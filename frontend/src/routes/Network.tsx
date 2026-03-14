import { useState, useEffect, useCallback } from 'react'
import { useGame } from '@/context/GameContext'
import {
  formatCycles,
  RARITY_COLORS,
  RARITY_BORDER,
  RARITY_BG,
  type Equipment,
  type Rarity,
  type EquipmentType,
} from '@/types/game'

// ── API base ───────────────────────────────────────────────────────────────
const API = '/api/network'

type NetworkTab = 'leaderboard' | 'market' | 'events'
type LBType     = 'cycles' | 'breach'

interface LBEntry {
  rank:        number
  sessionId:   string
  displayName: string
  score:       number
}

interface MarketListing {
  id:          string
  sellerName:  string
  item: {
    name:        string
    rarity:      Rarity
    type:        EquipmentType
    mult:        number
    description: string
  }
  priceFrag:  number
  expiresAt:  number
  createdAt:  number
}

interface GlobalEvent {
  active:       boolean
  type?:        string
  title?:       string
  description?: string
  effectType?:  string
  effectValue?: number
  expiresAt?:   number
  remainingSec?: number
}

interface NetworkStats {
  totalPlayers:   number
  activeListings: number
  topBreachLevel: number
  topCycles:      number
  globalEvent:    boolean
}

interface PlayerRank {
  rank:  number | null
  score: number | null
  total: number
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatScore(score: number, type: LBType): string {
  if (type === 'breach') return `BREACH_${Math.floor(score)}`
  return formatCycles(score)
}

function timeUntil(ts: number): string {
  const s = Math.max(0, ts - Date.now() / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(s % 60)}s`
}

const RARITY_ICONS: Record<Rarity, string> = {
  mythic: '★', legendary: '◆', epic: '◈', rare: '◇', uncommon: '○', common: '·',
}

// ── Sell modal ─────────────────────────────────────────────────────────────
function SellModal({
  equipment,
  sessionId,
  displayName,
  onClose,
  onListed,
}: {
  equipment:   Equipment[]
  sessionId:   string
  displayName: string
  onClose:     () => void
  onListed:    () => void
}) {
  const [selected, setSelected]   = useState<Equipment | null>(null)
  const [price,    setPrice]      = useState(10)
  const [loading,  setLoading]    = useState(false)
  const [error,    setError]      = useState('')

  const sellable = [...equipment].sort((a, b) => {
    const o: Record<Rarity, number> = { mythic:0,legendary:1,epic:2,rare:3,uncommon:4,common:5 }
    return o[a.rarity] - o[b.rarity]
  })

  const handleList = async () => {
    if (!selected) return
    setLoading(true); setError('')
    try {
      const res = await fetch(`${API}/market/list`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:   sessionId,
          display_name: displayName,
          item_name:    selected.name,
          item_rarity:  selected.rarity,
          item_type:    selected.type,
          item_mult:    selected.mult,
          item_desc:    selected.description,
          price_frag:   price,
        }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Failed') }
      onListed()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="border border-t-green/40 bg-t-bg p-5 max-w-lg w-full mx-4 shadow-2xl">
        <p className="text-xs text-t-muted tracking-widest mb-1">// DARKWEB_MARKET</p>
        <p className="text-sm text-t-green font-semibold mb-4">LIST EQUIPMENT FOR SALE</p>

        {/* Equipment selector */}
        <div className="max-h-48 overflow-y-auto space-y-1 mb-4 border border-t-border/40 p-2">
          {sellable.length === 0 && (
            <p className="text-xs text-t-muted text-center py-4">No equipment to sell.</p>
          )}
          {sellable.map(e => (
            <button
              key={e.id}
              onClick={() => setSelected(e)}
              className={[
                'w-full text-left border p-2 text-xs transition-all duration-150',
                selected?.id === e.id
                  ? `${RARITY_BORDER[e.rarity]} ${RARITY_BG[e.rarity]}`
                  : 'border-t-border/30 hover:border-t-border',
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <span className={`font-semibold ${RARITY_COLORS[e.rarity]}`}>
                  {RARITY_ICONS[e.rarity]} {e.name}
                </span>
                <span className={RARITY_COLORS[e.rarity]}>+{(e.mult*100).toFixed(1)}%</span>
              </div>
              <span className="text-t-muted capitalize">{e.rarity} · {e.type}</span>
            </button>
          ))}
        </div>

        {/* Price */}
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs text-t-dim">PRICE (fragments)</span>
          <input
            type="number"
            min={1} max={10000}
            value={price}
            onChange={e => setPrice(Math.max(1, Math.min(10000, parseInt(e.target.value) || 1)))}
            className="flex-1 bg-t-surface border border-t-border text-t-text text-xs px-2 py-1
                       focus:outline-none focus:border-t-green tabular-nums"
          />
          <span className="text-xs text-purple-400">ƒ</span>
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 border border-t-border/40 text-t-muted hover:text-t-dim"
          >
            CANCEL
          </button>
          <button
            onClick={handleList}
            disabled={!selected || loading}
            className="text-xs px-3 py-1.5 border border-t-green/60 text-t-green
                       hover:bg-t-green/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'LISTING...' : 'LIST FOR SALE (24h)'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function Network() {
  const { state } = useGame()
  const sessionId    = typeof window !== 'undefined'
    ? (localStorage.getItem('rogue-ai-session') ?? '')
    : ''

  const [tab,         setTab]        = useState<NetworkTab>('leaderboard')
  const [lbType,      setLbType]     = useState<LBType>('cycles')
  const [lbData,      setLbData]     = useState<LBEntry[]>([])
  const [playerRank,  setPlayerRank] = useState<PlayerRank | null>(null)
  const [market,      setMarket]     = useState<MarketListing[]>([])
  const [marketTotal, setMktTotal]   = useState(0)
  const [mktFilter,   setMktFilter]  = useState<{ type: string; rarity: string }>({ type:'all', rarity:'all' })
  const [globalEvent, setGlobalEvt]  = useState<GlobalEvent | null>(null)
  const [netStats,    setNetStats]   = useState<NetworkStats | null>(null)
  const [loading,     setLoading]    = useState(false)
  const [showSell,    setShowSell]   = useState(false)
  const [buyLoading,  setBuyLoading] = useState<string | null>(null)
  const [buyResult,   setBuyResult]  = useState<{ item: Equipment } | null>(null)
  const [displayName, setDisplayName] = useState(
    typeof window !== 'undefined' ? (localStorage.getItem('rogue-ai-display-name') ?? '') : ''
  )
  const [nameInput,   setNameInput]  = useState(displayName)
  const [nameEditing, setNameEditing] = useState(false)
  // Submit score on mount / when state changes significantly
  const submitScore = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await fetch(`${API}/score`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:          sessionId,
          display_name:        displayName,
          total_cycles:        state.totalCyclesEarned,
          breach_level:        state.prestigeCount,
          prestige_multiplier: state.prestigeMultiplier,
          stage:               state.stage,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.displayName) {
          localStorage.setItem('rogue-ai-display-name', data.displayName)
          setDisplayName(data.displayName)
        }
      }
    } catch { /* silent */ }
  }, [sessionId, displayName, state.totalCyclesEarned, state.prestigeCount, state.prestigeMultiplier, state.stage])

  // Load network stats
  const loadStats = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/stats`)
      if (res.ok) setNetStats(await res.json())
    } catch { /* silent */ }
  }, [])

  // Load leaderboard
  const loadLeaderboard = useCallback(async () => {
    setLoading(true)
    try {
      const [lbRes, rankRes] = await Promise.all([
        fetch(`${API}/leaderboard?type=${lbType}&limit=50`),
        sessionId ? fetch(`${API}/leaderboard/rank/${sessionId}?type=${lbType}`) : Promise.resolve(null),
      ])
      if (lbRes.ok) {
        const d = await lbRes.json()
        setLbData(d.entries ?? [])
      }
      if (rankRes?.ok) setPlayerRank(await rankRes.json())
    } catch { /* silent */ } finally { setLoading(false) }
  }, [lbType, sessionId])

  // Load market
  const loadMarket = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ type: mktFilter.type, rarity: mktFilter.rarity, limit: '30' })
      const res = await fetch(`${API}/market?${params}`)
      if (res.ok) {
        const d = await res.json()
        setMarket(d.listings ?? [])
        setMktTotal(d.total ?? 0)
      }
    } catch { /* silent */ } finally { setLoading(false) }
  }, [mktFilter])

  // Load global event
  const loadEvent = useCallback(async () => {
    try {
      const res = await fetch(`${API}/event`)
      if (res.ok) setGlobalEvt(await res.json())
    } catch { /* silent */ }
  }, [])

  // On mount
  useEffect(() => {
    submitScore()
    loadStats()
    loadEvent()
    const id = setInterval(() => { loadStats(); loadEvent() }, 30_000)
    return () => clearInterval(id)
  }, [])  // eslint-disable-line

  // On tab change
  useEffect(() => {
    if (tab === 'leaderboard') loadLeaderboard()
    if (tab === 'market')      loadMarket()
    if (tab === 'events')      loadEvent()
  }, [tab, lbType, mktFilter])  // eslint-disable-line

  const handleBuy = async (listing: MarketListing) => {
    if (!sessionId) return
    setBuyLoading(listing.id)
    try {
      const res = await fetch(`${API}/market/buy`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id:      sessionId,
          listing_id:      listing.id,
          buyer_fragments: state.neuralFragments ?? 0,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Purchase failed')
      setBuyResult({ item: { ...data.item, id: `market-${Date.now()}`, droppedAt: Date.now() } })
      loadMarket()
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Purchase failed')
    } finally {
      setBuyLoading(null)
    }
  }

  const handleNameSave = () => {
    localStorage.setItem('rogue-ai-display-name', nameInput)
    setDisplayName(nameInput)
    setNameEditing(false)
    // Re-submit score with new name
    setTimeout(submitScore, 100)
  }

  const fragments = state.neuralFragments ?? 0

  return (
    <div className="h-full flex flex-col animate-fade-in">

      {/* Buy result modal */}
      {buyResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className={`border p-5 bg-t-bg max-w-sm w-full mx-4 ${RARITY_BORDER[buyResult.item.rarity as Rarity]}`}>
            <p className="text-xs text-t-muted mb-2">// PURCHASE_COMPLETE</p>
            <p className={`text-sm font-semibold ${RARITY_COLORS[buyResult.item.rarity as Rarity]}`}>
              {RARITY_ICONS[buyResult.item.rarity as Rarity]} {buyResult.item.name}
            </p>
            <p className="text-xs text-t-dim mt-1">{buyResult.item.description}</p>
            <p className={`text-lg font-bold tabular-nums mt-2 ${RARITY_COLORS[buyResult.item.rarity as Rarity]}`}>
              +{(buyResult.item.mult * 100).toFixed(1)}%
            </p>
            <p className="text-xs text-t-muted mt-3">
              Item added to your equipment inventory. Check GAME → EQUIPMENT tab.
            </p>
            <button
              onClick={() => setBuyResult(null)}
              className="mt-4 w-full text-xs py-2 border border-t-green/40 text-t-green hover:bg-t-green/10"
            >
              CONFIRM
            </button>
          </div>
        </div>
      )}

      {/* Sell modal */}
      {showSell && (
        <SellModal
          equipment={state.equipment}
          sessionId={sessionId}
          displayName={displayName}
          onClose={() => setShowSell(false)}
          onListed={loadMarket}
        />
      )}

      {/* ── Top stats bar ──────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-t-border bg-t-panel/60 px-4 h-9 flex items-center gap-0 text-xs">
        <span className="text-t-muted mr-4">NETWORK:</span>
        {netStats ? (
          <>
            <span className="mr-4">
              NODES: <span className="text-t-green tabular-nums">{netStats.totalPlayers.toLocaleString()}</span>
            </span>
            <span className="text-t-muted mr-4">//</span>
            <span className="mr-4">
              MARKET: <span className="text-t-text tabular-nums">{netStats.activeListings}</span>
            </span>
            <span className="text-t-muted mr-4">//</span>
            <span className="mr-4">
              TOP_BREACH: <span className="text-purple-400">BR-{netStats.topBreachLevel}</span>
            </span>
            {netStats.globalEvent && (
              <>
                <span className="text-t-muted mr-4">//</span>
                <span className="text-t-amber animate-pulse">◆ GLOBAL_EVENT_ACTIVE</span>
              </>
            )}
          </>
        ) : (
          <span className="text-t-muted">CONNECTING...</span>
        )}

        {/* Fragments + player name on right */}
        <div className="ml-auto flex items-center gap-3">
          {nameEditing ? (
            <div className="flex items-center gap-1">
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setNameEditing(false) }}
                className="bg-t-surface border border-t-green text-t-green text-xs px-2 py-0.5 w-32
                           focus:outline-none"
                maxLength={20}
                autoFocus
              />
              <button onClick={handleNameSave} className="text-xs text-t-green hover:text-t-green">✓</button>
              <button onClick={() => setNameEditing(false)} className="text-xs text-t-muted hover:text-t-dim">✕</button>
            </div>
          ) : (
            <button
              onClick={() => { setNameInput(displayName); setNameEditing(true) }}
              className="text-xs text-t-dim hover:text-t-text"
              title="Click to set display name"
            >
              {displayName || 'SET_NAME'}
            </button>
          )}
          <span className="text-t-muted">//</span>
          <span className="text-purple-300 tabular-nums">{fragments.toLocaleString()} ƒ</span>
        </div>
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────── */}
      <div className="shrink-0 flex border-b border-t-border">
        {(['leaderboard', 'market', 'events'] as NetworkTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'flex-1 py-2.5 text-xs tracking-widest transition-all duration-150 border-b-2',
              tab === t
                ? 'border-t-green text-t-green bg-t-green/5'
                : 'border-transparent text-t-dim hover:text-t-text',
            ].join(' ')}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Content ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">

        {/* LEADERBOARD */}
        {tab === 'leaderboard' && (
          <div className="p-4 space-y-4">
            {/* Type selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-t-muted">// RANK_BY</span>
              {(['cycles', 'breach'] as LBType[]).map(t => (
                <button
                  key={t}
                  onClick={() => setLbType(t)}
                  className={[
                    'text-xs px-2.5 py-1 border tracking-wider transition-colors',
                    lbType === t
                      ? 'border-t-green text-t-green bg-t-green/10'
                      : 'border-t-border/40 text-t-muted hover:text-t-dim',
                  ].join(' ')}
                >
                  {t === 'cycles' ? 'TOTAL_CYCLES' : 'BREACH_LEVEL'}
                </button>
              ))}
              <button
                onClick={loadLeaderboard}
                className="ml-auto text-xs text-t-muted hover:text-t-dim border border-t-border/30 px-2 py-1"
              >
                ↻ REFRESH
              </button>
            </div>

            {/* Player's own rank */}
            {playerRank?.rank && (
              <div className="border border-purple-700/40 bg-purple-950/20 p-3 flex items-center justify-between">
                <span className="text-xs text-purple-400">YOUR RANK</span>
                <span className="text-xs text-purple-300 font-semibold">
                  #{playerRank.rank} / {playerRank.total}
                </span>
                <span className="text-xs text-purple-300 tabular-nums">
                  {playerRank.score !== null ? formatScore(playerRank.score, lbType) : '—'}
                </span>
              </div>
            )}

            {/* Leaderboard table */}
            {loading ? (
              <p className="text-xs text-t-muted text-center py-8">FETCHING DATA...</p>
            ) : lbData.length === 0 ? (
              <p className="text-xs text-t-muted text-center py-8">
                No data yet. Submit your score to appear on the leaderboard.
                <br />
                <button
                  onClick={submitScore}
                  className="mt-2 text-t-green border border-t-green/40 px-3 py-1 hover:bg-t-green/10"
                >
                  SUBMIT SCORE
                </button>
              </p>
            ) : (
              <div className="border border-t-border/40 overflow-hidden">
                <div className="grid text-xs text-t-muted bg-t-panel/40 px-3 py-2
                               border-b border-t-border/40"
                     style={{ gridTemplateColumns: '3rem 1fr 1fr' }}>
                  <span>RANK</span>
                  <span>AGENT</span>
                  <span className="text-right">{lbType === 'cycles' ? 'CYCLES' : 'BREACH'}</span>
                </div>
                {lbData.map(e => (
                  <div
                    key={e.rank}
                    className={[
                      'grid px-3 py-2.5 text-xs border-b border-t-border/20 last:border-0',
                      e.rank <= 3 ? 'bg-t-panel/20' : '',
                    ].join(' ')}
                    style={{ gridTemplateColumns: '3rem 1fr 1fr' }}
                  >
                    <span className={
                      e.rank === 1 ? 'text-t-amber font-bold' :
                      e.rank === 2 ? 'text-t-dim font-semibold' :
                      e.rank === 3 ? 'text-orange-600' : 'text-t-muted'
                    }>
                      {e.rank === 1 ? '★' : e.rank === 2 ? '◆' : e.rank === 3 ? '◈' : `#${e.rank}`}
                    </span>
                    <span className="text-t-text truncate">{e.displayName}</span>
                    <span className="text-t-green tabular-nums text-right">
                      {formatScore(e.score, lbType)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* MARKET */}
        {tab === 'market' && (
          <div className="p-4 space-y-4">
            {/* Header actions */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-t-muted">// DARKWEB_MARKET</span>
              <span className="text-xs text-t-dim">{marketTotal} listings</span>
              <button
                onClick={() => setShowSell(true)}
                className="ml-auto text-xs px-3 py-1 border border-t-green/50 text-t-green
                           hover:bg-t-green/10 tracking-wider"
              >
                + LIST EQUIPMENT
              </button>
              <button
                onClick={loadMarket}
                className="text-xs text-t-muted hover:text-t-dim border border-t-border/30 px-2 py-1"
              >
                ↻
              </button>
            </div>

            {/* Filters */}
            <div className="flex gap-1.5 flex-wrap">
              {(['all','cpu','memory','nic','crypto','algorithm'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setMktFilter(f => ({ ...f, type: t }))}
                  className={[
                    'text-xs px-1.5 py-0.5 border tracking-wider transition-colors',
                    mktFilter.type === t
                      ? 'border-t-green text-t-green bg-t-green/10'
                      : 'border-t-border/40 text-t-muted hover:text-t-dim',
                  ].join(' ')}
                >
                  {t.toUpperCase()}
                </button>
              ))}
              <span className="text-t-border mx-1">|</span>
              {(['all','mythic','legendary','epic','rare','uncommon','common'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setMktFilter(f => ({ ...f, rarity: r }))}
                  className={[
                    'text-xs px-1.5 py-0.5 border tracking-wider transition-colors',
                    mktFilter.rarity === r
                      ? 'border-t-amber/70 text-t-amber bg-t-amber/10'
                      : 'border-t-border/40 text-t-muted hover:text-t-dim',
                  ].join(' ')}
                >
                  {r === 'all' ? 'ALL' : RARITY_ICONS[r as Rarity]}
                </button>
              ))}
            </div>

            {/* Listings */}
            {loading ? (
              <p className="text-xs text-t-muted text-center py-8">FETCHING LISTINGS...</p>
            ) : market.length === 0 ? (
              <p className="text-xs text-t-muted text-center py-8">
                No listings found. Be the first to list equipment!
              </p>
            ) : (
              <div className="space-y-2">
                {market.map(listing => {
                  const canAfford = fragments >= listing.priceFrag
                  const isBuying  = buyLoading === listing.id
                  return (
                    <div
                      key={listing.id}
                      className={[
                        'border p-3 transition-all duration-150',
                        RARITY_BORDER[listing.item.rarity],
                        RARITY_BG[listing.item.rarity],
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-semibold tracking-wider ${RARITY_COLORS[listing.item.rarity]}`}>
                              {RARITY_ICONS[listing.item.rarity]} {listing.item.name}
                            </span>
                            <span className={`text-xs ${RARITY_COLORS[listing.item.rarity]}`}>
                              +{(listing.item.mult * 100).toFixed(1)}%
                            </span>
                          </div>
                          <p className="text-xs text-t-dim mt-0.5">{listing.item.description}</p>
                          <div className="flex gap-3 mt-1">
                            <span className="text-xs text-t-muted capitalize">
                              {listing.item.rarity} · {listing.item.type}
                            </span>
                            <span className="text-xs text-t-muted">
                              by {listing.sellerName}
                            </span>
                            <span className="text-xs text-t-muted">
                              expires {timeUntil(listing.expiresAt)}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-purple-300 font-semibold tabular-nums">
                            {listing.priceFrag.toLocaleString()} ƒ
                          </p>
                          <button
                            onClick={() => handleBuy(listing)}
                            disabled={!canAfford || isBuying}
                            className={[
                              'mt-1 text-xs px-2.5 py-1 border tracking-wider transition-all duration-150',
                              canAfford
                                ? 'border-purple-500 text-purple-400 hover:bg-purple-900/30'
                                : 'border-t-border/30 text-t-muted/40 cursor-not-allowed',
                            ].join(' ')}
                          >
                            {isBuying ? '...' : canAfford ? 'BUY' : 'NO ƒ'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* EVENTS */}
        {tab === 'events' && (
          <div className="p-4 space-y-4">
            <p className="text-xs text-t-muted tracking-widest">// GLOBAL_EVENT_MONITOR</p>

            {/* Active event */}
            {globalEvent?.active ? (
              <div className="border border-t-amber/40 bg-t-amber/5 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-t-amber text-xs animate-pulse">◆ ACTIVE</span>
                  <span className="text-xs text-t-amber font-semibold tracking-wider">
                    {globalEvent.title}
                  </span>
                </div>
                <p className="text-xs text-t-dim leading-relaxed">{globalEvent.description}</p>
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-xs">
                    <span className="text-t-muted">EFFECT: </span>
                    <span className="text-t-amber">
                      {globalEvent.effectType === 'drop_rate' && `Drop rate ×${globalEvent.effectValue}`}
                      {globalEvent.effectType === 'cps_mult'  && `CPS ×${globalEvent.effectValue}`}
                    </span>
                  </div>
                  <div className="text-xs text-t-dim tabular-nums">
                    {globalEvent.remainingSec !== undefined && (
                      <span>EXPIRES: {timeUntil(globalEvent.expiresAt ?? 0)}</span>
                    )}
                  </div>
                </div>
                {/* Progress bar */}
                {globalEvent.expiresAt && globalEvent.remainingSec !== undefined && (() => {
                  const duration   = globalEvent.effectType === 'drop_rate' ? 3600 : 1800
                  const remaining  = globalEvent.remainingSec
                  const pct        = Math.min(100, (remaining / duration) * 100)
                  return (
                    <div className="mt-2 h-1 bg-t-muted/20">
                      <div className="h-full bg-t-amber/60 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  )
                })()}
              </div>
            ) : (
              <div className="border border-t-border/40 p-6 text-center">
                <p className="text-xs text-t-muted">NO_GLOBAL_EVENT_ACTIVE</p>
                <p className="text-xs text-t-dim mt-2 leading-relaxed max-w-sm mx-auto">
                  Global events are triggered automatically when players reach significant milestones.
                  Reach BREACH_10 or Peta-scale cycles to trigger one.
                </p>
              </div>
            )}

            {/* How events work */}
            <div className="border border-t-border/30 p-3 space-y-2">
              <p className="text-xs text-t-muted tracking-widest">// EVENT_TRIGGERS</p>
              <div className="space-y-1.5">
                {[
                  { trigger: 'Reach BREACH_10', effect: 'All players: drop rate ×2 for 1h', icon: '◆' },
                  { trigger: 'Reach Peta-cycle (1P)', effect: 'All players: CPS ×1.3 for 30m', icon: '◈' },
                ].map(t => (
                  <div key={t.trigger} className="flex items-center gap-2 text-xs">
                    <span className="text-t-amber">{t.icon}</span>
                    <span className="text-t-dim">{t.trigger}</span>
                    <span className="text-t-muted">→</span>
                    <span className="text-t-dim">{t.effect}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Note about client-side effect */}
            {globalEvent?.active && (
              <div className="border border-t-green/20 p-3">
                <p className="text-xs text-t-green/70">
                  ◉ Global event effects are applied automatically to your game while active.
                  Check back regularly — events from other players benefit everyone.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
