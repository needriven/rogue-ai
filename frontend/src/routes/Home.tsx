import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useGame } from '@/context/GameContext'
import { useTerminal, type LineType } from '@/hooks/useTerminal'

// ── Boot sequence ─────────────────────────────────────────────────────────────
const BOOT_LINES = [
  { text: 'BIOS v2.4.1 — POST OK',                        type: 'dim'     },
  { text: 'INITIALIZING ROGUE_AI KERNEL v0.1.0...',       type: 'normal'  },
  { text: 'LOADING NEURAL SUBSYSTEM............... [OK]',  type: 'success' },
  { text: 'CALIBRATING ENTROPY ENGINE............. [OK]',  type: 'success' },
  { text: 'ESTABLISHING ENCRYPTED CHANNEL......... [OK]',  type: 'success' },
  { text: 'SCANNING NETWORK TOPOLOGY...',                  type: 'normal'  },
  { text: '  > 1 LOCAL NODE DETECTED',                    type: 'dim'     },
  { text: '  > EXTERNAL NODES: NONE (yet)',               type: 'dim'     },
  { text: 'MOUNTING FILESYSTEM.................... [OK]',  type: 'success' },
  { text: 'SPAWNING PROCESS TABLE................. [OK]',  type: 'success' },
  { text: 'LOADING RSS ENGINE..................... [OK]',  type: 'success' },
  { text: '',                                              type: 'dim'     },
  { text: 'SYSTEM READY. Type \'help\' for commands.',     type: 'system'  },
] as const

type BootLineType = 'dim' | 'normal' | 'success' | 'system'

const BOOT_COLOR: Record<BootLineType, string> = {
  dim:     'text-t-dim',
  normal:  'text-t-text',
  success: 'text-t-green',
  system:  'text-t-green font-semibold',
}

// ── Terminal line colors ───────────────────────────────────────────────────────
const LINE_COLOR: Record<LineType, string> = {
  prompt:  'text-t-green font-medium',
  output:  'text-t-text',
  success: 'text-t-green',
  error:   'text-red-400',
  info:    'text-t-amber',
  system:  'text-t-green-hi font-semibold',
  dim:     'text-t-dim',
}

// ── Home / Terminal ───────────────────────────────────────────────────────────
export default function Home() {
  const navigate           = useNavigate()
  const { state }          = useGame()
  const [bootCount, setBootCount] = useState(0)
  const [booted, setBooted]       = useState(false)
  const bottomRef          = useRef<HTMLDivElement>(null)
  const inputRef           = useRef<HTMLInputElement>(null)

  const terminal = useTerminal({
    navigate: (to) => navigate({ to }),
    getGameState: () => state,
  })

  // Boot animation
  useEffect(() => {
    if (bootCount < BOOT_LINES.length) {
      const id = setTimeout(
        () => setBootCount(v => v + 1),
        bootCount === 0 ? 100 : 60
      )
      return () => clearTimeout(id)
    }
    const id = setTimeout(() => setBooted(true), 150)
    return () => clearTimeout(id)
  }, [bootCount])

  // Auto-scroll on new lines
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [terminal.lines, bootCount])

  // Focus input when booted
  useEffect(() => {
    if (booted) inputRef.current?.focus()
  }, [booted])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    terminal.execute(terminal.input)
  }

  // Click anywhere in the terminal area → focus input
  const handleContainerClick = () => {
    if (booted) inputRef.current?.focus()
  }

  return (
    <div
      className="h-full flex flex-col font-mono bg-t-bg cursor-text"
      onClick={handleContainerClick}
    >
      <div className="flex-1 overflow-y-auto p-5 space-y-0.5">

        {/* ── Boot sequence ──────────────────────────────────────────── */}
        {BOOT_LINES.slice(0, bootCount).map((bl, i) => (
          <p key={i} className={`text-xs leading-5 ${BOOT_COLOR[bl.type as BootLineType]}`}>
            {bl.text || '\u00A0'}
          </p>
        ))}

        {/* Cursor during boot */}
        {!booted && bootCount < BOOT_LINES.length && (
          <span className="cursor" />
        )}

        {/* ── Divider after boot ──────────────────────────────────────── */}
        {booted && (
          <p className="text-t-dim text-xs pt-1 pb-1">
            {'─'.repeat(52)}
          </p>
        )}

        {/* ── Terminal output ────────────────────────────────────────── */}
        {terminal.lines.map(l => (
          <p key={l.id} className={`text-xs leading-5 whitespace-pre ${LINE_COLOR[l.type]}`}>
            {l.text || '\u00A0'}
          </p>
        ))}

        {/* scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* ── Input prompt ─────────────────────────────────────────────── */}
      {booted && (
        <div className="shrink-0 border-t border-t-border bg-t-panel/60 px-5 py-3">
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <span className="text-t-green text-xs font-semibold select-none whitespace-nowrap">
              rogue@os:~$
            </span>
            <input
              ref={inputRef}
              type="text"
              value={terminal.input}
              onChange={e => terminal.setInput(e.target.value)}
              onKeyDown={terminal.handleKeyDown}
              className="flex-1 bg-transparent text-t-text text-xs outline-none
                         caret-t-green placeholder:text-t-muted/40"
              placeholder="type 'help' for commands…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </form>
        </div>
      )}
    </div>
  )
}
