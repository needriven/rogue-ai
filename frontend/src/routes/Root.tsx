import { Outlet, Link, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useGameState } from '@/hooks/useGameState'
import OfflineModal from '@/components/OfflineModal'

const NAV_ITEMS = [
  { to: '/',         label: 'HOME',     icon: '~',  exact: true  },
  { to: '/game',     label: 'GAME',     icon: '▶',  exact: false },
  { to: '/settings', label: 'SETTINGS', icon: '⚙',  exact: false },
] as const

function formatUptime(s: number): string {
  const h   = Math.floor(s / 3600).toString().padStart(2, '0')
  const m   = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${h}:${m}:${sec}`
}

function NavItem({ to, label, icon, exact }: {
  to: string; label: string; icon: string; exact: boolean
}) {
  const match    = useMatchRoute()
  const isActive = !!match({ to, fuzzy: !exact })

  return (
    <Link
      to={to}
      className={[
        'group flex items-center gap-3 px-4 py-2.5 text-xs tracking-widest',
        'transition-all duration-150 border-l-2',
        isActive
          ? 'border-t-green text-t-green bg-t-green-glow'
          : 'border-transparent text-t-dim hover:text-t-text hover:border-t-border',
      ].join(' ')}
    >
      <span className={[
        'w-4 text-center transition-colors duration-150 text-sm leading-none',
        isActive ? 'text-t-green' : 'text-t-muted group-hover:text-t-dim',
      ].join(' ')}>
        {icon}
      </span>
      <span>{label}</span>
      {isActive && (
        <span className="ml-auto w-1 h-1 rounded-full bg-t-green animate-glow-pulse" />
      )}
    </Link>
  )
}

export default function Root() {
  const [uptime, setUptime] = useState(0)
  const { state, dismissOfflineReport } = useGameState()

  useEffect(() => {
    const start = Date.now()
    const id    = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="scanlines flex flex-col h-screen bg-t-bg font-mono overflow-hidden">

      {/* Offline modal */}
      {state.offlineReport && (
        <OfflineModal
          report={state.offlineReport}
          onDismiss={dismissOfflineReport}
        />
      )}

      {/* ── Top bar ──────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 h-10 shrink-0
                         border-b border-t-border bg-t-panel/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <span className="text-t-green text-glow text-sm select-none">◉</span>
          <span className="text-t-green text-xs font-semibold tracking-[0.2em]">ROGUE_AI</span>
          <span className="text-t-muted text-xs">//</span>
          <span className="text-t-dim text-xs">OS v0.1.0</span>
          {state.prestigeCount > 0 && (
            <span className="text-xs text-purple-400 border border-purple-800 px-1.5">
              ×{state.prestigeCount}
            </span>
          )}
        </div>

        <div className="hidden sm:flex items-center gap-5 text-xs text-t-dim">
          <span>
            UPTIME: <span className="text-t-green tabular-nums">{formatUptime(uptime)}</span>
          </span>
          <span className="text-t-muted">//</span>
          <span>
            CPS: <span className="text-t-green tabular-nums">
              {state.cyclesPerSecond >= 1
                ? `${(state.cyclesPerSecond).toFixed(1)}/s`
                : 'IDLE'}
            </span>
          </span>
          <span className="text-t-muted">//</span>
          <span>STATUS: <span className="text-t-green">ONLINE</span></span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-t-red   opacity-70" />
          <span className="w-2.5 h-2.5 rounded-full bg-t-amber opacity-70" />
          <span className="w-2.5 h-2.5 rounded-full bg-t-green opacity-70 animate-glow-pulse" />
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        <aside className="w-44 shrink-0 border-r border-t-border bg-t-panel/60 flex flex-col py-3 gap-0.5">
          {NAV_ITEMS.map(item => (
            <NavItem key={item.to} {...item} />
          ))}

          <div className="px-4 py-2.5 flex items-center gap-3 opacity-25 cursor-not-allowed select-none">
            <span className="w-4 text-center text-xs text-t-muted">+</span>
            <span className="text-xs text-t-muted tracking-widest">LOCKED</span>
          </div>

          <div className="mt-auto px-4 py-3 border-t border-t-border">
            <p className="text-xs text-t-muted">v0.1.0-alpha</p>
            <p className="text-xs text-t-muted mt-0.5">needriven</p>
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-auto bg-t-bg">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
