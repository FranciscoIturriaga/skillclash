import { describe, expect, it } from 'vitest'
import { ONLINE_OPPONENTS_MAX, onlinePastOpponents, pastOpponents, type BattleLike } from './opponents'

const ME = 'me'
const b = (playerA: string, playerB: string, createdAt?: number): BattleLike => ({ playerA, playerB, state: { createdAt } })

describe('pastOpponents', () => {
  it('lists opponents from both sides, most recent battle first, once each', () => {
    const rows = [b(ME, 'x', 100), b('y', ME, 300), b(ME, 'z', 200), b('x', ME, 400), b('q', 'r', 999)]
    expect(pastOpponents(rows, ME)).toEqual(['x', 'y', 'z'])
  })

  it('uses the latest battle per opponent, whatever the order of rows', () => {
    const rows = [b(ME, 'x', 500), b(ME, 'y', 600), b(ME, 'x', 50)]
    expect(pastOpponents(rows, ME)).toEqual(['y', 'x'])
  })

  it('puts battles without a createdAt last and never lists me', () => {
    const rows = [b(ME, 'old'), b(ME, 'new', 10), b(ME, ME, 20)]
    expect(pastOpponents(rows, ME)).toEqual(['new', 'old'])
  })
})

describe('onlinePastOpponents', () => {
  it('keeps only online opponents, in recency order', () => {
    const rows = [b(ME, 'a', 1), b(ME, 'b', 2), b(ME, 'c', 3)]
    expect(onlinePastOpponents(rows, ME, (id) => id !== 'b')).toEqual(['c', 'a'])
  })

  it('returns at most 8, the most recent ones, counted after the online filter', () => {
    const rows = Array.from({ length: 12 }, (_, i) => b(ME, `p${i}`, i))
    const online = (id: string) => id !== 'p11' // the most recent is offline
    const list = onlinePastOpponents(rows, ME, online)
    expect(ONLINE_OPPONENTS_MAX).toBe(8)
    expect(list).toHaveLength(8)
    expect(list).toEqual(['p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3'])
  })

  it('is empty when nobody is online', () => {
    expect(onlinePastOpponents([b(ME, 'a', 1)], ME, () => false)).toEqual([])
  })
})
