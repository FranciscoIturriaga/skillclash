/**
 * POST /api/admin/seed-demo: owner-only demo battle seed (D65).
 *
 * Needs `Authorization: Bearer <DEMO_SEED_TOKEN>` (a runtime secret only the
 * owner knows). Without the secret configured the route answers 404, so it
 * doesn't exist for anyone. Body: { skill?, videoA, videoB }, where each video
 * is { fileKey, mimeType, sizeBytes, durationSec } for a file the owner
 * uploaded with `npx deepspace app files put` (see scripts/seed-demo.sh).
 */

import type { Hono } from 'hono'
import type { AppContext } from '../../worker'
import { createActionTools } from './action-routes'
import { seedDemoBattle } from '../battle/demo'
import { makeEventHook } from '../battle/notify'
import { newBattleId } from '../actions/battle-actions'

/** Constant-time string compare (no early exit on the first mismatch). */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function registerDemoSeedRoute(app: Hono<AppContext>): void {
  app.post('/api/admin/seed-demo', async (c) => {
    const secret = c.env.DEMO_SEED_TOKEN
    if (!secret || secret.length < 24) return c.json({ error: 'Not found' }, 404)
    const auth = c.req.header('authorization') ?? ''
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!sameSecret(given, secret)) return c.json({ error: 'Not found' }, 404)

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Send a JSON body.' }, 400)
    }
    const tools = createActionTools(c.env, c.env.OWNER_USER_ID, '')
    const r = await seedDemoBattle(tools, body, Date.now(), newBattleId, makeEventHook(c.env, tools))
    if (!r.ok) {
      const status = r.error.code === 'open_battle_exists' ? 409 : r.error.code === 'bad_request' ? 400 : 500
      return c.json({ error: r.error.message, code: r.error.code }, status)
    }
    console.log(`[demo] seeded ${r.value.battleId}`)
    return c.json(r.value)
  })
}
