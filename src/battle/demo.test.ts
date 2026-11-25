import { describe, expect, it } from 'vitest'
import { DEMO_PLAYERS, seedDemoBattle } from './demo'
import { fakeTools } from './fake-tools'
import { loadBattle, revealEndedRounds } from './service'
import { MODES } from './modes'

const T0 = Date.UTC(2026, 10, 25, 20, 0, 0)
const UNIQUE = {
  usernames: ['username'],
  battle_transitions: ['battleId', 'fromVersion'],
  submissions: ['battleId', 'round', 'playerId'],
  rounds: ['battleId', 'number'],
}
const video = (uid: string, n: number) => ({
  fileKey: `videos/${uid}/demoClip${n}AbCdEfGhIjKlMnOp.mp4`,
  mimeType: 'video/mp4',
  sizeBytes: 9000,
  durationSec: 2,
})
const input = { videoA: video(DEMO_PLAYERS.a.userId, 1), videoB: video(DEMO_PLAYERS.b.userId, 2) }

describe('seedDemoBattle (D65)', () => {
  it('seeds a 1-round demo battle already voting for 7 days, with both videos revealed', async () => {
    const { tools, table } = fakeTools(UNIQUE)
    let n = 0
    const r = await seedDemoBattle(tools, input, T0, () => `demo${++n}`)
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.voteDeadline).toBe(T0 + MODES.demo.voteWindowMs)

    const s = await loadBattle(tools, r.value.battleId)
    if (!s.ok) throw new Error(s.error.message)
    expect(s.value.modeId).toBe('demo')
    expect(s.value.status).toBe('active')
    expect(s.value.rounds).toHaveLength(1)
    expect(s.value.rounds[0].phase).toBe('vote')
    expect(s.value.rounds[0].skill).toBeTruthy()

    // Went through the transitions table: create → accept → submit.
    const claims = [...table('battle_transitions').values()].map((t) => t.action)
    expect(claims).toEqual(['accept', 'submit'])

    await revealEndedRounds(tools, r.value.battleId, s.value)
    const subs = [...table('submissions').values()]
    expect(subs).toHaveLength(2)
    expect(subs.every((x) => x.revealed === 'yes')).toBe(true)
    expect(table('usernames').get(DEMO_PLAYERS.a.userId)?.username).toBe(DEMO_PLAYERS.a.username)
  })

  it('refuses a second demo while one is open', async () => {
    const { tools } = fakeTools(UNIQUE)
    let n = 0
    expect((await seedDemoBattle(tools, input, T0, () => `demo${++n}`)).ok).toBe(true)
    const again = await seedDemoBattle(tools, input, T0 + 1000, () => `demo${++n}`)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('open_battle_exists')
  })

  it('refuses videos that are not under the demo players\' keys', async () => {
    const { tools } = fakeTools(UNIQUE)
    const bad = await seedDemoBattle(tools, { ...input, videoA: video('someone_else', 1) }, T0, () => 'x')
    expect(bad.ok).toBe(false)
  })
})
