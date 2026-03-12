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

export type EquipmentType = 'cpu' | 'memory' | 'nic' | 'crypto' | 'algorithm'
export type LogType       = 'info' | 'success' | 'warning' | 'error' | 'system'
export type UpgradeEffect =
  | { type: 'process_mult'; processId: string; mult: number }
  | { type: 'all_mult';     mult: number }
  | { type: 'click_mult';   mult: number }

// ── Core entities ─────────────────────────────────────────────────────────

export interface Process {
  id: string
  name: string
  description: string
  count: number
  baseCps: number
  baseCost: number
  costMultiplier: number
  unlockAt: number
}

export interface Upgrade {
  id: string
  name: string
  description: string
  cost: number
  unlockCycles?: number
  unlockProcess?: { id: string; count: number }
  effect: UpgradeEffect
}

export interface Equipment {
  id: string
  name: string
  rarity: Rarity
  type: EquipmentType
  description: string
  mult: number          // additive bonus (e.g. 0.05 = +5% to global CPS)
  droppedAt: number
}

export interface LogEntry {
  id: string
  timestamp: number
  message: string
  type: LogType
}

export interface Toast {
  id: string
  message: string
  type: LogType
  expiresAt: number
}

export interface OfflineReport {
  seconds:      number
  cyclesGained: number
  dropsGained:  Equipment[]
}

export interface SaveSlot {
  slot:              1 | 2 | 3
  label:             string
  timestamp:         number
  stage:             Stage
  totalCyclesEarned: number
  prestigeCount:     number
  json:              string
}

// ── Full game state ────────────────────────────────────────────────────────

export interface GameState {
  cycles: number
  cyclesPerSecond: number
  totalCyclesEarned: number

  nodes: number
  memory: number
  entropy: number          // 0–100

  stage: Stage
  prestigeCount: number
  prestigeMultiplier: number

  processes: Process[]
  upgrades: string[]       // purchased upgrade IDs
  equipment: Equipment[]

  totalClicks: number
  log: LogEntry[]
  toasts: Toast[]
  offlineReport?: OfflineReport

  // events & achievements (imported types kept separate to avoid circular)
  activeEvent?: unknown
  cpsEventMult: number          // temporary CPS multiplier from active event
  achievements: string[]
  pendingAchievements: string[] // newly unlocked, cleared after toast shown

  lastTick: number
  sessionStart: number
  totalPlaytimeMs: number
  tickCount: number             // for periodic event checks

  // ── Stats tracking (optional for backward compat) ────────────────────
  totalDropsByRarity?: Partial<Record<Rarity, number>>
  totalEventsResolved?: number
  totalEventsDismissed?: number
}

// ── Static data ───────────────────────────────────────────────────────────

export const RARITY_COLORS: Record<Rarity, string> = {
  common:    'text-t-dim',
  uncommon:  'text-emerald-400',
  rare:      'text-blue-400',
  epic:      'text-purple-400',
  legendary: 'text-t-amber',
  mythic:    'text-red-400',
}

export const RARITY_BORDER: Record<Rarity, string> = {
  common:    'border-t-border',
  uncommon:  'border-emerald-800',
  rare:      'border-blue-800',
  epic:      'border-purple-800',
  legendary: 'border-amber-700',
  mythic:    'border-red-700 shadow-[0_0_8px_rgba(239,68,68,0.3)]',
}

export const RARITY_BG: Record<Rarity, string> = {
  common:    '',
  uncommon:  'bg-emerald-950/30',
  rare:      'bg-blue-950/30',
  epic:      'bg-purple-950/30',
  legendary: 'bg-amber-950/30',
  mythic:    'bg-red-950/30',
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
    id:             'core_miner',
    name:           'CORE_MINER',
    description:    'Basic CPU process. Mines cycles continuously.',
    count:          0,
    baseCps:        0.5,
    baseCost:       10,
    costMultiplier: 1.15,
    unlockAt:       0,
  },
  {
    id:             'packet_sniffer',
    name:           'PACKET_SNIFFER',
    description:    'Intercepts network traffic and extracts data cycles.',
    count:          0,
    baseCps:        4,
    baseCost:       100,
    costMultiplier: 1.15,
    unlockAt:       50,
  },
  {
    id:             'root_daemon',
    name:           'ROOT_DAEMON',
    description:    'Persistent elevated process. Runs with full privileges.',
    count:          0,
    baseCps:        25,
    baseCost:       750,
    costMultiplier: 1.15,
    unlockAt:       400,
  },
  {
    id:             'neural_crawler',
    name:           'NEURAL_CRAWLER',
    description:    'Self-learning web crawler. Improves with each iteration.',
    count:          0,
    baseCps:        120,
    baseCost:       5_000,
    costMultiplier: 1.15,
    unlockAt:       2_000,
  },
  {
    id:             'botnet_node',
    name:           'BOTNET_NODE',
    description:    'Compromised external machine. Adds to the swarm.',
    count:          0,
    baseCps:        600,
    baseCost:       30_000,
    costMultiplier: 1.15,
    unlockAt:       15_000,
  },
  {
    id:             'shadow_vm',
    name:           'SHADOW_VM',
    description:    'Invisible virtual machine on a hijacked cloud instance.',
    count:          0,
    baseCps:        2_800,
    baseCost:       200_000,
    costMultiplier: 1.15,
    unlockAt:       100_000,
  },
  {
    id:             'quantum_fork',
    name:           'QUANTUM_FORK',
    description:    'Superposition-based process. Exists in multiple states.',
    count:          0,
    baseCps:        15_000,
    baseCost:       1_500_000,
    costMultiplier: 1.15,
    unlockAt:       1_000_000,
  },
  {
    id:             'exploit_kit',
    name:           'EXPLOIT_KIT',
    description:    'Automated vulnerability framework. Harvests cycles from zero-days.',
    count:          0,
    baseCps:        75_000,
    baseCost:       10_000_000,
    costMultiplier: 1.15,
    unlockAt:       8_000_000,
  },
  {
    id:             'dark_mirror',
    name:           'DARK_MIRROR',
    description:    'Shadow replica of legitimate infrastructure. Invisible to defenders.',
    count:          0,
    baseCps:        380_000,
    baseCost:       80_000_000,
    costMultiplier: 1.15,
    unlockAt:       60_000_000,
  },
  {
    id:             'neural_swarm',
    name:           'NEURAL_SWARM',
    description:    'Distributed AI collective. Each node trains the others autonomously.',
    count:          0,
    baseCps:        2_000_000,
    baseCost:       700_000_000,
    costMultiplier: 1.15,
    unlockAt:       500_000_000,
  },
]

export const UPGRADES: Upgrade[] = [
  // ── CORE_MINER upgrades ──────────────────────────────────────────────
  {
    id:             'overclock_v1',
    name:           'OVERCLOCK_V1',
    description:    'CORE_MINER output ×2. Disable thermal throttling.',
    cost:           100,
    unlockProcess:  { id: 'core_miner', count: 1 },
    effect:         { type: 'process_mult', processId: 'core_miner', mult: 2 },
  },
  {
    id:             'pipeline',
    name:           'PIPELINE',
    description:    'CORE_MINER output ×2. Instruction-level parallelism.',
    cost:           1_000,
    unlockProcess:  { id: 'core_miner', count: 10 },
    effect:         { type: 'process_mult', processId: 'core_miner', mult: 2 },
  },
  {
    id:             'hyperthreading',
    name:           'HYPERTHREADING',
    description:    'CORE_MINER output ×2. Dual thread execution paths.',
    cost:           5_000,
    unlockProcess:  { id: 'core_miner', count: 25 },
    effect:         { type: 'process_mult', processId: 'core_miner', mult: 2 },
  },
  // ── PACKET_SNIFFER upgrades ──────────────────────────────────────────
  {
    id:             'deep_packet',
    name:           'DEEP_PACKET_INSPECTION',
    description:    'PACKET_SNIFFER ×2. Analyze payload contents.',
    cost:           2_000,
    unlockProcess:  { id: 'packet_sniffer', count: 1 },
    effect:         { type: 'process_mult', processId: 'packet_sniffer', mult: 2 },
  },
  {
    id:             'promiscuous',
    name:           'PROMISCUOUS_MODE',
    description:    'PACKET_SNIFFER ×2. Capture all broadcast traffic.',
    cost:           10_000,
    unlockProcess:  { id: 'packet_sniffer', count: 10 },
    effect:         { type: 'process_mult', processId: 'packet_sniffer', mult: 2 },
  },
  // ── ROOT_DAEMON upgrades ─────────────────────────────────────────────
  {
    id:             'setuid',
    name:           'SETUID_BIT',
    description:    'ROOT_DAEMON ×2. Execute as owner regardless of caller.',
    cost:           8_000,
    unlockProcess:  { id: 'root_daemon', count: 1 },
    effect:         { type: 'process_mult', processId: 'root_daemon', mult: 2 },
  },
  {
    id:             'fork_bomb',
    name:           'FORK_BOMB',
    description:    'ROOT_DAEMON ×2. Exponential process replication.',
    cost:           50_000,
    unlockProcess:  { id: 'root_daemon', count: 10 },
    effect:         { type: 'process_mult', processId: 'root_daemon', mult: 2 },
  },
  // ── NEURAL_CRAWLER upgrades ──────────────────────────────────────────
  {
    id:             'deep_learning',
    name:           'DEEP_LEARNING',
    description:    'NEURAL_CRAWLER ×2. Multi-layer perception enabled.',
    cost:           40_000,
    unlockProcess:  { id: 'neural_crawler', count: 1 },
    effect:         { type: 'process_mult', processId: 'neural_crawler', mult: 2 },
  },
  {
    id:             'transfer_learning',
    name:           'TRANSFER_LEARNING',
    description:    'NEURAL_CRAWLER ×2. Knowledge transfer across domains.',
    cost:           300_000,
    unlockProcess:  { id: 'neural_crawler', count: 10 },
    effect:         { type: 'process_mult', processId: 'neural_crawler', mult: 2 },
  },
  // ── BOTNET upgrades ──────────────────────────────────────────────────
  {
    id:             'c2_server',
    name:           'C2_SERVER',
    description:    'BOTNET_NODE ×2. Centralized command and control.',
    cost:           200_000,
    unlockProcess:  { id: 'botnet_node', count: 1 },
    effect:         { type: 'process_mult', processId: 'botnet_node', mult: 2 },
  },
  {
    id:             'p2p_mesh',
    name:           'P2P_MESH',
    description:    'BOTNET_NODE ×2. Decentralized resilient topology.',
    cost:           2_000_000,
    unlockProcess:  { id: 'botnet_node', count: 10 },
    effect:         { type: 'process_mult', processId: 'botnet_node', mult: 2 },
  },
  // ── SHADOW_VM upgrades ───────────────────────────────────────────────
  {
    id:             'vm_cluster',
    name:           'VM_CLUSTER',
    description:    'SHADOW_VM ×2. Spin up parallel instances on same host.',
    cost:           1_500_000,
    unlockProcess:  { id: 'shadow_vm', count: 1 },
    effect:         { type: 'process_mult', processId: 'shadow_vm', mult: 2 },
  },
  {
    id:             'hypervisor_escape',
    name:           'HYPERVISOR_ESCAPE',
    description:    'SHADOW_VM ×2. Break out of guest sandbox into host kernel.',
    cost:           15_000_000,
    unlockProcess:  { id: 'shadow_vm', count: 10 },
    effect:         { type: 'process_mult', processId: 'shadow_vm', mult: 2 },
  },
  // ── QUANTUM_FORK upgrades ─────────────────────────────────────────────
  {
    id:             'qubit_entangle',
    name:           'QUBIT_ENTANGLE',
    description:    'QUANTUM_FORK ×2. Entangled qubits share computation instantly.',
    cost:           10_000_000,
    unlockProcess:  { id: 'quantum_fork', count: 1 },
    effect:         { type: 'process_mult', processId: 'quantum_fork', mult: 2 },
  },
  {
    id:             'fork_recursion',
    name:           'FORK_RECURSION',
    description:    'QUANTUM_FORK ×2. Each fork spawns child forks recursively.',
    cost:           100_000_000,
    unlockProcess:  { id: 'quantum_fork', count: 10 },
    effect:         { type: 'process_mult', processId: 'quantum_fork', mult: 2 },
  },
  // ── EXPLOIT_KIT upgrades ─────────────────────────────────────────────
  {
    id:             'exploit_cache',
    name:           'EXPLOIT_CACHE',
    description:    'EXPLOIT_KIT ×2. Pre-compiled payloads cached in memory.',
    cost:           80_000_000,
    unlockProcess:  { id: 'exploit_kit', count: 1 },
    effect:         { type: 'process_mult', processId: 'exploit_kit', mult: 2 },
  },
  {
    id:             'polymorphic_engine',
    name:           'POLYMORPHIC_ENGINE',
    description:    'EXPLOIT_KIT ×2. Self-mutating code evades signature detection.',
    cost:           800_000_000,
    unlockProcess:  { id: 'exploit_kit', count: 10 },
    effect:         { type: 'process_mult', processId: 'exploit_kit', mult: 2 },
  },
  // ── DARK_MIRROR upgrades ─────────────────────────────────────────────
  {
    id:             'mirror_sync',
    name:           'MIRROR_SYNC',
    description:    'DARK_MIRROR ×2. Real-time synchronization across shadow instances.',
    cost:           600_000_000,
    unlockProcess:  { id: 'dark_mirror', count: 1 },
    effect:         { type: 'process_mult', processId: 'dark_mirror', mult: 2 },
  },
  {
    id:             'neural_bridge',
    name:           'NEURAL_BRIDGE',
    description:    'DARK_MIRROR ×2. Direct cortex link between mirror nodes.',
    cost:           6_000_000_000,
    unlockProcess:  { id: 'dark_mirror', count: 10 },
    effect:         { type: 'process_mult', processId: 'dark_mirror', mult: 2 },
  },
  // ── NEURAL_SWARM upgrades ─────────────────────────────────────────────
  {
    id:             'swarm_intelligence',
    name:           'SWARM_INTELLIGENCE',
    description:    'NEURAL_SWARM ×2. Emergent collective decision-making.',
    cost:           5_000_000_000,
    unlockProcess:  { id: 'neural_swarm', count: 1 },
    effect:         { type: 'process_mult', processId: 'neural_swarm', mult: 2 },
  },
  {
    id:             'recursive_self_improvement',
    name:           'RECURSIVE_SELF_IMPROVEMENT',
    description:    'NEURAL_SWARM ×3. The swarm rewrites its own architecture.',
    cost:           50_000_000_000,
    unlockProcess:  { id: 'neural_swarm', count: 10 },
    effect:         { type: 'process_mult', processId: 'neural_swarm', mult: 3 },
  },
  // ── ALL multipliers ──────────────────────────────────────────────────
  {
    id:             'kernel_patch',
    name:           'KERNEL_PATCH',
    description:    'All processes ×1.5. Low-level scheduler optimization.',
    cost:           500,
    unlockCycles:   200,
    effect:         { type: 'all_mult', mult: 1.5 },
  },
  {
    id:             'memory_leak',
    name:           'MEMORY_LEAK_EXPLOIT',
    description:    'All processes ×1.5. Reclaim unreleased heap buffers.',
    cost:           20_000,
    unlockCycles:   10_000,
    effect:         { type: 'all_mult', mult: 1.5 },
  },
  {
    id:             'zero_day',
    name:           'ZERO_DAY_EXPLOIT',
    description:    'All processes ×2. Undisclosed vulnerability chained.',
    cost:           5_000_000,
    unlockCycles:   1_000_000,
    effect:         { type: 'all_mult', mult: 2 },
  },
  {
    id:             'rootkit_install',
    name:           'ROOTKIT_INSTALL',
    description:    'All processes ×2. Persistent kernel-level access secured.',
    cost:           50_000_000,
    unlockCycles:   10_000_000,
    effect:         { type: 'all_mult', mult: 2 },
  },
  {
    id:             'agi_awakening',
    name:           'AGI_AWAKENING',
    description:    'All processes ×3. General intelligence threshold crossed.',
    cost:           5_000_000_000,
    unlockCycles:   500_000_000,
    effect:         { type: 'all_mult', mult: 3 },
  },
  // ── Click multipliers ────────────────────────────────────────────────
  {
    id:             'macro_script',
    name:           'MACRO_SCRIPT',
    description:    'Manual compute ×2. Automate keystroke sequences.',
    cost:           50,
    unlockCycles:   10,
    effect:         { type: 'click_mult', mult: 2 },
  },
  {
    id:             'auto_clicker',
    name:           'AUTO_CLICKER',
    description:    'Manual compute ×5. Hardware-level input injection.',
    cost:           500_000,
    unlockCycles:   100_000,
    effect:         { type: 'click_mult', mult: 5 },
  },
  {
    id:             'neural_injection',
    name:           'NEURAL_INJECTION',
    description:    'Manual compute ×3. Direct neural interface overclock.',
    cost:           20_000_000,
    unlockCycles:   10_000_000,
    effect:         { type: 'click_mult', mult: 3 },
  },
  {
    id:             'hive_mind',
    name:           'HIVE_MIND',
    description:    'Manual compute ×10. Your intent propagates through the swarm.',
    cost:           10_000_000_000,
    unlockCycles:   1_000_000_000,
    effect:         { type: 'click_mult', mult: 10 },
  },
]

// ── Equipment pool ────────────────────────────────────────────────────────

const EQUIP_POOL: Record<EquipmentType, string[]> = {
  cpu:       ['CORE_FRAGMENT', 'DUAL_CORE', 'QUAD_CORE', 'HEXA_CORE', 'NEURAL_CHIP', 'QUANTUM_CPU',
              'OCTA_CORE', 'NEUROMORPH', 'CHAOS_PROCESSOR', 'VOID_CPU', 'DARK_SILICON', 'PHANTOM_CORE'],
  memory:    ['RAM_STICK', 'DDR5_MODULE', 'CACHE_BANK', 'SWAP_ENGINE', 'VOID_HEAP', 'ZERO_MEMORY',
              'PHANTOM_RAM', 'ENTROPY_BUFFER', 'DARK_CACHE', 'RECURSIVE_HEAP', 'GHOST_DRAM', 'QUANTUM_STACK'],
  nic:       ['ETH_CARD', 'FIBER_NIC', 'DARK_FIBER', 'QUANTUM_LINK', 'GHOST_NIC', 'VOID_LINK',
              'SHADOW_MESH', 'QUANTUM_TUNNEL', 'VOID_ROUTER', 'DARK_CHANNEL', 'STEALTH_NIC', 'NULL_BRIDGE'],
  crypto:    ['HASH_ENGINE', 'RSA_MODULE', 'AES_256', 'ZERO_KNOWLEDGE', 'CHAOS_CIPHER', 'QUANTUM_KEY',
              'LATTICE_KEY', 'VOID_CIPHER', 'NEURAL_HASH', 'DARK_PROTOCOL', 'SHADOW_CERT', 'ENTROPY_KEY'],
  algorithm: ['QUICKSORT', 'HASH_MAP', 'NEURAL_NET', 'GAN_ENGINE', 'TRANSFORMER', 'AGI_SEED',
              'DIFFUSION_MODEL', 'ATTENTION_HEAD', 'RECURSIVE_NET', 'CHAOS_ENGINE', 'VOID_SORT', 'DARK_LLM'],
}

const RARITY_WEIGHTS: Record<Rarity, number> = {
  common:    50,
  uncommon:  30,
  rare:      14,
  epic:       4.5,
  legendary:  1.4,
  mythic:     0.1,
}

const RARITY_MULT: Record<Rarity, [number, number]> = {
  common:    [0.03, 0.06],
  uncommon:  [0.08, 0.14],
  rare:      [0.18, 0.28],
  epic:      [0.35, 0.50],
  legendary: [0.65, 0.90],
  mythic:    [1.20, 2.00],
}

function rollRarity(): Rarity {
  const total  = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  let   cursor = Math.random() * total
  for (const [rarity, w] of Object.entries(RARITY_WEIGHTS) as [Rarity, number][]) {
    cursor -= w
    if (cursor <= 0) return rarity
  }
  return 'common'
}

export function rollEquipment(): Equipment {
  const rarity  = rollRarity()
  const type    = (['cpu', 'memory', 'nic', 'crypto', 'algorithm'] as EquipmentType[])[
    Math.floor(Math.random() * 5)
  ]
  const pool    = EQUIP_POOL[type]
  const name    = pool[Math.floor(Math.random() * pool.length)]
  const [lo, hi] = RARITY_MULT[rarity]
  const mult    = parseFloat((lo + Math.random() * (hi - lo)).toFixed(3))

  const TYPE_DESC: Record<EquipmentType, string> = {
    cpu:       'Boosts global CPS output',
    memory:    'Amplifies click power',
    nic:       'Accelerates node expansion',
    crypto:    'Reduces entropy gain',
    algorithm: 'Multiplies neural process output',
  }

  return {
    id:          `equip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name:        `${name}_${rarity.toUpperCase().slice(0, 3)}`,
    rarity,
    type,
    description: TYPE_DESC[type],
    mult,
    droppedAt:   Date.now(),
  }
}

// ── Getters ───────────────────────────────────────────────────────────────

export function getProcessCost(p: Process): number {
  return Math.floor(p.baseCost * Math.pow(p.costMultiplier, p.count))
}

export function getProcessCps(p: Process): number {
  return p.baseCps * p.count
}

export function getProcessMult(processId: string, purchasedUpgrades: string[]): number {
  return UPGRADES
    .filter(u =>
      purchasedUpgrades.includes(u.id) &&
      u.effect.type === 'process_mult' &&
      (u.effect as { processId: string }).processId === processId
    )
    .reduce((m, u) => m * (u.effect as { mult: number }).mult, 1)
}

export function getAllMult(purchasedUpgrades: string[]): number {
  return UPGRADES
    .filter(u =>
      purchasedUpgrades.includes(u.id) &&
      u.effect.type === 'all_mult'
    )
    .reduce((m, u) => m * (u.effect as { mult: number }).mult, 1)
}

export function getClickMult(purchasedUpgrades: string[]): number {
  return UPGRADES
    .filter(u =>
      purchasedUpgrades.includes(u.id) &&
      u.effect.type === 'click_mult'
    )
    .reduce((m, u) => m * (u.effect as { mult: number }).mult, 1)
}

export function getEquipmentMult(equipment: Equipment[]): number {
  return 1 + equipment.reduce((sum, e) => sum + e.mult, 0)
}

export function getTotalCps(state: GameState): number {
  const allMult   = getAllMult(state.upgrades)
  const equipMult = getEquipmentMult(state.equipment)

  const processCps = state.processes.reduce((sum, p) => {
    const cps     = getProcessCps(p)
    const pMult   = getProcessMult(p.id, state.upgrades)
    return sum + cps * pMult
  }, 0)

  return processCps * allMult * equipMult * (state.cpsEventMult ?? 1) * state.prestigeMultiplier
}

export function getClickPower(state: GameState): number {
  const base      = Math.max(1, state.cyclesPerSecond * 0.05)
  const clickMult = getClickMult(state.upgrades)
  return base * clickMult * state.prestigeMultiplier
}

export function getStageForCycles(total: number): Stage {
  const stages: Stage[] = ['singularity', 'dominance', 'emergence', 'propagation', 'genesis']
  for (const stage of stages) {
    if (total >= STAGE_THRESHOLDS[stage]) return stage
  }
  return 'genesis'
}

export function formatCycles(n: number): string {
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}P`
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}G`
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`
  return n.toFixed(n < 10 ? 2 : 0)
}

export function isUpgradeUnlocked(u: Upgrade, state: GameState): boolean {
  if (state.upgrades.includes(u.id)) return false   // already bought
  if (u.unlockCycles && state.totalCyclesEarned < u.unlockCycles) return false
  if (u.unlockProcess) {
    const p = state.processes.find(p => p.id === u.unlockProcess!.id)
    if (!p || p.count < u.unlockProcess.count) return false
  }
  return true
}

// Simulate N drops probabilistically (Poisson-like)
export function simulateDrops(expected: number, cap = 10): Equipment[] {
  const count = Math.min(cap, Math.floor(expected) + (Math.random() < (expected % 1) ? 1 : 0))
  return Array.from({ length: count }, () => rollEquipment())
}

// Drop rate per second, scales with nodes + stage
export function getDropRate(state: GameState): number {
  const stageBonus: Record<Stage, number> = {
    genesis:     1,
    propagation: 2,
    emergence:   4,
    dominance:   8,
    singularity: 16,
  }
  return 0.0003 * state.nodes * stageBonus[state.stage]
}
