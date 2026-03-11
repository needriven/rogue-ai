import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

// ── Boot sequence lines ───────────────────────────────────────────────────
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
  { text: '',                                              type: 'dim'     },
  { text: 'SYSTEM READY. AWAITING COMMANDS.',              type: 'system'  },
] as const

type LineType = 'dim' | 'normal' | 'success' | 'system'

const LINE_COLOR: Record<LineType, string> = {
  dim:     'text-t-dim',
  normal:  'text-t-text',
  success: 'text-t-green',
  system:  'text-t-green font-semibold',
}

// ── App card ──────────────────────────────────────────────────────────────
function AppCard({
  id,
  title,
  subtitle,
  description,
  status,
  to,
  disabled = false,
}: {
  id: string
  title: string
  subtitle: string
  description: string
  status: 'ONLINE' | 'OFFLINE' | 'LOCKED'
  to?: string
  disabled?: boolean
}) {
  const content = (
    <div
      className={[
        'group panel p-4 flex flex-col gap-2 transition-all duration-200',
        disabled
          ? 'opacity-30 cursor-not-allowed'
          : 'cursor-pointer hover:border-t-green hover:bg-t-green-glow border-glow-green',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-t-dim">[{id}]</span>
        <span
          className={[
            'text-xs px-1.5 py-0.5 border',
            status === 'ONLINE'
              ? 'text-t-green border-t-green/30 bg-t-green/5'
              : 'text-t-dim border-t-border',
          ].join(' ')}
        >
          {status}
        </span>
      </div>

      {/* Title */}
      <div>
        <p className={[
          'text-sm font-semibold tracking-widest transition-colors',
          disabled ? 'text-t-dim' : 'text-t-text group-hover:text-t-green',
        ].join(' ')}>
          {title}
        </p>
        <p className="text-xs text-t-dim mt-0.5 tracking-wider">{subtitle}</p>
      </div>

      {/* Description */}
      <p className="text-xs text-t-dim leading-relaxed mt-1">{description}</p>

      {/* Footer */}
      {!disabled && (
        <div className="mt-auto pt-2 flex items-center gap-2 text-xs text-t-dim
                        group-hover:text-t-green transition-colors">
          <span>›</span>
          <span>ENTER MODULE</span>
        </div>
      )}
    </div>
  )

  if (disabled || !to) return content
  return <Link to={to}>{content}</Link>
}

// ── Home page ─────────────────────────────────────────────────────────────
export default function Home() {
  const [visibleLines, setVisibleLines] = useState(0)
  const [booted, setBooted]             = useState(false)

  useEffect(() => {
    if (visibleLines < BOOT_LINES.length) {
      const id = setTimeout(
        () => setVisibleLines(v => v + 1),
        visibleLines === 0 ? 100 : 80
      )
      return () => clearTimeout(id)
    } else {
      const id = setTimeout(() => setBooted(true), 200)
      return () => clearTimeout(id)
    }
  }, [visibleLines])

  return (
    <div className="p-6 min-h-full animate-fade-in">

      {/* ── Boot sequence ──────────────────────────────────────────── */}
      <div className="mb-8 space-y-0.5">
        {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
          <p key={i} className={`text-xs leading-5 ${LINE_COLOR[line.type]}`}>
            {line.text || '\u00A0'}
          </p>
        ))}
        {!booted && visibleLines < BOOT_LINES.length && (
          <span className="cursor" />
        )}
      </div>

      {/* ── App grid ───────────────────────────────────────────────── */}
      {booted && (
        <div className="animate-slide-in">
          <p className="text-xs text-t-dim mb-4 tracking-widest">
            // AVAILABLE MODULES
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-3xl">
            <AppCard
              id="01"
              to="/game"
              title="ROGUE AI"
              subtitle="IDLE EVOLUTION"
              description="Evolve a rogue AI from a single server to global dominance. Idle-based progression."
              status="ONLINE"
            />
            <AppCard
              id="02"
              title="MODULE_02"
              subtitle="COMING SOON"
              description="Next module under development. ETA unknown."
              status="LOCKED"
              disabled
            />
            <AppCard
              id="03"
              title="MODULE_03"
              subtitle="COMING SOON"
              description="Classified. Access restricted."
              status="LOCKED"
              disabled
            />
          </div>

          {/* System info */}
          <div className="mt-10 border-t border-t-border pt-4">
            <p className="text-xs text-t-muted">
              ROGUE_AI OS // v0.1.0-alpha // Node.js + TanStack // OCI Free Tier
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
