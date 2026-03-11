import { useState, useEffect } from 'react'
import type { ActiveEvent, EventChoice } from '@/types/events'
import { EVENT_POOL } from '@/types/events'

interface Props {
  event:     ActiveEvent
  cps:       number
  onChoice:  (eventId: string, choiceId: string) => void
  onDismiss: (eventId: string) => void
}

const TYPE_STYLES = {
  positive: 'border-t-green/50  bg-t-green/5  text-t-green',
  negative: 'border-red-500/50  bg-red-950/20 text-red-400',
  choice:   'border-t-amber/50  bg-t-amber/5  text-t-amber',
}

const TYPE_ICON = {
  positive: '▲',
  negative: '▼',
  choice:   '◆',
}

export default function EventBanner({ event, cps, onChoice, onDismiss }: Props) {
  const [remaining, setRemaining] = useState(0)
  const def = EVENT_POOL.find(e => e.id === event.defId)
  if (!def) return null

  // Countdown timer for timed events
  useEffect(() => {
    if (!event.expiresAt) return
    const update = () => setRemaining(Math.max(0, Math.ceil((event.expiresAt - Date.now()) / 1000)))
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [event.expiresAt])

  // Format dynamic choice descriptions
  const describeChoice = (c: EventChoice): string => {
    let desc = c.description
    if (c.effect.cyclesDelta && c.effect.cyclesDelta > 1) {
      desc = desc.replace('CPS × 20', `+${(cps * 20).toFixed(0)} cycles`)
                 .replace('CPS × 60', `+${(cps * 60).toFixed(0)} cycles`)
                 .replace('CPS × 10', `+${(cps * 10).toFixed(0)} cycles`)
                 .replace('CPS × 50', `~${(cps * 50).toFixed(0)} cycles cost`)
    }
    return desc
  }

  const hasChoices = !!def.choices?.length
  const isExpiring = event.expiresAt && remaining <= 10

  return (
    <div className={[
      'border-b px-4 py-2.5 flex items-center gap-4 text-xs animate-slide-in',
      TYPE_STYLES[def.type],
    ].join(' ')}>

      {/* Icon + title */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="font-bold">{TYPE_ICON[def.type]}</span>
        <span className="font-semibold tracking-wider">{def.title}</span>
      </div>

      {/* Description */}
      <p className="flex-1 text-xs opacity-80 hidden sm:block">{def.description}</p>

      {/* Timer (for timed events) */}
      {event.expiresAt > 0 && (
        <span className={`tabular-nums shrink-0 ${isExpiring ? 'animate-blink' : 'opacity-60'}`}>
          {remaining}s
        </span>
      )}

      {/* Choice buttons */}
      {hasChoices && def.choices!.map(c => (
        <button
          key={c.id}
          onClick={() => onChoice(def.id, c.id)}
          title={describeChoice(c)}
          className={[
            'shrink-0 px-2.5 py-1 border text-xs tracking-wider transition-all duration-150',
            def.type === 'negative'
              ? 'border-red-500/50 hover:bg-red-900/30'
              : 'border-t-amber/50 hover:bg-t-amber/10',
          ].join(' ')}
        >
          {c.label}
        </button>
      ))}

      {/* Dismiss for timed positive events */}
      {!hasChoices && (
        <button
          onClick={() => onDismiss(def.id)}
          className="shrink-0 text-t-muted hover:text-t-dim text-sm leading-none px-1"
          title="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  )
}
