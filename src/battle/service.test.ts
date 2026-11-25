import { describe, expect, it } from 'vitest'
import { findOpenBattle } from './service'

const row = (id: string, playerA: string, playerB: string, status: string) => ({
  recordId: id,
  data: { playerA, playerB, status },
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
})
