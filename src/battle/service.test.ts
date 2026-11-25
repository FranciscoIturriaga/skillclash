import { describe, expect, it } from 'vitest'
import { findOpenBattle } from './service'

const row = (id: string, playerA: string, playerB: string, status: string, nextDeadline: number | null = null) => ({
  recordId: id,
  data: { playerA, playerB, status, nextDeadline },
})

describe('findOpenBattle (one open battle per pair, D47)', () => {
  it('finds an invited or active battle in either direction', () => {
    expect(findOpenBattle([row('b1', 'x', 'y', 'invited')], 'x', 'y')?.recordId).toBe('b1')
    expect(findOpenBattle([row('b1', 'x', 'y', 'active')], 'x', 'y')?.recordId).toBe('b1')
    expect(findOpenBattle([row('b2', 'y', 'x', 'invited')], 'x', 'y')?.recordId).toBe('b2')
    expect(findOpenBattle([row('b2', 'y', 'x', 'active')], 'x', 'y')?.recordId).toBe('b2')
  })

  it('ignores finished battles and other pairs', () => {
    const rows = [
      row('done', 'x', 'y', 'complete'),
      row('no', 'y', 'x', 'declined'),
      row('other', 'x', 'z', 'active'),
      row('other2', 'z', 'y', 'invited'),
    ]
    expect(findOpenBattle(rows, 'x', 'y')).toBeNull()
  })

  it('cancelled and expired battles free the pair (D50, D51)', () => {
    expect(findOpenBattle([row('c', 'x', 'y', 'cancelled'), row('e', 'y', 'x', 'expired')], 'x', 'y')).toBeNull()
  })

  it('an invite past its deadline no longer counts, even before the sweep marks it expired', () => {
    const rows = [row('b1', 'x', 'y', 'invited', 1000)]
    expect(findOpenBattle(rows, 'x', 'y', 999)?.recordId).toBe('b1')
    expect(findOpenBattle(rows, 'x', 'y', 1000)).toBeNull()
    // Active battles keep counting whatever their round deadline.
    expect(findOpenBattle([row('b2', 'x', 'y', 'active', 1000)], 'x', 'y', 5000)?.recordId).toBe('b2')
  })
})

describe('findOpenBattle per mode (D64)', () => {
  const m = (id: string, a: string, b: string, status: string, modeId: string) => ({
    recordId: id,
    data: { playerA: a, playerB: b, status, nextDeadline: null, modeId },
  })

  it('an open Standard battle does not block a Rapid Fire one, and vice versa', () => {
    const rows = [m('s1', 'x', 'y', 'active', 'standard')]
    expect(findOpenBattle(rows, 'x', 'y', 0, 'rapid')).toBeNull()
    expect(findOpenBattle(rows, 'x', 'y', 0, 'standard')?.recordId).toBe('s1')
    const rapid = [m('r1', 'y', 'x', 'invited', 'rapid')]
    expect(findOpenBattle(rapid, 'x', 'y', 0, 'standard')).toBeNull()
    expect(findOpenBattle(rapid, 'x', 'y', 0, 'rapid')?.recordId).toBe('r1')
  })

  it('both modes open at once: each blocks only its own mode', () => {
    const rows = [m('s1', 'x', 'y', 'active', 'standard'), m('r1', 'x', 'y', 'active', 'rapid')]
    expect(findOpenBattle(rows, 'x', 'y', 0, 'standard')?.recordId).toBe('s1')
    expect(findOpenBattle(rows, 'y', 'x', 0, 'rapid')?.recordId).toBe('r1')
    expect(findOpenBattle(rows, 'x', 'y', 0, 'test')).toBeNull()
  })

  it('a finished battle of the same mode frees the pair for that mode', () => {
    expect(findOpenBattle([m('r1', 'x', 'y', 'complete', 'rapid')], 'x', 'y', 0, 'rapid')).toBeNull()
  })
})
