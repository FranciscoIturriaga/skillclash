/**
 * Energy (GAME_RULES.md "Energy", DECISIONS D66).
 *
 * Each player has up to 5 energy. Sending a challenge costs 1, a refused
 * challenge (declined, cancelled, expired) refunds it, and winning a battle
 * gives +1. While below 5, energy refills +1 every 5 hours.
 *
 * Two collections, the same shape as stored stats (D56):
 *   - `energy_entries`: the ledger. Every change is one row with a unique
 *     `key`: `spend:<player>:<n>` (n = how many spends the player already
 *     had, so two simultaneous spends can't both pass the check),
 *     `refund:<battleId>` and `win:<battleId>` (so a replayed event can never
 *     refund or reward twice), `dev:<random>` (local test reset only).
 *   - `player_energy`: one public row per player (record id = user id), the
 *     ledger replayed into `{ energy, lastRefillAt }`. The client computes the
 *     current value from it with `currentEnergy`, so refills need no cron.
 *
 * Written only by the server.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'
import type { BattleState } from './machine'
import { getMode } from './modes'
import { queryAll } from './service'

export const ENERGY_MAX = 5
export const ENERGY_REFILL_MS = 5 * 60 * 60 * 1000

/** What's stored: energy as of `lastRefillAt`. `lastRefillAt` is null when full (no timer). */
export interface EnergySnapshot {
  energy: number
  lastRefillAt: number | null
}

/** Energy right now, plus when the next +1 lands (null when full). */
export interface EnergyNow {
  energy: number
  nextRefillAt: number | null
}

export const FULL: EnergySnapshot = { energy: ENERGY_MAX, lastRefillAt: null }

export type EnergyKind = 'spend' | 'refund' | 'win' | 'set'

export interface EnergyEntry {
  key: string
  playerId: string
  battleId?: string
  kind: EnergyKind
  /** -1 spend, +1 refund/win; for 'set', the absolute value. */
  amount: number
  at: number
}

// ─── Pure ───────────────────────────────────────────────────────────────────

const clamp = (n: number) => Math.max(0, Math.min(ENERGY_MAX, Math.floor(n)))

/** Apply the refills that landed between the snapshot and `t`. */
export function refillTo(s: EnergySnapshot, t: number): EnergySnapshot {
  if (s.energy >= ENERGY_MAX || s.lastRefillAt === null) return { energy: clamp(s.energy), lastRefillAt: s.energy >= ENERGY_MAX ? null : s.lastRefillAt }
  const ticks = Math.max(0, Math.floor((t - s.lastRefillAt) / ENERGY_REFILL_MS))
  const energy = Math.min(ENERGY_MAX, s.energy + ticks)
  return energy >= ENERGY_MAX ? FULL : { energy, lastRefillAt: s.lastRefillAt + ticks * ENERGY_REFILL_MS }
}

/** Current energy from a stored row (no row = a new player = full). */
export function currentEnergy(row: Partial<EnergySnapshot> | null | undefined, now: number): EnergyNow {
  const snap: EnergySnapshot =
    row && typeof row.energy === 'number'
      ? { energy: row.energy, lastRefillAt: typeof row.lastRefillAt === 'number' ? row.lastRefillAt : null }
      : FULL
  const s = refillTo(snap, now)
  return { energy: s.energy, nextRefillAt: s.lastRefillAt === null ? null : s.lastRefillAt + ENERGY_REFILL_MS }
}

/**
 * One ledger entry applied at its time. The refill timer starts when energy
 * drops below 5 and keeps its progress while it stays below 5; reaching 5
 * stops it. Gains past 5 are lost (capped).
 */
export function applyEntry(s: EnergySnapshot, e: Pick<EnergyEntry, 'kind' | 'amount' | 'at'>): EnergySnapshot {
  const before = refillTo(s, e.at)
  const energy = clamp(e.kind === 'set' ? e.amount : before.energy + e.amount)
  if (energy >= ENERGY_MAX) return FULL
  return { energy, lastRefillAt: before.lastRefillAt ?? e.at }
}

/** Replay a player's ledger (any order) into a snapshot. */
export function replay(entries: ReadonlyArray<Pick<EnergyEntry, 'kind' | 'amount' | 'at'>>): EnergySnapshot {
  return [...entries].sort((x, y) => x.at - y.at).reduce(applyEntry, FULL)
}

/** "2h 14m", "14m", "1m": time until `at`, rounded up to the minute. */
export function formatRefill(at: number, now: number): string {
  const mins = Math.max(1, Math.ceil((at - now) / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function outOfEnergyMessage(e: EnergyNow, now: number): string {
  return `Out of energy. Next refill in ${formatRefill(e.nextRefillAt ?? now + ENERGY_REFILL_MS, now)}.`
}

/** Whether a mode's challenges cost energy (demo battles don't). */
export function modeUsesEnergy(modeId: string): boolean {
  return getMode(modeId)?.energy ?? false
}

/**
 * What a battle's end means for energy: a refund to the challenger for a
 * refused challenge, +1 to the winner of a completed one, nothing for a draw.
 * Pure; the refund only happens if the challenge was paid for (see
 * `settleBattleEnergy`).
 */
export function energyOutcome(state: BattleState): { kind: 'refund' | 'win'; playerId: string } | null {
  if (!modeUsesEnergy(state.modeId)) return null
  if (state.status === 'declined' || state.status === 'cancelled' || state.status === 'expired') {
    return { kind: 'refund', playerId: state.playerA }
  }
  if (state.status === 'complete' && state.result && state.result.winner !== 'draw') {
    return { kind: 'win', playerId: state.result.winner === 'a' ? state.playerA : state.playerB }
  }
  return null
}

// ─── Worker ─────────────────────────────────────────────────────────────────

function isDuplicate(r: ActionResult<unknown>): boolean {
  return !r.success && /duplicate/i.test(r.error)
}

export async function ledgerOf(tools: ActionTools, playerId: string): Promise<EnergyEntry[]> {
  const rows = await queryAll<EnergyEntry & Record<string, unknown>>(tools, 'energy_entries', { playerId })
  return rows.map((r) => r.data)
}

/** Recompute a player's public energy row from their ledger (upsert by user id). */
export async function recountEnergy(tools: ActionTools, playerId: string): Promise<EnergySnapshot> {
  const snap = replay(await ledgerOf(tools, playerId))
  const w = await tools.create('player_energy', { userId: playerId, energy: snap.energy, lastRefillAt: snap.lastRefillAt }, playerId)
  if (!w.success) throw new Error(`player_energy write failed: ${w.error}`)
  return snap
}

/** A player's energy right now, read from the ledger (the server's source of truth). */
export async function energyNow(tools: ActionTools, playerId: string, now: number): Promise<EnergyNow> {
  return currentEnergy(replay(await ledgerOf(tools, playerId)), now)
}

export type SpendResult =
  | { ok: true; energy: EnergyNow }
  | { ok: false; code: 'out_of_energy' | 'conflict' | 'storage_error'; message: string }

/**
 * Take 1 energy for a challenge. The ledger key `spend:<player>:<n>` is the
 * guard: two simultaneous spends read the same n, one wins, the other gets a
 * Duplicate, re-reads (now seeing the first spend) and checks again.
 */
export async function spendEnergy(tools: ActionTools, playerId: string, battleId: string, now: number): Promise<SpendResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entries = await ledgerOf(tools, playerId)
    // Never write an entry that sorts before one already there.
    const at = Math.max(now, ...entries.map((e) => e.at))
    const cur = currentEnergy(replay(entries), at)
    if (cur.energy < 1) return { ok: false, code: 'out_of_energy', message: outOfEnergyMessage(cur, now) }
    const n = entries.filter((e) => e.kind === 'spend').length
    const r = await tools.create('energy_entries', {
      key: `spend:${playerId}:${n}`,
      playerId,
      battleId,
      kind: 'spend',
      amount: -1,
      at,
    } satisfies EnergyEntry)
    if (r.success) {
      const snap = await recountEnergy(tools, playerId).catch((e) => {
        console.error(`[energy] recount ${playerId}: ${e instanceof Error ? e.message : String(e)}`)
        return replay([...entries, { kind: 'spend', amount: -1, at } as EnergyEntry])
      })
      return { ok: true, energy: currentEnergy(snap, now) }
    }
    if (!isDuplicate(r)) return { ok: false, code: 'storage_error', message: r.error }
  }
  return { ok: false, code: 'conflict', message: 'Your energy changed at the same moment. Try again.' }
}

/**
 * Give back the energy a challenge cost, at most once (key `refund:<battleId>`).
 * Does nothing if the challenge was never paid for (sent before energy
 * existed, or a mode without energy). Returns whether a refund was written now.
 */
export async function refundChallenge(tools: ActionTools, battleId: string, now: number): Promise<boolean> {
  const spends = await tools.query<EnergyEntry & Record<string, unknown>>('energy_entries', {
    where: { battleId, kind: 'spend' },
    limit: 1,
  })
  if (!spends.success) throw new Error(`energy_entries query failed: ${spends.error}`)
  const spend = spends.data.records[0]?.data
  if (!spend) return false
  return grant(tools, { key: `refund:${battleId}`, playerId: spend.playerId, battleId, kind: 'refund', amount: 1, at: now })
}

/** +1 to the winner of a battle, at most once (key `win:<battleId>`). */
export async function rewardWin(tools: ActionTools, battleId: string, playerId: string, now: number): Promise<boolean> {
  return grant(tools, { key: `win:${battleId}`, playerId, battleId, kind: 'win', amount: 1, at: now })
}

async function grant(tools: ActionTools, entry: EnergyEntry): Promise<boolean> {
  const r = await tools.create('energy_entries', { ...entry })
  if (!r.success && !isDuplicate(r)) throw new Error(`energy_entries write failed for ${entry.key}: ${r.error}`)
  // Recount even on a Duplicate, so a recount an earlier failure skipped is fixed.
  await recountEnergy(tools, entry.playerId)
  return r.success
}

/**
 * Energy for a battle that just ended (called from the event hook and the
 * repair path). Idempotent: replays find the refund/win key already taken.
 */
export async function settleBattleEnergy(tools: ActionTools, battleId: string, state: BattleState, now: number): Promise<string | null> {
  const o = energyOutcome(state)
  if (!o) return null
  if (o.kind === 'refund') return (await refundChallenge(tools, battleId, now)) ? 'refund' : null
  return (await rewardWin(tools, battleId, o.playerId, now)) ? 'win' : null
}

/** Local dev server only (the action checks): set a player's energy, for the browser tests. */
export async function devSetEnergy(tools: ActionTools, playerId: string, value: number, now: number): Promise<EnergySnapshot> {
  const key = `dev:${playerId}:${now}:${Math.random().toString(36).slice(2, 10)}`
  const r = await tools.create('energy_entries', { key, playerId, kind: 'set', amount: clamp(value), at: now } satisfies EnergyEntry)
  if (!r.success) throw new Error(r.error)
  return recountEnergy(tools, playerId)
}
