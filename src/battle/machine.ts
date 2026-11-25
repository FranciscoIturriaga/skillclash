/**
 * SkillClash battle state machine.
 *
 * This is the ONE place battle rules live (GAME_RULES.md "Architecture rule").
 * It is pure: no database, no SDK, no clock. Callers pass the current state,
 * an action, and the current time; they get back either the next state or a
 * typed error. Server actions and the cron sweep both call `transition`, and
 * persist the result with an expected-version check (see DECISIONS D10).
 *
 * ── Battle lifecycle ────────────────────────────────────────────────────────
 *
 *   invited ──accept (by B)──▶ active ──round 3 closes──▶ complete
 *      │
 *      ├────decline (by B)──────────────▶ declined
 *      ├────cancel (by A)───────────────▶ cancelled
 *      └────invite deadline passes──────▶ expired   (inviteExpiry, time-driven)
 *
 *   An invite must be answered before `inviteExpiresAt` (the mode's invite
 *   window after creation, 24h in Standard). At or after that moment it can
 *   no longer be accepted, declined or cancelled; the cron sweep and the lazy
 *   check in every action apply `inviteExpiry`. Declined, cancelled and
 *   expired battles are final and free the one-open-battle-per-pair rule.
 *
 *   A battle is created by Player A challenging Player B (`createBattle`).
 *   Nothing is played until B accepts. All 3 rounds are always played.
 *
 * ── Round lifecycle (one round at a time, inside an active battle) ──────────
 *
 *   pending ──previous round closed (or battle accepted)──▶ submit
 *
 *   submit  ──both players submitted──────────────────────▶ vote
 *   submit  ──deadline passed, exactly one submitted──────▶ closed (forfeit: submitter +10)
 *   submit  ──deadline passed, nobody submitted───────────▶ closed (both missed: 0 / 0)
 *
 *   vote    ──vote deadline passed (with the tally)───────▶ closed (scored by votes)
 *
 *   "submit": both players upload a video before one shared deadline. Videos
 *             stay hidden until this phase ends.
 *   "vote":   videos are revealed; anyone except the two players may vote.
 *             Voting always runs its full window, even if it ends early on
 *             submissions.
 *   "closed": the round has an outcome and points. The next round opens at
 *             the moment this one closed.
 *
 * Skills: Player A names round 1's skill when challenging; Player B names
 * round 2's (different) skill when accepting; round 3 is freestyle, so each
 * player names their own skill on their submission (not tracked here).
 */

import { getMode, type ModeId } from './modes'

// ─── Types ──────────────────────────────────────────────────────────────────

/** 'a' is the challenger, 'b' the challenged player. */
export type Side = 'a' | 'b'
export type RoundNumber = 1 | 2 | 3
export type BattleStatus = 'invited' | 'declined' | 'cancelled' | 'expired' | 'active' | 'complete'
export type RoundPhase = 'pending' | 'submit' | 'vote' | 'closed'

/** How a round ended. Points are derived from this by `roundPoints`. */
export type RoundOutcome =
  /** Both submitted and voting closed. Equal votes, including 0–0, is a tie. */
  | { kind: 'votes'; winner: Side | 'tie'; votesA: number; votesB: number }
  /** Exactly one player missed the submission deadline. No vote is held. */
  | { kind: 'forfeit'; winner: Side }
  /** Both players missed the submission deadline. */
  | { kind: 'both_missed' }

export interface RoundState {
  number: RoundNumber
  /** Shared skill for rounds 1 and 2; null for round 3 (freestyle). */
  skill: string | null
  phase: RoundPhase
  submitDeadline: number | null
  submitted: { a: boolean; b: boolean }
  /** When the submission window ended and videos became visible. */
  revealedAt: number | null
  voteDeadline: number | null
  closedAt: number | null
  outcome: RoundOutcome | null
}

export interface Pair {
  a: number
  b: number
}

export interface BattleResult {
  winner: Side | 'draw'
  roundWins: Pair
  /** Sum of round points (10 win / 5 tie / 0 loss or both missed). */
  roundPoints: Pair
  /** Battle bonus: +10 overall win, +5 each for a draw. */
  bonus: Pair
  /** roundPoints + bonus. This is what goes on profiles. */
  total: Pair
}

export interface BattleState {
  /** Bumped by every successful transition; the concurrency guard keys on it. */
  version: number
  modeId: ModeId
  playerA: string
  playerB: string
  status: BattleStatus
  /** The round being played; null before accept and after the battle ends. */
  currentRound: RoundNumber | null
  rounds: [RoundState, RoundState, RoundState]
  createdAt: number
  /**
   * When an unanswered invite expires. Battles created before D51 lack it;
   * read it through `inviteDeadline`, which falls back to createdAt + window.
   */
  inviteExpiresAt?: number | null
  /** When B accepted/declined, A cancelled, or the invite expired. */
  respondedAt: number | null
  completedAt: number | null
  result: BattleResult | null
}

export type BattleAction =
  | { type: 'accept'; by: string; round2Skill: string }
  | { type: 'decline'; by: string }
  /** The challenger withdraws an invite that hasn't been answered yet. */
  | { type: 'cancel'; by: string }
  /** The invite's answer deadline has passed. */
  | { type: 'inviteExpiry' }
  | { type: 'submit'; by: string; round: RoundNumber }
  /** The current round's submission deadline has passed. */
  | { type: 'submissionDeadline' }
  /** The current round's voting window has ended; carries the final tally. */
  | { type: 'closeVoting'; votesA: number; votesB: number }

/** Things that happened, so callers can send emails or log without diffing. */
export type BattleEvent =
  | { type: 'battle_started' }
  | { type: 'battle_declined' }
  | { type: 'battle_cancelled' }
  | { type: 'battle_expired' }
  | { type: 'submitted'; round: RoundNumber; side: Side }
  | { type: 'round_revealed'; round: RoundNumber }
  | { type: 'round_closed'; round: RoundNumber; outcome: RoundOutcome }
  | { type: 'battle_completed'; result: BattleResult }

export type MachineErrorCode =
  | 'invalid_mode'
  | 'invalid_skill'
  | 'same_skill'
  | 'self_challenge'
  | 'not_a_player'
  | 'wrong_player'
  | 'wrong_status'
  | 'invite_expired'
  | 'wrong_round'
  | 'wrong_phase'
  | 'already_submitted'
  | 'deadline_passed'
  | 'deadline_not_reached'
  | 'invalid_tally'

export interface MachineError {
  code: MachineErrorCode
  message: string
}

export type MachineResult =
  | { ok: true; state: BattleState; events: BattleEvent[] }
  | { ok: false; error: MachineError }

// ─── Scoring (GAME_RULES.md "Scoring") ──────────────────────────────────────

export const POINTS = {
  roundWin: 10,
  roundTie: 5,
  battleWin: 10,
  battleDraw: 5,
} as const

/** Points each player earns for one closed round. */
export function roundPoints(outcome: RoundOutcome): Pair {
  switch (outcome.kind) {
    case 'both_missed':
      return { a: 0, b: 0 }
    case 'forfeit':
      return outcome.winner === 'a' ? { a: POINTS.roundWin, b: 0 } : { a: 0, b: POINTS.roundWin }
    case 'votes':
      if (outcome.winner === 'tie') return { a: POINTS.roundTie, b: POINTS.roundTie }
      return outcome.winner === 'a' ? { a: POINTS.roundWin, b: 0 } : { a: 0, b: POINTS.roundWin }
  }
}

/** Who won a round, or null for a tie / both missed. */
export function roundWinner(outcome: RoundOutcome): Side | null {
  if (outcome.kind === 'both_missed') return null
  if (outcome.kind === 'votes' && outcome.winner === 'tie') return null
  return outcome.winner as Side
}

/** Final battle result once all three rounds are closed. */
export function battleResult(outcomes: RoundOutcome[]): BattleResult {
  const roundPts = { a: 0, b: 0 }
  const wins = { a: 0, b: 0 }
  for (const o of outcomes) {
    const p = roundPoints(o)
    roundPts.a += p.a
    roundPts.b += p.b
    const w = roundWinner(o)
    if (w) wins[w] += 1
  }
  // Higher round points wins the battle. (Point difference is always
  // 10 × round-win difference, so this is the same as comparing round wins.)
  const winner: Side | 'draw' =
    roundPts.a > roundPts.b ? 'a' : roundPts.b > roundPts.a ? 'b' : 'draw'
  const bonus =
    winner === 'draw'
      ? { a: POINTS.battleDraw, b: POINTS.battleDraw }
      : winner === 'a'
        ? { a: POINTS.battleWin, b: 0 }
        : { a: 0, b: POINTS.battleWin }
  return {
    winner,
    roundWins: wins,
    roundPoints: roundPts,
    bonus,
    total: { a: roundPts.a + bonus.a, b: roundPts.b + bonus.b },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const SKILL_MAX_LENGTH = 60

/** Trim and collapse whitespace. Returns null if empty or too long. */
export function normalizeSkill(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/\s+/g, ' ')
  if (s.length === 0 || s.length > SKILL_MAX_LENGTH) return null
  return s
}

export function sideOf(state: BattleState, userId: string): Side | null {
  if (userId === state.playerA) return 'a'
  if (userId === state.playerB) return 'b'
  return null
}

export function currentRoundState(state: BattleState): RoundState | null {
  return state.currentRound ? state.rounds[state.currentRound - 1] : null
}

/** When this battle's invite expires (stored, or createdAt + the mode's window for older battles). */
export function inviteDeadline(state: BattleState): number {
  if (typeof state.inviteExpiresAt === 'number') return state.inviteExpiresAt
  return state.createdAt + (getMode(state.modeId)?.inviteWindowMs ?? 24 * 60 * 60 * 1000)
}

export type DueAction = 'inviteExpiry' | 'submissionDeadline' | 'closeVoting'

/**
 * Which time-driven action is due right now, if any. The cron sweep and the
 * lazy check in server actions loop on this until it returns null.
 */
export function dueAction(state: BattleState, now: number): DueAction | null {
  if (state.status === 'invited') return now >= inviteDeadline(state) ? 'inviteExpiry' : null
  const round = currentRoundState(state)
  if (state.status !== 'active' || !round) return null
  if (round.phase === 'submit' && round.submitDeadline !== null && now >= round.submitDeadline) {
    return 'submissionDeadline'
  }
  if (round.phase === 'vote' && round.voteDeadline !== null && now >= round.voteDeadline) {
    return 'closeVoting'
  }
  return null
}

function fail(code: MachineErrorCode, message: string): MachineResult {
  return { ok: false, error: { code, message } }
}

/** Why an invite can't be answered or cancelled any more, or null if it still can. */
function inviteClosed(state: BattleState, now: number): MachineResult | null {
  switch (state.status) {
    case 'invited':
      return now >= inviteDeadline(state) ? fail('invite_expired', 'This challenge expired.') : null
    case 'expired':
      return fail('invite_expired', 'This challenge expired.')
    case 'cancelled':
      return fail('wrong_status', 'The challenger cancelled this challenge.')
    case 'declined':
      return fail('wrong_status', 'This challenge was declined.')
    default:
      return fail('wrong_status', 'This challenge was already answered.')
  }
}

function emptyRound(number: RoundNumber, skill: string | null): RoundState {
  return {
    number,
    skill,
    phase: 'pending',
    submitDeadline: null,
    submitted: { a: false, b: false },
    revealedAt: null,
    voteDeadline: null,
    closedAt: null,
    outcome: null,
  }
}

/** Copy the state with one round replaced. Never mutates the input. */
function withRound(state: BattleState, round: RoundState): BattleState {
  const rounds = [...state.rounds] as BattleState['rounds']
  rounds[round.number - 1] = round
  return { ...state, rounds }
}

function submitWindow(state: BattleState): number {
  return getMode(state.modeId)!.submitWindowMs
}

function voteWindow(state: BattleState): number {
  return getMode(state.modeId)!.voteWindowMs
}

/** Open a round's submission window starting at `at`. */
function openRound(state: BattleState, number: RoundNumber, at: number): BattleState {
  const round = state.rounds[number - 1]
  return {
    ...withRound(state, { ...round, phase: 'submit', submitDeadline: at + submitWindow(state) }),
    currentRound: number,
  }
}

/**
 * Close the current round with an outcome at time `at`, then either open the
 * next round (starting at the same moment) or finish the battle.
 */
function closeRound(
  state: BattleState,
  outcome: RoundOutcome,
  at: number,
  events: BattleEvent[],
): BattleState {
  const round = currentRoundState(state)!
  let next = withRound(state, { ...round, phase: 'closed', closedAt: at, outcome })
  events.push({ type: 'round_closed', round: round.number, outcome })

  if (round.number < 3) {
    return openRound(next, (round.number + 1) as RoundNumber, at)
  }
  const result = battleResult(next.rounds.map((r) => r.outcome!))
  next = { ...next, status: 'complete', currentRound: null, completedAt: at, result }
  events.push({ type: 'battle_completed', result })
  return next
}

// ─── Creating a battle ──────────────────────────────────────────────────────

export interface NewBattle {
  playerA: string
  playerB: string
  modeId: string
  round1Skill: string
}

/** Player A challenges Player B. The battle waits in 'invited' until B answers. */
export function createBattle(input: NewBattle, now: number): MachineResult {
  const mode = getMode(input.modeId)
  if (!mode) return fail('invalid_mode', `Unknown mode "${input.modeId}".`)
  if (input.playerA === input.playerB) return fail('self_challenge', "You can't challenge yourself.")
  const skill = normalizeSkill(input.round1Skill)
  if (!skill) return fail('invalid_skill', `Name a skill (1–${SKILL_MAX_LENGTH} characters).`)

  const state: BattleState = {
    version: 0,
    modeId: mode.id,
    playerA: input.playerA,
    playerB: input.playerB,
    status: 'invited',
    currentRound: null,
    rounds: [emptyRound(1, skill), emptyRound(2, null), emptyRound(3, null)],
    createdAt: now,
    inviteExpiresAt: now + mode.inviteWindowMs,
    respondedAt: null,
    completedAt: null,
    result: null,
  }
  return { ok: true, state, events: [] }
}

// ─── Transitions ────────────────────────────────────────────────────────────

/**
 * The single entry point for changing a battle. Returns the next state with
 * `version` bumped by one, or a typed error and no state change.
 */
export function transition(state: BattleState, action: BattleAction, now: number): MachineResult {
  const result = apply(state, action, now)
  if (!result.ok) return result
  return { ...result, state: { ...result.state, version: state.version + 1 } }
}

function apply(state: BattleState, action: BattleAction, now: number): MachineResult {
  const events: BattleEvent[] = []

  switch (action.type) {
    // B answers the challenge. Accepting names round 2's skill and opens round 1.
    case 'accept': {
      const closed = inviteClosed(state, now)
      if (closed) return closed
      if (action.by !== state.playerB) return fail('wrong_player', 'Only the challenged player can accept.')
      const skill = normalizeSkill(action.round2Skill)
      if (!skill) return fail('invalid_skill', `Name a skill for round 2 (1–${SKILL_MAX_LENGTH} characters).`)
      if (skill.toLowerCase() === state.rounds[0].skill?.toLowerCase()) {
        return fail('same_skill', 'Round 2 needs a different skill from round 1.')
      }
      let next: BattleState = { ...state, status: 'active', respondedAt: now }
      next = withRound(next, { ...next.rounds[1], skill })
      next = openRound(next, 1, now)
      events.push({ type: 'battle_started' })
      return { ok: true, state: next, events }
    }

    case 'decline': {
      const closed = inviteClosed(state, now)
      if (closed) return closed
      if (action.by !== state.playerB) return fail('wrong_player', 'Only the challenged player can decline.')
      events.push({ type: 'battle_declined' })
      return { ok: true, state: { ...state, status: 'declined', respondedAt: now }, events }
    }

    // A withdraws the invite before B answers.
    case 'cancel': {
      const closed = inviteClosed(state, now)
      if (closed) return closed
      if (action.by !== state.playerA) return fail('wrong_player', 'Only the challenger can cancel this challenge.')
      events.push({ type: 'battle_cancelled' })
      return { ok: true, state: { ...state, status: 'cancelled', respondedAt: now }, events }
    }

    // Nobody answered the invite in time.
    case 'inviteExpiry': {
      if (state.status !== 'invited') return fail('wrong_status', 'This challenge is no longer waiting for an answer.')
      const at = inviteDeadline(state)
      if (now < at) return fail('deadline_not_reached', 'The invite has not expired yet.')
      events.push({ type: 'battle_expired' })
      // Stamped with the deadline itself, so a late sweep gives the same state.
      return { ok: true, state: { ...state, status: 'expired', respondedAt: at }, events }
    }

    // A player turns in their video for the current round.
    case 'submit': {
      if (state.status !== 'active') return fail('wrong_status', 'This battle is not in progress.')
      const side = sideOf(state, action.by)
      if (!side) return fail('not_a_player', 'Only the two players can submit videos.')
      const round = currentRoundState(state)!
      if (action.round !== round.number) {
        return fail('wrong_round', `Round ${round.number} is the current round, not round ${action.round}.`)
      }
      if (round.phase !== 'submit') return fail('wrong_phase', 'Submissions for this round are closed.')
      if (round.submitted[side]) return fail('already_submitted', 'You already submitted for this round.')
      if (now >= round.submitDeadline!) return fail('deadline_passed', 'The submission deadline has passed.')

      const submitted = { ...round.submitted, [side]: true }
      events.push({ type: 'submitted', round: round.number, side })

      // Both in: the submission window ends now, videos are revealed, voting opens.
      if (submitted.a && submitted.b) {
        events.push({ type: 'round_revealed', round: round.number })
        const voting: RoundState = {
          ...round,
          submitted,
          phase: 'vote',
          revealedAt: now,
          voteDeadline: now + voteWindow(state),
        }
        return { ok: true, state: withRound(state, voting), events }
      }
      return { ok: true, state: withRound(state, { ...round, submitted }), events }
    }

    // Submission deadline passed before both players submitted.
    case 'submissionDeadline': {
      if (state.status !== 'active') return fail('wrong_status', 'This battle is not in progress.')
      const round = currentRoundState(state)!
      if (round.phase !== 'submit') return fail('wrong_phase', 'This round is not taking submissions.')
      const at = round.submitDeadline!
      if (now < at) return fail('deadline_not_reached', 'The submission deadline has not passed yet.')

      const { a, b } = round.submitted
      // (Both submitted is impossible here: that moves the round to 'vote'.)
      const outcome: RoundOutcome =
        a && !b ? { kind: 'forfeit', winner: 'a' }
        : b && !a ? { kind: 'forfeit', winner: 'b' }
        : { kind: 'both_missed' }
      const revealed = withRound(state, { ...round, revealedAt: at })
      // The round closes at the deadline itself, not at `now`, so a late
      // sweep produces exactly the same state as an on-time one.
      return { ok: true, state: closeRound(revealed, outcome, at, events), events }
    }

    // Voting window ended. The caller counts the votes and passes the tally.
    case 'closeVoting': {
      if (state.status !== 'active') return fail('wrong_status', 'This battle is not in progress.')
      const round = currentRoundState(state)!
      if (round.phase !== 'vote') return fail('wrong_phase', 'This round is not in voting.')
      const at = round.voteDeadline!
      if (now < at) return fail('deadline_not_reached', 'Voting is still open.')
      const { votesA, votesB } = action
      if (![votesA, votesB].every((v) => Number.isInteger(v) && v >= 0)) {
        return fail('invalid_tally', 'Vote counts must be whole numbers ≥ 0.')
      }
      // Zero votes is 0–0, which is a tie (+5 each).
      const winner: Side | 'tie' = votesA > votesB ? 'a' : votesB > votesA ? 'b' : 'tie'
      const outcome: RoundOutcome = { kind: 'votes', winner, votesA, votesB }
      return { ok: true, state: closeRound(state, outcome, at, events), events }
    }
  }
}
