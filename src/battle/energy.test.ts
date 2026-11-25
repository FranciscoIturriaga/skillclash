import type { ActionContext } from 'deepspace/worker'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../worker'
import { battleActions } from '../actions/battle-actions'
import { battleResult, createBattle, type BattleState, type RoundOutcome } from './machine'
import {
  ENERGY_MAX,
  ENERGY_REFILL_MS,
  FULL,
  applyEntry,
  currentEnergy,
  devSetEnergy,
  energyNow,
  energyOutcome,
  formatRefill,
  modeUsesEnergy,
  outOfEnergyMessage,
  refillTo,
  replay,
  spendEnergy,
} from './energy'
import { fakeTools } from './fake-tools'
import { makeEventHook } from './notify'
import { repairIfStuck, rowFromState } from './service'

const A = 'user_a'
const B = 'user_b'
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0)
const H = 60 * 60 * 1000
const P = ENERGY_REFILL_MS

const UNIQUE = { energy_entries: ['key'], stats_entries: ['battleId', 'playerId'], battle_transitions: ['battleId', 'fromVersion'] }
const env = {} as Env

function invited(modeId = 'test'): BattleState {
  const r = createBattle({ playerA: A, playerB: B, modeId, round1Skill: 'Juggling' }, T0)
  if (!r.ok) throw new Error(r.error.message)
  return r.state
}
const win = (w: 'a' | 'b'): RoundOutcome => ({ kind: 'votes', winner: w, votesA: w === 'a' ? 2 : 0, votesB: w === 'b' ? 2 : 0 })
const tie: RoundOutcome = { kind: 'votes', winner: 'tie', votesA: 0, votesB: 0 }
function completed(outcomes: RoundOutcome[], modeId = 'test'): BattleState {
  return { ...invited(modeId), status: 'complete', currentRound: null, completedAt: T0, result: battleResult(outcomes) }
}
const ended = (status: 'declined' | 'cancelled' | 'expired', modeId = 'test'): BattleState => ({ ...invited(modeId), status })

async function energyOf(tools: ReturnType<typeof fakeTools>['tools'], who: string, now = T0) {
  return (await energyNow(tools, who, now)).energy
}

describe('refill math', () => {
  it('a new player (no row) is full with no timer', () => {
    expect(currentEnergy(null, T0)).toEqual({ energy: 5, nextRefillAt: null })
  })

  it('the timer starts when energy drops below 5 and only runs below 5', () => {
    const s = applyEntry(FULL, { kind: 'spend', amount: -1, at: T0 })
    expect(s).toEqual({ energy: 4, lastRefillAt: T0 })
    expect(currentEnergy(s, T0 + P - 1)).toEqual({ energy: 4, nextRefillAt: T0 + P })
    // Back at 5: no timer, nothing more to count.
    expect(currentEnergy(s, T0 + P)).toEqual({ energy: 5, nextRefillAt: null })
    expect(currentEnergy(s, T0 + 10 * P)).toEqual({ energy: 5, nextRefillAt: null })
  })

  it('counts whole periods and keeps the partial one', () => {
    const s = { energy: 1, lastRefillAt: T0 }
    expect(currentEnergy(s, T0 + 2 * P + 2 * H)).toEqual({ energy: 3, nextRefillAt: T0 + 3 * P })
    expect(refillTo(s, T0 + 2 * P + 2 * H)).toEqual({ energy: 3, lastRefillAt: T0 + 2 * P })
  })

  it('caps at 5', () => {
    expect(currentEnergy({ energy: 0, lastRefillAt: T0 }, T0 + 100 * P)).toEqual({ energy: 5, nextRefillAt: null })
  })

  it('a spend while below 5 keeps the running timer (rolling refill)', () => {
    let s = applyEntry(FULL, { kind: 'spend', amount: -1, at: T0 })
    s = applyEntry(s, { kind: 'spend', amount: -1, at: T0 + 3 * H })
    expect(s).toEqual({ energy: 3, lastRefillAt: T0 })
    expect(currentEnergy(s, T0 + P)).toEqual({ energy: 4, nextRefillAt: T0 + 2 * P })
  })

  it('a gain that reaches 5 stops the timer; gains past 5 are lost', () => {
    let s = applyEntry(FULL, { kind: 'spend', amount: -1, at: T0 })
    s = applyEntry(s, { kind: 'refund', amount: 1, at: T0 + H })
    expect(s).toEqual(FULL)
    expect(applyEntry(FULL, { kind: 'win', amount: 1, at: T0 })).toEqual(FULL)
  })

  it('replay sorts by time', () => {
    const entries = [
      { kind: 'refund' as const, amount: 1, at: T0 + H },
      { kind: 'spend' as const, amount: -1, at: T0 },
    ]
    expect(replay(entries)).toEqual(FULL)
  })

  it('formats the time to the next refill, rounded up to the minute', () => {
    expect(formatRefill(T0 + 2 * H + 14 * 60_000, T0)).toBe('2h 14m')
    expect(formatRefill(T0 + 2 * H + 13 * 60_000 + 1, T0)).toBe('2h 14m')
    expect(formatRefill(T0 + 14 * 60_000, T0)).toBe('14m')
    expect(formatRefill(T0 + 5_000, T0)).toBe('1m')
    expect(outOfEnergyMessage({ energy: 0, nextRefillAt: T0 + 3 * H }, T0)).toBe('Out of energy. Next refill in 3h 0m.')
  })
})

describe('outcomes', () => {
  it('refund to the challenger on decline, cancel, expire; nothing for running battles', () => {
    for (const s of ['declined', 'cancelled', 'expired'] as const) {
      expect(energyOutcome(ended(s))).toEqual({ kind: 'refund', playerId: A })
    }
    expect(energyOutcome(invited())).toBeNull()
    expect(energyOutcome({ ...invited(), status: 'active' })).toBeNull()
  })

  it('+1 to the winner (either side), nothing for a draw', () => {
    expect(energyOutcome(completed([win('a'), win('a'), tie]))).toEqual({ kind: 'win', playerId: A })
    expect(energyOutcome(completed([win('b'), win('b'), tie]))).toEqual({ kind: 'win', playerId: B })
    expect(energyOutcome(completed([tie, tie, tie]))).toBeNull()
  })

  it('demo battles never touch energy; real and test modes do', () => {
    expect(modeUsesEnergy('demo')).toBe(false)
    for (const m of ['standard', 'rapid', 'test', 'rapid_test']) expect(modeUsesEnergy(m)).toBe(true)
    expect(energyOutcome(completed([win('a')], 'demo'))).toBeNull()
  })
})

describe('ledger', () => {
  it('spend takes 1 and writes the public row', async () => {
    const { tools, table } = fakeTools(UNIQUE)
    const r = await spendEnergy(tools, A, 'b1', T0)
    expect(r).toEqual({ ok: true, energy: { energy: 4, nextRefillAt: T0 + P } })
    expect(table('player_energy').get(A)).toMatchObject({ userId: A, energy: 4, lastRefillAt: T0 })
  })

  it('refuses at 0 with the time to the next refill', async () => {
    const { tools } = fakeTools(UNIQUE)
    for (let i = 0; i < ENERGY_MAX; i++) expect((await spendEnergy(tools, A, `b${i}`, T0)).ok).toBe(true)
    const r = await spendEnergy(tools, A, 'b9', T0 + 46 * 60_000)
    expect(r).toEqual({ ok: false, code: 'out_of_energy', message: 'Out of energy. Next refill in 4h 14m.' })
    // One refill later it works again.
    expect((await spendEnergy(tools, A, 'b9', T0 + P)).ok).toBe(true)
  })

  it('two simultaneous spends of the last energy: exactly one wins', async () => {
    const { tools } = fakeTools(UNIQUE)
    await devSetEnergy(tools, A, 1, T0)
    const [x, y] = await Promise.all([spendEnergy(tools, A, 'bx', T0), spendEnergy(tools, A, 'by', T0)])
    expect([x.ok, y.ok].sort()).toEqual([false, true])
    expect(await energyOf(tools, A)).toBe(0)
  })

  for (const status of ['declined', 'cancelled', 'expired'] as const) {
    it(`refunds a ${status} challenge once, even if the event is replayed`, async () => {
      const { tools, table } = fakeTools(UNIQUE)
      await spendEnergy(tools, A, 'b1', T0)
      const hook = makeEventHook(env, tools)
      const ev = { declined: 'battle_declined', cancelled: 'battle_cancelled', expired: 'battle_expired' }[status]
      await hook('b1', ended(status), [{ type: ev } as never])
      expect(await energyOf(tools, A)).toBe(5)
      await spendEnergy(tools, A, 'b2', T0)
      await hook('b1', ended(status), [{ type: ev } as never]) // replay
      expect(await energyOf(tools, A)).toBe(4)
      expect([...table('energy_entries').values()].filter((e) => e.kind === 'refund')).toHaveLength(1)
    })
  }

  it('no refund for a challenge that was never paid for (sent before energy)', async () => {
    const { tools } = fakeTools(UNIQUE)
    await devSetEnergy(tools, A, 3, T0)
    await makeEventHook(env, tools)('old', ended('declined'), [{ type: 'battle_declined' }])
    expect(await energyOf(tools, A)).toBe(3)
  })

  it('win gives the winner +1 once (capped at 5); a draw gives nothing', async () => {
    // The hook stamps entries with the real clock, so this test uses it too.
    const now = Date.now()
    const { tools } = fakeTools(UNIQUE)
    await devSetEnergy(tools, A, 2, now)
    await devSetEnergy(tools, B, 2, now)
    const hook = makeEventHook(env, tools)
    const done = completed([win('b'), win('b'), tie])
    const ev = [{ type: 'battle_completed', result: done.result! } as const]
    await hook('b1', done, ev)
    await hook('b1', done, ev) // replay
    expect(await energyOf(tools, B, now)).toBe(3)
    expect(await energyOf(tools, A, now)).toBe(2)

    const draw = completed([tie, tie, tie])
    await hook('b2', draw, [{ type: 'battle_completed', result: draw.result! }])
    expect(await energyOf(tools, A, now)).toBe(2)
    expect(await energyOf(tools, B, now)).toBe(3)

    // Capped: a full winner stays at 5.
    const { tools: t2 } = fakeTools(UNIQUE)
    await makeEventHook(env, t2)('b3', done, ev)
    expect(await energyOf(t2, B)).toBe(5)
  })

  it('the repair path settles too, without double counting what the hook did', async () => {
    const { tools } = fakeTools(UNIQUE)
    await spendEnergy(tools, A, 'b1', T0)
    const before = invited()
    const after = { ...before, status: 'declined' as const, version: before.version + 1 }
    await tools.create('battles', { battleId: 'b1', playerA: A, playerB: B, modeId: 'test', ...rowFromState(before) }, 'b1')
    await tools.create('battle_transitions', { battleId: 'b1', fromVersion: before.version, action: 'decline', actor: B, at: T0, toState: after })
    // The hook already refunded (e.g. it ran, then the battle write failed).
    await makeEventHook(env, tools)('b1', after, [{ type: 'battle_declined' }])
    expect(await repairIfStuck(tools, 'b1', before.version)).toBe(true)
    expect(await energyOf(tools, A)).toBe(5)
    await spendEnergy(tools, A, 'b2', T0)
    expect(await energyOf(tools, A)).toBe(4)
  })
})

describe('challenge action', () => {
  function setup() {
    const { tools, table } = fakeTools({ ...UNIQUE, usernames: ['username'] })
    const ctx = (userId: string, params: Record<string, unknown>) =>
      ({ userId, params, tools, env }) as unknown as ActionContext<Env>
    return { tools, table, ctx }
  }
  const video = (u: string) => ({ fileKey: `videos/${u}/abcdefghijklmnopqrstuvwx.webm`, mimeType: 'video/webm', sizeBytes: 1000, durationSec: 5 })

  it('spends 1 energy with the battle, and refuses at 0 before anything is written', async () => {
    const { tools, table, ctx } = setup()
    await tools.create('usernames', { username: 'ava', userId: A }, A)
    await tools.create('usernames', { username: 'ben', userId: B }, B)
    const params = { opponentUsername: 'ben', modeId: 'test', skill: 'Juggling', ...video(A) }

    const ok = await battleActions.challenge(ctx(A, params))
    expect(ok.success).toBe(true)
    expect(await energyOf(tools, A, Date.now())).toBe(4)

    await devSetEnergy(tools, A, 0, Date.now())
    const battles = table('battles').size
    const refused = await battleActions.challenge(ctx(A, { ...params, modeId: 'rapid_test' }))
    expect(refused).toMatchObject({ success: false, code: 'out_of_energy' })
    expect((refused as { error: string }).error).toMatch(/^Out of energy\. Next refill in (\d+h )?\d+m\.$/)
    expect(table('battles').size).toBe(battles)

    // Accepting is free.
    const before = await energyOf(tools, B, Date.now())
    await battleActions.declineChallenge(ctx(B, { battleId: [...table('battles').keys()][0] }))
    expect(await energyOf(tools, B, Date.now())).toBe(before)
  })

  it('a refused challenge (bad input) costs nothing', async () => {
    const { tools, ctx } = setup()
    await tools.create('usernames', { username: 'ava', userId: A }, A)
    await tools.create('usernames', { username: 'ben', userId: B }, B)
    const r = await battleActions.challenge(ctx(A, { opponentUsername: 'ben', modeId: 'test', skill: 'Juggling' }))
    expect(r).toMatchObject({ success: false, error: 'Record or choose a video first.' })
    expect(await energyOf(tools, A, Date.now())).toBe(5)
  })

  it('the dev energy action only works on the local dev server', async () => {
    const { ctx } = setup()
    expect(await battleActions.devSetMyEnergy(ctx(A, { energy: 0 }))).toMatchObject({ success: false, code: 'not_found' })
    const local = { ...ctx(A, { energy: 0 }), env: { ALLOW_DEBUG_ROUTES: 'true' } } as unknown as ActionContext<Env>
    expect(await battleActions.devSetMyEnergy(local)).toMatchObject({ success: true, data: { energy: 0 } })
  })
})
