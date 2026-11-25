/**
 * Battle page: the match screen.
 *
 * Reads (all live via useQuery):
 *   battles     → the full BattleState (rounds, deadlines, results)
 *   rounds      → live total vote count per round (per-side counts stay hidden
 *                 until the state machine records the outcome at vote close)
 *   submissions → only rows the server lets this viewer read: their own, plus
 *                 every revealed one (DECISIONS D8/D26). Under the setter
 *                 rules (D53) the round 1/2 skill names and setter videos
 *                 live here too, so an unopened round's skill never reaches
 *                 anyone but its setter.
 * Writes go through server actions (accept, decline, submitVideo, castVote).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthOverlay, useAuth, useQuery } from 'deepspace'
import { Check, ChevronDown, Clock, EyeOff, Lock, Trophy, Vote, X } from 'lucide-react'
import { Button, EmptyState, Input, cn, useToast } from '@/components/ui'
import { currentRoundState, inviteDeadline, roundPoints, setterOf, sideOf, usesSetterRules, type BattleState, type RoundState, type Side } from '../../../battle/machine'
import { getMode } from '../../../battle/modes'
import { lockedRoundCopy, roundDisplayOrder, runningScore, statusLabel, type BattleRowData, type SubmissionData } from '../../../battle/view'
import { callAction } from '../../../lib/api'
import { Countdown, ExpiresIn, LiveDot, Panel, PlayerTag, sideBorder, sideText } from '../../../components/game/bits'
import { CancelChallenge } from '../../../components/game/CancelChallenge'
import { VideoPicker, VideoPlayer, VideoUploader, useVideoUpload, type PickedVideo } from '../../../components/game/VideoUploader'
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
        <InvitePanel battleId={id} state={state} mySide={mySide} mySetterSub={subs.get('1_a')} canWrite={canWrite} onExpire={() => sync(1500)} />
      )}
      {state.status === 'declined' && (
        <Panel className="p-5 text-center text-muted-foreground">
          <PlayerTag userId={state.playerB} side="b" /> declined this challenge.
        </Panel>
      )}
      {state.status === 'cancelled' && (
        <Panel className="p-5 text-center text-muted-foreground" data-testid="battle-cancelled">
          {mySide === 'a' ? 'You' : <PlayerTag userId={state.playerA} side="a" />} cancelled this challenge.
        </Panel>
      )}
      {state.status === 'expired' && (
        <Panel className="p-5 text-center text-muted-foreground" data-testid="battle-expired">
          This challenge expired: <PlayerTag userId={state.playerB} side="b" /> didn't answer in time.
        </Panel>
      )}
      {state.status === 'complete' && state.result && <ResultPanel state={state} />}

      {(state.status === 'invited' || state.status === 'active' || state.status === 'complete') &&
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
          {state.status !== 'active' && state.status !== 'complete' ? (
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

function InvitePanel({
  battleId,
  state,
  mySide,
  mySetterSub,
  canWrite,
  onExpire,
}: {
  battleId: string
  state: BattleState
  mySide: Side | null
  /** A's own hidden round 1 row (only A can read it before accept). */
  mySetterSub?: SubmissionData
  canWrite: boolean
  onExpire: () => void
}) {
  const toast = useToast()
  const { nameOf } = useUsernames()
  const [skill, setSkill] = useState('')
  const [video, setVideo] = useState<PickedVideo | null>(null)
  const { uploadVideo, progress, done } = useVideoUpload()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expiresAt = inviteDeadline(state)
  const legacy = !usesSetterRules(state)
  const modeLabel = getMode(state.modeId)?.label ?? state.modeId

  if (mySide !== 'b') {
    // The skill is shown only to its setter: legacy battles kept it in the
    // state; under the setter rules it comes from A's own hidden row.
    const ownSkill = mySide === 'a' ? (legacy ? state.rounds[0].skill : mySetterSub?.skill) : null
    return (
      <Panel className="space-y-4 p-5 text-sm text-muted-foreground" data-testid="invite-waiting">
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p>
              Waiting for <PlayerTag userId={state.playerB} side="b" /> to accept.
              {ownSkill && (
                <>
                  {' '}Your round 1 skill: <span className="font-semibold text-foreground" data-testid="own-round-1-skill">{ownSkill}</span>
                  {!legacy && ' (hidden from them until they accept)'}
                </>
              )}
            </p>
            <ExpiresIn at={expiresAt} onExpire={onExpire} className="text-xs" />
          </div>
        </div>
        {mySide === 'a' && !legacy && mySetterSub?.fileKey && (
          <VideoPlayer fileKey={mySetterSub.fileKey} label="Your round 1 skill video" />
        )}
        {mySide === 'a' && <CancelChallenge battleId={battleId} disabled={!canWrite} />}
      </Panel>
    )
  }

  async function accept(e: FormEvent) {
    e.preventDefault()
    if (!skill.trim()) return setError('Name the round 2 skill to accept.')
    if (!video) return setError('Record your round 2 skill to accept.')
    setBusy('accept')
    setError(null)
    const up = await uploadVideo(video)
    if (!up.ok) {
      setBusy(null)
      return setError(up.error)
    }
    const r = await callAction('acceptChallenge', { battleId, round2Skill: skill.trim(), ...up.video })
    done()
    setBusy(null)
    if (!r.success) return setError(r.error)
    toast.success('Challenge accepted', 'Round 1 is live. Watch their skill and match it.')
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
          <p className="font-display text-2xl font-extrabold uppercase italic" data-testid="invite-headline">
            @{nameOf(state.playerA) ?? 'someone'} challenged you
          </p>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="invite-copy">
            {modeLabel} mode. {legacy ? '' : "Accept by recording your round 2 skill. You'll see their skill when round 1 starts."}
          </p>
          <ExpiresIn at={expiresAt} onExpire={onExpire} className="mt-1 text-xs text-muted-foreground" />
        </div>
        {legacy ? (
          <p className="text-sm text-muted-foreground" data-testid="legacy-invite">
            This challenge was sent under the old rules and can't be accepted any more. Decline it and send a new one.
          </p>
        ) : (
          <>
            <div>
              <label htmlFor="round2-skill" className="mb-2 block text-sm font-semibold">
                You set round 2: name a skill
              </label>
              <Input
                id="round2-skill"
                aria-label="Round 2 skill"
                placeholder="Round 2 skill (your pick)"
                value={skill}
                maxLength={60}
                onChange={(e) => setSkill(e.target.value)}
                className="h-12 bg-background"
              />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Show them the skill: record it now</p>
              <p className="mb-2 text-sm text-muted-foreground">They have to match it in round 2. Hidden from them until round 2 opens.</p>
              <VideoPicker value={video} onChange={setVideo} disabled={busy !== null} progress={progress} />
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Button type="button" variant="outline" size="lg" onClick={decline} loading={busy === 'decline'} disabled={!canWrite || busy !== null} data-testid="decline-challenge">
            Decline
          </Button>
          <Button type="submit" size="lg" className="font-semibold" loading={busy === 'accept'} disabled={!canWrite || busy !== null || legacy} data-testid="accept-challenge">
            {progress !== null ? `Uploading ${progress}%` : 'Accept'}
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
  const setter = setterOf(state, round.number)
  const setterSub = setter === 'a' ? subA : setter === 'b' ? subB : undefined
  const { nameOf } = useUsernames()

  if (round.phase === 'pending') {
    // Locked rounds are one compact row so the live panel stays the focus (D55).
    const own = setter && mySide === setter ? setterSub : undefined
    const names = { a: nameOf(state.playerA) ?? 'challenger', b: nameOf(state.playerB) ?? 'opponent' }
    const copy = lockedRoundCopy(state, round.number, mySide, names, own?.skill)
    return (
      <Panel className="overflow-hidden">
        <section data-testid={`round-${round.number}`} aria-label={`Round ${round.number}, locked`}>
          <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="font-display shrink-0 text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">R{round.number}</span>
            <p className="min-w-0 flex-1 truncate text-muted-foreground" data-testid={`round-${round.number}-skill`} title={copy}>
              {copy}
            </p>
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Locked" data-testid={`round-${round.number}-phase`} />
          </div>
          {own?.fileKey && !(round.number === 1 && state.status === 'invited') && (
            <details className="group border-t border-border" data-testid={`round-${round.number}-own-setter`}>
              <summary className="cursor-pointer list-none px-4 py-2 text-xs font-semibold text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                Watch your skill video (hidden until this round opens)
              </summary>
              <div className="px-4 pb-4">
                <VideoPlayer fileKey={own.fileKey} label={`Your round ${round.number} skill video`} />
              </div>
            </details>
          )}
        </section>
      </Panel>
    )
  }
  // Before a round opens only its setter can read their own row, so this
  // shows the skill to the setter and "hidden" to everyone else (D53).
  const skillLine =
    round.number === 3
      ? 'Freestyle: each player picks their own skill'
      : round.skill ?? setterSub?.skill ?? 'Skill hidden'

  const header = (
        <div className={cn('flex items-start justify-between gap-3 px-5 py-4', !collapsible && 'border-b border-border')}>
          <div className="min-w-0">
            <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-muted-foreground">Round {round.number}</p>
            <p className="mt-0.5 break-words font-semibold" data-testid={`round-${round.number}-skill`}>{skillLine}</p>
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
          {round.phase === 'submit' && (
            <SubmitPhase
              battleId={battleId}
              state={state}
              round={round}
              mySide={mySide}
              mySub={mySide === 'a' ? subA : mySide === 'b' ? subB : undefined}
              setterSub={setterSub}
              canWrite={canWrite}
            />
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
            {/* No outline on tap/click; a ring like the Button's for keyboard focus only. */}
            <summary
              className="cursor-pointer list-none rounded-2xl outline-none [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
              data-testid={`round-${round.number}-toggle`}
            >
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
  setterSub,
  canWrite,
}: {
  battleId: string
  state: BattleState
  round: RoundState
  mySide: Side | null
  mySub?: SubmissionData
  /** v2 rounds 1–2: the setter's video, public once the round is open. */
  setterSub?: SubmissionData
  canWrite: boolean
}) {
  const { nameOf } = useUsernames()
  const setter = setterOf(state, round.number)
  const replicator: Side | null = setter ? (setter === 'a' ? 'b' : 'a') : null
  const replicatorName = replicator ? nameOf(replicator === 'a' ? state.playerA : state.playerB) ?? 'opponent' : ''

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

      {setter && setterSub?.fileKey && mySide !== setter && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="match-this">
          <p className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-primary">
            {mySide ? 'Match this' : 'The skill to match'}
          </p>
          <VideoPlayer fileKey={setterSub.fileKey} label="Match this" />
        </div>
      )}

      {mySide && !round.submitted[mySide] && (
        <VideoUploader
          battleId={battleId}
          round={round.number}
          needsSkill={round.number === 3}
          disabled={!canWrite}
          hint={setter ? 'As soon as you submit, both videos go up and voting opens.' : undefined}
        />
      )}
      {setter && mySide === setter && (
        <div className="space-y-3" data-testid="setter-waiting">
          <p className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary">
            <Clock className="size-4 shrink-0" aria-hidden /> You set this skill. Waiting for @{replicatorName} to match it.
          </p>
          {mySub && <VideoPlayer fileKey={mySub.fileKey} label="Your skill video" />}
        </div>
      )}
      {!setter && mySide && round.submitted[mySide] && (
        <div className="space-y-3" data-testid="submitted-hidden">
          <p className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary">
            <EyeOff className="size-4 shrink-0" aria-hidden /> Submitted. Hidden from everyone until the round ends.
          </p>
          {mySub && <VideoPlayer fileKey={mySub.fileKey} label="Your submitted attempt" />}
        </div>
      )}
      {!mySide && (
        <p className="text-sm text-muted-foreground">
          {setter
            ? `Waiting for @${replicatorName} to match it. Voting opens as soon as they submit.`
            : "Both players are filming. Videos drop when the round's window ends, then voting opens."}
        </p>
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

  const players = useMemo(() => ({ a: state.playerA, b: state.playerB }), [state.playerA, state.playerB])
  // A closed round is always shown collapsed under its summary chips (D46),
  // which already carry each player's result, votes and points. Expanded, it
  // adds only what's new: the videos and round 3's skill names (D52).
  const filmed = (['a', 'b'] as const).filter((s) => round.submitted[s])
  const missed = (['a', 'b'] as const).filter((s) => !round.submitted[s])

  if (filmed.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground" data-testid={`round-${round.number}-both-missed`}>
        Both players missed the deadline. No points awarded.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className={cn('grid min-w-0 grid-cols-1 gap-4', filmed.length === 2 && 'sm:grid-cols-2')}>
        {filmed.map((side) => {
          const sub = side === 'a' ? subA : subB
          return (
            <div key={side} className={cn('min-w-0 rounded-xl border-t-4 bg-background p-3', sideBorder[side])} data-testid={`round-${round.number}-${side}`}>
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <PlayerTag userId={players[side]} side={side} className="min-w-0 text-sm" />
              </div>
              {round.number === 3 && sub?.skill && <p className="mb-2 break-words text-sm font-medium">{sub.skill}</p>}
              {sub?.fileKey ? (
                <VideoPlayer fileKey={sub.fileKey} label={`@${nameOf(players[side]) ?? 'player'}'s attempt`} />
              ) : (
                <div className="flex aspect-[9/16] max-h-[60vh] w-full items-center justify-center rounded-xl bg-black/40 text-sm text-muted-foreground">Loading video…</div>
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

      {missed.map((side) => (
        <p
          key={side}
          className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-sm text-muted-foreground"
          data-testid={`round-${round.number}-${side}-missed`}
        >
          <PlayerTag userId={players[side]} side={side} className="max-w-full" />
          <span aria-hidden>·</span> Missed the deadline <span aria-hidden>·</span>
          <span className={cn('font-semibold', sideText[side])}>+{outcome ? roundPoints(outcome)[side] : 0} pts</span>
        </p>
      ))}

      {voting && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground" data-testid={`round-${round.number}-total-votes`}>
            <span className="font-display text-lg font-bold text-foreground tabular-nums">{totalVotes}</span> {totalVotes === 1 ? 'vote' : 'votes'}
            {' so far · results hidden until voting closes'}
          </span>
          {mySide && <span className="text-muted-foreground">Players can't vote in their own battle.</span>}
          {!signedIn && (
            <Button variant="outline" size="sm" onClick={() => setShowAuth(true)}>
              Sign in to vote
            </Button>
          )}
        </div>
      )}
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </div>
  )
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
