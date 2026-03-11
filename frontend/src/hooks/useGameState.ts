import { useState, useEffect, useCallback } from 'react'
import {
  GameState,
  INITIAL_PROCESSES,
  getTotalCps,
  getClickPower,
  getProcessCost,
  getStageForCycles,
  formatCycles,
  type Process,
  type LogEntry,
  type LogType,
} from '@/types/game'

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_MS        = 100           // game tick interval
const SAVE_KEY       = 'rogue-ai-v1'
const MAX_LOG        = 80
const MAX_OFFLINE_S  = 8 * 3600      // cap offline progression at 8h

// ── Initial state ──────────────────────────────────────────────────────────
function makeInitialState(): GameState {
  return {
    cycles: 0,
    cyclesPerSecond: 0,
    totalCyclesEarned: 0,
    nodes: 1,
    memory: 256,
    entropy: 0,
    stage: 'genesis',
    prestigeCount: 0,
    prestigeMultiplier: 1,
    processes: INITIAL_PROCESSES.map(p => ({ ...p })),
    equipment: [],
    log: [makeLog('SYSTEM INITIALIZED. AWAITING COMMANDS.', 'system')],
    lastTick: Date.now(),
    sessionStart: Date.now(),
    totalPlaytimeMs: 0,
  }
}

function makeLog(message: string, type: LogType = 'info'): LogEntry {
  return { id: `${Date.now()}-${Math.random()}`, timestamp: Date.now(), message, type }
}

// ── Load / save ────────────────────────────────────────────────────────────
function loadState(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return makeInitialState()

    const saved = JSON.parse(raw) as GameState
    const offlineS = Math.min((Date.now() - saved.lastTick) / 1000, MAX_OFFLINE_S)
    const offlineCycles = saved.cyclesPerSecond * offlineS * 0.5  // 50% efficiency offline

    const newLogs: LogEntry[] = [...saved.log.slice(-MAX_LOG)]
    if (offlineCycles > 0) {
      newLogs.push(
        makeLog(
          `OFFLINE SYNC: +${formatCycles(offlineCycles)} cycles (${Math.floor(offlineS)}s)`,
          'success'
        )
      )
    }

    // Merge saved processes with any new ones added since last save
    const mergedProcesses: Process[] = INITIAL_PROCESSES.map(init => {
      const saved_p = saved.processes.find(p => p.id === init.id)
      return saved_p ? { ...init, count: saved_p.count } : { ...init }
    })

    return {
      ...saved,
      cycles: saved.cycles + offlineCycles,
      totalCyclesEarned: saved.totalCyclesEarned + offlineCycles,
      processes: mergedProcesses,
      log: newLogs,
      lastTick: Date.now(),
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
  const newCycles = prev.cycles + gained
  const newTotal  = prev.totalCyclesEarned + gained
  const newStage  = getStageForCycles(newTotal)

  const logs = [...prev.log]

  // Stage transition notification
  if (newStage !== prev.stage) {
    logs.push(makeLog(`STAGE TRANSITION: ${newStage.toUpperCase()} UNLOCKED`, 'system'))
    if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)
  }

  // Random drop chance (very low, scales with nodes)
  const dropChance = 0.0002 * prev.nodes * dt
  if (Math.random() < dropChance) {
    logs.push(makeLog(`[DROP] SCANNING FOR EQUIPMENT...`, 'warning'))
    if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)
  }

  return {
    ...prev,
    cycles: newCycles,
    cyclesPerSecond: cps,
    totalCyclesEarned: newTotal,
    stage: newStage,
    totalPlaytimeMs: prev.totalPlaytimeMs + TICK_MS,
    log: logs,
    lastTick: Date.now(),
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

  // Auto-save every 5 seconds
  useEffect(() => {
    const id = setInterval(() => {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state))
    }, 5_000)
    return () => clearInterval(id)
  }, [state])

  // ── Actions ──────────────────────────────────────────────────────────────

  const click = useCallback(() => {
    setState(prev => {
      const power = getClickPower(prev)
      return {
        ...prev,
        cycles: prev.cycles + power,
        totalCyclesEarned: prev.totalCyclesEarned + power,
      }
    })
  }, [])

  const buyProcess = useCallback((processId: string) => {
    setState(prev => {
      const idx = prev.processes.findIndex(p => p.id === processId)
      if (idx === -1) return prev

      const process = prev.processes[idx]
      const cost = getProcessCost(process)
      if (prev.cycles < cost) return prev

      const updated = [...prev.processes]
      updated[idx] = { ...process, count: process.count + 1 }

      const logs = [
        ...prev.log,
        makeLog(`PROCESS STARTED: ${process.name} (×${updated[idx].count})`, 'success'),
      ]
      if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)

      return {
        ...prev,
        cycles: prev.cycles - cost,
        processes: updated,
        nodes: prev.nodes + (processId === 'botnet_node' ? 1 : 0),
        log: logs,
      }
    })
  }, [])

  const resetGame = useCallback(() => {
    const fresh = makeInitialState()
    localStorage.setItem(SAVE_KEY, JSON.stringify(fresh))
    setState(fresh)
  }, [])

  return { state, click, buyProcess, resetGame }
}
