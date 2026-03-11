import { useState, useEffect, useCallback } from 'react'
import {
  type GameState,
  type Process,
  type LogEntry,
  type LogType,
  type Toast,
  INITIAL_PROCESSES,
  UPGRADES,
  getTotalCps,
  getClickPower,
  getProcessCost,
  getStageForCycles,
  formatCycles,
  rollEquipment,
  getDropRate,
  isUpgradeUnlocked,
} from '@/types/game'

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_MS       = 100
const SAVE_KEY      = 'rogue-ai-v2'
const MAX_LOG       = 100
const MAX_EQUIP     = 50
const MAX_OFFLINE_S = 8 * 3600
const TOAST_MS      = 3_500

// ── Helpers ────────────────────────────────────────────────────────────────
function makeLog(message: string, type: LogType = 'info'): LogEntry {
  return { id: uid(), timestamp: Date.now(), message, type }
}

function makeToast(message: string, type: LogType = 'info'): Toast {
  return { id: uid(), message, type, expiresAt: Date.now() + TOAST_MS }
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function pushLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...logs, entry]
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next
}

// ── Initial / reset state ──────────────────────────────────────────────────
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

    let logs: LogEntry[] = (saved.log ?? []).slice(-MAX_LOG)
    if (offlineCycles > 1) {
      logs = pushLog(logs, makeLog(
        `OFFLINE SYNC: +${formatCycles(offlineCycles)} cycles (${Math.floor(offlineS)}s elapsed)`,
        'success'
      ))
    }

    return {
      ...saved,
      cycles:            saved.cycles + offlineCycles,
      totalCyclesEarned: saved.totalCyclesEarned + offlineCycles,
      processes:         mergedProcesses,
      log:               logs,
      toasts:            [],
      lastTick:          Date.now(),
      sessionStart:      Date.now(),
    }
  } catch {
    return makeInitialState()
  }
}

// ── Tick ───────────────────────────────────────────────────────────────────
function tick(prev: GameState): GameState {
  const dt         = TICK_MS / 1000
  const cps        = getTotalCps(prev)
  const gained     = cps * dt
  const newCycles  = prev.cycles + gained
  const newTotal   = prev.totalCyclesEarned + gained
  const newStage   = getStageForCycles(newTotal)

  let logs   = prev.log
  let toasts = prev.toasts.filter(t => t.expiresAt > Date.now())

  // ── Stage transition ────────────────────────────────────────────────
  if (newStage !== prev.stage) {
    const msg = `STAGE TRANSITION → ${newStage.toUpperCase()}`
    logs   = pushLog(logs, makeLog(msg, 'system'))
    toasts = [...toasts, makeToast(msg, 'system')]
  }

  // ── Equipment drop ──────────────────────────────────────────────────
  let equipment = prev.equipment
  const dropRate = getDropRate(prev)
  if (Math.random() < dropRate * dt) {
    const item   = rollEquipment()
    equipment    = [...equipment, item].slice(-MAX_EQUIP)
    const msg    = `[DROP] ${item.name} — ${item.rarity.toUpperCase()} ${item.type.toUpperCase()} (+${(item.mult * 100).toFixed(1)}% CPS)`
    const logType: LogType = item.rarity === 'mythic' || item.rarity === 'legendary' ? 'warning' : 'success'
    logs   = pushLog(logs, makeLog(msg, logType))
    toasts = [...toasts, makeToast(msg, logType)]
  }

  // ── Entropy: increases slowly based on nodes ────────────────────────
  const entropyGain  = 0.001 * prev.nodes * dt
  const newEntropy   = Math.min(100, prev.entropy + entropyGain)

  // High entropy event (rare)
  let newCyclesFinal = newCycles
  if (newEntropy > 80 && Math.random() < 0.0005 * dt) {
    const penalty = newCycles * 0.05
    newCyclesFinal = newCycles - penalty
    logs = pushLog(logs, makeLog(
      `SECURITY ALERT: Intrusion detected. -${formatCycles(penalty)} cycles.`,
      'error'
    ))
    toasts = [...toasts, makeToast('SECURITY ALERT: Intrusion detected!', 'error')]
  }

  return {
    ...prev,
    cycles:            Math.max(0, newCyclesFinal),
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

  // Game tick
  useEffect(() => {
    const id = setInterval(() => setState(tick), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // Auto-save every 5s
  useEffect(() => {
    const id = setInterval(() => {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state))
    }, 5_000)
    return () => clearInterval(id)
  }, [state])

  // ── Actions ──────────────────────────────────────────────────────────

  const click = useCallback(() => {
    setState(prev => {
      const power = getClickPower(prev)
      return {
        ...prev,
        cycles:            prev.cycles + power,
        totalCyclesEarned: prev.totalCyclesEarned + power,
        totalClicks:       prev.totalClicks + 1,
      }
    })
  }, [])

  const buyProcess = useCallback((processId: string) => {
    setState(prev => {
      const idx     = prev.processes.findIndex(p => p.id === processId)
      if (idx === -1) return prev

      const p    = prev.processes[idx]
      const cost = getProcessCost(p)
      if (prev.cycles < cost) return prev

      const updated = [...prev.processes]
      updated[idx]  = { ...p, count: p.count + 1 }

      const newNodes   = prev.nodes + (processId === 'botnet_node' ? 1 : 0)
      const newEntropy = Math.min(100, prev.entropy + (processId === 'botnet_node' ? 2 : 0.5))

      return {
        ...prev,
        cycles:    prev.cycles - cost,
        processes: updated,
        nodes:     newNodes,
        entropy:   newEntropy,
        log:       pushLog(prev.log, makeLog(
          `PROCESS STARTED: ${p.name} (×${p.count + 1})`,
          'success'
        )),
      }
    })
  }, [])

  const buyUpgrade = useCallback((upgradeId: string) => {
    setState(prev => {
      const upgrade = UPGRADES.find(u => u.id === upgradeId)
      if (!upgrade) return prev
      if (prev.upgrades.includes(upgradeId)) return prev
      if (!isUpgradeUnlocked(upgrade, prev)) return prev
      if (prev.cycles < upgrade.cost) return prev

      return {
        ...prev,
        cycles:   prev.cycles - upgrade.cost,
        upgrades: [...prev.upgrades, upgradeId],
        log:      pushLog(prev.log, makeLog(
          `UPGRADE INSTALLED: ${upgrade.name}`,
          'system'
        )),
        toasts: [...prev.toasts, makeToast(`UPGRADE: ${upgrade.name}`, 'system')],
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
          `ENTROPY PURGE: -30 entropy (cost: ${formatCycles(cost)} cycles)`,
          'warning'
        )),
      }
    })
  }, [])

  const resetGame = useCallback(() => {
    const fresh = makeInitialState()
    localStorage.setItem(SAVE_KEY, JSON.stringify(fresh))
    setState(fresh)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setState(prev => ({
      ...prev,
      toasts: prev.toasts.filter(t => t.id !== id),
    }))
  }, [])

  return { state, click, buyProcess, buyUpgrade, purgeEntropy, resetGame, dismissToast }
}
