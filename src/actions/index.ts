import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { battleActions } from './battle-actions'

export const actions: Record<string, ActionHandler<Env>> = {
  ...battleActions,
}
