import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ── Types ─────────────────────────────────────────────────────────────────────
interface FeedItem {
  id:          number
  title:       string
  link:        string
  summary:     string
  published:   number | null
  source_name: string
  tag:         string
  source_id:   number
}

interface FeedSource {
  id:           number
  url:          string
  name:         string
  tag:          string
  last_fetched: number | null
  item_count:   number
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts)
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
  if (res.status === 204) return undefined as T
  return res.json()
}

// ── Read tracking (localStorage) ─────────────────────────────────────────────
const READ_KEY = 'feed-read-ids'
const MAX_READ = 2000  // cap stored IDs to avoid unbounded growth

function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}

function saveReadIds(ids: Set<string>): void {
  // Keep only the most recent MAX_READ IDs
  const arr = [...ids].slice(-MAX_READ)
  localStorage.setItem(READ_KEY, JSON.stringify(arr))
}

// ── Tag colors ────────────────────────────────────────────────────────────────
const TAG_COLOR: Record<string, string> = {
  ai:       'text-purple-400 border-purple-800',
  security: 'text-red-400   border-red-900',
  news:     'text-t-amber   border-amber-900',
  devops:   'text-blue-400  border-blue-900',
  general:  'text-t-dim     border-t-border',
}
function tagColor(tag: string): string {
  return TAG_COLOR[tag] ?? 'text-t-dim border-t-border'
}

// ── Add source form ───────────────────────────────────────────────────────────
function AddSourceForm({ onAdded }: { onAdded: () => void }) {
  const [url,  setUrl]  = useState('')
  const [tag,  setTag]  = useState('general')
  const [name, setName] = useState('')
  const [err,  setErr]  = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: () => apiFetch<FeedSource>('/api/feed/sources', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: url.trim(), tag: tag.trim() || 'general', name: name.trim() }),
    }),
    onSuccess: () => {
      setUrl(''); setTag('general'); setName(''); setErr(null)
      onAdded()
    },
    onError: (e: Error) => setErr(e.message),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setErr(null)
    mut.mutate()
  }

  return (
    <form onSubmit={submit} className="border border-t-border bg-t-panel/40 p-3 space-y-2">
      <p className="text-xs text-t-muted tracking-widest">// ADD SOURCE</p>
      <div className="flex gap-2 flex-wrap">
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com/feed.xml"
          className="flex-1 min-w-48 text-xs bg-t-surface border border-t-border text-t-text
                     px-2 py-1.5 outline-none focus:border-t-green placeholder:text-t-muted/40"
        />
        <input
          value={tag}
          onChange={e => setTag(e.target.value)}
          placeholder="tag"
          className="w-24 text-xs bg-t-surface border border-t-border text-t-text
                     px-2 py-1.5 outline-none focus:border-t-green placeholder:text-t-muted/40"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="name (optional)"
          className="w-36 text-xs bg-t-surface border border-t-border text-t-text
                     px-2 py-1.5 outline-none focus:border-t-green placeholder:text-t-muted/40"
        />
        <button
          type="submit"
          disabled={mut.isPending || !url.trim()}
          className="text-xs px-3 py-1.5 border border-t-green text-t-green
                     hover:bg-t-green hover:text-black transition-all duration-150
                     disabled:opacity-40 disabled:cursor-not-allowed tracking-wider"
        >
          {mut.isPending ? 'ADDING...' : '+ ADD'}
        </button>
      </div>
      {err && <p className="text-xs text-red-400">Error: {err}</p>}
      <p className="text-xs text-t-muted">
        Or use the terminal: <code className="text-t-dim">rss add &lt;url&gt; --tag &lt;tag&gt;</code>
      </p>
    </form>
  )
}

// ── Source list ───────────────────────────────────────────────────────────────
function SourceList({ sources, onRemove, onRefresh }: {
  sources:   FeedSource[]
  onRemove:  (id: number) => void
  onRefresh: (id: number) => void
}) {
  if (!sources.length) return null
  return (
    <div className="border border-t-border bg-t-panel/40">
      <p className="text-xs text-t-muted tracking-widest px-3 pt-2 pb-1">// SOURCES</p>
      <div className="divide-y divide-t-border/40">
        {sources.map(s => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2 text-xs">
            <span className={`border px-1 py-0.5 text-xs tracking-wider ${tagColor(s.tag)}`}>
              {s.tag}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-t-text truncate">{s.name}</p>
              <p className="text-t-muted truncate">{s.url}</p>
            </div>
            <span className="text-t-muted shrink-0">
              {s.item_count} items
              {s.last_fetched ? ` · ${timeAgo(s.last_fetched)}` : ' · never'}
            </span>
            <button onClick={() => onRefresh(s.id)} className="shrink-0 text-t-dim hover:text-t-green transition-colors px-1" title="Refresh">↻</button>
            <button onClick={() => onRemove(s.id)} className="shrink-0 text-red-800 hover:text-red-400 transition-colors px-1" title="Remove">✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Feed item card ────────────────────────────────────────────────────────────
function FeedCard({ item, isRead, onRead }: {
  item:   FeedItem
  isRead: boolean
  onRead: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const pub = item.published ? timeAgo(item.published) : ''

  const handleLinkClick = () => onRead(item.id)
  const handleExpand    = () => {
    setExpanded(v => !v)
    if (!isRead) onRead(item.id)
  }

  return (
    <div className={[
      'border border-t-border/50 hover:border-t-border transition-colors',
      isRead ? 'bg-t-panel/10 opacity-60' : 'bg-t-panel/20 hover:bg-t-panel/40',
    ].join(' ')}>
      <div className="p-3">
        {/* Header row */}
        <div className="flex items-start gap-2 mb-1">
          {!isRead && (
            <span className="w-1.5 h-1.5 rounded-full bg-t-green mt-1.5 shrink-0 animate-glow-pulse" />
          )}
          <span className={`shrink-0 border text-xs px-1 py-0.5 tracking-wider ${tagColor(item.tag)}`}>
            {item.tag}
          </span>
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleLinkClick}
            className={[
              'flex-1 text-xs transition-colors leading-relaxed line-clamp-2',
              isRead ? 'text-t-dim hover:text-t-muted' : 'text-t-text hover:text-t-green',
            ].join(' ')}
          >
            {item.title}
          </a>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-xs text-t-muted mt-1.5 pl-3.5">
          <span className="truncate">{item.source_name}</span>
          {pub && <><span>·</span><span className="shrink-0">{pub}</span></>}
          {item.summary && (
            <>
              <span>·</span>
              <button onClick={handleExpand} className="shrink-0 hover:text-t-dim transition-colors">
                {expanded ? '▲ less' : '▼ more'}
              </button>
            </>
          )}
          {!isRead && (
            <button
              onClick={() => onRead(item.id)}
              className="shrink-0 ml-auto hover:text-t-dim transition-colors"
              title="Mark as read"
            >
              ✓
            </button>
          )}
        </div>

        {/* Expandable summary */}
        {expanded && item.summary && (
          <p className="mt-2 text-xs text-t-dim leading-relaxed border-t border-t-border/30 pt-2 pl-3.5">
            {item.summary.replace(/<[^>]+>/g, '').slice(0, 400)}
            {item.summary.length > 400 ? '…' : ''}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Feed page ─────────────────────────────────────────────────────────────────
export default function Feed() {
  const qc = useQueryClient()
  const [tag,         setTag]         = useState<string | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [readIds,     setReadIds]     = useState<Set<string>>(loadReadIds)

  const { data: sources = [], refetch: refetchSources } = useQuery<FeedSource[]>({
    queryKey: ['feed-sources'],
    queryFn:  () => apiFetch('/api/feed/sources'),
    staleTime: 60_000,
  })

  const { data: items = [], isFetching } = useQuery<FeedItem[]>({
    queryKey: ['feed-items', tag],
    queryFn:  () => apiFetch(`/api/feed${tag ? `?tag=${encodeURIComponent(tag)}` : '?limit=100'}`),
    staleTime:       60_000,
    refetchInterval: 5 * 60_000,
  })

  // Persist readIds on change
  useEffect(() => { saveReadIds(readIds) }, [readIds])

  const markRead = useCallback((id: number) => {
    setReadIds(prev => {
      const next = new Set(prev)
      next.add(String(id))
      return next
    })
  }, [])

  const markAllRead = useCallback(() => {
    setReadIds(prev => {
      const next = new Set(prev)
      items.forEach(i => next.add(String(i.id)))
      return next
    })
  }, [items])

  const allTags   = [...new Set(sources.map(s => s.tag))].sort()
  const unreadCnt = items.filter(i => !readIds.has(String(i.id))).length

  const removeMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/feed/sources/${id}`, { method: 'DELETE' }),
    onSuccess:  () => { refetchSources(); qc.invalidateQueries({ queryKey: ['feed-items'] }) },
  })

  const refreshMut = useMutation({
    mutationFn: (id: number | null) =>
      apiFetch(id ? `/api/feed/refresh/${id}` : '/api/feed/refresh', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feed-items'] }),
  })

  const handleAdded = useCallback(() => {
    refetchSources()
    qc.invalidateQueries({ queryKey: ['feed-items'] })
  }, [refetchSources, qc])

  return (
    <div className="h-full flex flex-col animate-fade-in">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-t-border bg-t-panel/60 px-5 py-2.5
                      flex items-center gap-4 flex-wrap">
        <span className="text-xs text-t-green font-semibold tracking-widest">FEED</span>
        <span className="text-t-muted text-xs">//</span>

        {/* Tag filters */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setTag(null)}
            className={[
              'text-xs px-2 py-0.5 border tracking-wider transition-colors',
              tag === null
                ? 'border-t-green text-t-green bg-t-green/10'
                : 'border-t-border/40 text-t-muted hover:text-t-dim',
            ].join(' ')}
          >
            ALL
          </button>
          {allTags.map(t => (
            <button
              key={t}
              onClick={() => setTag(t)}
              className={[
                'text-xs px-2 py-0.5 border tracking-wider transition-colors',
                tag === t
                  ? 'border-t-green text-t-green bg-t-green/10'
                  : 'border-t-border/40 text-t-muted hover:text-t-dim',
              ].join(' ')}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {isFetching && <span className="text-xs text-t-muted animate-pulse">SYNCING...</span>}

          {/* Unread badge */}
          {unreadCnt > 0 && (
            <span className="text-xs text-t-green tabular-nums">
              {unreadCnt} UNREAD
            </span>
          )}
          {unreadCnt > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs px-2 py-1 border border-t-border/40 text-t-dim
                         hover:border-t-green hover:text-t-green transition-colors tracking-wider"
            >
              MARK ALL READ
            </button>
          )}

          <span className="text-xs text-t-muted">{items.length} items</span>
          <button
            onClick={() => refreshMut.mutate(null)}
            disabled={refreshMut.isPending}
            className="text-xs px-2 py-1 border border-t-border/40 text-t-dim
                       hover:border-t-green hover:text-t-green transition-colors tracking-wider"
          >
            {refreshMut.isPending ? '...' : '↻ REFRESH'}
          </button>
          <button
            onClick={() => setShowSources(v => !v)}
            className={[
              'text-xs px-2 py-1 border tracking-wider transition-colors',
              showSources
                ? 'border-t-amber/60 text-t-amber'
                : 'border-t-border/40 text-t-dim hover:border-t-amber/40 hover:text-t-amber',
            ].join(' ')}
          >
            ⚙ SOURCES ({sources.length})
          </button>
        </div>
      </div>

      {/* ── Source management panel ──────────────────────────────────── */}
      {showSources && (
        <div className="shrink-0 border-b border-t-border bg-t-bg px-5 py-3 space-y-3">
          <AddSourceForm onAdded={handleAdded} />
          <SourceList
            sources={sources}
            onRemove={id => removeMut.mutate(id)}
            onRefresh={id => refreshMut.mutate(id)}
          />
        </div>
      )}

      {/* ── Feed items ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {items.length === 0 && !isFetching && (
          <div className="text-center py-16 text-t-muted text-xs space-y-2">
            <p>No feed items yet.</p>
            <p className="text-t-dim">
              Add sources via the SOURCES panel above,<br/>
              or use the terminal: <code className="text-t-text">rss add &lt;url&gt;</code>
            </p>
          </div>
        )}
        <div className="space-y-1.5 max-w-3xl">
          {items.map(item => (
            <FeedCard
              key={item.id}
              item={item}
              isRead={readIds.has(String(item.id))}
              onRead={markRead}
            />
          ))}
        </div>
      </div>

    </div>
  )
}
