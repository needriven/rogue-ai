#!/usr/bin/env python3
"""
Rogue AI — Terminal relay agent (runs on MacBook)

Connects to the OCI WebSocket relay and bridges it to a local PTY,
letting the browser at chans.place/term control a local terminal.

Usage:
    python agent.py                        # uses .env or env vars
    python agent.py --cmd "claude"         # launch claude instead of bash
    python agent.py --relay wss://chans.place --token $TERM_TOKEN

Env vars (can also live in agent/.env):
    RELAY_URL   wss://chans.place          (no trailing slash)
    TERM_TOKEN  your-secret-token
    TERM_CMD    bash  (default)
    TERM_ROWS   24
    TERM_COLS   200
"""

import argparse
import asyncio
import os
import shlex
import signal
import struct
import sys
import termios
import fcntl
import pty
from pathlib import Path

# ── optional .env loader ──────────────────────────────────────────────────────
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            k, _, v = _line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

try:
    import websockets
except ImportError:
    print("Missing dependency: pip install websockets")
    sys.exit(1)


# ── Config ────────────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Rogue AI terminal relay agent")
    p.add_argument("--relay", default=os.environ.get("RELAY_URL", "wss://chans.place"))
    p.add_argument("--token", default=os.environ.get("TERM_TOKEN", ""))
    p.add_argument("--cmd",   default=os.environ.get("TERM_CMD",   "bash"))
    p.add_argument("--rows",  type=int, default=int(os.environ.get("TERM_ROWS", "24")))
    p.add_argument("--cols",  type=int, default=int(os.environ.get("TERM_COLS", "200")))
    p.add_argument("--reconnect-delay", type=float, default=5.0)
    return p.parse_args()


# ── PTY helpers ───────────────────────────────────────────────────────────────
def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def spawn_pty(cmd: str, rows: int, cols: int) -> tuple[int, int]:
    """Fork a child with a PTY. Returns (child_pid, master_fd)."""
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        # Child: exec the command
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(cols)
        os.environ["LINES"]   = str(rows)
        args = shlex.split(cmd)
        os.execvp(args[0], args)
        sys.exit(1)
    # Parent
    set_winsize(master_fd, rows, cols)
    return child_pid, master_fd


# ── Main relay loop ───────────────────────────────────────────────────────────
async def run_session(ws_url: str, cmd: str, rows: int, cols: int) -> None:
    """Spawn PTY, connect to relay, bridge bytes in both directions."""
    child_pid, master_fd = spawn_pty(cmd, rows, cols)
    print(f"[agent] PTY spawned: pid={child_pid}  cmd={cmd}")

    loop = asyncio.get_event_loop()

    # Queue for PTY output → WebSocket
    pty_out_queue: asyncio.Queue[bytes] = asyncio.Queue()

    # Read PTY output in a thread (blocking read)
    def _read_pty() -> None:
        while True:
            try:
                data = os.read(master_fd, 4096)
                if not data:
                    break
                loop.call_soon_threadsafe(pty_out_queue.put_nowait, data)
            except OSError:
                break
        loop.call_soon_threadsafe(pty_out_queue.put_nowait, b"")  # sentinel

    import threading
    t = threading.Thread(target=_read_pty, daemon=True)
    t.start()

    try:
        async with websockets.connect(ws_url) as ws:
            print(f"[agent] connected to relay: {ws_url}")

            # Forward PTY output to WebSocket
            async def pty_to_ws() -> None:
                while True:
                    data = await pty_out_queue.get()
                    if not data:
                        break
                    try:
                        await ws.send(data)
                    except Exception:
                        break

            # Forward WebSocket input to PTY
            async def ws_to_pty() -> None:
                async for msg in ws:
                    try:
                        raw = msg if isinstance(msg, bytes) else msg.encode()
                        # Handle resize: escape sequence \x1b[8;<rows>;<cols>t
                        if raw.startswith(b"\x1b[8;") and raw.endswith(b"t"):
                            try:
                                _, r, c = raw[4:-1].split(b";")
                                set_winsize(master_fd, int(r), int(c))
                            except Exception:
                                pass
                            continue
                        os.write(master_fd, raw)
                    except OSError:
                        break

            await asyncio.gather(pty_to_ws(), ws_to_pty())
    except Exception as e:
        print(f"[agent] relay error: {e}")
    finally:
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.close(master_fd)
        print("[agent] session ended")


async def main() -> None:
    args = parse_args()

    if not args.token:
        print("[agent] ERROR: TERM_TOKEN not set.")
        print("  Set it in agent/.env:  TERM_TOKEN=your-secret-token")
        print("  Or pass --token <token>")
        sys.exit(1)

    ws_url = f"{args.relay.rstrip('/')}/ws/term/host?token={args.token}"
    print(f"[agent] relay  : {args.relay}")
    print(f"[agent] command: {args.cmd}")
    print(f"[agent] size   : {args.rows}×{args.cols}")

    while True:
        try:
            await run_session(ws_url, args.cmd, args.rows, args.cols)
        except KeyboardInterrupt:
            print("\n[agent] stopped.")
            break
        except Exception as e:
            print(f"[agent] error: {e}")
        print(f"[agent] reconnecting in {args.reconnect_delay}s...")
        await asyncio.sleep(args.reconnect_delay)


if __name__ == "__main__":
    asyncio.run(main())
