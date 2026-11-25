/**
 * Client-side view helpers: turn a BattleState into what the UI shows.
 * Pure functions only (unit tested in view.test.ts).
 */

import {
  currentRoundState,
  inviteDeadline,
  roundPoints,
  sideOf,
  type BattleState,
  type RoundState,
  type Side,
} from './machine'

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
      if (r.phase === 'vote') return `Round ${r.number} · Voting`
      if (side && !r.submitted[side]) return `Round ${r.number} · Your turn`
      return `Round ${r.number} · Filming`
    }
  }
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

/** "11:59:03", "4:05", "0:09". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
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
  return r.skill ?? 'Skill TBD'
}

export interface ProfileStats {
  played: number
  won: number
  lost: number
  tied: number
  roundWins: number
  points: number
}

/** Profile numbers, computed from the player's completed battles (DECISIONS D30). */
export function profileStats(battles: BattleState[], userId: string): ProfileStats {
  const s: ProfileStats = { played: 0, won: 0, lost: 0, tied: 0, roundWins: 0, points: 0 }
  for (const b of battles) {
    const side = sideOf(b, userId)
    if (!side || b.status !== 'complete' || !b.result) continue
    s.played++
    if (b.result.winner === 'draw') s.tied++
    else if (b.result.winner === side) s.won++
    else s.lost++
    s.roundWins += b.result.roundWins[side]
    s.points += b.result.total[side]
  }
  return s
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
