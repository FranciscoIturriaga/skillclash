import { describe, expect, it } from 'vitest'
import {
  battleResult,
  createBattle,
  dueAction,
  normalizeSkill,
  roundPoints,
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

function active(at = T0): BattleState {
  return ok(transition(invited(), { type: 'accept', by: B, round2Skill: 'Backflip' }, at)).state
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
  it('starts invited, version 0, with round 1 skill set and nothing open', () => {
    const s = invited()
    expect(s.status).toBe('invited')
    expect(s.version).toBe(0)
    expect(s.currentRound).toBeNull()
    expect(s.rounds.map((r) => r.phase)).toEqual(['pending', 'pending', 'pending'])
    expect(s.rounds[0].skill).toBe('Juggling')
    expect(s.rounds[2].skill).toBeNull()
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
  it('B accepts: battle active, round 2 skill set, round 1 submission open', () => {
    const r = ok(transition(invited(), { type: 'accept', by: B, round2Skill: 'Backflip' }, T0 + 5))
    expect(r.events).toEqual([{ type: 'battle_started' }])
    const s = r.state
    expect(s.status).toBe('active')
    expect(s.version).toBe(1)
    expect(s.currentRound).toBe(1)
    expect(s.rounds[0].phase).toBe('submit')
    expect(s.rounds[0].submitDeadline).toBe(T0 + 5 + SUBMIT)
    expect(s.rounds[1].skill).toBe('Backflip')
    expect(s.rounds[1].phase).toBe('pending')
  })

  it('only B can accept or decline', () => {
    expect(errCode(transition(invited(), { type: 'accept', by: A, round2Skill: 'Backflip' }, T0))).toBe('wrong_player')
    expect(errCode(transition(invited(), { type: 'accept', by: C, round2Skill: 'Backflip' }, T0))).toBe('wrong_player')
    expect(errCode(transition(invited(), { type: 'decline', by: A }, T0))).toBe('wrong_player')
  })

  it('round 2 skill must be valid and different from round 1 (case-insensitive)', () => {
    expect(errCode(transition(invited(), { type: 'accept', by: B, round2Skill: '' }, T0))).toBe('invalid_skill')
    expect(errCode(transition(invited(), { type: 'accept', by: B, round2Skill: ' juggling ' }, T0))).toBe('same_skill')
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
  it('is null for invited, declined and complete battles, and before deadlines', () => {
    expect(dueAction(invited(), T0 + 10 * SUBMIT)).toBeNull()
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
