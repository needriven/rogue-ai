import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ── Status bar ────────────────────────────────────────────────────────────────
type ConnState = 'idle' | 'connecting' | 'connected' | 'no-host' | 'error'

function StatusBar({
  state,
  onConnect,
  onDisconnect,
  token,
  setToken,
}: {
  state:        ConnState
  onConnect:    () => void
  onDisconnect: () => void
  token:        string
  setToken:     (v: string) => void
}) {
  const dot =
    state === 'connected'   ? 'bg-t-green animate-glow-pulse' :
    state === 'connecting'  ? 'bg-t-amber animate-pulse' :
    state === 'no-host'     ? 'bg-t-amber' :
                              'bg-t-muted'

  const label =
    state === 'connected'   ? 'CONNECTED' :
    state === 'connecting'  ? 'CONNECTING...' :
    state === 'no-host'     ? 'NO HOST' :
    state === 'error'       ? 'ERROR' :
                              'DISCONNECTED'

  return (
    <div className="shrink-0 border-b border-t-border bg-t-panel/60 px-5 py-2.5 flex items-center gap-4">
      <span className="text-xs text-t-green font-semibold tracking-widest">TERM</span>
      <span className="text-t-muted text-xs">//</span>

      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs text-t-dim tracking-wider">{label}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {state === 'idle' || state === 'error' || state === 'no-host' ? (
          <>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && token && onConnect()}
              placeholder="token"
              className="text-xs bg-t-surface border border-t-border text-t-text
                         px-2 py-1 outline-none focus:border-t-green placeholder:text-t-muted/40 w-36"
            />
            <button
              onClick={onConnect}
              disabled={!token}
              className="text-xs px-3 py-1 border border-t-green text-t-green
                         hover:bg-t-green hover:text-black transition-all duration-150
                         disabled:opacity-40 disabled:cursor-not-allowed tracking-wider"
            >
              CONNECT
            </button>
          </>
        ) : (
          <button
            onClick={onDisconnect}
            className="text-xs px-3 py-1 border border-t-red text-t-red
                       hover:bg-t-red hover:text-black transition-all duration-150 tracking-wider"
          >
            DISCONNECT
          </button>
        )}
      </div>
    </div>
  )
}

// ── Term page ─────────────────────────────────────────────────────────────────
export default function Term() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)

  const [connState, setConnState] = useState<ConnState>('idle')
  const [token,     setToken]     = useState(() => localStorage.getItem('term-token') ?? '')

  // ── Init xterm ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: {
        background:  '#0a0f0a',
        foreground:  '#a0b8a0',
        cursor:      '#39ff14',
        cursorAccent:'#0a0f0a',
        black:       '#0a0f0a',
        brightBlack: '#3a4a3a',
        red:         '#ff4444',
        brightRed:   '#ff6666',
        green:       '#39ff14',
        brightGreen: '#66ff44',
        yellow:      '#ffaa00',
        brightYellow:'#ffcc44',
        blue:        '#4488ff',
        brightBlue:  '#66aaff',
        magenta:     '#cc44ff',
        brightMagenta:'#ee66ff',
        cyan:        '#00cccc',
        brightCyan:  '#44eeff',
        white:       '#a0b8a0',
        brightWhite: '#c8dcc8',
      },
      fontFamily:     '"JetBrains Mono", "Fira Code", monospace',
      fontSize:       13,
      lineHeight:     1.4,
      cursorBlink:    true,
      cursorStyle:    'block',
      allowProposedApi: true,
      scrollback:     5000,
    })

    const fit   = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current  = fit

    term.writeln('\x1b[32m┌─────────────────────────────────────────┐\x1b[0m')
    term.writeln('\x1b[32m│  ROGUE_AI  //  REMOTE TERMINAL  v0.1.0  │\x1b[0m')
    term.writeln('\x1b[32m└─────────────────────────────────────────┘\x1b[0m')
    term.writeln('')
    term.writeln('\x1b[2mEnter token and press CONNECT to start session.\x1b[0m')
    term.writeln('\x1b[2mRun  agent/agent.py  on your MacBook first.\x1b[0m')
    term.writeln('')

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      term.dispose()
      termRef.current = null
    }
  }, [])

  // ── Connect ─────────────────────────────────────────────────────────────────
  const connect = () => {
    if (!token || !termRef.current) return
    localStorage.setItem('term-token', token)

    const term = termRef.current

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url   = `${proto}//${location.host}/ws/term/client?token=${encodeURIComponent(token)}`

    setConnState('connecting')
    term.writeln(`\x1b[33mConnecting to relay...\x1b[0m`)

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setConnState('connected')
      term.writeln(`\x1b[32mRelay connected. Waiting for host...\x1b[0m`)
      term.writeln('')

      // Send initial resize
      const cols = term.cols
      const rows = term.rows
      const resize = new TextEncoder().encode(`\x1b[8;${rows};${cols}t`)
      ws.send(resize)

      // Forward keystrokes
      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data))
      })

      // Forward resizes
      term.onResize(({ rows: r, cols: c }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(`\x1b[8;${r};${c}t`))
        }
        fitRef.current?.fit()
      })
    }

    ws.onmessage = evt => {
      const data = evt.data instanceof ArrayBuffer
        ? new Uint8Array(evt.data)
        : new TextEncoder().encode(evt.data as string)
      term.write(data)
    }

    ws.onclose = (ev) => {
      setConnState('idle')
      term.writeln(`\r\n\x1b[31mDisconnected (${ev.code})\x1b[0m`)
      wsRef.current = null
    }

    ws.onerror = () => {
      setConnState('error')
      term.writeln('\x1b[31mWebSocket error\x1b[0m')
    }
  }

  const disconnect = () => {
    wsRef.current?.close()
    wsRef.current = null
    setConnState('idle')
  }

  // Fit on route mount
  useEffect(() => {
    const id = setTimeout(() => fitRef.current?.fit(), 50)
    return () => clearTimeout(id)
  }, [])

  return (
    <div className="h-full flex flex-col animate-fade-in">
      <StatusBar
        state={connState}
        onConnect={connect}
        onDisconnect={disconnect}
        token={token}
        setToken={setToken}
      />

      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-2 bg-[#0a0f0a]"
        onClick={() => termRef.current?.focus()}
      />
    </div>
  )
}
