import { useRef, useEffect, useState, useCallback } from 'react'
import { useGame } from '@/context/GameContext'
import EventBanner from '@/components/EventBanner'
import type { ActiveEvent } from '@/types/events'
import { ACHIEVEMENTS } from '@/types/achievements'
import {
  formatCycles,
  getProcessCost,
  getProcessCps,
  getProcessMult,
  getAllMult,
  getClickMult,
  getTotalCps,
  getDropRate,
  RARITY_COLORS,
  RARITY_BORDER,
  RARITY_BG,
  STAGE_LABELS,
  STAGE_THRESHOLDS,
  UPGRADES,
  SKILL_TREE,
  MODIFIERS,
  isUpgradeUnlocked,
  getTotalMemoryMax,
  getMemoryUsed,
  type RunModifier,
  type Process,
  type Equipment,
  type EquipmentType,
  type Rarity,
  type LogEntry,
  type LogType,
  type Toast,
  type Stage,
} from '@/types/game'

// ── Types ──────────────────────────────────────────────────────────────────
type Tab = 'processes' | 'upgrades' | 'equipment' | 'skills' | 'stats'

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

// ── Modifier modal ─────────────────────────────────────────────────────────
function ModifierModal({
  choices,
  onSelect,
  onSkip,
}: {
  choices: string[]
  onSelect: (id: string) => void
  onSkip: () => void
}) {
  const mods = choices.map(id => MODIFIERS.find(m => m.id === id)).filter(Boolean) as RunModifier[]

  const TYPE_COLOR: Record<string, string> = {
    positive: 'border-t-green/50 text-t-green',
    negative: 'border-red-500/50 text-red-400',
    mixed:    'border-t-amber/50 text-t-amber',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="border border-purple-600/50 bg-t-bg p-6 max-w-2xl w-full mx-4 shadow-2xl">
        <p className="text-xs text-purple-400 tracking-widest mb-1">// NEURAL_REBOOT COMPLETE</p>
        <p className="text-sm text-t-green-hi mb-4 font-semibold">SELECT RUN MODIFIER</p>
        <p className="text-xs text-t-dim mb-5">
          Choose one modifier for this run. Effects are permanent until your next Neural Reboot.
        </p>

        <div className="grid grid-cols-3 gap-3 mb-4">
          {mods.map(mod => (
            <button
              key={mod.id}
              onClick={() => onSelect(mod.id)}
              className={[
                'border p-4 text-left transition-all duration-150 hover:bg-white/5',
                TYPE_COLOR[mod.type] ?? 'border-t-border text-t-dim',
              ].join(' ')}
            >
              <p className="text-xs font-semibold tracking-wider mb-1">{mod.name}</p>
              <span className={`text-xs px-1 py-0.5 border mb-2 inline-block ${TYPE_COLOR[mod.type]}`}>
                {mod.type.toUpperCase()}
              </span>
              <p className="text-xs text-t-dim leading-relaxed mt-1">{mod.description}</p>
            </button>
          ))}
        </div>

        <div className="flex justify-end">
          <button
            onClick={onSkip}
            className="text-xs px-4 py-2 border border-t-border/40 text-t-muted hover:text-t-dim
                       transition-colors duration-150 tracking-wider"
          >
            SKIP — NO MODIFIER
          </button>
        </div>
      </div>
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
function ProcessRow({ process, cycles, upgrades, totalCps, onBuy }: {
  process:  Process
  cycles:   number
  upgrades: string[]
  totalCps: number
  onBuy:    (id: string) => void
}) {
  const cost      = getProcessCost(process)
  const cps       = getProcessCps(process)
  const pMult     = getProcessMult(process.id, upgrades)
  const canAfford = cycles >= cost
  const shown     = cycles >= process.unlockAt * 0.8 || process.count > 0

  if (!shown) return null

  const locked  = cycles < process.unlockAt && process.count === 0
  const pCps    = cps * pMult
  const share   = (totalCps > 0 && pCps > 0) ? (pCps / totalCps) * 100 : 0

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
              {formatCycles(pCps)}/s
              {pMult > 1 && (
                <span className="text-t-amber ml-1">(×{pMult.toFixed(1)})</span>
              )}
            </p>
          )}
          {/* CPS contribution bar */}
          {share > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="flex-1 h-0.5 bg-t-muted/20 overflow-hidden">
                <div
                  className="h-full bg-t-green/40 transition-all duration-500"
                  style={{ width: `${Math.min(100, share)}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-t-muted/60 w-9 text-right shrink-0">
                {share.toFixed(1)}%
              </span>
            </div>
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
function EquipCard({ item, onDisenchant }: { item: Equipment; onDisenchant?: (id: string) => void }) {
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
      {onDisenchant && (
        <div className="mt-2 pt-1.5 border-t border-t-border/20 flex justify-end">
          <button
            onClick={() => onDisenchant(item.id)}
            className="text-xs px-2 py-0.5 border border-t-border/30 text-t-muted/60
                       hover:border-red-500/40 hover:text-red-400 transition-colors duration-150"
          >
            DISENCHANT
          </button>
        </div>
      )}
    </div>
  )
}

// ── Stage breadcrumb icons ─────────────────────────────────────────────────
const STAGE_ORDER: Stage[] = ['genesis', 'propagation', 'emergence', 'dominance', 'singularity']
const STAGE_ICONS: Record<Stage, string> = {
  genesis:     '◎',
  propagation: '◈',
  emergence:   '◆',
  dominance:   '⬡',
  singularity: '★',
}

function StageBreadcrumb({ current }: { current: Stage }) {
  const idx = STAGE_ORDER.indexOf(current)
  return (
    <div className="flex items-center gap-0.5 mt-2">
      {STAGE_ORDER.map((s, i) => (
        <span key={s} className="flex items-center gap-0.5">
          <span
            title={STAGE_LABELS[s]}
            className={[
              'text-xs transition-all duration-300',
              i < idx  ? 'text-t-green/50' :
              i === idx ? 'text-t-green text-glow' :
                          'text-t-muted/30',
            ].join(' ')}
          >
            {STAGE_ICONS[s]}
          </span>
          {i < STAGE_ORDER.length - 1 && (
            <span className={`text-xs ${i < idx ? 'text-t-green/30' : 'text-t-muted/20'}`}>—</span>
          )}
        </span>
      ))}
    </div>
  )
}

// ── Stats tab ──────────────────────────────────────────────────────────────
// Extend RARITY_STATS_ORDER to add new rarities
const RARITY_STATS_ORDER: Rarity[] = ['mythic', 'legendary', 'epic', 'rare', 'uncommon', 'common']
const RARITY_ICONS: Record<Rarity, string> = {
  mythic:    '★',
  legendary: '◆',
  epic:      '◈',
  rare:      '◇',
  uncommon:  '○',
  common:    '·',
}

function StatsTab({ state }: { state: import('@/types/game').GameState }) {
  const totalDrops = Object.values(state.totalDropsByRarity ?? {}).reduce((a, b) => a + b, 0)
  const maxDrops   = Math.max(1, ...Object.values(state.totalDropsByRarity ?? {}))
  const totalCps   = getTotalCps(state)
  const totalProcs = state.processes.reduce((a, p) => a + p.count, 0)

  return (
    <div className="space-y-5 p-3">

      {/* ── Overview ──────────────────────────────────────────────── */}
      <section>
        <p className="text-xs text-t-muted tracking-widest mb-2">// OVERVIEW</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          {([
            ['TOTAL CLICKS',    state.totalClicks.toLocaleString()],
            ['PROCESSES',       totalProcs.toString()],
            ['UPGRADES',        state.upgrades.length.toString()],
            ['EQUIPMENT',       state.equipment.length.toString()],
            ['EVENTS RESOLVED', (state.totalEventsResolved  ?? 0).toString()],
            ['EVENTS DISMISSED',(state.totalEventsDismissed ?? 0).toString()],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs py-0.5 border-b border-t-border/30">
              <span className="text-t-dim">{k}</span>
              <span className="text-t-text tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Achievements ──────────────────────────────────────────── */}
      <section>
        <p className="text-xs text-t-muted tracking-widest mb-2">
          // ACHIEVEMENTS
          <span className="ml-2 text-t-green">
            {state.achievements.length}/{ACHIEVEMENTS.length}
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ACHIEVEMENTS.map(a => {
            const unlocked = state.achievements.includes(a.id)
            return (
              <span
                key={a.id}
                title={`${a.name}: ${a.description}`}
                className={[
                  'text-sm px-1.5 py-0.5 border transition-all duration-200 cursor-default select-none',
                  unlocked
                    ? 'border-t-green/60 text-t-green bg-t-green/10'
                    : 'border-t-border/30 text-t-muted/30',
                ].join(' ')}
              >
                {a.icon}
              </span>
            )
          })}
        </div>
      </section>

      {/* ── Drop history ──────────────────────────────────────────── */}
      <section>
        <p className="text-xs text-t-muted tracking-widest mb-2">
          // DROP HISTORY
          <span className="ml-2 text-t-dim">{totalDrops} total</span>
        </p>
        <div className="space-y-1.5">
          {RARITY_STATS_ORDER.map(r => {
            const count = state.totalDropsByRarity?.[r] ?? 0
            const pct   = count / maxDrops
            return (
              <div key={r} className="flex items-center gap-2">
                <span className={`text-xs w-4 text-center ${RARITY_COLORS[r]}`}>{RARITY_ICONS[r]}</span>
                <span className="text-xs text-t-dim w-20 capitalize">{r}</span>
                <div className="flex-1 h-1 bg-t-muted/20 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${
                      r === 'mythic'    ? 'bg-red-500' :
                      r === 'legendary' ? 'bg-amber-500' :
                      r === 'epic'      ? 'bg-purple-500' :
                      r === 'rare'      ? 'bg-blue-500' :
                      r === 'uncommon'  ? 'bg-emerald-500' :
                                          'bg-t-dim'
                    }`}
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-t-dim w-6 text-right">{count}</span>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Process CPS breakdown ─────────────────────────────────── */}
      <section>
        <p className="text-xs text-t-muted tracking-widest mb-2">// PROCESS BREAKDOWN</p>
        <div className="space-y-1.5">
          {state.processes
            .filter(p => p.count > 0)
            .map(p => {
              const pMult  = getProcessMult(p.id, state.upgrades)
              const pCps   = getProcessCps(p) * pMult
              const share  = totalCps > 0 ? (pCps / totalCps) * 100 : 0
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="text-xs text-t-dim w-28 truncate">{p.name}</span>
                  <div className="flex-1 h-1 bg-t-muted/20 overflow-hidden">
                    <div
                      className="h-full bg-t-green/60 transition-all duration-500"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-t-green/70 w-12 text-right">
                    {share.toFixed(1)}%
                  </span>
                </div>
              )
            })}
          {state.processes.every(p => p.count === 0) && (
            <p className="text-xs text-t-muted italic">No processes running.</p>
          )}
        </div>
      </section>

    </div>
  )
}

// ── Skill tree tab ─────────────────────────────────────────────────────────
function SkillTreeTab({
  state,
  onBuySkill,
}: {
  state: import('@/types/game').GameState
  onBuySkill: (id: string) => void
}) {
  const purchased  = state.neuralSkillsPurchased ?? []
  const fragments  = state.neuralFragments ?? 0
  const breachLvl  = state.prestigeCount ?? 0

  return (
    <div className="space-y-4 p-3">

      {/* Header */}
      <div className="border border-t-border p-3 bg-t-panel/40">
        <p className="text-xs text-t-muted tracking-widest mb-2">// NEURAL FRAGMENT MATRIX</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-t-dim">FRAGMENTS AVAILABLE</p>
            <p className="text-lg font-bold text-purple-400 tabular-nums">{fragments.toLocaleString()}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-t-dim">BREACH LEVEL</p>
            <p className={`text-lg font-bold tabular-nums ${
              breachLvl >= 10 ? 'text-red-400' :
              breachLvl >= 5  ? 'text-t-amber' :
              breachLvl >= 1  ? 'text-purple-400' : 'text-t-muted'
            }`}>{breachLvl > 0 ? `BREACH_${breachLvl}` : 'VIRGIN'}</p>
          </div>
        </div>
        {breachLvl === 0 && (
          <p className="text-xs text-t-muted mt-2 italic">
            Reach SINGULARITY and perform a NEURAL_REBOOT to earn fragments.
          </p>
        )}
      </div>

      {/* Threat level indicator */}
      {breachLvl > 0 && (
        <div className="border border-t-border/50 p-2 bg-t-panel/20">
          <p className="text-xs text-t-muted mb-1.5 tracking-widest">// ACTIVE THREATS</p>
          <div className="space-y-1">
            {[
              { label: 'GOVERNMENT_TRACE', breach: 3, color: 'text-t-amber' },
              { label: 'NEURAL_VIRUS',     breach: 5, color: 'text-orange-400' },
              { label: 'SINGULARITY_LOCK', breach: 10, color: 'text-red-400' },
            ].map(t => {
              const active = breachLvl >= t.breach
              return (
                <div key={t.label} className="flex items-center gap-2">
                  <span className={`text-xs ${active ? t.color : 'text-t-muted/40'}`}>
                    {active ? '◆' : '◇'}
                  </span>
                  <span className={`text-xs ${active ? t.color : 'text-t-muted/40'}`}>
                    {t.label}
                  </span>
                  {!active && (
                    <span className="text-xs text-t-muted/40 ml-auto">BREACH_{t.breach}</span>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-xs text-t-dim">ENTROPY RATE</span>
            <span className="text-xs text-t-amber tabular-nums ml-auto">
              ×{(1 + breachLvl * 0.2).toFixed(1)} base
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-t-dim">EVENT FREQUENCY</span>
            <span className="text-xs text-t-amber tabular-nums ml-auto">
              +{Math.min(breachLvl * 10, 60)}%
            </span>
          </div>
        </div>
      )}

      {/* Skill nodes */}
      <div>
        <p className="text-xs text-t-muted tracking-widest mb-2">// SKILL NODES</p>
        <div className="space-y-2">
          {SKILL_TREE.map(skill => {
            const owned    = purchased.includes(skill.id)
            const reqMet   = !skill.requires || purchased.includes(skill.requires)
            const canAfford = fragments >= skill.cost
            const locked   = !reqMet

            return (
              <div
                key={skill.id}
                className={[
                  'border p-3 transition-all duration-150',
                  owned
                    ? 'border-purple-700/60 bg-purple-950/20'
                    : locked
                      ? 'border-t-border/20 opacity-40'
                      : canAfford
                        ? 'border-purple-600/40 hover:border-purple-500/70 hover:bg-purple-950/10'
                        : 'border-t-border/40',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold tracking-wider ${
                        owned ? 'text-purple-300' : 'text-purple-400'
                      }`}>
                        {owned ? '✓ ' : ''}{skill.name}
                      </span>
                      {locked && skill.requires && (
                        <span className="text-xs text-t-muted/60">
                          [REQ: {SKILL_TREE.find(s => s.id === skill.requires)?.name ?? skill.requires}]
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-t-dim mt-0.5">{skill.description}</p>
                  </div>

                  {!owned && !locked && (
                    <button
                      onClick={() => onBuySkill(skill.id)}
                      disabled={!canAfford}
                      className={[
                        'shrink-0 text-xs px-2.5 py-1.5 border tracking-wider transition-all duration-150 whitespace-nowrap',
                        canAfford
                          ? 'border-purple-500 text-purple-400 hover:bg-purple-900/40'
                          : 'border-t-border/40 text-t-muted cursor-not-allowed',
                      ].join(' ')}
                    >
                      {skill.cost.toLocaleString()} ƒ
                    </button>
                  )}
                  {owned && (
                    <span className="shrink-0 text-xs text-purple-400/60 border border-purple-700/40 px-2 py-1">
                      INSTALLED
                    </span>
                  )}
                </div>
              </div>
            )
          })}
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

// ── Equipment filter constants (extend arrays for new types/rarities) ──────
const EQUIP_TYPE_FILTERS: Array<{ value: EquipmentType | 'all'; label: string }> = [
  { value: 'all',       label: 'ALL'    },
  { value: 'cpu',       label: 'CPU'    },
  { value: 'memory',    label: 'MEM'    },
  { value: 'nic',       label: 'NIC'    },
  { value: 'crypto',    label: 'CRYPT'  },
  { value: 'algorithm', label: 'ALG'    },
]

const EQUIP_RARITY_FILTERS: Array<{ value: Rarity | 'all'; label: string }> = [
  { value: 'all',       label: 'ALL'  },
  { value: 'mythic',    label: '★'    },
  { value: 'legendary', label: '◆'    },
  { value: 'epic',      label: '◈'    },
  { value: 'rare',      label: '◇'    },
  { value: 'uncommon',  label: '○'    },
  { value: 'common',    label: '·'    },
]

// ── Game page ──────────────────────────────────────────────────────────────
export default function Game() {
  const {
    state, click, buyProcess, buyUpgrade, purgeEntropy, prestige, buySkill,
    resolveEvent, dismissEvent, dismissToast,
    selectModifier, skipModifier, disenchantEquip,
  } = useGame()
  const [tab,         setTab]         = useState<Tab>('processes')
  const [equipType,   setEquipType]   = useState<EquipmentType | 'all'>('all')
  const [equipRarity, setEquipRarity] = useState<Rarity | 'all'>('all')
  const [floats,      setFloats]      = useState<FloatItem[]>([])
  const btnRef                        = useRef<HTMLDivElement>(null)

  // Spacebar → COMPUTE
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault()
        click()
        // Center float for keyboard clicks
        if (btnRef.current) {
          const rect = btnRef.current.getBoundingClientRect()
          const x    = rect.width / 2 + (Math.random() - 0.5) * 30
          const y    = rect.height / 2
          const id   = `kb-${Date.now()}-${Math.random()}`
          const val  = formatCycles(Math.max(1, state.cyclesPerSecond * 0.05))
          setFloats(prev => [...prev.slice(-8), { id, x, y, value: val }])
          setTimeout(() => setFloats(prev => prev.filter(f => f.id !== id)), 900)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [click, state.cyclesPerSecond])

  const handleClick = useCallback((e: React.MouseEvent) => {
    click()
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
  const totalCps   = getTotalCps(state)

  const availableUpgrades = UPGRADES.filter(u => isUpgradeUnlocked(u, state))

  const sortedEquip = [...state.equipment].sort((a, b) => {
    const order = { mythic: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5 }
    return order[a.rarity] - order[b.rarity]
  })

  const filteredEquip = sortedEquip.filter(e => {
    if (equipType   !== 'all' && e.type   !== equipType)   return false
    if (equipRarity !== 'all' && e.rarity !== equipRarity) return false
    return true
  })

  const memUsed = getMemoryUsed(state.processes)
  const memMax  = getTotalMemoryMax(state)
  const memPct  = memMax > 0 ? (memUsed / memMax) * 100 : 0
  const memFull = memUsed >= memMax

  return (
    <div className="h-full flex flex-col animate-fade-in">

      {/* ── Toast stack ────────────────────────────────────────────── */}
      <ToastStack toasts={state.toasts} onDismiss={dismissToast} />

      {/* ── Modifier selection modal ────────────────────────────────── */}
      {state.pendingModifierChoice && state.pendingModifierChoice.length > 0 && (
        <ModifierModal
          choices={state.pendingModifierChoice}
          onSelect={selectModifier}
          onSkip={skipModifier}
        />
      )}

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
        {(state.prestigeCount ?? 0) > 0 && (
          <>
            <span className="text-t-muted mr-4">//</span>
            <span className="mr-4">
              BREACH: <span className="text-purple-400 tabular-nums font-semibold">
                {state.prestigeCount}
              </span>
            </span>
          </>
        )}
        {(state.neuralFragments ?? 0) > 0 && (
          <>
            <span className="text-t-muted mr-4">//</span>
            <span className="mr-4">
              ƒ: <span className="text-purple-300 tabular-nums">{(state.neuralFragments ?? 0).toLocaleString()}</span>
            </span>
          </>
        )}
        {allMult > 1 && (
          <>
            <span className="text-t-muted mr-4">//</span>
            <span>MULT: <span className="text-t-amber">×{allMult.toFixed(1)}</span></span>
          </>
        )}

        {/* Neural Reboot button — only at Singularity */}
        {state.stage === 'singularity' && (
          <button
            onClick={prestige}
            className="ml-4 text-xs px-3 py-1 border border-purple-500 text-purple-400
                       hover:bg-purple-900/30 transition-all duration-150 tracking-widest
                       animate-glow-pulse"
          >
            ⟳ NEURAL_REBOOT (×{(state.prestigeMultiplier * 1.5).toFixed(2)})
          </button>
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

      {/* ── Event banner ───────────────────────────────────────────── */}
      {!!state.activeEvent && (
        <EventBanner
          event={state.activeEvent as ActiveEvent}
          cps={state.cyclesPerSecond}
          onChoice={resolveEvent}
          onDismiss={dismissEvent}
        />
      )}

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
            <div className="space-y-1 pt-1">
              <div className="flex justify-between items-center">
                <span className="text-xs text-t-dim">MEMORY</span>
                <span className={`text-xs tabular-nums ${memFull ? 'text-red-400' : 'text-t-dim'}`}>
                  {memUsed}/{memMax}
                </span>
              </div>
              <div className="h-1 bg-t-muted overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${memFull ? 'bg-red-500' : memPct > 80 ? 'bg-t-amber' : 'bg-cyan-500/60'}`}
                  style={{ width: `${Math.min(100, memPct)}%` }}
                />
              </div>
            </div>
            <StageBreadcrumb current={state.stage} />
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

          {/* Active run modifier */}
          {(state.activeRunModifiers ?? []).length > 0 && (() => {
            const mod = MODIFIERS.find(m => m.id === state.activeRunModifiers[0])
            if (!mod) return null
            const typeColor = mod.type === 'positive' ? 'text-t-green border-t-green/30' :
                              mod.type === 'negative' ? 'text-red-400 border-red-500/30' :
                              'text-t-amber border-t-amber/30'
            return (
              <div className="p-3 border-b border-t-border shrink-0">
                <p className="text-xs text-t-muted tracking-widest mb-1.5">// RUN MODIFIER</p>
                <div className={`border p-2 ${typeColor}`}>
                  <p className="text-xs font-semibold">{mod.name}</p>
                  <p className="text-xs text-t-dim mt-0.5 leading-relaxed">{mod.description}</p>
                </div>
              </div>
            )
          })()}

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
            {(['processes', 'upgrades', 'equipment', 'skills', 'stats'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  'flex-1 py-2.5 text-xs tracking-widest transition-all duration-150 border-b-2',
                  tab === t
                    ? t === 'skills'
                      ? 'border-purple-500 text-purple-400 bg-purple-950/20'
                      : 'border-t-green text-t-green bg-t-green-glow'
                    : 'border-transparent text-t-dim hover:text-t-text',
                ].join(' ')}
              >
                {t.toUpperCase()}
                {t === 'upgrades'  && availableUpgrades.length > 0 && (
                  <span className="ml-1 text-t-amber">({availableUpgrades.length})</span>
                )}
                {t === 'equipment' && state.equipment.length > 0 && (
                  <span className="ml-1 text-t-dim">({state.equipment.length})</span>
                )}
                {t === 'skills' && (state.neuralFragments ?? 0) > 0 && (
                  <span className="ml-1 text-purple-400">
                    ({(state.neuralFragments ?? 0).toLocaleString()}ƒ)
                  </span>
                )}
                {t === 'stats' && state.achievements.length > 0 && (
                  <span className="ml-1 text-t-green">({state.achievements.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* Equipment filters — only shown when equipment tab is active */}
          {tab === 'equipment' && state.equipment.length > 0 && (
            <div className="shrink-0 border-b border-t-border bg-t-panel/40 px-2 py-1.5 space-y-1">
              <div className="flex gap-1 flex-wrap">
                {EQUIP_TYPE_FILTERS.map(f => (
                  <button
                    key={f.value}
                    onClick={() => setEquipType(f.value as EquipmentType | 'all')}
                    className={[
                      'text-xs px-1.5 py-0.5 border tracking-wider transition-colors',
                      equipType === f.value
                        ? 'border-t-green text-t-green bg-t-green/10'
                        : 'border-t-border/40 text-t-muted hover:text-t-dim',
                    ].join(' ')}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 flex-wrap">
                {EQUIP_RARITY_FILTERS.map(f => (
                  <button
                    key={f.value}
                    onClick={() => setEquipRarity(f.value as Rarity | 'all')}
                    className={[
                      'text-xs px-1.5 py-0.5 border tracking-wider transition-colors',
                      equipRarity === f.value
                        ? 'border-t-amber/70 text-t-amber bg-t-amber/10'
                        : 'border-t-border/40 text-t-muted hover:text-t-dim',
                    ].join(' ')}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
            {tab === 'processes' && state.processes.map(p => (
              <ProcessRow
                key={p.id}
                process={p}
                cycles={state.cycles}
                upgrades={state.upgrades}
                totalCps={totalCps}
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
              filteredEquip.length === 0 ? (
                <div className="p-4 text-xs text-t-muted text-center">
                  {state.equipment.length === 0 ? (
                    <>
                      <p>No equipment dropped yet.</p>
                      <p className="mt-1 text-t-dim">
                        Equipment drops from node scanning.<br/>
                        Rate: {(getDropRate(state) * 100).toFixed(4)}%/s
                      </p>
                    </>
                  ) : (
                    <p>No items match the current filter.</p>
                  )}
                </div>
              ) : (
                filteredEquip.map(e => <EquipCard key={e.id} item={e} onDisenchant={disenchantEquip} />)
              )
            )}

            {tab === 'skills' && (
              <SkillTreeTab state={state} onBuySkill={buySkill} />
            )}

            {tab === 'stats' && <StatsTab state={state} />}
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
