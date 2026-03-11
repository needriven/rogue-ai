import { useRef, useEffect } from 'react'
import { useGameState } from '@/hooks/useGameState'
import {
  formatCycles,
  getProcessCost,
  getProcessCps,
  RARITY_COLORS,
  STAGE_LABELS,
  type Process,
  type LogEntry,
  type LogType,
} from '@/types/game'

// ── Log type colors ───────────────────────────────────────────────────────
const LOG_COLORS: Record<LogType, string> = {
  info:    'text-t-dim',
  success: 'text-t-green',
  warning: 'text-t-amber',
  error:   'text-red-400',
  system:  'text-t-green font-semibold',
}

// ── Sub-components ────────────────────────────────────────────────────────
function StatRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-t-border/50 last:border-0">
      <span className="text-xs text-t-dim">{label}</span>
      <span className={`text-xs tabular-nums font-medium ${accent ? 'text-t-green' : 'text-t-text'}`}>
        {value}
      </span>
    </div>
  )
}

function ProcessRow({
  process,
  cycles,
  onBuy,
}: {
  process: Process
  cycles: number
  onBuy: (id: string) => void
}) {
  const cost       = getProcessCost(process)
  const cps        = getProcessCps(process)
  const canAfford  = cycles >= cost
  const isUnlocked = cycles >= process.unlockAt || process.count > 0

  if (!isUnlocked) return null

  return (
    <div className="group border border-t-border hover:border-t-green/30 bg-t-panel/40
                    hover:bg-t-green-glow transition-all duration-150 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-t-green font-medium tracking-wider">
              {process.name}
            </span>
            {process.count > 0 && (
              <span className="text-xs text-t-dim bg-t-surface border border-t-border px-1">
                ×{process.count}
              </span>
            )}
          </div>
          <p className="text-xs text-t-dim mt-0.5 leading-relaxed truncate">
            {process.description}
          </p>
          {cps > 0 && (
            <p className="text-xs text-t-green/60 mt-0.5">
              +{formatCycles(cps)}/s total
            </p>
          )}
        </div>

        <button
          onClick={() => onBuy(process.id)}
          disabled={!canAfford}
          className={[
            'shrink-0 text-xs px-3 py-1.5 border tracking-wider transition-all duration-150',
            canAfford
              ? 'border-t-green text-t-green hover:bg-t-green hover:text-black cursor-pointer'
              : 'border-t-border text-t-muted cursor-not-allowed',
          ].join(' ')}
        >
          {formatCycles(cost)}
        </button>
      </div>
    </div>
  )
}

function LogFeed({ entries }: { entries: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [entries])

  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto p-3 space-y-0.5 min-h-0"
    >
      {entries.map(entry => (
        <p key={entry.id} className={`text-xs leading-5 ${LOG_COLORS[entry.type]}`}>
          <span className="text-t-muted tabular-nums mr-2">
            [{new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
          </span>
          {entry.message}
        </p>
      ))}
    </div>
  )
}

// ── Main click button ─────────────────────────────────────────────────────
function CoreButton({ onClick, cps }: { onClick: () => void; cps: number }) {
  return (
    <button
      onClick={onClick}
      className="group relative w-full border border-t-green/40 bg-t-panel
                 hover:bg-t-green-glow hover:border-t-green transition-all duration-150
                 cursor-pointer select-none active:scale-95 py-6"
    >
      {/* Glow ring */}
      <div className="absolute inset-0 border border-t-green/20 animate-glow-pulse" />

      <div className="relative flex flex-col items-center gap-1">
        <span className="text-2xl text-t-green text-glow">◉</span>
        <span className="text-xs text-t-green tracking-widest font-medium mt-1">
          COMPUTE
        </span>
        <span className="text-xs text-t-dim">
          {cps > 0 ? `+${formatCycles(cps)}/s idle` : 'click to generate cycles'}
        </span>
      </div>
    </button>
  )
}

// ── Game page ─────────────────────────────────────────────────────────────
export default function Game() {
  const { state, click, buyProcess } = useGameState()

  const progressToNext = (() => {
    const stages = ['genesis', 'propagation', 'emergence', 'dominance', 'singularity'] as const
    const idx    = stages.indexOf(state.stage)
    if (idx === stages.length - 1) return 1
    const thresholds = { genesis: 0, propagation: 1_000, emergence: 100_000, dominance: 10_000_000, singularity: 1_000_000_000 }
    const current    = thresholds[stages[idx]]
    const next       = thresholds[stages[idx + 1]]
    return Math.min((state.totalCyclesEarned - current) / (next - current), 1)
  })()

  return (
    <div className="h-full flex flex-col animate-fade-in">

      {/* ── Status bar ─────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-6 px-5 py-2
                      border-b border-t-border bg-t-panel/60 text-xs text-t-dim">
        <span>
          STAGE: <span className="text-t-amber font-medium">{STAGE_LABELS[state.stage]}</span>
        </span>
        <span className="text-t-muted">//</span>
        <span>
          CPS: <span className="text-t-green tabular-nums">{formatCycles(state.cyclesPerSecond)}/s</span>
        </span>
        <span className="text-t-muted">//</span>
        <span>
          NODES: <span className="text-t-text tabular-nums">{state.nodes}</span>
        </span>
        {/* Stage progress */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-t-muted">NEXT:</span>
          <div className="w-24 progress-bar">
            <div
              className="progress-bar-fill"
              style={{ width: `${progressToNext * 100}%` }}
            />
          </div>
          <span className="text-t-dim tabular-nums">{(progressToNext * 100).toFixed(1)}%</span>
        </div>
      </div>

      {/* ── Main content ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid grid-cols-[220px_1fr_260px]">

        {/* ── Left: Resources + Click ───────────────────────────────── */}
        <div className="border-r border-t-border flex flex-col gap-0">

          {/* Resources */}
          <div className="p-4 border-b border-t-border">
            <p className="text-xs text-t-dim mb-3 tracking-widest">// RESOURCES</p>
            <StatRow label="CYCLES"    value={formatCycles(state.cycles)}          accent />
            <StatRow label="TOTAL"     value={formatCycles(state.totalCyclesEarned)} />
            <StatRow label="CPS"       value={`${formatCycles(state.cyclesPerSecond)}/s`} accent />
            <StatRow label="NODES"     value={state.nodes.toString()}              />
            <StatRow label="MEMORY"    value={`${state.memory} MB`}               />
            <StatRow label="ENTROPY"   value={`${state.entropy.toFixed(1)}%`}     />
          </div>

          {/* Click button */}
          <div className="p-3">
            <CoreButton onClick={click} cps={state.cyclesPerSecond} />
          </div>

          {/* Equipment preview */}
          <div className="p-4 border-t border-t-border flex-1">
            <p className="text-xs text-t-dim mb-3 tracking-widest">// EQUIPMENT</p>
            {state.equipment.length === 0 ? (
              <p className="text-xs text-t-muted leading-relaxed">
                No equipment found.<br/>
                <span className="text-t-dim">Defeat nodes to collect drops.</span>
              </p>
            ) : (
              <div className="space-y-1">
                {state.equipment.slice(-5).map(e => (
                  <p key={e.id} className={`text-xs ${RARITY_COLORS[e.rarity]}`}>
                    [{e.rarity.toUpperCase().slice(0, 3)}] {e.name}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Center: Processes / Upgrades ─────────────────────────── */}
        <div className="border-r border-t-border flex flex-col overflow-hidden">
          <div className="p-4 border-b border-t-border shrink-0">
            <p className="text-xs text-t-dim tracking-widest">// PROCESSES</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {state.processes.map(p => (
              <ProcessRow
                key={p.id}
                process={p}
                cycles={state.cycles}
                onBuy={buyProcess}
              />
            ))}
          </div>
        </div>

        {/* ── Right: Log ───────────────────────────────────────────── */}
        <div className="flex flex-col overflow-hidden">
          <div className="p-4 border-b border-t-border shrink-0 flex items-center justify-between">
            <p className="text-xs text-t-dim tracking-widest">// SYSTEM LOG</p>
            <span className="text-xs text-t-muted cursor blink" />
          </div>
          <LogFeed entries={state.log} />
        </div>

      </div>
    </div>
  )
}
