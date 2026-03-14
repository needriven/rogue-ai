import { useState, useEffect, useCallback } from 'react'
import { formatCycles } from '@/types/game'

const API = '/api/analytics'

// ── Types ──────────────────────────────────────────────────────────────────────
interface RunRecord {
  breach_level:     number
  duration_sec:     number
  total_cycles:     number
  stage_reached:    string
  modifier_used:    string
  fragments_gained: number
  equip_drops:      number
  legendary_drops:  number
  mythic_drops:     number
  createdAt:        number
}

interface BreachStat {
  breach:      number
  count:       number
  avgDuration: number
  avgCycles:   number
}

interface Summary {
  total_runs:      number
  best_breach:     number
  total_cycles:    number
  avg_duration:    number
  total_fragments: number
  total_drops:     number
  legendary_drops: number
  mythic_drops:    number
}

interface AnalyticsData {
  exists:      boolean
  summary?:    Summary
  byBreach?:   BreachStat[]
  topModifiers?: { modifier: string; count: number }[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function stageColor(stage: string): string {
  const map: Record<string, string> = {
    genesis:     'text-t-dim',
    propagation: 'text-cyan-400',
    emergence:   'text-t-amber',
    dominance:   'text-t-red',
    singularity: 'text-purple-400',
  }
  return map[stage] ?? 'text-t-dim'
}

const MODIFIER_NAMES: Record<string, string> = {
  overclock:          'OVERCLOCK',
  dark_market:        'DARK_MARKET',
  ghost_node:         'GHOST_NODE',
  parallel_process:   'PARALLEL_PROCESS',
  compressed_memory:  'COMPRESSED_MEMORY',
  turbo_mode:         'TURBO_MODE',
  trace_protocol:     'TRACE_PROTOCOL',
  fragmented_memory:  'FRAGMENTED_MEMORY',
  system_throttle:    'SYSTEM_THROTTLE',
  cold_storage:       'COLD_STORAGE',
}

// ── Mini bar chart ─────────────────────────────────────────────────────────────
function BreachBar({ breach, count, avgDuration, maxCount }: BreachStat & { maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-8 text-right text-t-dim shrink-0">×{breach}</span>
      <div className="flex-1 h-4 bg-t-border/40 relative overflow-hidden">
        <div
          className="h-full bg-purple-900/60 border-r border-purple-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-0 flex items-center pl-1 text-purple-300">
          {count} run{count !== 1 ? 's' : ''}
        </span>
      </div>
      <span className="w-24 text-right text-t-dim shrink-0 tabular-nums">
        {formatDuration(Math.floor(avgDuration))}
      </span>
    </div>
  )
}

// ── Run row ────────────────────────────────────────────────────────────────────
function RunRow({ run, idx }: { run: RunRecord; idx: number }) {
  const date = new Date(run.createdAt * 1000)
  return (
    <div className={`text-xs border-b border-t-border/30 py-2 px-3 ${idx % 2 === 0 ? '' : 'bg-t-panel/20'}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-t-muted shrink-0 tabular-nums">
          {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="border border-purple-800 text-purple-300 px-1">×{run.breach_level}</span>
        <span className={stageColor(run.stage_reached)}>{run.stage_reached.toUpperCase()}</span>
        <span className="text-t-dim">{formatDuration(run.duration_sec)}</span>
        <span className="text-t-green tabular-nums">{formatCycles(run.total_cycles)}</span>
        {run.modifier_used && (
          <span className="text-t-amber text-[10px] border border-amber-800 px-1">
            {MODIFIER_NAMES[run.modifier_used] ?? run.modifier_used}
          </span>
        )}
        <span className="ml-auto text-t-muted">
          +{run.fragments_gained}ƒ
          {run.legendary_drops > 0 && <span className="text-yellow-400 ml-1">★{run.legendary_drops}</span>}
          {run.mythic_drops    > 0 && <span className="text-purple-400 ml-1">◆{run.mythic_drops}</span>}
        </span>
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-t-border bg-t-panel/60 p-3 space-y-1">
      <p className="text-[10px] text-t-dim tracking-widest">{label}</p>
      <p className="text-lg font-semibold text-t-green tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[10px] text-t-muted">{sub}</p>}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Analytics() {
  const [sessionId] = useState(() => localStorage.getItem('rogue-ai-session') ?? '')
  const [summary,   setSummary]  = useState<AnalyticsData | null>(null)
  const [runs,      setRuns]     = useState<RunRecord[]>([])
  const [loading,   setLoading]  = useState(true)
  const [error,     setError]    = useState<string | null>(null)
  const [tab,       setTab]      = useState<'overview' | 'history'>('overview')

  const load = useCallback(async () => {
    if (!sessionId) { setLoading(false); return }
    setLoading(true)
    try {
      const [sumRes, runsRes] = await Promise.all([
        fetch(`${API}/summary/${sessionId}`),
        fetch(`${API}/runs/${sessionId}?limit=50`),
      ])
      if (!sumRes.ok || !runsRes.ok) throw new Error('API error')
      const sumJson  = await sumRes.json()  as AnalyticsData
      const runsJson = await runsRes.json() as { runs: RunRecord[] }
      setSummary(sumJson)
      setRuns(runsJson.runs)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load])

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center font-mono text-xs text-t-dim">
        <div className="text-center space-y-2">
          <p className="text-t-amber">NO SESSION ID FOUND</p>
          <p className="text-t-muted">Start the game to generate a session ID.</p>
        </div>
      </div>
    )
  }

  const s = summary?.summary

  return (
    <div className="h-full flex flex-col font-mono text-t-text overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-3 border-b border-t-border bg-t-panel/40
                      flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-t-green text-xs tracking-widest font-semibold">RUN_ANALYTICS</span>
          <span className="text-t-muted text-xs">//</span>
          <span className="text-t-dim text-xs font-mono truncate max-w-[200px]">{sessionId}</span>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-t-dim hover:text-t-text border border-t-border px-2 py-0.5 hover:border-t-green transition-colors"
        >
          ↻ REFRESH
        </button>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="shrink-0 flex border-b border-t-border">
        {(['overview', 'history'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-5 py-2 text-xs tracking-widest border-b-2 transition-colors',
              tab === t
                ? 'border-t-green text-t-green'
                : 'border-transparent text-t-dim hover:text-t-text',
            ].join(' ')}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-t-dim text-xs tracking-widest">
          LOADING ANALYTICS...
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-t-red text-xs">
          ERROR: {error}
        </div>
      ) : !summary?.exists ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2 text-xs">
            <p className="text-t-amber tracking-widest">NO RUN DATA</p>
            <p className="text-t-muted">Complete a NEURAL REBOOT to record your first run.</p>
          </div>
        </div>
      ) : tab === 'overview' ? (
        <div className="flex-1 overflow-auto p-6 space-y-6">

          {/* Summary stats */}
          {s && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="TOTAL RUNS"     value={String(s.total_runs)} />
              <StatCard label="BEST BREACH"    value={`×${s.best_breach}`} />
              <StatCard
                label="AVG RUN TIME"
                value={formatDuration(Math.floor(s.avg_duration))}
              />
              <StatCard
                label="TOTAL FRAGMENTS"
                value={`${s.total_fragments.toLocaleString()}ƒ`}
              />
              <StatCard
                label="TOTAL CYCLES"
                value={formatCycles(s.total_cycles)}
                sub="across all runs"
              />
              <StatCard
                label="EQUIPMENT DROPS"
                value={String(s.total_drops)}
                sub={`★${s.legendary_drops} legendary · ◆${s.mythic_drops} mythic`}
              />
            </div>
          )}

          {/* Breach progression chart */}
          {summary.byBreach && summary.byBreach.length > 0 && (
            <div className="border border-t-border bg-t-panel/60 p-4">
              <h3 className="text-xs font-semibold text-t-green tracking-widest mb-3">
                BREACH DISTRIBUTION
              </h3>
              <div className="flex text-[10px] text-t-muted justify-between mb-1 px-11">
                <span>RUNS</span>
                <span>AVG DURATION</span>
              </div>
              <div className="space-y-1.5">
                {(() => {
                  const max = Math.max(...summary.byBreach!.map(b => b.count))
                  return summary.byBreach!.map(b => (
                    <BreachBar key={b.breach} {...b} maxCount={max} />
                  ))
                })()}
              </div>
            </div>
          )}

          {/* Top modifiers */}
          {summary.topModifiers && summary.topModifiers.length > 0 && (
            <div className="border border-t-border bg-t-panel/60 p-4">
              <h3 className="text-xs font-semibold text-t-green tracking-widest mb-3">
                MOST USED MODIFIERS
              </h3>
              <div className="space-y-2">
                {summary.topModifiers.map((m, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-t-amber">
                      {MODIFIER_NAMES[m.modifier] ?? m.modifier}
                    </span>
                    <span className="text-t-dim tabular-nums">{m.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* History tab */
        <div className="flex-1 overflow-auto">
          <div className="sticky top-0 bg-t-panel/90 border-b border-t-border
                          grid grid-cols-[1fr_auto] text-[10px] text-t-muted
                          tracking-wider px-3 py-1.5">
            <span>RUN · BREACH · STAGE · DURATION · CYCLES · MOD</span>
            <span>FRAGS</span>
          </div>
          {runs.length === 0 ? (
            <div className="p-6 text-xs text-t-dim text-center">No run history yet.</div>
          ) : (
            runs.map((r, i) => <RunRow key={i} run={r} idx={i} />)
          )}
        </div>
      )}
    </div>
  )
}
