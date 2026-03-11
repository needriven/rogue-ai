import { useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GameState } from '@/types/game'

// ── Session ID ────────────────────────────────────────────────────────────────
const SESSION_KEY = 'rogue-ai-session'

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface CloudMeta {
  session_id: string
  updated_at: number   // ms since epoch
  size_bytes: number
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init)
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  return res
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useCloudSync(currentState: GameState) {
  const [sessionId, setSessionId] = useState(getOrCreateSessionId)
  const qc = useQueryClient()

  // ── Fetch cloud metadata (updated_at + size, no game data) ────────────────
  const {
    data:    cloudMeta,
    isLoading,
    error:   fetchError,
    refetch: refetchMeta,
  } = useQuery<CloudMeta | null>({
    queryKey: ['cloud-meta', sessionId],
    queryFn: async () => {
      const res = await apiFetch(`/api/saves/${sessionId}/meta`)
      if (res.status === 404) return null
      return res.json() as Promise<CloudMeta>
    },
    retry:     1,
    staleTime: 60_000,
  })

  // ── Push current state to cloud ───────────────────────────────────────────
  const pushMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/saves/${sessionId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: currentState }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || `HTTP ${res.status}`)
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-meta', sessionId] }),
  })

  // ── Pull full game state from cloud ───────────────────────────────────────
  const pullMut = useMutation({
    mutationFn: async (): Promise<GameState> => {
      const res = await fetch(`/api/saves/${sessionId}`)
      if (res.status === 404) throw new Error('No cloud save found for this session.')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      return body.data as GameState
    },
  })

  // ── Change session ID (cross-device restore) ──────────────────────────────
  const changeSession = useCallback((newId: string) => {
    const trimmed = newId.trim().toLowerCase()
    if (!trimmed) return
    localStorage.setItem(SESSION_KEY, trimmed)
    setSessionId(trimmed)
    qc.removeQueries({ queryKey: ['cloud-meta'] })
  }, [qc])

  // ── Delete cloud save ─────────────────────────────────────────────────────
  const deleteMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/saves/${sessionId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-meta', sessionId] }),
  })

  return {
    sessionId,
    cloudMeta,
    isLoading,
    fetchError,
    refetchMeta,

    push:        pushMut.mutate,
    isPushing:   pushMut.isPending,
    pushError:   pushMut.error,
    pushSuccess: pushMut.isSuccess,

    pull:        pullMut.mutate,
    isPulling:   pullMut.isPending,
    pullError:   pullMut.error,
    pullData:    pullMut.data,

    deleteCloud:   deleteMut.mutate,
    isDeleting:    deleteMut.isPending,

    changeSession,
  }
}
