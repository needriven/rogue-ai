import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import aiosqlite
import feedparser
import httpx
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


# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    task = asyncio.create_task(feed_fetcher_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


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
