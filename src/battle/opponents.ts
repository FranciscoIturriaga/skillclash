/**
 * Past opponents for the challenge form's "Online now" list (D67).
 * Pure, so the ordering and the cap are unit tested.
 */

export const ONLINE_OPPONENTS_MAX = 8

export interface BattleLike {
  playerA: string
  playerB: string
  state?: { createdAt?: number } | null
}

/**
 * Everyone `me` has battled (any mode, any status), most recent battle first,
 * each opponent once. Battles without a createdAt sort last.
 */
export function pastOpponents(rows: readonly BattleLike[], me: string): string[] {
  const latest = new Map<string, number>()
  for (const r of rows) {
    const other = r.playerA === me ? r.playerB : r.playerB === me ? r.playerA : null
    if (!other || other === me) continue
    const at = Number(r.state?.createdAt) || 0
    if (!latest.has(other) || at > latest.get(other)!) latest.set(other, at)
  }
  return [...latest.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([id]) => id)
}

/** Past opponents who are online right now, most recent first, at most 8. */
export function onlinePastOpponents(
  rows: readonly BattleLike[],
  me: string,
  isOnline: (userId: string) => boolean,
  max = ONLINE_OPPONENTS_MAX,
): string[] {
  return pastOpponents(rows, me).filter(isOnline).slice(0, max)
}
