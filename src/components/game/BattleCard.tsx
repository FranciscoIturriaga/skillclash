import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { currentRoundState, type BattleState } from '../../battle/machine'
import { activeDeadline, inviteExpiry, pastSummary, runningScore, statusLabel, roundLabel } from '../../battle/view'
import { Countdown, ExpiresIn, LiveDot, ModeBadge, PlayerTag } from './bits'

/** One battle in a feed: "@a VS @b", status, score and the live countdown. */
export function BattleCard({
  battleId,
  state,
  viewerId,
  highlight,
  className,
  compact,
  perspectiveId,
}: {
  battleId: string
  state: BattleState
  viewerId: string | null
  highlight?: boolean
  className?: string
  /** Tighter spacing, for the full-screen feed card (D59). */
  compact?: boolean
  /** Whose result a finished card's summary line shows (the profile's player); defaults to the viewer. */
  perspectiveId?: string | null
}) {
  const deadline = activeDeadline(state)
  const expiresAt = inviteExpiry(state)
  const score = state.result ? state.result.total : runningScore(state)
  const showScore = state.status === 'active' || state.status === 'complete'
  const voting = deadline?.kind === 'vote'
  // The round being played or voted on right now; round 1 before the battle starts.
  const shownRound = currentRoundState(state) ?? state.rounds[0]
  // Finished battles show "Won · Standard · Nov 25" instead of a skill.
  const summary = pastSummary(state, perspectiveId ?? viewerId)

  return (
    <Link
      to={`/battle/${battleId}`}
      data-testid="battle-card"
      className={cn(
        'group block rounded-2xl border bg-card transition-colors hover:border-primary/50',
        compact ? 'px-3 py-2' : 'p-4',
        highlight ? 'border-primary/60' : 'border-border',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider">
        <span className={cn('flex items-center gap-1.5', voting ? 'text-destructive' : highlight ? 'text-primary' : 'text-muted-foreground')}>
          {voting && <LiveDot />}
          {statusLabel(state, viewerId)}
        </span>
        {deadline && <Countdown at={deadline.at} className="text-sm" />}
        {expiresAt && <ExpiresIn at={expiresAt} className="normal-case tracking-normal" />}
      </div>

      <div className={cn('grid grid-cols-[1fr_auto_1fr] items-center gap-3', compact ? 'mt-1' : 'mt-3')}>
        <div className="min-w-0">
          <PlayerTag userId={state.playerA} side="a" link={false} className="block text-base" />
        </div>
        <div className={cn('font-display text-center font-extrabold italic leading-none', compact ? 'text-xl' : 'text-2xl')}>
          {showScore ? (
            <span className="tabular-nums">
              <span className="text-side-a">{score.a}</span>
              <span className="mx-1 text-muted-foreground">–</span>
              <span className="text-side-b">{score.b}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">VS</span>
          )}
        </div>
        <div className="min-w-0 text-right">
          <PlayerTag userId={state.playerB} side="b" link={false} className="block text-base" />
        </div>
      </div>

      <div className={cn('flex items-center justify-between text-sm text-muted-foreground', compact ? 'mt-1' : 'mt-3')}>
        {summary ? (
          <span className="truncate" data-testid="battle-card-summary">
            {summary}
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <ModeBadge modeId={state.modeId} />
            <span className="truncate">{roundLabel(shownRound)}</span>
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </div>
    </Link>
  )
}
