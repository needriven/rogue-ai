import asyncio
import json
import os
import re
import subprocess
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import aiosqlite
import feedparser
import httpx
import math
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from redis.asyncio import Redis as AIORedis
from motor.motor_asyncio import AsyncIOMotorClient

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

REDIS_URL   = os.environ.get("REDIS_URL",   "redis://localhost:6379")
MONGO_URL   = os.environ.get("MONGO_URL",   "mongodb://localhost:27017")
MONGO_DB    = os.environ.get("MONGO_DB",    "rogueai")
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", "/data/uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

# Global clients (initialized in lifespan)
redis_client: AIORedis | None = None
mongo_client: AsyncIOMotorClient | None = None


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
        await db.execute("""
            CREATE TABLE IF NOT EXISTS bot_data (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id     INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                key        TEXT    NOT NULL DEFAULT 'default',
                value_json TEXT    NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL,
                UNIQUE(bot_id, key)
            )
        """)
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

    merged_env = {
        **os.environ,
        **{k: str(v) for k, v in env_extras.items()},
        "BOT_ID":       str(bot_id),
        "BOT_API_BASE": "http://localhost:8000/api",
    }
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
    global redis_client, mongo_client
    # Redis
    redis_client = AIORedis.from_url(REDIS_URL, decode_responses=True)
    # MongoDB
    mongo_client = AsyncIOMotorClient(MONGO_URL)
    db = mongo_client[MONGO_DB]
    # MongoDB indexes
    await db.market_listings.create_index("expiresAt", expireAfterSeconds=0)
    await db.market_listings.create_index([("item.rarity", 1), ("item.type", 1)])
    await db.players.create_index("lastSeen")
    await db.run_records.create_index([("session_id", 1), ("createdAt", -1)])
    await db.planner_memos.create_index("expiresAt", expireAfterSeconds=0, sparse=True)
    await db.planner_memos.create_index([("sessionId", 1), ("createdAt", -1)])
    await db.planner_schedules.create_index([("sessionId", 1), ("createdAt", -1)])

    # Warm up CPU baseline so first monitor request shows real delta
    _total, _idle = _read_cpu_stats()
    _cpu_prev.update({"total": _total, "idle": _idle, "percent": 0.0})

    await init_db()
    await db.planner_notifications.create_index([("sessionId", 1), ("acked", 1), ("firedAt", -1)])
    await db.planner_notifications.create_index("firedAt", expireAfterSeconds=86400)  # auto-delete after 24h

    scheduler.start()
    await _load_bot_schedules()
    await _load_planner_schedules()

    task_feed    = asyncio.create_task(feed_fetcher_loop())
    task_monitor = asyncio.create_task(monitor_collector_loop())
    task_cleanup = asyncio.create_task(upload_cleanup_loop())
    yield
    task_feed.cancel(); task_monitor.cancel(); task_cleanup.cancel()
    for t in [task_feed, task_monitor, task_cleanup]:
        try:
            await t
        except asyncio.CancelledError:
            pass
    scheduler.shutdown(wait=False)
    if redis_client:
        await redis_client.aclose()
    if mongo_client:
        mongo_client.close()


app = FastAPI(title="Rogue AI API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


# ── Models ────────────────────────────────────────────────────────────────────
class SavePayload(BaseModel):
    data: dict


class FeedSourcePayload(BaseModel):
    url:  str
    name: str  = ""
    tag:  str  = "general"


# ── Network models ─────────────────────────────────────────────────────────────
class ScoreSubmit(BaseModel):
    session_id:          str
    display_name:        str = ""
    total_cycles:        float
    breach_level:        int
    prestige_multiplier: float
    stage:               str = "genesis"

class MarketListRequest(BaseModel):
    session_id:   str
    display_name: str = ""
    item_name:    str
    item_rarity:  str
    item_type:    str
    item_mult:    float
    item_desc:    str
    price_frag:   int

class MarketBuyRequest(BaseModel):
    session_id:       str
    listing_id:       str
    buyer_fragments:  int


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


# ── Bot data (REST publish) ─────────────────────────────────────────────────────
@app.post("/api/bots/{bot_id}/data", status_code=204)
async def store_bot_data(bot_id: int, request: Request, key: str = Query("default")):
    """Bots call this via BOT_API_BASE to publish structured JSON results."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")
    now = int(time.time() * 1000)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO bot_data (bot_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(bot_id, key) DO UPDATE SET value_json=excluded.value_json, "
            "updated_at=excluded.updated_at",
            (bot_id, key, json.dumps(body), now),
        )
        await db.commit()


@app.get("/api/bots/{bot_id}/data")
async def get_bot_data(bot_id: int):
    """Return all stored data keys for a bot. CORS-open for external web services."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT key, value_json, updated_at FROM bot_data WHERE bot_id=? ORDER BY key",
            (bot_id,),
        ) as cur:
            rows = await cur.fetchall()
    return {
        r["key"]: {
            "value":      json.loads(r["value_json"]),
            "updated_at": r["updated_at"],
        }
        for r in rows
    }


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

## Publish data as REST API (web-accessible)
```python
import os, json, urllib.request
BOT_ID       = os.environ.get("BOT_ID", "")
BOT_API_BASE = os.environ.get("BOT_API_BASE", "http://localhost:8000/api")

def store_data(data: dict, key: str = "default"):
    # Save structured JSON so it's readable via GET /api/bots/{BOT_ID}/data
    # External services can poll this endpoint to consume bot output.
    if not BOT_ID:
        print("[store_data] BOT_ID not set — skipping")
        return
    body = json.dumps(data).encode()
    req  = urllib.request.Request(
        f"{BOT_API_BASE}/bots/{BOT_ID}/data?key={key}",
        data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    urllib.request.urlopen(req, timeout=5)

# Example usage:
# store_data({"price": 42000, "symbol": "BTC", "change_pct": -1.5})
# store_data({"items": [...]}, key="feed")
# store_data({"disk_pct": 61.2, "mem_pct": 43.0}, key="health")
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


# ── Network helpers ────────────────────────────────────────────────────────────

def _get_redis() -> AIORedis:
    if not redis_client:
        raise HTTPException(503, "Redis not available")
    return redis_client

def _get_mongo():
    if not mongo_client:
        raise HTTPException(503, "MongoDB not available")
    return mongo_client[MONGO_DB]

def _safe_display_name(session_id: str, name: str) -> str:
    """Generate safe display name, fallback to session prefix."""
    if name and len(name.strip()) >= 2:
        clean = name.strip()[:20]
        import re as _re
        clean = _re.sub(r'[^a-zA-Z0-9_\-]', '', clean)
        if len(clean) >= 2:
            return clean
    return f"AGENT_{session_id[:8].upper()}"

async def _check_rate_limit(r: AIORedis, key: str, limit: int, window: int) -> bool:
    count = await r.incr(key)
    if count == 1:
        await r.expire(key, window)
    return count <= limit

async def _maybe_trigger_global_event(r: AIORedis, db, breach_level: int, total_cycles: float):
    """Check if player activity should trigger a global server event."""
    existing = await r.hget("event:global", "expiresAt")
    if existing and float(existing) > time.time():
        return  # event already active

    event = None
    if breach_level >= 10:
        event = {
            "type": "singularity_wave",
            "title": "SINGULARITY_WAVE",
            "description": f"A Breach-10 AI triggered a cascade. All players: drop rate ×2 for 1h.",
            "effectType": "drop_rate",
            "effectValue": "2.0",
            "expiresAt": str(time.time() + 3600),
        }
    elif total_cycles >= 1e15:  # 1 Peta-cycle
        event = {
            "type": "mega_miner",
            "title": "MEGA_MINER_DETECTED",
            "description": "A player reached Peta-scale computation. All players: CPS ×1.3 for 30m.",
            "effectType": "cps_mult",
            "effectValue": "1.3",
            "expiresAt": str(time.time() + 1800),
        }

    if event:
        await r.hset("event:global", mapping=event)
        await r.expire("event:global", 3700)
        await db.global_events_log.insert_one({
            "type": event["type"], "title": event["title"],
            "startedAt": time.time(),
            "expiresAt": float(event["expiresAt"]),
        })


# ── Network endpoints ──────────────────────────────────────────────────────────

@app.post("/api/network/score")
async def submit_score(body: ScoreSubmit):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")

    r  = _get_redis()
    db = _get_mongo()

    # Rate limit: 1 submit per 30s per session
    rl_key = f"ratelimit:score:{body.session_id}"
    if not await _check_rate_limit(r, rl_key, 2, 30):
        raise HTTPException(429, "Rate limit: submit once per 30s")

    display_name = _safe_display_name(body.session_id, body.display_name)

    # Update Redis leaderboards (sorted sets)
    await r.zadd("leaderboard:cycles",  {body.session_id: body.total_cycles})
    await r.zadd("leaderboard:breach",  {body.session_id: float(body.breach_level)})

    # Store display name mapping (hash)
    await r.hset("players:names", body.session_id, display_name)

    # Upsert player in MongoDB
    now = time.time()
    await db.players.update_one(
        {"_id": body.session_id},
        {"$set": {
            "displayName":    display_name,
            "stage":          body.stage,
            "lastSeen":       now,
            "stats.maxCycles":          body.total_cycles,
            "stats.maxBreachLevel":     body.breach_level,
            "stats.prestigeMultiplier": body.prestige_multiplier,
        }, "$setOnInsert": {"firstSeen": now}},
        upsert=True,
    )

    # Maybe trigger global event
    await _maybe_trigger_global_event(r, db, body.breach_level, body.total_cycles)

    return {"ok": True, "displayName": display_name}


@app.get("/api/network/leaderboard")
async def get_leaderboard(
    type: str = Query("cycles", regex="^(cycles|breach)$"),
    limit: int = Query(50, ge=1, le=100),
):
    r = _get_redis()

    key = f"leaderboard:{type}"
    # Try cache first
    cache_key = f"cache:lb:{type}:{limit}"
    cached = await r.get(cache_key)
    if cached:
        return json.loads(cached)

    # Get top N from sorted set (descending)
    raw = await r.zrevrange(key, 0, limit - 1, withscores=True)
    names = await r.hmget("players:names", [sid for sid, _ in raw]) if raw else []

    entries = []
    for i, ((sid, score), name) in enumerate(zip(raw, names)):
        entries.append({
            "rank":        i + 1,
            "sessionId":   sid[:8] + "...",  # privacy: truncate
            "displayName": name or f"AGENT_{sid[:8].upper()}",
            "score":       score,
        })

    result = {"entries": entries, "type": type}

    # Cache for 30s
    await r.set(cache_key, json.dumps(result), ex=30)
    return result


@app.get("/api/network/leaderboard/rank/{session_id}")
async def get_player_rank(session_id: str, type: str = Query("cycles")):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")
    r = _get_redis()
    key = f"leaderboard:{type}"
    rank  = await r.zrevrank(key, session_id)
    score = await r.zscore(key, session_id)
    total = await r.zcard(key)
    return {
        "rank":  (rank + 1) if rank is not None else None,
        "score": score,
        "total": total,
    }


@app.get("/api/network/market")
async def get_market(
    type:   str = Query("all"),
    rarity: str = Query("all"),
    limit:  int = Query(30, ge=1, le=100),
):
    db = _get_mongo()

    # Build filter
    filt: dict = {"expiresAt": {"$gt": time.time()}}
    if type   != "all": filt["item.type"]   = type
    if rarity != "all": filt["item.rarity"] = rarity

    cursor = db.market_listings.find(filt).sort("createdAt", -1).limit(limit)
    docs   = await cursor.to_list(length=limit)

    listings = []
    for d in docs:
        listings.append({
            "id":          str(d["_id"]),
            "sellerName":  d.get("sellerName", "UNKNOWN"),
            "item":        d.get("item", {}),
            "priceFrag":   d.get("priceFrag", 0),
            "expiresAt":   d.get("expiresAt", 0),
            "createdAt":   d.get("createdAt", 0),
        })

    total = await db.market_listings.count_documents({"expiresAt": {"$gt": time.time()}})
    return {"listings": listings, "total": total}


@app.post("/api/network/market/list")
async def list_equipment(body: MarketListRequest):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")
    if body.price_frag < 1 or body.price_frag > 10000:
        raise HTTPException(400, "Price must be 1–10000 fragments")
    if body.item_mult <= 0 or body.item_mult > 20:
        raise HTTPException(400, "Invalid item mult")

    r  = _get_redis()
    db = _get_mongo()

    # Rate limit: 3 listings per 60s
    rl_key = f"ratelimit:market_list:{body.session_id}"
    if not await _check_rate_limit(r, rl_key, 3, 60):
        raise HTTPException(429, "Rate limit: max 3 listings per minute")

    # Max 10 active listings per seller
    existing_count = await db.market_listings.count_documents({
        "sellerId": body.session_id,
        "expiresAt": {"$gt": time.time()},
    })
    if existing_count >= 10:
        raise HTTPException(400, "Max 10 active listings per player")

    display_name = _safe_display_name(body.session_id, body.display_name)
    now      = time.time()
    expires  = now + 86400  # 24 hours

    valid_rarities = {"common", "uncommon", "rare", "epic", "legendary", "mythic"}
    valid_types    = {"cpu", "memory", "nic", "crypto", "algorithm"}
    if body.item_rarity not in valid_rarities:
        raise HTTPException(400, "Invalid rarity")
    if body.item_type not in valid_types:
        raise HTTPException(400, "Invalid type")

    result = await db.market_listings.insert_one({
        "sellerId":    body.session_id,
        "sellerName":  display_name,
        "item": {
            "name":        body.item_name[:50],
            "rarity":      body.item_rarity,
            "type":        body.item_type,
            "mult":        round(body.item_mult, 3),
            "description": body.item_desc[:100],
        },
        "priceFrag":  body.price_frag,
        "createdAt":  now,
        "expiresAt":  expires,
    })

    listing_id = str(result.inserted_id)
    # Add to Redis sorted set (score = expiresAt for TTL tracking)
    await r.zadd("market:active", {listing_id: expires})
    # Invalidate market cache
    await r.delete("cache:market:all")

    return {"ok": True, "listingId": listing_id, "expiresAt": expires}


@app.post("/api/network/market/buy")
async def buy_equipment(body: MarketBuyRequest):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")

    r  = _get_redis()
    db = _get_mongo()

    # Rate limit: 10 buys per minute
    rl_key = f"ratelimit:market_buy:{body.session_id}"
    if not await _check_rate_limit(r, rl_key, 10, 60):
        raise HTTPException(429, "Rate limit exceeded")

    from bson import ObjectId
    try:
        oid = ObjectId(body.listing_id)
    except Exception:
        raise HTTPException(400, "Invalid listing_id")

    listing = await db.market_listings.find_one({
        "_id":       oid,
        "expiresAt": {"$gt": time.time()},
    })
    if not listing:
        raise HTTPException(404, "Listing not found or expired")
    if listing["sellerId"] == body.session_id:
        raise HTTPException(400, "Cannot buy your own listing")
    if body.buyer_fragments < listing["priceFrag"]:
        raise HTTPException(400, f"Not enough fragments (need {listing['priceFrag']})")

    # Delete listing (atomic: if already deleted → 404)
    del_result = await db.market_listings.delete_one({"_id": oid, "expiresAt": {"$gt": time.time()}})
    if del_result.deleted_count == 0:
        raise HTTPException(409, "Listing already sold or expired")

    # Remove from Redis sorted set
    await r.zrem("market:active", body.listing_id)
    await r.delete("cache:market:all")

    return {
        "ok":       True,
        "item":     listing["item"],
        "pricePaid": listing["priceFrag"],
    }


@app.delete("/api/network/market/{listing_id}")
async def cancel_listing(listing_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    r  = _get_redis()
    db = _get_mongo()

    from bson import ObjectId
    try:
        oid = ObjectId(listing_id)
    except Exception:
        raise HTTPException(400, "Invalid listing_id")

    result = await db.market_listings.delete_one({"_id": oid, "sellerId": session_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Listing not found or not yours")

    await r.zrem("market:active", listing_id)
    await r.delete("cache:market:all")
    return {"ok": True}


@app.get("/api/network/event")
async def get_global_event():
    r = _get_redis()
    data = await r.hgetall("event:global")
    if not data or float(data.get("expiresAt", 0)) <= time.time():
        return {"active": False}
    return {
        "active":      True,
        "type":        data.get("type"),
        "title":       data.get("title"),
        "description": data.get("description"),
        "effectType":  data.get("effectType"),
        "effectValue": float(data.get("effectValue", 1)),
        "expiresAt":   float(data.get("expiresAt", 0)),
        "remainingSec": max(0, float(data.get("expiresAt", 0)) - time.time()),
    }


@app.get("/api/network/stats")
async def get_network_stats():
    r  = _get_redis()
    db = _get_mongo()

    total_players  = await r.zcard("leaderboard:cycles")
    active_market  = await db.market_listings.count_documents({"expiresAt": {"$gt": time.time()}})
    top_breach_raw = await r.zrevrange("leaderboard:breach", 0, 0, withscores=True)
    top_breach     = int(top_breach_raw[0][1]) if top_breach_raw else 0
    top_cycles_raw = await r.zrevrange("leaderboard:cycles", 0, 0, withscores=True)
    top_cycles     = top_cycles_raw[0][1] if top_cycles_raw else 0

    event_data = await r.hgetall("event:global")
    has_event  = bool(event_data) and float(event_data.get("expiresAt", 0)) > time.time()

    return {
        "totalPlayers":   total_players,
        "activeListings": active_market,
        "topBreachLevel": top_breach,
        "topCycles":      top_cycles,
        "globalEvent":    has_event,
    }


@app.get("/api/network/profile/{session_id}")
async def get_profile(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")
    db = _get_mongo()
    player = await db.players.find_one({"_id": session_id})
    if not player:
        return {"exists": False}
    player["_id"] = str(player["_id"])
    return {"exists": True, "player": player}


# ── Monitor helpers ────────────────────────────────────────────────────────────
def _read_cpu_stats() -> tuple[int, int]:
    try:
        with open("/proc/stat") as f:
            line = f.readline()
        fields = list(map(int, line.split()[1:]))
        idle  = fields[3] + (fields[4] if len(fields) > 4 else 0)
        total = sum(fields)
        return total, idle
    except Exception:
        return 0, 0


def _read_mem_info() -> dict:
    info: dict = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    info[parts[0].rstrip(":")] = int(parts[1])
    except Exception:
        pass
    return info


def _read_disk_usage(path: str = "/") -> tuple[int, int, int]:
    try:
        import shutil
        total, used, free = shutil.disk_usage(path)
        return total, used, free
    except Exception:
        return 0, 0, 0


async def _get_docker_containers() -> list:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "ps", "--format",
            '{"name":"{{.Names}}","status":"{{.Status}}","image":"{{.Image}}"}',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        containers = []
        for line in out.decode().strip().splitlines():
            try:
                containers.append(json.loads(line))
            except Exception:
                pass
        return containers
    except Exception:
        return []


async def _get_redis_info() -> dict:
    r = _get_redis()
    try:
        info = await r.info()
        return {
            "used_memory_human":         info.get("used_memory_human", "N/A"),
            "connected_clients":         info.get("connected_clients", 0),
            "total_commands_processed":  info.get("total_commands_processed", 0),
            "keyspace_hits":             info.get("keyspace_hits", 0),
            "keyspace_misses":           info.get("keyspace_misses", 0),
            "uptime_in_seconds":         info.get("uptime_in_seconds", 0),
        }
    except Exception:
        return {}


async def _get_mongo_info() -> dict:
    db = _get_mongo()
    try:
        status = await db.command("serverStatus")
        return {
            "connections_current":   status.get("connections", {}).get("current", 0),
            "connections_available": status.get("connections", {}).get("available", 0),
            "opcounters":            {k: v for k, v in status.get("opcounters", {}).items()},
            "uptime":                status.get("uptime", 0),
        }
    except Exception:
        return {}


# CPU usage needs two samples to compute delta — store previous reading
_cpu_prev: dict = {"total": 0, "idle": 0, "percent": 0.0}


@app.get("/api/monitor/stats")
async def get_monitor_stats():
    global _cpu_prev

    # CPU delta
    total, idle = _read_cpu_stats()
    d_total = total - _cpu_prev["total"]
    d_idle  = idle  - _cpu_prev["idle"]
    cpu_pct = max(0.0, min(100.0, (1 - d_idle / max(d_total, 1)) * 100)) if d_total > 0 else _cpu_prev["percent"]
    _cpu_prev = {"total": total, "idle": idle, "percent": cpu_pct}

    # Memory
    mem       = _read_mem_info()
    mem_total = mem.get("MemTotal", 0)
    mem_free  = mem.get("MemAvailable", mem.get("MemFree", 0))
    mem_used  = mem_total - mem_free
    mem_pct   = (mem_used / mem_total * 100) if mem_total > 0 else 0.0

    # Disk
    disk_total, disk_used, _ = _read_disk_usage("/")
    disk_pct = (disk_used / disk_total * 100) if disk_total > 0 else 0.0

    # Docker + Redis + MongoDB in parallel
    results = await asyncio.gather(
        _get_docker_containers(),
        _get_redis_info(),
        _get_mongo_info(),
        return_exceptions=True,
    )
    containers = results[0] if not isinstance(results[0], Exception) else []
    redis_info = results[1] if not isinstance(results[1], Exception) else {}
    mongo_info = results[2] if not isinstance(results[2], Exception) else {}

    return {
        "ts": int(time.time() * 1000),
        "system": {
            "cpu_percent":   round(cpu_pct, 1),
            "mem_total_kb":  mem_total,
            "mem_used_kb":   mem_used,
            "mem_percent":   round(mem_pct, 1),
            "disk_total_gb": round(disk_total / 1024 ** 3, 2),
            "disk_used_gb":  round(disk_used  / 1024 ** 3, 2),
            "disk_percent":  round(disk_pct, 1),
        },
        "containers": containers,
        "redis":      redis_info,
        "mongodb":    mongo_info,
    }


# ── Analytics models ───────────────────────────────────────────────────────────
class RunRecord(BaseModel):
    session_id:       str
    breach_level:     int
    duration_sec:     int
    total_cycles:     float
    stage_reached:    str
    modifier_used:    str = ""
    fragments_gained: int = 0
    equip_drops:      int = 0
    legendary_drops:  int = 0
    mythic_drops:     int = 0


@app.post("/api/analytics/run")
async def submit_run(body: RunRecord):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")

    r  = _get_redis()
    db = _get_mongo()

    rl_key = f"ratelimit:analytics_run:{body.session_id}"
    if not await _check_rate_limit(r, rl_key, 20, 3600):
        raise HTTPException(429, "Rate limit exceeded")

    doc = body.model_dump()
    doc["createdAt"] = time.time()
    await db.run_records.insert_one(doc)
    return {"ok": True}


@app.get("/api/analytics/runs/{session_id}")
async def get_runs(session_id: str, limit: int = Query(default=20, le=50)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db = _get_mongo()
    cursor = db.run_records.find(
        {"session_id": session_id},
        {"_id": 0},
        sort=[("createdAt", -1)],
        limit=limit,
    )
    runs = await cursor.to_list(length=limit)
    return {"runs": runs}


@app.get("/api/analytics/summary/{session_id}")
async def get_summary(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db = _get_mongo()

    agg = await db.run_records.aggregate([
        {"$match": {"session_id": session_id}},
        {"$group": {
            "_id":             None,
            "total_runs":      {"$sum": 1},
            "best_breach":     {"$max": "$breach_level"},
            "total_cycles":    {"$sum": "$total_cycles"},
            "avg_duration":    {"$avg": "$duration_sec"},
            "total_fragments": {"$sum": "$fragments_gained"},
            "total_drops":     {"$sum": "$equip_drops"},
            "legendary_drops": {"$sum": "$legendary_drops"},
            "mythic_drops":    {"$sum": "$mythic_drops"},
        }},
    ]).to_list(length=1)

    if not agg:
        return {"exists": False}

    summary = {k: v for k, v in agg[0].items() if k != "_id"}

    by_breach = await db.run_records.aggregate([
        {"$match": {"session_id": session_id}},
        {"$group": {
            "_id":         "$breach_level",
            "count":       {"$sum": 1},
            "avg_dur":     {"$avg": "$duration_sec"},
            "avg_cycles":  {"$avg": "$total_cycles"},
        }},
        {"$sort": {"_id": 1}},
    ]).to_list(length=30)

    top_mods = await db.run_records.aggregate([
        {"$match": {"session_id": session_id, "modifier_used": {"$ne": ""}}},
        {"$group": {"_id": "$modifier_used", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 5},
    ]).to_list(length=5)

    return {
        "exists":  True,
        "summary": summary,
        "byBreach": [
            {"breach": s["_id"], "count": s["count"],
             "avgDuration": s["avg_dur"], "avgCycles": s["avg_cycles"]}
            for s in by_breach
        ],
        "topModifiers": [{"modifier": s["_id"], "count": s["count"]} for s in top_mods],
    }


# ── Planner: image upload ──────────────────────────────────────────────────────
ALLOWED_IMG_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_UPLOAD_BYTES  = 5 * 1024 * 1024  # 5 MB


@app.post("/api/planner/upload")
async def upload_image(
    session_id: str = Form(...),
    file:        UploadFile = File(...),
):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")
    if file.content_type not in ALLOWED_IMG_TYPES:
        raise HTTPException(415, "Unsupported image type")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 5 MB)")

    ext  = (file.filename or "img").rsplit(".", 1)[-1].lower()
    ext  = ext if ext in {"jpg", "jpeg", "png", "gif", "webp"} else "jpg"
    name = f"{uuid.uuid4().hex}.{ext}"
    path = os.path.join(UPLOADS_DIR, name)
    with open(path, "wb") as f:
        f.write(content)

    return {"url": f"/uploads/{name}"}


# ── Planner: memo models & endpoints ──────────────────────────────────────────
class MemoCreate(BaseModel):
    session_id:  str
    title:       str
    content:     str   = ""
    image_url:   str   = ""      # /uploads/{name} from upload endpoint
    activate_at: float = 0       # unix ts; 0 = immediately
    expires_at:  float = 0       # unix ts; 0 = never


def _memo_out(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id"))
    return doc


@app.post("/api/planner/memos")
async def create_memo(body: MemoCreate):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")

    now = time.time()
    doc: dict = {
        "sessionId":  body.session_id,
        "title":      body.title[:200],
        "content":    body.content[:4000],
        "imageUrl":   body.image_url,
        "activateAt": body.activate_at or now,
        "isDone":     False,
        "createdAt":  now,
    }
    # TTL field: only set when expiry is specified (MongoDB drops doc at this time)
    if body.expires_at > now:
        from datetime import datetime, timezone
        doc["expiresAt"] = datetime.fromtimestamp(body.expires_at, tz=timezone.utc)

    db = _get_mongo()
    result = await db.planner_memos.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    if "expiresAt" in doc:
        doc["expiresAt"] = body.expires_at  # return as unix ts for frontend
    return doc


@app.get("/api/planner/memos")
async def list_memos(session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db   = _get_mongo()
    docs = await db.planner_memos.find(
        {"sessionId": session_id},
        sort=[("createdAt", -1)],
        limit=100,
    ).to_list(length=100)

    out = []
    for d in docs:
        d["id"] = str(d.pop("_id"))
        # Convert datetime expiresAt back to unix ts
        if "expiresAt" in d and hasattr(d["expiresAt"], "timestamp"):
            d["expiresAt"] = d["expiresAt"].timestamp()
        out.append(d)
    return {"memos": out}


@app.patch("/api/planner/memos/{memo_id}/done")
async def toggle_memo_done(memo_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(memo_id)
    except Exception:
        raise HTTPException(400, "Invalid memo_id")

    db  = _get_mongo()
    doc = await db.planner_memos.find_one({"_id": oid, "sessionId": session_id})
    if not doc:
        raise HTTPException(404, "Memo not found")

    new_val = not doc.get("isDone", False)
    await db.planner_memos.update_one({"_id": oid}, {"$set": {"isDone": new_val}})
    return {"ok": True, "isDone": new_val}


@app.delete("/api/planner/memos/{memo_id}")
async def delete_memo(memo_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(memo_id)
    except Exception:
        raise HTTPException(400, "Invalid memo_id")

    db = _get_mongo()
    # Also delete uploaded image if any
    doc = await db.planner_memos.find_one({"_id": oid, "sessionId": session_id}, {"imageUrl": 1})
    if doc and doc.get("imageUrl", "").startswith("/uploads/"):
        img_path = os.path.join(UPLOADS_DIR, doc["imageUrl"].split("/uploads/")[-1])
        try:
            os.unlink(img_path)
        except Exception:
            pass

    result = await db.planner_memos.delete_one({"_id": oid, "sessionId": session_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Memo not found")
    return {"ok": True}


# ── Planner: schedule models & endpoints ───────────────────────────────────────
class ScheduleCreate(BaseModel):
    session_id:   str
    label:        str
    type:         str    # "recurring" | "onetime"
    cron:         str  = ""    # for recurring
    scheduled_at: float = 0    # unix ts for onetime
    note:         str  = ""


def _sched_out(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id"))
    if "scheduledAt" in doc and hasattr(doc["scheduledAt"], "timestamp"):
        doc["scheduledAt"] = doc["scheduledAt"].timestamp()
    return doc


@app.post("/api/planner/schedules")
async def create_schedule(body: ScheduleCreate):
    if not _valid_session(body.session_id):
        raise HTTPException(400, "Invalid session_id")
    if body.type not in ("recurring", "onetime"):
        raise HTTPException(400, "type must be recurring or onetime")
    if body.type == "recurring" and not body.cron.strip():
        raise HTTPException(400, "cron expression required for recurring")
    if body.type == "onetime" and body.scheduled_at <= 0:
        raise HTTPException(400, "scheduled_at required for onetime")

    # Validate cron for recurring
    if body.type == "recurring":
        parts = body.cron.strip().split()
        if len(parts) != 5:
            raise HTTPException(400, "cron must have 5 fields: min hr dom mon dow")

    now = time.time()
    doc: dict = {
        "sessionId":  body.session_id,
        "label":      body.label[:200],
        "type":       body.type,
        "cron":       body.cron.strip() if body.type == "recurring" else "",
        "note":       body.note[:1000],
        "isActive":   True,
        "isDone":     False,
        "createdAt":  now,
        "notifiedAt": 0,
    }
    if body.type == "onetime":
        doc["scheduledAt"] = body.scheduled_at

    db     = _get_mongo()
    result = await db.planner_schedules.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@app.get("/api/planner/schedules")
async def list_schedules(session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db   = _get_mongo()
    docs = await db.planner_schedules.find(
        {"sessionId": session_id},
        sort=[("createdAt", -1)],
        limit=200,
    ).to_list(length=200)

    return {"schedules": [_sched_out(d) for d in docs]}


@app.patch("/api/planner/schedules/{sched_id}/toggle")
async def toggle_schedule(sched_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(sched_id)
    except Exception:
        raise HTTPException(400, "Invalid sched_id")

    db  = _get_mongo()
    doc = await db.planner_schedules.find_one({"_id": oid, "sessionId": session_id})
    if not doc:
        raise HTTPException(404, "Schedule not found")

    new_val = not doc.get("isActive", True)
    await db.planner_schedules.update_one({"_id": oid}, {"$set": {"isActive": new_val}})
    return {"ok": True, "isActive": new_val}


@app.patch("/api/planner/schedules/{sched_id}/done")
async def mark_schedule_done(sched_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(sched_id)
    except Exception:
        raise HTTPException(400, "Invalid sched_id")

    db  = _get_mongo()
    doc = await db.planner_schedules.find_one({"_id": oid, "sessionId": session_id})
    if not doc:
        raise HTTPException(404, "Schedule not found")

    new_val = not doc.get("isDone", False)
    await db.planner_schedules.update_one({"_id": oid}, {"$set": {"isDone": new_val}})
    return {"ok": True, "isDone": new_val}


@app.delete("/api/planner/schedules/{sched_id}")
async def delete_schedule(sched_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(sched_id)
    except Exception:
        raise HTTPException(400, "Invalid sched_id")

    db     = _get_mongo()
    result = await db.planner_schedules.delete_one({"_id": oid, "sessionId": session_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Schedule not found")
    return {"ok": True}


# ── Planner: alerts endpoint ───────────────────────────────────────────────────
@app.get("/api/planner/alerts")
async def get_alerts(session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db  = _get_mongo()
    now = time.time()
    alerts = []

    # Overdue one-time schedules (past scheduledAt, not done, active)
    overdue_scheds = await db.planner_schedules.find({
        "sessionId":   session_id,
        "type":        "onetime",
        "isDone":      False,
        "isActive":    True,
        "scheduledAt": {"$lt": now},
    }, {"_id": 1, "label": 1, "scheduledAt": 1, "note": 1}).to_list(length=50)

    for s in overdue_scheds:
        alerts.append({
            "type":        "overdue_schedule",
            "id":          str(s["_id"]),
            "label":       s.get("label", ""),
            "scheduledAt": s.get("scheduledAt", 0),
            "note":        s.get("note", ""),
        })

    # Memos expiring within the next hour (not done)
    from datetime import datetime, timezone
    soon = datetime.fromtimestamp(now + 3600, tz=timezone.utc)
    now_dt = datetime.fromtimestamp(now, tz=timezone.utc)
    expiring_memos = await db.planner_memos.find({
        "sessionId": session_id,
        "isDone":    False,
        "expiresAt": {"$gt": now_dt, "$lte": soon},
    }, {"_id": 1, "title": 1, "expiresAt": 1}).to_list(length=50)

    for m in expiring_memos:
        exp_ts = m["expiresAt"].timestamp() if hasattr(m["expiresAt"], "timestamp") else m["expiresAt"]
        alerts.append({
            "type":      "expiring_memo",
            "id":        str(m["_id"]),
            "label":     m.get("title", ""),
            "expiresAt": exp_ts,
        })

    # Recurring schedules that are active (just list them for awareness)
    return {"alerts": alerts, "count": len(alerts)}


# ── Monitor: time-series collector ────────────────────────────────────────────
async def monitor_collector_loop() -> None:
    """Background: collect CPU/mem/disk every 30s into Redis List (60 samples = 30min)."""
    await asyncio.sleep(15)
    while True:
        try:
            r = _get_redis()
            total, idle = _read_cpu_stats()
            d_total = total - _cpu_prev["total"]
            d_idle  = idle  - _cpu_prev["idle"]
            cpu_pct = max(0.0, min(100.0, (1 - d_idle / max(d_total, 1)) * 100)) if d_total > 0 else _cpu_prev["percent"]
            _cpu_prev.update({"total": total, "idle": idle, "percent": cpu_pct})

            mem      = _read_mem_info()
            mem_tot  = mem.get("MemTotal", 0)
            mem_free = mem.get("MemAvailable", mem.get("MemFree", 0))
            mem_pct  = ((mem_tot - mem_free) / mem_tot * 100) if mem_tot > 0 else 0.0

            disk_tot, disk_used, _ = _read_disk_usage("/")
            disk_pct = (disk_used / disk_tot * 100) if disk_tot > 0 else 0.0

            sample = json.dumps({
                "ts":   int(time.time()),
                "cpu":  round(cpu_pct, 1),
                "mem":  round(mem_pct, 1),
                "disk": round(disk_pct, 1),
            })
            pipe = r.pipeline()
            pipe.lpush("monitor:history", sample)
            pipe.ltrim("monitor:history", 0, 59)   # 60 × 30s = 30 min
            await pipe.execute()
        except Exception:
            pass
        await asyncio.sleep(30)


@app.get("/api/monitor/history")
async def get_monitor_history():
    r   = _get_redis()
    raw = await r.lrange("monitor:history", 0, -1)
    history = []
    for item in reversed(raw):   # lrange returns newest-first; reverse for chronological
        try:
            history.append(json.loads(item))
        except Exception:
            pass
    return {"history": history}


# ── Planner: image upload orphan cleanup ──────────────────────────────────────
async def upload_cleanup_loop() -> None:
    """Background: every 6h remove /data/uploads/ images not referenced by any memo."""
    await asyncio.sleep(300)   # wait 5 min after startup
    while True:
        try:
            db = _get_mongo()
            # Collect all imageUrl values stored in memos
            docs = await db.planner_memos.find(
                {"imageUrl": {"$ne": ""}}, {"imageUrl": 1}
            ).to_list(length=10000)
            referenced = {d["imageUrl"].split("/uploads/")[-1] for d in docs if d.get("imageUrl", "").startswith("/uploads/")}

            for fname in os.listdir(UPLOADS_DIR):
                if fname not in referenced:
                    try:
                        os.unlink(os.path.join(UPLOADS_DIR, fname))
                    except Exception:
                        pass
        except Exception:
            pass
        await asyncio.sleep(6 * 3600)


# ── Planner: APScheduler integration for recurring schedules ──────────────────
def _register_planner_sched(sched_id: str, session_id: str, label: str, cron: str) -> None:
    parts = cron.strip().split()
    if len(parts) != 5:
        return
    minute, hour, dom, month, dow = parts
    try:
        trigger = CronTrigger(
            minute=minute, hour=hour, day=dom,
            month=month, day_of_week=dow, timezone="UTC",
        )
        scheduler.add_job(
            _planner_sched_fire, trigger,
            id=f"planner_{sched_id}",
            replace_existing=True,
            kwargs={"session_id": session_id, "sched_id": sched_id, "label": label},
        )
    except Exception:
        pass


def _unregister_planner_sched(sched_id: str) -> None:
    try:
        scheduler.remove_job(f"planner_{sched_id}")
    except Exception:
        pass


async def _planner_sched_fire(session_id: str, sched_id: str, label: str) -> None:
    """Called by APScheduler when a recurring planner schedule fires."""
    db = _get_mongo()
    await db.planner_notifications.insert_one({
        "sessionId":  session_id,
        "scheduleId": sched_id,
        "label":      label,
        "firedAt":    time.time(),
        "acked":      False,
    })


async def _load_planner_schedules() -> None:
    """Register all active recurring planner schedules into APScheduler on startup."""
    db   = _get_mongo()
    docs = await db.planner_schedules.find(
        {"type": "recurring", "isActive": True}
    ).to_list(length=5000)
    for doc in docs:
        _register_planner_sched(
            str(doc["_id"]), doc["sessionId"], doc["label"], doc["cron"]
        )


# ── Planner: new REST endpoints ────────────────────────────────────────────────

class MemoUpdate(BaseModel):
    title:       Optional[str]   = None
    content:     Optional[str]   = None
    activate_at: Optional[float] = None
    expires_at:  Optional[float] = None


@app.patch("/api/planner/memos/{memo_id}")
async def update_memo(memo_id: str, body: MemoUpdate, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(memo_id)
    except Exception:
        raise HTTPException(400, "Invalid memo_id")

    db  = _get_mongo()
    now = time.time()
    upd: dict = {}
    if body.title       is not None: upd["title"]      = body.title[:200]
    if body.content     is not None: upd["content"]    = body.content[:4000]
    if body.activate_at is not None: upd["activateAt"] = body.activate_at or now
    if body.expires_at  is not None:
        if body.expires_at > now:
            from datetime import datetime, timezone
            upd["expiresAt"] = datetime.fromtimestamp(body.expires_at, tz=timezone.utc)
        else:
            upd["$unset"] = {"expiresAt": ""}

    if not upd:
        return {"ok": True}

    # Separate $unset if present
    set_fields = {k: v for k, v in upd.items() if k != "$unset"}
    mongo_op: dict = {}
    if set_fields:        mongo_op["$set"]   = set_fields
    if "$unset" in upd:   mongo_op["$unset"] = upd["$unset"]

    result = await db.planner_memos.update_one(
        {"_id": oid, "sessionId": session_id}, mongo_op
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Memo not found")
    return {"ok": True}


class ScheduleUpdate(BaseModel):
    label:        Optional[str]   = None
    cron:         Optional[str]   = None
    scheduled_at: Optional[float] = None
    note:         Optional[str]   = None
    is_active:    Optional[bool]  = None


@app.patch("/api/planner/schedules/{sched_id}")
async def update_schedule(sched_id: str, body: ScheduleUpdate, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(sched_id)
    except Exception:
        raise HTTPException(400, "Invalid sched_id")

    db  = _get_mongo()
    doc = await db.planner_schedules.find_one({"_id": oid, "sessionId": session_id})
    if not doc:
        raise HTTPException(404, "Schedule not found")

    upd: dict = {}
    if body.label        is not None: upd["label"]       = body.label[:200]
    if body.note         is not None: upd["note"]        = body.note[:1000]
    if body.is_active    is not None: upd["isActive"]    = body.is_active
    if body.scheduled_at is not None: upd["scheduledAt"] = body.scheduled_at
    if body.cron         is not None:
        parts = body.cron.strip().split()
        if len(parts) != 5:
            raise HTTPException(400, "cron must have 5 fields")
        upd["cron"] = body.cron.strip()

    if upd:
        await db.planner_schedules.update_one({"_id": oid}, {"$set": upd})

    # Update APScheduler if cron or isActive changed for recurring schedules
    if doc.get("type") == "recurring":
        new_cron     = upd.get("cron",     doc.get("cron", ""))
        new_active   = upd.get("isActive", doc.get("isActive", True))
        new_label    = upd.get("label",    doc.get("label", ""))
        if new_active:
            _register_planner_sched(sched_id, session_id, new_label, new_cron)
        else:
            _unregister_planner_sched(sched_id)

    return {"ok": True}


# ── Planner: notifications (APScheduler-fired alerts) ─────────────────────────
@app.get("/api/planner/notifications")
async def get_notifications(session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db   = _get_mongo()
    docs = await db.planner_notifications.find(
        {"sessionId": session_id, "acked": False},
        sort=[("firedAt", -1)],
        limit=20,
    ).to_list(length=20)

    out = []
    for d in docs:
        out.append({
            "id":         str(d["_id"]),
            "scheduleId": d.get("scheduleId", ""),
            "label":      d.get("label", ""),
            "firedAt":    d.get("firedAt", 0),
        })
    return {"notifications": out}


@app.patch("/api/planner/notifications/{notif_id}/ack")
async def ack_notification(notif_id: str, session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    from bson import ObjectId
    try:
        oid = ObjectId(notif_id)
    except Exception:
        raise HTTPException(400, "Invalid notif_id")

    db = _get_mongo()
    await db.planner_notifications.update_one(
        {"_id": oid, "sessionId": session_id}, {"$set": {"acked": True}}
    )
    return {"ok": True}


@app.delete("/api/planner/notifications/ack-all")
async def ack_all_notifications(session_id: str = Query(...)):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")
    db = _get_mongo()
    await db.planner_notifications.update_many(
        {"sessionId": session_id, "acked": False},
        {"$set": {"acked": True}},
    )
    return {"ok": True}


# ── Analytics: stage distribution (add to summary endpoint) ───────────────────
@app.get("/api/analytics/stage-dist/{session_id}")
async def get_stage_dist(session_id: str):
    if not _valid_session(session_id):
        raise HTTPException(400, "Invalid session_id")

    db = _get_mongo()
    pipeline = [
        {"$match": {"session_id": session_id}},
        {"$group": {"_id": "$stage_reached", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    docs = await db.run_records.aggregate(pipeline).to_list(length=10)
    return {"stages": [{"stage": d["_id"], "count": d["count"]} for d in docs]}
