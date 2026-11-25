/**
 * Battle modes, as config (GAME_RULES.md "Modes").
 *
 * A mode only sets the window lengths (invite, submit, vote). Everything else about a battle is
 * the same in every mode. Add a mode by adding an entry here; nothing else in
 * the state machine needs to change.
 */

export type ModeId = 'standard' | 'test'

export interface BattleMode {
  id: ModeId
  label: string
  /** How long both players have to submit a video in each round. */
  submitWindowMs: number
  /** How long voting stays open once a round's videos are revealed. */
  voteWindowMs: number
  /** How long the challenged player has to answer before the invite expires (D51). */
  inviteWindowMs: number
  /** Hidden modes are not offered in the challenge picker by default. */
  hidden: boolean
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export const MODES: Record<ModeId, BattleMode> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    submitWindowMs: 12 * HOUR,
    voteWindowMs: 3 * HOUR,
    inviteWindowMs: 24 * HOUR,
    hidden: false,
  },
  // Test-only: very short windows so automated tests can play a full round
  // in seconds. Not offered in the UI unless the page is opened with ?test=1.
  test: {
    id: 'test',
    label: 'Test (short windows)',
    submitWindowMs: 3 * MINUTE,
    voteWindowMs: 20 * SECOND,
    inviteWindowMs: 5 * MINUTE,
    hidden: true,
  },
}

export function getMode(id: string): BattleMode | undefined {
  return Object.prototype.hasOwnProperty.call(MODES, id) ? MODES[id as ModeId] : undefined
}
