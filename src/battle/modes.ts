/**
 * Battle modes, as config (GAME_RULES.md "Modes").
 *
 * A mode sets everything that differs between kinds of battle: how many
 * rounds, the window lengths (invite, submit, vote) and whether the battle
 * bonus applies. The state machine reads these and has no per-mode branches.
 * Add a mode by adding an entry here.
 */

export type ModeId = 'standard' | 'rapid' | 'test' | 'rapid_test' | 'demo'

export interface BattleMode {
  id: ModeId
  /** Shown on the battle page and invite ("Standard", "Rapid Fire"). */
  label: string
  /** Short name used in sentences, e.g. "an open Rapid Fire battle" (D63). */
  name: string
  /** One line for the challenge form's mode picker. */
  description: string
  /**
   * Rounds per battle. 3 = set (A), set (B), freestyle. 1 = one set-and-match
   * round where A sets the skill (D63).
   */
  rounds: 1 | 3
  /** Whether the overall winner gets the battle bonus (+10 win / +5 each draw). */
  battleBonus: boolean
  /** How long players have to submit a video in each round. */
  submitWindowMs: number
  /** How long voting stays open once a round's videos are revealed. */
  voteWindowMs: number
  /** How long the challenged player has to answer before the invite expires (D51). */
  inviteWindowMs: number
  /** Hidden modes are not offered in the challenge picker by default. */
  hidden: boolean
  /** Shown as a badge on cards and the battle page (Standard has none). */
  badge: string | null
  /** Whether challenge/result emails go out (never for test or demo battles, D48). */
  emails: boolean
  /**
   * Whether sending this mode's challenge costs 1 energy, with refunds and the
   * win reward (D66). The hidden test modes mirror their real modes so the
   * browser tests exercise energy; demo battles never touch it.
   */
  energy: boolean
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const MODES: Record<ModeId, BattleMode> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    name: 'Standard',
    description: '3 rounds. 24h to accept, 12h to film each round, 3h of voting.',
    rounds: 3,
    battleBonus: true,
    submitWindowMs: 12 * HOUR,
    voteWindowMs: 3 * HOUR,
    inviteWindowMs: 24 * HOUR,
    hidden: false,
    badge: null,
    emails: true,
    energy: true,
  },
  rapid: {
    id: 'rapid',
    label: 'Rapid Fire',
    name: 'Rapid Fire',
    description: '1 round. 5 min to accept, 5 min to match, 15 min of voting.',
    rounds: 1,
    battleBonus: false,
    submitWindowMs: 5 * MINUTE,
    voteWindowMs: 15 * MINUTE,
    inviteWindowMs: 5 * MINUTE,
    hidden: false,
    badge: 'Rapid Fire',
    emails: true,
    energy: true,
  },
  // Test-only: very short windows so automated tests can play a full battle
  // in seconds. Not offered in the UI unless the page is opened with ?test=1.
  test: {
    id: 'test',
    label: 'Test (short windows)',
    name: 'Test',
    description: '3 rounds with test-speed timers.',
    rounds: 3,
    battleBonus: true,
    submitWindowMs: 3 * MINUTE,
    voteWindowMs: 20 * SECOND,
    inviteWindowMs: 5 * MINUTE,
    hidden: true,
    badge: 'Test',
    emails: false,
    energy: true,
  },
  // Rapid Fire rules with the test voting window, for the browser test.
  rapid_test: {
    id: 'rapid_test',
    label: 'Rapid Fire (test)',
    name: 'Rapid Fire test',
    description: '1 round with test-speed timers.',
    rounds: 1,
    battleBonus: false,
    submitWindowMs: 3 * MINUTE,
    voteWindowMs: 20 * SECOND,
    inviteWindowMs: 5 * MINUTE,
    hidden: true,
    badge: 'Rapid Fire',
    emails: false,
    energy: true,
  },
  // Seeded demo battles for reviewers (D65): one Rapid Fire style round whose
  // voting stays open for a week. Only the owner-only seed route creates them.
  demo: {
    id: 'demo',
    label: 'Demo',
    name: 'Demo',
    description: 'A seeded demo battle.',
    rounds: 1,
    battleBonus: false,
    submitWindowMs: 5 * MINUTE,
    voteWindowMs: 7 * DAY,
    inviteWindowMs: 5 * MINUTE,
    hidden: true,
    badge: 'Demo',
    emails: false,
    energy: false,
  },
}

export function getMode(id: string): BattleMode | undefined {
  return Object.prototype.hasOwnProperty.call(MODES, id) ? MODES[id as ModeId] : undefined
}

/** Modes a player can pick when challenging (demo battles are only seeded). */
export function pickableModes(includeTest: boolean): BattleMode[] {
  return Object.values(MODES).filter((m) => m.id !== 'demo' && (!m.hidden || includeTest))
}
