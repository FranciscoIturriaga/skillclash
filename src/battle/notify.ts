/**
 * Email notifications (phase 4). Only two emails exist:
 *   - "You've been challenged" → the opponent, when a battle is created
 *   - "Battle result"          → both players, when a battle completes
 * Failures are logged and never undo a state change.
 */

import type { ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { BattleState } from './machine'
import type { EventHook } from './service'

export async function notifyChallenged(
  _env: Env,
  _tools: ActionTools,
  _battleId: string,
  _state: BattleState,
): Promise<void> {
  // Filled in during phase 4.
}

export function makeEventHook(_env: Env, _tools: ActionTools): EventHook {
  return async () => {
    // Filled in during phase 4.
  }
}
