import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
import type { BattleState } from './machine'
import { emailsEnabledFor, notifyChallenged, notifyResult } from './notify'
import { fakeTools } from './fake-tools'

describe('emailsEnabledFor (D48)', () => {
  it('sends for real modes and skips test mode', () => {
    expect(emailsEnabledFor({ modeId: 'standard' })).toBe(true)
    expect(emailsEnabledFor({ modeId: 'test' })).toBe(false)
    expect(emailsEnabledFor({ modeId: 'rapid' })).toBe(true)
    expect(emailsEnabledFor({ modeId: 'rapid_test' })).toBe(false)
    expect(emailsEnabledFor({ modeId: 'demo' })).toBe(false)
  })
})

describe('email opt-out (D69)', () => {
  const env = { APP_NAME: 'skillclash' } as unknown as Env
  const state = {
    modeId: 'standard',
    playerA: 'ua',
    playerB: 'ub',
    result: { winner: 'a', total: { a: 30, b: 10 }, roundWins: { a: 2, b: 1 }, bonus: { a: 10, b: 0 } },
  } as unknown as BattleState

  function setup(prefs: Record<string, 'on' | 'off'>) {
    const { tools, table } = fakeTools({})
    const sent: string[] = []
    ;(tools as unknown as { integration: unknown }).integration = async (_: string, body: { to: string }) => {
      sent.push(body.to)
      return { success: true, data: { id: 'x' } }
    }
    table('users').set('ua', { email: 'a@x.test' })
    table('users').set('ub', { email: 'b@x.test' })
    table('usernames').set('ua', { username: 'alpha' })
    table('usernames').set('ub', { username: 'bravo' })
    for (const [id, emails] of Object.entries(prefs)) table('email_prefs').set(id, { userId: id, emails })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    return { tools, sent, log }
  }
  afterEach(() => vi.restoreAllMocks())

  it('sends both emails when no preference row exists (default on)', async () => {
    const { tools, sent } = setup({})
    await notifyChallenged(env, tools, 'b1', state)
    await notifyResult(env, tools, 'b1', state)
    expect(sent).toEqual(['b@x.test', 'a@x.test', 'b@x.test'])
  })

  it('skips the challenge email when the opponent opted out', async () => {
    const { tools, sent, log } = setup({ ub: 'off' })
    await notifyChallenged(env, tools, 'b1', state)
    expect(sent).toEqual([])
    expect(log).toHaveBeenCalledWith('[email] challenged b1 skipped (opted out)')
  })

  it('skips the result email only for the player who opted out', async () => {
    const { tools, sent, log } = setup({ ua: 'off', ub: 'on' })
    await notifyResult(env, tools, 'b1', state)
    expect(sent).toEqual(['b@x.test'])
    expect(log).toHaveBeenCalledWith('[email] result b1 side=a skipped (opted out)')
  })
})
