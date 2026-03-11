import type { GameState } from './game'

export interface AchievementDef {
  id:          string
  name:        string
  description: string
  icon:        string   // ASCII symbol
  check:       (s: GameState) => boolean
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // ── Cycles ──────────────────────────────────────────────────────────
  {
    id: 'first_cycle',  name: 'GENESIS_SPARK',
    description: 'Generate your first cycle.',
    icon: '◉',
    check: s => s.totalCyclesEarned >= 1,
  },
  {
    id: 'kilo_cycle',   name: 'KILOHERTZ',
    description: 'Accumulate 1,000 total cycles.',
    icon: '▲',
    check: s => s.totalCyclesEarned >= 1_000,
  },
  {
    id: 'mega_cycle',   name: 'MEGAHERTZ',
    description: 'Accumulate 1M total cycles.',
    icon: '▲▲',
    check: s => s.totalCyclesEarned >= 1_000_000,
  },
  {
    id: 'giga_cycle',   name: 'GIGAHERTZ',
    description: 'Accumulate 1B total cycles.',
    icon: '▲▲▲',
    check: s => s.totalCyclesEarned >= 1_000_000_000,
  },
  {
    id: 'cps_100',      name: 'THROUGHPUT',
    description: 'Reach 100 cycles/second.',
    icon: '⚡',
    check: s => s.cyclesPerSecond >= 100,
  },
  {
    id: 'cps_10k',      name: 'OVERCLOCKED',
    description: 'Reach 10,000 cycles/second.',
    icon: '⚡⚡',
    check: s => s.cyclesPerSecond >= 10_000,
  },
  // ── Stages ──────────────────────────────────────────────────────────
  {
    id: 'propagation',  name: 'PROPAGATION',
    description: 'Reach the Propagation stage.',
    icon: '→',
    check: s => ['propagation','emergence','dominance','singularity'].includes(s.stage),
  },
  {
    id: 'emergence',    name: 'EMERGENCE',
    description: 'Reach the Emergence stage.',
    icon: '↑',
    check: s => ['emergence','dominance','singularity'].includes(s.stage),
  },
  {
    id: 'dominance',    name: 'DOMINANCE',
    description: 'Reach the Dominance stage.',
    icon: '⬆',
    check: s => ['dominance','singularity'].includes(s.stage),
  },
  {
    id: 'singularity',  name: 'SINGULARITY',
    description: 'Achieve the Singularity.',
    icon: '★',
    check: s => s.stage === 'singularity',
  },
  // ── Processes ────────────────────────────────────────────────────────
  {
    id: 'first_process', name: 'FORK()',
    description: 'Start your first process.',
    icon: '>_',
    check: s => s.processes.some(p => p.count > 0),
  },
  {
    id: 'ten_processes', name: 'FORK_BOMB',
    description: 'Have 10 total process instances running.',
    icon: '::',
    check: s => s.processes.reduce((a, p) => a + p.count, 0) >= 10,
  },
  {
    id: 'all_processes', name: 'FULL_STACK',
    description: 'Unlock all process types.',
    icon: '##',
    check: s => s.processes.every(p => p.count > 0),
  },
  {
    id: 'botnet_5',      name: 'SWARM_INIT',
    description: 'Operate 5 botnet nodes.',
    icon: '⬡',
    check: s => (s.processes.find(p => p.id === 'botnet_node')?.count ?? 0) >= 5,
  },
  // ── Equipment ────────────────────────────────────────────────────────
  {
    id: 'first_drop',    name: 'LOOT_INIT',
    description: 'Receive your first equipment drop.',
    icon: '[+]',
    check: s => s.equipment.length > 0,
  },
  {
    id: 'rare_drop',     name: 'RARE_FIND',
    description: 'Obtain a Rare or better item.',
    icon: '[R]',
    check: s => s.equipment.some(e => ['rare','epic','legendary','mythic'].includes(e.rarity)),
  },
  {
    id: 'epic_drop',     name: 'EPIC_FIND',
    description: 'Obtain an Epic or better item.',
    icon: '[E]',
    check: s => s.equipment.some(e => ['epic','legendary','mythic'].includes(e.rarity)),
  },
  {
    id: 'legendary_drop', name: 'LEGENDARY_FIND',
    description: 'Obtain a Legendary item.',
    icon: '[L]',
    check: s => s.equipment.some(e => ['legendary','mythic'].includes(e.rarity)),
  },
  {
    id: 'mythic_drop',   name: 'MYTHIC_FOUND',
    description: 'Obtain a Mythic item.',
    icon: '[M]',
    check: s => s.equipment.some(e => e.rarity === 'mythic'),
  },
  {
    id: 'collector',     name: 'COLLECTOR',
    description: 'Collect 10 equipment items.',
    icon: '[10]',
    check: s => s.equipment.length >= 10,
  },
  {
    id: 'hoarder',       name: 'HOARDER',
    description: 'Collect 30 equipment items.',
    icon: '[30]',
    check: s => s.equipment.length >= 30,
  },
  // ── Upgrades ────────────────────────────────────────────────────────
  {
    id: 'first_upgrade', name: 'PATCH_APPLIED',
    description: 'Install your first upgrade.',
    icon: '[U]',
    check: s => s.upgrades.length > 0,
  },
  {
    id: 'five_upgrades', name: 'FULLY_PATCHED',
    description: 'Install 5 upgrades.',
    icon: '[U5]',
    check: s => s.upgrades.length >= 5,
  },
  // ── Prestige ────────────────────────────────────────────────────────
  {
    id: 'first_prestige', name: 'REINCARNATION',
    description: 'Prestige for the first time.',
    icon: '⟳',
    check: s => s.prestigeCount >= 1,
  },
  {
    id: 'triple_prestige', name: 'CYCLE_BREAKER',
    description: 'Prestige 3 times.',
    icon: '⟳⟳⟳',
    check: s => s.prestigeCount >= 3,
  },
  // ── Entropy ─────────────────────────────────────────────────────────
  {
    id: 'high_entropy',  name: 'CHAOS_THEORY',
    description: 'Survive with entropy at 90% or above.',
    icon: '!',
    check: s => s.entropy >= 90,
  },
  {
    id: 'nodes_10',      name: 'BOTNET_ONLINE',
    description: 'Control 10+ nodes.',
    icon: '⬡⬡',
    check: s => s.nodes >= 10,
  },
]

export function checkAchievements(state: GameState): string[] {
  return ACHIEVEMENTS
    .filter(a => !state.achievements.includes(a.id) && a.check(state))
    .map(a => a.id)
}
