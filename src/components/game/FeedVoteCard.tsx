/**
 * "Voting now" feed card, reels-style (D57): the battle header (tap → battle
 * page), then the round's two videos one at a time in a horizontal
 * scroll-snap track. Swipe on touch, or use the side arrows; "1/2" shows where
 * you are. Each video has a "Vote for this" button that calls the same
 * `castVote` action as the battle page, with the same rules.
 *
 * Performance: a video gets its `src` only once its slide has been on screen
 * (card in view and slide current), and only that one plays. Videos are
 * inline, muted, looped, never fullscreen; tap the video to pause, the
 * speaker button to unmute.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthOverlay, useQuery, useR2Files } from 'deepspace'
import { Check, ChevronLeft, ChevronRight, Vote, Volume2, VolumeX } from 'lucide-react'
import { Button, cn, useToast } from '@/components/ui'
import { currentRoundState, sideOf, type BattleState, type Side } from '../../battle/machine'
import type { SubmissionData } from '../../battle/view'
import { callAction } from '../../lib/api'
import { BattleCard } from './BattleCard'
import { sideText } from './bits'
import { fullFileKey } from './VideoUploader'
import { useUsernames } from './usernames'

const SIDES: Side[] = ['a', 'b']

function useInView<T extends Element>(threshold = 0.5) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return setInView(true)
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

export function FeedVoteCard({ battleId, state, viewerId }: { battleId: string; state: BattleState; viewerId: string | null }) {
  const round = currentRoundState(state)
  if (!round || round.phase !== 'vote') return <BattleCard battleId={battleId} state={state} viewerId={viewerId} />
  return <Reel battleId={battleId} state={state} roundNumber={round.number} viewerId={viewerId} />
}

function Reel({ battleId, state, roundNumber, viewerId }: { battleId: string; state: BattleState; roundNumber: number; viewerId: string | null }) {
  const toast = useToast()
  const { nameOf } = useUsernames()
  const [cardRef, inView] = useInView<HTMLElement>(0.5)
  const trackRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [loaded, setLoaded] = useState<Record<Side, boolean>>({ a: false, b: false })
  const [muted, setMuted] = useState(true)
  const [myVote, setMyVote] = useState<Side | null>(null)
  const [busy, setBusy] = useState<Side | null>(null)
  const [showAuth, setShowAuth] = useState(false)

  const signedIn = !!viewerId
  const mySide = viewerId ? sideOf(state, viewerId) : null
  const players: Record<Side, string> = { a: state.playerA, b: state.playerB }
  const current = SIDES[index]

  const subsQ = useQuery<SubmissionData>('submissions', { where: { battleId }, limit: 6 })
  const subs: Partial<Record<Side, SubmissionData>> = {}
  for (const r of subsQ.records) {
    if (r.data.round === roundNumber && r.data.revealed === 'yes') subs[r.data.side] = r.data
  }

  // Load a video the first time its slide is on screen.
  useEffect(() => {
    if (inView && !loaded[current]) setLoaded((l) => ({ ...l, [current]: true }))
  }, [inView, current, loaded])

  // Has this viewer already voted this round? Asked once the card is seen.
  const asked = useRef(false)
  useEffect(() => {
    if (!inView || !signedIn || mySide || asked.current) return
    asked.current = true
    void callAction<{ side: Side | null }>('myVote', { battleId, round: roundNumber }).then((r) => {
      if (r.success && r.data.side) setMyVote(r.data.side)
    })
  }, [inView, signedIn, mySide, battleId, roundNumber])

  const go = useCallback((i: number) => {
    const t = trackRef.current
    const next = Math.max(0, Math.min(SIDES.length - 1, i))
    setIndex(next)
    t?.scrollTo({ left: next * t.clientWidth, behavior: 'smooth' })
  }, [])

  // Swipes move the track natively (scroll-snap); read the slide from the scroll position.
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  function onScroll() {
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => {
      const t = trackRef.current
      if (t && t.clientWidth) setIndex(Math.max(0, Math.min(SIDES.length - 1, Math.round(t.scrollLeft / t.clientWidth))))
    }, 80)
  }
  useEffect(() => () => clearTimeout(scrollTimer.current), [])

  async function vote(side: Side) {
    setBusy(side)
    const r = await callAction<{ totalVotes: number }>('castVote', { battleId, round: roundNumber, side })
    setBusy(null)
    if (r.success) {
      setMyVote(side)
      toast.success('Vote locked in')
    } else {
      if (r.code === 'already_voted') setMyVote(side)
      toast.error("Vote didn't count", r.error)
    }
  }

  const name = (side: Side) => nameOf(players[side]) ?? 'player'

  return (
    <article ref={cardRef} data-testid="feed-vote-card" data-battle-id={battleId} className="overflow-hidden rounded-2xl border border-border bg-card">
      <BattleCard battleId={battleId} state={state} viewerId={viewerId} className="rounded-none border-0 bg-transparent" />

      <div className="relative" role="group" aria-roledescription="carousel" aria-label={`Round ${roundNumber} videos`}>
        <div
          ref={trackRef}
          onScroll={onScroll}
          data-testid="reel-track"
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
        >
          {SIDES.map((side, i) => (
            <div
              key={side}
              data-testid={`reel-slide-${side}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${SIDES.length}: @${name(side)}'s video`}
              aria-hidden={i !== index}
              className="flex w-full shrink-0 snap-center flex-col items-center gap-2 px-4 pb-4"
            >
              <p data-testid="reel-label" className="w-full text-center text-sm font-semibold">
                <span className={sideText[side]}>@{name(side)}</span>'s video
              </p>
              {roundNumber === 3 && subs[side]?.skill && (
                <p data-testid={`reel-skill-${side}`} className="-mt-1 w-full truncate text-center text-xs text-muted-foreground">
                  {subs[side]!.skill}
                </p>
              )}
              <ReelVideo
                fileKey={subs[side]?.fileKey ?? null}
                load={loaded[side]}
                active={inView && i === index}
                muted={muted}
                onToggleMute={() => setMuted((m) => !m)}
                label={`@${name(side)}'s video`}
                testId={`reel-video-${side}`}
              />
              {mySide ? null : !signedIn ? (
                <Button size="lg" className="w-full max-w-xs font-semibold" onClick={() => setShowAuth(true)} tabIndex={i === index ? 0 : -1}>
                  Sign in to vote
                </Button>
              ) : (
                <Button
                  size="lg"
                  data-testid={`reel-vote-${side}`}
                  className="w-full max-w-xs font-semibold"
                  variant={myVote === side ? 'secondary' : 'default'}
                  disabled={!!myVote || busy !== null || !subs[side]}
                  tabIndex={i === index ? 0 : -1}
                  onClick={() => void vote(side)}
                >
                  {myVote === side ? (
                    <>
                      <Check className="size-4" aria-hidden /> You voted
                    </>
                  ) : (
                    <>
                      <Vote className="size-4" aria-hidden /> {busy === side ? 'Voting…' : 'Vote for this'}
                    </>
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          data-testid="reel-prev"
          aria-label="Previous video"
          disabled={index === 0}
          onClick={() => go(index - 1)}
          className="absolute left-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-background/80 text-foreground shadow transition-opacity disabled:pointer-events-none disabled:opacity-0"
        >
          <ChevronLeft className="size-6" aria-hidden />
        </button>
        <button
          type="button"
          data-testid="reel-next"
          aria-label="Next video"
          disabled={index === SIDES.length - 1}
          onClick={() => go(index + 1)}
          className="absolute right-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-background/80 text-foreground shadow transition-opacity disabled:pointer-events-none disabled:opacity-0"
        >
          <ChevronRight className="size-6" aria-hidden />
        </button>
        <span
          data-testid="reel-indicator"
          aria-live="polite"
          className="absolute right-3 top-0 rounded-full bg-background/80 px-2 py-0.5 text-xs font-semibold tabular-nums"
        >
          {index + 1}/{SIDES.length}
        </span>
      </div>

      {(mySide || myVote) && (
        <p className="border-t border-border px-4 py-3 text-center text-sm text-muted-foreground" data-testid={mySide ? 'reel-competitor' : 'reel-you-voted'}>
          {mySide
            ? "It's your battle, so you can't vote on it."
            : `You voted for @${name(myVote!)}. Vote counts show when voting closes.`}
        </p>
      )}
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </article>
  )
}

function ReelVideo({
  fileKey,
  load,
  active,
  muted,
  onToggleMute,
  label,
  testId,
}: {
  fileKey: string | null
  load: boolean
  active: boolean
  muted: boolean
  onToggleMute: () => void
  label: string
  testId: string
}) {
  const { getUrl } = useR2Files({ scope: 'app' })
  const ref = useRef<HTMLVideoElement>(null)
  const src = load && fileKey ? getUrl(fullFileKey(fileKey)) : undefined

  // React doesn't keep the `muted` property in sync; set it directly.
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted, src])

  // Only the slide on screen plays.
  useEffect(() => {
    const v = ref.current
    if (!v || !src) return
    if (active) void v.play().catch(() => {})
    else v.pause()
  }, [active, src])

  function togglePlay() {
    const v = ref.current
    if (!v || !src) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }

  return (
    <div className="relative aspect-[9/16] overflow-hidden rounded-xl bg-black" style={{ width: 'min(100%, calc(70vh * 9 / 16))' }}>
      <video
        ref={ref}
        data-testid={testId}
        src={src}
        preload={src ? 'metadata' : 'none'}
        muted
        loop
        playsInline
        disablePictureInPicture
        aria-label={label}
        onClick={togglePlay}
        className="size-full object-contain"
      />
      <button
        type="button"
        data-testid="reel-mute"
        onClick={onToggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={!muted}
        className={cn('absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white')}
      >
        {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
        {muted ? 'Tap to unmute' : 'Sound on'}
      </button>
    </div>
  )
}
