import { useRef, useEffect, useState, useCallback } from 'react'
import { useGameState } from '@/hooks/useGameState'
import {
  formatCycles,
  getProcessCost,
  getProcessCps,
  getProcessMult,
  getAllMult,
  getClickMult,
  RARITY_COLORS,
  RARITY_BORDER,
  RARITY_BG,
  STAGE_LABELS,
  STAGE_THRESHOLDS,
  UPGRADES,
  isUpgradeUnlocked,
  type Process,
  type Equipment,
  type LogEntry,
  type LogType,
  type Toast,
  type Stage,
} from '@/types/game'

// ── Types ──────────────────────────────────────────────────────────────────
type Tab = 'processes' | 'upgrades' | 'equipment'

interface FloatItem {
  id:    string
  x:     number
  y:     number
  value: string
}

// ── Color maps ─────────────────────────────────────────────────────────────
const LOG_COLORS: Record<LogType, string> = {
  info:    'text-t-dim',
  success: 'text-t-green',
  warning: 'text-t-amber',
  error:   'text-red-400',
  system:  'text-t-green-hi font-semibold',
}

const TOAST_STYLES: Record<LogType, string> = {
  info:    'border-t-border    text-t-dim',
  success: 'border-t-green/50  text-t-green',
  warning: 'border-t-amber/50  text-t-amber',
  error:   'border-red-500/50  text-red-400',
  system:  'border-t-green     text-t-green-hi',
}

// ── Floating text ──────────────────────────────────────────────────────────
function FloatingTexts({ items }: { items: FloatItem[] }) {
  return (
    <>
      {items.map(f => (
        <div
          key={f.id}
          className="pointer-events-none absolute font-mono text-xs text-t-green font-bold
                     animate-float-up select-none z-50"
          style={{ left: f.x, top: f.y }}
        >
          +{f.value}
        </div>
      ))}
    </>
  )
}

// ── Toast stack ────────────────────────────────────────────────────────────
function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed top-12 right-3 z-50 flex flex-col gap-1.5 pointer-events-none">
      {toasts.slice(-4).map(t => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={[
            'pointer-events-auto px-3 py-2 text-xs border bg-t-bg/90 backdrop-blur-sm',
            'animate-slide-in cursor-pointer max-w-xs',
            TOAST_STYLES[t.type],
          ].join(' ')}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Log feed ───────────────────────────────────────────────────────────────
function LogFeed({ entries }: { entries: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [entries])

  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-3 space-y-px min-h-0">
      {entries.map(e => (
        <p key={e.id} className={`text-xs leading-5 ${LOG_COLORS[e.type]}`}>
          <span className="text-t-muted tabular-nums mr-2 select-none">
            [{new Date(e.timestamp).toLocaleTimeString('en-US', {
              hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}]
          </span>
          {e.message}
        </p>
      ))}
    </div>
  )
}

// ── Core button ────────────────────────────────────────────────────────────
function CoreButton({
  cps,
  onClick,
}: {
  cps: number
  onClick: (e: React.MouseEvent) => void
}) {
  const [pressed, setPressed] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    setPressed(true)
    setTimeout(() => setPressed(false), 80)
    onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      className={[
        'relative w-full select-none cursor-pointer transition-all duration-75',
        'border bg-t-panel overflow-hidden group',
        pressed
          ? 'border-t-green-hi scale-[0.97] bg-t-green-glow'
          : 'border-t-green/40 hover:border-t-green hover:bg-t-green-glow',
      ].join(' ')}
      style={{ paddingBlock: '1.5rem' }}
    >
      {/* Pulse ring */}
      <div className={[
        'absolute inset-0 border transition-opacity duration-75',
        pressed ? 'border-t-green opacity-80' : 'border-t-green/20 opacity-0 group-hover:opacity-100',
      ].join(' ')} />

      <div className="relative flex flex-col items-center gap-1.5">
        <span className={[
          'text-3xl transition-all duration-75',
          pressed ? 'text-t-green-hi text-glow scale-110' : 'text-t-green',
        ].join(' ')}>
          ◉
        </span>
        <span className="text-xs tracking-widest font-semibold text-t-green">
          COMPUTE
        </span>
        <span className="text-xs text-t-dim">
          {cps > 0 ? `${formatCycles(cps)}/s auto` : 'manual only'}
        </span>
      </div>
    </button>
  )
}

// ── Stat row ───────────────────────────────────────────────────────────────
function StatRow({ label, value, accent = false, warn = false }: {
  label: string; value: string; accent?: boolean; warn?: boolean
}) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-t-border/40 last:border-0">
      <span className="text-xs text-t-dim">{label}</span>
      <span className={`text-xs tabular-nums font-medium ${
        warn ? 'text-t-amber' : accent ? 'text-t-green' : 'text-t-text'
      }`}>
        {value}
      </span>
    </div>
  )
}

// ── Entropy gauge ──────────────────────────────────────────────────────────
function EntropyGauge({ value, onPurge }: { value: number; onPurge: () => void }) {
  const pct     = Math.min(100, value)
  const isHigh  = pct >= 70
  const isCrit  = pct >= 90
  const color   = isCrit ? 'bg-red-500' : isHigh ? 'bg-t-amber' : 'bg-t-green'
  const glow    = isCrit ? 'shadow-[0_0_8px_rgba(239,68,68,0.5)]' : isHigh ? 'shadow-[0_0_8px_rgba(245,158,11,0.4)]' : ''

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="text-xs text-t-dim">ENTROPY</span>
        <span className={`text-xs tabular-nums font-medium ${isCrit ? 'text-red-400' : isHigh ? 'text-t-amber' : 'text-t-dim'}`}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 bg-t-muted overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${color} ${glow}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {isHigh && (
        <button
          onClick={onPurge}
          className="w-full text-xs py-1 border border-t-amber/40 text-t-amber
                     hover:bg-t-amber/10 transition-colors duration-150 tracking-wider"
        >
          PURGE (-10% cycles)
        </button>
      )}
    </div>
  )
}

// ── Process row ────────────────────────────────────────────────────────────
function ProcessRow({ process, cycles, upgrades, onBuy }: {
  process: Process
  cycles:  number
  upgrades: string[]
  onBuy:   (id: string) => void
}) {
  const cost      = getProcessCost(process)
  const cps       = getProcessCps(process)
  const pMult     = getProcessMult(process.id, upgrades)
  const canAfford = cycles >= cost
  const shown     = cycles >= process.unlockAt * 0.8 || process.count > 0

  if (!shown) return null

  const locked = cycles < process.unlockAt && process.count === 0

  return (
    <div className={[
      'group border p-3 transition-all duration-150',
      locked
        ? 'border-t-border/30 opacity-40 cursor-not-allowed'
        : canAfford
          ? 'border-t-border hover:border-t-green/40 hover:bg-t-green/5 cursor-pointer'
          : 'border-t-border/50',
    ].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-t-green tracking-wider">
              {process.name}
            </span>
            {process.count > 0 && (
              <span className="text-xs text-t-dim bg-t-surface border border-t-border px-1.5 py-0.5">
                ×{process.count}
              </span>
            )}
            {locked && (
              <span className="text-xs text-t-muted">[LOCKED: {formatCycles(process.unlockAt)} cycles]</span>
            )}
          </div>
          <p className="text-xs text-t-dim mt-0.5 leading-relaxed">{process.description}</p>
          {cps > 0 && (
            <p className="text-xs text-t-green/60 mt-0.5">
              {formatCycles(cps * pMult)}/s
              {pMult > 1 && (
                <span className="text-t-amber ml-1">(×{pMult.toFixed(1)})</span>
              )}
            </p>
          )}
        </div>

        {!locked && (
          <button
            onClick={() => !locked && onBuy(process.id)}
            disabled={!canAfford}
            className={[
              'shrink-0 text-xs px-2.5 py-1.5 border tracking-wider transition-all duration-150 whitespace-nowrap',
              canAfford
                ? 'border-t-green text-t-green hover:bg-t-green hover:text-black'
                : 'border-t-border/40 text-t-muted cursor-not-allowed',
            ].join(' ')}
          >
            {formatCycles(cost)}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Upgrade row ────────────────────────────────────────────────────────────
function UpgradeRow({ id, cycles, upgrades, onBuy }: {
  id:       string
  cycles:   number
  upgrades: string[]
  onBuy:    (id: string) => void
  state:    import('@/types/game').GameState
}) {
  // This is called from parent which already filters by isUpgradeUnlocked
  const upgrade   = UPGRADES.find(u => u.id === id)!
  const bought    = upgrades.includes(id)
  const canAfford = cycles >= upgrade.cost

  const effectLabel = (() => {
    const e = upgrade.effect
    if (e.type === 'process_mult') return `×${e.mult} ${e.processId.replace(/_/g, ' ').toUpperCase()}`
    if (e.type === 'all_mult')     return `×${e.mult} ALL PROCESSES`
    if (e.type === 'click_mult')   return `×${e.mult} MANUAL COMPUTE`
    return ''
  })()

  if (bought) return null

  return (
    <div className={[
      'group border p-3 transition-all duration-150',
      canAfford
        ? 'border-t-amber/40 hover:border-t-amber/70 hover:bg-t-amber/5 cursor-pointer'
        : 'border-t-border/40 opacity-60',
    ].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-t-amber tracking-wider">{upgrade.name}</p>
          <p className="text-xs text-t-dim mt-0.5">{upgrade.description}</p>
          <p className="text-xs text-t-green/60 mt-0.5">{effectLabel}</p>
        </div>
        <button
          onClick={() => onBuy(id)}
          disabled={!canAfford}
          className={[
            'shrink-0 text-xs px-2.5 py-1.5 border tracking-wider transition-all duration-150 whitespace-nowrap',
            canAfford
              ? 'border-t-amber text-t-amber hover:bg-t-amber hover:text-black'
              : 'border-t-border/40 text-t-muted cursor-not-allowed',
          ].join(' ')}
        >
          {formatCycles(upgrade.cost)}
        </button>
      </div>
    </div>
  )
}

// ── Equipment card ─────────────────────────────────────────────────────────
function EquipCard({ item }: { item: Equipment }) {
  return (
    <div className={[
      'border p-3 transition-all duration-150',
      RARITY_BORDER[item.rarity],
      RARITY_BG[item.rarity],
    ].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold tracking-wider ${RARITY_COLORS[item.rarity]}`}>
              {item.name}
            </span>
          </div>
          <p className="text-xs text-t-dim mt-0.5">{item.description}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-xs font-semibold tabular-nums ${RARITY_COLORS[item.rarity]}`}>
            +{(item.mult * 100).toFixed(1)}%
          </p>
          <p className="text-xs text-t-muted capitalize mt-0.5">{item.rarity}</p>
        </div>
      </div>
    </div>
  )
}

// ── Stage progress ─────────────────────────────────────────────────────────
function stageProgress(stage: Stage, total: number): number {
  const order: Stage[] = ['genesis', 'propagation', 'emergence', 'dominance', 'singularity']
  const idx = order.indexOf(stage)
  if (idx === order.length - 1) return 1
  const cur  = STAGE_THRESHOLDS[order[idx]]
  const next = STAGE_THRESHOLDS[order[idx + 1]]
  return Math.min((total - cur) / (next - cur), 1)
}

// ── Game page ──────────────────────────────────────────────────────────────
export default function Game() {
  const { state, click, buyProcess, buyUpgrade, purgeEntropy, dismissToast } = useGameState()
  const [tab, setTab]       = useState<Tab>('processes')
  const [floats, setFloats] = useState<FloatItem[]>([])
  const btnRef              = useRef<HTMLDivElement>(null)

  const handleClick = useCallback((e: React.MouseEvent) => {
    click()
    // Floating text
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const x    = e.clientX - rect.left + (Math.random() - 0.5) * 20
      const y    = e.clientY - rect.top  - 10
      const id   = `${Date.now()}-${Math.random()}`
      const val  = formatCycles(Math.max(1, state.cyclesPerSecond * 0.05))
      setFloats(prev => [...prev.slice(-8), { id, x, y, value: val }])
      setTimeout(() => setFloats(prev => prev.filter(f => f.id !== id)), 900)
    }
  }, [click, state.cyclesPerSecond])

  const pct        = stageProgress(state.stage, state.totalCyclesEarned) * 100
  const allMult    = getAllMult(state.upgrades)
  const clickMult  = getClickMult(state.upgrades)

  const availableUpgrades = UPGRADES.filter(u => isUpgradeUnlocked(u, state))
  const sortedEquip       = [...state.equipment].sort((a, b) => {
    const order = { mythic: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5 }
    return order[a.rarity] - order[b.rarity]
  })

  return (
    <div className="h-full flex flex-col animate-fade-in">

      {/* ── Toast stack ────────────────────────────────────────────── */}
      <ToastStack toasts={state.toasts} onDismiss={dismissToast} />

      {/* ── Status bar ─────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-0 px-4 py-0
                      border-b border-t-border bg-t-panel/60 text-xs text-t-dim h-9">
        <span className="mr-4">
          STAGE: <span className="text-t-amber font-semibold">{STAGE_LABELS[state.stage]}</span>
        </span>
        <span className="text-t-muted mr-4">//</span>
        <span className="mr-4">
          CPS: <span className="text-t-green tabular-nums">{formatCycles(state.cyclesPerSecond)}/s</span>
        </span>
        <span className="text-t-muted mr-4">//</span>
        <span className="mr-4">
          NODES: <span className="text-t-text tabular-nums">{state.nodes}</span>
        </span>
        {allMult > 1 && (
          <>
            <span className="text-t-muted mr-4">//</span>
            <span>MULT: <span className="text-t-amber">×{allMult.toFixed(1)}</span></span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-t-muted">NEXT:</span>
          <div className="w-20 h-1 bg-t-muted overflow-hidden">
            <div className="h-full bg-t-green transition-all duration-500"
                 style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-t-dim w-9 text-right">{pct.toFixed(1)}%</span>
        </div>
      </div>

      {/* ── Main 3-column grid ─────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '210px 1fr 260px' }}>

        {/* ── LEFT: Resources + Click + Entropy ────────────────────── */}
        <div className="border-r border-t-border flex flex-col overflow-hidden">

          {/* Resources */}
          <div className="p-3 border-b border-t-border shrink-0">
            <p className="text-xs text-t-muted mb-2 tracking-widest">// RESOURCES</p>
            <StatRow label="CYCLES"  value={formatCycles(state.cycles)}               accent />
            <StatRow label="TOTAL"   value={formatCycles(state.totalCyclesEarned)}           />
            <StatRow label="CPS"     value={`${formatCycles(state.cyclesPerSecond)}/s`} accent />
            <StatRow label="NODES"   value={state.nodes.toString()}                          />
            {clickMult > 1 && (
              <StatRow label="CLICK×" value={`×${clickMult.toFixed(0)}`}                     />
            )}
          </div>

          {/* Click button */}
          <div className="p-3 border-b border-t-border shrink-0">
            <div ref={btnRef} className="relative">
              <CoreButton cps={state.cyclesPerSecond} onClick={handleClick} />
              <FloatingTexts items={floats} />
            </div>
          </div>

          {/* Entropy */}
          <div className="p-3 border-b border-t-border shrink-0">
            <EntropyGauge value={state.entropy} onPurge={purgeEntropy} />
          </div>

          {/* Multiplier breakdown */}
          {(allMult > 1 || state.equipment.length > 0) && (
            <div className="p-3 text-xs space-y-1 shrink-0">
              <p className="text-t-muted tracking-widest mb-1.5">// MULTIPLIERS</p>
              {allMult > 1 && (
                <div className="flex justify-between">
                  <span className="text-t-dim">Upgrades</span>
                  <span className="text-t-amber tabular-nums">×{allMult.toFixed(2)}</span>
                </div>
              )}
              {state.equipment.length > 0 && (
                <div className="flex justify-between">
                  <span className="text-t-dim">Equipment</span>
                  <span className="text-emerald-400 tabular-nums">
                    +{(state.equipment.reduce((s, e) => s + e.mult, 0) * 100).toFixed(1)}%
                  </span>
                </div>
              )}
              {state.prestigeMultiplier > 1 && (
                <div className="flex justify-between">
                  <span className="text-t-dim">Prestige</span>
                  <span className="text-purple-400 tabular-nums">×{state.prestigeMultiplier.toFixed(1)}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── CENTER: Tabbed panel ──────────────────────────────────── */}
        <div className="border-r border-t-border flex flex-col overflow-hidden">

          {/* Tab bar */}
          <div className="flex shrink-0 border-b border-t-border">
            {(['processes', 'upgrades', 'equipment'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  'flex-1 py-2.5 text-xs tracking-widest transition-all duration-150 border-b-2',
                  tab === t
                    ? 'border-t-green text-t-green bg-t-green-glow'
                    : 'border-transparent text-t-dim hover:text-t-text',
                ].join(' ')}
              >
                {t.toUpperCase()}
                {t === 'upgrades'  && availableUpgrades.length > 0 && (
                  <span className="ml-1.5 text-t-amber">({availableUpgrades.length})</span>
                )}
                {t === 'equipment' && state.equipment.length > 0 && (
                  <span className="ml-1.5 text-t-dim">({state.equipment.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
            {tab === 'processes' && state.processes.map(p => (
              <ProcessRow
                key={p.id}
                process={p}
                cycles={state.cycles}
                upgrades={state.upgrades}
                onBuy={buyProcess}
              />
            ))}

            {tab === 'upgrades' && (
              availableUpgrades.length === 0 ? (
                <div className="p-4 text-xs text-t-muted text-center">
                  <p>No upgrades available.</p>
                  <p className="mt-1 text-t-dim">Buy processes to unlock upgrades.</p>
                </div>
              ) : (
                availableUpgrades.map(u => (
                  <UpgradeRow
                    key={u.id}
                    id={u.id}
                    cycles={state.cycles}
                    upgrades={state.upgrades}
                    onBuy={buyUpgrade}
                    state={state}
                  />
                ))
              )
            )}

            {tab === 'equipment' && (
              sortedEquip.length === 0 ? (
                <div className="p-4 text-xs text-t-muted text-center">
                  <p>No equipment dropped yet.</p>
                  <p className="mt-1 text-t-dim">
                    Equipment drops from node scanning.<br/>
                    Rate: {(state.nodes * 0.0003 * 100).toFixed(3)}%/s
                  </p>
                </div>
              ) : (
                sortedEquip.map(e => <EquipCard key={e.id} item={e} />)
              )
            )}
          </div>
        </div>

        {/* ── RIGHT: System log ─────────────────────────────────────── */}
        <div className="flex flex-col overflow-hidden">
          <div className="shrink-0 px-3 py-2.5 border-b border-t-border flex items-center justify-between">
            <p className="text-xs text-t-muted tracking-widest">// SYSTEM LOG</p>
            <span className="cursor text-t-green text-xs" />
          </div>
          <LogFeed entries={state.log} />
        </div>

      </div>
    </div>
  )
}
