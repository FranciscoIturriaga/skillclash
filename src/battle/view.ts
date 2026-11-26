/**
 * Client-side view helpers: turn a BattleState into what the UI shows.
 * Pure functions only (unit tested in view.test.ts).
 */

import {
  currentRoundState,
  inviteDeadline,
  roundPoints,
  setterOf,
  sideOf,
  usesSetterRules,
  type BattleState,
  type RoundState,
  type Side,
} from './machine'
import { getMode } from './modes'

export interface BattleRowData {
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

export interface SubmissionData {
  battleId: string
  round: number
  playerId: string
  side: Side
  fileKey: string
  mimeType?: string
  durationSec?: number
  skill?: string
  revealed: 'no' | 'yes'
}

export type MyBucket = 'invite' | 'sent' | 'my_turn' | 'in_progress' | 'finished'

/** Which "My battles" group a battle goes in, from the viewer's side. */
export function bucketFor(state: BattleState, userId: string): MyBucket | null {
  const side = sideOf(state, userId)
  if (!side) return null
  if (state.status === 'invited') return side === 'b' ? 'invite' : 'sent'
  if (state.status !== 'active') return 'finished' // declined, cancelled, expired, complete
  const round = currentRoundState(state)
  if (round?.phase === 'submit' && !round.submitted[side]) return 'my_turn'
  return 'in_progress'
}

/** Short status line for a battle card, from the viewer's side (or a spectator's). */
export function statusLabel(state: BattleState, userId: string | null): string {
  const side = userId ? sideOf(state, userId) : null
  switch (state.status) {
    case 'invited':
      return side === 'b' ? 'Challenge received' : side === 'a' ? 'Waiting for opponent' : 'Challenge sent'
    case 'declined':
      return 'Declined'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired'
    case 'complete':
      if (!state.result) return 'Final'
      if (state.result.winner === 'draw') return 'Draw'
      if (side) return state.result.winner === side ? 'You won' : 'You lost'
      return 'Final'
    case 'active': {
      const r = currentRoundState(state)
      if (!r) return 'In progress'
      // One-round battles (Rapid Fire, D63) don't number their round.
      const prefix = state.rounds.length > 1 ? `Round ${r.number} · ` : ''
      if (r.phase === 'vote') return `${prefix}Voting`
      if (side && !r.submitted[side]) return `${prefix}Your turn`
      return `${prefix}Filming`
    }
  }
}

/** True once a battle can't change any more (played out, declined, cancelled or expired). */
export function isFinished(state: Pick<BattleState, 'status'>): boolean {
  return state.status !== 'invited' && state.status !== 'active'
}

/**
 * The summary line on a finished battle's card, from `perspectiveId`'s side
 * (the profile being viewed): "Won · Standard · Nov 25". Round skills are not
 * shown on past cards. The date is when it finished (completed, or when the
 * invite was answered, cancelled or expired). Null for live battles.
 */
export function pastSummary(state: BattleState, perspectiveId: string | null, timeZone?: string): string | null {
  if (!isFinished(state)) return null
  const side = perspectiveId ? sideOf(state, perspectiveId) : null
  let result: string
  if (state.status === 'complete') {
    const w = state.result?.winner
    result = w === 'draw' ? 'Draw' : !w || !side ? 'Final' : w === side ? 'Won' : 'Lost'
  } else {
    result = state.status === 'declined' ? 'Declined' : state.status === 'cancelled' ? 'Cancelled' : 'Expired'
  }
  const mode = getMode(state.modeId)?.name ?? 'Standard'
  const at = state.completedAt ?? state.respondedAt ?? state.createdAt
  const date = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })
  return `${result} · ${mode} · ${date}`
}

/** The deadline a countdown should show right now, or null. */
export function activeDeadline(state: BattleState): { at: number; kind: 'submit' | 'vote' } | null {
  const r = currentRoundState(state)
  if (state.status !== 'active' || !r) return null
  if (r.phase === 'submit' && r.submitDeadline) return { at: r.submitDeadline, kind: 'submit' }
  if (r.phase === 'vote' && r.voteDeadline) return { at: r.voteDeadline, kind: 'vote' }
  return null
}

/** When an open invite expires, or null if the battle isn't waiting for an answer. */
export function inviteExpiry(state: BattleState): number | null {
  return state.status === 'invited' ? inviteDeadline(state) : null
}

/** Coarse time left for an invite: "23h", "45m", "<1m". Rounds down, like a countdown. */
export function formatExpiresIn(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/** "11:59:03", "4:05", "0:09"; a day or more is "6d 23h" (demo voting, D65). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total >= 86_400) return `${Math.floor(total / 86_400)}d ${Math.floor((total % 86_400) / 3600)}h`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Points so far per side (closed rounds only). */
export function runningScore(state: BattleState): { a: number; b: number } {
  let a = 0
  let b = 0
  for (const r of state.rounds) {
    if (r.outcome) {
      const p = roundPoints(r.outcome)
      a += p.a
      b += p.b
    }
  }
  return { a, b }
}

export function roundLabel(r: RoundState): string {
  if (r.number === 3) return 'Freestyle'
  // Under the setter rules a skill stays hidden until its round opens (D53).
  return r.skill ?? 'Skill hidden'
}

/**
 * "Voting now" order (D58): the sum of both players' stored total points,
 * highest first; ties broken by the soonest voting deadline. Players with no
 * stats row count as 0. Returns a new array.
 */
export function sortVotingNow<T extends { playerA: string; playerB: string; nextDeadline: number | null }>(
  rows: T[],
  pointsOf: (userId: string) => number,
): T[] {
  const sum = (r: T) => pointsOf(r.playerA) + pointsOf(r.playerB)
  const due = (r: T) => r.nextDeadline ?? Number.POSITIVE_INFINITY
  return [...rows].sort((x, y) => sum(y) - sum(x) || due(x) - due(y))
}

export function otherSide(side: Side): Side {
  return side === 'a' ? 'b' : 'a'
}

export interface RoundSlot {
  round: RoundState
  /** Past rounds start collapsed; the current and locked rounds don't collapse. */
  collapsible: boolean
}

/**
 * Battle page order, the same for players and voters (D46): the current round
 * first, then past rounds newest first (collapsed), then rounds not reached
 * yet. A finished battle has no current round, so it is 3, 2, 1.
 */
export function roundDisplayOrder(state: BattleState): RoundSlot[] {
  const current = state.status === 'active' ? currentRoundState(state) : null
  const others = state.rounds.filter((r) => r !== current)
  const past = others.filter((r) => r.phase === 'closed').sort((x, y) => y.number - x.number)
  const later = others.filter((r) => r.phase !== 'closed').sort((x, y) => x.number - y.number)
  return [
    ...(current ? [{ round: current, collapsible: false }] : []),
    ...past.map((round) => ({ round, collapsible: true })),
    ...later.map((round) => ({ round, collapsible: false })),
  ]
}

/**
 * One short line for a locked (pending) round, worded for who is looking
 * (D55). Never names an unrevealed skill unless the viewer set it
 * (`ownSkill` comes from the viewer's own hidden row).
 */
export function lockedRoundCopy(
  state: BattleState,
  round: 1 | 2 | 3,
  viewer: Side | null,
  names: { a: string; b: string },
  ownSkill?: string | null,
): string {
  if (round === 3) return 'Freestyle. Opens after round 2'
  if (!usesSetterRules(state)) {
    // Legacy battles (D54): skills were public from the start.
    const skill = state.rounds[round - 1].skill
    const when = round === 1 ? 'Opens when the challenge is accepted' : 'Opens after round 1'
    return skill ? `${skill}. ${when}` : when
  }
  const setter = setterOf(state, round)!
  const other: Side = setter === 'a' ? 'b' : 'a'
  if (viewer === setter) {
    if (!ownSkill && round === 2 && state.status === 'invited') return "You'll set this when accepting"
    const yours = ownSkill ? `Your skill: ${ownSkill}` : 'Your skill'
    return round === 1
      ? `${yours}. Revealed to @${names[other]} when they accept`
      : `${yours}. Revealed to @${names[other]} when round 2 starts`
  }
  if (round === 1) return viewer === 'b' ? `Set by @${names.a}. Revealed when you accept` : 'Revealed when the battle starts'
  return viewer === 'a' ? `Set by @${names.b}. Revealed when round 2 starts` : 'Revealed when round 2 starts'
}
