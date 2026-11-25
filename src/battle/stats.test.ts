import type { ActionTools } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import { battleResult, createBattle, type BattleState, type RoundOutcome } from './machine'
import {
  EMPTY_STATS,
  STATS_BACKFILL_MARKER,
  backfillStats,
  recordBattleStats,
  runStatsBackfillOnce,
  statsEntriesFor,
  sumStats,
} from './stats'

const A = 'user_a'
const B = 'user_b'
const C = 'user_c'
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0)

function base(playerA = A, playerB = B): BattleState {
  const r = createBattle({ playerA, playerB, modeId: 'test', round1Skill: 'Juggling' }, T0)
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}

/** A finished battle with the given round outcomes (the machine's own scoring). */
function completed(outcomes: RoundOutcome[], playerA = A, playerB = B): BattleState {
  return { ...base(playerA, playerB), status: 'complete', currentRound: null, completedAt: T0, result: battleResult(outcomes) }
}

const win = (w: 'a' | 'b'): RoundOutcome => ({ kind: 'votes', winner: w, votesA: w === 'a' ? 2 : 0, votesB: w === 'b' ? 2 : 0 })
const tie: RoundOutcome = { kind: 'votes', winner: 'tie', votesA: 0, votesB: 0 }
const forfeit = (w: 'a' | 'b'): RoundOutcome => ({ kind: 'forfeit', winner: w })
const bothMissed: RoundOutcome = { kind: 'both_missed' }

/**
 * Minimal in-memory ActionTools: create (upsert with an id, Duplicate on a
 * uniqueOn clash without one), get, query by equality. Enough for the ledger.
 */
function fakeTools(uniqueOn: Record<string, string[]> = { stats_entries: ['battleId', 'playerId'] }) {
  const db = new Map<string, Map<string, Record<string, unknown>>>()
  const table = (c: string) => db.get(c) ?? db.set(c, new Map()).get(c)!
  let seq = 0
  const tools = {
    async create(collection: string, data: Record<string, unknown>, recordId?: string) {
      const t = table(collection)
      const keys = uniqueOn[collection]
      if (keys) {
        for (const [id, row] of t) {
          if (id !== recordId && keys.every((k) => row[k] === data[k])) {
            return { success: false, error: `Duplicate value for unique constraint (${keys.join(', ')})` }
          }
        }
      }
      const id = recordId ?? `r${++seq}`
      t.set(id, { ...data })
      return { success: true, data: { recordId: id } }
    },
    async get(collection: string, recordId: string) {
      const row = table(collection).get(recordId)
      return row ? { success: true, data: { record: { recordId, data: row } } } : { success: false, error: 'not found' }
    },
    async query(collection: string, opts: { where?: Record<string, unknown> } = {}) {
      const records = [...table(collection)]
        .filter(([, row]) => Object.entries(opts.where ?? {}).every(([k, v]) => row[k] === v))
        .map(([recordId, data]) => ({ recordId, data }))
      return { success: true, data: { records, count: records.length } }
    },
    async update(collection: string, recordId: string, patch: Record<string, unknown>) {
      const t = table(collection)
      t.set(recordId, { ...t.get(recordId), ...patch })
      return { success: true, data: { recordId } }
    },
  }
  const statsOf = (userId: string) => {
    const row = table('player_stats').get(userId)
    if (!row) return null
    const { userId: _u, ...rest } = row
    return rest
  }
  return { tools: tools as unknown as ActionTools, table, statsOf }
}

describe('statsEntriesFor (what one battle adds to each profile)', () => {
  it('win/loss: the winner gets the win, round wins and bonus; the loser a loss', () => {
    const s = completed([win('a'), win('a'), win('b')]) // A 20+10, B 10
    const [a, b] = statsEntriesFor('bt1', s)
    expect(a).toEqual({ battleId: 'bt1', playerId: A, side: 'a', points: 30, played: 1, won: 1, lost: 0, tied: 0, roundWins: 2 })
    expect(b).toEqual({ battleId: 'bt1', playerId: B, side: 'b', points: 10, played: 1, won: 0, lost: 1, tied: 0, roundWins: 1 })
  })

  it('draw: both tie, +5 bonus each', () => {
    const [a, b] = statsEntriesFor('bt2', completed([win('a'), win('b'), tie])) // 15 + 5 each
    expect(a).toMatchObject({ points: 20, won: 0, lost: 0, tied: 1, roundWins: 1 })
    expect(b).toMatchObject({ points: 20, won: 0, lost: 0, tied: 1, roundWins: 1 })
  })

  it('forfeits count as round wins for the player who submitted', () => {
    const [a, b] = statsEntriesFor('bt3', completed([forfeit('b'), forfeit('b'), tie])) // B 25+10, A 5
    expect(b).toMatchObject({ points: 35, won: 1, lost: 0, roundWins: 2 })
    expect(a).toMatchObject({ points: 5, won: 0, lost: 1, roundWins: 0 })
  })

  it('both players missed every round: a draw worth only the +5 bonus, no round wins', () => {
    const [a, b] = statsEntriesFor('bt4', completed([bothMissed, bothMissed, bothMissed]))
    for (const e of [a, b]) expect(e).toMatchObject({ points: 5, played: 1, won: 0, lost: 0, tied: 1, roundWins: 0 })
  })

  it('battles that never completed add nothing', () => {
    expect(statsEntriesFor('x', base())).toEqual([])
    for (const status of ['declined', 'cancelled', 'expired', 'active'] as const) {
      expect(statsEntriesFor('x', { ...base(), status })).toEqual([])
    }
  })

  it('sumStats adds ledger rows; no rows is all zeros', () => {
    expect(sumStats([])).toEqual(EMPTY_STATS)
    expect(sumStats([{ points: 30, played: 1, won: 1, roundWins: 2 }, { points: 5, played: 1, tied: 1 }])).toEqual({
      points: 35, played: 2, won: 1, lost: 0, tied: 1, roundWins: 2,
    })
  })
})

describe('recordBattleStats (stored, idempotent)', () => {
  it('writes both players’ public stats on completion', async () => {
    const f = fakeTools()
    const r = await recordBattleStats(f.tools, 'bt1', completed([win('a'), win('a'), win('b')]))
    expect(r.counted).toBe(2)
    expect(f.statsOf(A)).toEqual({ points: 30, played: 1, won: 1, lost: 0, tied: 0, roundWins: 2 })
    expect(f.statsOf(B)).toEqual({ points: 10, played: 1, won: 0, lost: 1, tied: 0, roundWins: 1 })
  })

  it('a replayed completion does not double count', async () => {
    const f = fakeTools()
    const s = completed([win('a'), tie, tie])
    await recordBattleStats(f.tools, 'bt1', s)
    const again = await recordBattleStats(f.tools, 'bt1', s)
    expect(again.counted).toBe(0)
    expect(f.statsOf(A)).toMatchObject({ played: 1, won: 1, points: 30 })
    expect(f.statsOf(B)).toMatchObject({ played: 1, lost: 1, points: 10 })
    expect(f.table('stats_entries').size).toBe(2)
  })

  it('accumulates across different battles and opponents', async () => {
    const f = fakeTools()
    await recordBattleStats(f.tools, 'bt1', completed([win('a'), win('a'), tie])) // A wins vs B
    await recordBattleStats(f.tools, 'bt2', completed([win('a'), win('b'), tie], C, A)) // C draws A
    expect(f.statsOf(A)).toEqual({ points: 35 + 20, played: 2, won: 1, lost: 0, tied: 1, roundWins: 3 })
    expect(f.statsOf(C)).toEqual({ points: 20, played: 1, won: 0, lost: 0, tied: 1, roundWins: 1 })
  })

  it('ignores a battle that is not complete', async () => {
    const f = fakeTools()
    expect((await recordBattleStats(f.tools, 'x', base())).counted).toBe(0)
    expect(f.statsOf(A)).toBeNull()
  })
})

describe('stats backfill', () => {
  async function seed(f: ReturnType<typeof fakeTools>) {
    for (const [id, state] of [
      ['old1', completed([win('a'), win('a'), win('b')])],
      ['old2', completed([bothMissed, bothMissed, bothMissed])],
      ['live', { ...base(), status: 'active' as const }],
    ] as const) {
      await f.tools.create('battles', { battleId: id, status: state.status, state }, id)
    }
  }

  it('counts every completed battle once, even if run twice or after the live hook', async () => {
    const f = fakeTools()
    await seed(f)
    // The live hook already counted old1 before the backfill ran.
    await recordBattleStats(f.tools, 'old1', (f.table('battles').get('old1')!.state as BattleState))
    expect(await backfillStats(f.tools)).toEqual({ battles: 2, counted: 2 })
    expect(await backfillStats(f.tools)).toEqual({ battles: 2, counted: 0 })
    expect(f.statsOf(A)).toEqual({ points: 35, played: 2, won: 1, lost: 0, tied: 1, roundWins: 2 })
    expect(f.statsOf(B)).toEqual({ points: 15, played: 2, won: 0, lost: 1, tied: 1, roundWins: 1 })
  })

  it('runStatsBackfillOnce runs only until its marker exists', async () => {
    const f = fakeTools()
    await seed(f)
    expect(await runStatsBackfillOnce(f.tools)).toBe(true)
    expect(f.table('app_migrations').has(STATS_BACKFILL_MARKER)).toBe(true)
    expect(await runStatsBackfillOnce(f.tools)).toBe(false)
    expect(f.statsOf(A)).toMatchObject({ played: 2 })
  })
})

describe('Rapid Fire battles count in the same stored stats (D63)', () => {
  function rapidDone(outcome: RoundOutcome): BattleState {
    const r = createBattle({ playerA: A, playerB: B, modeId: 'rapid', round1Skill: 'Juggling' }, T0)
    if (!r.ok) throw new Error(r.error.message)
    return { ...r.state, status: 'complete', currentRound: null, completedAt: T0, result: battleResult([outcome], false) }
  }

  it('a Rapid Fire win is +10 with no bonus, recorded in player_stats', async () => {
    const f = fakeTools()
    await recordBattleStats(f.tools, 'rf1', rapidDone(win('a')))
    expect(f.statsOf(A)).toMatchObject({ points: 10, played: 1, won: 1, lost: 0, roundWins: 1 })
    expect(f.statsOf(B)).toMatchObject({ points: 0, played: 1, won: 0, lost: 1 })
  })

  it('a Rapid Fire tie is +5 each; the opponent missing the deadline gives the challenger +10', async () => {
    const f = fakeTools()
    await recordBattleStats(f.tools, 'rf2', rapidDone(tie))
    await recordBattleStats(f.tools, 'rf3', rapidDone(forfeit('a')))
    expect(f.statsOf(A)).toMatchObject({ points: 15, played: 2, won: 1, tied: 1 })
    expect(f.statsOf(B)).toMatchObject({ points: 5, played: 2, lost: 1, tied: 1 })
  })
})
