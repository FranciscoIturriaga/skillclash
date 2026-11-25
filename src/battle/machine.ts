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
 *   invited ──accept (by B)──▶ active ──last round closes──▶ complete
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
 *   Nothing is played until B accepts. Every round is always played. The
 *   mode sets how many rounds there are (`rounds` in modes.ts: 3 in Standard,
 *   1 in Rapid Fire, D63); `state.rounds` holds exactly that many, and the
 *   battle completes when the last one closes. The mode also says whether
 *   the battle bonus applies. Nothing below branches on the mode itself.
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
 * Skills and setter videos (rules v2, D53): Player A names round 1's skill AND
 * films it when challenging; Player B names round 2's (different) skill AND
 * films it when accepting. Those skill names and videos live only on hidden
 * submission rows; this state never holds a skill before its round opens.
 * When round 1 or 2 opens, its setter counts as already submitted and the
 * skill is written into the round (the server reads it from the hidden row and
 * passes it on the action that opens the round). Only the other player (the
 * replicator) has a deadline in those rounds: when they submit, voting opens;
 * if they miss, the setter wins by forfeit. Round 3 is freestyle and blind,
 * unchanged: each player names their own skill on their submission.
 *
 * Battles created before D53 have no `rules` field (legacy, v1): both players
 * submit blind in every round and the round 1/2 skills sit in the state from
 * the start. In-progress legacy battles finish that way; legacy invites can no
 * longer be accepted (D54).
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
  /**
   * Shared skill for rounds 1 and 2; null for round 3 (freestyle). Under the
   * setter rules it stays null until the round opens (D53).
   */
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
  /** Battle bonus: +10 overall win, +5 each for a draw; 0/0 in modes without it. */
  bonus: Pair
  /** roundPoints + bonus. This is what goes on profiles. */
  total: Pair
}

export interface BattleState {
  /** Bumped by every successful transition; the concurrency guard keys on it. */
  version: number
  /** 2 = setter rules (D53). Absent on battles created before them (legacy). */
  rules?: 2
  modeId: ModeId
  playerA: string
  playerB: string
  status: BattleStatus
  /** The round being played; null before accept and after the battle ends. */
  currentRound: RoundNumber | null
  /** One entry per round of the mode: 3 (Standard) or 1 (Rapid Fire). */
  rounds: RoundState[]
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
  /**
   * B accepts and names round 2's skill. `round1Skill` is A's skill, read by
   * the server from A's hidden setter submission (v2); legacy battles have it
   * in the state already.
   */
  | { type: 'accept'; by: string; round2Skill?: string | null; round1Skill?: string | null }
  | { type: 'decline'; by: string }
  /** The challenger withdraws an invite that hasn't been answered yet. */
  | { type: 'cancel'; by: string }
  /** The invite's answer deadline has passed. */
  | { type: 'inviteExpiry' }
  | { type: 'submit'; by: string; round: RoundNumber }
  /**
   * The current round's submission deadline has passed. `nextSkill` is the
   * setter's skill for the round this opens (v2 round 2), read by the server
   * from the hidden submission row.
   */
  | { type: 'submissionDeadline'; nextSkill?: string | null }
  /** The current round's voting window has ended; carries the final tally. */
  | { type: 'closeVoting'; votesA: number; votesB: number; nextSkill?: string | null }

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
  | 'legacy_invite'
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

/**
 * Final battle result once every round is closed. `battleBonus` comes from
 * the mode (false in Rapid Fire, D63).
 */
export function battleResult(outcomes: RoundOutcome[], battleBonus = true): BattleResult {
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
  const bonus = !battleBonus
    ? { a: 0, b: 0 }
    : winner === 'draw'
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

/** True for battles under the setter rules (D53); false for legacy battles. */
export function usesSetterRules(state: Pick<BattleState, 'rules'>): boolean {
  return state.rules === 2
}

/**
 * Who set this round's skill and pre-filmed it (v2): A in round 1, B in round
 * 2. Null for round 3 (freestyle) and for every round of a legacy battle.
 */
export function setterOf(state: Pick<BattleState, 'rules'>, round: RoundNumber): Side | null {
  if (!usesSetterRules(state)) return null
  return round === 1 ? 'a' : round === 2 ? 'b' : null
}

/**
 * Which submission rows everyone may see right now (round + side). The
 * service flips exactly these to revealed; nothing else is ever public.
 *   - A round whose submission window ended: every side that submitted.
 *   - v2 rounds 1–2 once open: the setter's video (the skill to match).
 */
export function publicSubmissions(state: BattleState): Array<{ round: RoundNumber; side: Side }> {
  const out: Array<{ round: RoundNumber; side: Side }> = []
  for (const r of state.rounds) {
    const setter = setterOf(state, r.number)
    for (const side of ['a', 'b'] as const) {
      const ended = r.revealedAt !== null && r.submitted[side]
      const setterOpen = side === setter && r.phase !== 'pending'
      if (ended || setterOpen) out.push({ round: r.number, side })
    }
  }
  return out
}

/** How many rounds a mode plays (3 if the mode is unknown, like every pre-D63 battle). */
export function roundsForMode(modeId: string): number {
  return getMode(modeId)?.rounds ?? 3
}

/** Whether the mode awards the battle bonus (true if unknown). */
export function bonusForMode(modeId: string): boolean {
  return getMode(modeId)?.battleBonus ?? true
}

/** True when this round is the battle's last (round 3 in Standard, round 1 in Rapid Fire). */
export function isLastRound(state: Pick<BattleState, 'rounds'>, round: number): boolean {
  return round >= state.rounds.length
}

/**
 * Round 3 of a 3-round battle: freestyle, each player names their own skill.
 * Rapid Fire's only round is a set-and-match round, not freestyle.
 */
export function isFreestyle(state: Pick<BattleState, 'rounds'>, round: number): boolean {
  return round === 3 && state.rounds.length === 3
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

/**
 * Open a round's submission window starting at `at`. In v2 rounds 1–2 the
 * setter's video already exists, so the setter counts as submitted and the
 * round's skill (read from the hidden row by the server) becomes public.
 */
function openRound(state: BattleState, number: RoundNumber, at: number, skill?: string | null): BattleState {
  const round = state.rounds[number - 1]
  const setter = setterOf(state, number)
  const opened: RoundState = { ...round, phase: 'submit', submitDeadline: at + submitWindow(state) }
  if (setter) {
    opened.submitted = { ...round.submitted, [setter]: true }
    if (!opened.skill) opened.skill = normalizeSkill(skill) ?? null
  }
  return { ...withRound(state, opened), currentRound: number }
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
  nextSkill?: string | null,
): BattleState {
  const round = currentRoundState(state)!
  let next = withRound(state, { ...round, phase: 'closed', closedAt: at, outcome })
  events.push({ type: 'round_closed', round: round.number, outcome })

  if (!isLastRound(next, round.number)) {
    return openRound(next, (round.number + 1) as RoundNumber, at, nextSkill)
  }
  const result = battleResult(next.rounds.map((r) => r.outcome!), bonusForMode(next.modeId))
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

/**
 * Player A challenges Player B. The battle waits in 'invited' until B answers.
 * The round 1 skill is checked here but NOT stored: it stays on A's hidden
 * setter submission until round 1 opens (D53).
 */
export function createBattle(input: NewBattle, now: number): MachineResult {
  const mode = getMode(input.modeId)
  if (!mode) return fail('invalid_mode', `Unknown mode "${input.modeId}".`)
  if (input.playerA === input.playerB) return fail('self_challenge', "You can't challenge yourself.")
  const skill = normalizeSkill(input.round1Skill)
  if (!skill) return fail('invalid_skill', `Name a skill (1–${SKILL_MAX_LENGTH} characters).`)

  const state: BattleState = {
    version: 0,
    rules: 2,
    modeId: mode.id,
    playerA: input.playerA,
    playerB: input.playerB,
    status: 'invited',
    currentRound: null,
    rounds: Array.from({ length: mode.rounds }, (_, i) => emptyRound((i + 1) as RoundNumber, null)),
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
    // B answers the challenge and round 1 opens. In a multi-round battle,
    // accepting also names (and films) round 2's skill; a 1-round battle
    // (Rapid Fire) has no round 2, so B accepts with nothing to name (D63).
    case 'accept': {
      const closed = inviteClosed(state, now)
      if (closed) return closed
      if (action.by !== state.playerB) return fail('wrong_player', 'Only the challenged player can accept.')
      if (!usesSetterRules(state)) {
        return fail('legacy_invite', 'This challenge was sent under the old rules. Ask for a new one.')
      }
      const round1Skill = normalizeSkill(action.round1Skill)
      if (state.rounds.length > 1) {
        const skill = normalizeSkill(action.round2Skill)
        if (!skill) return fail('invalid_skill', `Name a skill for round 2 (1–${SKILL_MAX_LENGTH} characters).`)
        if (!round1Skill) return fail('invalid_skill', "Round 1's skill is missing.")
        if (skill.toLowerCase() === round1Skill.toLowerCase()) {
          return fail('same_skill', 'Round 2 needs a different skill from round 1.')
        }
      } else if (!round1Skill) {
        return fail('invalid_skill', "Round 1's skill is missing.")
      }
      // Round 2's skill is NOT stored: it stays on B's hidden setter
      // submission until round 2 opens.
      const next = openRound({ ...state, status: 'active', respondedAt: now }, 1, now, round1Skill)
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
      return { ok: true, state: closeRound(revealed, outcome, at, events, action.nextSkill), events }
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
      return { ok: true, state: closeRound(state, outcome, at, events, action.nextSkill), events }
    }
  }
}
