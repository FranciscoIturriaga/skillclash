import { describe, expect, it } from 'vitest'
import {
  battleResult,
  createBattle,
  dueAction,
  inviteDeadline,
  normalizeSkill,
  publicSubmissions,
  roundPoints,
  setterOf,
  transition,
  type BattleAction,
  type BattleState,
  type MachineResult,
} from './machine'
import { MODES } from './modes'

const A = 'user_a'
const B = 'user_b'
const C = 'user_c'
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)
const SUBMIT = MODES.test.submitWindowMs
const VOTE = MODES.test.voteWindowMs
const INVITE = MODES.test.inviteWindowMs

// ── helpers ────────────────────────────────────────────────────────────────

function ok(r: MachineResult): Extract<MachineResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r
}

function errCode(r: MachineResult): string {
  if (r.ok) throw new Error('expected an error, got ok')
  return r.error.code
}

function invited(): BattleState {
  return ok(createBattle({ playerA: A, playerB: B, modeId: 'test', round1Skill: 'Juggling' }, T0)).state
}

/** B accepts a setter-rules (v2) invite; the server passes A's hidden round 1 skill. */
function accepted(at = T0): BattleState {
  return ok(transition(invited(), { type: 'accept', by: B, round2Skill: 'Backflip', round1Skill: 'Juggling' }, at)).state
}

/**
 * A legacy (pre-D53) battle just accepted: no `rules`, skills in the state,
 * nobody pre-submitted. Legacy invites can't be accepted any more (D54), so
 * this builds the state the old machine left, as the 2 live old battles have.
 * Most gameplay tests below run on it, since the shared machinery (deadlines,
 * voting, scoring) is the same for both rule sets.
 */
function active(at = T0): BattleState {
  const { rules: _rules, ...inv } = invited()
  return {
    ...inv,
    version: 1,
    status: 'active',
    respondedAt: at,
    currentRound: 1,
    rounds: [
      { ...inv.rounds[0], skill: 'Juggling', phase: 'submit', submitDeadline: at + SUBMIT },
      { ...inv.rounds[1], skill: 'Backflip' },
      inv.rounds[2],
    ],
  }
}

function step(s: BattleState, action: BattleAction, now: number): BattleState {
  return ok(transition(s, action, now)).state
}

/** Both players submit at `at`; the round moves to voting. */
function bothSubmit(s: BattleState, at: number): BattleState {
  const r = s.currentRound!
  return step(step(s, { type: 'submit', by: A, round: r }, at), { type: 'submit', by: B, round: r }, at)
}

/** Close the current round's voting with a tally, exactly at its deadline. */
function closeVotes(s: BattleState, votesA: number, votesB: number): BattleState {
  const deadline = s.rounds[s.currentRound! - 1].voteDeadline!
  return step(s, { type: 'closeVoting', votesA, votesB }, deadline)
}

/** Let the current round's submission deadline pass. */
function passSubmitDeadline(s: BattleState): BattleState {
  const deadline = s.rounds[s.currentRound! - 1].submitDeadline!
  return step(s, { type: 'submissionDeadline' }, deadline)
}

// ── creating a battle ──────────────────────────────────────────────────────

describe('createBattle', () => {
  it('starts invited, version 0, setter rules, nothing open, and no skill in the state', () => {
    const s = invited()
    expect(s.status).toBe('invited')
    expect(s.version).toBe(0)
    expect(s.rules).toBe(2)
    expect(s.currentRound).toBeNull()
    expect(s.rounds.map((r) => r.phase)).toEqual(['pending', 'pending', 'pending'])
    // Round 1's skill stays on A's hidden submission row, never in the public state (D53).
    expect(s.rounds.map((r) => r.skill)).toEqual([null, null, null])
    expect(JSON.stringify(s)).not.toContain('Juggling')
    expect(s.rounds[0].submitted).toEqual({ a: false, b: false })
  })

  it('rejects self-challenge, unknown mode, and empty or too-long skill', () => {
    expect(errCode(createBattle({ playerA: A, playerB: A, modeId: 'test', round1Skill: 'x' }, T0))).toBe('self_challenge')
    expect(errCode(createBattle({ playerA: A, playerB: B, modeId: 'nope', round1Skill: 'x' }, T0))).toBe('invalid_mode')
    expect(errCode(createBattle({ playerA: A, playerB: B, modeId: 'test', round1Skill: '   ' }, T0))).toBe('invalid_skill')
    expect(errCode(createBattle({ playerA: A, playerB: B, modeId: 'test', round1Skill: 'x'.repeat(61) }, T0))).toBe('invalid_skill')
  })

  it('normalizes skill whitespace', () => {
    expect(normalizeSkill('  Kick   ups ')).toBe('Kick ups')
    expect(normalizeSkill(42)).toBeNull()
  })

  it('does not allow __proto__-style mode ids', () => {
    expect(errCode(createBattle({ playerA: A, playerB: B, modeId: 'constructor', round1Skill: 'x' }, T0))).toBe('invalid_mode')
  })
})

// ── accept / decline ───────────────────────────────────────────────────────

describe('accept and decline', () => {
  it('B accepts: battle active, round 1 open with its skill revealed, round 2 skill still hidden', () => {
    const r = ok(transition(invited(), { type: 'accept', by: B, round2Skill: 'Backflip', round1Skill: 'Juggling' }, T0 + 5))
    expect(r.events).toEqual([{ type: 'battle_started' }])
    const s = r.state
    expect(s.status).toBe('active')
    expect(s.version).toBe(1)
    expect(s.currentRound).toBe(1)
    expect(s.rounds[0].phase).toBe('submit')
    expect(s.rounds[0].skill).toBe('Juggling')
    expect(s.rounds[0].submitDeadline).toBe(T0 + 5 + SUBMIT)
    // A's video is A's round 1 submission.
    expect(s.rounds[0].submitted).toEqual({ a: true, b: false })
    expect(s.rounds[1].skill).toBeNull()
    expect(s.rounds[1].phase).toBe('pending')
    expect(JSON.stringify(s)).not.toContain('Backflip')
  })

  it('only B can accept or decline', () => {
    const acc = (by: string) => transition(invited(), { type: 'accept', by, round2Skill: 'Backflip', round1Skill: 'Juggling' }, T0)
    expect(errCode(acc(A))).toBe('wrong_player')
    expect(errCode(acc(C))).toBe('wrong_player')
    expect(errCode(transition(invited(), { type: 'decline', by: A }, T0))).toBe('wrong_player')
  })

  it('round 2 skill must be valid and different from round 1 (case-insensitive)', () => {
    const acc = (round2Skill: string, round1Skill?: string | null) =>
      transition(invited(), { type: 'accept', by: B, round2Skill, round1Skill }, T0)
    expect(errCode(acc('', 'Juggling'))).toBe('invalid_skill')
    expect(errCode(acc(' juggling ', 'Juggling'))).toBe('same_skill')
    // The server must supply round 1's skill (from A's hidden row).
    expect(errCode(acc('Backflip', null))).toBe('invalid_skill')
    expect(errCode(acc('Backflip'))).toBe('invalid_skill')
  })

  it('a legacy (pre-D53) invite can no longer be accepted, but can be declined or cancelled', () => {
    const { rules: _rules, ...legacy } = invited()
    legacy.rounds = [{ ...legacy.rounds[0], skill: 'Juggling' }, legacy.rounds[1], legacy.rounds[2]]
    expect(errCode(transition(legacy, { type: 'accept', by: B, round2Skill: 'Backflip' }, T0))).toBe('legacy_invite')
    expect(step(legacy, { type: 'decline', by: B }, T0).status).toBe('declined')
    expect(step(legacy, { type: 'cancel', by: A }, T0).status).toBe('cancelled')
  })

  it('B declines: battle declined, nothing opens', () => {
    const r = ok(transition(invited(), { type: 'decline', by: B }, T0))
    expect(r.state.status).toBe('declined')
    expect(r.state.currentRound).toBeNull()
    expect(r.events).toEqual([{ type: 'battle_declined' }])
  })

  it('cannot answer twice', () => {
    const declined = step(invited(), { type: 'decline', by: B }, T0)
    expect(errCode(transition(declined, { type: 'accept', by: B, round2Skill: 'Backflip' }, T0))).toBe('wrong_status')
    expect(errCode(transition(active(), { type: 'decline', by: B }, T0))).toBe('wrong_status')
    expect(errCode(transition(active(), { type: 'accept', by: B, round2Skill: 'Backflip' }, T0))).toBe('wrong_status')
  })

  it('nothing can be submitted before acceptance or after decline', () => {
    expect(errCode(transition(invited(), { type: 'submit', by: A, round: 1 }, T0))).toBe('wrong_status')
    const declined = step(invited(), { type: 'decline', by: B }, T0)
    expect(errCode(transition(declined, { type: 'submit', by: B, round: 1 }, T0))).toBe('wrong_status')
    expect(errCode(transition(invited(), { type: 'submissionDeadline' }, T0 + 10 * SUBMIT))).toBe('wrong_status')
  })
})

// ── legacy battles (pre-D53): shared gameplay machinery ─────────────────────
// The sections below (submit, deadlines, voting, dueAction, full battles) run
// on `active()`, a legacy battle where both players submit blind every round.

// ── submissions ────────────────────────────────────────────────────────────

describe('submit', () => {
  it('first submission marks that side only; round stays in submit', () => {
    const r = ok(transition(active(), { type: 'submit', by: A, round: 1 }, T0 + 1))
    expect(r.state.rounds[0].submitted).toEqual({ a: true, b: false })
    expect(r.state.rounds[0].phase).toBe('submit')
    expect(r.state.rounds[0].revealedAt).toBeNull()
    expect(r.events).toEqual([{ type: 'submitted', round: 1, side: 'a' }])
  })

  it('second submission ends the window early: reveal + voting opens for the full window', () => {
    const s1 = step(active(), { type: 'submit', by: A, round: 1 }, T0 + 1)
    const r = ok(transition(s1, { type: 'submit', by: B, round: 1 }, T0 + 2))
    const round = r.state.rounds[0]
    expect(round.phase).toBe('vote')
    expect(round.revealedAt).toBe(T0 + 2)
    expect(round.voteDeadline).toBe(T0 + 2 + VOTE)
    expect(r.events).toEqual([
      { type: 'submitted', round: 1, side: 'b' },
      { type: 'round_revealed', round: 1 },
    ])
  })

  it('rejects non-players, double submits, wrong round, and late submits', () => {
    const s = active()
    expect(errCode(transition(s, { type: 'submit', by: C, round: 1 }, T0))).toBe('not_a_player')
    const s1 = step(s, { type: 'submit', by: A, round: 1 }, T0)
    expect(errCode(transition(s1, { type: 'submit', by: A, round: 1 }, T0))).toBe('already_submitted')
    // skipping ahead to round 2 while round 1 is open
    expect(errCode(transition(s, { type: 'submit', by: A, round: 2 }, T0))).toBe('wrong_round')
    expect(errCode(transition(s, { type: 'submit', by: A, round: 1 }, T0 + SUBMIT))).toBe('deadline_passed')
  })

  it('cannot submit during voting', () => {
    const voting = bothSubmit(active(), T0 + 1)
    expect(errCode(transition(voting, { type: 'submit', by: A, round: 1 }, T0 + 2))).toBe('wrong_phase')
  })

  it('every successful transition bumps version by exactly one', () => {
    let s = active()
    expect(s.version).toBe(1)
    s = step(s, { type: 'submit', by: A, round: 1 }, T0 + 1)
    expect(s.version).toBe(2)
    s = step(s, { type: 'submit', by: B, round: 1 }, T0 + 1)
    expect(s.version).toBe(3)
  })

  it('never mutates the input state', () => {
    const s = active()
    const snapshot = JSON.stringify(s)
    bothSubmit(s, T0 + 1)
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})

// ── deadlines ──────────────────────────────────────────────────────────────

describe('missed submission deadlines', () => {
  it('deadline cannot be applied early', () => {
    expect(errCode(transition(active(), { type: 'submissionDeadline' }, T0 + SUBMIT - 1))).toBe('deadline_not_reached')
  })

  it('one player missed: submitter wins +10, no vote, next round opens at the deadline', () => {
    const s1 = step(active(), { type: 'submit', by: B, round: 1 }, T0 + 1)
    const late = T0 + SUBMIT + 45_000 // a sweep that ran 45s late
    const r = ok(transition(s1, { type: 'submissionDeadline' }, late))
    const round1 = r.state.rounds[0]
    expect(round1.phase).toBe('closed')
    expect(round1.outcome).toEqual({ kind: 'forfeit', winner: 'b' })
    expect(round1.voteDeadline).toBeNull()
    expect(roundPoints(round1.outcome!)).toEqual({ a: 0, b: 10 })
    expect(r.state.currentRound).toBe(2)
    // Next round is anchored to the deadline, not to when the sweep ran.
    expect(r.state.rounds[1].submitDeadline).toBe(T0 + SUBMIT + SUBMIT)
    expect(r.events.map((e) => e.type)).toEqual(['round_closed'])
  })

  it('A missed while B submitted (mirror case)', () => {
    const s1 = step(active(), { type: 'submit', by: A, round: 1 }, T0 + 1)
    const s2 = passSubmitDeadline(s1)
    expect(s2.rounds[0].outcome).toEqual({ kind: 'forfeit', winner: 'a' })
  })

  it('both missed: tie worth 0 each, next round opens', () => {
    const s = passSubmitDeadline(active())
    expect(s.rounds[0].outcome).toEqual({ kind: 'both_missed' })
    expect(roundPoints(s.rounds[0].outcome!)).toEqual({ a: 0, b: 0 })
    expect(s.currentRound).toBe(2)
    expect(s.rounds[1].phase).toBe('submit')
  })

  it('deadline action is rejected once the round has moved to voting', () => {
    const voting = bothSubmit(active(), T0 + 1)
    expect(errCode(transition(voting, { type: 'submissionDeadline' }, T0 + SUBMIT))).toBe('wrong_phase')
  })
})

// ── voting ─────────────────────────────────────────────────────────────────

describe('closing votes', () => {
  const voting = () => bothSubmit(active(), T0 + 1)

  it('voting always runs the full window', () => {
    const s = voting()
    expect(errCode(transition(s, { type: 'closeVoting', votesA: 3, votesB: 0 }, T0 + 1 + VOTE - 1))).toBe('deadline_not_reached')
  })

  it('more votes wins +10', () => {
    const s = closeVotes(voting(), 3, 1)
    expect(s.rounds[0].outcome).toEqual({ kind: 'votes', winner: 'a', votesA: 3, votesB: 1 })
    expect(roundPoints(s.rounds[0].outcome!)).toEqual({ a: 10, b: 0 })
    expect(s.currentRound).toBe(2)
    expect(s.rounds[1].submitDeadline).toBe(T0 + 1 + VOTE + SUBMIT)
  })

  it('equal votes is a tie, +5 each', () => {
    const s = closeVotes(voting(), 2, 2)
    expect(roundPoints(s.rounds[0].outcome!)).toEqual({ a: 5, b: 5 })
  })

  it('zero votes is a tie, +5 each', () => {
    const s = closeVotes(voting(), 0, 0)
    expect(s.rounds[0].outcome).toEqual({ kind: 'votes', winner: 'tie', votesA: 0, votesB: 0 })
    expect(roundPoints(s.rounds[0].outcome!)).toEqual({ a: 5, b: 5 })
  })

  it('rejects bad tallies and closing outside voting', () => {
    const s = voting()
    const at = s.rounds[0].voteDeadline!
    expect(errCode(transition(s, { type: 'closeVoting', votesA: -1, votesB: 0 }, at))).toBe('invalid_tally')
    expect(errCode(transition(s, { type: 'closeVoting', votesA: 1.5, votesB: 0 }, at))).toBe('invalid_tally')
    expect(errCode(transition(active(), { type: 'closeVoting', votesA: 0, votesB: 0 }, T0 + SUBMIT))).toBe('wrong_phase')
  })
})

// ── dueAction (what the sweep runs) ─────────────────────────────────────────

describe('dueAction', () => {
  it('is null before deadlines, and for declined battles', () => {
    expect(dueAction(invited(), T0 + INVITE - 1)).toBeNull()
    expect(dueAction(step(invited(), { type: 'decline', by: B }, T0 + 1), T0 + 10 * INVITE)).toBeNull()
    expect(dueAction(active(), T0 + SUBMIT - 1)).toBeNull()
  })

  it('names the submission deadline, then the vote close', () => {
    expect(dueAction(active(), T0 + SUBMIT)).toBe('submissionDeadline')
    const voting = bothSubmit(active(), T0 + 1)
    expect(dueAction(voting, T0 + 1 + VOTE - 1)).toBeNull()
    expect(dueAction(voting, T0 + 1 + VOTE)).toBe('closeVoting')
  })

  it('a long-idle battle can be caught up by looping until nothing is due', () => {
    let s = active()
    const farFuture = T0 + 100 * SUBMIT
    let steps = 0
    for (let due = dueAction(s, farFuture); due; due = dueAction(s, farFuture)) {
      s = step(s, due === 'closeVoting' ? { type: 'closeVoting', votesA: 0, votesB: 0 } : { type: 'submissionDeadline' }, farFuture)
      steps++
    }
    expect(steps).toBe(3)
    expect(s.status).toBe('complete')
    expect(s.result!.winner).toBe('draw')
    expect(s.result!.total).toEqual({ a: 5, b: 5 }) // 0 round points + 5 draw bonus each
  })
})

// ── full battles ───────────────────────────────────────────────────────────

describe('full 3-round battles', () => {
  it('A wins 2–1: round points + battle bonus', () => {
    let s = active()
    s = closeVotes(bothSubmit(s, T0 + 1), 4, 1) // R1: A
    expect(s.rounds[0].phase).toBe('closed')

    const t2 = s.rounds[1].submitDeadline! - SUBMIT + 1
    s = closeVotes(bothSubmit(s, t2), 0, 2) // R2: B

    const t3 = s.rounds[2].submitDeadline! - SUBMIT + 1
    s = bothSubmit(s, t3)
    const r = ok(transition(s, { type: 'closeVoting', votesA: 5, votesB: 3 }, s.rounds[2].voteDeadline!)) // R3: A

    expect(r.state.status).toBe('complete')
    expect(r.state.currentRound).toBeNull()
    expect(r.state.completedAt).toBe(s.rounds[2].voteDeadline)
    expect(r.state.result).toEqual({
      winner: 'a',
      roundWins: { a: 2, b: 1 },
      roundPoints: { a: 20, b: 10 },
      bonus: { a: 10, b: 0 },
      total: { a: 30, b: 10 },
    })
    expect(r.events.map((e) => e.type)).toEqual(['round_closed', 'battle_completed'])
  })

  it('draw: win, loss, tie → 15–15 and +5 bonus each', () => {
    let s = active()
    s = closeVotes(bothSubmit(s, T0 + 1), 2, 1) // A
    s = closeVotes(bothSubmit(s, s.rounds[1].submitDeadline! - 1), 1, 2) // B
    s = closeVotes(bothSubmit(s, s.rounds[2].submitDeadline! - 1), 0, 0) // tie (zero votes)
    expect(s.status).toBe('complete')
    expect(s.result).toEqual({
      winner: 'draw',
      roundWins: { a: 1, b: 1 },
      roundPoints: { a: 15, b: 15 },
      bonus: { a: 5, b: 5 },
      total: { a: 20, b: 20 },
    })
  })

  it('mixed: forfeit, both missed, voted — B wins', () => {
    let s = active()
    s = passSubmitDeadline(step(s, { type: 'submit', by: B, round: 1 }, T0 + 1)) // R1: B by forfeit
    s = passSubmitDeadline(s) // R2: both missed
    s = closeVotes(bothSubmit(s, s.rounds[2].submitDeadline! - 1), 1, 1) // R3: tie
    expect(s.result).toEqual({
      winner: 'b',
      roundWins: { a: 0, b: 1 },
      roundPoints: { a: 5, b: 15 },
      bonus: { a: 0, b: 10 },
      total: { a: 5, b: 25 },
    })
  })

  it('nothing can happen after the battle is complete', () => {
    let s = active()
    for (let i = 0; i < 3; i++) s = passSubmitDeadline(s)
    expect(s.status).toBe('complete')
    expect(errCode(transition(s, { type: 'submit', by: A, round: 3 }, T0))).toBe('wrong_status')
    expect(errCode(transition(s, { type: 'submissionDeadline' }, T0 + 99 * SUBMIT))).toBe('wrong_status')
    expect(errCode(transition(s, { type: 'closeVoting', votesA: 1, votesB: 0 }, T0 + 99 * SUBMIT))).toBe('wrong_status')
  })
})

describe('battleResult', () => {
  it('3 wins for one side', () => {
    const w = { kind: 'forfeit', winner: 'b' } as const
    expect(battleResult([w, w, w]).total).toEqual({ a: 0, b: 40 })
  })
})

// ── cancelling an invite (D50) ─────────────────────────────────────────────

describe('cancel', () => {
  it('the challenger can cancel while the battle is invited', () => {
    const r = ok(transition(invited(), { type: 'cancel', by: A }, T0 + 1000))
    expect(r.state.status).toBe('cancelled')
    expect(r.state.respondedAt).toBe(T0 + 1000)
    expect(r.state.currentRound).toBeNull()
    expect(r.state.version).toBe(1)
    expect(r.events).toEqual([{ type: 'battle_cancelled' }])
  })

  it('only the challenger can cancel', () => {
    expect(errCode(transition(invited(), { type: 'cancel', by: B }, T0 + 1))).toBe('wrong_player')
    expect(errCode(transition(invited(), { type: 'cancel', by: C }, T0 + 1))).toBe('wrong_player')
  })

  it('only while invited: not once accepted, declined, cancelled or complete', () => {
    expect(errCode(transition(active(), { type: 'cancel', by: A }, T0 + 1))).toBe('wrong_status')
    const declined = step(invited(), { type: 'decline', by: B }, T0 + 1)
    expect(errCode(transition(declined, { type: 'cancel', by: A }, T0 + 2))).toBe('wrong_status')
    const cancelled = step(invited(), { type: 'cancel', by: A }, T0 + 1)
    expect(errCode(transition(cancelled, { type: 'cancel', by: A }, T0 + 2))).toBe('wrong_status')
  })

  it('not after the invite has expired', () => {
    expect(errCode(transition(invited(), { type: 'cancel', by: A }, T0 + INVITE))).toBe('invite_expired')
    const expired = step(invited(), { type: 'inviteExpiry' }, T0 + INVITE)
    expect(errCode(transition(expired, { type: 'cancel', by: A }, T0 + INVITE + 1))).toBe('invite_expired')
  })

  it('a cancelled challenge cannot be accepted or declined', () => {
    const cancelled = step(invited(), { type: 'cancel', by: A }, T0 + 1)
    const accept = transition(cancelled, { type: 'accept', by: B, round2Skill: 'Backflip' }, T0 + 2)
    expect(errCode(accept)).toBe('wrong_status')
    expect(!accept.ok && accept.error.message).toBe('The challenger cancelled this challenge.')
    expect(errCode(transition(cancelled, { type: 'decline', by: B }, T0 + 2))).toBe('wrong_status')
    expect(dueAction(cancelled, T0 + 10 * INVITE)).toBeNull()
  })
})

// ── invite expiry (D51) ────────────────────────────────────────────────────

describe('invite expiry', () => {
  it('stores the expiry time on the battle, from the mode config', () => {
    expect(invited().inviteExpiresAt).toBe(T0 + INVITE)
    expect(INVITE).toBeLessThan(MODES.standard.inviteWindowMs)
    const std = ok(createBattle({ playerA: A, playerB: B, modeId: 'standard', round1Skill: 'Juggling' }, T0)).state
    expect(std.inviteExpiresAt).toBe(T0 + 24 * 60 * 60 * 1000)
  })

  it('is not due and cannot be applied before the deadline', () => {
    expect(dueAction(invited(), T0 + INVITE - 1)).toBeNull()
    expect(errCode(transition(invited(), { type: 'inviteExpiry' }, T0 + INVITE - 1))).toBe('deadline_not_reached')
    // B can still answer one millisecond before.
    expect(accepted(T0 + INVITE - 1).status).toBe('active')
  })

  it('expires exactly at the deadline', () => {
    expect(dueAction(invited(), T0 + INVITE)).toBe('inviteExpiry')
    const r = ok(transition(invited(), { type: 'inviteExpiry' }, T0 + INVITE))
    expect(r.state.status).toBe('expired')
    expect(r.state.respondedAt).toBe(T0 + INVITE)
    expect(r.events).toEqual([{ type: 'battle_expired' }])
  })

  it('a late sweep gives the same state as an on-time one', () => {
    const onTime = step(invited(), { type: 'inviteExpiry' }, T0 + INVITE)
    const late = step(invited(), { type: 'inviteExpiry' }, T0 + 50 * INVITE)
    expect(late).toEqual(onTime)
  })

  it('is idempotent: once expired, nothing is due and a second run is refused without change', () => {
    const expired = step(invited(), { type: 'inviteExpiry' }, T0 + INVITE)
    expect(dueAction(expired, T0 + 2 * INVITE)).toBeNull()
    expect(errCode(transition(expired, { type: 'inviteExpiry' }, T0 + 2 * INVITE))).toBe('wrong_status')
  })

  it("can't accept or decline an expired invite", () => {
    // At the deadline, before any sweep has run:
    expect(errCode(transition(invited(), { type: 'accept', by: B, round2Skill: 'Backflip', round1Skill: 'Juggling' }, T0 + INVITE))).toBe('invite_expired')
    expect(errCode(transition(invited(), { type: 'decline', by: B }, T0 + INVITE))).toBe('invite_expired')
    // After the sweep marked it expired:
    const expired = step(invited(), { type: 'inviteExpiry' }, T0 + INVITE)
    const accept = transition(expired, { type: 'accept', by: B, round2Skill: 'Backflip' }, T0 + INVITE + 1)
    expect(errCode(accept)).toBe('invite_expired')
    expect(!accept.ok && accept.error.message).toBe('This challenge expired.')
  })

  it('does not apply to accepted battles', () => {
    const s = active(T0 + 1)
    expect(errCode(transition(s, { type: 'inviteExpiry' }, T0 + 10 * INVITE))).toBe('wrong_status')
    expect(dueAction(s, T0 + 1 + SUBMIT - 1)).toBeNull()
  })

  it('battles created before the expiry field existed expire 24h (mode window) after creation', () => {
    const legacy = { ...invited() }
    delete legacy.inviteExpiresAt
    expect(inviteDeadline(legacy)).toBe(T0 + INVITE)
    expect(dueAction(legacy, T0 + INVITE)).toBe('inviteExpiry')
    expect(step(legacy, { type: 'inviteExpiry' }, T0 + INVITE).status).toBe('expired')
  })
})

// ── setter rules (D53) ─────────────────────────────────────────────────────

describe('setter rules: rounds 1 and 2', () => {
  /** B (the replicator) submits in round 1; voting opens at once. */
  const r1Voting = (at = T0 + 1) => step(accepted(), { type: 'submit', by: B, round: 1 }, at)

  it('names the setters: A for round 1, B for round 2, nobody for round 3 or legacy battles', () => {
    expect([1, 2, 3].map((n) => setterOf(invited(), n as 1 | 2 | 3))).toEqual(['a', 'b', null])
    expect(setterOf(active(), 1)).toBeNull()
  })

  it('the setter is pre-submitted and cannot submit again', () => {
    const s = accepted()
    expect(errCode(transition(s, { type: 'submit', by: A, round: 1 }, T0 + 1))).toBe('already_submitted')
  })

  it('as soon as the replicator submits, the window ends and voting opens for the full window', () => {
    const r = ok(transition(accepted(), { type: 'submit', by: B, round: 1 }, T0 + 7))
    const round = r.state.rounds[0]
    expect(round.phase).toBe('vote')
    expect(round.revealedAt).toBe(T0 + 7)
    expect(round.voteDeadline).toBe(T0 + 7 + VOTE)
    expect(r.events).toEqual([
      { type: 'submitted', round: 1, side: 'b' },
      { type: 'round_revealed', round: 1 },
    ])
  })

  it('the only deadline is the replicator\'s: missing it gives the setter the round (+10, no vote)', () => {
    const s = accepted()
    expect(dueAction(s, T0 + SUBMIT - 1)).toBeNull()
    expect(dueAction(s, T0 + SUBMIT)).toBe('submissionDeadline')
    expect(errCode(transition(s, { type: 'submit', by: B, round: 1 }, T0 + SUBMIT))).toBe('deadline_passed')
    const r = ok(transition(s, { type: 'submissionDeadline', nextSkill: 'Backflip' }, T0 + SUBMIT + 30_000))
    const round1 = r.state.rounds[0]
    expect(round1.outcome).toEqual({ kind: 'forfeit', winner: 'a' })
    expect(round1.voteDeadline).toBeNull()
    expect(roundPoints(round1.outcome!)).toEqual({ a: 10, b: 0 })
  })

  it('round 2 opens when round 1 closes: its skill becomes public and B is pre-submitted', () => {
    const s = closeVotes(r1Voting(), 1, 0) // closeVotes passes no nextSkill
    expect(s.currentRound).toBe(2)
    expect(s.rounds[1].phase).toBe('submit')
    expect(s.rounds[1].submitted).toEqual({ a: false, b: true })
    // Without the server-provided skill it stays null (the UI falls back to the revealed row).
    expect(s.rounds[1].skill).toBeNull()

    const v = r1Voting()
    const withSkill = step(v, { type: 'closeVoting', votesA: 1, votesB: 0, nextSkill: ' Backflip ' }, v.rounds[0].voteDeadline!)
    expect(withSkill.rounds[1].skill).toBe('Backflip')
    expect(withSkill.rounds[1].submitDeadline).toBe(v.rounds[0].voteDeadline! + SUBMIT)
  })

  it('in round 2, A replicates: A submitting opens voting; A missing gives B the round', () => {
    const r2 = closeVotes(r1Voting(), 0, 0)
    expect(errCode(transition(r2, { type: 'submit', by: B, round: 2 }, r2.rounds[1].submitDeadline! - 1))).toBe('already_submitted')
    const voting = step(r2, { type: 'submit', by: A, round: 2 }, r2.rounds[1].submitDeadline! - 1)
    expect(voting.rounds[1].phase).toBe('vote')
    const missed = passSubmitDeadline(r2)
    expect(missed.rounds[1].outcome).toEqual({ kind: 'forfeit', winner: 'b' })
    expect(missed.currentRound).toBe(3)
  })

  it('round 3 is unchanged: nobody pre-submitted, both submit blind before one deadline', () => {
    const r3 = passSubmitDeadline(passSubmitDeadline(accepted()))
    expect(r3.currentRound).toBe(3)
    expect(r3.rounds[2].submitted).toEqual({ a: false, b: false })
    expect(r3.rounds[2].skill).toBeNull()
    const one = step(r3, { type: 'submit', by: A, round: 3 }, r3.rounds[2].submitDeadline! - 10)
    expect(one.rounds[2].phase).toBe('submit')
    expect(one.rounds[2].revealedAt).toBeNull()
    const both = step(one, { type: 'submit', by: B, round: 3 }, r3.rounds[2].submitDeadline! - 5)
    expect(both.rounds[2].phase).toBe('vote')
    // Both missing round 3 is still 0 / 0.
    expect(passSubmitDeadline(r3).rounds[2].outcome).toEqual({ kind: 'both_missed' })
  })

  it('a long-idle v2 battle catches up: setter forfeits in rounds 1–2, both missed in round 3', () => {
    let s = accepted()
    const far = T0 + 100 * SUBMIT
    for (let due = dueAction(s, far); due; due = dueAction(s, far)) {
      s = step(s, due === 'closeVoting' ? { type: 'closeVoting', votesA: 0, votesB: 0 } : { type: 'submissionDeadline' }, far)
    }
    expect(s.rounds.map((r) => r.outcome)).toEqual([
      { kind: 'forfeit', winner: 'a' },
      { kind: 'forfeit', winner: 'b' },
      { kind: 'both_missed' },
    ])
    expect(s.result!.total).toEqual({ a: 15, b: 15 })
  })

  it('full v2 battle: A wins round 1 on votes, rounds 2–3 tie with no votes → 30 : 10', () => {
    let s = closeVotes(r1Voting(), 1, 0)
    s = closeVotes(step(s, { type: 'submit', by: A, round: 2 }, s.rounds[1].submitDeadline! - 1), 0, 0)
    s = closeVotes(bothSubmit(s, s.rounds[2].submitDeadline! - 1), 0, 0)
    expect(s.status).toBe('complete')
    expect(s.result!.total).toEqual({ a: 30, b: 10 })
  })
})

describe('publicSubmissions (what the server reveals)', () => {
  it('nothing before accept; the setter video once its round opens; the replicator only when the window ends', () => {
    expect(publicSubmissions(invited())).toEqual([])
    const s = accepted()
    expect(publicSubmissions(s)).toEqual([{ round: 1, side: 'a' }])
    const voting = step(s, { type: 'submit', by: B, round: 1 }, T0 + 1)
    expect(publicSubmissions(voting)).toEqual([
      { round: 1, side: 'a' },
      { round: 1, side: 'b' },
    ])
    // B's round 2 video stays hidden until round 2 opens.
    expect(publicSubmissions(voting)).not.toContainEqual({ round: 2, side: 'b' })
    const r2 = closeVotes(voting, 0, 0)
    expect(publicSubmissions(r2)).toContainEqual({ round: 2, side: 'b' })
    expect(publicSubmissions(r2)).not.toContainEqual({ round: 2, side: 'a' })
  })

  it('round 3 stays blind until both are in or the deadline passes', () => {
    const r3 = passSubmitDeadline(passSubmitDeadline(accepted()))
    const one = step(r3, { type: 'submit', by: A, round: 3 }, r3.rounds[2].submitDeadline! - 10)
    expect(publicSubmissions(one).filter((p) => p.round === 3)).toEqual([])
    expect(publicSubmissions(passSubmitDeadline(one)).filter((p) => p.round === 3)).toEqual([{ round: 3, side: 'a' }])
  })

  it('legacy battles: only rounds whose window ended', () => {
    const s = step(active(), { type: 'submit', by: A, round: 1 }, T0 + 1)
    expect(publicSubmissions(s)).toEqual([])
    expect(publicSubmissions(step(s, { type: 'submit', by: B, round: 1 }, T0 + 2))).toEqual([
      { round: 1, side: 'a' },
      { round: 1, side: 'b' },
    ])
  })
})

// ── Rapid Fire: one round, no bonus, modes as config (D63) ────────────────

describe('Rapid Fire (1 round)', () => {
  const R = MODES.rapid
  const rapidInvite = () => ok(createBattle({ playerA: A, playerB: B, modeId: 'rapid', round1Skill: 'Juggling' }, T0)).state
  const rapidAccepted = (at = T0 + 1000) =>
    ok(transition(rapidInvite(), { type: 'accept', by: B, round1Skill: 'Juggling' }, at)).state

  it('is configured as 1 round, 5 min invite and submit, 15 min vote, no bonus', () => {
    expect(R.rounds).toBe(1)
    expect(R.inviteWindowMs).toBe(5 * 60_000)
    expect(R.submitWindowMs).toBe(5 * 60_000)
    expect(R.voteWindowMs).toBe(15 * 60_000)
    expect(R.battleBonus).toBe(false)
  })

  it('creates exactly one round', () => {
    const s = rapidInvite()
    expect(s.rounds).toHaveLength(1)
    expect(s.rounds[0].number).toBe(1)
    expect(inviteDeadline(s)).toBe(T0 + R.inviteWindowMs)
  })

  it('B accepts blind with no round 2 skill; round 1 opens with a 5-minute clock and A already in', () => {
    const r = ok(transition(rapidInvite(), { type: 'accept', by: B, round1Skill: 'Juggling' }, T0 + 1000))
    expect(r.events).toEqual([{ type: 'battle_started' }])
    expect(r.state.status).toBe('active')
    expect(r.state.currentRound).toBe(1)
    expect(r.state.rounds[0].skill).toBe('Juggling')
    expect(r.state.rounds[0].phase).toBe('submit')
    expect(r.state.rounds[0].submitted).toEqual({ a: true, b: false })
    expect(r.state.rounds[0].submitDeadline).toBe(T0 + 1000 + R.submitWindowMs)
    expect(setterOf(r.state, 1)).toBe('a')
  })

  it('expires an unanswered invite at exactly 5 minutes', () => {
    const s = rapidInvite()
    expect(dueAction(s, T0 + R.inviteWindowMs - 1)).toBeNull()
    expect(dueAction(s, T0 + R.inviteWindowMs)).toBe('inviteExpiry')
    expect(errCode(transition(s, { type: 'inviteExpiry' }, T0 + R.inviteWindowMs - 1))).toBe('deadline_not_reached')
    expect(step(s, { type: 'inviteExpiry' }, T0 + R.inviteWindowMs).status).toBe('expired')
    expect(errCode(transition(s, { type: 'accept', by: B, round1Skill: 'Juggling' }, T0 + R.inviteWindowMs))).not.toBe('ok')
  })

  it('B submits: 15 minutes of voting, then a round win is +10 and the battle ends with no bonus', () => {
    const s = step(rapidAccepted(), { type: 'submit', by: B, round: 1 }, T0 + 60_000)
    expect(s.rounds[0].phase).toBe('vote')
    expect(s.rounds[0].voteDeadline).toBe(T0 + 60_000 + R.voteWindowMs)
    const r = ok(transition(s, { type: 'closeVoting', votesA: 1, votesB: 3 }, s.rounds[0].voteDeadline!))
    expect(r.state.status).toBe('complete')
    expect(r.state.currentRound).toBeNull()
    expect(r.state.result!.winner).toBe('b')
    expect(r.state.result!.bonus).toEqual({ a: 0, b: 0 })
    expect(r.state.result!.total).toEqual({ a: 0, b: 10 })
    expect(r.events).toContainEqual({ type: 'battle_completed', result: r.state.result })
  })

  it('zero votes is a tie: +5 each, no bonus', () => {
    const s = step(rapidAccepted(), { type: 'submit', by: B, round: 1 }, T0 + 60_000)
    const done = closeVotes(s, 0, 0)
    expect(done.result!.winner).toBe('draw')
    expect(done.result!.total).toEqual({ a: 5, b: 5 })
  })

  it('B misses the deadline: A (the challenger) wins +10, no bonus', () => {
    const s = rapidAccepted()
    const done = passSubmitDeadline(s)
    expect(done.status).toBe('complete')
    expect(done.rounds[0].outcome).toEqual({ kind: 'forfeit', winner: 'a' })
    expect(done.result!.winner).toBe('a')
    expect(done.result!.total).toEqual({ a: 10, b: 0 })
  })

  it('refuses round 2 and 3 submissions', () => {
    expect(errCode(transition(rapidAccepted(), { type: 'submit', by: B, round: 2 }, T0 + 2000))).not.toBe('ok')
    expect(errCode(transition(rapidAccepted(), { type: 'submit', by: B, round: 3 }, T0 + 2000))).not.toBe('ok')
  })

  it('Standard is unchanged: 3 rounds, bonus applies', () => {
    expect(MODES.standard.rounds).toBe(3)
    expect(MODES.standard.battleBonus).toBe(true)
    const s = ok(createBattle({ playerA: A, playerB: B, modeId: 'standard', round1Skill: 'Juggling' }, T0)).state
    expect(s.rounds.map((r) => r.number)).toEqual([1, 2, 3])
    // A Standard accept still needs B's round 2 skill.
    expect(errCode(transition(s, { type: 'accept', by: B, round1Skill: 'Juggling' }, T0 + 1))).toBe('invalid_skill')
  })
})

describe('battleResult with and without the bonus', () => {
  const w = { kind: 'votes', winner: 'a', votesA: 2, votesB: 0 } as const
  it('adds the bonus by default (Standard)', () => {
    expect(battleResult([w]).total).toEqual({ a: 20, b: 0 })
  })
  it('skips it when the mode has none (Rapid Fire)', () => {
    expect(battleResult([w], false).total).toEqual({ a: 10, b: 0 })
  })
})
