/** Small presentational pieces shared by the game pages. */

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Timer } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Side } from '../../battle/machine'
import { formatCountdown } from '../../battle/view'
import { useNow } from '../../lib/useNow'
import { useUsernames } from './usernames'

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

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-2xl border border-border bg-card', className)}>{children}</div>
}
