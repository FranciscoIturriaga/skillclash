/**
 * Stored player stats (DECISIONS D56, replaces D30's client-side computation).
 *
 * Two collections:
 *   - `stats_entries`: the ledger. One row per player per completed battle
 *     with what that battle added to their profile. `uniqueOn [battleId,
 *     playerId]` makes counting a battle twice impossible: a replay of the
 *     completion, a repair, or the backfill gets a Duplicate refusal.
 *   - `player_stats`: one public row per player (record id = user id), the
 *     sum of their ledger rows. Recomputed from the ledger after every write
 *     instead of incremented (no compare-and-set in the SDK; a recount heals
 *     itself, same idea as the live vote total in D28).
 *
 * Written only by the server: from the event hook when `battle_completed`
 * fires, from `repairIfStuck` when a completion is replayed, and once by the
 * backfill for battles that finished before this existed.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'
import type { BattleState, Side } from './machine'
import { queryAll, type BattleRow } from './service'

export interface PlayerStats {
  points: number
  played: number
  won: number
  lost: number
  tied: number
  roundWins: number
}

export const EMPTY_STATS: PlayerStats = { points: 0, played: 0, won: 0, lost: 0, tied: 0, roundWins: 0 }

export interface StatsEntry extends PlayerStats {
  battleId: string
  playerId: string
  side: Side
}

// ─── Pure ───────────────────────────────────────────────────────────────────

/**
 * What a battle adds to each player's profile: one entry per player, or none
 * if the battle didn't complete (declined, cancelled, expired, still running).
 */
export function statsEntriesFor(battleId: string, state: BattleState): StatsEntry[] {
  const result = state.result
  if (state.status !== 'complete' || !result) return []
  return (['a', 'b'] as const).map((side) => {
    const playerId = side === 'a' ? state.playerA : state.playerB
    return {
      battleId,
      playerId,
      side,
      points: result.total[side],
      played: 1,
      won: result.winner === side ? 1 : 0,
      lost: result.winner !== 'draw' && result.winner !== side ? 1 : 0,
      tied: result.winner === 'draw' ? 1 : 0,
      roundWins: result.roundWins[side],
    }
  })
}

/** Sum ledger rows into profile totals. */
export function sumStats(entries: ReadonlyArray<Partial<PlayerStats>>): PlayerStats {
  const s = { ...EMPTY_STATS }
  for (const e of entries) {
    for (const k of Object.keys(EMPTY_STATS) as Array<keyof PlayerStats>) s[k] += Number(e[k]) || 0
  }
  return s
}

/** A player's stats from a stored row (or zeros when they have none yet). */
export function statsFromRow(row: Partial<PlayerStats> | null | undefined): PlayerStats {
  return sumStats(row ? [row] : [])
}

// ─── Worker ─────────────────────────────────────────────────────────────────

function isDuplicate(r: ActionResult<unknown>): boolean {
  return !r.success && /duplicate/i.test(r.error)
}

/** Recompute one player's public stats row from their ledger rows. */
export async function recountPlayerStats(tools: ActionTools, playerId: string): Promise<PlayerStats> {
  const rows = await queryAll<StatsEntry & Record<string, unknown>>(tools, 'stats_entries', { playerId })
  const stats = sumStats(rows.map((r) => r.data))
  // Record id = user id, so this is an upsert of the player's single row.
  const w = await tools.create('player_stats', { userId: playerId, ...stats }, playerId)
  if (!w.success) throw new Error(`player_stats write failed: ${w.error}`)
  return stats
}

/**
 * Count a completed battle on both players' profiles, at most once.
 * Returns how many ledger rows were new (0 on a replay). Always recounts both
 * players, so a recount that an earlier failure skipped gets fixed here.
 */
export async function recordBattleStats(tools: ActionTools, battleId: string, state: BattleState): Promise<{ counted: number }> {
  const entries = statsEntriesFor(battleId, state)
  let counted = 0
  for (const e of entries) {
    const r = await tools.create('stats_entries', { ...e })
    if (r.success) counted++
    else if (!isDuplicate(r)) throw new Error(`stats_entries write failed for ${battleId}: ${r.error}`)
  }
  for (const e of entries) await recountPlayerStats(tools, e.playerId)
  return { counted }
}

export const STATS_BACKFILL_MARKER = 'stats-backfill-v1'

/**
 * Count every battle that completed before stored stats existed. Safe to run
 * more than once (the ledger refuses repeats); `runStatsBackfillOnce` makes
 * sure it normally runs exactly once.
 */
export async function backfillStats(tools: ActionTools): Promise<{ battles: number; counted: number }> {
  const done = await queryAll<BattleRow & Record<string, unknown>>(tools, 'battles', { status: 'complete' })
  let counted = 0
  for (const b of done) {
    const r = await recordBattleStats(tools, b.recordId, b.data.state)
    counted += r.counted
  }
  return { battles: done.length, counted }
}

/**
 * Run the backfill if its marker row doesn't exist yet, then write the
 * marker. Called by the cron sweep. If the backfill fails halfway there's no
 * marker, so the next sweep tries again, and the ledger skips what was done.
 */
export async function runStatsBackfillOnce(tools: ActionTools): Promise<boolean> {
  const marker = await tools.get('app_migrations', STATS_BACKFILL_MARKER)
  if (marker.success) return false
  const r = await backfillStats(tools)
  const w = await tools.create('app_migrations', { name: STATS_BACKFILL_MARKER, at: Date.now() }, STATS_BACKFILL_MARKER)
  if (!w.success && !isDuplicate(w)) throw new Error(`marker write failed: ${w.error}`)
  console.log(`[stats] backfill done battles=${r.battles} counted=${r.counted}`)
  return true
}
