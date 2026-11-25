/**
 * Email notifications. Only two emails exist:
 *   - "You've been challenged" → the opponent, when a battle is created
 *   - "Battle result"          → both players, when a battle completes
 *
 * Sent through the `email/send` integration, billed to the app owner
 * ($0.013 each). The sender is always DeepSpace Apps
 * <notifications@updates.app.space> whatever `from` says (DECISIONS D40).
 *
 * Exactly-once comes from the state machine: the event hook only runs for the
 * caller whose transition claim won, so `battle_completed` fires once.
 * Failures are logged and never undo a state change.
 *
 * Recipient emails are read server-side from `users` and never leave the worker.
 */

import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { BattleState, Side } from './machine'
import type { EventHook } from './service'
import { recordBattleStats } from './stats'
import { settleBattleEnergy } from './energy'
import { getMode } from './modes'

interface Person {
  email: string | null
  username: string
}

async function person(tools: ActionTools, userId: string): Promise<Person> {
  const [u, n] = await Promise.all([
    tools.get<{ email?: string } & Record<string, unknown>>('users', userId),
    tools.get<{ username?: string } & Record<string, unknown>>('usernames', userId),
  ])
  const email = u.success && typeof u.data.record.data.email === 'string' ? u.data.record.data.email : null
  const username = n.success && typeof n.data.record.data.username === 'string' ? n.data.record.data.username : 'a player'
  return { email, username }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function siteUrl(env: Env): string {
  return `https://${env.APP_NAME}.app.space`
}

function layout(title: string, bodyHtml: string, ctaUrl: string, ctaLabel: string): string {
  return `<!doctype html><html><body style="margin:0;background:#07080a;font-family:Inter,Arial,sans-serif;color:#f2f4f7">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="margin:0 0 4px;font-weight:800;font-style:italic;letter-spacing:1px;text-transform:uppercase">Skill<span style="color:#c8ff2e">Clash</span></p>
<h1 style="margin:16px 0 12px;font-size:28px;line-height:1.1;text-transform:uppercase;font-style:italic">${esc(title)}</h1>
${bodyHtml}
<p style="margin:28px 0"><a href="${ctaUrl}" style="background:#c8ff2e;color:#0a0b0d;padding:12px 20px;border-radius:10px;font-weight:700;text-decoration:none;text-transform:uppercase">${esc(ctaLabel)}</a></p>
<p style="color:#8b93a1;font-size:12px">You're getting this because you play on SkillClash.</p>
</div></body></html>`
}

async function send(
  tools: ActionTools,
  to: string,
  subject: string,
  html: string,
  text: string,
  tag: string,
): Promise<void> {
  const r = await tools.integration<{ id?: string }>('email/send', { to, subject, html, text })
  if (r.success) console.log(`[email] ${tag} sent id=${r.data?.id ?? '?'}`)
  else console.error(`[email] ${tag} failed: ${r.code ?? ''} ${r.error}`)
}

/** Test and demo battles send no email: no credits spent, no mail to fake addresses (D48, D63). */
export function emailsEnabledFor(state: Pick<BattleState, 'modeId'>): boolean {
  return getMode(state.modeId)?.emails ?? false
}

export async function notifyChallenged(env: Env, tools: ActionTools, battleId: string, state: BattleState): Promise<void> {
  if (!emailsEnabledFor(state)) return console.log(`[email] challenged ${battleId} skipped (${state.modeId} mode)`)
  try {
    const [challenger, opponent] = await Promise.all([person(tools, state.playerA), person(tools, state.playerB)])
    if (!opponent.email) return console.warn(`[email] challenged ${battleId}: opponent has no email`)
    const url = `${siteUrl(env)}/battle/${battleId}`
    // No skill name here: round 1's skill stays hidden until B accepts (D53).
    const subject = `@${challenger.username} challenged you on SkillClash`
    const html = layout(
      "You've been challenged",
      `<p style="margin:0 0 8px;font-size:16px"><b style="color:#2dd4ff">@${esc(challenger.username)}</b> wants to battle you.</p>
<p style="margin:0;color:#8b93a1">Their skill stays hidden until you accept. To accept, name round 2's skill and film it, or decline.</p>`,
      url,
      'See the challenge',
    )
    const text = `@${challenger.username} challenged you on SkillClash.\nTheir skill stays hidden until you accept.\nAccept or decline: ${url}`
    await send(tools, opponent.email, subject, html, text, `challenged ${battleId}`)
  } catch (e) {
    console.error(`[email] challenged ${battleId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function notifyResult(env: Env, tools: ActionTools, battleId: string, state: BattleState): Promise<void> {
  const result = state.result
  if (!result) return
  if (!emailsEnabledFor(state)) return console.log(`[email] result ${battleId} skipped (${state.modeId} mode)`)
  const people: Record<Side, Person> = {
    a: await person(tools, state.playerA),
    b: await person(tools, state.playerB),
  }
  const url = `${siteUrl(env)}/battle/${battleId}`
  for (const side of ['a', 'b'] as const) {
    const me = people[side]
    const them = people[side === 'a' ? 'b' : 'a']
    if (!me.email) continue
    const headline = result.winner === 'draw' ? 'It was a draw' : result.winner === side ? 'You won' : 'You lost'
    const mine = result.total[side]
    const theirs = result.total[side === 'a' ? 'b' : 'a']
    const subject = `Battle result vs @${them.username}: ${headline.toLowerCase()} (${mine}–${theirs})`
    const html = layout(
      headline,
      `<p style="margin:0 0 8px;font-size:16px">Your battle with <b>@${esc(them.username)}</b> is over.</p>
<p style="margin:0;font-size:36px;font-weight:800;font-style:italic">${mine} <span style="color:#8b93a1">–</span> ${theirs}</p>
<p style="margin:8px 0 0;color:#8b93a1">Rounds won: ${result.roundWins[side]}–${result.roundWins[side === 'a' ? 'b' : 'a']} · bonus +${result.bonus[side]}</p>`,
      url,
      'See the results',
    )
    const text = `${headline}. Your battle with @${them.username} ended ${mine}–${theirs}.\nSee the results: ${url}`
    await send(tools, me.email, subject, html, text, `result ${battleId} side=${side}`)
  }
}

const ENERGY_EVENTS = new Set(['battle_declined', 'battle_cancelled', 'battle_expired', 'battle_completed'])

/**
 * What runs after a winning transition. Battle end: settle energy (D66).
 * On `battle_completed`: count the
 * battle on both profiles (stored stats, D56; idempotent), then email the
 * result. Each step's failure is logged and doesn't block the other.
 */
export function makeEventHook(env: Env, tools: ActionTools): EventHook {
  return async (battleId, state, events) => {
    // Energy (D66): refund a declined/cancelled/expired challenge, +1 to a
    // battle's winner. Keyed on the battle, so a replay changes nothing.
    if (events.some((e) => ENERGY_EVENTS.has(e.type))) {
      try {
        const done = await settleBattleEnergy(tools, battleId, state, Date.now())
        if (done) console.log(`[energy] ${battleId} ${done}`)
      } catch (e) {
        console.error(`[energy] ${battleId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (events.some((e) => e.type === 'battle_completed')) {
      try {
        const r = await recordBattleStats(tools, battleId, state)
        console.log(`[stats] ${battleId} counted=${r.counted}`)
      } catch (e) {
        console.error(`[stats] ${battleId}: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        await notifyResult(env, tools, battleId, state)
      } catch (e) {
        console.error(`[email] result ${battleId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}
