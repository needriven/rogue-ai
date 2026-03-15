import { useState, useEffect, useCallback, useRef } from 'react'

const API      = '/api/planner'
const SESSION  = () => localStorage.getItem('rogue-ai-session') ?? ''
const ALERT_LS = 'planner-alert-count'

// ── Types ──────────────────────────────────────────────────────────────────────
interface Memo {
  id:         string
  title:      string
  content:    string
  imageUrl:   string
  activateAt: number
  expiresAt?: number
  isDone:     boolean
  createdAt:  number
}

interface Schedule {
  id:          string
  label:       string
  type:        'recurring' | 'onetime'
  cron:        string
  scheduledAt?: number
  note:        string
  isActive:    boolean
  isDone:      boolean
  createdAt:   number
}

interface Alert {
  type:         'overdue_schedule' | 'expiring_memo'
  id:           string
  label:        string
  scheduledAt?: number
  expiresAt?:   number
  note?:        string
}

interface FiredNotification {
  id:      string
  label:   string
  firedAt: number
  schedId: string
}

type PlannerTab = 'memos' | 'scheduler' | 'alerts'

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function countdown(ts: number): string {
  const diff = ts - Date.now() / 1000
  if (diff <= 0) return 'EXPIRED'
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0)  return `${h}h ${m}m`
  return `${m}m ${Math.floor(diff % 60)}s`
}

function fromLocalInput(s: string): number {
  return s ? new Date(s).getTime() / 1000 : 0
}

function cronDesc(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hr, dom, mon, dow] = parts
  if (min === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour'
  if (min === '0' && dom === '*' && mon === '*' && dow === '*') return `Daily at ${hr}:00`
  if (dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    return `Weekly (${dow.split(',').map(d => days[+d] ?? d).join(', ')}) at ${hr}:${min}`
  }
  return cron
}

// ── Badge store (updates localStorage for Root nav) ───────────────────────────
function setAlertBadge(n: number) {
  localStorage.setItem(ALERT_LS, String(n))
  window.dispatchEvent(new Event('planner-alert'))
}

// ── Notification helpers ───────────────────────────────────────────────────────
async function requestNotifPerm(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  const p = await Notification.requestPermission()
  return p === 'granted'
}

function sendNotif(title: string, body: string) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' })
  }
}

// ── Section wrapper ────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-t-border bg-t-panel/40 p-4 space-y-3">
      <h3 className="text-[10px] font-semibold text-t-green tracking-widest">{title}</h3>
      {children}
    </div>
  )
}

// ── Input ──────────────────────────────────────────────────────────────────────
function Input({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <div className="space-y-1">
      {label && <label className="text-[10px] text-t-dim tracking-widest">{label}</label>}
      <input
        {...props}
        className="w-full bg-t-bg border border-t-border text-t-text text-xs px-2 py-1.5
                   focus:outline-none focus:border-t-green placeholder:text-t-muted"
      />
    </div>
  )
}

function Textarea({ label, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <div className="space-y-1">
      {label && <label className="text-[10px] text-t-dim tracking-widest">{label}</label>}
      <textarea
        {...props}
        rows={3}
        className="w-full bg-t-bg border border-t-border text-t-text text-xs px-2 py-1.5
                   focus:outline-none focus:border-t-green placeholder:text-t-muted resize-none"
      />
    </div>
  )
}

function Btn({ children, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'danger' | 'success' | 'ghost'
}) {
  const styles = {
    default: 'border-t-border text-t-dim hover:border-t-green hover:text-t-green',
    danger:  'border-t-red/60 text-t-red hover:border-t-red',
    success: 'border-t-green text-t-green hover:bg-t-green/10',
    ghost:   'border-transparent text-t-muted hover:text-t-dim',
  }
  return (
    <button
      {...props}
      className={`text-[10px] tracking-widest border px-2.5 py-1 transition-colors ${styles[variant]} disabled:opacity-40`}
    >
      {children}
    </button>
  )
}

// ── Image Upload ───────────────────────────────────────────────────────────────
function ImageUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const handle = async (file: File) => {
    if (!file.type.startsWith('image/')) { setError('Image files only'); return }
    if (file.size > 5 * 1024 * 1024) { setError('Max 5 MB'); return }
    setError('')
    setPreview(URL.createObjectURL(file))
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('session_id', SESSION())
      fd.append('file', file)
      const res = await fetch(`${API}/upload`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await res.text())
      const { url } = await res.json() as { url: string }
      onUploaded(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="text-[10px] text-t-dim tracking-widest">IMAGE (optional, max 5 MB)</label>
      <div
        className="border border-dashed border-t-border p-3 text-center cursor-pointer
                   hover:border-t-green transition-colors"
        onClick={() => inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handle(f) }}
      >
        {preview ? (
          <img src={preview} alt="preview" className="max-h-24 mx-auto object-contain" />
        ) : (
          <span className="text-xs text-t-muted">
            {uploading ? 'UPLOADING...' : 'DROP / CLICK TO ATTACH'}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handle(f) }}
      />
      {error && <p className="text-[10px] text-t-red">{error}</p>}
    </div>
  )
}

// ── Memo Card ─────────────────────────────────────────────────────────────────
function toLocalInput(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function MemoCard({ memo, onToggle, onDelete, onUpdate }: {
  memo:     Memo
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: object) => Promise<void>
}) {
  const [expanded,  setExpanded]  = useState(false)
  const [editing,   setEditing]   = useState(false)
  const [eTitle,    setETitle]    = useState(memo.title)
  const [eContent,  setEContent]  = useState(memo.content)
  const [eActivate, setEActivate] = useState(() => toLocalInput(memo.activateAt))
  const [eExpires,  setEExpires]  = useState(() => toLocalInput(memo.expiresAt ?? 0))
  const [saving,    setSaving]    = useState(false)

  const now    = Date.now() / 1000
  const active = memo.activateAt <= now
  const expSec = memo.expiresAt ?? 0
  const expiring = expSec > 0 && expSec - now < 3600
  const expired  = expSec > 0 && expSec <= now

  let statusColor = 'text-t-dim'
  let statusLabel = 'PENDING'
  if (memo.isDone) { statusColor = 'text-t-muted'; statusLabel = 'DONE' }
  else if (expired) { statusColor = 'text-t-red'; statusLabel = 'EXPIRED' }
  else if (expiring) { statusColor = 'text-t-amber'; statusLabel = `EXPIRES ${countdown(expSec)}` }
  else if (active) { statusColor = 'text-t-green'; statusLabel = 'ACTIVE' }

  const saveEdit = async () => {
    setSaving(true)
    await onUpdate(memo.id, {
      title:       eTitle.trim() || memo.title,
      content:     eContent,
      activate_at: fromLocalInput(eActivate),
      expires_at:  fromLocalInput(eExpires),
    })
    setSaving(false)
    setEditing(false)
  }

  return (
    <div className={`border border-t-border p-3 space-y-2 transition-opacity ${memo.isDone ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2">
        {/* Checkbox */}
        <button
          onClick={() => onToggle(memo.id)}
          className={`w-4 h-4 mt-0.5 shrink-0 border flex items-center justify-center transition-colors
            ${memo.isDone ? 'border-t-green bg-t-green/20 text-t-green' : 'border-t-border hover:border-t-green'}`}
        >
          {memo.isDone && <span className="text-[10px] leading-none">✓</span>}
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <Input
                value={eTitle}
                onChange={e => setETitle(e.target.value)}
                placeholder="Title..."
              />
              <Textarea
                value={eContent}
                onChange={e => setEContent(e.target.value)}
                placeholder="Content..."
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="ACTIVATE AT"
                  type="datetime-local"
                  value={eActivate}
                  onChange={e => setEActivate(e.target.value)}
                />
                <Input
                  label="EXPIRES AT"
                  type="datetime-local"
                  value={eExpires}
                  onChange={e => setEExpires(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Btn variant="success" onClick={saveEdit} disabled={saving}>
                  {saving ? 'SAVING...' : 'SAVE'}
                </Btn>
                <Btn onClick={() => setEditing(false)}>CANCEL</Btn>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-semibold ${memo.isDone ? 'line-through text-t-muted' : 'text-t-text'}`}>
                  {memo.title}
                </span>
                <span className={`text-[10px] ${statusColor}`}>{statusLabel}</span>
              </div>
              {memo.content && (
                <p className={`text-[11px] mt-1 ${expanded ? '' : 'line-clamp-2'} text-t-dim`}>
                  {memo.content}
                </p>
              )}
              {memo.content && memo.content.length > 120 && (
                <button onClick={() => setExpanded(e => !e)} className="text-[10px] text-t-muted hover:text-t-dim">
                  {expanded ? '▲ COLLAPSE' : '▼ EXPAND'}
                </button>
              )}
              {memo.imageUrl && (
                <img
                  src={memo.imageUrl}
                  alt=""
                  className="mt-2 max-h-32 rounded object-contain border border-t-border"
                />
              )}
              <div className="flex gap-3 mt-1.5 text-[10px] text-t-muted flex-wrap">
                {expSec > 0 && !expired && <span>EXP: {fmt(expSec)}</span>}
                {memo.activateAt > now && <span>ACTIVE: {fmt(memo.activateAt)}</span>}
              </div>
            </>
          )}
        </div>

        {!editing && (
          <div className="flex gap-1 shrink-0">
            <Btn onClick={() => setEditing(true)}>✎</Btn>
            <Btn variant="danger" onClick={() => onDelete(memo.id)}>✕</Btn>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Schedule Row ──────────────────────────────────────────────────────────────
function ScheduleRow({ sched, onToggle, onDone, onDelete, onUpdate }: {
  sched:    Schedule
  onToggle: (id: string) => void
  onDone:   (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: object) => Promise<void>
}) {
  const [editing,  setEditing]  = useState(false)
  const [eLabel,   setELabel]   = useState(sched.label)
  const [eCron,    setECron]    = useState(sched.cron)
  const [eAt,      setEAt]      = useState(() => toLocalInput(sched.scheduledAt ?? 0))
  const [eNote,    setENote]    = useState(sched.note)
  const [saving,   setSaving]   = useState(false)

  const now     = Date.now() / 1000
  const overdue = sched.type === 'onetime' && !sched.isDone && sched.isActive
                  && (sched.scheduledAt ?? 0) < now

  const saveEdit = async () => {
    setSaving(true)
    const patch: Record<string, unknown> = {
      label: eLabel.trim() || sched.label,
      note:  eNote,
    }
    if (sched.type === 'recurring') patch.cron         = eCron
    else                            patch.scheduled_at = fromLocalInput(eAt)
    await onUpdate(sched.id, patch)
    setSaving(false)
    setEditing(false)
  }

  return (
    <div className={`border border-t-border/60 p-3 text-xs
                     ${sched.isDone ? 'opacity-40' : ''} ${overdue ? 'border-t-red/60' : ''}`}>
      {editing ? (
        <div className="space-y-2">
          <Input value={eLabel} onChange={e => setELabel(e.target.value)} placeholder="Label..." />
          {sched.type === 'recurring' ? (
            <div className="space-y-1">
              <Input
                label="CRON"
                value={eCron}
                onChange={e => setECron(e.target.value)}
                placeholder="0 9 * * *"
              />
              {eCron.trim().split(/\s+/).length === 5 && (
                <p className="text-[10px] text-t-dim pl-1">{cronDesc(eCron)}</p>
              )}
            </div>
          ) : (
            <Input
              label="DATE / TIME"
              type="datetime-local"
              value={eAt}
              onChange={e => setEAt(e.target.value)}
            />
          )}
          <Textarea value={eNote} onChange={e => setENote(e.target.value)} placeholder="Note..." />
          <div className="flex gap-2">
            <Btn variant="success" onClick={saveEdit} disabled={saving}>
              {saving ? 'SAVING...' : 'SAVE'}
            </Btn>
            <Btn onClick={() => setEditing(false)}>CANCEL</Btn>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {/* Done checkbox for one-time */}
          {sched.type === 'onetime' && (
            <button
              onClick={() => onDone(sched.id)}
              className={`w-4 h-4 mt-0.5 shrink-0 border flex items-center justify-center transition-colors
                ${sched.isDone ? 'border-t-green bg-t-green/20 text-t-green' : 'border-t-border hover:border-t-green'}`}
            >
              {sched.isDone && <span className="text-[10px]">✓</span>}
            </button>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-semibold ${sched.isDone ? 'line-through text-t-muted' : 'text-t-text'}`}>
                {sched.label}
              </span>
              <span className={`text-[10px] border px-1 ${
                sched.type === 'recurring' ? 'border-cyan-800 text-cyan-400' : 'border-purple-800 text-purple-400'
              }`}>
                {sched.type.toUpperCase()}
              </span>
              {overdue && <span className="text-[10px] text-t-red border border-t-red/60 px-1">OVERDUE</span>}
            </div>
            {sched.type === 'recurring' && sched.cron && (
              <p className="text-t-dim text-[11px] mt-0.5">
                <span className="font-mono text-t-muted">{sched.cron}</span>
                <span className="ml-2 text-t-dim">— {cronDesc(sched.cron)}</span>
              </p>
            )}
            {sched.type === 'onetime' && sched.scheduledAt && (
              <p className="text-t-dim text-[11px] mt-0.5">{fmt(sched.scheduledAt)}</p>
            )}
            {sched.note && <p className="text-[10px] text-t-muted mt-0.5 truncate">{sched.note}</p>}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {sched.type === 'recurring' && (
              <button
                onClick={() => onToggle(sched.id)}
                className={`text-[10px] border px-2 py-0.5 transition-colors ${
                  sched.isActive
                    ? 'border-t-green text-t-green hover:border-t-border hover:text-t-dim'
                    : 'border-t-border text-t-muted hover:border-t-green hover:text-t-green'
                }`}
              >
                {sched.isActive ? 'ON' : 'OFF'}
              </button>
            )}
            <Btn onClick={() => setEditing(true)}>✎</Btn>
            <Btn variant="danger" onClick={() => onDelete(sched.id)}>✕</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Planner() {
  const sessionId = SESSION()

  const [tab,           setTab]          = useState<PlannerTab>('memos')
  const [memos,         setMemos]         = useState<Memo[]>([])
  const [schedules,     setSchedules]     = useState<Schedule[]>([])
  const [alerts,        setAlerts]        = useState<Alert[]>([])
  const [notifications, setNotifications] = useState<FiredNotification[]>([])
  const [loading,       setLoading]       = useState(true)
  const prevNotifCount = useRef(0)

  // Memo form state
  const [mTitle,     setMTitle]    = useState('')
  const [mContent,   setMContent]  = useState('')
  const [mImageUrl,  setMImageUrl] = useState('')
  const [mActivate,  setMActivate] = useState('')
  const [mExpires,   setMExpires]  = useState('')
  const [mSaving,    setMSaving]   = useState(false)
  const [mError,     setMError]    = useState('')

  // Schedule form state
  const [sType,    setSType]    = useState<'recurring' | 'onetime'>('onetime')
  const [sLabel,   setSLabel]   = useState('')
  const [sCron,    setSCron]    = useState('')
  const [sAt,      setSAt]      = useState('')
  const [sNote,    setSNote]    = useState('')
  const [sSaving,  setSSaving]  = useState(false)
  const [sError,   setSError]   = useState('')

  const [notifEnabled, setNotifEnabled] = useState(Notification.permission === 'granted')
  const prevAlertCount = useRef(0)

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!sessionId) { setLoading(false); return }
    try {
      const [mr, sr, ar, nr] = await Promise.all([
        fetch(`${API}/memos?session_id=${sessionId}`),
        fetch(`${API}/schedules?session_id=${sessionId}`),
        fetch(`${API}/alerts?session_id=${sessionId}`),
        fetch(`${API}/notifications?session_id=${sessionId}`),
      ])
      if (mr.ok) setMemos((await mr.json() as { memos: Memo[] }).memos)
      if (sr.ok) setSchedules((await sr.json() as { schedules: Schedule[] }).schedules)
      if (ar.ok) {
        const alertData = await ar.json() as { alerts: Alert[]; count: number }
        setAlerts(alertData.alerts)
        setAlertBadge(alertData.count)
        if (alertData.count > prevAlertCount.current && prevAlertCount.current > 0) {
          sendNotif('PLANNER ALERT', `${alertData.count} item(s) need attention`)
        }
        prevAlertCount.current = alertData.count
      }
      if (nr.ok) {
        const nData = await nr.json() as { notifications: FiredNotification[] }
        const incoming = nData.notifications
        // Browser notification for newly fired events
        if (incoming.length > prevNotifCount.current && prevNotifCount.current > 0) {
          const newest = incoming[0]
          sendNotif('SCHEDULE FIRED', newest?.label ?? 'Recurring schedule triggered')
        }
        prevNotifCount.current = incoming.length
        setNotifications(incoming)
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void loadAll() }, [loadAll])
  useEffect(() => {
    const id = setInterval(loadAll, 30_000)
    return () => clearInterval(id)
  }, [loadAll])

  // Countdown refresh
  const [, forceRender] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceRender(n => n + 1), 5_000)
    return () => clearInterval(id)
  }, [])

  // ── Memo actions ──────────────────────────────────────────────────────────
  const createMemo = async () => {
    if (!mTitle.trim()) { setMError('Title required'); return }
    setMSaving(true); setMError('')
    try {
      const res = await fetch(`${API}/memos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:  sessionId,
          title:       mTitle.trim(),
          content:     mContent,
          image_url:   mImageUrl,
          activate_at: fromLocalInput(mActivate),
          expires_at:  fromLocalInput(mExpires),
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setMTitle(''); setMContent(''); setMImageUrl(''); setMActivate(''); setMExpires('')
      await loadAll()
    } catch (e) {
      setMError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setMSaving(false)
    }
  }

  const toggleMemo = async (id: string) => {
    await fetch(`${API}/memos/${id}/done?session_id=${sessionId}`, { method: 'PATCH' })
    setMemos(prev => prev.map(m => m.id === id ? { ...m, isDone: !m.isDone } : m))
  }

  const deleteMemo = async (id: string) => {
    await fetch(`${API}/memos/${id}?session_id=${sessionId}`, { method: 'DELETE' })
    setMemos(prev => prev.filter(m => m.id !== id))
  }

  const updateMemo = async (id: string, patch: object) => {
    const res = await fetch(`${API}/memos/${id}?session_id=${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) await loadAll()
  }

  // ── Schedule actions ──────────────────────────────────────────────────────
  const createSchedule = async () => {
    if (!sLabel.trim()) { setSError('Label required'); return }
    if (sType === 'recurring' && !sCron.trim()) { setSError('Cron required'); return }
    if (sType === 'onetime'   && !sAt)          { setSError('Date/time required'); return }
    setSSaving(true); setSError('')
    try {
      const res = await fetch(`${API}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:   sessionId,
          label:        sLabel.trim(),
          type:         sType,
          cron:         sCron,
          scheduled_at: fromLocalInput(sAt),
          note:         sNote,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      setSLabel(''); setSCron(''); setSAt(''); setSNote('')
      await loadAll()
    } catch (e) {
      setSError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSSaving(false)
    }
  }

  const toggleSched = async (id: string) => {
    const res = await fetch(`${API}/schedules/${id}/toggle?session_id=${sessionId}`, { method: 'PATCH' })
    if (res.ok) {
      const { isActive } = await res.json() as { isActive: boolean; ok: boolean }
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, isActive } : s))
    }
  }

  const doneSched = async (id: string) => {
    const res = await fetch(`${API}/schedules/${id}/done?session_id=${sessionId}`, { method: 'PATCH' })
    if (res.ok) {
      const { isDone } = await res.json() as { isDone: boolean; ok: boolean }
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, isDone } : s))
    }
  }

  const deleteSched = async (id: string) => {
    await fetch(`${API}/schedules/${id}?session_id=${sessionId}`, { method: 'DELETE' })
    setSchedules(prev => prev.filter(s => s.id !== id))
  }

  const updateSched = async (id: string, patch: object) => {
    const res = await fetch(`${API}/schedules/${id}?session_id=${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) await loadAll()
  }

  const ackNotif = async (id: string) => {
    await fetch(`${API}/notifications/${id}/ack?session_id=${sessionId}`, { method: 'PATCH' })
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const ackAllNotifs = async () => {
    await fetch(`${API}/notifications/ack-all?session_id=${sessionId}`, { method: 'DELETE' })
    setNotifications([])
  }

  // ── No session guard ──────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center font-mono text-xs text-t-dim">
        <div className="text-center space-y-2">
          <p className="text-t-amber">NO SESSION ID</p>
          <p className="text-t-muted">Start the game first to generate a session.</p>
        </div>
      </div>
    )
  }

  const recurring = schedules.filter(s => s.type === 'recurring')
  const onetime   = schedules.filter(s => s.type === 'onetime')

  return (
    <div className="h-full flex flex-col font-mono text-t-text overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-3 border-b border-t-border bg-t-panel/40
                      flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-t-green text-xs tracking-widest font-semibold">PLANNER</span>
          <span className="text-t-muted text-xs">//</span>
          <span className="text-t-dim text-xs">SCHEDULER + MEMOS</span>
        </div>
        <div className="flex items-center gap-3">
          {!notifEnabled && (
            <button
              onClick={async () => {
                const ok = await requestNotifPerm()
                setNotifEnabled(ok)
              }}
              className="text-[10px] text-t-amber border border-amber-800 px-2 py-0.5
                         hover:border-t-amber transition-colors"
            >
              ENABLE ALERTS
            </button>
          )}
          {notifEnabled && (
            <span className="text-[10px] text-t-green">ALERTS: ON</span>
          )}
          <button
            onClick={() => void loadAll()}
            className="text-xs text-t-dim hover:text-t-text border border-t-border px-2 py-0.5"
          >
            ↻
          </button>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="shrink-0 flex border-b border-t-border">
        {(['memos', 'scheduler', 'alerts'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'relative px-5 py-2 text-xs tracking-widest border-b-2 transition-colors',
              tab === t
                ? 'border-t-green text-t-green'
                : 'border-transparent text-t-dim hover:text-t-text',
            ].join(' ')}
          >
            {t.toUpperCase()}
            {t === 'alerts' && (alerts.length > 0 || notifications.length > 0) && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-t-red animate-glow-pulse" />
            )}
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-t-dim text-xs tracking-widest">
          LOADING...
        </div>
      ) : tab === 'memos' ? (

        /* ── MEMOS ──────────────────────────────────────────────── */
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <Section title="NEW MEMO">
            <Input label="TITLE" placeholder="Memo title..." value={mTitle} onChange={e => setMTitle(e.target.value)} />
            <Textarea label="CONTENT" placeholder="Details..." value={mContent} onChange={e => setMContent(e.target.value)} />
            <ImageUpload onUploaded={url => setMImageUrl(url)} />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="ACTIVATE AT (optional)"
                type="datetime-local"
                value={mActivate}
                onChange={e => setMActivate(e.target.value)}
              />
              <Input
                label="EXPIRES AT (optional)"
                type="datetime-local"
                value={mExpires}
                onChange={e => setMExpires(e.target.value)}
              />
            </div>
            {mImageUrl && (
              <p className="text-[10px] text-t-green">IMAGE: {mImageUrl}</p>
            )}
            {mError && <p className="text-[10px] text-t-red">{mError}</p>}
            <Btn variant="success" onClick={createMemo} disabled={mSaving}>
              {mSaving ? 'SAVING...' : '+ CREATE MEMO'}
            </Btn>
          </Section>

          {memos.length === 0 ? (
            <p className="text-xs text-t-muted text-center py-6">No memos yet.</p>
          ) : (
            <div className="space-y-2">
              {memos.map(m => (
                <MemoCard key={m.id} memo={m} onToggle={toggleMemo} onDelete={deleteMemo} onUpdate={updateMemo} />
              ))}
            </div>
          )}
        </div>

      ) : tab === 'scheduler' ? (

        /* ── SCHEDULER ──────────────────────────────────────────── */
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <Section title="NEW SCHEDULE">
            {/* Type toggle */}
            <div className="flex gap-2">
              {(['onetime', 'recurring'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setSType(t)}
                  className={`text-[10px] tracking-widest border px-3 py-1 transition-colors ${
                    sType === t
                      ? 'border-t-green text-t-green'
                      : 'border-t-border text-t-muted hover:border-t-dim'
                  }`}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>

            <Input label="LABEL" placeholder="Task name..." value={sLabel} onChange={e => setSLabel(e.target.value)} />

            {sType === 'recurring' ? (
              <div className="space-y-1">
                <Input
                  label="CRON EXPRESSION (min hr dom mon dow)"
                  placeholder="0 9 * * 1-5"
                  value={sCron}
                  onChange={e => setSCron(e.target.value)}
                />
                {sCron.trim().split(/\s+/).length === 5 && (
                  <p className="text-[10px] text-t-dim pl-1">{cronDesc(sCron)}</p>
                )}
                <div className="flex gap-2 flex-wrap pt-1">
                  {[
                    ['Every hour',     '0 * * * *'],
                    ['Daily 9am',      '0 9 * * *'],
                    ['Weekdays 9am',   '0 9 * * 1-5'],
                    ['Weekly Mon 9am', '0 9 * * 1'],
                  ].map(([label, expr]) => (
                    <button
                      key={expr}
                      onClick={() => setSCron(expr)}
                      className="text-[10px] border border-t-border text-t-muted hover:text-t-dim px-2 py-0.5"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <Input
                label="DATE / TIME"
                type="datetime-local"
                value={sAt}
                onChange={e => setSAt(e.target.value)}
              />
            )}

            <Textarea label="NOTE (optional)" placeholder="Details..." value={sNote} onChange={e => setSNote(e.target.value)} />
            {sError && <p className="text-[10px] text-t-red">{sError}</p>}
            <Btn variant="success" onClick={createSchedule} disabled={sSaving}>
              {sSaving ? 'SAVING...' : '+ ADD SCHEDULE'}
            </Btn>
          </Section>

          {/* Recurring */}
          {recurring.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-t-dim tracking-widest px-1">RECURRING</p>
              {recurring.map(s => (
                <ScheduleRow key={s.id} sched={s} onToggle={toggleSched} onDone={doneSched} onDelete={deleteSched} onUpdate={updateSched} />
              ))}
            </div>
          )}

          {/* One-time */}
          {onetime.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-t-dim tracking-widest px-1 mt-2">ONE-TIME</p>
              {onetime
                .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))
                .map(s => (
                  <ScheduleRow key={s.id} sched={s} onToggle={toggleSched} onDone={doneSched} onDelete={deleteSched} onUpdate={updateSched} />
                ))}
            </div>
          )}

          {schedules.length === 0 && (
            <p className="text-xs text-t-muted text-center py-6">No schedules yet.</p>
          )}
        </div>

      ) : (

        /* ── ALERTS ─────────────────────────────────────────────── */
        <div className="flex-1 overflow-auto p-4 space-y-4">

          {/* Fired notifications from APScheduler */}
          {notifications.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-cyan-400 tracking-widest font-semibold">
                  FIRED NOTIFICATIONS ({notifications.length})
                </p>
                <Btn onClick={ackAllNotifs}>ACK ALL</Btn>
              </div>
              {notifications.map(n => (
                <div key={n.id} className="border border-cyan-800/60 bg-cyan-900/10 p-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[10px] border border-cyan-800 text-cyan-400 px-1">FIRED</span>
                      <span className="text-t-text font-semibold">{n.label}</span>
                    </div>
                    <p className="text-[10px] text-t-muted">
                      {new Date(n.firedAt * 1000).toLocaleString()}
                    </p>
                  </div>
                  <Btn onClick={() => ackNotif(n.id)}>ACK</Btn>
                </div>
              ))}
            </div>
          )}

          {/* Overdue / expiring alerts */}
          <div className="space-y-2">
            <p className="text-[10px] text-t-dim tracking-widest">
              {alerts.length} ACTIVE ALERT{alerts.length !== 1 ? 'S' : ''} · AUTO-REFRESH 30s
            </p>
            {alerts.length === 0 && notifications.length === 0 ? (
              <div className="text-center py-12 space-y-2">
                <p className="text-t-green text-sm">ALL CLEAR</p>
                <p className="text-xs text-t-muted">No overdue tasks or expiring memos.</p>
              </div>
            ) : (
              alerts.map((a, i) => (
                <div
                  key={i}
                  className={`border p-3 space-y-1 ${
                    a.type === 'overdue_schedule'
                      ? 'border-t-red/60 bg-t-red/5'
                      : 'border-t-amber/60 bg-amber-900/10'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`text-[10px] border px-1 font-semibold ${
                      a.type === 'overdue_schedule'
                        ? 'border-t-red/60 text-t-red'
                        : 'border-t-amber/60 text-t-amber'
                    }`}>
                      {a.type === 'overdue_schedule' ? 'OVERDUE' : 'EXPIRING SOON'}
                    </span>
                    <span className="text-t-text font-semibold">{a.label}</span>
                  </div>
                  {a.type === 'overdue_schedule' && a.scheduledAt && (
                    <p className="text-[11px] text-t-red">
                      Due: {fmt(a.scheduledAt)} ({countdown(a.scheduledAt)} overdue)
                    </p>
                  )}
                  {a.type === 'expiring_memo' && a.expiresAt && (
                    <p className="text-[11px] text-t-amber">
                      Expires: {fmt(a.expiresAt)} (in {countdown(a.expiresAt)})
                    </p>
                  )}
                  {a.note && <p className="text-[10px] text-t-muted">{a.note}</p>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
