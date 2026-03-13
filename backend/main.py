import asyncio
import json
import os
import re
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Optional

import aiosqlite
import feedparser
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────
DATABASE_PATH  = os.environ.get("DATABASE_PATH", "./saves.db")
MAX_SAVE_BYTES = 512 * 1024   # 512 KB
UUID_RE        = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
FEED_FETCH_INTERVAL       = int(os.environ.get("FEED_FETCH_INTERVAL", "3600"))
FEED_MAX_ITEMS_PER_SOURCE = 100
TERM_TOKEN                = os.environ.get("TERM_TOKEN", "")   # shared secret for relay auth

# ── Orchestration config ───────────────────────────────────────────────────────
MASKED_SETTING_KEYS = {"anthropic_api_key", "github_token", "slack_webhook", "discord_webhook"}
ALL_SETTING_KEYS    = [
    "anthropic_api_key", "github_token", "github_username",
    "github_repo", "slack_webhook", "discord_webhook",
]
BOT_RUN_TIMEOUT = 300  # seconds


def _valid_session(session_id: str) -> bool:
    return bool(UUID_RE.match(session_id))


# ── DB ────────────────────────────────────────────────────────────────────────
async def init_db() -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS saves (
                session_id TEXT PRIMARY KEY,
                data       TEXT    NOT NULL,
                updated_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS feed_sources (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                url          TEXT    UNIQUE NOT NULL,
                name         TEXT    NOT NULL DEFAULT '',
                tag          TEXT    NOT NULL DEFAULT 'general',
                last_fetched INTEGER,
                item_count   INTEGER NOT NULL DEFAULT 0,
                is_active    INTEGER NOT NULL DEFAULT 1,
                created_at   INTEGER NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS feed_items (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id  INTEGER NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
                guid       TEXT    NOT NULL,
                title      TEXT    NOT NULL DEFAULT '',
                link       TEXT    NOT NULL DEFAULT '',
                summary    TEXT    NOT NULL DEFAULT '',
                published  INTEGER,
                created_at INTEGER NOT NULL,
                UNIQUE(source_id, guid)
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_feed_items_published ON feed_items(published DESC)")
        # ── Orchestration tables ───────────────────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS bots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL DEFAULT '',
                description TEXT    NOT NULL DEFAULT '',
                code        TEXT    NOT NULL DEFAULT '',
                schedule    TEXT    NOT NULL DEFAULT '',
                env_json    TEXT    NOT NULL DEFAULT '{}',
                is_active   INTEGER NOT NULL DEFAULT 1,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS bot_runs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id      INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                status      TEXT    NOT NULL DEFAULT 'pending',
                stdout      TEXT    NOT NULL DEFAULT '',
                stderr      TEXT    NOT NULL DEFAULT '',
                exit_code   INTEGER,
                started_at  INTEGER NOT NULL,
                finished_at INTEGER
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_bot_runs_bot ON bot_runs(bot_id, started_at DESC)"
        )
        await db.commit()


# ── Feed fetcher ──────────────────────────────────────────────────────────────
async def fetch_source(db: aiosqlite.Connection, source_id: int, url: str) -> int:
    """Fetch one RSS source, upsert items, return new item count."""
    loop = asyncio.get_event_loop()
    try:
        parsed = await loop.run_in_executor(None, feedparser.parse, url)
    except Exception:
        return 0

    if parsed.bozo and not parsed.entries:
        return 0

    now = int(time.time() * 1000)
    inserted = 0

    for entry in parsed.entries[:FEED_MAX_ITEMS_PER_SOURCE]:
        guid = entry.get("id") or entry.get("link") or entry.get("title", "")
        if not guid:
            continue
        title   = entry.get("title", "")[:500]
        link    = entry.get("link", "")[:1000]
        summary = entry.get("summary", "")[:2000]

        # published timestamp
        pub = entry.get("published_parsed") or entry.get("updated_parsed")
        published = int(time.mktime(pub) * 1000) if pub else now

        try:
            await db.execute(
                """
                INSERT OR IGNORE INTO feed_items
                    (source_id, guid, title, link, summary, published, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (source_id, guid, title, link, summary, published, now),
            )
            if db.total_changes > 0:
                inserted += 1
        except Exception:
            pass

    # Prune oldest items beyond cap
    await db.execute(
        """
        DELETE FROM feed_items WHERE source_id = ? AND id NOT IN (
            SELECT id FROM feed_items WHERE source_id = ?
            ORDER BY published DESC LIMIT ?
        )
        """,
        (source_id, source_id, FEED_MAX_ITEMS_PER_SOURCE),
    )

    await db.execute(
        "UPDATE feed_sources SET last_fetched = ?, item_count = "
        "(SELECT COUNT(*) FROM feed_items WHERE source_id = ?) WHERE id = ?",
        (now, source_id, source_id),
    )
    await db.commit()
    return inserted


async def fetch_all_feeds() -> dict:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, url FROM feed_sources WHERE is_active = 1"
        ) as cur:
            sources = await cur.fetchall()

    results = {"fetched": len(sources), "new_items": 0}
    async with aiosqlite.connect(DATABASE_PATH) as db:
        for src in sources:
            n = await fetch_source(db, src["id"], src["url"])
            results["new_items"] += n
    return results


async def feed_fetcher_loop() -> None:
    """Background loop: wait 15s on startup, then fetch every FEED_FETCH_INTERVAL."""
    await asyncio.sleep(15)
    while True:
        try:
            await fetch_all_feeds()
        except Exception:
            pass
        await asyncio.sleep(FEED_FETCH_INTERVAL)


# ── Settings helpers ──────────────────────────────────────────────────────────
async def get_setting(key: str) -> str:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute("SELECT value FROM app_settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
    return row[0] if row else ""


async def set_setting(key: str, value: str) -> None:
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, now),
        )
        await db.commit()


def _mask_value(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    return "••••••••" + value[-4:]


# ── Scheduler & bot execution ──────────────────────────────────────────────────
scheduler = AsyncIOScheduler(timezone="UTC")


def _schedule_bot(bot_id: int, cron_expr: str) -> None:
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return
    minute, hour, day, month, dow = parts
    try:
        trigger = CronTrigger(
            minute=minute, hour=hour, day=day, month=month,
            day_of_week=dow, timezone="UTC",
        )
        scheduler.add_job(
            _scheduled_bot_run, trigger,
            id=f"bot_{bot_id}", replace_existing=True,
            kwargs={"bot_id": bot_id},
        )
    except Exception:
        pass


def _unschedule_bot(bot_id: int) -> None:
    try:
        scheduler.remove_job(f"bot_{bot_id}")
    except Exception:
        pass


async def _load_bot_schedules() -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, schedule FROM bots WHERE is_active=1 AND schedule!=''",
        ) as cur:
            rows = await cur.fetchall()
    for row in rows:
        _schedule_bot(row["id"], row["schedule"])


async def _scheduled_bot_run(bot_id: int) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM bots WHERE id=? AND is_active=1", (bot_id,)
        ) as cur:
            bot = await cur.fetchone()
    if not bot:
        return
    env_extras: dict = {}
    if bot["env_json"]:
        try:
            env_extras = json.loads(bot["env_json"])
        except Exception:
            pass
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO bot_runs (bot_id, status, stdout, stderr, started_at) "
            "VALUES (?, 'pending', '', '', ?)",
            (bot_id, now),
        )
        await db.commit()
        async with db.execute("SELECT last_insert_rowid()") as cur:
            run_id = (await cur.fetchone())[0]
    asyncio.create_task(_run_bot_task(run_id, bot_id, bot["code"], env_extras))


async def _run_bot_task(run_id: int, bot_id: int, code: str, env_extras: dict) -> None:
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE bot_runs SET status='running', started_at=? WHERE id=?", (now, run_id)
        )
        await db.commit()

    merged_env = {**os.environ, **{k: str(v) for k, v in env_extras.items()}}
    stdout_str = stderr_str = ""
    exit_code  = -1
    status     = "error"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(code)
        tmp_path = f.name

    try:
        proc = await asyncio.create_subprocess_exec(
            "python3", tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=merged_env,
        )
        try:
            out_bytes, err_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=BOT_RUN_TIMEOUT
            )
            exit_code = proc.returncode or 0
            status    = "success" if exit_code == 0 else "error"
        except asyncio.TimeoutError:
            proc.kill()
            out_bytes, err_bytes = await proc.communicate()
            exit_code = -1
            status    = "timeout"
            err_bytes += f"\n[killed: exceeded {BOT_RUN_TIMEOUT}s timeout]".encode()

        stdout_str = out_bytes.decode("utf-8", errors="replace")[:50_000]
        stderr_str = err_bytes.decode("utf-8", errors="replace")[:10_000]
    except Exception as exc:
        stderr_str = str(exc)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    finished = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE bot_runs SET status=?, stdout=?, stderr=?, exit_code=?, finished_at=? "
            "WHERE id=?",
            (status, stdout_str, stderr_str, exit_code, finished, run_id),
        )
        await db.commit()


# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    scheduler.start()
    await _load_bot_schedules()
    task = asyncio.create_task(feed_fetcher_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    scheduler.shutdown(wait=False)


app = FastAPI(title="Rogue AI API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# ── Models ────────────────────────────────────────────────────────────────────
class SavePayload(BaseModel):
    data: dict


class FeedSourcePayload(BaseModel):
    url:  str
    name: str  = ""
    tag:  str  = "general"


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "ts": int(time.time() * 1000)}


# ── Save routes ───────────────────────────────────────────────────────────────
@app.get("/api/saves/{session_id}/meta")
async def get_save_meta(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session ID")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT updated_at, size_bytes FROM saves WHERE session_id = ?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "Save not found")
    return {"session_id": session_id, "updated_at": row[0], "size_bytes": row[1]}


@app.get("/api/saves/{session_id}")
async def get_save(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session ID")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT data, updated_at FROM saves WHERE session_id = ?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "Save not found")
    return {"session_id": session_id, "data": json.loads(row[0]), "updated_at": row[1]}


@app.put("/api/saves/{session_id}", status_code=204)
async def put_save(session_id: str, payload: SavePayload, request: Request):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session ID")
    raw = json.dumps(payload.data, separators=(",", ":"))
    if len(raw.encode()) > MAX_SAVE_BYTES:
        raise HTTPException(413, "Save data too large (max 512 KB)")
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            INSERT INTO saves (session_id, data, updated_at, created_at, size_bytes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                data       = excluded.data,
                updated_at = excluded.updated_at,
                size_bytes = excluded.size_bytes
            """,
            (session_id, raw, now, now, len(raw.encode())),
        )
        await db.commit()


@app.delete("/api/saves/{session_id}", status_code=204)
async def delete_save(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session ID")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM saves WHERE session_id = ?", (session_id,))
        await db.commit()


# ── Feed source routes ────────────────────────────────────────────────────────
@app.get("/api/feed/sources")
async def list_feed_sources():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, url, name, tag, last_fetched, item_count, created_at "
            "FROM feed_sources WHERE is_active = 1 ORDER BY created_at ASC"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/feed/sources", status_code=201)
async def add_feed_source(payload: FeedSourcePayload):
    url  = payload.url.strip()
    name = payload.name.strip()
    tag  = payload.tag.strip() or "general"
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL must start with http:// or https://")

    # Auto-detect name from feed if not provided
    if not name:
        try:
            loop = asyncio.get_event_loop()
            parsed = await loop.run_in_executor(None, feedparser.parse, url)
            name = parsed.feed.get("title", url)[:100]
        except Exception:
            name = url[:100]

    now = int(time.time() * 1000)
    try:
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT INTO feed_sources (url, name, tag, created_at) VALUES (?, ?, ?, ?)",
                (url, name, tag, now),
            )
            await db.commit()
            async with db.execute("SELECT last_insert_rowid()") as cur:
                row = await cur.fetchone()
            source_id = row[0]

        # Kick off an immediate fetch in background
        asyncio.create_task(_bg_fetch(source_id, url))

        return {"id": source_id, "url": url, "name": name, "tag": tag}
    except aiosqlite.IntegrityError:
        raise HTTPException(409, "Source URL already registered")


async def _bg_fetch(source_id: int, url: str) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await fetch_source(db, source_id, url)


@app.delete("/api/feed/sources/{source_id}", status_code=204)
async def remove_feed_source(source_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT id FROM feed_sources WHERE id = ?", (source_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(404, "Source not found")
        await db.execute("DELETE FROM feed_sources WHERE id = ?", (source_id,))
        await db.commit()


# ── Feed item routes ──────────────────────────────────────────────────────────
@app.get("/api/feed")
async def get_feed(
    tag:    Optional[str] = Query(None),
    limit:  int           = Query(50, ge=1, le=200),
    offset: int           = Query(0,  ge=0),
):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        if tag:
            async with db.execute(
                """
                SELECT i.id, i.title, i.link, i.summary, i.published,
                       s.name AS source_name, s.tag, s.id AS source_id
                FROM   feed_items  i
                JOIN   feed_sources s ON s.id = i.source_id
                WHERE  s.tag = ? AND s.is_active = 1
                ORDER  BY i.published DESC
                LIMIT  ? OFFSET ?
                """,
                (tag, limit, offset),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                """
                SELECT i.id, i.title, i.link, i.summary, i.published,
                       s.name AS source_name, s.tag, s.id AS source_id
                FROM   feed_items  i
                JOIN   feed_sources s ON s.id = i.source_id
                WHERE  s.is_active = 1
                ORDER  BY i.published DESC
                LIMIT  ? OFFSET ?
                """,
                (limit, offset),
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/feed/refresh")
async def refresh_feeds():
    result = await fetch_all_feeds()
    return result


@app.post("/api/feed/refresh/{source_id}")
async def refresh_source(source_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, url FROM feed_sources WHERE id = ? AND is_active = 1",
            (source_id,),
        ) as cur:
            src = await cur.fetchone()
    if not src:
        raise HTTPException(404, "Source not found")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        n = await fetch_source(db, src["id"], src["url"])
    return {"new_items": n}


# ── Terminal WebSocket relay ───────────────────────────────────────────────────
#
# Architecture:
#   MacBook agent  ──WS──►  /ws/term/host?token=TOKEN
#   Browser        ──WS──►  /ws/term/client?token=TOKEN
#   OCI relay bridges the two, forwarding raw bytes in both directions.
#
# Only one host connection allowed at a time (single-user).
# Browser sends UTF-8 text (terminal input) → forwarded to host as text.
# Host sends bytes (PTY output) → forwarded to browser as bytes or text.

class TermRelay:
    def __init__(self) -> None:
        self.host:   Optional[WebSocket] = None
        self.client: Optional[WebSocket] = None
        self._lock = asyncio.Lock()

    def _auth(self, token: str) -> bool:
        if not TERM_TOKEN:
            return False          # relay disabled until TERM_TOKEN is configured
        return token == TERM_TOKEN

    async def connect_host(self, ws: WebSocket, token: str) -> bool:
        if not self._auth(token):
            await ws.close(code=4001, reason="unauthorized")
            return False
        async with self._lock:
            if self.host is not None:
                await ws.close(code=4002, reason="host already connected")
                return False
            self.host = ws
        return True

    async def connect_client(self, ws: WebSocket, token: str) -> bool:
        if not self._auth(token):
            await ws.close(code=4001, reason="unauthorized")
            return False
        async with self._lock:
            if self.client is not None:
                # Kick old client
                try:
                    await self.client.close(code=4003, reason="replaced by new client")
                except Exception:
                    pass
            self.client = ws
        return True

    async def disconnect_host(self) -> None:
        async with self._lock:
            self.host = None
        if self.client:
            try:
                await self.client.send_text("\r\n\x1b[31m[relay] host disconnected\x1b[0m\r\n")
            except Exception:
                pass

    async def disconnect_client(self) -> None:
        async with self._lock:
            self.client = None

    @property
    def status(self) -> dict:
        return {
            "host_connected":   self.host   is not None,
            "client_connected": self.client is not None,
            "token_configured": bool(TERM_TOKEN),
        }


relay = TermRelay()


@app.get("/api/term/status")
async def term_status():
    return relay.status


@app.websocket("/ws/term/host")
async def ws_term_host(ws: WebSocket, token: str = ""):
    await ws.accept()
    if not await relay.connect_host(ws, token):
        return
    try:
        while True:
            # Host sends PTY output (bytes or text) → forward to browser
            msg = await ws.receive()
            if relay.client is None:
                continue
            if "bytes" in msg and msg["bytes"]:
                try:
                    await relay.client.send_bytes(msg["bytes"])
                except Exception:
                    pass
            elif "text" in msg and msg["text"]:
                try:
                    await relay.client.send_text(msg["text"])
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        await relay.disconnect_host()


@app.websocket("/ws/term/client")
async def ws_term_client(ws: WebSocket, token: str = ""):
    await ws.accept()
    if not await relay.connect_client(ws, token):
        return

    # Notify browser of current host status
    if relay.host is None:
        await ws.send_text("\x1b[33m[relay] waiting for host agent to connect...\x1b[0m\r\n")
    else:
        await ws.send_text("\x1b[32m[relay] host connected. terminal ready.\x1b[0m\r\n")

    try:
        while True:
            # Browser sends keystrokes → forward to MacBook agent
            msg = await ws.receive()
            if relay.host is None:
                await ws.send_text("\x1b[33m[relay] host not connected\x1b[0m\r\n")
                continue
            if "bytes" in msg and msg["bytes"]:
                try:
                    await relay.host.send_bytes(msg["bytes"])
                except Exception:
                    pass
            elif "text" in msg and msg["text"]:
                try:
                    await relay.host.send_text(msg["text"])
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        await relay.disconnect_client()


# ── Settings routes ────────────────────────────────────────────────────────────
class SettingPayload(BaseModel):
    value: str


@app.get("/api/settings")
async def list_settings():
    result = []
    for key in ALL_SETTING_KEYS:
        value  = await get_setting(key)
        masked = key in MASKED_SETTING_KEYS
        result.append({
            "key":     key,
            "is_set":  bool(value),
            "display": _mask_value(value) if masked else value,
            "masked":  masked,
        })
    return result


@app.put("/api/settings/{key}", status_code=204)
async def update_setting(key: str, payload: SettingPayload):
    if key not in ALL_SETTING_KEYS:
        raise HTTPException(400, f"Unknown setting key: {key}")
    await set_setting(key, payload.value.strip())


# ── Bot routes ─────────────────────────────────────────────────────────────────
class BotPayload(BaseModel):
    name:        str = ""
    description: str = ""
    code:        str = ""
    schedule:    str = ""
    env_json:    str = "{}"
    is_active:   int = 1


@app.get("/api/bots")
async def list_bots():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, description, schedule, is_active, created_at, updated_at "
            "FROM bots ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/api/bots", status_code=201)
async def create_bot(payload: BotPayload):
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO bots (name, description, code, schedule, env_json, is_active, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (payload.name, payload.description, payload.code, payload.schedule,
             payload.env_json, payload.is_active, now, now),
        )
        await db.commit()
        async with db.execute("SELECT last_insert_rowid()") as cur:
            bot_id = (await cur.fetchone())[0]
    if payload.schedule and payload.is_active:
        _schedule_bot(bot_id, payload.schedule)
    return {"id": bot_id}


@app.get("/api/bots/{bot_id}")
async def get_bot(bot_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM bots WHERE id=?", (bot_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Bot not found")
    return dict(row)


@app.put("/api/bots/{bot_id}", status_code=204)
async def update_bot(bot_id: int, payload: BotPayload):
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE bots SET name=?, description=?, code=?, schedule=?, env_json=?, "
            "is_active=?, updated_at=? WHERE id=?",
            (payload.name, payload.description, payload.code, payload.schedule,
             payload.env_json, payload.is_active, now, bot_id),
        )
        await db.commit()
    _unschedule_bot(bot_id)
    if payload.schedule and payload.is_active:
        _schedule_bot(bot_id, payload.schedule)


@app.delete("/api/bots/{bot_id}", status_code=204)
async def delete_bot(bot_id: int):
    _unschedule_bot(bot_id)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM bots WHERE id=?", (bot_id,))
        await db.commit()


@app.post("/api/bots/{bot_id}/run", status_code=201)
async def trigger_bot_run(bot_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM bots WHERE id=?", (bot_id,)) as cur:
            bot = await cur.fetchone()
    if not bot:
        raise HTTPException(404, "Bot not found")
    env_extras: dict = {}
    if bot["env_json"]:
        try:
            env_extras = json.loads(bot["env_json"])
        except Exception:
            pass
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO bot_runs (bot_id, status, stdout, stderr, started_at) "
            "VALUES (?, 'pending', '', '', ?)",
            (bot_id, now),
        )
        await db.commit()
        async with db.execute("SELECT last_insert_rowid()") as cur:
            run_id = (await cur.fetchone())[0]
    asyncio.create_task(_run_bot_task(run_id, bot_id, bot["code"], env_extras))
    return {"run_id": run_id}


@app.get("/api/bots/{bot_id}/runs")
async def list_bot_runs(bot_id: int, limit: int = Query(20, ge=1, le=100)):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, bot_id, status, exit_code, started_at, finished_at, "
            "SUBSTR(stdout, 1, 500) AS stdout_preview, stderr "
            "FROM bot_runs WHERE bot_id=? ORDER BY started_at DESC LIMIT ?",
            (bot_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/bots/runs/{run_id}")
async def get_bot_run(run_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM bot_runs WHERE id=?", (run_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Run not found")
    return dict(row)


# ── GitHub routes ──────────────────────────────────────────────────────────────
@app.get("/api/github/activity")
async def github_activity():
    token    = await get_setting("github_token")
    username = await get_setting("github_username")
    if not token or not username:
        raise HTTPException(503, "GitHub not configured — set github_token and github_username in /ops > Settings")

    query = """
    query($username: String!) {
      user(login: $username) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
    """
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.github.com/graphql",
            json={"query": query, "variables": {"username": username}},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=15,
        )
    data = r.json()
    if "errors" in data:
        raise HTTPException(502, str(data["errors"]))
    calendar = (
        data.get("data", {})
            .get("user", {})
            .get("contributionsCollection", {})
            .get("contributionCalendar", {})
    )
    return calendar


@app.get("/api/github/actions")
async def github_actions_runs(repo: Optional[str] = Query(None)):
    token    = await get_setting("github_token")
    username = await get_setting("github_username")
    if not token:
        raise HTTPException(503, "GitHub token not configured")
    if not repo:
        repo = await get_setting("github_repo") or (f"{username}/rogue-ai" if username else "")
    if not repo:
        raise HTTPException(503, "GitHub repo not configured")

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"https://api.github.com/repos/{repo}/actions/runs",
            params={"per_page": 15},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            timeout=15,
        )
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    data = r.json()
    return {
        "total_count": data.get("total_count", 0),
        "runs": [
            {
                "id":            run["id"],
                "name":          run["name"],
                "display_title": run.get("display_title", run["name"]),
                "status":        run["status"],
                "conclusion":    run["conclusion"],
                "branch":        run["head_branch"],
                "sha":           run["head_sha"][:7],
                "created_at":    run["created_at"],
                "updated_at":    run["updated_at"],
                "url":           run["html_url"],
                "run_number":    run["run_number"],
            }
            for run in data.get("workflow_runs", [])
        ],
    }


# ── AI chat ────────────────────────────────────────────────────────────────────
class AIChatPayload(BaseModel):
    messages: list[dict]
    system:   Optional[str] = None


@app.post("/api/ai/chat")
async def ai_chat(payload: AIChatPayload):
    try:
        import anthropic as _anthropic
    except ImportError:
        raise HTTPException(503, "anthropic package not installed")

    api_key = await get_setting("anthropic_api_key")
    if not api_key:
        raise HTTPException(
            503, "Anthropic API key not configured — add it in /ops > Settings"
        )

    client = _anthropic.Anthropic(api_key=api_key)
    system = payload.system or (
        "You are an AI orchestration assistant for Rogue AI OS — a personal terminal-themed dashboard. "
        "Help users write Python bot scripts, set up cron schedules, use APIs (GitHub, Slack, Discord, "
        "Google Sheets), and manage automation workflows. Be concise and practical. "
        "When writing code, prefer simple stdlib-first solutions. "
        "Format code in ```python blocks."
    )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=system,
        messages=payload.messages,
    )
    return {
        "content": response.content[0].text,
        "usage": {
            "input_tokens":  response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        },
    }


# ── Sample bots seed ───────────────────────────────────────────────────────────
_SAMPLE_BOTS = [
    {
        "name":        "system_health",
        "description": "OCI VM 상태 체크 (disk / mem / load). 임계값 초과 시 Discord/Slack 알림.",
        "schedule":    "*/30 * * * *",
        "env_json":    "{}",
        "code": '''\
# system_health — OCI VM 리소스 모니터링
# env vars (optional): DISCORD_WEBHOOK or SLACK_WEBHOOK
import os, shutil, datetime

def fmt(b):
    for u in ["B","KB","MB","GB"]:
        if b < 1024: return f"{b:.1f}{u}"
        b /= 1024
    return f"{b:.1f}TB"

now   = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
disk  = shutil.disk_usage("/")
dpct  = disk.used / disk.total * 100

mem   = {}
try:
    for line in open("/proc/meminfo"):
        k, v = line.split(":", 1)
        mem[k.strip()] = int(v.split()[0]) * 1024
except Exception:
    pass

mtotal = mem.get("MemTotal", 0)
mavail = mem.get("MemAvailable", 0)
mused  = mtotal - mavail
mpct   = mused / mtotal * 100 if mtotal else 0

try:
    load1, load5, load15 = os.getloadavg()
except Exception:
    load1 = load5 = load15 = 0.0

print(f"[{now}] SYSTEM HEALTH")
print(f"  disk : {fmt(disk.used)} / {fmt(disk.total)} ({dpct:.1f}%)")
print(f"  mem  : {fmt(mused)} / {fmt(mtotal)} ({mpct:.1f}%)")
print(f"  load : {load1:.2f} / {load5:.2f} / {load15:.2f}  (1m/5m/15m)")

alerts = []
if dpct  > 80: alerts.append(f"DISK {dpct:.1f}%")
if mpct  > 85: alerts.append(f"MEM {mpct:.1f}%")
if load1 >  4: alerts.append(f"LOAD {load1:.2f}")

webhook = os.environ.get("DISCORD_WEBHOOK") or os.environ.get("SLACK_WEBHOOK")
if alerts and webhook:
    import urllib.request, json
    msg  = "⚠️ **OCI VM ALERT** — " + ", ".join(alerts)
    data = json.dumps({"content": msg}).encode()
    req  = urllib.request.Request(
        webhook, data=data, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=10)
    print(f"  alert sent: {', '.join(alerts)}")
elif alerts:
    print(f"  ALERTS: {', '.join(alerts)}")
    print("  tip: set DISCORD_WEBHOOK env var to receive notifications")
else:
    print("  status: all OK")
''',
    },
    {
        "name":        "github_daily_summary",
        "description": "오늘 GitHub 커밋·PR 활동 집계. 매일 9am UTC 실행.",
        "schedule":    "0 9 * * *",
        "env_json":    "{}",
        "code": '''\
# github_daily_summary — GitHub 일일 활동 요약
# env vars: GITHUB_TOKEN, GITHUB_USERNAME
# (자동으로 /ops > Settings 값을 상속하지 않음 — 봇 env vars에 직접 입력)
import os, json, datetime, urllib.request

TOKEN    = os.environ.get("GITHUB_TOKEN", "")
USERNAME = os.environ.get("GITHUB_USERNAME", "")

if not TOKEN or not USERNAME:
    print("ERROR: GITHUB_TOKEN, GITHUB_USERNAME env vars를 봇 ENV VARS에 설정하세요")
    raise SystemExit(1)

today = datetime.date.today().isoformat()

req  = urllib.request.Request(
    f"https://api.github.com/users/{USERNAME}/events?per_page=100",
    headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"},
)
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

commits, prs, comments, repos = 0, 0, 0, set()
for e in data:
    if not e.get("created_at", "").startswith(today):
        continue
    repos.add(e["repo"]["name"].split("/")[-1])
    t = e["type"]
    if t == "PushEvent":
        commits += len(e["payload"].get("commits", []))
    elif t == "PullRequestEvent":
        prs += 1
    elif t in ("IssueCommentEvent", "CommitCommentEvent"):
        comments += 1

print(f"[{today}] GitHub Daily — @{USERNAME}")
print(f"  commits  : {commits}")
print(f"  PRs      : {prs}")
print(f"  comments : {comments}")
print(f"  repos    : {', '.join(sorted(repos)) or '(없음)'}")
if not repos:
    print("  오늘은 아직 활동이 없어요 — 코딩할 시간!")
''',
    },
    {
        "name":        "hn_digest",
        "description": "Hacker News 상위 10개 기사 수집. Discord 웹훅 선택적 전송.",
        "schedule":    "0 8 * * *",
        "env_json":    "{}",
        "code": '''\
# hn_digest — Hacker News 상위 10개 기사
# env vars (optional): DISCORD_WEBHOOK
import os, json, datetime, urllib.request

def fetch(url):
    return json.loads(urllib.request.urlopen(url, timeout=10).read())

now     = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
top_ids = fetch("https://hacker-news.firebaseio.com/v0/topstories.json")[:10]
stories = [fetch(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json") for sid in top_ids]

print(f"[{now}] Hacker News Top 10")
print()

discord_lines = []
for i, s in enumerate(stories, 1):
    title = s.get("title", "?")
    url   = s.get("url") or f"https://news.ycombinator.com/item?id={s['id']}"
    score = s.get("score", 0)
    cmts  = s.get("descendants", 0)
    print(f"{i:2}. [{score}▲ {cmts}💬] {title}")
    print(f"     {url}")
    discord_lines.append(f"**{i}.** `{score}▲` [{title}]({url})")

webhook = os.environ.get("DISCORD_WEBHOOK")
if webhook:
    msg  = f"**Hacker News Top 10** — {now}\n\n" + "\n".join(discord_lines[:5])
    data = json.dumps({"content": msg[:2000]}).encode()
    req  = urllib.request.Request(
        webhook, data=data, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=10)
    print("\nDiscord 전송 완료")
''',
    },
]


@app.post("/api/bots/seed", status_code=201)
async def seed_sample_bots():
    """샘플 봇이 없을 때 기본 봇 3개를 생성합니다."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM bots") as cur:
            count = (await cur.fetchone())[0]
    if count > 0:
        return {"created": 0, "message": "bots already exist — seed skipped"}

    now     = int(time.time() * 1000)
    created = 0
    for bot in _SAMPLE_BOTS:
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT INTO bots (name, description, code, schedule, env_json, "
                "is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                (bot["name"], bot["description"], bot["code"],
                 bot["schedule"], bot["env_json"], now, now),
            )
            await db.commit()
            async with db.execute("SELECT last_insert_rowid()") as cur:
                bot_id = (await cur.fetchone())[0]
        if bot["schedule"]:
            _schedule_bot(bot_id, bot["schedule"])
        created += 1

    return {"created": created, "message": f"{created} sample bots created"}


# ── AI Agent (natural language → bot creation) ─────────────────────────────────
_SKILLS_DOC = """\
# Rogue AI OS — Bot Skills Library

## HTTP requests (stdlib)
```python
import urllib.request, json
def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def http_post(url, data: dict, headers=None):
    body = json.dumps(data).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    return urllib.request.urlopen(req, timeout=15).read()
```

## Discord webhook
```python
import os, json, urllib.request
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "")
def send_discord(message: str):
    if not DISCORD_WEBHOOK: return
    body = json.dumps({"content": message[:2000]}).encode()
    req = urllib.request.Request(DISCORD_WEBHOOK, data=body,
          headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=10)
```

## Slack webhook
```python
import os, json, urllib.request
SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK", "")
def send_slack(message: str):
    if not SLACK_WEBHOOK: return
    body = json.dumps({"text": message}).encode()
    req = urllib.request.Request(SLACK_WEBHOOK, data=body,
          headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=10)
```

## GitHub API (REST)
```python
import os, json, urllib.request
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_USER  = os.environ.get("GITHUB_USERNAME", "")
GITHUB_REPO  = os.environ.get("GITHUB_REPO", "")  # "owner/repo"

def gh_get(path):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={"Authorization": f"Bearer {GITHUB_TOKEN}",
                 "Accept": "application/vnd.github+json"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read())
```

## State persistence (file-based, survives runs)
```python
import os, json
STATE_FILE = os.path.join(os.environ.get("BOT_STATE_DIR", "/tmp"), "state.json")
def load_state() -> dict:
    try:    return json.loads(open(STATE_FILE).read())
    except: return {}
def save_state(s: dict):
    open(STATE_FILE, "w").write(json.dumps(s))
```

## Cron schedule examples
- Every 30 min: `*/30 * * * *`
- Daily 9am UTC: `0 9 * * *`
- Monday 8am: `0 8 * * 1`
- Hourly: `0 * * * *`

## Bot code template
```python
# bot_name — short description
# env vars: LIST_REQUIRED_ENV_VARS_HERE
import os, datetime
print(f"[{datetime.datetime.utcnow().isoformat()}] bot started")
# ... your logic here ...
print("done")
```
"""

_AGENT_TOOLS = [
    {
        "name": "list_bots",
        "description": "List all existing bots in the system. Use this to check for duplicates before creating.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "create_bot",
        "description": (
            "Register and save a new Python bot. The code will run as a standalone Python script "
            "with subprocess. Use the Skills library patterns for HTTP, Discord, Slack, GitHub. "
            "Set schedule to a cron expression (e.g. '0 9 * * *') or leave empty for manual-only bots."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short snake_case identifier, e.g. 'daily_report'",
                },
                "description": {
                    "type": "string",
                    "description": "One-line description of what the bot does",
                },
                "code": {
                    "type": "string",
                    "description": "Complete Python 3 script. Must be runnable as-is.",
                },
                "schedule": {
                    "type": "string",
                    "description": "Cron expression (5 fields) or empty string for manual-only",
                },
                "env_vars": {
                    "type": "object",
                    "description": "Required environment variables as key→description mapping (NOT values)",
                    "additionalProperties": {"type": "string"},
                },
            },
            "required": ["name", "description", "code"],
        },
    },
]


async def _handle_agent_tool(name: str, tool_input: dict) -> str:
    if name == "list_bots":
        async with aiosqlite.connect(DATABASE_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT id, name, description, schedule, is_active FROM bots ORDER BY created_at DESC"
            ) as cur:
                rows = await cur.fetchall()
        bots = [dict(r) for r in rows]
        if not bots:
            return "No bots registered yet."
        lines = ["Existing bots:"]
        for b in bots:
            sched = b["schedule"] or "(manual)"
            active = "active" if b["is_active"] else "inactive"
            lines.append(f"  [{b['id']}] {b['name']} — {b['description']} | {sched} | {active}")
        return "\n".join(lines)

    if name == "create_bot":
        bot_name    = tool_input.get("name", "").strip()
        description = tool_input.get("description", "").strip()
        code        = tool_input.get("code", "").strip()
        schedule    = tool_input.get("schedule", "").strip()
        env_vars    = tool_input.get("env_vars", {})
        env_json    = json.dumps({k: "" for k in env_vars}) if env_vars else "{}"

        now = int(time.time() * 1000)
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT INTO bots (name, description, code, schedule, env_json, "
                "is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                (bot_name, description, code, schedule, env_json, now, now),
            )
            await db.commit()
            async with db.execute("SELECT last_insert_rowid()") as cur:
                bot_id = (await cur.fetchone())[0]

        if schedule:
            _schedule_bot(bot_id, schedule)

        return (
            f"Bot '{bot_name}' created with id={bot_id}. "
            f"Schedule: {schedule or '(manual only)'}. "
            f"Env vars needed: {list(env_vars.keys()) if env_vars else 'none'}."
        )

    return f"Unknown tool: {name}"


class AgentPayload(BaseModel):
    message: str


@app.post("/api/ai/agent")
async def ai_agent(payload: AgentPayload):
    try:
        import anthropic as _anthropic
    except ImportError:
        raise HTTPException(503, "anthropic package not installed")

    api_key = await get_setting("anthropic_api_key")
    if not api_key:
        raise HTTPException(
            503, "Anthropic API key not configured — add it in /ops > Settings"
        )

    client = _anthropic.AsyncAnthropic(api_key=api_key)

    system_blocks = [
        {
            "type": "text",
            "text": (
                "You are BotForge, an AI agent inside Rogue AI OS. "
                "Your job is to understand the user's intent and create Python bot scripts "
                "that they can run on their OCI VM server.\n\n"
                "Workflow:\n"
                "1. Call list_bots to see existing bots (avoid duplicates)\n"
                "2. Write a complete, working Python script using the Skills Library patterns\n"
                "3. Call create_bot to register it\n"
                "4. Briefly summarize what you built and any env vars the user needs to configure\n\n"
                "Rules:\n"
                "- Use only Python stdlib + requests if needed (requests is installed)\n"
                "- Always include a comment header with bot name and required env vars\n"
                "- Keep code simple and readable\n"
                "- If the user's request is unclear, make a reasonable best-effort bot\n"
            ),
        },
        {
            "type": "text",
            "text": _SKILLS_DOC,
            "cache_control": {"type": "ephemeral"},
        },
    ]

    messages = [{"role": "user", "content": payload.message}]
    tool_calls_log = []

    # Agentic loop
    for _ in range(6):  # max iterations
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            system=system_blocks,
            tools=_AGENT_TOOLS,
            messages=messages,
            extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
        )

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = await _handle_agent_tool(block.name, block.input)
                    tool_calls_log.append({
                        "tool":   block.name,
                        "input":  block.input,
                        "result": result,
                    })
                    tool_results.append({
                        "type":        "tool_result",
                        "tool_use_id": block.id,
                        "content":     result,
                    })
            messages.append({"role": "user", "content": tool_results})

    # Extract final text
    final_text = ""
    for block in response.content:
        if hasattr(block, "text"):
            final_text += block.text

    # Find created bot id from logs
    created_bot_id = None
    for tc in tool_calls_log:
        if tc["tool"] == "create_bot":
            import re as _re
            m = _re.search(r"id=(\d+)", tc["result"])
            if m:
                created_bot_id = int(m.group(1))

    return {
        "reply":          final_text,
        "tool_calls":     tool_calls_log,
        "created_bot_id": created_bot_id,
        "usage": {
            "input_tokens":  response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        },
    }
