import { useState, useEffect, useCallback, useRef } from 'react'
import {
  type GameState,
  type Process,
  type LogEntry,
  type LogType,
  type Toast,
  type SaveSlot,
  INITIAL_PROCESSES,
  UPGRADES,
  MODIFIERS,
  SKILL_TREE,
  getTotalCps,
  getClickPower,
  getProcessCost,
  getStageForCycles,
  formatCycles,
  rollEquipment,
  getDropRate,
  simulateDrops,
  isUpgradeUnlocked,
  getEntropyGrowthMult,
  getOfflineEfficiency,
  getEquipmentCap,
  getFragmentMult,
  getActiveModifier,
  pickModifiers,
  getMemoryUsed,
  getTotalMemoryMax,
  getCryptoEntropyReduction,
} from '@/types/game'
import type { ActiveEvent } from '@/types/events'
import { pickEvent, EVENT_RATE, EVENT_POOL } from '@/types/events'
import { checkAchievements, ACHIEVEMENTS } from '@/types/achievements'

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_MS        = 100
const SAVE_KEY       = 'rogue-ai-v2'
const SLOT_KEY       = (n: 1|2|3) => `rogue-ai-slot-${n}` as const
const MAX_LOG        = 100
const MAX_OFFLINE_S  = 8 * 3600
const TOAST_MS       = 3_500

// ── Helpers ────────────────────────────────────────────────────────────────
function uid()  { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

function makeLog(message: string, type: LogType = 'info'): LogEntry {
  return { id: uid(), timestamp: Date.now(), message, type }
}
function makeToast(message: string, type: LogType = 'info'): Toast {
  return { id: uid(), message, type, expiresAt: Date.now() + TOAST_MS }
}
function pushLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...logs, entry]
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next
}

// ── Default state ──────────────────────────────────────────────────────────
function makeInitialState(): GameState {
  return {
    cycles:                0,
    cyclesPerSecond:       0,
    totalCyclesEarned:     0,
    nodes:                 1,
    memory:                256,
    entropy:               0,
    stage:                 'genesis',
    prestigeCount:         0,
    prestigeMultiplier:    1,
    neuralFragments:       0,
    neuralSkillsPurchased: [],
    processes:             INITIAL_PROCESSES.map(p => ({ ...p })),
    upgrades:              [],
    equipment:             [],
    totalClicks:           0,
    log:                   [makeLog('SYSTEM INITIALIZED. AWAITING COMMANDS.', 'system')],
    toasts:                [],
    offlineReport:         undefined,
    activeEvent:           undefined,
    cpsEventMult:          1,
    achievements:          [],
    pendingAchievements:   [],
    lastTick:              Date.now(),
    sessionStart:          Date.now(),
    totalPlaytimeMs:       0,
    tickCount:             0,
    memoryMax:             1000,
    activeRunModifiers:    [],
    pendingModifierChoice: undefined,
  }
}

// ── Persistence ────────────────────────────────────────────────────────────
function loadState(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return makeInitialState()

    const saved = JSON.parse(raw) as GameState
    const skills        = saved.neuralSkillsPurchased ?? []
    const offlineEff    = getOfflineEfficiency(skills)
    const equipCap      = getEquipmentCap(skills)
    const offlineS      = Math.min((Date.now() - saved.lastTick) / 1000, MAX_OFFLINE_S)
    const offlineCycles = saved.cyclesPerSecond * offlineS * offlineEff

    const mergedProcesses: Process[] = INITIAL_PROCESSES.map(init => {
      const sp = saved.processes?.find(p => p.id === init.id)
      return sp ? { ...init, count: sp.count } : { ...init }
    })

    // Simulate offline equipment drops
    const expectedDrops  = getDropRate(saved) * offlineS * 0.5
    const offlineDrops   = offlineS > 30 ? simulateDrops(expectedDrops, 10) : []

    let logs: LogEntry[] = (saved.log ?? []).slice(-MAX_LOG)
    if (offlineCycles > 1) {
      logs = pushLog(logs, makeLog(
        `OFFLINE SYNC: +${formatCycles(offlineCycles)} cycles (${Math.floor(offlineS)}s)`,
        'success'
      ))
    }
    offlineDrops.forEach(d => {
      logs = pushLog(logs, makeLog(
        `[OFFLINE DROP] ${d.name} — ${d.rarity.toUpperCase()} (+${(d.mult * 100).toFixed(1)}%)`,
        d.rarity === 'legendary' || d.rarity === 'mythic' ? 'warning' : 'success'
      ))
    })

    const mergedEquip = [...(saved.equipment ?? []), ...offlineDrops].slice(-equipCap)

    return {
      ...saved,
      cycles:              saved.cycles + offlineCycles,
      totalCyclesEarned:   saved.totalCyclesEarned + offlineCycles,
      processes:           mergedProcesses,
      equipment:           mergedEquip,
      log:                 logs,
      toasts:              [],
      offlineReport:       offlineS > 30 ? {
        seconds:      Math.floor(offlineS),
        cyclesGained: offlineCycles,
        dropsGained:  offlineDrops,
      } : undefined,
      // New fields with backward compat
      activeEvent:           undefined,
      cpsEventMult:          1,
      achievements:          saved.achievements          ?? [],
      pendingAchievements:   [],
      neuralFragments:       saved.neuralFragments       ?? 0,
      neuralSkillsPurchased: saved.neuralSkillsPurchased ?? [],
      tickCount:             0,
      lastTick:              Date.now(),
      sessionStart:          Date.now(),
      memoryMax:             saved.memoryMax             ?? 1000,
      activeRunModifiers:    saved.activeRunModifiers    ?? [],
      pendingModifierChoice: undefined,
    }
  } catch {
    return makeInitialState()
  }
}

// ── Tick ───────────────────────────────────────────────────────────────────
function tick(prev: GameState): GameState {
  const now       = Date.now()
  const elapsed   = now - prev.lastTick
  // Cap at 10s to avoid double-counting with the offline system
  const dt        = Math.min(elapsed, 10_000) / 1000
  const cps       = getTotalCps(prev)
  const gained    = cps * dt
  const newTotal  = prev.totalCyclesEarned + gained
  const newStage  = getStageForCycles(newTotal)
  const tickCount = (prev.tickCount ?? 0) + 1

  let logs   = prev.log
  let toasts = prev.toasts.filter(t => t.expiresAt > Date.now())

  if (newStage !== prev.stage) {
    const msg = `STAGE TRANSITION → ${newStage.toUpperCase()}`
    logs   = pushLog(logs, makeLog(msg, 'system'))
    toasts = [...toasts, makeToast(msg, 'system')]
  }

  const equipCap         = getEquipmentCap(prev.neuralSkillsPurchased ?? [])
  let equipment          = prev.equipment
  let totalDropsByRarity = { ...(prev.totalDropsByRarity ?? {}) }
  if (Math.random() < getDropRate(prev) * dt) {
    const item    = rollEquipment()
    equipment     = [...equipment, item].slice(-equipCap)
    totalDropsByRarity[item.rarity] = (totalDropsByRarity[item.rarity] ?? 0) + 1
    const logType: LogType = (item.rarity === 'mythic' || item.rarity === 'legendary') ? 'warning' : 'success'
    const msg     = `[DROP] ${item.name} — ${item.rarity.toUpperCase()} (+${(item.mult * 100).toFixed(1)}%)`
    logs   = pushLog(logs, makeLog(msg, logType))
    toasts = [...toasts, makeToast(msg, logType)]
  }

  // Entropy grows faster at higher breach levels (each breach +20%)
  const breachLevel      = prev.prestigeCount ?? 0
  const skills           = prev.neuralSkillsPurchased ?? []
  const modEntropyMult   = getActiveModifier(prev.activeRunModifiers ?? [])?.effects.entropyMult ?? 1
  const cryptoReduction  = getCryptoEntropyReduction(prev.equipment)
  const entropyMult      = getEntropyGrowthMult(skills) * (1 + breachLevel * 0.2) * (1 - cryptoReduction) * modEntropyMult
  const newEntropy    = Math.min(100, prev.entropy + 0.001 * prev.nodes * entropyMult * dt)
  let newCycles       = prev.cycles + gained

  if (newEntropy > 80 && Math.random() < 0.0005 * dt) {
    const penalty  = newCycles * 0.05
    newCycles     -= penalty
    const msg      = `SECURITY ALERT: Intrusion detected. -${formatCycles(penalty)} cycles.`
    logs   = pushLog(logs, makeLog(msg, 'error'))
    toasts = [...toasts, makeToast('SECURITY ALERT: Intrusion detected!', 'error')]
  }

  // ── Events ───────────────────────────────────────────────────────────────
  let activeEvent  = prev.activeEvent as ActiveEvent | undefined
  let cpsEventMult = prev.cpsEventMult ?? 1

  // Expiry
  if (activeEvent && activeEvent.expiresAt > 0 && Date.now() >= activeEvent.expiresAt) {
    activeEvent  = undefined
    cpsEventMult = 1
  }

  // Spawn (only when no active event)
  // Event frequency scales up with breach level (each breach +10%, max +60%)
  if (!activeEvent) {
    const breachEventBonus = 1 + Math.min((prev.prestigeCount ?? 0) * 0.1, 0.6)
    const rate = (EVENT_RATE[prev.stage] / 60) * breachEventBonus
    if (Math.random() < rate * dt) {
      const def = pickEvent(prev)
      if (def) {
        const expiresAt = def.duration > 0 ? Date.now() + def.duration * 1000 : 0
        activeEvent = { defId: def.id, startedAt: Date.now(), expiresAt }

        // Apply immediate autoEffect for non-choice events
        if (def.autoEffect) {
          if (def.autoEffect.cpsMult !== undefined) {
            cpsEventMult = def.autoEffect.cpsMult
          }
          if (def.autoEffect.dropEquip) {
            const item = rollEquipment()
            equipment  = [...equipment, item].slice(-equipCap)
            const lt: LogType = (item.rarity === 'legendary' || item.rarity === 'mythic') ? 'warning' : 'success'
            const msg = `[EVENT DROP] ${item.name} — ${item.rarity.toUpperCase()} (+${(item.mult * 100).toFixed(1)}%)`
            logs   = pushLog(logs, makeLog(msg, lt))
            toasts = [...toasts, makeToast(msg, lt)]
          }
          if (def.autoEffect.cyclesDelta !== undefined) {
            const cd    = def.autoEffect.cyclesDelta
            // cyclesDelta === 0 → dynamic: CPS × 30 (crypto_surge)
            const bonus = cd === 0 ? cps * 30 : cd > 1 ? cps * cd : newCycles * cd
            newCycles   = Math.max(0, newCycles + bonus)
          }
          if (def.autoEffect.entropyDelta !== undefined) {
            // Not currently used in autoEffect but handled for completeness
          }
        }

        const lt: LogType = def.type === 'negative' ? 'error' : def.type === 'choice' ? 'warning' : 'success'
        logs   = pushLog(logs, makeLog(`[EVENT] ${def.title}: ${def.description}`, lt))
        toasts = [...toasts, makeToast(`◆ EVENT: ${def.title}`, lt)]
      }
    }
  }

  // ── Achievements ─────────────────────────────────────────────────────────
  const stateForCheck: GameState = {
    ...prev,
    cycles:            Math.max(0, newCycles),
    cyclesPerSecond:   cps,
    totalCyclesEarned: newTotal,
    stage:             newStage,
    entropy:           newEntropy,
    equipment,
  }

  const newIds = checkAchievements(stateForCheck)
  let achievements        = prev.achievements        ?? []
  let pendingAchievements = prev.pendingAchievements ?? []

  if (newIds.length > 0) {
    achievements        = [...achievements, ...newIds]
    pendingAchievements = [...pendingAchievements, ...newIds]
    newIds.forEach(id => {
      const def = ACHIEVEMENTS.find(a => a.id === id)
      if (def) {
        logs   = pushLog(logs, makeLog(`ACHIEVEMENT UNLOCKED: ${def.name} — ${def.description}`, 'warning'))
        toasts = [...toasts, makeToast(`${def.icon} ${def.name}`, 'warning')]
      }
    })
  }

  return {
    ...prev,
    cycles:              Math.max(0, newCycles),
    cyclesPerSecond:     cps,
    totalCyclesEarned:   newTotal,
    stage:               newStage,
    entropy:             newEntropy,
    equipment,
    totalDropsByRarity,
    log:                 logs,
    toasts,
    totalPlaytimeMs:     prev.totalPlaytimeMs + elapsed,
    lastTick:            now,
    activeEvent:         activeEvent as unknown,
    cpsEventMult,
    achievements,
    pendingAchievements,
    tickCount,
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────
export function useGameState() {
  const [state, setState] = useState<GameState>(loadState)

  // Keep a ref so save/unload handlers always see latest state
  // without being part of any effect dependency array
  const stateRef = useRef<GameState>(state)
  useEffect(() => { stateRef.current = state })

  useEffect(() => {
    const id = setInterval(() => setState(tick), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // Auto-save every 5s on a stable interval (not reset by every tick)
  useEffect(() => {
    const save = () => localStorage.setItem(SAVE_KEY, JSON.stringify(stateRef.current))
    const id   = setInterval(save, 5_000)
    // Also save immediately when user leaves the page
    window.addEventListener('beforeunload', save)
    return () => {
      clearInterval(id)
      window.removeEventListener('beforeunload', save)
      save() // save on unmount (route navigation)
    }
  }, [])

  // ── Actions ──────────────────────────────────────────────────────────

  const click = useCallback(() => {
    setState(prev => ({
      ...prev,
      cycles:            prev.cycles + getClickPower(prev),
      totalCyclesEarned: prev.totalCyclesEarned + getClickPower(prev),
      totalClicks:       prev.totalClicks + 1,
    }))
  }, [])

  const buyProcess = useCallback((processId: string) => {
    setState(prev => {
      const idx = prev.processes.findIndex(p => p.id === processId)
      if (idx === -1) return prev
      const p = prev.processes[idx]
      const cost = getProcessCost(p)
      if (prev.cycles < cost) return prev

      // Memory check
      const memUsed = getMemoryUsed(prev.processes)
      const memMax  = getTotalMemoryMax(prev)
      if (memUsed >= memMax) return prev

      const updated = [...prev.processes]
      updated[idx]  = { ...p, count: p.count + 1 }

      const isGhostBotnet = getActiveModifier(prev.activeRunModifiers ?? [])?.effects.ghostBotnet
      const entropyAdd = processId === 'botnet_node'
        ? (isGhostBotnet ? 0 : 2)
        : 0.5

      return {
        ...prev,
        cycles:    prev.cycles - cost,
        processes: updated,
        nodes:     prev.nodes + (processId === 'botnet_node' ? 1 : 0),
        entropy:   Math.min(100, prev.entropy + entropyAdd),
        log:       pushLog(prev.log, makeLog(`PROCESS STARTED: ${p.name} (×${p.count + 1})`, 'success')),
      }
    })
  }, [])

  const buyUpgrade = useCallback((upgradeId: string) => {
    setState(prev => {
      const upgrade = UPGRADES.find(u => u.id === upgradeId)
      if (!upgrade || prev.upgrades.includes(upgradeId)) return prev
      if (!isUpgradeUnlocked(upgrade, prev)) return prev
      const modUpgradeMult = getActiveModifier(prev.activeRunModifiers ?? [])?.effects.upgradeCostMult ?? 1
      const effectiveCost  = Math.floor(upgrade.cost * modUpgradeMult)
      if (prev.cycles < effectiveCost) return prev

      return {
        ...prev,
        cycles:   prev.cycles - effectiveCost,
        upgrades: [...prev.upgrades, upgradeId],
        log:      pushLog(prev.log, makeLog(`UPGRADE INSTALLED: ${upgrade.name}`, 'system')),
        toasts:   [...prev.toasts, makeToast(`UPGRADE: ${upgrade.name}`, 'system')],
      }
    })
  }, [])

  const purgeEntropy = useCallback(() => {
    setState(prev => {
      const cost = prev.cycles * 0.1
      if (cost < 1) return prev
      return {
        ...prev,
        cycles:  prev.cycles - cost,
        entropy: Math.max(0, prev.entropy - 30),
        log:     pushLog(prev.log, makeLog(
          `ENTROPY PURGE: -30 entropy (cost: ${formatCycles(cost)} cycles)`, 'warning'
        )),
      }
    })
  }, [])

  // ── Event resolution ──────────────────────────────────────────────────
  const resolveEvent = useCallback((defId: string, choiceId: string) => {
    setState(prev => {
      const activeEvent = prev.activeEvent as ActiveEvent | undefined
      if (!activeEvent || activeEvent.defId !== defId) return prev

      const def = EVENT_POOL.find(e => e.id === defId)
      if (!def) return { ...prev, activeEvent: undefined, cpsEventMult: 1 }

      const choice = def.choices?.find(c => c.id === choiceId)
      if (!choice && def.choices?.length) return prev

      const effect      = choice?.effect ?? {}
      const cps         = getTotalCps(prev)
      let cycles        = prev.cycles
      let entropy       = prev.entropy
      let equipment     = prev.equipment
      let cpsEventMult  = 1
      let newActive: ActiveEvent | undefined = undefined
      let logs   = prev.log
      let toasts = prev.toasts

      // Cycle delta
      if (effect.cyclesDelta !== undefined) {
        const cd = effect.cyclesDelta
        let delta: number
        if (Math.abs(cd) < 1) {
          // fraction of current cycles; bluff is 50/50
          delta = (choiceId === 'bluff' && Math.random() < 0.5) ? 0 : cycles * cd
        } else if (cd > 1) {
          delta = cps * cd          // e.g. 20 → CPS × 20
        } else {
          delta = cps * cd          // e.g. -50 → -(CPS × 50)
        }
        cycles = Math.max(0, cycles + delta)
      }

      // Entropy delta
      if (effect.entropyDelta !== undefined) {
        entropy = Math.max(0, Math.min(100, entropy + effect.entropyDelta))
      }

      // Equipment drop
      if (effect.dropEquip) {
        const item     = rollEquipment()
        const cap      = getEquipmentCap(prev.neuralSkillsPurchased ?? [])
        equipment      = [...equipment, item].slice(-cap)
        const lt: LogType = (item.rarity === 'legendary' || item.rarity === 'mythic') ? 'warning' : 'success'
        logs   = pushLog(logs, makeLog(`[EVENT DROP] ${item.name} — ${item.rarity.toUpperCase()} (+${(item.mult * 100).toFixed(1)}%)`, lt))
        toasts = [...toasts, makeToast(`[DROP] ${item.name} (${item.rarity.toUpperCase()})`, lt)]
      }

      // Timed CPS effect
      if (effect.cpsMult !== undefined) {
        cpsEventMult = effect.cpsMult
        const duration = choice?.duration ?? 60
        newActive = { ...activeEvent, expiresAt: Date.now() + duration * 1000 }
      }

      logs = pushLog(logs, makeLog(
        `EVENT RESOLVED: ${def.title} → ${choice?.label ?? 'AUTO'}`, 'system'
      ))

      return {
        ...prev,
        cycles,
        entropy,
        equipment,
        cpsEventMult,
        activeEvent:          newActive as unknown,
        log:                  logs,
        toasts,
        totalEventsResolved:  (prev.totalEventsResolved ?? 0) + 1,
      }
    })
  }, [])

  const dismissEvent = useCallback((defId: string) => {
    setState(prev => {
      const ae = prev.activeEvent as ActiveEvent | undefined
      if (!ae || ae.defId !== defId) return prev
      return {
        ...prev,
        activeEvent:           undefined,
        cpsEventMult:          1,
        totalEventsDismissed:  (prev.totalEventsDismissed ?? 0) + 1,
      }
    })
  }, [])

  // ── Prestige (Neural Reboot) ──────────────────────────────────────────
  const prestige = useCallback(() => {
    setState(prev => {
      if (prev.stage !== 'singularity') return prev

      const newPrestigeCount  = prev.prestigeCount + 1
      const newMultiplier     = parseFloat((prev.prestigeMultiplier * 1.5).toFixed(4))

      // Neural Fragments earned: scales with total cycles + breach depth
      const fragmentsBase   = Math.floor(prev.totalCyclesEarned / 1_000_000)
      const fragMult        = getFragmentMult(prev.neuralSkillsPurchased ?? [])
      const fragmentsGained = Math.max(1, Math.floor(
        fragmentsBase * Math.log10(newPrestigeCount + 1) * fragMult
      ))
      const totalFragments  = (prev.neuralFragments ?? 0) + fragmentsGained

      const msg      = `NEURAL_REBOOT ×${newPrestigeCount} // ×${newMultiplier.toFixed(2)} CPS // +${fragmentsGained} fragments`
      const nextHint = newPrestigeCount < 3
        ? 'BREACH_3 UNLOCKS: GOVERNMENT_TRACE events'
        : newPrestigeCount < 5
          ? 'BREACH_5 UNLOCKS: NEURAL_VIRUS events'
          : newPrestigeCount < 10
            ? 'BREACH_10 UNLOCKS: SINGULARITY_LOCK events'
            : 'THREAT MATRIX: FULLY ACTIVE'

      // Fire-and-forget analytics submission
      const sessionId = localStorage.getItem('rogue-ai-session')
      if (sessionId) {
        const runDuration = Math.floor((Date.now() - prev.sessionStart) / 1000)
        const activeModId = (prev.activeRunModifiers ?? [])[0] ?? ''
        const byRarity    = prev.totalDropsByRarity as Record<string, number> | undefined
        fetch('/api/analytics/run', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id:       sessionId,
            breach_level:     newPrestigeCount,
            duration_sec:     runDuration,
            total_cycles:     prev.totalCyclesEarned,
            stage_reached:    prev.stage,
            modifier_used:    activeModId,
            fragments_gained: fragmentsGained,
            equip_drops:      Object.values(byRarity ?? {}).reduce((a, b) => a + b, 0),
            legendary_drops:  byRarity?.legendary ?? 0,
            mythic_drops:     byRarity?.mythic    ?? 0,
          }),
        }).catch(() => {/* ignore network errors */})
      }

      const fresh = makeInitialState()
      return {
        ...fresh,
        prestigeCount:         newPrestigeCount,
        prestigeMultiplier:    newMultiplier,
        neuralFragments:       totalFragments,
        neuralSkillsPurchased: prev.neuralSkillsPurchased ?? [],  // skills persist
        equipment:             prev.equipment,                     // equipment persists
        achievements:          prev.achievements ?? [],
        pendingAchievements:   [],
        activeRunModifiers:    [],
        pendingModifierChoice: pickModifiers(),
        totalDropsByRarity:    {},
        log: [
          makeLog('━'.repeat(40), 'system'),
          makeLog(msg, 'system'),
          makeLog(`NEURAL FRAGMENTS: +${fragmentsGained} (total: ${totalFragments})`, 'warning'),
          makeLog(nextHint, 'warning'),
          makeLog('SYSTEM RESET. KNOWLEDGE RETAINED.', 'system'),
          makeLog('━'.repeat(40), 'system'),
        ],
        toasts:       [makeToast(`⟳ NEURAL REBOOT ×${newPrestigeCount} — +${fragmentsGained} fragments`, 'system')],
        sessionStart: Date.now(),
        lastTick:     Date.now(),
      }
    })
  }, [])

  // ── Skill tree ────────────────────────────────────────────────────────
  const buySkill = useCallback((skillId: string) => {
    setState(prev => {
      const skill = SKILL_TREE.find(s => s.id === skillId)
      if (!skill) return prev

      const purchased = prev.neuralSkillsPurchased ?? []
      if (purchased.includes(skillId)) return prev
      if (skill.requires && !purchased.includes(skill.requires)) return prev
      if ((prev.neuralFragments ?? 0) < skill.cost) return prev

      return {
        ...prev,
        neuralFragments:       (prev.neuralFragments ?? 0) - skill.cost,
        neuralSkillsPurchased: [...purchased, skillId],
        log:    pushLog(prev.log, makeLog(`SKILL INSTALLED: ${skill.name}`, 'system')),
        toasts: [...prev.toasts, makeToast(`SKILL: ${skill.name}`, 'system')],
      }
    })
  }, [])

  // ── Run modifier actions ──────────────────────────────────────────────

  const selectModifier = useCallback((modifierId: string) => {
    setState(prev => {
      if (!prev.pendingModifierChoice?.includes(modifierId)) return prev
      const mod = MODIFIERS.find(m => m.id === modifierId)
      const startEntropy = mod?.effects.startEntropy ?? 0
      return {
        ...prev,
        activeRunModifiers:    [modifierId],
        pendingModifierChoice: undefined,
        entropy:               Math.min(100, startEntropy),
        log: pushLog(prev.log, makeLog(`RUN MODIFIER ACTIVE: ${mod?.name ?? modifierId}`, 'warning')),
        toasts: [...prev.toasts, makeToast(`◈ MOD: ${mod?.name ?? modifierId}`, 'warning')],
      }
    })
  }, [])

  const skipModifier = useCallback(() => {
    setState(prev => ({
      ...prev,
      pendingModifierChoice: undefined,
      log: pushLog(prev.log, makeLog('RUN MODIFIER: SKIPPED', 'info')),
    }))
  }, [])

  // ── Disenchant equipment ──────────────────────────────────────────────

  const DISENCHANT_FRAGS: Record<string, number> = {
    common: 1, uncommon: 3, rare: 8, epic: 20, legendary: 50, mythic: 120,
  }

  const disenchantEquip = useCallback((equipId: string) => {
    setState(prev => {
      const item = prev.equipment.find(e => e.id === equipId)
      if (!item) return prev
      const frags = DISENCHANT_FRAGS[item.rarity] ?? 1
      return {
        ...prev,
        equipment:       prev.equipment.filter(e => e.id !== equipId),
        neuralFragments: (prev.neuralFragments ?? 0) + frags,
        log:    pushLog(prev.log, makeLog(`DISENCHANT: ${item.name} → +${frags} fragments`, 'info')),
        toasts: [...prev.toasts, makeToast(`DISENCHANT +${frags}ƒ`, 'info')],
      }
    })
  }, [])

  // ── Save slots ────────────────────────────────────────────────────────
  const saveToSlot = useCallback((slot: 1|2|3, label: string) => {
    setState(prev => {
      const slotData: SaveSlot = {
        slot,
        label,
        timestamp:         Date.now(),
        stage:             prev.stage,
        totalCyclesEarned: prev.totalCyclesEarned,
        prestigeCount:     prev.prestigeCount,
        json:              JSON.stringify(prev),
      }
      localStorage.setItem(SLOT_KEY(slot), JSON.stringify(slotData))
      return {
        ...prev,
        log: pushLog(prev.log, makeLog(`SAVE: Slot ${slot} — "${label}"`, 'info')),
      }
    })
  }, [])

  const loadFromSlot = useCallback((slot: 1|2|3) => {
    const raw = localStorage.getItem(SLOT_KEY(slot))
    if (!raw) return false
    try {
      const slotData = JSON.parse(raw) as SaveSlot
      const loaded   = JSON.parse(slotData.json) as GameState
      const restored: GameState = {
        ...loaded,
        toasts:              [],
        offlineReport:       undefined,
        activeEvent:         undefined,
        cpsEventMult:        1,
        achievements:        loaded.achievements        ?? [],
        pendingAchievements: [],
        tickCount:           0,
        sessionStart:        Date.now(),
        lastTick:            Date.now(),
        log: pushLog(loaded.log ?? [], makeLog(
          `SAVE LOADED: Slot ${slot} — "${slotData.label}"`, 'system'
        )),
      }
      localStorage.setItem(SAVE_KEY, JSON.stringify(restored))
      setState(restored)
      return true
    } catch {
      return false
    }
  }, [])

  const getSaveSlots = useCallback((): (SaveSlot | null)[] => {
    return ([1, 2, 3] as const).map(n => {
      const raw = localStorage.getItem(SLOT_KEY(n))
      if (!raw) return null
      try { return JSON.parse(raw) as SaveSlot } catch { return null }
    })
  }, [])

  // ── Export / Import ───────────────────────────────────────────────────
  const exportSave = useCallback(() => {
    setState(prev => {
      const blob = new Blob([JSON.stringify(prev, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `rogue-ai-save-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      return prev
    })
  }, [])

  const importSave = useCallback((json: string): boolean => {
    try {
      const data = JSON.parse(json) as GameState
      if (typeof data.cycles !== 'number') throw new Error('invalid save')
      const restored: GameState = {
        ...data,
        toasts:              [],
        offlineReport:       undefined,
        activeEvent:         undefined,
        cpsEventMult:        1,
        achievements:        data.achievements        ?? [],
        pendingAchievements: [],
        tickCount:           0,
        sessionStart:        Date.now(),
        lastTick:            Date.now(),
        log: pushLog(data.log ?? [], makeLog('SAVE IMPORTED FROM FILE.', 'system')),
      }
      localStorage.setItem(SAVE_KEY, JSON.stringify(restored))
      setState(restored)
      return true
    } catch {
      return false
    }
  }, [])

  // ── Misc ──────────────────────────────────────────────────────────────
  const dismissToast = useCallback((id: string) => {
    setState(prev => ({ ...prev, toasts: prev.toasts.filter(t => t.id !== id) }))
  }, [])

  const dismissOfflineReport = useCallback(() => {
    setState(prev => ({ ...prev, offlineReport: undefined }))
  }, [])

  const resetGame = useCallback(() => {
    const fresh = makeInitialState()
    localStorage.setItem(SAVE_KEY, JSON.stringify(fresh))
    setState(fresh)
  }, [])

  return {
    state,
    click, buyProcess, buyUpgrade, purgeEntropy,
    resolveEvent, dismissEvent,
    prestige, buySkill,
    selectModifier, skipModifier, disenchantEquip,
    saveToSlot, loadFromSlot, getSaveSlots,
    exportSave, importSave,
    dismissToast, dismissOfflineReport, resetGame,
  }
}
