import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { currentRoundState, type BattleState } from '../../battle/machine'
import { activeDeadline, runningScore, statusLabel, roundLabel } from '../../battle/view'
import { Countdown, LiveDot, PlayerTag } from './bits'

/** One battle in a feed: "@a VS @b", status, score and the live countdown. */
export function BattleCard({
  battleId,
  state,
  viewerId,
  highlight,
}: {
  battleId: string
  state: BattleState
  viewerId: string | null
  highlight?: boolean
}) {
  const deadline = activeDeadline(state)
  const score = state.result ? state.result.total : runningScore(state)
  const showScore = state.status === 'active' || state.status === 'complete'
  const voting = deadline?.kind === 'vote'
  // The round being played or voted on right now; round 1 before the battle starts.
  const shownRound = currentRoundState(state) ?? state.rounds[0]

  return (
    <Link
      to={`/battle/${battleId}`}
      data-testid="battle-card"
      className={cn(
        'group block rounded-2xl border bg-card p-4 transition-colors hover:border-primary/50',
        highlight ? 'border-primary/60' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider">
        <span className={cn('flex items-center gap-1.5', voting ? 'text-destructive' : highlight ? 'text-primary' : 'text-muted-foreground')}>
          {voting && <LiveDot />}
          {statusLabel(state, viewerId)}
        </span>
        {deadline && <Countdown at={deadline.at} className="text-sm" />}
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="min-w-0">
          <PlayerTag userId={state.playerA} side="a" link={false} className="block text-base" />
        </div>
        <div className="font-display text-center text-2xl font-extrabold italic leading-none">
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

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span className="truncate">{roundLabel(shownRound)}{state.modeId === 'test' ? ' · test mode' : ''}</span>
        <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </div>
    </Link>
  )
}
