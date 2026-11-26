/**
 * "Voting now" feed card, Reels-style overlay (D57, D68): the round's two
 * videos one at a time in a horizontal scroll-snap track, each filling the
 * card. Overlays: a top gradient with "Round 1 · Voting · 18:07" and the skill
 * (tap → battle page), a mute icon, two dots, and per slide a bottom gradient
 * with the player chip and a "Vote" pill that calls the same `castVote` action
 * as the battle page, with the same rules.
 *
 * Moving: swipe on touch, or tap the left/right edge of the video (read from
 * the tap position, so swipes still start anywhere). Keyboard users get
 * visually hidden prev/next buttons.
 *
 * Fit: the video is object-contain (never cropped); behind it a tiny canvas
 * copy of the current frame, scaled to cover, blurred and darkened, fills the
 * empty space. A canvas, not a second <video>: one download, one decoder.
 *
 * Performance: a video gets its `src` only once its slide has been on screen
 * (card in view and slide current), and only that one plays.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthOverlay, useQuery, useR2Files } from 'deepspace'
import { Check, Volume2, VolumeX } from 'lucide-react'
import { cn, useToast } from '@/components/ui'
import { currentRoundState, sideOf, type BattleState, type Side } from '../../battle/machine'
import { activeDeadline, roundLabel, type SubmissionData } from '../../battle/view'
import { callAction } from '../../lib/api'
import { BattleCard } from './BattleCard'
import { Countdown, LiveDot, ModeBadge, sideText } from './bits'
import { fullFileKey } from './VideoUploader'
import { useUsernames } from './usernames'

const SIDES: Side[] = ['a', 'b']
/** Fraction of the slide width on each side that acts as a prev/next tap zone. */
const EDGE = 0.25

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
  const videoRefs = useRef<Partial<Record<Side, HTMLVideoElement | null>>>({})
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
  const round = currentRoundState(state)!
  const deadline = activeDeadline(state)?.at

  const subsQ = useQuery<SubmissionData>('submissions', { where: { battleId }, limit: 6 })
  const subs: Partial<Record<Side, SubmissionData>> = {}
  for (const r of subsQ.records) {
    if (r.data.round === roundNumber && r.data.revealed === 'yes') subs[r.data.side] = r.data
  }
  // Round 3: each player's own skill, so it follows the slide on screen.
  const skill = roundNumber === 3 ? subs[current]?.skill || roundLabel(round) : roundLabel(round)

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
  // Settle the index as soon as a swipe ends, where supported.
  useEffect(() => {
    const t = trackRef.current
    if (!t) return
    const settle = () => {
      if (t.clientWidth) setIndex(Math.max(0, Math.min(SIDES.length - 1, Math.round(t.scrollLeft / t.clientWidth))))
    }
    t.addEventListener('scrollend', settle)
    return () => t.removeEventListener('scrollend', settle)
  }, [])

  // Invisible tap zones: left/right edge → prev/next, middle → pause/play.
  // A swipe never fires a click, so swipes still work from anywhere.
  function onSlideClick(e: React.MouseEvent<HTMLDivElement>, side: Side) {
    if ((e.target as Element).closest('button, a')) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    if (x < EDGE && index > 0) return go(index - 1)
    if (x > 1 - EDGE && index < SIDES.length - 1) return go(index + 1)
    const v = videoRefs.current[side]
    if (!v || !v.src) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }

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
  const pill = 'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-5 text-sm font-bold shadow-lg'

  return (
    // Fills its feed slot (one screen tall, D59). Everything is overlaid on
    // the videos, so nothing can push the vote button off screen.
    <article
      ref={cardRef}
      data-testid="feed-vote-card"
      data-battle-id={battleId}
      className="relative h-full overflow-hidden rounded-2xl border border-border bg-black text-white"
      role="group"
      aria-roledescription="carousel"
      aria-label={`Round ${roundNumber} videos: @${name('a')} vs @${name('b')}`}
    >
      {/* x mandatory + snap-always: one swipe lands exactly on the next video.
          overscroll-x-contain keeps horizontal swipes from leaking out; the
          browser locks each gesture to one axis, so vertical swipes on the
          video still scroll the feed. */}
      <div
        ref={trackRef}
        onScroll={onScroll}
        data-testid="reel-track"
        className="no-scrollbar flex h-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain"
      >
        {SIDES.map((side, i) => (
          <div
            key={side}
            data-testid={`reel-slide-${side}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${SIDES.length}: @${name(side)}'s video`}
            aria-hidden={i !== index}
            onClick={(e) => onSlideClick(e, side)}
            className="relative h-full w-full shrink-0 snap-center snap-always overflow-hidden"
          >
            <ReelVideo
              videoRef={(el) => {
                videoRefs.current[side] = el
              }}
              fileKey={subs[side]?.fileKey ?? null}
              load={loaded[side]}
              active={inView && i === index}
              muted={muted}
              label={`@${name(side)}'s video`}
              testId={`reel-video-${side}`}
            />

            {/* Bottom: player chip + Vote pill on one row, over a gradient. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/90 via-black/55 to-transparent px-3 pb-3 pt-12">
              <div className="pointer-events-auto flex items-center justify-between gap-2" data-testid={`reel-bottom-${side}`}>
                <span
                  data-testid="reel-chip"
                  className={cn('min-w-0 truncate rounded-full bg-black/55 px-3 py-1.5 text-sm font-bold backdrop-blur-sm', sideText[side])}
                >
                  @{name(side)}
                </span>
                {mySide ? (
                  <span data-testid="reel-competitor" className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white">
                    Your battle
                  </span>
                ) : !signedIn ? (
                  <button type="button" className={cn(pill, 'bg-primary text-primary-foreground')} onClick={() => setShowAuth(true)} tabIndex={i === index ? 0 : -1}>
                    Sign in to vote
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`reel-vote-${side}`}
                    className={cn(
                      pill,
                      'max-w-[65%] disabled:cursor-default',
                      myVote ? 'bg-white/20 text-white backdrop-blur-sm' : 'bg-primary text-primary-foreground disabled:opacity-60',
                    )}
                    disabled={!!myVote || busy !== null || !subs[side]}
                    tabIndex={i === index ? 0 : -1}
                    onClick={() => void vote(side)}
                  >
                    {myVote ? (
                      <>
                        <Check className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">Voted @{name(myVote)}</span>
                      </>
                    ) : busy === side ? (
                      'Voting…'
                    ) : (
                      'Vote'
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Top: round, phase, countdown, badge; skill below. Tap → battle page. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-1 bg-linear-to-b from-black/85 via-black/50 to-transparent pb-8 pl-3 pr-1 pt-1">
        <Link
          to={`/battle/${battleId}`}
          data-testid="reel-header"
          className="pointer-events-auto flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1 [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/90">
            <LiveDot />
            <span className="shrink-0">Round {roundNumber}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 text-destructive">Voting</span>
            {deadline && (
              <>
                <span aria-hidden>·</span>
                <Countdown at={deadline} className="text-xs [&>svg]:hidden" label="Voting ends in" />
              </>
            )}
            <ModeBadge modeId={state.modeId} className="ml-1" />
          </span>
          <span data-testid="reel-skill" className="mt-0.5 truncate text-base font-bold leading-tight">
            {skill}
          </span>
        </Link>
        <button
          type="button"
          data-testid="reel-mute"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={!muted}
          className="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full text-white"
        >
          <span className="grid size-8 place-items-center rounded-full bg-black/50 backdrop-blur-sm">
            {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
          </span>
        </button>
      </div>

      {/* Two dots, just above the bottom row. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[68px] flex justify-center gap-1.5" data-testid="reel-dots" aria-hidden>
        {SIDES.map((s, i) => (
          <span key={s} className={cn('size-1.5 rounded-full transition-colors', i === index ? 'bg-white' : 'bg-white/40')} />
        ))}
      </div>
      <span data-testid="reel-indicator" aria-live="polite" className="sr-only">
        {index + 1} of {SIDES.length}
      </span>

      {/* Keyboard: visually hidden until focused. */}
      <button
        type="button"
        data-testid="reel-prev"
        aria-label="Previous video"
        disabled={index === 0}
        onClick={() => go(index - 1)}
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-2 focus-visible:top-1/2 focus-visible:rounded-full focus-visible:bg-black/70 focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm"
      >
        Previous
      </button>
      <button
        type="button"
        data-testid="reel-next"
        aria-label="Next video"
        disabled={index === SIDES.length - 1}
        onClick={() => go(index + 1)}
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:right-2 focus-visible:top-1/2 focus-visible:rounded-full focus-visible:bg-black/70 focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm"
      >
        Next
      </button>
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </article>
  )
}

function ReelVideo({
  videoRef,
  fileKey,
  load,
  active,
  muted,
  label,
  testId,
}: {
  videoRef: (el: HTMLVideoElement | null) => void
  fileKey: string | null
  load: boolean
  active: boolean
  muted: boolean
  label: string
  testId: string
}) {
  const { getUrl } = useR2Files({ scope: 'app' })
  const ref = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
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

  // Blurred backdrop: copy the current frame into a 36×64 canvas a few times a
  // second (timeupdate). Drawing never reads pixels back, so it works even if
  // the canvas is tainted.
  function drawFrame() {
    const v = ref.current
    const c = canvasRef.current
    if (!v || !c || v.readyState < 2) return
    try {
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
    } catch {
      /* leave the last frame */
    }
  }

  return (
    <div className="absolute inset-0" data-testid="reel-video-box">
      <canvas
        ref={canvasRef}
        width={36}
        height={64}
        aria-hidden
        className="absolute inset-0 size-full scale-125 object-cover blur-2xl brightness-50 saturate-150"
      />
      <video
        ref={(el) => {
          ref.current = el
          videoRef(el)
        }}
        data-testid={testId}
        src={src}
        preload={src ? 'metadata' : 'none'}
        muted
        loop
        playsInline
        disablePictureInPicture
        aria-label={label}
        onLoadedData={drawFrame}
        onSeeked={drawFrame}
        onTimeUpdate={drawFrame}
        className="relative size-full object-contain"
      />
    </div>
  )
}
