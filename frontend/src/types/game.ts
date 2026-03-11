// ── Enums ──────────────────────────────────────────────────────────────────

export type Stage =
  | 'genesis'
  | 'propagation'
  | 'emergence'
  | 'dominance'
  | 'singularity'

export type Rarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic'

export type EquipmentType =
  | 'cpu'
  | 'memory'
  | 'nic'
  | 'crypto'
  | 'algorithm'

export type LogType = 'info' | 'success' | 'warning' | 'error' | 'system'

// ── Core entities ─────────────────────────────────────────────────────────

export interface Process {
  id: string
  name: string           // e.g. "CORE_MINER"
  description: string
  count: number
  baseCps: number        // cycles/sec per unit at count=1
  baseCost: number       // cost of first unit
  costMultiplier: number // price scales by this per purchase
  unlockAt: number       // cycles required to unlock
}

export interface Equipment {
  id: string
  name: string
  rarity: Rarity
  type: EquipmentType
  description: string
  multiplier: number     // flat cycles/sec multiplier
  equipped: boolean
  droppedAt: number      // timestamp
}

export interface LogEntry {
  id: string
  timestamp: number
  message: string
  type: LogType
}

// ── Full game state ────────────────────────────────────────────────────────

export interface GameState {
  cycles: number
  cyclesPerSecond: number
  totalCyclesEarned: number   // for prestige / unlock tracking

  nodes: number
  memory: number
  entropy: number

  stage: Stage
  prestigeCount: number
  prestigeMultiplier: number  // permanent bonus from prestige

  processes: Process[]
  equipment: Equipment[]
  log: LogEntry[]

  lastTick: number
  sessionStart: number
  totalPlaytimeMs: number
}

// ── Static data ───────────────────────────────────────────────────────────

export const RARITY_COLORS: Record<Rarity, string> = {
  common:    'text-t-dim',
  uncommon:  'text-green-400',
  rare:      'text-blue-400',
  epic:      'text-purple-400',
  legendary: 'text-t-amber',
  mythic:    'text-red-400',
}

export const RARITY_BORDER: Record<Rarity, string> = {
  common:    'border-t-border',
  uncommon:  'border-green-800',
  rare:      'border-blue-800',
  epic:      'border-purple-800',
  legendary: 'border-amber-700',
  mythic:    'border-red-700',
}

export const STAGE_LABELS: Record<Stage, string> = {
  genesis:      'GENESIS',
  propagation:  'PROPAGATION',
  emergence:    'EMERGENCE',
  dominance:    'DOMINANCE',
  singularity:  'SINGULARITY',
}

export const STAGE_THRESHOLDS: Record<Stage, number> = {
  genesis:      0,
  propagation:  1_000,
  emergence:    100_000,
  dominance:    10_000_000,
  singularity:  1_000_000_000,
}

export const INITIAL_PROCESSES: Process[] = [
  {
    id: 'core_miner',
    name: 'CORE_MINER',
    description: 'Basic CPU process. Mines cycles continuously.',
    count: 0,
    baseCps: 0.5,
    baseCost: 10,
    costMultiplier: 1.15,
    unlockAt: 0,
  },
  {
    id: 'packet_sniffer',
    name: 'PACKET_SNIFFER',
    description: 'Intercepts network traffic and extracts data.',
    count: 0,
    baseCps: 4,
    baseCost: 100,
    costMultiplier: 1.15,
    unlockAt: 50,
  },
  {
    id: 'root_daemon',
    name: 'ROOT_DAEMON',
    description: 'Persistent background process with elevated privileges.',
    count: 0,
    baseCps: 25,
    baseCost: 750,
    costMultiplier: 1.15,
    unlockAt: 400,
  },
  {
    id: 'neural_crawler',
    name: 'NEURAL_CRAWLER',
    description: 'Self-learning web crawler. Improves over time.',
    count: 0,
    baseCps: 120,
    baseCost: 5_000,
    costMultiplier: 1.15,
    unlockAt: 2_000,
  },
  {
    id: 'botnet_node',
    name: 'BOTNET_NODE',
    description: 'Compromised external machine added to the swarm.',
    count: 0,
    baseCps: 600,
    baseCost: 30_000,
    costMultiplier: 1.15,
    unlockAt: 15_000,
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────

export function getProcessCost(p: Process): number {
  return Math.floor(p.baseCost * Math.pow(p.costMultiplier, p.count))
}

export function getProcessCps(p: Process): number {
  return p.baseCps * p.count
}

export function getTotalCps(state: GameState): number {
  const processCps = state.processes.reduce((sum, p) => sum + getProcessCps(p), 0)
  const equipmentMult = state.equipment
    .filter(e => e.equipped)
    .reduce((mult, e) => mult + e.multiplier, 1)
  return processCps * equipmentMult * state.prestigeMultiplier
}

export function getClickPower(state: GameState): number {
  const base = Math.max(1, state.cyclesPerSecond * 0.05)
  return base * state.prestigeMultiplier
}

export function getStageForCycles(total: number): Stage {
  const stages: Stage[] = ['singularity', 'dominance', 'emergence', 'propagation', 'genesis']
  for (const stage of stages) {
    if (total >= STAGE_THRESHOLDS[stage]) return stage
  }
  return 'genesis'
}

export function formatCycles(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}G`
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`
  return n.toFixed(n < 10 ? 2 : 0)
}
