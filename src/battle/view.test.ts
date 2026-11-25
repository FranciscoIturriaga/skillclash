import { describe, expect, it } from 'vitest'
import { createBattle, transition, type BattleAction, type BattleState, type MachineResult } from './machine'
import { activeDeadline, bucketFor, formatCountdown, formatExpiresIn, inviteExpiry, lockedRoundCopy, roundDisplayOrder, sortVotingNow, runningScore, statusLabel } from './view'
import { MODES } from './modes'

const A = 'user_a'
const B = 'user_b'
const C = 'user_c'
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)

function ok(r: MachineResult): BattleState {
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}
const step = (s: BattleState, a: BattleAction, now: number) => ok(transition(s, a, now))
const invited = () => ok(createBattle({ playerA: A, playerB: B, modeId: 'test', round1Skill: 'Juggling' }, T0))
const active = () => step(invited(), { type: 'accept', by: B, round2Skill: 'Backflip', round1Skill: 'Juggling' }, T0)

function playRound(s: BattleState, votesA: number, votesB: number): BattleState {
  const r = s.currentRound!
  const at = s.rounds[r - 1].submitDeadline! - 1000
  // Under the setter rules the setter is already in (D53); only submit who isn't.
  if (!s.rounds[r - 1].submitted.a) s = step(s, { type: 'submit', by: A, round: r }, at)
  if (!s.rounds[r - 1].submitted.b) s = step(s, { type: 'submit', by: B, round: r }, at)
  return step(s, { type: 'closeVoting', votesA, votesB }, s.rounds[r - 1].voteDeadline!)
}

describe('view helpers', () => {
  it('buckets an invite by side', () => {
    expect(bucketFor(invited(), B)).toBe('invite')
    expect(bucketFor(invited(), A)).toBe('sent')
    expect(bucketFor(invited(), C)).toBeNull()
  })

  it("puts an active battle in 'my_turn' until the viewer submits", () => {
    const after = active() // round 1: A set the skill, so A is already in (D53)
    expect(bucketFor(after, A)).toBe('in_progress')
    expect(bucketFor(after, B)).toBe('my_turn')
    expect(statusLabel(after, B)).toBe('Round 1 · Your turn')
    expect(statusLabel(after, C)).toBe('Round 1 · Filming')
  })

  it('shows the submit deadline, then the vote deadline', () => {
    let s = active()
    expect(activeDeadline(s)?.kind).toBe('submit')
    s = step(s, { type: 'submit', by: B, round: 1 }, T0) // the replicator's video opens voting
    expect(activeDeadline(s)?.kind).toBe('vote')
    expect(statusLabel(s, C)).toBe('Round 1 · Voting')
  })

  it('scores a finished battle and builds profile stats', () => {
    let s = active()
    s = playRound(s, 3, 1) // A wins (10–0)
    expect(runningScore(s)).toEqual({ a: 10, b: 0 })
    s = playRound(s, 0, 0) // tie (+5 each)
    s = playRound(s, 2, 2) // tie (+5 each)
    expect(s.status).toBe('complete')
    expect(bucketFor(s, A)).toBe('finished')
    expect(statusLabel(s, A)).toBe('You won')
    expect(statusLabel(s, B)).toBe('You lost')
    expect(activeDeadline(s)).toBeNull()
  })

  it('sorts "Voting now" by both players\' stored points, then soonest deadline (D58)', () => {
    const pts: Record<string, number> = { a: 100, b: 10, c: 50, d: 50 }
    const pointsOf = (u: string) => pts[u] ?? 0
    const rows = [
      { id: 'low', playerA: 'b', playerB: 'new', nextDeadline: 1 }, // 10
      { id: 'tieLate', playerA: 'c', playerB: 'd', nextDeadline: 900 }, // 100
      { id: 'top', playerA: 'a', playerB: 'c', nextDeadline: 999 }, // 150
      { id: 'tieSoon', playerA: 'a', playerB: 'new2', nextDeadline: 500 }, // 100
      { id: 'tieNull', playerA: 'd', playerB: 'c', nextDeadline: null }, // 100
    ]
    expect(sortVotingNow(rows, pointsOf).map((r) => r.id)).toEqual(['top', 'tieSoon', 'tieLate', 'tieNull', 'low'])
    expect(rows[0].id).toBe('low') // input untouched
  })

  it('formats countdowns', () => {
    expect(formatCountdown(9_000)).toBe('0:09')
    expect(formatCountdown(245_000)).toBe('4:05')
    expect(formatCountdown(12 * 3600_000 - 57_000)).toBe('11:59:03')
    expect(formatCountdown(-5)).toBe('0:00')
  })

  it('orders rounds: current first, past newest first (collapsed), then locked', () => {
    const order = (st: BattleState) => roundDisplayOrder(st).map((x) => `${x.round.number}${x.collapsible ? 'c' : ''}`)
    expect(order(invited())).toEqual(['1', '2', '3'])
    expect(order(active())).toEqual(['1', '2', '3'])
    const r2 = playRound(active(), 1, 0)
    expect(r2.currentRound).toBe(2)
    expect(order(r2)).toEqual(['2', '1c', '3'])
    const r3 = playRound(r2, 0, 0)
    expect(order(r3)).toEqual(['3', '2c', '1c'])
    const done = playRound(r3, 0, 0)
    expect(done.status).toBe('complete')
    expect(order(done)).toEqual(['3c', '2c', '1c'])
  })
})

describe('cancelled and expired invites (D50, D51)', () => {
  const cancelled = () => step(invited(), { type: 'cancel', by: A }, T0 + 1)
  const expired = () => step(invited(), { type: 'inviteExpiry' }, T0 + MODES.test.inviteWindowMs)

  it('go to Finished for both players, with their own label', () => {
    for (const s of [cancelled(), expired()]) {
      expect(bucketFor(s, A)).toBe('finished')
      expect(bucketFor(s, B)).toBe('finished')
    }
    expect(statusLabel(cancelled(), B)).toBe('Cancelled')
    expect(statusLabel(expired(), A)).toBe('Expired')
  })

  it('only an open invite has an expiry to show', () => {
    expect(inviteExpiry(invited())).toBe(T0 + MODES.test.inviteWindowMs)
    expect(inviteExpiry(active())).toBeNull()
    expect(inviteExpiry(cancelled())).toBeNull()
    expect(inviteExpiry(expired())).toBeNull()
  })

  it('formats time left coarsely, rounding down', () => {
    const H = 3_600_000
    expect(formatExpiresIn(24 * H)).toBe('24h')
    expect(formatExpiresIn(24 * H - 1)).toBe('23h')
    expect(formatExpiresIn(59 * 60_000 + 59_000)).toBe('59m')
    expect(formatExpiresIn(30_000)).toBe('<1m')
    expect(formatExpiresIn(0)).toBe('now')
  })
})

describe('lockedRoundCopy (D55)', () => {
  const names = { a: 'ann', b: 'bob' }
  const all = (s: BattleState, viewer: 'a' | 'b' | null, own?: string) =>
    ([1, 2, 3] as const).map((n) => lockedRoundCopy(s, n, viewer, names, own))

  it('words an open invite for B, A and others, with no skill and no "round 0"', () => {
    expect(all(invited(), 'b')).toEqual([
      'Set by @ann. Revealed when you accept',
      "You'll set this when accepting",
      'Freestyle. Opens after round 2',
    ])
    expect(lockedRoundCopy(invited(), 1, 'a', names, 'Juggling')).toBe('Your skill: Juggling. Revealed to @bob when they accept')
    expect(lockedRoundCopy(invited(), 2, 'a', names)).toBe('Set by @bob. Revealed when round 2 starts')
    expect(all(invited(), null)).toEqual(['Revealed when the battle starts', 'Revealed when round 2 starts', 'Freestyle. Opens after round 2'])
    for (const v of ['a', 'b', null] as const) for (const t of all(invited(), v)) expect(t).not.toMatch(/round 0|Juggling/)
  })

  it('after accept, round 2 shows B their own skill and hides it from A', () => {
    const s = active()
    expect(lockedRoundCopy(s, 2, 'b', names, 'Backflip')).toBe('Your skill: Backflip. Revealed to @ann when round 2 starts')
    expect(lockedRoundCopy(s, 2, 'a', names)).toBe('Set by @bob. Revealed when round 2 starts')
  })

  it('legacy battles show their public skills', () => {
    const { rules: _r, ...legacy } = invited()
    legacy.rounds = [{ ...legacy.rounds[0], skill: 'Juggling' }, legacy.rounds[1], legacy.rounds[2]]
    expect(lockedRoundCopy(legacy, 1, 'b', names)).toBe('Juggling. Opens when the challenge is accepted')
    expect(lockedRoundCopy(legacy, 2, null, names)).toBe('Opens after round 1')
  })
})
