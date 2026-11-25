/**
 * Cron tasks, registered into the AppCronRoom DO (worker.ts).
 *
 * `battle-sweep` runs every minute (the finest interval available) and moves
 * battles past their deadlines: closes submission windows and tallies votes.
 * Every server action also does this lazily for the battle it touches, so the
 * sweep only matters for battles nobody is looking at. Both paths go through
 * src/battle/service.ts, and both are idempotent: a second run finds nothing due.
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { createActionTools } from './server/action-routes'
import { advance, queryAll, revealEndedRounds, type BattleRow } from './battle/service'
import { makeEventHook } from './battle/notify'

export const tasks: CronTask[] = [{ name: 'battle-sweep', intervalMinutes: 1 }]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name === 'battle-sweep') await battleSweep(env)
}

export async function battleSweep(env: Env): Promise<void> {
  const tools = createActionTools(env, env.OWNER_USER_ID, '')
  const hook = makeEventHook(env, tools)
  const now = Date.now()
  const active = await queryAll<BattleRow & Record<string, unknown>>(tools, 'battles', { status: 'active' })

  let advanced = 0
  let failed = 0
  for (const b of active) {
    try {
      // Always heal reveals (cheap), then advance only battles with a passed deadline.
      await revealEndedRounds(tools, b.recordId, b.data.state)
      if (b.data.nextDeadline !== null && b.data.nextDeadline <= now) {
        const r = await advance(tools, b.recordId, now, 'cron', hook)
        if (r.ok) {
          if (r.value.version !== b.data.version) advanced++
        } else {
          failed++
          console.error(`[cron] battle-sweep ${b.recordId}: ${r.error.code} ${r.error.message}`)
        }
      }
    } catch (e) {
      failed++
      console.error(`[cron] battle-sweep ${b.recordId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`[cron] battle-sweep active=${active.length} advanced=${advanced} failed=${failed}`)
}
