/**
 * Seeded demo battle for reviewers (D65).
 *
 * Reviewers usually have one account, so they can't play a battle. This seeds
 * one between two demo players that is already in its voting phase, with a
 * 7-day voting window (the `demo` mode in modes.ts). It goes through the same
 * path as a real battle: createBattle, A's hidden setter row, then `accept`
 * and B's `submit` through runAction (machine + battle_transitions guard),
 * which reveals the videos when voting opens.
 *
 * Only the owner can run it: the HTTP route (worker.ts) needs the
 * DEMO_SEED_TOKEN secret and answers 404 without it. No player action can
 * create a demo battle (challenge refuses the mode).
 */

import type { ActionTools } from 'deepspace/worker'
import { createBattle, normalizeSkill } from './machine'
import {
  battlesBetween,
  err,
  findOpenBattle,
  roundId,
  rowFromState,
  runAction,
  submissionId,
  type EventHook,
  type Outcome,
} from './service'

export const DEMO_PLAYERS = {
  a: { userId: 'demo_player_a', username: 'demo_ava' },
  b: { userId: 'demo_player_b', username: 'demo_ben' },
} as const

export const DEMO_DEFAULT_SKILL = 'Balance a ball on your head for 5 seconds'

export interface DemoVideo {
  fileKey: string
  mimeType: string
  sizeBytes: number
  durationSec: number
}

/** `videos/<demo player id>/<random>.<ext>`, the same shape real uploads use. */
function validVideo(v: unknown, userId: string): v is DemoVideo {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const key = new RegExp(`^videos/${userId}/[A-Za-z0-9_-]{16,64}\\.[a-z0-9]{2,5}$`)
  return (
    typeof o.fileKey === 'string' &&
    key.test(o.fileKey) &&
    typeof o.mimeType === 'string' &&
    o.mimeType.startsWith('video/') &&
    typeof o.sizeBytes === 'number' &&
    o.sizeBytes > 0 &&
    typeof o.durationSec === 'number' &&
    o.durationSec > 0
  )
}

export async function seedDemoBattle(
  tools: ActionTools,
  input: { skill?: unknown; videoA?: unknown; videoB?: unknown },
  now: number,
  newId: () => string,
  hook?: EventHook,
): Promise<Outcome<{ battleId: string; voteDeadline: number | null }>> {
  const { a, b } = DEMO_PLAYERS
  if (!validVideo(input.videoA, a.userId)) return err('bad_request', `videoA must be a videos/${a.userId}/… upload.`)
  if (!validVideo(input.videoB, b.userId)) return err('bad_request', `videoB must be a videos/${b.userId}/… upload.`)
  const skill = normalizeSkill(typeof input.skill === 'string' ? input.skill : DEMO_DEFAULT_SKILL)
  if (!skill) return err('invalid_skill', 'Bad skill name.')

  // Demo players need usernames to show up as @demo_ava / @demo_ben. Same
  // shape setUsername writes (record id = user id); a repeat is harmless.
  for (const p of [a, b]) {
    const existing = await tools.get('usernames', p.userId)
    if (!existing.success) {
      const made = await tools.create('usernames', { username: p.username, userId: p.userId }, p.userId)
      if (!made.success) return err('storage_error', `username ${p.username}: ${made.error}`)
    }
  }

  // One open demo battle at a time (the per-mode pair rule, D64).
  const open = findOpenBattle(await battlesBetween(tools, a.userId, b.userId), a.userId, b.userId, now, 'demo')
  if (open) return err('open_battle_exists', `A demo battle is already open: ${open.recordId}.`)

  const created = createBattle({ playerA: a.userId, playerB: b.userId, modeId: 'demo', round1Skill: skill }, now)
  if (!created.ok) return err(created.error.code, created.error.message)
  const state = created.state
  const battleId = newId()

  // A's hidden setter row, then the battle row and its round rows: the same
  // writes as the challenge action.
  const va = input.videoA as DemoVideo
  const vb = input.videoB as DemoVideo
  const setter = await tools.create(
    'submissions',
    { battleId, round: 1, playerId: a.userId, side: 'a', ...va, skill, revealed: 'no' },
    submissionId(battleId, 1, 'a'),
  )
  if (!setter.success) return err('storage_error', setter.error)
  const row = await tools.create(
    'battles',
    { battleId, playerA: state.playerA, playerB: state.playerB, modeId: state.modeId, ...rowFromState(state) },
    battleId,
  )
  if (!row.success) return err('storage_error', row.error)
  for (const { number: n } of state.rounds) {
    await tools.create('rounds', { battleId, number: n, totalVotes: 0 }, roundId(battleId, n))
  }

  // B accepts (round 1 opens), then B submits: voting opens for 7 days and
  // the reveal step makes both videos public.
  const accepted = await runAction(
    tools,
    battleId,
    () => ({ type: 'accept', by: b.userId, round1Skill: skill }),
    b.userId,
    now,
    hook,
  )
  if (!accepted.ok) return accepted
  const sub = await tools.create(
    'submissions',
    { battleId, round: 1, playerId: b.userId, side: 'b', ...vb, revealed: 'no' },
    submissionId(battleId, 1, 'b'),
  )
  if (!sub.success) return err('storage_error', sub.error)
  const submitted = await runAction(tools, battleId, () => ({ type: 'submit', by: b.userId, round: 1 }), b.userId, now, hook)
  if (!submitted.ok) return submitted
  const round = submitted.value.state.rounds[0]
  if (round.phase !== 'vote') return err('storage_error', `Demo battle ended up in phase ${round.phase}.`)
  return { ok: true, value: { battleId, voteDeadline: round.voteDeadline } }
}
