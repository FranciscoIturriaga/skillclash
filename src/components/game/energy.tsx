/**
 * Energy on the client (D66): the player's public `player_energy` row, turned
 * into the current value with the same pure math the server uses. The row is
 * a live query, so spends, refunds and win rewards show up as soon as the
 * server writes them; refills are computed here as time passes.
 */

import { useAuth, useQuery } from 'deepspace'
import { Zap } from 'lucide-react'
import { cn } from '@/components/ui'
import { ENERGY_MAX, currentEnergy, formatRefill, type EnergySnapshot } from '../../battle/energy'
import { useNow } from '../../lib/useNow'

export interface EnergyView {
  ready: boolean
  energy: number
  nextRefillAt: number | null
  /** "2h 14m" until the next +1, or null when full. */
  refillIn: string | null
}

export function useEnergy(): EnergyView {
  const { userId } = useAuth()
  const q = useQuery<EnergySnapshot & { userId: string }>('player_energy', { where: { userId: userId ?? '' }, limit: 1 })
  // useNow only re-renders on a timer; read the clock itself so a fresh write
  // isn't measured against a time up to 15 s old ("5h 1m" right after a spend).
  const tick = useNow(15_000)
  const now = Math.max(tick, Date.now())
  const ready = !!userId && q.status === 'ready'
  const { energy, nextRefillAt } = currentEnergy(q.records[0]?.data ?? null, now)
  return { ready, energy, nextRefillAt, refillIn: nextRefillAt === null ? null : formatRefill(nextRefillAt, now) }
}

/** 5 segments, the count ("3/5") and the time to the next refill when below 5. */
export function EnergyBar({ view, className }: { view: EnergyView; className?: string }) {
  const { energy, refillIn } = view
  return (
    <div
      data-testid="energy-bar"
      role="meter"
      aria-label="Energy"
      aria-valuemin={0}
      aria-valuemax={ENERGY_MAX}
      aria-valuenow={energy}
      className={cn('flex items-center gap-2 text-xs leading-4', className)}
    >
      <Zap className={cn('size-3.5 shrink-0', energy > 0 ? 'fill-primary text-primary' : 'text-muted-foreground')} aria-hidden />
      <div className="flex w-20 shrink-0 gap-1" aria-hidden>
        {Array.from({ length: ENERGY_MAX }, (_, i) => (
          <span
            key={i}
            data-testid="energy-segment"
            data-filled={i < energy}
            className={cn('h-2 flex-1 rounded-full', i < energy ? 'bg-primary' : 'bg-muted-foreground/25')}
          />
        ))}
      </div>
      <span data-testid="energy-count" className="font-display font-bold tabular-nums">
        {energy}/{ENERGY_MAX}
      </span>
      {refillIn && (
        <span data-testid="energy-refill" className="truncate text-muted-foreground">
          Next refill in {refillIn}
        </span>
      )}
    </div>
  )
}
