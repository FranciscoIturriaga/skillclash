/**
 * Server actions for SkillClash. Clients call these via POST /api/actions/:name.
 *
 * These tools run with record RBAC OFF, so every action authorizes the caller
 * itself (player checks live in the state machine; vote checks below).
 * Nothing here ever returns a raw `users` row (it contains email).
 */

import type { ActionContext, ActionHandler, ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  createBattle,
  currentRoundState,
  normalizeSkill,
  sideOf,
  SKILL_MAX_LENGTH,
  transition,
  type BattleState,
  type Side,
} from '../battle/machine'
import {
  advance,
  asRound,
  battlesBetween,
  findOpenBattle,
  countVotes,
  err,
  loadBattle,
  roundId,
  rowFromState,
  runAction,
  setterSkill,
  submissionId,
  toActionResult,
  type Outcome,
} from '../battle/service'
import { makeEventHook, notifyChallenged } from '../battle/notify'
import { pickableModes } from '../battle/modes'

type Ctx = ActionContext<Env>

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 20
/** Small slack for container/metadata rounding of a 20 s clip. */
const DURATION_SLACK_SEC = 0.75

function isDuplicate(r: ActionResult<unknown>): boolean {
  return !r.success && /duplicate/i.test(r.error)
}

/** URL-safe random id, e.g. `b7f3k2...` (16 chars). */
export function newBattleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return 'b' + Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-3)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function usernameOf(ctx: Ctx, userId: string): Promise<string | null> {
  const r = await ctx.tools.get<{ username: string }>('usernames', userId)
  return r.success ? r.data.record.data.username : null
}

function signedIn(ctx: Ctx): Outcome<true> {
  // Anonymous callers never reach actions (the route requires a JWT), but be explicit.
  return ctx.userId ? { ok: true, value: true } : err('bad_request', 'Sign in first.')
}

// ─── Usernames ──────────────────────────────────────────────────────────────

const setUsername: ActionHandler<Env> = async (ctx) => {
  const raw = typeof ctx.params.username === 'string' ? ctx.params.username.trim().toLowerCase() : ''
  if (!USERNAME_RE.test(raw)) {
    return toActionResult(err('bad_request', 'Usernames are 3–20 characters: letters, numbers and _.'))
  }
  const current = await usernameOf(ctx, ctx.userId)
  if (current === raw) return { success: true, data: { username: raw } }

  // uniqueOn ['username'] is the real guard: a taken name comes back Duplicate.
  const claim = await ctx.tools.create('usernames', { username: raw, userId: ctx.userId }, ctx.userId)
  if (!claim.success) {
    if (isDuplicate(claim)) return toActionResult(err('username_taken', `@${raw} is taken.`))
    return toActionResult(err('storage_error', claim.error))
  }
  // Private mirror on the user's own row (upsert by user id).
  await ctx.tools.create('users', { username: raw }, ctx.userId)
  return { success: true, data: { username: raw } }
}

// ─── Videos ─────────────────────────────────────────────────────────────────

/**
 * Keys must be ones this user generated for their own upload: the files proxy
 * only lets a user upload to `videos/<their id>/<random>.<ext>` (http-routes.ts),
 * so a player can't point their submission at someone else's file.
 */
export function videoKeyPattern(userId: string): RegExp {
  return new RegExp(`(^|/)videos/${escapeRe(userId)}/[A-Za-z0-9_-]{16,64}\\.[a-z0-9]{2,5}$`)
}

export interface VideoParams {
  fileKey: string
  mimeType: string
  sizeBytes: number
  durationSec: number
}

/** Validate the uploaded-video params every video-carrying action takes (20 s / 50 MB, D8). */
export function parseVideo(params: Record<string, unknown>, userId: string): Outcome<VideoParams> {
  const fileKey = typeof params.fileKey === 'string' ? params.fileKey : ''
  if (!fileKey) return err('bad_request', 'Record or choose a video first.')
  if (!videoKeyPattern(userId).test(fileKey)) return err('bad_request', 'That upload does not belong to you.')
  const sizeBytes = Number(params.sizeBytes)
  const durationSec = Number(params.durationSec)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_VIDEO_BYTES) {
    return err('bad_request', 'Videos must be 50 MB or smaller.')
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_VIDEO_SECONDS + DURATION_SLACK_SEC) {
    return err('bad_request', 'Videos must be 20 seconds or shorter.')
  }
  const mimeType = typeof params.mimeType === 'string' ? params.mimeType.slice(0, 100) : ''
  if (mimeType && !mimeType.startsWith('video/')) return err('bad_request', 'That file is not a video.')
  return { ok: true, value: { fileKey, mimeType, sizeBytes, durationSec } }
}

// ─── Challenge lifecycle ────────────────────────────────────────────────────

const challenge: ActionHandler<Env> = async (ctx) => {
  const auth = signedIn(ctx)
  if (!auth.ok) return toActionResult(auth)
  if (!(await usernameOf(ctx, ctx.userId))) {
    return toActionResult(err('no_username', 'Pick a username before challenging someone.'))
  }
  const opponentName =
    typeof ctx.params.opponentUsername === 'string'
      ? ctx.params.opponentUsername.trim().replace(/^@/, '').toLowerCase()
      : ''
  if (!USERNAME_RE.test(opponentName)) return toActionResult(err('bad_request', 'Enter a valid username.'))

  const found = await ctx.tools.query<{ userId: string }>('usernames', { where: { username: opponentName }, limit: 1 })
  if (!found.success || found.data.records.length === 0) {
    return toActionResult(err('not_found', `No player called @${opponentName}.`))
  }
  const opponentId = found.data.records[0].data.userId

  // Players pick Standard or Rapid Fire (test modes only from ?test=1);
  // demo battles are only seeded by the owner (D65).
  const modeId = typeof ctx.params.modeId === 'string' ? ctx.params.modeId : 'standard'
  const mode = pickableModes(true).find((m) => m.id === modeId)
  if (!mode) return toActionResult(err('invalid_mode', 'Pick Standard or Rapid Fire.'))

  // One open (invited or active) battle per pair per mode, either direction
  // (D47, D64). Self-challenges fall through to createBattle's own refusal.
  if (opponentId !== ctx.userId) {
    let between
    try {
      between = await battlesBetween(ctx.tools, ctx.userId, opponentId)
    } catch (e) {
      return toActionResult(err('storage_error', e instanceof Error ? e.message : String(e)))
    }
    if (findOpenBattle(between, ctx.userId, opponentId, Date.now(), mode.id)) {
      return toActionResult(
        err('open_battle_exists', `You already have an open ${mode.name} battle with @${opponentName}.`),
      )
    }
  }

  const now = Date.now()
  const round1Skill = typeof ctx.params.skill === 'string' ? ctx.params.skill : ''
  const created = createBattle(
    {
      playerA: ctx.userId,
      playerB: opponentId,
      modeId: mode.id,
      round1Skill,
    },
    now,
  )
  if (!created.ok) return toActionResult(err(created.error.code, created.error.message))
  const state = created.state
  // A films round 1's skill as part of the challenge (D53).
  const video = parseVideo(ctx.params, ctx.userId)
  if (!video.ok) return toActionResult(video)

  const battleId = newBattleId()
  // The skill name and video live only on A's hidden setter row (owner-read
  // until round 1 opens), never in the public battle state. Written first so
  // a battle never exists without its setter video.
  const setterRow = await ctx.tools.create(
    'submissions',
    {
      battleId,
      round: 1,
      playerId: ctx.userId,
      side: 'a',
      ...video.value,
      skill: normalizeSkill(round1Skill)!,
      revealed: 'no',
    },
    submissionId(battleId, 1, 'a'),
  )
  if (!setterRow.success) return toActionResult(err('storage_error', setterRow.error))

  const row = await ctx.tools.create(
    'battles',
    {
      battleId,
      playerA: state.playerA,
      playerB: state.playerB,
      modeId: state.modeId,
      ...rowFromState(state),
    },
    battleId,
  )
  if (!row.success) return toActionResult(err('storage_error', row.error))

  for (const { number: n } of state.rounds) {
    await ctx.tools.create('rounds', { battleId, number: n, totalVotes: 0 }, roundId(battleId, n))
  }

  await notifyChallenged(ctx.env, ctx.tools, battleId, state)
  return { success: true, data: { battleId } }
}

/**
 * B accepts: names round 2's skill and films it (D53). Same pattern as
 * submitVideo: dry-run the transition, write B's hidden setter row, then
 * commit. Round 1's skill is read here from A's hidden row so the
 * different-skill check runs on the server without the client ever seeing it.
 */
const acceptChallenge: ActionHandler<Env> = async (ctx) => {
  const now = Date.now()
  const battleId = String(ctx.params.battleId ?? '')
  const round2Skill = typeof ctx.params.round2Skill === 'string' ? ctx.params.round2Skill : ''
  const hook = makeEventHook(ctx.env, ctx.tools)

  const current = await advance(ctx.tools, battleId, now, ctx.userId, hook)
  if (!current.ok) return toActionResult(current)
  const round1Skill = await setterSkill(ctx.tools, battleId, current.value, 1)
  const dry = transition(current.value, { type: 'accept', by: ctx.userId, round2Skill, round1Skill }, now)
  if (!dry.ok) return toActionResult(err(dry.error.code, dry.error.message))
  // A one-round battle (Rapid Fire) has no round 2 to set: B accepts blind
  // and round 1 opens straight away (D63).
  if (current.value.rounds.length > 1) {
    const video = parseVideo(ctx.params, ctx.userId)
    if (!video.ok) return toActionResult(video)

    const setterRow = await ctx.tools.create(
      'submissions',
      {
        battleId,
        round: 2,
        playerId: ctx.userId,
        side: 'b',
        ...video.value,
        skill: normalizeSkill(round2Skill)!,
        revealed: 'no',
      },
      submissionId(battleId, 2, 'b'),
    )
    if (!setterRow.success) return toActionResult(err('storage_error', setterRow.error))
  }

  const r = await runAction(
    ctx.tools,
    battleId,
    () => ({ type: 'accept', by: ctx.userId, round2Skill, round1Skill }),
    ctx.userId,
    now,
    hook,
  )
  return toActionResult(r.ok ? { ok: true, value: { version: r.value.state.version } } : r)
}

const declineChallenge: ActionHandler<Env> = async (ctx) => {
  const battleId = String(ctx.params.battleId ?? '')
  const r = await runAction(
    ctx.tools,
    battleId,
    () => ({ type: 'decline', by: ctx.userId }),
    ctx.userId,
    Date.now(),
    makeEventHook(ctx.env, ctx.tools),
  )
  return toActionResult(r.ok ? { ok: true, value: { version: r.value.state.version } } : r)
}

/** The challenger withdraws an unanswered invite (D50). No email. */
const cancelChallenge: ActionHandler<Env> = async (ctx) => {
  const battleId = String(ctx.params.battleId ?? '')
  const r = await runAction(
    ctx.tools,
    battleId,
    () => ({ type: 'cancel', by: ctx.userId }),
    ctx.userId,
    Date.now(),
    makeEventHook(ctx.env, ctx.tools),
  )
  return toActionResult(r.ok ? { ok: true, value: { version: r.value.state.version } } : r)
}

// ─── Submissions ────────────────────────────────────────────────────────────

const submitVideo: ActionHandler<Env> = async (ctx) => {
  const now = Date.now()
  const battleId = String(ctx.params.battleId ?? '')
  const round = asRound(ctx.params.round)
  if (!round) return toActionResult(err('bad_request', 'Pick a round (1–3).'))

  const video = parseVideo(ctx.params, ctx.userId)
  if (!video.ok) return toActionResult(video)
  const { fileKey, mimeType, sizeBytes, durationSec } = video.value

  let skill: string | undefined
  if (round === 3) {
    const s = normalizeSkill(ctx.params.skill)
    if (!s) return toActionResult(err('invalid_skill', `Name your round 3 skill (1–${SKILL_MAX_LENGTH} characters).`))
    skill = s
  }

  const hook = makeEventHook(ctx.env, ctx.tools)
  const current = await advance(ctx.tools, battleId, now, ctx.userId, hook)
  if (!current.ok) return toActionResult(current)
  const side = sideOf(current.value, ctx.userId)
  if (!side) return toActionResult(err('not_a_player', 'Only the two players can submit videos.'))

  // Dry run so a refused submit never overwrites the stored row (e.g. a
  // second upload after the first was accepted).
  const dry = transition(current.value, { type: 'submit', by: ctx.userId, round }, now)
  if (!dry.ok) return toActionResult(err(dry.error.code, dry.error.message))

  // Write the (hidden) submission first, then commit the transition. If the
  // commit loses, the row stays hidden forever: reveal only flips sides the
  // machine counted as submitted.
  const sub = await ctx.tools.create(
    'submissions',
    {
      battleId,
      round,
      playerId: ctx.userId,
      side,
      fileKey,
      mimeType,
      sizeBytes,
      durationSec,
      ...(skill ? { skill } : {}),
      revealed: 'no',
    },
    submissionId(battleId, round, side),
  )
  if (!sub.success) return toActionResult(err('storage_error', sub.error))

  const r = await runAction(
    ctx.tools,
    battleId,
    () => ({ type: 'submit', by: ctx.userId, round }),
    ctx.userId,
    now,
    hook,
  )
  return toActionResult(r.ok ? { ok: true, value: { version: r.value.state.version } } : r)
}

// ─── Voting ─────────────────────────────────────────────────────────────────

const castVote: ActionHandler<Env> = async (ctx) => {
  const now = Date.now()
  const battleId = String(ctx.params.battleId ?? '')
  const round = asRound(ctx.params.round)
  const side = ctx.params.side === 'a' || ctx.params.side === 'b' ? (ctx.params.side as Side) : null
  if (!round || !side) return toActionResult(err('bad_request', 'Pick a round and a player.'))

  const current = await advance(ctx.tools, battleId, now, ctx.userId, makeEventHook(ctx.env, ctx.tools))
  if (!current.ok) return toActionResult(current)
  const state: BattleState = current.value

  if (sideOf(state, ctx.userId)) {
    return toActionResult(err('competitor', "Players can't vote in their own battle."))
  }
  const r = currentRoundState(state)
  if (state.status !== 'active' || !r || r.number !== round || r.phase !== 'vote' || now >= r.voteDeadline!) {
    return toActionResult(err('voting_closed', 'Voting for this round is not open.'))
  }

  // uniqueOn ['roundId','voterId'] is the one-vote guarantee. voterId is
  // userBound, so the room stamps the verified caller.
  const rid = roundId(battleId, round)
  const vote = await ctx.tools.create('votes', { roundId: rid, battleId, voterId: ctx.userId, side })
  if (!vote.success) {
    if (isDuplicate(vote)) return toActionResult(err('already_voted', 'You already voted in this round.'))
    return toActionResult(err('storage_error', vote.error))
  }

  // Live public total (not per side). Recount rather than increment so a
  // lost update heals on the next vote.
  const tally = await countVotes(ctx.tools, battleId, round)
  await ctx.tools.update('rounds', rid, { totalVotes: tally.total })
  return { success: true, data: { totalVotes: tally.total } }
}

/** Clients call this when a countdown hits zero, so the page doesn't wait for cron. */
const syncBattle: ActionHandler<Env> = async (ctx) => {
  const battleId = String(ctx.params.battleId ?? '')
  const r = await advance(ctx.tools, battleId, Date.now(), ctx.userId, makeEventHook(ctx.env, ctx.tools))
  return toActionResult(r.ok ? { ok: true, value: { version: r.value.version } } : r)
}

/** Has the caller voted in this round, and for whom? (votes read 'own' anyway; this is a convenience.) */
const myVote: ActionHandler<Env> = async (ctx) => {
  const battleId = String(ctx.params.battleId ?? '')
  const round = asRound(ctx.params.round)
  if (!round) return toActionResult(err('bad_request', 'Pick a round.'))
  const loaded = await loadBattle(ctx.tools, battleId)
  if (!loaded.ok) return toActionResult(loaded)
  const r = await ctx.tools.query<{ side: string }>('votes', {
    where: { roundId: roundId(battleId, round), voterId: ctx.userId },
    limit: 1,
  })
  const side = r.success && r.data.records[0] ? r.data.records[0].data.side : null
  return { success: true, data: { side } }
}

export const battleActions: Record<string, ActionHandler<Env>> = {
  setUsername,
  challenge,
  acceptChallenge,
  declineChallenge,
  cancelChallenge,
  submitVideo,
  castVote,
  syncBattle,
  myVote,
}
