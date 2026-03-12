import { createContext, useContext } from 'react'
import type { useGameState } from '@/hooks/useGameState'

type GameContextValue = ReturnType<typeof useGameState>

export const GameContext = createContext<GameContextValue | null>(null)

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGame must be used within a GameContext.Provider')
  return ctx
}
