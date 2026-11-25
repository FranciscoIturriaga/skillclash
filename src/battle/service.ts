/**
 * Worker-side battle persistence. Server actions and the cron sweep both go
 * through this file; it is the only code that writes battle state.
 *
 * Every change follows the same four steps (DECISIONS D10/D15):
 *   1. read the battle (state at version N)
 *   2. run the pure state machine → state N+1, or a typed error
 *   3. claim (battleId, fromVersion N) in `battle_transitions`; uniqueOn lets
 *      exactly one concurrent caller win. The loser re-reads and re-validates
 *      against the new state (up to MAX_ATTEMPTS), then reports a conflict.
 *   4. write state N+1 to the battle row, then reveal any videos whose round
 *      just ended its submission window.
 *
 * If step 4 fails after step 3, the claimed row still holds `toState`; the
 * next caller (or the cron sweep) replays it. Replaying writes the exact same
 * value, so it is idempotent.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'
import {
  currentRoundState,
  dueAction,
  transition,
  type BattleAction,
  type BattleEvent,
  type BattleState,
  type MachineErrorCode,
  type RoundNumber,
  type Side,
} from './machine'

export const MAX_ATTEMPTS = 3
/**
 * Voting is tallied a few seconds after its deadline so a vote accepted just
 * before the deadline has landed before we count (DECISIONS D27).
 */
export const VOTE_SETTLE_MS = 3000

export type ServiceErrorCode =
  | MachineErrorCode
  | 'not_found'
  | 'conflict'
  | 'storage_error'
  | 'bad_request'
  | 'competitor'
  | 'already_voted'
  | 'voting_closed'
  | 'username_taken'
  | 'no_username'

export interface ServiceError {
  code: ServiceErrorCode
  message: string
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ServiceError }

export function err<T = never>(code: ServiceErrorCode, message: string): Outcome<T> {
  return { ok: false, error: { code, message } }
}

/** Convert a service outcome to the action wire shape. */
export function toActionResult<T>(o: Outcome<T>): ActionResult<T> {
  return o.ok
    ? { success: true, data: o.value }
    : { success: false, error: o.error.message, code: o.error.code }
}

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface BattleRow {
  battleId: string
  playerA: string
  playerB: string
  modeId: string
  status: BattleState['status']
  phase: string | null
  currentRound: number | null
  version: number
  nextDeadline: number | null
  state: BattleState
}

export interface SubmissionRow {
  battleId: string
  round: number
  playerId: string
  side: Side
  fileKey: string
  mimeType?: string
  sizeBytes?: number
  durationSec?: number
  skill?: string
  revealed: 'no' | 'yes'
}

export interface TransitionRow {
  battleId: string
  fromVersion: number
  action: string
  actor: string
  at: number
  toState: BattleState
}

export function roundId(battleId: string, round: number): string {
  return `${battleId}_r${round}`
}

export function submissionId(battleId: string, round: number, side: Side): string {
  return `${battleId}_r${round}_${side}`
}

/** The mirror columns the feed filters on, derived from the state. */
export function rowFromState(state: BattleState): Omit<BattleRow, 'battleId' | 'playerA' | 'playerB' | 'modeId'> {
  const round = currentRoundState(state)
  const nextDeadline =
    round?.phase === 'submit' ? round.submitDeadline : round?.phase === 'vote' ? round.voteDeadline : null
  return {
    status: state.status,
    phase: round?.phase ?? null,
    currentRound: state.currentRound,
    version: state.version,
    nextDeadline,
    state,
  }
}

function isDuplicate(r: ActionResult<unknown>): boolean {
  return !r.success && /duplicate/i.test(r.error)
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function loadBattle(tools: ActionTools, battleId: string): Promise<Outcome<BattleState>> {
  if (typeof battleId !== 'string' || !battleId) return err('bad_request', 'Missing battleId.')
  const r = await tools.get<BattleRow & Record<string, unknown>>('battles', battleId)
  if (!r.success) return err('not_found', 'Battle not found.')
  return { ok: true, value: r.data.record.data.state }
}

/**
 * Read every matching row, following `nextOffset` (pages cap at ~30 KB, and
 * `count` is only the page length).
 */
export async function queryAll<T extends Record<string, unknown>>(
  tools: ActionTools,
  collection: string,
  where: Record<string, unknown>,
  maxRows = 5000,
): Promise<Array<{ recordId: string; data: T }>> {
  const out: Array<{ recordId: string; data: T }> = []
  let offset = 0
  while (out.length < maxRows) {
    const r = await tools.query<T>(collection, { where, limit: 200, offset } as Parameters<ActionTools['query']>[1])
    if (!r.success) throw new Error(`query ${collection} failed: ${r.error}`)
    out.push(...r.data.records)
    const next = (r.data as { nextOffset?: number }).nextOffset
    if (next === undefined || r.data.records.length === 0) break
    offset = next
  }
  return out
}

export async function countVotes(tools: ActionTools, battleId: string, round: number) {
  const votes = await queryAll<{ side: string }>(tools, 'votes', { roundId: roundId(battleId, round) })
  let a = 0
  let b = 0
  for (const v of votes) {
    if (v.data.side === 'a') a++
    else if (v.data.side === 'b') b++
  }
  return { a, b, total: a + b }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface Committed {
  state: BattleState
  events: BattleEvent[]
}

/**
 * Hook called after every successful commit with the events it produced.
 * Set by the email module (phase 4); failures there never undo a commit.
 */
export type EventHook = (battleId: string, state: BattleState, events: BattleEvent[]) => Promise<void>

/**
 * Make videos visible for every round whose submission window has ended.
 * Only sides the state machine counted as submitted are revealed, so a late
 * upload that the machine refused stays hidden. Safe to call repeatedly.
 */
export async function revealEndedRounds(tools: ActionTools, battleId: string, state: BattleState) {
  for (const round of state.rounds) {
    if (round.revealedAt === null) continue
    for (const side of ['a', 'b'] as const) {
      if (!round.submitted[side]) continue
      const id = submissionId(battleId, round.number, side)
      const sub = await tools.get<SubmissionRow & Record<string, unknown>>('submissions', id)
      if (sub.success && sub.data.record.data.revealed !== 'yes') {
        await tools.update('submissions', id, { revealed: 'yes' })
      }
    }
  }
}

/** Replay a claimed-but-unwritten transition (step 4 failed earlier). */
export async function repairIfStuck(tools: ActionTools, battleId: string, version: number): Promise<boolean> {
  const claimed = await tools.query<TransitionRow & Record<string, unknown>>('battle_transitions', {
    where: { battleId, fromVersion: version },
    limit: 1,
  })
  if (!claimed.success || claimed.data.records.length === 0) return false
  const current = await loadBattle(tools, battleId)
  // Only replay if the battle is still at that version, so we never move it backwards.
  if (!current.ok || current.value.version !== version) return false
  const toState = claimed.data.records[0].data.toState
  const w = await tools.update('battles', battleId, rowFromState(toState))
  if (w.success) {
    console.warn(`[battle] repaired ${battleId} v${version} -> v${toState.version}`)
    await revealEndedRounds(tools, battleId, toState)
  }
  return w.success
}

/** Steps 2–4 for one action against a state we just read. */
async function commitOnce(
  tools: ActionTools,
  battleId: string,
  before: BattleState,
  action: BattleAction,
  actor: string,
  now: number,
): Promise<Outcome<Committed>> {
  const result = transition(before, action, now)
  if (!result.ok) return err(result.error.code, result.error.message)
  const next = result.state

  const claim = await tools.create('battle_transitions', {
    battleId,
    fromVersion: before.version,
    action: action.type,
    actor,
    at: now,
    toState: next,
  } satisfies TransitionRow)
  if (!claim.success) {
    if (isDuplicate(claim)) return err('conflict', 'Someone else changed this battle at the same moment.')
    return err('storage_error', claim.error)
  }

  const write = await tools.update('battles', battleId, rowFromState(next))
  if (!write.success) {
    console.error(`[battle] claimed ${battleId} v${before.version} but write failed: ${write.error}`)
    return err('storage_error', 'Saved partially; it will finish automatically within a minute.')
  }
  await revealEndedRounds(tools, battleId, next)
  return { ok: true, value: { state: next, events: result.events } }
}

/**
 * Bring a battle up to date with the clock: apply every deadline that has
 * passed (submission deadline, then vote close with the tally). Used lazily
 * by every action and by the cron sweep. Idempotent.
 */
export async function advance(
  tools: ActionTools,
  battleId: string,
  now: number,
  actor: string,
  onEvents?: EventHook,
): Promise<Outcome<BattleState>> {
  let loaded = await loadBattle(tools, battleId)
  if (!loaded.ok) return loaded
  if (await repairIfStuck(tools, battleId, loaded.value.version)) {
    loaded = await loadBattle(tools, battleId)
    if (!loaded.ok) return loaded
  }
  let state = loaded.value

  // At most 3 rounds × 2 deadlines, plus slack for conflict retries.
  for (let i = 0; i < 10; i++) {
    const due = dueAction(state, now)
    if (!due) break
    let action: BattleAction
    if (due === 'closeVoting') {
      const round = currentRoundState(state)!
      if (now < round.voteDeadline! + VOTE_SETTLE_MS) break
      const tally = await countVotes(tools, battleId, round.number)
      action = { type: 'closeVoting', votesA: tally.a, votesB: tally.b }
    } else {
      action = { type: 'submissionDeadline' }
    }
    const c = await commitOnce(tools, battleId, state, action, actor, now)
    if (c.ok) {
      state = c.value.state
      if (onEvents) await safeHook(onEvents, battleId, state, c.value.events)
      continue
    }
    if (c.error.code !== 'conflict') return c
    // Someone else advanced it; re-read and keep going.
    const again = await loadBattle(tools, battleId)
    if (!again.ok) return again
    state = again.value
  }
  return { ok: true, value: state }
}

/**
 * Run one player action: catch the battle up with the clock, then apply the
 * action with the expected-version guard. On a conflict, re-read and
 * re-validate (the action may now be invalid, e.g. a second accept).
 */
export async function runAction(
  tools: ActionTools,
  battleId: string,
  makeAction: (state: BattleState) => BattleAction,
  actor: string,
  now: number,
  onEvents?: EventHook,
): Promise<Outcome<Committed>> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await advance(tools, battleId, now, actor, onEvents)
    if (!current.ok) return current
    const c = await commitOnce(tools, battleId, current.value, makeAction(current.value), actor, now)
    if (c.ok) {
      if (onEvents) await safeHook(onEvents, battleId, c.value.state, c.value.events)
      return c
    }
    if (c.error.code !== 'conflict') return c
  }
  return err('conflict', 'This battle is busy right now. Try again.')
}

async function safeHook(hook: EventHook, battleId: string, state: BattleState, events: BattleEvent[]) {
  if (events.length === 0) return
  try {
    await hook(battleId, state, events)
  } catch (e) {
    console.error(`[battle] event hook failed for ${battleId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function asRound(n: unknown): RoundNumber | null {
  return n === 1 || n === 2 || n === 3 ? n : null
}
