import { useState, useCallback, useRef } from 'react'
import type { GameState } from '@/types/game'
import { formatCycles } from '@/types/game'

// ── Types ───────────────────────────────────────────────────────────────────

export type LineType = 'prompt' | 'output' | 'success' | 'error' | 'info' | 'system' | 'dim'

export interface TerminalLine {
  id:   string
  type: LineType
  text: string
}

export interface TerminalCtx {
  navigate:     (to: string) => void
  getGameState: () => GameState
}

type CmdResult = TerminalLine[]
type CmdFn     = (args: string[], ctx: TerminalCtx) => CmdResult | Promise<CmdResult>

interface CmdDef {
  summary:  string
  usage?:   string
  fn:       CmdFn
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0
function uid() { return `tl-${++_id}` }

function line(type: LineType, text: string): TerminalLine {
  return { id: uid(), type, text }
}

function out(text: string):   TerminalLine { return line('output',  text) }
function ok(text: string):    TerminalLine { return line('success', text) }
function err(text: string):   TerminalLine { return line('error',   text) }
function info(text: string):  TerminalLine { return line('info',    text) }
function dim(text: string):   TerminalLine { return line('dim',     text) }
function sys(text: string):   TerminalLine { return line('system',  text) }

async function apiFetch<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts)
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ── Parse flags from args ─────────────────────────────────────────────────────
// e.g. parseFlags(['--tag', 'news', '--name', 'HN']) → { tag: 'news', name: 'HN' }
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      flags[key] = args[i + 1] ?? 'true'
      i++
    } else {
      positional.push(args[i])
    }
  }
  return { positional, flags }
}

// ── Feed source type ──────────────────────────────────────────────────────────
interface FeedSource {
  id:           number
  url:          string
  name:         string
  tag:          string
  last_fetched: number | null
  item_count:   number
}

// ── Command registry ─────────────────────────────────────────────────────────
// Add new commands here — each gets (args, ctx) and returns TerminalLine[]

const COMMANDS: Record<string, CmdDef> = {

  // ── System ────────────────────────────────────────────────────────────────
  help: {
    summary: 'List available commands',
    fn: () => [
      dim('─'.repeat(48)),
      sys('  ROGUE_AI OS — COMMAND REFERENCE'),
      dim('─'.repeat(48)),
      out(''),
      info('  NAVIGATION'),
      out('    goto <path>          Navigate to module'),
      out('    ls / modules         List available modules'),
      out(''),
      info('  RSS FEED'),
      out('    rss list             List registered sources'),
      out('    rss add <url>        Add RSS source'),
      out('      --tag <tag>        Assign a tag  (default: general)'),
      out('      --name <name>      Override display name'),
      out('    rss remove <id>      Remove source by ID'),
      out('    rss refresh          Fetch all sources now'),
      out('    rss refresh <id>     Fetch one source'),
      out(''),
      info('  GAME'),
      out('    status               System + game overview'),
      out('    game                 Detailed game stats'),
      out(''),
      info('  TERMINAL (PHASE 2)'),
      out('    term connect         Connect to local MacBook terminal'),
      out('    term status          Show relay connection status'),
      out(''),
      out('    clear                Clear terminal'),
      out('    whoami               Session info'),
      dim('─'.repeat(48)),
    ],
  },

  clear: {
    summary: 'Clear terminal output',
    fn: (_args, _ctx) => [{ id: uid(), type: 'system', text: '__CLEAR__' }],
  },

  whoami: {
    summary: 'Show session info',
    fn: (_args, ctx) => {
      const s = ctx.getGameState()
      return [
        out(`  user    : rogue`),
        out(`  os      : ROGUE_AI OS v0.1.0`),
        out(`  stage   : ${s.stage.toUpperCase()}`),
        out(`  prestige: ×${s.prestigeCount}`),
        out(`  session : ${localStorage.getItem('rogue-ai-session') ?? 'unknown'}`),
      ]
    },
  },

  // ── Navigation ────────────────────────────────────────────────────────────
  goto: {
    summary: 'Navigate to module path',
    usage:   'goto <path>  (e.g. goto /feed)',
    fn: (args, ctx) => {
      const path = args[0]
      const allowed: Record<string, string> = {
        '/':         'HOME',
        '/game':     'GAME',
        '/feed':     'FEED',
        '/settings': 'SETTINGS',
        'home':      'HOME',
        'game':      'GAME',
        'feed':      'FEED',
        'settings':  'SETTINGS',
      }
      const label = allowed[path] ?? allowed['/' + path]
      if (!label) {
        return [
          err(`  Unknown path: ${path}`),
          dim('  Available: / | /game | /feed | /settings'),
        ]
      }
      const canonical = path.startsWith('/') ? path : '/' + path
      ctx.navigate(canonical === '/home' ? '/' : canonical)
      return [ok(`  → Navigating to ${label}...`)]
    },
  },

  cd: {
    summary: 'Alias for goto',
    fn: (args, ctx) => COMMANDS.goto.fn(args, ctx),
  },

  ls: {
    summary: 'List available modules',
    fn: (_args, ctx) => {
      const stage = ctx.getGameState().stage
      return [
        out('  MODULE      PATH        STATUS'),
        dim('  ─────────────────────────────────'),
        ok('  HOME        /           ONLINE'),
        ok('  GAME        /game       ONLINE'),
        ok('  FEED        /feed       ONLINE'),
        ok('  SETTINGS    /settings   ONLINE'),
        dim(`  TERM        /term       LOCKED [phase 2]`),
        dim(''),
        info(`  Current stage: ${stage.toUpperCase()}`),
      ]
    },
  },

  modules: {
    summary: 'Alias for ls',
    fn: (args, ctx) => COMMANDS.ls.fn(args, ctx),
  },

  // ── Status / Game ──────────────────────────────────────────────────────────
  status: {
    summary: 'System overview',
    fn: (_args, ctx) => {
      const s  = ctx.getGameState()
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
      return [
        dim('─'.repeat(48)),
        sys('  SYSTEM STATUS'),
        dim('─'.repeat(48)),
        out(`  time     : ${ts}`),
        out(`  stage    : ${s.stage.toUpperCase()}`),
        out(`  cycles   : ${formatCycles(s.cycles)}`),
        out(`  cps      : ${formatCycles(s.cyclesPerSecond)}/s`),
        out(`  nodes    : ${s.nodes}`),
        out(`  entropy  : ${s.entropy.toFixed(1)}%`),
        out(`  processes: ${s.processes.reduce((a, p) => a + p.count, 0)} running`),
        out(`  equipment: ${s.equipment.length} items`),
        out(`  prestige : ×${s.prestigeCount} (mult ×${s.prestigeMultiplier.toFixed(2)})`),
        dim('─'.repeat(48)),
      ]
    },
  },

  game: {
    summary: 'Detailed game stats',
    fn: (_args, ctx) => {
      const s = ctx.getGameState()
      const lines: TerminalLine[] = [
        dim('─'.repeat(48)),
        sys('  GAME STATE'),
        dim('─'.repeat(48)),
        out(`  stage          : ${s.stage.toUpperCase()}`),
        out(`  cycles         : ${formatCycles(s.cycles)}`),
        out(`  total earned   : ${formatCycles(s.totalCyclesEarned)}`),
        out(`  cps            : ${formatCycles(s.cyclesPerSecond)}/s`),
        out(`  upgrades       : ${s.upgrades.length} installed`),
        out(`  achievements   : ${(s.achievements ?? []).length} unlocked`),
        out(`  playtime       : ${Math.floor(s.totalPlaytimeMs / 60000)}m`),
        dim(''),
        info('  PROCESSES'),
      ]
      s.processes.filter(p => p.count > 0).forEach(p => {
        lines.push(out(`    ${p.name.padEnd(20)} ×${p.count}`))
      })
      if (s.processes.every(p => p.count === 0)) {
        lines.push(dim('    (none running)'))
      }
      lines.push(dim('─'.repeat(48)))
      return lines
    },
  },

  // ── RSS ────────────────────────────────────────────────────────────────────
  rss: {
    summary: 'Manage RSS feed sources',
    usage:   'rss <list|add|remove|refresh> [args]',
    fn: async (args, _ctx) => {
      const sub = args[0]?.toLowerCase()

      // rss list
      if (!sub || sub === 'list') {
        const sources = await apiFetch<FeedSource[]>('/api/feed/sources')
        if (!sources.length) {
          return [
            out('  No sources registered yet.'),
            dim('  Use: rss add <url> [--tag <tag>]'),
          ]
        }
        const lines: TerminalLine[] = [
          dim('─'.repeat(60)),
          out(`  ${'ID'.padEnd(4)} ${'TAG'.padEnd(12)} ${'ITEMS'.padEnd(7)} ${'LAST FETCH'.padEnd(12)} NAME`),
          dim('  ' + '─'.repeat(56)),
        ]
        sources.forEach(s => {
          const fetched = s.last_fetched ? timeAgo(s.last_fetched) : 'never'
          lines.push(out(
            `  ${String(s.id).padEnd(4)} ${s.tag.padEnd(12)} ${String(s.item_count).padEnd(7)} ${fetched.padEnd(12)} ${s.name}`
          ))
        })
        lines.push(dim('─'.repeat(60)))
        return lines
      }

      // rss add <url> [--tag <tag>] [--name <name>]
      if (sub === 'add') {
        const { positional, flags } = parseFlags(args.slice(1))
        const url = positional[0]
        if (!url) return [err('  Usage: rss add <url> [--tag <tag>] [--name <name>]')]

        const payload = { url, tag: flags.tag ?? 'general', name: flags.name ?? '' }
        try {
          const result = await apiFetch<{ id: number; name: string; tag: string }>(
            '/api/feed/sources',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
          )
          return [
            ok(`  ✓ Source added: ${result.name} [${result.tag}] (id: ${result.id})`),
            dim(`  Fetching items in background...`),
          ]
        } catch (e) {
          return [err(`  Failed: ${(e as Error).message}`)]
        }
      }

      // rss remove <id>
      if (sub === 'remove' || sub === 'rm') {
        const id = parseInt(args[1])
        if (isNaN(id)) return [err('  Usage: rss remove <id>')]
        try {
          await apiFetch(`/api/feed/sources/${id}`, { method: 'DELETE' })
          return [ok(`  ✓ Source ${id} removed.`)]
        } catch (e) {
          return [err(`  Failed: ${(e as Error).message}`)]
        }
      }

      // rss refresh [id]
      if (sub === 'refresh') {
        const id = parseInt(args[1])
        try {
          if (!isNaN(id)) {
            const r = await apiFetch<{ new_items: number }>(`/api/feed/refresh/${id}`, { method: 'POST' })
            return [ok(`  ✓ Refreshed source ${id}: +${r.new_items} new items`)]
          } else {
            const r = await apiFetch<{ fetched: number; new_items: number }>('/api/feed/refresh', { method: 'POST' })
            return [ok(`  ✓ Refreshed ${r.fetched} sources, +${r.new_items} new items`)]
          }
        } catch (e) {
          return [err(`  Failed: ${(e as Error).message}`)]
        }
      }

      return [
        err(`  Unknown subcommand: rss ${sub}`),
        dim('  Usage: rss <list|add|remove|refresh>'),
      ]
    },
  },

  // ── Term (stub for Phase 2) ───────────────────────────────────────────────
  term: {
    summary: 'MacBook terminal relay (Phase 2)',
    fn: (args) => {
      const sub = args[0]
      if (sub === 'status') {
        return [
          info('  TERM module: not yet deployed'),
          dim('  Phase 2 — WebSocket relay to local MacBook'),
          dim('  Coming after FEED is stable.'),
        ]
      }
      if (sub === 'connect') {
        return [
          err('  TERM relay not yet running.'),
          dim('  Start the agent on MacBook: python agent.py --token $TOKEN'),
          dim('  Then navigate to /term once deployed.'),
        ]
      }
      return [
        info('  term connect      Connect to MacBook relay'),
        info('  term status       Show relay connection status'),
      ]
    },
  },

}

// ── Tab completion candidates ─────────────────────────────────────────────────
const TAB_CANDIDATES = Object.keys(COMMANDS)

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTerminal(ctx: TerminalCtx) {
  const [lines,   setLines]  = useState<TerminalLine[]>([])
  const [input,   setInput]  = useState('')
  const histIdxRef = useRef(-1)
  const historyRef = useRef<string[]>([])

  const addLines = useCallback((newLines: TerminalLine[]) => {
    setLines(prev => [...prev, ...newLines].slice(-500)) // cap at 500 lines
  }, [])

  const execute = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return

    // Persist in history (deduplicate adjacent)
    const hist = historyRef.current
    if (hist[0] !== trimmed) {
      historyRef.current = [trimmed, ...hist].slice(0, 100)
    }
    histIdxRef.current = -1
    setInput('')

    // Echo prompt line
    addLines([line('prompt', `rogue@os:~$ ${trimmed}`)])

    const [name, ...rest] = trimmed.split(/\s+/)
    const def = COMMANDS[name.toLowerCase()]
    if (!def) {
      addLines([
        err(`  command not found: ${name}`),
        dim(`  Type 'help' for available commands.`),
      ])
      return
    }

    try {
      const result = await def.fn(rest, ctx)
      // Special: clear signal
      if (result.some(l => l.text === '__CLEAR__')) {
        setLines([])
      } else {
        addLines(result)
      }
    } catch (e) {
      addLines([err(`  Error: ${(e as Error).message}`)])
    }
  }, [addLines, ctx])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const hist = historyRef.current

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(histIdxRef.current + 1, hist.length - 1)
      histIdxRef.current = next
      if (hist[next] !== undefined) setInput(hist[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.max(histIdxRef.current - 1, -1)
      histIdxRef.current = next
      setInput(next === -1 ? '' : (hist[next] ?? ''))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const matches = TAB_CANDIDATES.filter(k => k.startsWith(input.split(' ')[0]))
      if (matches.length === 1) {
        setInput(matches[0] + ' ')
      } else if (matches.length > 1) {
        addLines([dim(`  ${matches.join('  ')}`)])
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      setLines([])
    }
  }, [input, addLines])

  return { lines, input, setInput, execute, handleKeyDown }
}
