/** Small presentational pieces shared by the game pages. */

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Timer } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Side } from '../../battle/machine'
import { formatCountdown, formatExpiresIn } from '../../battle/view'
import { useNow } from '../../lib/useNow'
import { useUsernames } from './usernames'
import { getMode } from '../../battle/modes'

export const sideText: Record<Side, string> = { a: 'text-side-a', b: 'text-side-b' }
export const sideBg: Record<Side, string> = { a: 'bg-side-a', b: 'bg-side-b' }
export const sideBorder: Record<Side, string> = { a: 'border-side-a', b: 'border-side-b' }

/** "@name" in the player's corner color, linking to their profile. */
export function PlayerTag({
  userId,
  side,
  className,
  link = true,
}: {
  userId: string
  side?: Side
  className?: string
  link?: boolean
}) {
  const { nameOf } = useUsernames()
  const name = nameOf(userId)
  const label = name ? `@${name}` : 'player'
  const cls = cn('truncate font-semibold', side && sideText[side], className)
  if (!link || !name) return <span className={cls}>{label}</span>
  return (
    <Link to={`/u/${name}`} className={cn(cls, 'hover:underline')} onClick={(e) => e.stopPropagation()}>
      {label}
    </Link>
  )
}

/**
 * Live countdown to `at`. Calls `onExpire` once when it reaches zero (used to
 * nudge the server so the page doesn't wait for the minute cron).
 */
export function Countdown({
  at,
  onExpire,
  className,
  label,
}: {
  at: number
  onExpire?: () => void
  className?: string
  label?: string
}) {
  const now = useNow(1000)
  const left = at - now
  const fired = useRef<number | null>(null)
  useEffect(() => {
    if (left <= 0 && onExpire && fired.current !== at) {
      fired.current = at
      onExpire()
    }
  }, [left, at, onExpire])
  const urgent = left > 0 && left < 60_000
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-display text-lg font-bold tabular-nums',
        urgent ? 'text-destructive' : 'text-foreground',
        className,
      )}
      aria-label={label ? `${label}: ${formatCountdown(left)}` : undefined}
    >
      <Timer className="size-4 opacity-70" aria-hidden />
      {left > 0 ? formatCountdown(left) : '0:00'}
    </span>
  )
}

/**
 * "Expires in 23h" for an open invite. Coarse on purpose; re-renders every
 * 30 s. Calls `onExpire` once when the deadline passes.
 */
export function ExpiresIn({ at, onExpire, className }: { at: number; onExpire?: () => void; className?: string }) {
  const now = useNow(30_000)
  const left = at - now
  const fired = useRef<number | null>(null)
  useEffect(() => {
    if (!onExpire) return
    if (left <= 0) {
      if (fired.current !== at) {
        fired.current = at
        onExpire()
      }
      return
    }
    // Fire on time even between the 30 s ticks.
    const t = setTimeout(() => {
      if (fired.current !== at) {
        fired.current = at
        onExpire()
      }
    }, left)
    return () => clearTimeout(t)
  }, [left, at, onExpire])
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', className)} data-testid="invite-expires">
      <Timer className="size-3.5 opacity-70" aria-hidden />
      {left > 0 ? `Expires in ${formatExpiresIn(left)}` : 'Expired'}
    </span>
  )
}

/** "Rapid Fire" / "Demo" / "Test" pill for non-Standard battles (D63, D65). */
export function ModeBadge({ modeId, className }: { modeId: string; className?: string }) {
  const badge = getMode(modeId)?.badge
  if (!badge) return null
  const demo = modeId === 'demo'
  return (
    <span
      data-testid="mode-badge"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase leading-none tracking-wider',
        demo ? 'bg-side-a/15 text-side-a' : 'bg-primary/15 text-primary',
        className,
      )}
    >
      {badge}
    </span>
  )
}

export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 rounded-full bg-destructive animate-live', className)} />
}

export function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="font-display mb-3 flex items-baseline gap-2 text-xl font-extrabold uppercase italic tracking-wide">
      {children}
      {count !== undefined && <span className="text-sm font-semibold not-italic text-muted-foreground">{count}</span>}
    </h2>
  )
}

export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string }) {
  return (
    <div {...rest} className={cn('rounded-2xl border border-border bg-card', className)}>
      {children}
    </div>
  )
}
