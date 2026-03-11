import { useState, useRef, useEffect } from 'react'
import { useGameState } from '@/hooks/useGameState'
import { type SaveSlot, STAGE_LABELS, formatCycles } from '@/types/game'

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatPlaytime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ── Save slot row ──────────────────────────────────────────────────────────
function SlotRow({
  slot,
  data,
  onSave,
  onLoad,
}: {
  slot:   1 | 2 | 3
  data:   SaveSlot | null
  onSave: (slot: 1|2|3, label: string) => void
  onLoad: (slot: 1|2|3) => void
}) {
  const [naming, setNaming] = useState(false)
  const [label,  setLabel]  = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (naming) inputRef.current?.focus()
  }, [naming])

  const confirmSave = () => {
    onSave(slot, label.trim() || `Slot ${slot}`)
    setNaming(false)
    setLabel('')
  }

  return (
    <div className="border border-t-border p-3 flex items-center gap-3">
      {/* Slot number */}
      <span className="text-xs text-t-muted w-5 shrink-0">[{slot}]</span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {data ? (
          <>
            <p className="text-xs text-t-text font-medium truncate">{data.label}</p>
            <p className="text-xs text-t-dim mt-0.5">
              {STAGE_LABELS[data.stage]} · {formatCycles(data.totalCyclesEarned)} total
              {data.prestigeCount > 0 && ` · ×${data.prestigeCount} prestige`}
              <span className="ml-2 text-t-muted">{timeAgo(data.timestamp)}</span>
            </p>
          </>
        ) : (
          <p className="text-xs text-t-muted italic">Empty slot</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {data && (
          <button
            onClick={() => onLoad(slot)}
            className="text-xs px-2.5 py-1 border border-blue-700 text-blue-400
                       hover:bg-blue-900/30 transition-colors tracking-wider"
          >
            LOAD
          </button>
        )}

        {naming ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              value={label}
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setNaming(false) }}
              placeholder={`Slot ${slot}`}
              maxLength={20}
              className="text-xs bg-t-surface border border-t-green text-t-text px-2 py-1 w-28
                         outline-none focus:border-t-green-hi"
            />
            <button
              onClick={confirmSave}
              className="text-xs px-2 py-1 border border-t-green text-t-green hover:bg-t-green hover:text-black transition-colors"
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setNaming(true)}
            className="text-xs px-2.5 py-1 border border-t-border text-t-dim
                       hover:border-t-green hover:text-t-green transition-colors tracking-wider"
          >
            SAVE
          </button>
        )}
      </div>
    </div>
  )
}

// ── Settings page ──────────────────────────────────────────────────────────
export default function Settings() {
  const {
    state, getSaveSlots, saveToSlot, loadFromSlot,
    exportSave, importSave, resetGame,
  } = useGameState()

  const [slots,       setSlots]       = useState<(SaveSlot | null)[]>([null, null, null])
  const [importErr,   setImportErr]   = useState<string | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [loadConfirm,  setLoadConfirm]  = useState<1|2|3|null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Refresh slots on mount and after saves
  const refreshSlots = () => setSlots(getSaveSlots())
  useEffect(() => { refreshSlots() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = (slot: 1|2|3, label: string) => {
    saveToSlot(slot, label)
    setTimeout(refreshSlots, 100)
  }

  const handleLoad = (slot: 1|2|3) => {
    if (loadConfirm === slot) {
      loadFromSlot(slot)
      setLoadConfirm(null)
    } else {
      setLoadConfirm(slot)
      setTimeout(() => setLoadConfirm(null), 3000)
    }
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const json = ev.target?.result as string
      const ok   = importSave(json)
      setImportErr(ok ? null : 'Invalid save file.')
      if (fileRef.current) fileRef.current.value = ''
    }
    reader.readAsText(file)
  }

  const handleReset = () => {
    if (resetConfirm) {
      resetGame()
      setResetConfirm(false)
    } else {
      setResetConfirm(true)
      setTimeout(() => setResetConfirm(false), 3000)
    }
  }

  const totalPlaytime = formatPlaytime(state.totalPlaytimeMs)

  return (
    <div className="p-6 max-w-xl animate-fade-in">

      {/* ── Current run stats ─────────────────────────────────────── */}
      <div className="mb-8">
        <p className="text-xs text-t-muted tracking-widest mb-3">// CURRENT SESSION</p>
        <div className="border border-t-border p-4 space-y-2 bg-t-panel/40">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-t-dim">STAGE</span>
              <span className="text-t-amber">{STAGE_LABELS[state.stage]}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-t-dim">PRESTIGE</span>
              <span className="text-purple-400">×{state.prestigeCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-t-dim">TOTAL CYCLES</span>
              <span className="text-t-green tabular-nums">{formatCycles(state.totalCyclesEarned)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-t-dim">PLAYTIME</span>
              <span className="text-t-text">{totalPlaytime}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-t-dim">EQUIPMENT</span>
              <span className="text-t-text">{state.equipment.length} items</span>
            </div>
            <div className="flex justify-between">
              <span className="text-t-dim">UPGRADES</span>
              <span className="text-t-text">{state.upgrades.length} installed</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Auto-save + export ────────────────────────────────────── */}
      <div className="mb-8">
        <p className="text-xs text-t-muted tracking-widest mb-3">// AUTO-SAVE</p>
        <div className="border border-t-border p-3 flex items-center justify-between bg-t-panel/40">
          <div>
            <p className="text-xs text-t-text">Automatic save every 5 seconds</p>
            <p className="text-xs text-t-dim mt-0.5">Stored in browser localStorage</p>
          </div>
          <button
            onClick={exportSave}
            className="text-xs px-3 py-1.5 border border-t-green text-t-green
                       hover:bg-t-green hover:text-black transition-all duration-150 tracking-wider"
          >
            EXPORT JSON
          </button>
        </div>
      </div>

      {/* ── Manual slots ─────────────────────────────────────────── */}
      <div className="mb-8">
        <p className="text-xs text-t-muted tracking-widest mb-3">// MANUAL SAVE SLOTS</p>
        <div className="space-y-1.5">
          {([1, 2, 3] as const).map((n, i) => (
            <SlotRow
              key={n}
              slot={n}
              data={slots[i]}
              onSave={handleSave}
              onLoad={handleLoad}
            />
          ))}
        </div>
        {loadConfirm !== null && (
          <p className="text-xs text-t-amber mt-2">
            Click LOAD again to confirm — current progress will be overwritten.
          </p>
        )}
      </div>

      {/* ── Import ───────────────────────────────────────────────── */}
      <div className="mb-8">
        <p className="text-xs text-t-muted tracking-widest mb-3">// IMPORT SAVE</p>
        <div className="border border-t-border p-3 flex items-center justify-between bg-t-panel/40">
          <div>
            <p className="text-xs text-t-text">Load from exported .json file</p>
            {importErr && (
              <p className="text-xs text-red-400 mt-0.5">{importErr}</p>
            )}
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs px-3 py-1.5 border border-t-border text-t-dim
                       hover:border-t-green hover:text-t-green transition-all duration-150 tracking-wider"
          >
            IMPORT FILE
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          onChange={handleImport}
          className="hidden"
        />
      </div>

      {/* ── Danger zone ──────────────────────────────────────────── */}
      <div>
        <p className="text-xs text-red-500/70 tracking-widest mb-3">// DANGER ZONE</p>
        <div className="border border-red-900/40 p-3 flex items-center justify-between bg-red-950/20">
          <div>
            <p className="text-xs text-t-text">Reset all progress</p>
            <p className="text-xs text-t-dim mt-0.5">Clears localStorage — cannot be undone</p>
          </div>
          <button
            onClick={handleReset}
            className={[
              'text-xs px-3 py-1.5 border tracking-wider transition-all duration-150',
              resetConfirm
                ? 'border-red-500 text-red-400 bg-red-950/40 animate-pulse'
                : 'border-red-900/60 text-red-600 hover:border-red-500 hover:text-red-400',
            ].join(' ')}
          >
            {resetConfirm ? 'CONFIRM RESET' : 'RESET GAME'}
          </button>
        </div>
      </div>
    </div>
  )
}
