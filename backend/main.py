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
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────
DATABASE_PATH  = os.environ.get("DATABASE_PATH", "./saves.db")
MAX_SAVE_BYTES = 512 * 1024   # 512 KB
UUID_RE        = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
FEED_FETCH_INTERVAL = int(os.environ.get("FEED_FETCH_INTERVAL", "3600"))  # seconds
FEED_MAX_ITEMS_PER_SOURCE = 100


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
