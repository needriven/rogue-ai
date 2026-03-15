import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DigestRun {
  id:           string
  runId:        string
  status:       'running' | 'done' | 'error'
  abEnabled:    boolean
  primaryModel: string
  altModel:     string | null
  sourceStats:  { hn: number; github: number }
  itemCount:    number
  durationMs:   number
  createdAt:    number
  error?:       string
}

interface DigestItem {
  id:              string
  runId:           string
  source:          'hn' | 'github'
  title:           string
  url:             string
  originalText:    string
  score:           number
  by:              string
  hnId?:           number
  primaryModel:    string
  altModel:        string | null
  aiCategory:      string
  aiImportance:    number
  aiSummary:       string
  aiTags:          string[]
  altAiCategory:   string | null
  altAiImportance: number | null
  altAiSummary:    string | null
  altAiTags:       string[] | null
  feedbackPrimary: 1 | -1 | null
  feedbackAlt:     1 | -1 | null
}

interface ModelStats {
  primaryModel: string
  altModel:     string
  primary:      { good: number; bad: number }
  alt:          { good: number; bad: number }
  preferences:  { primary: number; alt: number; equal: number }
}

interface DigestSettings {
  primaryModel: string
  schedule:     string
  hnCount:      number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  'AI/ML':        'text-cyan-400  border-cyan-800  bg-cyan-950/40',
  'Security':     'text-red-400   border-red-800   bg-red-950/40',
  'Web Dev':      'text-green-400 border-green-800 bg-green-950/40',
  'DevOps':       'text-yellow-400 border-yellow-800 bg-yellow-950/40',
  'Open Source':  'text-purple-400 border-purple-800 bg-purple-950/40',
  'Research':     'text-blue-400  border-blue-800  bg-blue-950/40',
  'Other':        'text-t-dim     border-t-border  bg-t-panel/40',
}

const MODEL_LABEL: Record<string, string> = {
  haiku:  'HAIKU',
  sonnet: 'SONNET',
}

const API = '/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function importanceDots(n: number) {
  return Array.from({ length: 5 }, (_, i) => (
    <span key={i} className={i < n ? 'text-t-green' : 'text-t-muted/30'}>●</span>
  ))
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms * 1000
  if (diff < 60_000)    return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CategoryBadge({ cat }: { cat: string }) {
  const cls = CATEGORY_COLORS[cat] ?? CATEGORY_COLORS['Other']
  return (
    <span className={`text-[10px] px-1.5 py-0.5 border rounded tracking-wider ${cls}`}>
      {cat.toUpperCase()}
    </span>
  )
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className={[
      'text-[10px] px-1.5 py-0.5 border rounded tracking-widest font-semibold',
      source === 'hn'
        ? 'text-orange-400 border-orange-800 bg-orange-950/40'
        : 'text-t-dim border-t-border bg-t-panel/40',
    ].join(' ')}>
      {source === 'hn' ? 'HN' : 'GH'}
    </span>
  )
}

function FeedbackBtn({
  active, value, onClick, children,
}: {
  active: boolean
  value:  1 | -1
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-2 py-0.5 text-xs border rounded transition-colors',
        active && value === 1
          ? 'border-t-green text-t-green bg-t-green/10'
          : active && value === -1
            ? 'border-t-red text-t-red bg-t-red/10'
            : 'border-t-border text-t-muted hover:text-t-dim hover:border-t-border/70',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ── DigestCard ────────────────────────────────────────────────────────────────

function DigestCard({
  item,
  showAlt,
  onFeedback,
}: {
  item:       DigestItem
  showAlt:    boolean
  onFeedback: (itemId: string, type: string, value: number) => void
}) {
  const hasAlt = item.altModel !== null && item.altAiSummary !== null

  return (
    <div className="border border-t-border bg-t-panel/30 p-4 hover:bg-t-panel/50 transition-colors">
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <SourceBadge source={item.source} />
          <CategoryBadge cat={item.aiCategory} />
        </div>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-t-text hover:text-t-green transition-colors leading-snug flex-1"
        >
          {item.title}
        </a>
        <div className="flex gap-0.5 shrink-0 text-[10px]">{importanceDots(item.aiImportance)}</div>
      </div>

      {/* Summary */}
      {!showAlt || !hasAlt ? (
        <p className="text-xs text-t-dim leading-relaxed mb-3 pl-0">
          {item.aiSummary || item.originalText || '—'}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="border-l-2 border-cyan-700 pl-2">
            <p className="text-[10px] text-cyan-500 tracking-widest mb-1">
              MODEL A · {MODEL_LABEL[item.primaryModel] ?? item.primaryModel}
            </p>
            <p className="text-xs text-t-dim leading-relaxed">{item.aiSummary || '—'}</p>
            <div className="flex gap-1.5 mt-2">
              <FeedbackBtn
                active={item.feedbackPrimary === 1}
                value={1}
                onClick={() => onFeedback(item.id, 'primary', item.feedbackPrimary === 1 ? 0 : 1)}
              >
                ▲ Good
              </FeedbackBtn>
              <FeedbackBtn
                active={item.feedbackPrimary === -1}
                value={-1}
                onClick={() => onFeedback(item.id, 'primary', item.feedbackPrimary === -1 ? 0 : -1)}
              >
                ▼ Bad
              </FeedbackBtn>
            </div>
          </div>
          <div className="border-l-2 border-purple-700 pl-2">
            <p className="text-[10px] text-purple-400 tracking-widest mb-1">
              MODEL B · {MODEL_LABEL[item.altModel!] ?? item.altModel}
            </p>
            <p className="text-xs text-t-dim leading-relaxed">{item.altAiSummary || '—'}</p>
            <div className="flex gap-1.5 mt-2">
              <FeedbackBtn
                active={item.feedbackAlt === 1}
                value={1}
                onClick={() => onFeedback(item.id, 'alt', item.feedbackAlt === 1 ? 0 : 1)}
              >
                ▲ Good
              </FeedbackBtn>
              <FeedbackBtn
                active={item.feedbackAlt === -1}
                value={-1}
                onClick={() => onFeedback(item.id, 'alt', item.feedbackAlt === -1 ? 0 : -1)}
              >
                ▼ Bad
              </FeedbackBtn>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-3 flex-wrap">
        {item.aiTags.map(tag => (
          <span key={tag} className="text-[10px] text-t-muted">#{tag}</span>
        ))}
        {item.score > 0 && (
          <span className="text-[10px] text-t-muted ml-auto">
            {item.score} pts · {item.by}
          </span>
        )}
      </div>
    </div>
  )
}

// ── ModelStats panel ──────────────────────────────────────────────────────────

function ModelStatsPanel({ stats }: { stats: ModelStats }) {
  const totalPref = stats.preferences.primary + stats.preferences.alt + stats.preferences.equal
  const primScore = stats.primary.good - stats.primary.bad
  const altScore  = stats.alt.good  - stats.alt.bad

  function bar(val: number, total: number, color: string) {
    const pct = total > 0 ? Math.round((val / total) * 100) : 0
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-t-border/30 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] text-t-dim w-8 text-right">{pct}%</span>
      </div>
    )
  }

  return (
    <div className="border border-t-border bg-t-panel/30 p-4 space-y-4">
      <p className="text-[10px] text-t-muted tracking-widest">MODEL COMPARISON</p>

      <div className="grid grid-cols-2 gap-4">
        {/* Primary */}
        <div>
          <p className="text-xs text-cyan-400 tracking-widest mb-2">
            {MODEL_LABEL[stats.primaryModel] ?? stats.primaryModel}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px] text-t-dim">
              <span>▲ {stats.primary.good}</span>
              <span>▼ {stats.primary.bad}</span>
              <span className={primScore >= 0 ? 'text-t-green' : 'text-t-red'}>
                {primScore >= 0 ? '+' : ''}{primScore}
              </span>
            </div>
            {bar(stats.primary.good, stats.primary.good + stats.primary.bad, 'bg-t-green')}
          </div>
        </div>

        {/* Alt */}
        <div>
          <p className="text-xs text-purple-400 tracking-widest mb-2">
            {MODEL_LABEL[stats.altModel] ?? stats.altModel}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px] text-t-dim">
              <span>▲ {stats.alt.good}</span>
              <span>▼ {stats.alt.bad}</span>
              <span className={altScore >= 0 ? 'text-t-green' : 'text-t-red'}>
                {altScore >= 0 ? '+' : ''}{altScore}
              </span>
            </div>
            {bar(stats.alt.good, stats.alt.good + stats.alt.bad, 'bg-purple-500')}
          </div>
        </div>
      </div>

      {/* Preferences */}
      {totalPref > 0 && (
        <div>
          <p className="text-[10px] text-t-muted tracking-widest mb-2">BLIND PREFERENCE ({totalPref} rated)</p>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px]">
              <span className="w-14 text-cyan-400">{MODEL_LABEL[stats.primaryModel]}</span>
              {bar(stats.preferences.primary, totalPref, 'bg-cyan-500')}
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="w-14 text-purple-400">{MODEL_LABEL[stats.altModel]}</span>
              {bar(stats.preferences.alt, totalPref, 'bg-purple-500')}
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="w-14 text-t-muted">EQUAL</span>
              {bar(stats.preferences.equal, totalPref, 'bg-t-dim')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({
  settings,
  onSave,
}: {
  settings: DigestSettings
  onSave:   (patch: Partial<DigestSettings>) => Promise<void>
}) {
  const [model,    setModel]    = useState(settings.primaryModel)
  const [schedule, setSchedule] = useState(settings.schedule)
  const [hnCount,  setHnCount]  = useState(settings.hnCount)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave({ primary_model: model, schedule, hn_count: hnCount } as never)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="border border-t-border bg-t-panel/30 p-4 space-y-4">
      <p className="text-[10px] text-t-muted tracking-widest">DIGEST SETTINGS</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-[10px] text-t-muted tracking-widest block">PRIMARY MODEL</span>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="w-full bg-t-bg border border-t-border text-t-text text-xs px-2 py-1.5 focus:outline-none focus:border-t-green"
          >
            <option value="haiku">claude-haiku  (fast · cheap)</option>
            <option value="sonnet">claude-sonnet  (smart · accurate)</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-t-muted tracking-widest block">SCHEDULE (cron UTC)</span>
          <input
            value={schedule}
            onChange={e => setSchedule(e.target.value)}
            placeholder="0 6 * * *"
            className="w-full bg-t-bg border border-t-border text-t-text text-xs px-2 py-1.5 focus:outline-none focus:border-t-green font-mono"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-t-muted tracking-widest block">HN STORIES (5–50)</span>
          <input
            type="number"
            min={5}
            max={50}
            value={hnCount}
            onChange={e => setHnCount(Number(e.target.value))}
            className="w-full bg-t-bg border border-t-border text-t-text text-xs px-2 py-1.5 focus:outline-none focus:border-t-green"
          />
        </label>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-4 py-1.5 border border-t-green text-t-green hover:bg-t-green/10 transition-colors disabled:opacity-50"
      >
        {saving ? 'SAVING...' : saved ? '✓ SAVED' : 'SAVE'}
      </button>
    </div>
  )
}

// ── Main Digest page ──────────────────────────────────────────────────────────

type Tab = 'digest' | 'compare' | 'stats' | 'settings'

export default function Digest() {
  const [activeTab,  setActiveTab]  = useState<Tab>('digest')
  const [run,        setRun]        = useState<DigestRun | null>(null)
  const [items,      setItems]      = useState<DigestItem[]>([])
  const [stats,      setStats]      = useState<ModelStats | null>(null)
  const [settings,   setSettings]   = useState<DigestSettings | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [running,    setRunning]    = useState(false)
  const [abRunning,  setAbRunning]  = useState(false)
  const [filterCat,  setFilterCat]  = useState<string>('ALL')
  const [filterSrc,  setFilterSrc]  = useState<string>('ALL')

  // ── Fetchers ───────────────────────────────────────────────────────────────

  const fetchLatest = useCallback(async () => {
    try {
      const r = await fetch(`${API}/digest/latest`)
      const d = await r.json()
      setRun(d.run)
      setItems(d.items ?? [])
      if (d.running) setRunning(true)
      else           setRunning(false)
    } catch { /* ignore */ }
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch(`${API}/digest/model-stats`)
      setStats(await r.json())
    } catch { /* ignore */ }
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const r = await fetch(`${API}/digest/settings`)
      setSettings(await r.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    Promise.all([fetchLatest(), fetchStats(), fetchSettings()])
      .finally(() => setLoading(false))
  }, [fetchLatest, fetchStats, fetchSettings])

  // Poll while a run is in progress
  useEffect(() => {
    if (!running) return
    const id = setInterval(fetchLatest, 4000)
    return () => clearInterval(id)
  }, [running, fetchLatest])

  // ── Actions ────────────────────────────────────────────────────────────────

  async function triggerRun(abEnabled: boolean) {
    if (abEnabled) setAbRunning(true)
    else           setRunning(true)
    try {
      await fetch(`${API}/digest/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ab_enabled: abEnabled }),
      })
      setRunning(true)
      setAbRunning(false)
    } catch {
      setRunning(false)
      setAbRunning(false)
    }
  }

  async function handleFeedback(itemId: string, type: string, value: number) {
    await fetch(`${API}/digest/feedback`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ item_id: itemId, feedback_type: type, value }),
    })
    // Optimistic update
    setItems(prev => prev.map(it => {
      if (it.id !== itemId) return it
      if (type === 'primary') return { ...it, feedbackPrimary: value as 1 | -1 | null }
      if (type === 'alt')     return { ...it, feedbackAlt:     value as 1 | -1 | null }
      return it
    }))
    fetchStats()
  }

  async function saveSettings(patch: Partial<DigestSettings>) {
    await fetch(`${API}/digest/settings`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    fetchSettings()
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const categories = ['ALL', ...Array.from(new Set(items.map(i => i.aiCategory))).sort()]
  const showAlt    = activeTab === 'compare'

  const filteredItems = items.filter(it => {
    if (filterCat !== 'ALL' && it.aiCategory !== filterCat) return false
    if (filterSrc !== 'ALL' && it.source    !== filterSrc)  return false
    return true
  })

  const abItems = items.filter(it => it.altModel !== null && it.altAiSummary !== null)

  // ── Render ─────────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string }[] = [
    { id: 'digest',   label: 'DIGEST'   },
    { id: 'compare',  label: `A/B COMPARE${abItems.length > 0 ? ` (${abItems.length})` : ''}` },
    { id: 'stats',    label: 'MODEL STATS' },
    { id: 'settings', label: 'SETTINGS' },
  ]

  return (
    <div className="h-full flex flex-col bg-t-bg font-mono">

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-t-border px-5 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <h1 className="text-xs text-t-green tracking-[0.2em] font-semibold">✦ DIGEST ENGINE</h1>
          {run && (
            <p className="text-[10px] text-t-muted mt-0.5">
              {run.sourceStats
                ? `HN ${run.sourceStats.hn} · GH ${run.sourceStats.github} · `
                : ''}
              {run.itemCount} items ·{' '}
              {MODEL_LABEL[run.primaryModel] ?? run.primaryModel}
              {run.abEnabled && run.altModel ? ` + ${MODEL_LABEL[run.altModel] ?? run.altModel}` : ''}
              {' '}· {relativeTime(run.createdAt)}
            </p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <span className="text-xs text-t-amber animate-pulse tracking-widest">
              ◌ PROCESSING...
            </span>
          ) : (
            <>
              <button
                onClick={() => triggerRun(false)}
                className="text-xs px-3 py-1.5 border border-t-green text-t-green hover:bg-t-green/10 transition-colors"
              >
                ▶ RUN DIGEST
              </button>
              <button
                onClick={() => triggerRun(true)}
                disabled={abRunning}
                className="text-xs px-3 py-1.5 border border-purple-600 text-purple-400 hover:bg-purple-900/20 transition-colors disabled:opacity-50"
              >
                {abRunning ? '◌ ...' : '⚡ RUN A/B'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex border-b border-t-border">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={[
              'px-4 py-2.5 text-[10px] tracking-widest border-b-2 transition-colors',
              activeTab === t.id
                ? 'border-t-green text-t-green'
                : 'border-transparent text-t-muted hover:text-t-dim',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-5">

        {loading && (
          <p className="text-t-muted text-xs animate-pulse">LOADING...</p>
        )}

        {/* DIGEST / COMPARE tabs share the item list */}
        {(activeTab === 'digest' || activeTab === 'compare') && !loading && (
          <>
            {/* Filters */}
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <div className="flex gap-1.5 flex-wrap">
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setFilterCat(cat)}
                    className={[
                      'text-[10px] px-2 py-0.5 border rounded tracking-wider transition-colors',
                      filterCat === cat
                        ? 'border-t-green text-t-green bg-t-green/10'
                        : 'border-t-border text-t-muted hover:text-t-dim',
                    ].join(' ')}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 ml-auto">
                {['ALL', 'hn', 'github'].map(src => (
                  <button
                    key={src}
                    onClick={() => setFilterSrc(src)}
                    className={[
                      'text-[10px] px-2 py-0.5 border rounded tracking-wider transition-colors',
                      filterSrc === src
                        ? 'border-t-green text-t-green bg-t-green/10'
                        : 'border-t-border text-t-muted hover:text-t-dim',
                    ].join(' ')}
                  >
                    {src.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Empty state */}
            {!running && filteredItems.length === 0 && (
              <div className="text-center py-20">
                <p className="text-t-muted text-xs mb-2">No digest yet.</p>
                <p className="text-[10px] text-t-muted/60">
                  Press <span className="text-t-green">▶ RUN DIGEST</span> to fetch &amp; analyse articles.
                </p>
              </div>
            )}

            {/* Items */}
            <div className="space-y-2">
              {(activeTab === 'compare' ? filteredItems.filter(i => i.altModel !== null && i.altAiSummary !== null) : filteredItems)
                .map(item => (
                  <DigestCard
                    key={item.id}
                    item={item}
                    showAlt={showAlt}
                    onFeedback={handleFeedback}
                  />
                ))
              }
            </div>

            {activeTab === 'compare' && abItems.length === 0 && !loading && (
              <div className="text-center py-20">
                <p className="text-t-muted text-xs mb-2">No A/B run yet.</p>
                <p className="text-[10px] text-t-muted/60">
                  Press <span className="text-purple-400">⚡ RUN A/B</span> to compare Haiku vs Sonnet side-by-side.
                </p>
              </div>
            )}
          </>
        )}

        {/* MODEL STATS */}
        {activeTab === 'stats' && !loading && (
          <div className="max-w-lg space-y-4">
            {stats ? (
              <ModelStatsPanel stats={stats} />
            ) : (
              <p className="text-t-muted text-xs">No feedback recorded yet. Rate summaries to build stats.</p>
            )}
            <p className="text-[10px] text-t-muted/60">
              Run with <span className="text-purple-400">⚡ RUN A/B</span> to generate side-by-side comparisons,
              then rate them in the A/B COMPARE tab to populate this chart.
            </p>
          </div>
        )}

        {/* SETTINGS */}
        {activeTab === 'settings' && !loading && settings && (
          <div className="max-w-lg">
            <SettingsPanel settings={settings} onSave={saveSettings} />
          </div>
        )}
      </div>
    </div>
  )
}
