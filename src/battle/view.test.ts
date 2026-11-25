import { describe, expect, it } from 'vitest'
import { createBattle, transition, type BattleAction, type BattleState, type MachineResult } from './machine'
import { activeDeadline, bucketFor, formatCountdown, formatExpiresIn, inviteExpiry, profileStats, roundDisplayOrder, runningScore, statusLabel } from './view'
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
const active = () => step(invited(), { type: 'accept', by: B, round2Skill: 'Backflip' }, T0)

function playRound(s: BattleState, votesA: number, votesB: number): BattleState {
  const r = s.currentRound!
  const at = s.rounds[r - 1].submitDeadline! - 1000
  s = step(step(s, { type: 'submit', by: A, round: r }, at), { type: 'submit', by: B, round: r }, at)
  return step(s, { type: 'closeVoting', votesA, votesB }, s.rounds[r - 1].voteDeadline!)
}

describe('view helpers', () => {
  it('buckets an invite by side', () => {
    expect(bucketFor(invited(), B)).toBe('invite')
    expect(bucketFor(invited(), A)).toBe('sent')
    expect(bucketFor(invited(), C)).toBeNull()
  })

  it("puts an active battle in 'my_turn' until the viewer submits", () => {
    const s = active()
    expect(bucketFor(s, A)).toBe('my_turn')
    const after = step(s, { type: 'submit', by: A, round: 1 }, T0 + 1000)
    expect(bucketFor(after, A)).toBe('in_progress')
    expect(bucketFor(after, B)).toBe('my_turn')
    expect(statusLabel(after, B)).toBe('Round 1 · Your turn')
    expect(statusLabel(after, C)).toBe('Round 1 · Filming')
  })

  it('shows the submit deadline, then the vote deadline', () => {
    let s = active()
    expect(activeDeadline(s)?.kind).toBe('submit')
    s = step(step(s, { type: 'submit', by: A, round: 1 }, T0), { type: 'submit', by: B, round: 1 }, T0)
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
    const a = profileStats([s], A)
    expect(a).toMatchObject({ played: 1, won: 1, lost: 0, tied: 0, roundWins: 1 })
    expect(a.points).toBe(s.result!.total.a)
    expect(profileStats([s], B)).toMatchObject({ played: 1, won: 0, lost: 1 })
    expect(profileStats([invited()], A).played).toBe(0)
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
