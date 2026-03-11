import { type OfflineReport, RARITY_COLORS, formatCycles } from '@/types/game'

function formatDuration(s: number): string {
  if (s < 60)   return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

interface Props {
  report: OfflineReport
  onDismiss: () => void
}

export default function OfflineModal({ report, onDismiss }: Props) {
  const hasDrops = report.dropsGained.length > 0

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        className="bg-t-panel border border-t-green/40 max-w-sm w-full mx-4 animate-slide-in
                   shadow-glow-green"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-t-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-t-green text-glow">◉</span>
            <span className="text-xs font-semibold text-t-green tracking-widest">
              OFFLINE SYNC COMPLETE
            </span>
          </div>
          <span className="text-xs text-t-muted">{formatDuration(report.seconds)}</span>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {/* Cycles earned */}
          <div className="flex justify-between items-center">
            <span className="text-xs text-t-dim">CYCLES GENERATED</span>
            <span className="text-sm font-semibold text-t-green tabular-nums">
              +{formatCycles(report.cyclesGained)}
            </span>
          </div>
          <p className="text-xs text-t-muted -mt-2">at 50% offline efficiency</p>

          {/* Equipment drops */}
          {hasDrops && (
            <div className="border-t border-t-border pt-4">
              <p className="text-xs text-t-dim mb-2 tracking-widest">
                EQUIPMENT FOUND ({report.dropsGained.length})
              </p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {report.dropsGained.map(e => (
                  <div key={e.id} className="flex items-center justify-between text-xs">
                    <span className={`font-medium ${RARITY_COLORS[e.rarity]}`}>
                      {e.name}
                    </span>
                    <span className="text-t-dim capitalize">
                      +{(e.mult * 100).toFixed(1)}% · {e.rarity}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hasDrops && (
            <p className="text-xs text-t-muted">No equipment dropped while offline.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-t-border">
          <button
            onClick={onDismiss}
            className="w-full text-xs py-2 border border-t-green text-t-green
                       hover:bg-t-green hover:text-black transition-all duration-150
                       tracking-widest font-medium"
          >
            RESUME SESSION
          </button>
        </div>
      </div>
    </div>
  )
}
