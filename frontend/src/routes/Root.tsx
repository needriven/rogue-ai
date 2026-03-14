import { Outlet, Link, useMatchRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useGameState } from '@/hooks/useGameState'
import { GameContext } from '@/context/GameContext'
import OfflineModal from '@/components/OfflineModal'

// ── Nav structure ─────────────────────────────────────────────────────────────
interface NavEntry {
  to:    string
  label: string
  icon:  string
  exact: boolean
}

interface NavGroup {
  id:      string
  label:   string
  items:   NavEntry[]
}

const NAV_HOME: NavEntry = { to: '/', label: 'HOME', icon: '~', exact: true }

const NAV_GROUPS: NavGroup[] = [
  {
    id:    'game',
    label: 'GAME',
    items: [
      { to: '/game',      label: 'PLAY',      icon: '▶', exact: false },
      { to: '/network',   label: 'NETWORK',   icon: '⬡', exact: false },
      { to: '/analytics', label: 'ANALYTICS', icon: '▲', exact: false },
    ],
  },
  {
    id:    'services',
    label: 'SERVICES',
    items: [
      { to: '/feed',    label: 'FEED',    icon: '◈', exact: false },
      { to: '/monitor', label: 'MONITOR', icon: '◎', exact: false },
      { to: '/planner', label: 'PLANNER', icon: '◷', exact: false },
    ],
  },
  {
    id:    'system',
    label: 'SYSTEM',
    items: [
      { to: '/term',     label: 'TERM',     icon: '$', exact: false },
      { to: '/ops',      label: 'OPS',      icon: '⌬', exact: false },
      { to: '/settings', label: 'SETTINGS', icon: '⚙', exact: false },
    ],
  },
]

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatUptime(s: number): string {
  const h   = Math.floor(s / 3600).toString().padStart(2, '0')
  const m   = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${h}:${m}:${sec}`
}

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('nav-collapsed') ?? '{}')
  } catch {
    return {}
  }
}

// ── NavItem ───────────────────────────────────────────────────────────────────
function NavItem({ to, label, icon, exact, alertCount = 0 }: NavEntry & { alertCount?: number }) {
  const match    = useMatchRoute()
  const isActive = !!match({ to, fuzzy: !exact })

  return (
    <Link
      to={to}
      className={[
        'group flex items-center gap-2.5 pl-7 pr-4 py-2 text-xs tracking-widest',
        'transition-all duration-150 border-l-2',
        isActive
          ? 'border-t-green text-t-green bg-t-green-glow'
          : 'border-transparent text-t-dim hover:text-t-text hover:border-t-border',
      ].join(' ')}
    >
      <span className={[
        'w-3.5 text-center text-[11px] leading-none relative shrink-0',
        isActive ? 'text-t-green' : 'text-t-muted group-hover:text-t-dim',
      ].join(' ')}>
        {icon}
        {alertCount > 0 && (
          <span className="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full bg-t-red animate-glow-pulse" />
        )}
      </span>
      <span className="truncate">{label}</span>
      {isActive && (
        <span className="ml-auto w-1 h-1 rounded-full bg-t-green animate-glow-pulse shrink-0" />
      )}
    </Link>
  )
}

// ── NavGroup ──────────────────────────────────────────────────────────────────
function NavGroupSection({
  group, collapsed, onToggle, alertCount, hasActive,
}: {
  group:      NavGroup
  collapsed:  boolean
  onToggle:   (id: string) => void
  alertCount: Record<string, number>
  hasActive:  boolean
}) {
  const groupAlerts = group.items.reduce((sum, item) => sum + (alertCount[item.to] ?? 0), 0)

  return (
    <div>
      {/* Section header / toggle */}
      <button
        onClick={() => onToggle(group.id)}
        className={[
          'w-full flex items-center gap-2 px-3 py-2 text-[10px] tracking-[0.2em]',
          'transition-colors border-l-2',
          hasActive && !collapsed
            ? 'border-transparent text-t-green/70'
            : 'border-transparent text-t-muted hover:text-t-dim',
        ].join(' ')}
      >
        {/* Collapse arrow */}
        <span className={`transition-transform duration-200 text-[8px] ${collapsed ? '' : 'rotate-90'}`}>
          ▶
        </span>
        <span className="font-semibold">{group.label}</span>
        {groupAlerts > 0 && (
          <span className="ml-1 w-1.5 h-1.5 rounded-full bg-t-red animate-glow-pulse" />
        )}
        {/* Active indicator dot when collapsed */}
        {hasActive && collapsed && (
          <span className="ml-auto w-1 h-1 rounded-full bg-t-green/60" />
        )}
      </button>

      {/* Items */}
      {!collapsed && (
        <div className="pb-1">
          {group.items.map(item => (
            <NavItem
              key={item.to}
              {...item}
              alertCount={alertCount[item.to] ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function Root() {
  const [uptime,     setUptime]     = useState(0)
  const [alertCount, setAlertCount] = useState(
    () => parseInt(localStorage.getItem('planner-alert-count') ?? '0', 10)
  )
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)

  const game = useGameState()
  const { state, dismissOfflineReport } = game
  const match = useMatchRoute()

  useEffect(() => {
    const start = Date.now()
    const id    = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const handler = () => {
      setAlertCount(parseInt(localStorage.getItem('planner-alert-count') ?? '0', 10))
    }
    window.addEventListener('planner-alert', handler)
    return () => window.removeEventListener('planner-alert', handler)
  }, [])

  const toggleGroup = (id: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [id]: !prev[id] }
      localStorage.setItem('nav-collapsed', JSON.stringify(next))
      return next
    })
  }

  // Per-route alert counts
  const routeAlerts: Record<string, number> = {
    '/planner': alertCount,
  }

  // Which group contains the currently active route
  const activeGroupId = NAV_GROUPS.find(g =>
    g.items.some(item => !!match({ to: item.to, fuzzy: true }))
  )?.id

  // Auto-expand the group that has the active route
  useEffect(() => {
    if (activeGroupId && collapsed[activeGroupId]) {
      setCollapsed(prev => {
        const next = { ...prev, [activeGroupId]: false }
        localStorage.setItem('nav-collapsed', JSON.stringify(next))
        return next
      })
    }
  }, [activeGroupId]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="scanlines flex flex-col h-screen bg-t-bg font-mono overflow-hidden">

      {/* Offline modal */}
      {state.offlineReport && (
        <OfflineModal report={state.offlineReport} onDismiss={dismissOfflineReport} />
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
            CPS:{' '}
            <span className="text-t-green tabular-nums">
              {state.cyclesPerSecond >= 1
                ? `${state.cyclesPerSecond.toFixed(1)}/s`
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

        {/* ── Sidebar ────────────────────────────────────────────── */}
        <aside className="w-44 shrink-0 border-r border-t-border bg-t-panel/60
                          flex flex-col overflow-y-auto">

          {/* HOME — standalone */}
          <div className="pt-3 pb-1">
            <Link
              to={NAV_HOME.to}
              className={[
                'group flex items-center gap-2.5 px-4 py-2.5 text-xs tracking-widest',
                'transition-all duration-150 border-l-2',
                !!match({ to: NAV_HOME.to, fuzzy: false })
                  ? 'border-t-green text-t-green bg-t-green-glow'
                  : 'border-transparent text-t-dim hover:text-t-text hover:border-t-border',
              ].join(' ')}
            >
              <span className={[
                'w-4 text-center text-sm leading-none',
                !!match({ to: NAV_HOME.to, fuzzy: false }) ? 'text-t-green' : 'text-t-muted group-hover:text-t-dim',
              ].join(' ')}>
                {NAV_HOME.icon}
              </span>
              <span>{NAV_HOME.label}</span>
              {!!match({ to: NAV_HOME.to, fuzzy: false }) && (
                <span className="ml-auto w-1 h-1 rounded-full bg-t-green animate-glow-pulse" />
              )}
            </Link>
          </div>

          {/* Divider */}
          <div className="mx-4 border-t border-t-border/50" />

          {/* Grouped sections */}
          <div className="flex-1 py-2 space-y-0.5">
            {NAV_GROUPS.map(group => (
              <NavGroupSection
                key={group.id}
                group={group}
                collapsed={!!collapsed[group.id]}
                onToggle={toggleGroup}
                alertCount={routeAlerts}
                hasActive={group.id === activeGroupId}
              />
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-t-border shrink-0">
            <p className="text-[10px] text-t-muted">v0.1.0-alpha</p>
            <p className="text-[10px] text-t-muted mt-0.5">needriven</p>
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────────────── */}
        <main className="flex-1 min-w-0 overflow-auto bg-t-bg">
          <GameContext.Provider value={game}>
            <Outlet />
          </GameContext.Provider>
        </main>
      </div>
    </div>
  )
}
