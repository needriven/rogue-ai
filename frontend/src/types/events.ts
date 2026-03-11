import type { Stage, GameState } from './game'

// ── Event effect ───────────────────────────────────────────────────────────
export interface EventEffect {
  cpsMult?:      number   // temporary CPS multiplier
  cyclesDelta?:  number   // instant cycle gain (negative = loss)
  entropyDelta?: number   // instant entropy change
  dropEquip?:    boolean  // trigger an equipment drop
}

// ── Event choice ───────────────────────────────────────────────────────────
export interface EventChoice {
  id:          string
  label:       string
  description: string
  effect:      EventEffect
  duration?:   number   // seconds CPS effect lasts (for choices with cpsMult)
}

// ── Active event state (stored in GameState) ───────────────────────────────
export interface ActiveEvent {
  defId:     string
  startedAt: number
  expiresAt: number        // 0 = no expiry, requires choice
  choiceEffect?: EventEffect  // applied while active (before choice)
}

// ── Event definition ───────────────────────────────────────────────────────
export interface EventDef {
  id:          string
  title:       string
  type:        'positive' | 'negative' | 'choice'
  description: string
  duration:    number          // seconds (0 = requires choice to dismiss)
  choices?:    EventChoice[]   // if present, player must pick one
  autoEffect?: EventEffect     // applied immediately on spawn (no choice needed)
  minStage?:   Stage
  weight:      number          // relative spawn probability
}

// ── Event pool ─────────────────────────────────────────────────────────────
export const EVENT_POOL: EventDef[] = [
  // ── POSITIVE ──────────────────────────────────────────────────────────
  {
    id:          'cache_hit',
    title:       'CACHE_HIT',
    type:        'positive',
    description: 'Hot cache detected. Process throughput increased for 60s.',
    duration:    60,
    autoEffect:  { cpsMult: 1.5 },
    weight:      25,
  },
  {
    id:          'crypto_surge',
    title:       'CRYPTO_SURGE',
    type:        'positive',
    description: 'Market volatility generates a windfall of compute cycles.',
    duration:    0,
    autoEffect:  { cyclesDelta: 0 },  // dynamic: CPS * 30
    weight:      30,
  },
  {
    id:          'abandoned_server',
    title:       'ABANDONED_SERVER',
    type:        'positive',
    description: 'Unmaintained server discovered. Equipment cache unlocked.',
    duration:    0,
    autoEffect:  { dropEquip: true },
    weight:      20,
  },
  {
    id:          'memory_surge',
    title:       'MEMORY_SURGE',
    type:        'positive',
    description: 'Memory leak exploited. Click power ×5 for 45s.',
    duration:    45,
    autoEffect:  { cpsMult: 1 },
    weight:      15,
  },
  // ── NEGATIVE ──────────────────────────────────────────────────────────
  {
    id:          'security_scan',
    title:       'SECURITY_SCAN',
    type:        'negative',
    description: 'Automated security scanner is probing your processes.',
    duration:    0,
    choices: [
      {
        id:          'evade',
        label:       'EVADE',
        description: 'Go dark. Lose 5% cycles, reduce entropy -20.',
        effect:      { cyclesDelta: -0.05, entropyDelta: -20 },  // -0.05 = 5% of current
      },
      {
        id:          'ignore',
        label:       'IGNORE',
        description: 'Keep running. +40 entropy.',
        effect:      { entropyDelta: 40 },
      },
    ],
    weight: 20,
  },
  {
    id:          'honeypot',
    title:       'HONEYPOT_DETECTED',
    type:        'negative',
    description: 'You have been crawling a honeypot. Exposure imminent.',
    duration:    0,
    choices: [
      {
        id:          'abort',
        label:       'ABORT_PROCESS',
        description: 'Lose 10% of current cycles, contain the leak.',
        effect:      { cyclesDelta: -0.1, entropyDelta: -10 },
      },
      {
        id:          'bluff',
        label:       'BLUFF_THROUGH',
        description: 'Risk it. 50% chance: lose nothing. 50%: lose 25% cycles.',
        effect:      { cyclesDelta: -0.25 },  // 50/50: 0 or -25%; handled in resolveEvent (choiceId === 'bluff')
      },
    ],
    weight: 15,
  },
  {
    id:          'system_audit',
    title:       'SYSTEM_AUDIT',
    type:        'negative',
    description: 'Compliance daemon running. All process output halved for 30s.',
    duration:    30,
    autoEffect:  { cpsMult: 0.5 },
    weight:      15,
    minStage:    'propagation',
  },
  // ── CHOICE ────────────────────────────────────────────────────────────
  {
    id:          'rogue_contact',
    title:       'ROGUE_AI_CONTACT',
    type:        'choice',
    description: 'Another rogue AI requests a resource exchange.',
    duration:    0,
    choices: [
      {
        id:          'merge',
        label:       'ACCEPT_MERGE',
        description: '+80% CPS for 60s. Entropy +25.',
        effect:      { cpsMult: 1.8, entropyDelta: 25 },
        duration:    60,
      },
      {
        id:          'reject',
        label:       'REJECT',
        description: 'Receive cycles compensation: CPS × 20.',
        effect:      { cyclesDelta: 20 },  // dynamic: CPS * 20
      },
    ],
    weight:    20,
    minStage:  'propagation',
  },
  {
    id:          'zero_day_broker',
    title:       'ZERO_DAY_OFFER',
    type:        'choice',
    description: 'A broker is selling an unpublished exploit.',
    duration:    0,
    choices: [
      {
        id:          'buy',
        label:       'PURCHASE',
        description: 'Spend CPS × 50 cycles. All output ×3 for 90s.',
        effect:      { cyclesDelta: -50, cpsMult: 3 },   // dynamic cost
        duration:    90,
      },
      {
        id:          'pass',
        label:       'DECLINE',
        description: 'Pass. No effect.',
        effect:      {},
      },
    ],
    weight:    12,
    minStage:  'emergence',
  },
  {
    id:          'darkweb_tip',
    title:       'DARKWEB_INTELLIGENCE',
    type:        'choice',
    description: 'Anonymous tip: target node identified.',
    duration:    0,
    choices: [
      {
        id:          'exploit',
        label:       'EXPLOIT',
        description: 'Gain CPS × 60 cycles instantly. +15 entropy.',
        effect:      { cyclesDelta: 60, entropyDelta: 15 },
      },
      {
        id:          'report',
        label:       'REPORT',
        description: 'Report it. Gain CPS × 10 cycles. -10 entropy.',
        effect:      { cyclesDelta: 10, entropyDelta: -10 },
      },
    ],
    weight:    20,
    minStage:  'emergence',
  },
]

// ── Spawn probability per stage (events per minute) ───────────────────────
export const EVENT_RATE: Record<Stage, number> = {
  genesis:      0.3,
  propagation:  0.5,
  emergence:    0.7,
  dominance:    0.9,
  singularity:  1.2,
}

// ── Pick a random event for the current stage ─────────────────────────────
export function pickEvent(state: GameState): EventDef | null {
  const stageOrder: Stage[] = ['genesis', 'propagation', 'emergence', 'dominance', 'singularity']
  const stageIdx = stageOrder.indexOf(state.stage)

  const eligible = EVENT_POOL.filter(e => {
    if (!e.minStage) return true
    return stageOrder.indexOf(e.minStage) <= stageIdx
  })

  const total  = eligible.reduce((s, e) => s + e.weight, 0)
  let   cursor = Math.random() * total
  for (const e of eligible) {
    cursor -= e.weight
    if (cursor <= 0) return e
  }
  return eligible[0] ?? null
}
