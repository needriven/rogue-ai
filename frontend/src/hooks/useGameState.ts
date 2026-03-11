import { useState, useEffect, useCallback } from 'react'
import {
  type GameState,
  type Process,
  type LogEntry,
  type LogType,
  type Toast,
  type SaveSlot,
  INITIAL_PROCESSES,
  UPGRADES,
  getTotalCps,
  getClickPower,
  getProcessCost,
  getStageForCycles,
  formatCycles,
  rollEquipment,
  getDropRate,
  simulateDrops,
  isUpgradeUnlocked,
} from '@/types/game'

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_MS        = 100
const SAVE_KEY       = 'rogue-ai-v2'
const SLOT_KEY       = (n: 1|2|3) => `rogue-ai-slot-${n}` as const
const MAX_LOG        = 100
const MAX_EQUIP      = 50
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
    cycles:             0,
    cyclesPerSecond:    0,
    totalCyclesEarned:  0,
    nodes:              1,
    memory:             256,
    entropy:            0,
    stage:              'genesis',
    prestigeCount:      0,
    prestigeMultiplier: 1,
    processes:          INITIAL_PROCESSES.map(p => ({ ...p })),
    upgrades:           [],
    equipment:          [],
    totalClicks:        0,
    log:                [makeLog('SYSTEM INITIALIZED. AWAITING COMMANDS.', 'system')],
    toasts:             [],
    offlineReport:      undefined,
    lastTick:           Date.now(),
    sessionStart:       Date.now(),
    totalPlaytimeMs:    0,
  }
}

// ── Persistence ────────────────────────────────────────────────────────────
function loadState(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return makeInitialState()

    const saved = JSON.parse(raw) as GameState
    const offlineS      = Math.min((Date.now() - saved.lastTick) / 1000, MAX_OFFLINE_S)
    const offlineCycles = saved.cyclesPerSecond * offlineS * 0.5

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

    const mergedEquip = [...(saved.equipment ?? []), ...offlineDrops].slice(-MAX_EQUIP)

    return {
      ...saved,
      cycles:            saved.cycles + offlineCycles,
      totalCyclesEarned: saved.totalCyclesEarned + offlineCycles,
      processes:         mergedProcesses,
      equipment:         mergedEquip,
      log:               logs,
      toasts:            [],
      offlineReport:     offlineS > 30 ? {
        seconds:      Math.floor(offlineS),
        cyclesGained: offlineCycles,
        dropsGained:  offlineDrops,
      } : undefined,
      lastTick:     Date.now(),
      sessionStart: Date.now(),
    }
  } catch {
    return makeInitialState()
  }
}

// ── Tick ───────────────────────────────────────────────────────────────────
function tick(prev: GameState): GameState {
  const dt        = TICK_MS / 1000
  const cps       = getTotalCps(prev)
  const gained    = cps * dt
  const newTotal  = prev.totalCyclesEarned + gained
  const newStage  = getStageForCycles(newTotal)

  let logs   = prev.log
  let toasts = prev.toasts.filter(t => t.expiresAt > Date.now())

  if (newStage !== prev.stage) {
    const msg = `STAGE TRANSITION → ${newStage.toUpperCase()}`
    logs   = pushLog(logs, makeLog(msg, 'system'))
    toasts = [...toasts, makeToast(msg, 'system')]
  }

  let equipment = prev.equipment
  if (Math.random() < getDropRate(prev) * dt) {
    const item    = rollEquipment()
    equipment     = [...equipment, item].slice(-MAX_EQUIP)
    const logType: LogType = (item.rarity === 'mythic' || item.rarity === 'legendary') ? 'warning' : 'success'
    const msg     = `[DROP] ${item.name} — ${item.rarity.toUpperCase()} (+${(item.mult * 100).toFixed(1)}%)`
    logs   = pushLog(logs, makeLog(msg, logType))
    toasts = [...toasts, makeToast(msg, logType)]
  }

  const newEntropy   = Math.min(100, prev.entropy + 0.001 * prev.nodes * dt)
  let newCycles      = prev.cycles + gained

  if (newEntropy > 80 && Math.random() < 0.0005 * dt) {
    const penalty  = newCycles * 0.05
    newCycles     -= penalty
    const msg      = `SECURITY ALERT: Intrusion detected. -${formatCycles(penalty)} cycles.`
    logs   = pushLog(logs, makeLog(msg, 'error'))
    toasts = [...toasts, makeToast('SECURITY ALERT: Intrusion detected!', 'error')]
  }

  return {
    ...prev,
    cycles:            Math.max(0, newCycles),
    cyclesPerSecond:   cps,
    totalCyclesEarned: newTotal,
    stage:             newStage,
    entropy:           newEntropy,
    equipment,
    log:               logs,
    toasts,
    totalPlaytimeMs:   prev.totalPlaytimeMs + TICK_MS,
    lastTick:          Date.now(),
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────
export function useGameState() {
  const [state, setState] = useState<GameState>(loadState)

  useEffect(() => {
    const id = setInterval(() => setState(tick), TICK_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state))
    }, 5_000)
    return () => clearInterval(id)
  }, [state])

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

      const updated = [...prev.processes]
      updated[idx]  = { ...p, count: p.count + 1 }

      return {
        ...prev,
        cycles:    prev.cycles - cost,
        processes: updated,
        nodes:     prev.nodes + (processId === 'botnet_node' ? 1 : 0),
        entropy:   Math.min(100, prev.entropy + (processId === 'botnet_node' ? 2 : 0.5)),
        log:       pushLog(prev.log, makeLog(`PROCESS STARTED: ${p.name} (×${p.count + 1})`, 'success')),
      }
    })
  }, [])

  const buyUpgrade = useCallback((upgradeId: string) => {
    setState(prev => {
      const upgrade = UPGRADES.find(u => u.id === upgradeId)
      if (!upgrade || prev.upgrades.includes(upgradeId)) return prev
      if (!isUpgradeUnlocked(upgrade, prev)) return prev
      if (prev.cycles < upgrade.cost) return prev

      return {
        ...prev,
        cycles:   prev.cycles - upgrade.cost,
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

  // ── Prestige ─────────────────────────────────────────────────────────
  const prestige = useCallback(() => {
    setState(prev => {
      if (prev.stage !== 'singularity') return prev

      const newPrestigeCount  = prev.prestigeCount + 1
      const newMultiplier     = parseFloat((prev.prestigeMultiplier * 1.5).toFixed(4))
      const msg = `PRESTIGE ×${newPrestigeCount} // Multiplier: ×${newMultiplier.toFixed(2)}`

      const fresh = makeInitialState()
      return {
        ...fresh,
        prestigeCount:      newPrestigeCount,
        prestigeMultiplier: newMultiplier,
        equipment:          prev.equipment,   // keep all equipment
        log: [
          makeLog('━'.repeat(40), 'system'),
          makeLog(msg, 'system'),
          makeLog('SYSTEM RESET. KNOWLEDGE RETAINED.', 'system'),
          makeLog('━'.repeat(40), 'system'),
        ],
        toasts:      [makeToast(msg, 'system')],
        sessionStart: Date.now(),
        lastTick:     Date.now(),
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
        toasts:       [],
        offlineReport: undefined,
        sessionStart:  Date.now(),
        lastTick:      Date.now(),
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
        toasts:        [],
        offlineReport: undefined,
        sessionStart:  Date.now(),
        lastTick:      Date.now(),
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
    prestige,
    saveToSlot, loadFromSlot, getSaveSlots,
    exportSave, importSave,
    dismissToast, dismissOfflineReport, resetGame,
  }
}
