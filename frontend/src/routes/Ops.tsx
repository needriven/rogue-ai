import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Bot {
  id: number; name: string; description: string; schedule: string
  is_active: number; created_at: number; updated_at: number
}
interface BotDetail extends Bot { code: string; env_json: string }
interface BotRun {
  id: number; bot_id: number; status: 'pending' | 'running' | 'success' | 'error' | 'timeout'
  exit_code: number | null; started_at: number; finished_at: number | null
  stdout_preview?: string; stdout?: string; stderr: string
}
interface Setting { key: string; is_set: boolean; display: string; masked: boolean; from_env: boolean }
interface UsagePeriod { input_tokens: number; output_tokens: number; cost_usd: number; calls: number }
interface UsageByModel { model: string; endpoint: string; inp: number; out: number; cost: number; calls: number }
interface UsageRecent { endpoint: string; model: string; input_tok: number; output_tok: number; cost_usd: number; created_at: number }
interface UsageStats { periods: Record<'today'|'week'|'month', UsagePeriod>; by_model: UsageByModel[]; recent: UsageRecent[] }
interface AdminUsageDay { date: string; model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
interface AdminUsage { data: AdminUsageDay[] }
interface BotDataEntry { value: unknown; updated_at: number }
interface BotData { [key: string]: BotDataEntry }
interface ContribDay { date: string; contributionCount: number }
interface ContribWeek { contributionDays: ContribDay[] }
interface GitActivity { totalContributions: number; weeks: ContribWeek[] }
interface ActionRun {
  id: number; name: string; display_title: string; status: string; conclusion: string | null
  branch: string; sha: string; created_at: string; url: string; run_number: number
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(text || `HTTP ${r.status}`)
  }
  if (r.status === 204) return undefined as T
  return r.json()
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function duration(startMs: number, endMs: number | null): string {
  if (!endMs) return '…'
  const s = (endMs - startMs) / 1000
  if (s < 60)  return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

function envJsonToLines(json: string): string {
  try {
    const obj = JSON.parse(json)
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n')
  } catch { return '' }
}

function linesToEnvJson(lines: string): string {
  const obj: Record<string, string> = {}
  for (const line of lines.split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return JSON.stringify(obj)
}

const CRON_PRESETS = [
  { label: 'every minute',   value: '* * * * *' },
  { label: 'every hour',     value: '0 * * * *' },
  { label: 'daily 9am UTC',  value: '0 9 * * *' },
  { label: 'daily midnight', value: '0 0 * * *' },
  { label: 'every Monday',   value: '0 9 * * 1' },
  { label: 'every weekday',  value: '0 9 * * 1-5' },
]

const STATUS_COLOR: Record<string, string> = {
  success: 'text-t-green',
  error:   'text-t-red',
  timeout: 'text-t-amber',
  running: 'text-t-amber animate-pulse',
  pending: 'text-t-dim',
}

const STATUS_ICON: Record<string, string> = {
  success: '✓', error: '✗', timeout: '⏱', running: '●', pending: '○',
}

const CONTRIB_COLOR = (n: number) =>
  n === 0 ? 'bg-t-panel'
  : n < 3  ? 'bg-green-900'
  : n < 6  ? 'bg-green-700'
  : n < 10 ? 'bg-green-500'
             : 'bg-t-green'

// ── Tab bar ───────────────────────────────────────────────────────────────────
type Tab = 'bots' | 'github' | 'ai' | 'usage' | 'settings'
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'bots',     label: 'BOTS',     icon: '◈' },
  { id: 'github',   label: 'GITHUB',   icon: '⌥' },
  { id: 'ai',       label: 'AI',       icon: '✦' },
  { id: 'usage',    label: 'USAGE',    icon: '$' },
  { id: 'settings', label: 'SETTINGS', icon: '⚙' },
]

// ── BOT EDITOR ────────────────────────────────────────────────────────────────
const DEFAULT_CODE = `# Rogue AI bot — runs on OCI VM (python3)
# stdout is captured and shown in run history
import datetime, os

print(f"[{datetime.datetime.utcnow().isoformat()}] bot started")

# your logic here

print("done.")
`

interface Draft {
  name: string; description: string; code: string
  schedule: string; env_lines: string; is_active: boolean
}

function BotEditor({
  bot, onSave, onDelete, onRun,
}: {
  bot: BotDetail | null
  onSave: (d: Draft) => void
  onDelete: () => void
  onRun: () => void
}) {
  const [draft, setDraft] = useState<Draft>({
    name: '', description: '', code: DEFAULT_CODE,
    schedule: '', env_lines: '', is_active: true,
  })
  const [showPresets, setShowPresets] = useState(false)
  const codeRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (bot) {
      setDraft({
        name:        bot.name,
        description: bot.description,
        code:        bot.code,
        schedule:    bot.schedule,
        env_lines:   envJsonToLines(bot.env_json),
        is_active:   !!bot.is_active,
      })
    } else {
      setDraft({ name: '', description: '', code: DEFAULT_CODE, schedule: '', env_lines: '', is_active: true })
    }
  }, [bot?.id])

  const set = (k: keyof Draft) => (v: string | boolean) =>
    setDraft(d => ({ ...d, [k]: v }))

  const handleCodeTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const el = e.currentTarget
    const s  = el.selectionStart
    const newVal = draft.code.slice(0, s) + '    ' + draft.code.slice(el.selectionEnd)
    set('code')(newVal)
    requestAnimationFrame(() => {
      if (codeRef.current) codeRef.current.selectionStart = codeRef.current.selectionEnd = s + 4
    })
  }

  const inp = 'w-full bg-black/40 border border-t-border text-t-text text-xs px-2 py-1.5 focus:outline-none focus:border-t-green font-mono'

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* name + active toggle */}
      <div className="flex items-center gap-2">
        <input
          className={`${inp} flex-1`} placeholder="bot_name"
          value={draft.name} onChange={e => set('name')(e.target.value)}
        />
        <button
          onClick={() => set('is_active')(!draft.is_active)}
          className={`text-xs px-2 py-1 border ${draft.is_active ? 'border-t-green text-t-green' : 'border-t-border text-t-dim'}`}
        >
          {draft.is_active ? 'ACTIVE' : 'PAUSED'}
        </button>
      </div>

      {/* description */}
      <input
        className={inp} placeholder="description (optional)"
        value={draft.description} onChange={e => set('description')(e.target.value)}
      />

      {/* schedule */}
      <div className="flex items-center gap-1 relative">
        <input
          className={`${inp} flex-1`} placeholder="cron: * * * * *  (leave blank = manual only)"
          value={draft.schedule} onChange={e => set('schedule')(e.target.value)}
        />
        <button
          onClick={() => setShowPresets(p => !p)}
          className="text-xs px-2 py-1.5 border border-t-border text-t-dim hover:text-t-text hover:border-t-green shrink-0"
        >
          ▾
        </button>
        {showPresets && (
          <div className="absolute top-8 right-0 z-10 bg-t-panel border border-t-border w-52">
            {CRON_PRESETS.map(p => (
              <button
                key={p.value}
                onClick={() => { set('schedule')(p.value); setShowPresets(false) }}
                className="w-full text-left px-3 py-1.5 text-xs text-t-dim hover:text-t-green hover:bg-black/30"
              >
                <span className="text-t-muted">{p.value}</span>
                <span className="ml-2">{p.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* env vars */}
      <div>
        <p className="text-xs text-t-muted mb-1">ENV VARS <span className="opacity-50">(KEY=VALUE, one per line)</span></p>
        <textarea
          className={`${inp} h-16 resize-none`}
          placeholder="API_KEY=xxx&#10;BASE_URL=https://..."
          value={draft.env_lines} onChange={e => set('env_lines')(e.target.value)}
        />
      </div>

      {/* code editor */}
      <div className="flex flex-col flex-1 min-h-0">
        <p className="text-xs text-t-muted mb-1">CODE <span className="opacity-50">(python3, Tab = 4 spaces)</span></p>
        <textarea
          ref={codeRef}
          className="flex-1 min-h-0 w-full bg-black/60 border border-t-border text-t-green text-xs px-3 py-2
                     focus:outline-none focus:border-t-green font-mono resize-none leading-5"
          value={draft.code}
          onChange={e => set('code')(e.target.value)}
          onKeyDown={handleCodeTab}
          spellCheck={false}
        />
      </div>

      {/* actions */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => onSave(draft)}
          className="text-xs px-3 py-1.5 border border-t-green text-t-green hover:bg-t-green-glow"
        >
          SAVE
        </button>
        <button
          onClick={onRun}
          disabled={!bot}
          className="text-xs px-3 py-1.5 border border-t-amber text-t-amber hover:bg-t-amber/10 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ▶ RUN NOW
        </button>
        {bot && (
          <button
            onClick={onDelete}
            className="ml-auto text-xs px-3 py-1.5 border border-t-red text-t-red hover:bg-t-red/10"
          >
            DELETE
          </button>
        )}
      </div>
    </div>
  )
}

// ── RUN LOG ───────────────────────────────────────────────────────────────────
function RunLog({ run }: { run: BotRun }) {
  const [expanded, setExpanded] = useState(false)
  const [full, setFull] = useState<BotRun | null>(null)

  const expand = async () => {
    if (!expanded) {
      const data = await apiFetch<BotRun>(`/bots/runs/${run.id}`)
      setFull(data)
    }
    setExpanded(e => !e)
  }

  const col  = STATUS_COLOR[run.status] ?? 'text-t-dim'
  const icon = STATUS_ICON[run.status]  ?? '○'

  return (
    <div className="border-b border-t-border/50 last:border-0">
      <button
        onClick={expand}
        className="w-full flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-t-panel/50 text-left"
      >
        <span className={`${col} w-3`}>{icon}</span>
        <span className={`${col} uppercase w-16 shrink-0`}>{run.status}</span>
        <span className="text-t-dim w-16 shrink-0">{duration(run.started_at, run.finished_at)}</span>
        <span className="text-t-muted flex-1">{timeAgo(run.started_at)}</span>
        <span className="text-t-muted">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3">
          {(full?.stdout || run.stdout_preview) ? (
            <pre className="text-t-green text-xs bg-black/40 border border-t-border p-2 overflow-auto max-h-40 leading-4">
              {full?.stdout ?? run.stdout_preview}
            </pre>
          ) : null}
          {(full?.stderr ?? run.stderr) ? (
            <pre className="text-t-red text-xs bg-black/40 border border-t-red/30 p-2 mt-1 overflow-auto max-h-24 leading-4">
              {full?.stderr ?? run.stderr}
            </pre>
          ) : null}
          {!full?.stdout && !run.stdout_preview && !run.stderr && (
            <p className="text-t-muted text-xs italic px-1">no output</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── BOT DATA PANEL ────────────────────────────────────────────────────────────
function BotDataPanel({ botId, data }: { botId: number; data: BotData }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const apiBase = window.location.origin

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  return (
    <div className="border-t border-t-border shrink-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-t-border">
        <span className="text-t-green text-[10px]">◈</span>
        <p className="text-xs text-t-muted tracking-widest">BOT DATA</p>
        <span className="text-[10px] text-t-muted ml-auto">REST API · public read</span>
      </div>
      <div className="overflow-y-auto max-h-56 divide-y divide-t-border/50">
        {Object.entries(data).map(([key, entry]) => {
          const url     = `${apiBase}/api/bots/${botId}/data`
          const val     = entry.value
          const isObj   = typeof val === 'object' && val !== null
          const preview = isObj
            ? JSON.stringify(val).slice(0, 120)
            : String(val)
          const expanded = expandedKey === key

          return (
            <div key={key} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-t-green font-mono text-[10px] tracking-wider">
                  {key === 'default' ? 'data' : key}
                </span>
                <span className="text-[10px] text-t-muted ml-auto">{timeAgo(entry.updated_at)}</span>
                <button
                  onClick={() => setExpandedKey(expanded ? null : key)}
                  className="text-[10px] text-t-muted hover:text-t-text px-1"
                  title="expand"
                >
                  {expanded ? '▲' : '▼'}
                </button>
                <button
                  onClick={() => copy(url + (key !== 'default' ? `?key=${key}` : ''), `url-${key}`)}
                  className="text-[10px] text-t-dim hover:text-t-green border border-t-border/50 px-1.5 py-0.5"
                  title="copy API URL"
                >
                  {copiedKey === `url-${key}` ? '✓ copied' : '⧉ URL'}
                </button>
                <button
                  onClick={() => copy(JSON.stringify(val, null, 2), `val-${key}`)}
                  className="text-[10px] text-t-dim hover:text-t-green border border-t-border/50 px-1.5 py-0.5"
                >
                  {copiedKey === `val-${key}` ? '✓' : '{ }'}
                </button>
              </div>

              {expanded ? (
                <pre className="mt-1.5 text-[10px] text-t-green bg-black/40 border border-t-border
                                p-2 overflow-auto max-h-40 leading-4 font-mono">
                  {JSON.stringify(val, null, 2)}
                </pre>
              ) : (
                <p className="mt-0.5 text-[10px] text-t-dim font-mono truncate">{preview}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── BOTS PANEL ────────────────────────────────────────────────────────────────
function BotsPanel() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [runFlash, setRunFlash] = useState<number | null>(null)

  const { data: bots = [] } = useQuery<Bot[]>({
    queryKey: ['bots'],
    queryFn:  () => apiFetch('/bots'),
    refetchInterval: 5000,
  })

  const { data: detail } = useQuery<BotDetail>({
    queryKey: ['bot', selectedId],
    queryFn:  () => apiFetch(`/bots/${selectedId}`),
    enabled:  selectedId !== null && !isNew,
  })

  const { data: runs = [], refetch: refetchRuns } = useQuery<BotRun[]>({
    queryKey: ['bot-runs', selectedId],
    queryFn:  () => apiFetch(`/bots/${selectedId}/runs`),
    enabled:  selectedId !== null && !isNew,
    refetchInterval: (query) => {
      const data = query.state.data as BotRun[] | undefined
      return data?.some((r: BotRun) => r.status === 'running' || r.status === 'pending') ? 2000 : false
    },
  })

  const saveMut = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name, description: d.description, code: d.code,
        schedule: d.schedule, env_json: linesToEnvJson(d.env_lines),
        is_active: d.is_active ? 1 : 0,
      }
      if (isNew) {
        const res = await apiFetch<{ id: number }>('/bots', {
          method: 'POST', body: JSON.stringify(body),
        })
        return res.id
      }
      await apiFetch(`/bots/${selectedId}`, { method: 'PUT', body: JSON.stringify(body) })
      return selectedId!
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['bots'] })
      qc.invalidateQueries({ queryKey: ['bot', id] })
      setIsNew(false)
      setSelectedId(id)
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/bots/${selectedId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bots'] })
      setSelectedId(null)
    },
  })

  const runMut = useMutation({
    mutationFn: () => apiFetch<{ run_id: number }>(`/bots/${selectedId}/run`, { method: 'POST' }),
    onSuccess: () => {
      setRunFlash(Date.now())
      setTimeout(() => setRunFlash(null), 1000)
      refetchRuns()
    },
  })

  const hasActive = runs.some((r: BotRun) => r.status === 'running' || r.status === 'pending')

  const { data: botData } = useQuery<BotData>({
    queryKey: ['bot-data', selectedId],
    queryFn:  () => apiFetch(`/bots/${selectedId}/data`),
    enabled:  selectedId !== null && !isNew,
    refetchInterval: 10000,
  })

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* ── Left: bot list ── */}
      <div className="w-44 shrink-0 border-r border-t-border flex flex-col">
        <div className="px-3 py-2 border-b border-t-border">
          <p className="text-xs text-t-muted tracking-widest">BOTS</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {bots.map(b => (
            <button
              key={b.id}
              onClick={() => { setSelectedId(b.id); setIsNew(false) }}
              className={`w-full text-left px-3 py-2 text-xs border-l-2 transition-colors ${
                selectedId === b.id && !isNew
                  ? 'border-t-green text-t-green bg-t-green-glow'
                  : 'border-transparent text-t-dim hover:text-t-text hover:border-t-border'
              }`}
            >
              <span className={`mr-1.5 ${b.is_active ? 'text-t-green' : 'text-t-muted'}`}>●</span>
              <span className="truncate">{b.name || 'unnamed'}</span>
              {b.schedule && <p className="text-t-muted text-[10px] mt-0.5 truncate">{b.schedule}</p>}
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-t-border flex flex-col gap-1">
          <button
            onClick={() => { setIsNew(true); setSelectedId(null) }}
            className={`w-full text-xs py-1.5 border ${
              isNew ? 'border-t-green text-t-green' : 'border-t-border text-t-dim hover:border-t-green hover:text-t-green'
            }`}
          >
            + NEW BOT
          </button>
          {bots.length === 0 && (
            <button
              onClick={async () => {
                await apiFetch('/bots/seed', { method: 'POST' })
                qc.invalidateQueries({ queryKey: ['bots'] })
              }}
              className="w-full text-xs py-1.5 border border-t-amber/50 text-t-amber hover:border-t-amber"
            >
              ✦ load samples
            </button>
          )}
        </div>
      </div>

      {/* ── Right: editor + runs ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedId !== null || isNew ? (
          <>
            <div className="flex-1 min-h-0 p-4 overflow-y-auto">
              <BotEditor
                bot={isNew ? null : detail ?? null}
                onSave={d => saveMut.mutate(d)}
                onDelete={() => { if (confirm(`Delete bot "${detail?.name}"?`)) deleteMut.mutate() }}
                onRun={() => runMut.mutate()}
              />
              {saveMut.error && (
                <p className="text-t-red text-xs mt-2">{String(saveMut.error)}</p>
              )}
            </div>

            {/* run history */}
            {selectedId !== null && !isNew && (
              <div className="border-t border-t-border shrink-0 max-h-48 flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-t-border">
                  <p className="text-xs text-t-muted tracking-widest">RUN HISTORY</p>
                  {hasActive && <span className="text-t-amber text-xs animate-pulse">● running</span>}
                  {runFlash && <span className="text-t-green text-xs">triggered</span>}
                </div>
                <div className="overflow-y-auto">
                  {runs.length === 0 ? (
                    <p className="text-t-muted text-xs px-3 py-3 italic">no runs yet</p>
                  ) : (
                    runs.map((r: BotRun) => <RunLog key={r.id} run={r} />)
                  )}
                </div>
              </div>
            )}

            {/* data panel */}
            {selectedId !== null && !isNew && botData && Object.keys(botData).length > 0 && (
              <BotDataPanel botId={selectedId} data={botData} />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-t-muted text-xs">← select a bot or create new</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── GITHUB PANEL ──────────────────────────────────────────────────────────────
function GitHubPanel() {
  const { data: activity, isLoading: loadAct, error: errAct } = useQuery<GitActivity>({
    queryKey: ['github-activity'],
    queryFn:  () => apiFetch('/github/activity'),
    staleTime: 5 * 60 * 1000,
  })

  const { data: actions, isLoading: loadAct2, error: errAct2 } = useQuery<{ total_count: number; runs: ActionRun[] }>({
    queryKey: ['github-actions'],
    queryFn:  () => apiFetch('/github/actions'),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  })

  const conclusionStyle = (c: string | null) =>
    c === 'success' ? 'text-t-green' : c === 'failure' ? 'text-t-red' : c === null ? 'text-t-amber animate-pulse' : 'text-t-dim'

  const conclusionIcon = (status: string, c: string | null) =>
    status === 'in_progress' || status === 'queued' ? '●'
    : c === 'success' ? '✓' : c === 'failure' ? '✗' : '○'

  const weeks = activity?.weeks ?? []

  // month labels: find first week of each month
  const monthLabels: { label: string; col: number }[] = []
  weeks.forEach((week, wi) => {
    const day = week.contributionDays[0]
    if (!day) return
    const d = new Date(day.date)
    if (d.getDate() <= 7) {
      monthLabels.push({ label: d.toLocaleString('en', { month: 'short' }), col: wi })
    }
  })

  return (
    <div className="p-4 flex flex-col gap-6 overflow-y-auto h-full">
      {/* Activity heatmap */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <p className="text-xs text-t-muted tracking-widest">CONTRIBUTION ACTIVITY</p>
          {activity && (
            <span className="text-t-green text-xs">
              {activity.totalContributions.toLocaleString()} contributions this year
            </span>
          )}
          {loadAct && <span className="text-t-dim text-xs animate-pulse">fetching…</span>}
        </div>

        {errAct ? (
          <p className="text-t-red text-xs">{String(errAct)}</p>
        ) : weeks.length > 0 ? (
          <div className="overflow-x-auto">
            {/* month labels */}
            <div className="flex gap-[3px] mb-1 text-[10px] text-t-muted" style={{ paddingLeft: '2px' }}>
              {monthLabels.map(m => (
                <span key={m.col} style={{ gridColumn: m.col + 1, marginLeft: m.col === 0 ? 0 : `${(m.col - (monthLabels[monthLabels.indexOf(m) - 1]?.col ?? 0) - 1) * 11}px` }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="flex gap-[3px]">
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[3px]">
                  {Array.from({ length: 7 }).map((_, di) => {
                    const day = week.contributionDays[di]
                    return (
                      <div
                        key={di}
                        title={day ? `${day.date}: ${day.contributionCount} contributions` : ''}
                        className={`w-[10px] h-[10px] rounded-[1px] ${day ? CONTRIB_COLOR(day.contributionCount) : 'bg-t-panel opacity-30'}`}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2 text-[10px] text-t-muted">
              <span>less</span>
              {[0, 2, 5, 8, 12].map(n => (
                <div key={n} className={`w-[10px] h-[10px] rounded-[1px] ${CONTRIB_COLOR(n)}`} />
              ))}
              <span>more</span>
            </div>
          </div>
        ) : !loadAct ? (
          <p className="text-t-muted text-xs italic">Configure github_token + github_username in Settings to see activity</p>
        ) : null}
      </div>

      {/* Recent Actions runs */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <p className="text-xs text-t-muted tracking-widest">RECENT ACTIONS</p>
          {actions && (
            <span className="text-t-dim text-xs">{actions.total_count} total runs</span>
          )}
          {loadAct2 && <span className="text-t-dim text-xs animate-pulse">fetching…</span>}
        </div>

        {errAct2 ? (
          <p className="text-t-red text-xs">{String(errAct2)}</p>
        ) : (actions?.runs ?? []).length > 0 ? (
          <div className="border border-t-border">
            {actions!.runs.map(run => (
              <a
                key={run.id} href={run.url} target="_blank" rel="noreferrer"
                className="flex items-center gap-3 px-3 py-2 text-xs border-b border-t-border/50 last:border-0 hover:bg-t-panel/50 transition-colors"
              >
                <span className={`w-4 text-center ${conclusionStyle(run.conclusion)}`}>
                  {conclusionIcon(run.status, run.conclusion)}
                </span>
                <span className="text-t-text truncate flex-1">{run.display_title}</span>
                <span className="text-t-muted shrink-0">#{run.run_number}</span>
                <span className="text-t-dim shrink-0 w-16 truncate">{run.branch}</span>
                <span className="text-t-muted font-mono shrink-0">{run.sha}</span>
                <span className="text-t-muted shrink-0">
                  {timeAgo(new Date(run.created_at).getTime())}
                </span>
              </a>
            ))}
          </div>
        ) : !loadAct2 ? (
          <p className="text-t-muted text-xs italic">Configure github_token + github_repo in Settings to see Actions runs</p>
        ) : null}
      </div>
    </div>
  )
}

// ── AI PANEL ──────────────────────────────────────────────────────────────────
interface Message { role: 'user' | 'assistant'; content: string }

interface ToolCall {
  tool:   string
  input:  Record<string, unknown>
  result: string
}

interface AgentResponse {
  reply:          string
  tool_calls:     ToolCall[]
  created_bot_id: number | null
  usage:          { input_tokens: number; output_tokens: number }
}

function renderContent(text: string) {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '')
      return (
        <pre key={i} className="bg-black/60 border border-t-border text-t-green text-xs p-2 my-1 overflow-auto leading-4">
          {code}
        </pre>
      )
    }
    return <span key={i} className="whitespace-pre-wrap">{part}</span>
  })
}

// Chat sub-panel (original Haiku chat)
function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setError('')
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setLoading(true)
    try {
      const res = await apiFetch<{ content: string; usage: { input_tokens: number; output_tokens: number } }>(
        '/ai/chat',
        { method: 'POST', body: JSON.stringify({ messages: next }) },
      )
      setMessages([...next, { role: 'assistant', content: res.content }])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [input, messages, loading])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="text-t-muted text-xs space-y-1 mt-4">
            <p>Ask the AI assistant anything:</p>
            <p className="text-t-dim">· explain what this cron expression does: 0 9 * * 1</p>
            <p className="text-t-dim">· how do I send a Discord webhook from Python?</p>
            <p className="text-t-dim">· help me debug this Python script</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={`inline-block max-w-[85%] text-xs px-3 py-2 border ${
              m.role === 'user'
                ? 'border-t-green/50 text-t-text bg-t-green-glow'
                : 'border-t-border text-t-dim bg-t-panel/50'
            }`}>
              {m.role === 'assistant' ? renderContent(m.content) : m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div>
            <div className="inline-block text-xs px-3 py-2 border border-t-border text-t-muted animate-pulse">
              thinking…
            </div>
          </div>
        )}
        {error && <p className="text-t-red text-xs">{error}</p>}
        <div ref={bottomRef} />
      </div>
      <div className="shrink-0 px-4 py-3 border-t border-t-border flex gap-2">
        <textarea
          className="flex-1 bg-black/40 border border-t-border text-t-text text-xs px-2 py-1.5
                     focus:outline-none focus:border-t-green font-mono resize-none h-14 leading-5"
          placeholder="ask the AI…  (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
        />
        <button
          onClick={send} disabled={loading || !input.trim()}
          className="text-xs px-4 py-2 border border-t-green text-t-green hover:bg-t-green-glow
                     disabled:opacity-30 disabled:cursor-not-allowed self-end"
        >
          SEND
        </button>
      </div>
    </div>
  )
}

// Agent sub-panel (BotForge: natural language → bot creation)
function AgentPanel({ onBotCreated }: { onBotCreated: (id: number) => void }) {
  const [input, setInput]     = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [result, setResult]   = useState<AgentResponse | null>(null)

  const run = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const res = await apiFetch<AgentResponse>(
        '/ai/agent',
        { method: 'POST', body: JSON.stringify({ message: text }) },
      )
      setResult(res)
      if (res.created_bot_id != null) onBotCreated(res.created_bot_id)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [input, loading, onBotCreated])

  const TOOL_ICONS: Record<string, string> = {
    list_bots:  '📋',
    create_bot: '🤖',
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Prompt examples */}
        {!result && !loading && (
          <div className="text-t-muted text-xs space-y-1 mt-2">
            <p className="text-t-dim tracking-wider">BotForge — describe a bot in plain language:</p>
            <button onClick={() => setInput('매일 오전 9시에 GitHub 이슈를 체크해서 Discord로 알려주는 봇 만들어줘')}
              className="block text-left text-t-muted hover:text-t-text w-full py-0.5">
              · 매일 오전 9시에 GitHub 이슈를 체크해서 Discord로 알려주는 봇
            </button>
            <button onClick={() => setInput('30분마다 HN Top 5를 Slack으로 보내주는 봇 만들어줘')}
              className="block text-left text-t-muted hover:text-t-text w-full py-0.5">
              · 30분마다 HN Top 5를 Slack으로 보내는 봇
            </button>
            <button onClick={() => setInput('OCI VM 디스크 사용량이 80% 넘으면 Discord 경고 보내는 봇 만들어줘')}
              className="block text-left text-t-muted hover:text-t-text w-full py-0.5">
              · 디스크 사용량 80% 초과 시 Discord 경고 봇
            </button>
          </div>
        )}

        {/* Input */}
        <div className="flex flex-col gap-2">
          <textarea
            className="w-full bg-black/40 border border-t-border text-t-text text-xs px-2 py-1.5
                       focus:outline-none focus:border-t-green font-mono resize-none h-20 leading-5"
            placeholder="만들고 싶은 봇을 설명하세요…  (예: 매일 아침 날씨 정보 Discord 전송)"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() }
            }}
          />
          <button
            onClick={run} disabled={loading || !input.trim()}
            className="self-end text-xs px-5 py-1.5 border border-t-green text-t-green
                       hover:bg-t-green-glow disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {loading ? 'BUILDING…' : '⚡ BUILD BOT'}
          </button>
        </div>

        {/* Loading indicator */}
        {loading && (
          <div className="border border-t-border p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-t-green animate-pulse" />
              <span className="text-xs text-t-muted">BotForge is working…</span>
            </div>
            <p className="text-[10px] text-t-muted pl-4">checking existing bots → writing code → registering</p>
          </div>
        )}

        {error && <p className="text-t-red text-xs border border-t-red/30 px-2 py-1">{error}</p>}

        {/* Result */}
        {result && (
          <div className="flex flex-col gap-3">
            {/* Tool call timeline */}
            {result.tool_calls.length > 0 && (
              <div className="border border-t-border">
                <p className="text-[10px] text-t-muted tracking-widest px-2 py-1 border-b border-t-border">
                  AGENT TRACE
                </p>
                {result.tool_calls.map((tc, i) => (
                  <div key={i} className="border-b border-t-border/50 last:border-0 px-2 py-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span>{TOOL_ICONS[tc.tool] ?? '⚙'}</span>
                      <span className="text-t-green font-mono">{tc.tool}</span>
                      {tc.tool === 'create_bot' && (
                        <span className="text-t-dim">
                          {(tc.input as { name?: string }).name}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-t-muted mt-0.5 pl-5 leading-4">{tc.result}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Created bot card */}
            {result.created_bot_id != null && (
              <div className="border border-t-green/40 bg-t-green-glow px-3 py-2 flex items-center gap-3">
                <span className="text-t-green text-sm">✓</span>
                <div className="flex-1">
                  <p className="text-xs text-t-green tracking-wider">BOT CREATED</p>
                  <p className="text-[10px] text-t-dim">id={result.created_bot_id} · visible in BOTS tab</p>
                </div>
              </div>
            )}

            {/* Final reply */}
            {result.reply && (
              <div className="border border-t-border bg-t-panel/40 px-3 py-2 text-xs text-t-dim leading-5">
                {renderContent(result.reply)}
              </div>
            )}

            {/* Usage */}
            <p className="text-[10px] text-t-muted text-right">
              tokens: {result.usage.input_tokens}↑ {result.usage.output_tokens}↓
            </p>

            {/* Build another */}
            <button
              onClick={() => { setResult(null); setInput('') }}
              className="self-start text-[10px] text-t-dim hover:text-t-text border border-t-border/50 px-2 py-1"
            >
              ← build another bot
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function AiPanel({ onSwitchToBots }: { onSwitchToBots: (botId: number) => void }) {
  const [mode, setMode] = useState<'chat' | 'agent'>('agent')

  const tabCls = (m: 'chat' | 'agent') =>
    `text-[10px] tracking-widest px-3 py-1 border-b-2 transition-colors ${
      mode === m
        ? 'border-t-green text-t-green'
        : 'border-transparent text-t-muted hover:text-t-dim'
    }`

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header with mode tabs */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-t-border shrink-0">
        <span className="text-t-green text-xs">✦</span>
        <span className="text-xs text-t-muted tracking-widest">AI ASSISTANT</span>
        <div className="ml-auto flex gap-0">
          <button className={tabCls('agent')} onClick={() => setMode('agent')}>BOTFORGE</button>
          <button className={tabCls('chat')}  onClick={() => setMode('chat')}>CHAT</button>
        </div>
      </div>

      {mode === 'agent'
        ? <AgentPanel onBotCreated={(id) => { onSwitchToBots(id) }} />
        : <ChatPanel />
      }
    </div>
  )
}

// ── USAGE PANEL ───────────────────────────────────────────────────────────────
function UsagePanel() {
  const { data: stats, isLoading: loadingStats, refetch } = useQuery<UsageStats>({
    queryKey: ['usage-stats'],
    queryFn:  () => apiFetch('/usage/stats'),
    refetchInterval: 30_000,
  })
  const { data: adminData, isLoading: loadingAdmin, error: adminErr } = useQuery<AdminUsage>({
    queryKey: ['usage-admin'],
    queryFn:  () => apiFetch('/usage/admin'),
    retry: false,
  })

  const fmt = (n: number) => n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}k` : String(n)
  const fmtCost = (n: number) => n < 0.001 ? `$${(n * 1000).toFixed(3)}m` : `$${n.toFixed(4)}`
  const fmtTime = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

  // Aggregate admin data by model for last 7 days
  const adminByModel = (() => {
    if (!adminData?.data) return []
    const cutoff = Date.now() - 7 * 86_400_000
    const map: Record<string, { input: number; output: number }> = {}
    for (const row of adminData.data) {
      if (new Date(row.date).getTime() < cutoff) continue
      if (!map[row.model]) map[row.model] = { input: 0, output: 0 }
      map[row.model].input  += row.input_tokens
      map[row.model].output += row.output_tokens
    }
    return Object.entries(map).map(([model, v]) => ({ model, ...v }))
  })()

  const PERIOD_LABELS: Record<string, string> = { today: 'TODAY', week: '7 DAYS', month: '30 DAYS' }

  return (
    <div className="p-4 flex flex-col gap-6 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <p className="text-xs text-t-muted tracking-widest">API COST MONITORING</p>
        <button onClick={() => refetch()} className="text-[10px] text-t-dim hover:text-t-text px-2 py-1 border border-t-border">
          REFRESH
        </button>
      </div>

      {/* Self-tracked period cards */}
      {loadingStats ? (
        <p className="text-xs text-t-dim animate-pulse">Loading…</p>
      ) : stats ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            {(Object.entries(stats.periods) as [string, UsagePeriod][]).map(([period, p]) => (
              <div key={period} className="border border-t-border p-3 flex flex-col gap-1">
                <p className="text-[10px] text-t-muted tracking-widest">{PERIOD_LABELS[period]}</p>
                <p className="text-lg font-mono text-t-green">{fmtCost(p.cost_usd)}</p>
                <p className="text-[10px] text-t-dim">{fmt(p.input_tokens + p.output_tokens)} tok · {p.calls} calls</p>
              </div>
            ))}
          </div>

          {/* By model breakdown */}
          {stats.by_model.length > 0 && (
            <div className="border border-t-border">
              <p className="text-[10px] text-t-muted tracking-widest px-3 py-2 border-b border-t-border">30-DAY BREAKDOWN (SELF-TRACKED)</p>
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-t-dim border-b border-t-border">
                    <th className="text-left px-3 py-1.5">ENDPOINT</th>
                    <th className="text-left px-3 py-1.5">MODEL</th>
                    <th className="text-right px-3 py-1.5">IN</th>
                    <th className="text-right px-3 py-1.5">OUT</th>
                    <th className="text-right px-3 py-1.5">CALLS</th>
                    <th className="text-right px-3 py-1.5">COST</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_model.map((r, i) => (
                    <tr key={i} className="border-b border-t-border/50 hover:bg-white/2">
                      <td className="px-3 py-1.5 text-t-text">{r.endpoint}</td>
                      <td className="px-3 py-1.5 text-t-dim">{r.model.replace('claude-', '')}</td>
                      <td className="px-3 py-1.5 text-right text-t-dim">{fmt(r.inp)}</td>
                      <td className="px-3 py-1.5 text-right text-t-dim">{fmt(r.out)}</td>
                      <td className="px-3 py-1.5 text-right text-t-dim">{r.calls}</td>
                      <td className="px-3 py-1.5 text-right text-t-green">{fmtCost(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent calls */}
          {stats.recent.length > 0 && (
            <div className="border border-t-border">
              <p className="text-[10px] text-t-muted tracking-widest px-3 py-2 border-b border-t-border">RECENT CALLS</p>
              <div className="max-h-48 overflow-y-auto">
                {stats.recent.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-1.5 border-b border-t-border/40 text-[10px] hover:bg-white/2">
                    <span className="text-t-dim w-28 shrink-0">{fmtTime(r.created_at)}</span>
                    <span className="text-t-text w-16 shrink-0">{r.endpoint}</span>
                    <span className="text-t-dim flex-1 truncate">{r.model.replace('claude-', '')}</span>
                    <span className="text-t-dim shrink-0">{fmt(r.input_tok + r.output_tok)} tok</span>
                    <span className="text-t-green shrink-0">{fmtCost(r.cost_usd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}

      {/* Anthropic Admin API section */}
      <div className="border border-t-border">
        <p className="text-[10px] text-t-muted tracking-widest px-3 py-2 border-b border-t-border">
          ANTHROPIC ADMIN API <span className="text-t-dim ml-2">(official · 1h cache)</span>
        </p>
        {loadingAdmin ? (
          <p className="text-xs text-t-dim animate-pulse px-3 py-3">Fetching from Anthropic…</p>
        ) : adminErr ? (
          <p className="text-[10px] text-t-amber px-3 py-3">
            {String(adminErr).includes('503')
              ? 'Admin API key not configured — add ANTHROPIC_ADMIN_KEY in Settings.'
              : `Error: ${String(adminErr)}`}
          </p>
        ) : adminByModel.length > 0 ? (
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-t-dim border-b border-t-border">
                <th className="text-left px-3 py-1.5">MODEL</th>
                <th className="text-right px-3 py-1.5">INPUT (7D)</th>
                <th className="text-right px-3 py-1.5">OUTPUT (7D)</th>
              </tr>
            </thead>
            <tbody>
              {adminByModel.map((r, i) => (
                <tr key={i} className="border-b border-t-border/50">
                  <td className="px-3 py-1.5 text-t-text">{r.model.replace('claude-', '')}</td>
                  <td className="px-3 py-1.5 text-right text-t-dim">{fmt(r.input)}</td>
                  <td className="px-3 py-1.5 text-right text-t-dim">{fmt(r.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[10px] text-t-dim px-3 py-3">No data available for last 7 days.</p>
        )}
      </div>
    </div>
  )
}


// ── SETTINGS PANEL ────────────────────────────────────────────────────────────
const SETTING_META: Record<string, { label: string; description: string; placeholder: string }> = {
  anthropic_api_key: {
    label:       'ANTHROPIC_API_KEY',
    description: 'Used for AI chat (claude-haiku). Cost-optimized — ~$0.001 per message.',
    placeholder: 'sk-ant-api03-…',
  },
  anthropic_admin_key: {
    label:       'ANTHROPIC_ADMIN_KEY',
    description: 'Admin API Key from Anthropic Console → Settings → Admin API Keys. Used to fetch official billing data.',
    placeholder: 'sk-ant-admin03-…',
  },
  github_token: {
    label:       'GITHUB_TOKEN',
    description: 'Personal Access Token. Scopes needed: repo, workflow, read:user.',
    placeholder: 'ghp_…',
  },
  github_username: {
    label:       'GITHUB_USERNAME',
    description: 'Your GitHub username (used for contribution graph).',
    placeholder: 'needriven',
  },
  github_repo: {
    label:       'GITHUB_REPO',
    description: 'Default repo for Actions CI/CD view.',
    placeholder: 'needriven/rogue-ai',
  },
  slack_webhook: {
    label:       'SLACK_WEBHOOK',
    description: 'Incoming webhook URL for Slack notifications from bots.',
    placeholder: 'https://hooks.slack.com/services/…',
  },
  discord_webhook: {
    label:       'DISCORD_WEBHOOK',
    description: 'Discord webhook URL for bot notifications.',
    placeholder: 'https://discord.com/api/webhooks/…',
  },
}

function SettingsPanel() {
  const qc = useQueryClient()
  const { data: settings = [] } = useQuery<Setting[]>({
    queryKey: ['settings'],
    queryFn:  () => apiFetch('/settings'),
  })

  const [vals, setVals]       = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [saving, setSaving]   = useState<Record<string, boolean>>({})
  const [saved, setSaved]     = useState<Record<string, boolean>>({})

  const save = async (key: string) => {
    if (!vals[key] && vals[key] !== '') return
    setSaving(s => ({ ...s, [key]: true }))
    try {
      await apiFetch(`/settings/${key}`, {
        method: 'PUT', body: JSON.stringify({ value: vals[key] }),
      })
      qc.invalidateQueries({ queryKey: ['settings'] })
      setVals(v => { const n = { ...v }; delete n[key]; return n })
      setSaved(s => ({ ...s, [key]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [key]: false })), 2000)
    } finally {
      setSaving(s => ({ ...s, [key]: false }))
    }
  }

  const inp = 'flex-1 bg-black/40 border border-t-border text-t-text text-xs px-2 py-1.5 focus:outline-none focus:border-t-green font-mono'

  return (
    <div className="p-4 flex flex-col gap-6 overflow-y-auto h-full">
      <p className="text-xs text-t-muted tracking-widest">CONFIGURATION</p>
      <p className="text-xs text-t-dim -mt-4">
        Secrets are stored in the OCI VM database and masked in the UI.
        Values are never sent back to the browser after saving.
        Keys managed via <code className="text-t-amber">.env</code> are read-only in the UI.
      </p>

      {settings.map(s => {
        const meta   = SETTING_META[s.key]
        const edited = vals[s.key] !== undefined
        const isRev  = revealed[s.key]

        return (
          <div key={s.key} className={`border p-3 flex flex-col gap-2 ${s.from_env ? 'border-t-amber/40' : 'border-t-border'}`}>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] w-2 ${s.is_set ? 'text-t-green' : 'text-t-muted'}`}>●</span>
              <p className="text-xs text-t-text tracking-wider">{meta?.label ?? s.key}</p>
              {s.from_env && (
                <span className="ml-auto text-[10px] text-t-amber border border-t-amber/40 px-1" title="Managed via .env — edit on the server">🔒 ENV</span>
              )}
              {!s.from_env && s.is_set && !edited && (
                <span className="ml-auto text-[10px] text-t-green border border-t-green/30 px-1">CONFIGURED</span>
              )}
              {!s.from_env && edited && (
                <span className="ml-auto text-[10px] text-t-amber border border-t-amber/30 px-1">UNSAVED</span>
              )}
            </div>

            {meta?.description && (
              <p className="text-[10px] text-t-muted leading-4">{meta.description}</p>
            )}

            {s.from_env ? (
              <p className="text-[10px] text-t-dim font-mono italic">
                Loaded from environment variable — edit <span className="text-t-amber">.env</span> on the server to change.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type={s.masked && !isRev ? 'password' : 'text'}
                  className={inp}
                  placeholder={s.is_set ? s.display || '(configured)' : meta?.placeholder ?? ''}
                  value={vals[s.key] ?? ''}
                  onChange={e => setVals(v => ({ ...v, [s.key]: e.target.value }))}
                  autoComplete="off"
                />
                {s.masked && (
                  <button
                    onClick={() => setRevealed(r => ({ ...r, [s.key]: !r[s.key] }))}
                    className="text-xs px-2 py-1.5 border border-t-border text-t-dim hover:text-t-text"
                    title={isRev ? 'hide' : 'show'}
                  >
                    {isRev ? '🙈' : '👁'}
                  </button>
                )}
                <button
                  onClick={() => save(s.key)}
                  disabled={saving[s.key] || !edited}
                  className="text-xs px-3 py-1.5 border border-t-green text-t-green hover:bg-t-green-glow
                             disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {saved[s.key] ? '✓ SAVED' : saving[s.key] ? '…' : 'SAVE'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function Ops() {
  const [tab, setTab] = useState<Tab>('bots')

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-t-border shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-t-green text-xs">◈</span>
          <span className="text-xs text-t-green tracking-widest">ORCHESTRATION</span>
          <span className="text-t-muted text-xs">//</span>
          <span className="text-t-dim text-xs">OCI VM</span>
        </div>
        <span className="text-t-muted text-xs">OPS v0.1</span>
      </div>

      {/* tab bar */}
      <div className="flex border-b border-t-border shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs tracking-widest transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-t-green text-t-green'
                : 'border-transparent text-t-dim hover:text-t-text'
            }`}
          >
            <span className="text-sm leading-none">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'bots'     && <BotsPanel />}
        {tab === 'github'   && <GitHubPanel />}
        {tab === 'ai'       && <AiPanel onSwitchToBots={() => setTab('bots')} />}
        {tab === 'usage'    && <UsagePanel />}
        {tab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  )
}
