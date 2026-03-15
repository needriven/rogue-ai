import { useState, useEffect, useCallback } from 'react'

const API = '/api/monitor'

// ── Types ──────────────────────────────────────────────────────────────────────
interface SystemStats {
  cpu_percent:   number
  mem_total_kb:  number
  mem_used_kb:   number
  mem_percent:   number
  disk_total_gb: number
  disk_used_gb:  number
  disk_percent:  number
}

interface Container {
  name:   string
  status: string
  image:  string
}

interface RedisInfo {
  used_memory_human:        string
  connected_clients:        number
  total_commands_processed: number
  keyspace_hits:            number
  keyspace_misses:          number
  uptime_in_seconds:        number
}

interface MongoInfo {
  connections_current:   number
  connections_available: number
  uptime:                number
  opcounters:            Record<string, number>
}

interface MonitorData {
  ts:         number
  system:     SystemStats
  containers: Container[]
  redis:      RedisInfo
  mongodb:    MongoInfo
}

interface HistorySample {
  ts:   number
  cpu:  number
  mem:  number
  disk: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function pctColor(pct: number): string {
  if (pct >= 90) return 'text-t-red'
  if (pct >= 70) return 'text-t-amber'
  return 'text-t-green'
}

function pctBarColor(pct: number): string {
  if (pct >= 90) return 'bg-t-red'
  if (pct >= 70) return 'bg-t-amber'
  return 'bg-t-green'
}

function containerStatusColor(status: string): string {
  if (status.toLowerCase().startsWith('up'))      return 'text-t-green'
  if (status.toLowerCase().includes('exit'))      return 'text-t-red'
  return 'text-t-amber'
}

function containerDot(status: string): string {
  if (status.toLowerCase().startsWith('up'))      return 'bg-t-green animate-glow-pulse'
  if (status.toLowerCase().includes('exit'))      return 'bg-t-red'
  return 'bg-t-amber'
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ data, field, color }: {
  data:  HistorySample[]
  field: 'cpu' | 'mem' | 'disk'
  color: string
}) {
  if (data.length < 2) return (
    <div className="h-8 flex items-end gap-px opacity-30">
      {Array.from({ length: 20 }).map((_, i) => (
        <div key={i} className="flex-1 bg-t-border" style={{ height: '2px' }} />
      ))}
    </div>
  )

  const vals    = data.map(s => s[field])
  const max     = Math.max(...vals, 1)
  const display = data.slice(-40)   // last 40 samples = ~20 min

  return (
    <div className="h-8 flex items-end gap-px" title={`${field.toUpperCase()} history`}>
      {display.map((s, i) => {
        const h = Math.max(1, Math.round((s[field] / max) * 32))
        return (
          <div
            key={i}
            className={`flex-1 ${color} opacity-70 transition-all duration-300`}
            style={{ height: `${h}px` }}
            title={`${s[field]}% @ ${new Date(s.ts * 1000).toLocaleTimeString()}`}
          />
        )
      })}
    </div>
  )
}

// ── Gauge bar ─────────────────────────────────────────────────────────────────
function GaugeBar({ label, value, pct, unit = '%', history, field }: {
  label:    string
  value:    string | number
  pct:      number
  unit?:    string
  history?: HistorySample[]
  field?:   'cpu' | 'mem' | 'disk'
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-t-dim">{label}</span>
        <span className={pctColor(pct)}>{value}{unit !== '' ? ` ${unit}` : ''}</span>
      </div>
      <div className="h-1.5 bg-t-border rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${pctBarColor(pct)}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {history && field && history.length > 1 && (
        <Sparkline data={history} field={field} color={pctBarColor(pct)} />
      )}
    </div>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-t-border bg-t-panel/60 p-4 space-y-3">
      <h3 className="text-xs font-semibold text-t-green tracking-widest uppercase">{title}</h3>
      {children}
    </div>
  )
}

// ── Stat row ──────────────────────────────────────────────────────────────────
function Stat({ label, value, dim }: { label: string; value: string | number; dim?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-t-dim">{label}</span>
      <span className={dim ? 'text-t-dim' : 'text-t-text tabular-nums'}>{value}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Monitor() {
  const [data,      setData]    = useState<MonitorData | null>(null)
  const [history,   setHistory] = useState<HistorySample[]>([])
  const [error,     setError]   = useState<string | null>(null)
  const [loading,   setLoading] = useState(true)
  const [lastUpdate,setLast]    = useState<number>(0)
  const [ageSec,    setAgeSec]  = useState<number | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json() as MonitorData)
      setLast(Date.now())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/history`)
      if (res.ok) setHistory((await res.json() as { history: HistorySample[] }).history)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    void fetchStats()
    void fetchHistory()
    const statsId   = setInterval(fetchStats,   5_000)
    const historyId = setInterval(fetchHistory, 30_000)
    return () => { clearInterval(statsId); clearInterval(historyId) }
  }, [fetchStats, fetchHistory])

  // Age counter
  useEffect(() => {
    const id = setInterval(() => {
      setAgeSec(lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) : null)
    }, 1000)
    return () => clearInterval(id)
  }, [lastUpdate])

  return (
    <div className="h-full flex flex-col font-mono text-t-text overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-3 border-b border-t-border bg-t-panel/40
                      flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-t-green text-xs tracking-widest font-semibold">SYSTEM_MONITOR</span>
          <span className="text-t-muted text-xs">//</span>
          <span className="text-t-dim text-xs">OCI VM — chans.place</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-t-dim">
          {ageSec !== null && (
            <span>
              REFRESH{' '}
              <span className={ageSec < 3 ? 'text-t-green' : ageSec < 8 ? 'text-t-amber' : 'text-t-red'}>
                {ageSec}s
              </span>{' '}AGO
            </span>
          )}
          {history.length > 0 && (
            <span className="text-t-muted">HIST: {history.length} samples</span>
          )}
          <span className="text-t-muted">AUTO ×5s</span>
          {error && <span className="text-t-red">ERR: {error}</span>}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────── */}
      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center text-t-dim text-xs tracking-widest">
          LOADING SYSTEM DATA...
        </div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center text-t-red text-xs">
          MONITOR OFFLINE — {error}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 content-start">

          {/* System Resources + sparklines */}
          <Card title="SYSTEM RESOURCES">
            <GaugeBar
              label="CPU"
              value={`${data.system.cpu_percent}%`}
              pct={data.system.cpu_percent}
              unit=""
              history={history}
              field="cpu"
            />
            <GaugeBar
              label="MEMORY"
              value={`${data.system.mem_percent}%`}
              pct={data.system.mem_percent}
              unit=""
              history={history}
              field="mem"
            />
            <GaugeBar
              label="DISK"
              value={`${data.system.disk_percent}%`}
              pct={data.system.disk_percent}
              unit=""
              history={history}
              field="disk"
            />
            <div className="pt-2 space-y-1 border-t border-t-border">
              <Stat label="MEM USED" value={`${(data.system.mem_used_kb / 1024).toFixed(0)} / ${(data.system.mem_total_kb / 1024).toFixed(0)} MB`} />
              <Stat label="DISK USED" value={`${data.system.disk_used_gb} / ${data.system.disk_total_gb} GB`} />
              {history.length > 0 && (
                <p className="text-[10px] text-t-muted pt-1">↑ 30-min history (30s interval)</p>
              )}
            </div>
          </Card>

          {/* Docker Containers */}
          <Card title="DOCKER CONTAINERS">
            {data.containers.length === 0 ? (
              <div className="space-y-1">
                <p className="text-xs text-t-amber">Socket connecting...</p>
                <p className="text-[10px] text-t-muted">docker.sock mounted — data available shortly</p>
              </div>
            ) : (
              <div className="space-y-2">
                {data.containers.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full mt-0.5 shrink-0 ${containerDot(c.status)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2">
                        <span className="text-t-text font-semibold truncate">{c.name}</span>
                        <span className={`shrink-0 ${containerStatusColor(c.status)}`}>
                          {c.status.slice(0, 20)}
                        </span>
                      </div>
                      <div className="text-t-muted truncate text-[10px]">{c.image}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Redis */}
          <Card title="REDIS">
            {Object.keys(data.redis).length === 0 ? (
              <p className="text-xs text-t-red">Redis unreachable</p>
            ) : (
              <>
                <Stat label="MEMORY"  value={data.redis.used_memory_human} />
                <Stat label="CLIENTS" value={data.redis.connected_clients} />
                <Stat label="UPTIME"  value={formatUptime(data.redis.uptime_in_seconds)} />
                <div className="border-t border-t-border pt-2 space-y-1">
                  <p className="text-[10px] text-t-dim tracking-wider">KEYSPACE</p>
                  <div className="flex gap-4 text-xs">
                    <span>HITS <span className="text-t-green tabular-nums">{data.redis.keyspace_hits.toLocaleString()}</span></span>
                    <span>MISS <span className="text-t-amber tabular-nums">{data.redis.keyspace_misses.toLocaleString()}</span></span>
                  </div>
                  <Stat
                    label="HIT RATE"
                    value={
                      data.redis.keyspace_hits + data.redis.keyspace_misses > 0
                        ? `${((data.redis.keyspace_hits / (data.redis.keyspace_hits + data.redis.keyspace_misses)) * 100).toFixed(1)}%`
                        : 'N/A'
                    }
                  />
                  <Stat label="TOTAL CMDS" value={data.redis.total_commands_processed.toLocaleString()} dim />
                </div>
              </>
            )}
          </Card>

          {/* MongoDB */}
          <Card title="MONGODB">
            {Object.keys(data.mongodb).length === 0 ? (
              <p className="text-xs text-t-red">MongoDB unreachable</p>
            ) : (
              <>
                <Stat label="UPTIME"      value={formatUptime(data.mongodb.uptime)} />
                <Stat label="CONNECTIONS" value={`${data.mongodb.connections_current} / ${data.mongodb.connections_current + data.mongodb.connections_available}`} />
                {data.mongodb.opcounters && (
                  <div className="border-t border-t-border pt-2 space-y-1">
                    <p className="text-[10px] text-t-dim tracking-wider">OP COUNTERS</p>
                    {['insert', 'query', 'update', 'delete'].map(op => (
                      <Stat
                        key={op}
                        label={op.toUpperCase()}
                        value={(data.mongodb.opcounters[op] ?? 0).toLocaleString()}
                        dim={(data.mongodb.opcounters[op] ?? 0) === 0}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>

          {/* Snapshot info */}
          <div className="border border-t-border/40 bg-t-panel/30 p-4 text-xs text-t-dim space-y-1">
            <p className="text-t-green/70 tracking-widest font-semibold text-[10px]">SNAPSHOT</p>
            <p>COLLECTED: {new Date(data.ts).toLocaleTimeString()}</p>
            <p>DISPLAYED: {new Date().toLocaleTimeString()}</p>
            <p className="pt-2 text-t-muted">
              OCI FREE TIER — Ubuntu 24.04 LTS (ARM64)<br />
              Ampere A1 · 4 vCPU · 24 GB RAM
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
