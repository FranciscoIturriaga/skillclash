/**
 * Battle page: the match screen.
 *
 * Reads (all live via useQuery):
 *   battles     → the full BattleState (rounds, deadlines, results)
 *   rounds      → live total vote count per round (per-side counts stay hidden
 *                 until the state machine records the outcome at vote close)
 *   submissions → only rows the server lets this viewer read: their own, plus
 *                 every revealed one (DECISIONS D8/D26)
 * Writes go through server actions (accept, decline, submitVideo, castVote).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthOverlay, useAuth, useQuery } from 'deepspace'
import { Check, ChevronDown, Clock, EyeOff, Lock, Trophy, Vote, X } from 'lucide-react'
import { Button, EmptyState, Input, cn, useToast } from '@/components/ui'
import { currentRoundState, roundPoints, sideOf, type BattleState, type RoundState, type Side } from '../../../battle/machine'
import { getMode } from '../../../battle/modes'
import { roundDisplayOrder, runningScore, statusLabel, type BattleRowData, type SubmissionData } from '../../../battle/view'
import { callAction } from '../../../lib/api'
import { Countdown, LiveDot, Panel, PlayerTag, sideBorder, sideText } from '../../../components/game/bits'
import { VideoPlayer, VideoUploader } from '../../../components/game/VideoUploader'
import { useUsernames } from '../../../components/game/usernames'

interface RoundRow {
  battleId: string
  number: number
  totalVotes: number
}

export default function BattlePage() {
  const { id = '' } = useParams()
  const { userId, isSignedIn } = useAuth()
  const battleQ = useQuery<BattleRowData>('battles', { where: { battleId: id }, limit: 1 })
  const roundsQ = useQuery<RoundRow>('rounds', { where: { battleId: id }, limit: 3 })
  const subsQ = useQuery<SubmissionData>('submissions', { where: { battleId: id }, limit: 6 })

  const row = battleQ.records[0]?.data
  const state = row?.state
  const ready = battleQ.status === 'ready'

  // Nudge the server when a deadline passes so the page updates without
  // waiting for the once-a-minute cron. Idempotent; signed-in viewers only.
  const sync = useCallback(
    (delayMs: number) => {
      if (!isSignedIn) return
      setTimeout(() => void callAction('syncBattle', { battleId: id }), delayMs)
    },
    [id, isSignedIn],
  )

  if (!ready && !state) {
    return <div className="mx-auto h-64 max-w-2xl animate-pulse px-4 py-6" aria-busy="true" />
  }
  if (!state) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <EmptyState icon={<X className="size-8 text-muted-foreground" />} title="Battle not found" description="It may have been removed, or the link is wrong." />
      </div>
    )
  }

  const mySide = userId ? sideOf(state, userId) : null
  const totals = new Map(roundsQ.records.map((r) => [r.data.number, r.data.totalVotes ?? 0]))
  const subs = new Map(subsQ.records.map((r) => [`${r.data.round}_${r.data.side}`, r.data]))
  const canWrite = ready && !!isSignedIn

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 pb-20" data-testid="battle-page">
      <MatchHeader state={state} viewerId={userId} />

      {state.status === 'invited' && (
        <InvitePanel battleId={id} state={state} mySide={mySide} canWrite={canWrite} />
      )}
      {state.status === 'declined' && (
        <Panel className="p-5 text-center text-muted-foreground">
          <PlayerTag userId={state.playerB} side="b" /> declined this challenge.
        </Panel>
      )}
      {state.status === 'complete' && state.result && <ResultPanel state={state} />}

      {state.status !== 'declined' &&
        roundDisplayOrder(state).map(({ round, collapsible }) => (
          <RoundPanel
            key={round.number}
            battleId={id}
            state={state}
            round={round}
            collapsible={collapsible}
            mySide={mySide}
            totalVotes={totals.get(round.number) ?? 0}
            subA={subs.get(`${round.number}_a`)}
            subB={subs.get(`${round.number}_b`)}
            canWrite={canWrite}
            signedIn={!!isSignedIn}
            onDeadline={sync}
          />
        ))}
    </div>
  )
}

// ─── Header ─────────────────────────────────────────────────────────────────

function MatchHeader({ state, viewerId }: { state: BattleState; viewerId: string | null }) {
  const score = state.result ? state.result.total : runningScore(state)
  const mode = getMode(state.modeId)
  const live = currentRoundState(state)?.phase === 'vote'
  return (
    <header className="bg-arena overflow-hidden rounded-2xl border border-border p-5" data-testid="match-header">
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={cn('flex items-center gap-1.5', live && 'text-destructive')} data-testid="battle-status">
          {live && <LiveDot />}
          {statusLabel(state, viewerId)}
        </span>
        <span>{mode?.label ?? state.modeId}</span>
      </div>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Corner userId={state.playerA} side="a" winner={state.result?.winner === 'a'} />
        <div className="font-display text-center text-5xl font-extrabold italic leading-none tabular-nums" data-testid="battle-score">
          {state.status === 'invited' || state.status === 'declined' ? (
            <span className="text-muted-foreground">VS</span>
          ) : (
            <>
              <span className="text-side-a">{score.a}</span>
              <span className="mx-1.5 text-muted-foreground">:</span>
              <span className="text-side-b">{score.b}</span>
            </>
          )}
        </div>
        <Corner userId={state.playerB} side="b" winner={state.result?.winner === 'b'} align="right" />
      </div>
    </header>
  )
}

function Corner({ userId, side, winner, align }: { userId: string; side: Side; winner: boolean; align?: 'right' }) {
  return (
    <div className={cn('min-w-0', align === 'right' && 'text-right')}>
      <p className={cn('text-[10px] font-bold uppercase tracking-[0.25em]', sideText[side])}>{side === 'a' ? 'Challenger' : 'Opponent'}</p>
      <PlayerTag userId={userId} side={side} className="block text-lg" />
      {winner && (
        <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold uppercase text-primary">
          <Trophy className="size-3.5" aria-hidden /> Winner
        </span>
      )}
    </div>
  )
}

// ─── Invite ─────────────────────────────────────────────────────────────────

function InvitePanel({ battleId, state, mySide, canWrite }: { battleId: string; state: BattleState; mySide: Side | null; canWrite: boolean }) {
  const toast = useToast()
  const [skill, setSkill] = useState('')
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (mySide !== 'b') {
    return (
      <Panel className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
        <Clock className="size-5 shrink-0" aria-hidden />
        <span>
          Waiting for <PlayerTag userId={state.playerB} side="b" /> to accept. Round 1:{' '}
          <span className="font-semibold text-foreground">{state.rounds[0].skill}</span>
        </span>
      </Panel>
    )
  }

  async function accept(e: FormEvent) {
    e.preventDefault()
    if (!skill.trim()) return setError('Name the round 2 skill to accept.')
    setBusy('accept')
    setError(null)
    const r = await callAction('acceptChallenge', { battleId, round2Skill: skill.trim() })
    setBusy(null)
    if (!r.success) return setError(r.error)
    toast.success('Challenge accepted', 'Round 1 is live. Film your attempt.')
  }

  async function decline() {
    setBusy('decline')
    setError(null)
    const r = await callAction('declineChallenge', { battleId })
    setBusy(null)
    if (!r.success) setError(r.error)
  }

  return (
    <Panel className="border-primary/60 p-5" >
      <form onSubmit={accept} data-testid="invite-panel" className="space-y-4">
        <div>
          <p className="font-display text-2xl font-extrabold uppercase italic">You've been challenged</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Round 1 skill: <span className="font-semibold text-foreground">{state.rounds[0].skill}</span>. Accept by picking round 2's skill.
          </p>
        </div>
        <Input
          aria-label="Round 2 skill"
          placeholder="Round 2 skill (your pick)"
          value={skill}
          maxLength={60}
          onChange={(e) => setSkill(e.target.value)}
          className="h-12 bg-background"
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Button type="button" variant="outline" size="lg" onClick={decline} loading={busy === 'decline'} disabled={!canWrite || busy !== null} data-testid="decline-challenge">
            Decline
          </Button>
          <Button type="submit" size="lg" className="font-semibold" loading={busy === 'accept'} disabled={!canWrite || busy !== null} data-testid="accept-challenge">
            Accept
          </Button>
        </div>
      </form>
    </Panel>
  )
}

// ─── Rounds ─────────────────────────────────────────────────────────────────

const phaseBadge: Record<RoundState['phase'], string> = {
  pending: 'Locked',
  submit: 'Filming',
  vote: 'Voting',
  closed: 'Final',
}

function RoundPanel({
  battleId,
  state,
  round,
  collapsible,
  mySide,
  totalVotes,
  subA,
  subB,
  canWrite,
  signedIn,
  onDeadline,
}: {
  battleId: string
  state: BattleState
  round: RoundState
  /** Past round: starts collapsed to a one-line result (D46). */
  collapsible: boolean
  mySide: Side | null
  totalVotes: number
  subA?: SubmissionData
  subB?: SubmissionData
  canWrite: boolean
  signedIn: boolean
  onDeadline: (delayMs: number) => void
}) {
  const isCurrent = state.currentRound === round.number && state.status === 'active'
  const skillLine =
    round.number === 3 ? 'Freestyle: each player picks their own skill' : round.skill ?? 'Picked when the challenge is accepted'

  const header = (
        <div className={cn('flex items-start justify-between gap-3 px-5 py-4', !collapsible && 'border-b border-border')}>
          <div className="min-w-0">
            <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-muted-foreground">Round {round.number}</p>
            <p className="mt-0.5 font-semibold">{skillLine}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider',
                round.phase === 'vote' ? 'bg-destructive/15 text-destructive' : round.phase === 'submit' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
              )}
              data-testid={`round-${round.number}-phase`}
            >
              {phaseBadge[round.phase]}
            </span>
            {round.phase === 'submit' && round.submitDeadline && (
              <Countdown at={round.submitDeadline} label="Time left to film" onExpire={() => onDeadline(1500)} />
            )}
            {round.phase === 'vote' && round.voteDeadline && (
              <Countdown at={round.voteDeadline} label="Voting closes in" onExpire={() => onDeadline(3500)} />
            )}
            {collapsible && (
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            )}
          </div>
        </div>
  )

  const body = (
        <div className="p-5">
          {round.phase === 'pending' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="size-4" aria-hidden /> Unlocks when round {round.number - 1} ends.
            </p>
          )}
          {round.phase === 'submit' && (
            <SubmitPhase battleId={battleId} state={state} round={round} mySide={mySide} mySub={mySide === 'a' ? subA : mySide === 'b' ? subB : undefined} canWrite={canWrite} />
          )}
          {(round.phase === 'vote' || round.phase === 'closed') && (
            <RevealedRound
              battleId={battleId}
              state={state}
              round={round}
              mySide={mySide}
              totalVotes={totalVotes}
              subA={subA}
              subB={subB}
              canWrite={canWrite}
              signedIn={signedIn}
            />
          )}
        </div>
  )

  return (
    <Panel className={cn('overflow-hidden', isCurrent && 'border-primary/50')}>
      <section data-testid={`round-${round.number}`} aria-label={`Round ${round.number}`}>
        {collapsible ? (
          <details className="group">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden" data-testid={`round-${round.number}-toggle`}>
              {header}
              <RoundSummary state={state} round={round} />
            </summary>
            <div className="border-t border-border">{body}</div>
          </details>
        ) : (
          <>
            {header}
            {body}
          </>
        )}
      </section>
    </Panel>
  )
}

/** One-line result for a collapsed past round: each player's votes and points. */
function RoundSummary({ state, round }: { state: BattleState; round: RoundState }) {
  const o = round.outcome
  if (!o) return null
  const pts = roundPoints(o)
  const players = { a: state.playerA, b: state.playerB }
  return (
    <div className="grid grid-cols-2 gap-3 px-5 pb-4 text-sm" data-testid={`round-${round.number}-summary`}>
      {(['a', 'b'] as const).map((side) => {
        const won = o.kind !== 'both_missed' && o.winner === side
        const detail =
          o.kind === 'votes'
            ? `${side === 'a' ? o.votesA : o.votesB} ${(side === 'a' ? o.votesA : o.votesB) === 1 ? 'vote' : 'votes'}`
            : o.kind === 'forfeit'
              ? won ? 'won by forfeit' : 'missed'
              : 'missed'
        return (
          <div key={side} className={cn('rounded-lg border-l-4 bg-background px-3 py-1.5', sideBorder[side])}>
            <PlayerTag userId={players[side]} side={side} link={false} className="block text-sm" />
            <p className="text-xs text-muted-foreground">
              {won && <Trophy className="mr-1 inline size-3 text-primary" aria-label="Round winner" />}
              {detail} · <span className={cn('font-semibold', sideText[side])}>+{pts[side]} pts</span>
            </p>
          </div>
        )
      })}
    </div>
  )
}

function SubmitPhase({
  battleId,
  state,
  round,
  mySide,
  mySub,
  canWrite,
}: {
  battleId: string
  state: BattleState
  round: RoundState
  mySide: Side | null
  mySub?: SubmissionData
  canWrite: boolean
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {(['a', 'b'] as const).map((side) => (
          <div key={side} className={cn('rounded-xl border-l-4 bg-background px-3 py-2', sideBorder[side])}>
            <PlayerTag userId={side === 'a' ? state.playerA : state.playerB} side={side} className="block text-sm" />
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground" data-testid={`round-${round.number}-${side}-status`}>
              {round.submitted[side] ? (
                <>
                  <Check className="size-3.5 text-primary" aria-hidden /> Filmed
                </>
              ) : (
                'Not yet'
              )}
            </p>
          </div>
        ))}
      </div>

      {mySide && !round.submitted[mySide] && (
        <VideoUploader battleId={battleId} round={round.number} needsSkill={round.number === 3} disabled={!canWrite} />
      )}
      {mySide && round.submitted[mySide] && (
        <div className="space-y-3" data-testid="submitted-hidden">
          <p className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary">
            <EyeOff className="size-4 shrink-0" aria-hidden /> Submitted. Hidden from everyone until the round ends.
          </p>
          {mySub && <VideoPlayer fileKey={mySub.fileKey} label="Your submitted attempt" />}
        </div>
      )}
      {!mySide && (
        <p className="text-sm text-muted-foreground">Both players are filming. Videos drop when the round's window ends, then voting opens.</p>
      )}
    </div>
  )
}

function RevealedRound({
  battleId,
  state,
  round,
  mySide,
  totalVotes,
  subA,
  subB,
  canWrite,
  signedIn,
}: {
  battleId: string
  state: BattleState
  round: RoundState
  mySide: Side | null
  totalVotes: number
  subA?: SubmissionData
  subB?: SubmissionData
  canWrite: boolean
  signedIn: boolean
}) {
  const toast = useToast()
  const { nameOf } = useUsernames()
  const [myVote, setMyVote] = useState<Side | null>(null)
  const [busy, setBusy] = useState<Side | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const voting = round.phase === 'vote'
  const outcome = round.outcome
  const canVote = voting && signedIn && !mySide && !myVote

  // Has this viewer already voted? (votes are owner-read-only; ask the server.)
  useEffect(() => {
    if (!signedIn || mySide) return
    let cancelled = false
    void callAction<{ side: Side | null }>('myVote', { battleId, round: round.number }).then((r) => {
      if (!cancelled && r.success && r.data.side) setMyVote(r.data.side)
    })
    return () => {
      cancelled = true
    }
  }, [battleId, round.number, signedIn, mySide])

  async function vote(side: Side) {
    setBusy(side)
    const r = await callAction<{ totalVotes: number }>('castVote', { battleId, round: round.number, side })
    setBusy(null)
    if (r.success) {
      setMyVote(side)
      toast.success('Vote locked in')
    } else {
      if (r.code === 'already_voted') setMyVote(side)
      toast.error("Vote didn't count", r.error)
    }
  }

  const points = outcome ? roundPoints(outcome) : null
  const players = useMemo(() => ({ a: state.playerA, b: state.playerB }), [state.playerA, state.playerB])

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {(['a', 'b'] as const).map((side) => {
          const sub = side === 'a' ? subA : subB
          const submitted = round.submitted[side]
          const won = outcome && outcome.kind !== 'both_missed' && outcome.winner === side
          return (
            <div key={side} className={cn('rounded-xl border-t-4 bg-background p-3', sideBorder[side])} data-testid={`round-${round.number}-${side}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <PlayerTag userId={players[side]} side={side} className="text-sm" />
                {won && <Trophy className="size-4 text-primary" aria-label="Round winner" />}
              </div>
              {round.number === 3 && sub?.skill && <p className="mb-2 text-sm font-medium">{sub.skill}</p>}
              {submitted && sub?.fileKey ? (
                <VideoPlayer fileKey={sub.fileKey} label={`@${nameOf(players[side]) ?? 'player'}'s attempt`} />
              ) : submitted ? (
                <div className="flex aspect-[9/16] max-h-[60vh] items-center justify-center rounded-xl bg-black/40 text-sm text-muted-foreground">Loading video…</div>
              ) : (
                <div className="flex aspect-[9/16] max-h-[30vh] items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                  Missed the deadline
                </div>
              )}
              {outcome?.kind === 'votes' && (
                <p className="mt-2 text-sm">
                  <span className="font-display text-2xl font-extrabold tabular-nums">{side === 'a' ? outcome.votesA : outcome.votesB}</span>{' '}
                  <span className="text-muted-foreground">votes</span>
                  {points && <span className={cn('ml-2 font-semibold', sideText[side])}>+{points[side]} pts</span>}
                </p>
              )}
              {outcome && outcome.kind !== 'votes' && points && (
                <p className={cn('mt-2 text-sm font-semibold', sideText[side])}>+{points[side]} pts</p>
              )}
              {voting && canVote && (
                <Button
                  className="mt-3 w-full font-semibold"
                  onClick={() => vote(side)}
                  loading={busy === side}
                  disabled={!canWrite || busy !== null}
                  data-testid={`vote-${side}`}
                >
                  <Vote className="size-4" aria-hidden /> Vote @{nameOf(players[side]) ?? side.toUpperCase()}
                </Button>
              )}
              {voting && myVote === side && (
                <p className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-primary/10 py-2 text-sm font-semibold text-primary" data-testid="my-vote">
                  <Check className="size-4" aria-hidden /> Your vote
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground" data-testid={`round-${round.number}-total-votes`}>
          <span className="font-display text-lg font-bold text-foreground tabular-nums">{totalVotes}</span> {totalVotes === 1 ? 'vote' : 'votes'}
          {voting && ' so far · results hidden until voting closes'}
        </span>
        {voting && mySide && <span className="text-muted-foreground">Players can't vote in their own battle.</span>}
        {voting && !signedIn && (
          <Button variant="outline" size="sm" onClick={() => setShowAuth(true)}>
            Sign in to vote
          </Button>
        )}
      </div>
      {outcome && <OutcomeLine round={round} players={players} />}
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </div>
  )
}

function OutcomeLine({ round, players }: { round: RoundState; players: Record<Side, string> }) {
  const o = round.outcome!
  let text: React.ReactNode
  if (o.kind === 'both_missed') text = 'Both players missed the deadline. No points.'
  else if (o.kind === 'forfeit')
    text = (
      <>
        <PlayerTag userId={players[o.winner]} side={o.winner} /> wins by forfeit (opponent didn't submit).
      </>
    )
  else if (o.winner === 'tie') text = o.votesA + o.votesB === 0 ? 'No votes: tie, +5 each.' : 'Tied on votes: +5 each.'
  else
    text = (
      <>
        <PlayerTag userId={players[o.winner]} side={o.winner} /> takes the round.
      </>
    )
  return <p className="rounded-lg bg-secondary px-3 py-2 text-sm" data-testid={`round-${round.number}-outcome`}>{text}</p>
}

// ─── Result ─────────────────────────────────────────────────────────────────

function ResultPanel({ state }: { state: BattleState }) {
  const r = state.result!
  const players = { a: state.playerA, b: state.playerB }
  return (
    <Panel className="border-primary/60 p-5">
      <section data-testid="battle-result" aria-label="Battle result">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary">Final</p>
        <p className="font-display mt-1 text-3xl font-extrabold uppercase italic">
          {r.winner === 'draw' ? (
            'Draw'
          ) : (
            <>
              <PlayerTag userId={players[r.winner]} side={r.winner} link={false} /> wins
            </>
          )}
        </p>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="py-1 font-semibold">Player</th>
              <th className="py-1 text-right font-semibold">Rounds won</th>
              <th className="py-1 text-right font-semibold">Round pts</th>
              <th className="py-1 text-right font-semibold">Bonus</th>
              <th className="py-1 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {(['a', 'b'] as const).map((s) => (
              <tr key={s} className="border-t border-border">
                <td className="py-2">
                  <PlayerTag userId={players[s]} side={s} />
                </td>
                <td className="py-2 text-right tabular-nums">{r.roundWins[s]}</td>
                <td className="py-2 text-right tabular-nums">{r.roundPoints[s]}</td>
                <td className="py-2 text-right tabular-nums">+{r.bonus[s]}</td>
                <td className="font-display py-2 text-right text-lg font-extrabold tabular-nums">{r.total[s]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Link to="/home" className="mt-4 inline-block text-sm text-muted-foreground hover:text-foreground hover:underline">
          Back to battles
        </Link>
      </section>
    </Panel>
  )
}
