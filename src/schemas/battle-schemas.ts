/**
 * SkillClash collections.
 *
 * Rule of thumb: clients can READ, but never WRITE, anything game-related.
 * Every write goes through a server action (src/actions) or the cron sweep
 * (src/cron.ts), which run the state machine first. That is why every
 * `create` / `update` / `delete` below is false for every role.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const NO_WRITES = { create: false, update: false, delete: false } as const

/** Everyone (signed in or not) can read; nobody can write from a client. */
function publicReadOnly(): Record<string, RolePermissions> {
  return {
    '*': { read: true, ...NO_WRITES },
    viewer: { read: true, ...NO_WRITES },
    member: { read: true, ...NO_WRITES },
    admin: { read: true, ...NO_WRITES },
  }
}

/**
 * Public usernames. `uniqueOn: ['username']` is the database-level guarantee
 * that two people can't hold the same name. The record id is the user id, so
 * there is also at most one row per user. Written only by `setUsername`.
 */
export const usernamesSchema: CollectionSchema = {
  name: 'usernames',
  columns: [
    { name: 'username', storage: 'text', interpretation: 'plain', required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
  ],
  uniqueOn: ['username'],
  permissions: publicReadOnly(),
}

/**
 * One row per battle. `state` holds the full state machine value
 * (src/battle/machine.ts BattleState); the other columns mirror parts of it
 * so the feed can filter without parsing JSON.
 *
 * `state` never contains anything secret: per-player vote counts only enter
 * it when a round's voting closes, which is when they become public.
 */
export const battlesSchema: CollectionSchema = {
  name: 'battles',
  columns: [
    /** Same as the record id. Client `where` filters only match data columns. */
    { name: 'battleId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'playerA', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'playerB', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'modeId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['invited', 'declined', 'active', 'complete'] },
      required: true,
    },
    { name: 'phase', storage: 'text', interpretation: 'plain' },
    { name: 'currentRound', storage: 'number', interpretation: 'plain' },
    { name: 'version', storage: 'number', interpretation: 'plain', required: true },
    /** Epoch ms of the next deadline (submit or vote), or null. */
    { name: 'nextDeadline', storage: 'number', interpretation: 'plain' },
    { name: 'state', storage: 'text', interpretation: { kind: 'json' }, required: true },
  ],
  permissions: publicReadOnly(),
}

/**
 * One row per round (3 per battle), id `<battleId>_r<n>`. Holds the live
 * total vote count, which is public while voting is open. Per-player counts
 * are NOT here.
 */
export const roundsSchema: CollectionSchema = {
  name: 'rounds',
  columns: [
    { name: 'battleId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'number', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'totalVotes', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  uniqueOn: ['battleId', 'number'],
  permissions: publicReadOnly(),
}

/**
 * A player's video for one round. Hidden from everyone except the uploader
 * (`ownerField: playerId`) until `revealed` flips to 'yes' when the round's
 * submission window ends. The file itself is a public-with-link upload; its
 * key lives only here, so hiding the row hides the video (DECISIONS D14).
 */
export const submissionsSchema: CollectionSchema = {
  name: 'submissions',
  columns: [
    { name: 'battleId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'round', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    // Server-written owner. No client role can create rows, so this is never
    // client-controlled (and must not be userBound: the cron writes too).
    { name: 'playerId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'side', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'fileKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'mimeType', storage: 'text', interpretation: 'plain' },
    { name: 'sizeBytes', storage: 'number', interpretation: 'plain' },
    { name: 'durationSec', storage: 'number', interpretation: 'plain' },
    /** Round 3 (freestyle) only: the skill this player chose. */
    { name: 'skill', storage: 'text', interpretation: 'plain' },
    {
      name: 'revealed',
      storage: 'text',
      interpretation: { kind: 'select', options: ['no', 'yes'] },
      required: true,
      default: 'no',
    },
  ],
  uniqueOn: ['battleId', 'round', 'playerId'],
  ownerField: 'playerId',
  visibilityField: { field: 'revealed', value: 'yes' },
  permissions: {
    '*': { read: 'published', ...NO_WRITES },
    viewer: { read: 'published', ...NO_WRITES },
    member: { read: 'published', ...NO_WRITES },
    admin: { read: 'published', ...NO_WRITES },
  },
}

/**
 * One vote per user per round, enforced by `uniqueOn` in the database.
 * `voterId` is stamped by the server with the verified caller (`userBound`).
 * Each voter can read only their own vote, so nobody can tally early.
 */
export const votesSchema: CollectionSchema = {
  name: 'votes',
  columns: [
    { name: 'roundId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'battleId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'voterId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'side', storage: 'text', interpretation: 'plain', required: true, immutable: true },
  ],
  uniqueOn: ['roundId', 'voterId'],
  ownerField: 'voterId',
  permissions: {
    viewer: { read: 'own', ...NO_WRITES },
    member: { read: 'own', ...NO_WRITES },
    admin: { read: true, ...NO_WRITES },
  },
}

/**
 * The concurrency guard (DECISIONS D10/D15). Every state change first claims
 * the row (battleId, fromVersion). `uniqueOn` lets exactly one claim per
 * version succeed; a simultaneous second attempt gets a Duplicate refusal and
 * the caller reports a conflict. `toState` is kept so a half-finished write
 * can be repaired. Not readable by clients.
 */
export const transitionsSchema: CollectionSchema = {
  name: 'battle_transitions',
  columns: [
    { name: 'battleId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'fromVersion', storage: 'number', interpretation: 'plain', required: true, immutable: true },
    { name: 'action', storage: 'text', interpretation: 'plain', required: true },
    { name: 'actor', storage: 'text', interpretation: 'plain' },
    { name: 'at', storage: 'number', interpretation: 'plain', required: true },
    { name: 'toState', storage: 'text', interpretation: { kind: 'json' }, required: true },
  ],
  uniqueOn: ['battleId', 'fromVersion'],
  permissions: {
    admin: { read: true, ...NO_WRITES },
  },
}

export const battleSchemas: CollectionSchema[] = [
  usernamesSchema,
  battlesSchema,
  roundsSchema,
  submissionsSchema,
  votesSchema,
  transitionsSchema,
]
