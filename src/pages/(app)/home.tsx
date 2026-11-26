/**
 * Home feed: "Voting now" for everyone, plus "My battles" grouped by what the
 * signed-in player needs to do (invites, your turn, in progress, sent). Finished
 * battles never appear here: they live on the profile's Past battles (D71).
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useNavigationType } from 'react-router-dom'
import { AuthOverlay, useAuth, useQuery } from 'deepspace'
import { ChevronDown, Flame, HelpCircle, Swords, Trophy, Zap } from 'lucide-react'
import { Button, EmptyState, buttonVariants, cn } from '@/components/ui'
import type { BattleRowData, MyBucket } from '../../battle/view'
import { bucketFor, sortVotingNow } from '../../battle/view'
import type { PlayerStats } from '../../battle/stats'
import { BattleCard } from '../../components/game/BattleCard'
import { resetScroll } from '../../components/ScrollManager'
import { FeedVoteCard } from '../../components/game/FeedVoteCard'
import { CancelChallenge } from '../../components/game/CancelChallenge'
import { SectionTitle } from '../../components/game/bits'
import { useMyUsername } from '../../components/game/usernames'
import { EnergyBar, useEnergy } from '../../components/game/energy'

const GROUPS: Array<{ bucket: MyBucket; title: string }> = [
  { bucket: 'invite', title: 'Challenges for you' },
  { bucket: 'my_turn', title: 'Your turn' },
  { bucket: 'in_progress', title: 'In progress' },
  { bucket: 'sent', title: 'Sent challenges' },
]

export default function HomePage() {
  const { isSignedIn, userId } = useAuth()
  // Home always opens at the top, except on back/forward (ScrollManager restores those).
  const navType = useNavigationType()
  useEffect(() => {
    if (navType !== 'POP') resetScroll()
  }, [navType])
  return (
    // No bottom padding: the "Voting now" list is last and exactly one screen
    // tall, so scrolling to the end lines it up with the screen.
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 pt-6">
      {isSignedIn && userId ? <SignedInHeader /> : <SignedOutHero />}
      {isSignedIn && userId && <MyBattles userId={userId} />}
      <VotingNow viewerId={userId} />
    </div>
  )
}

function SignedInHeader() {
  const { username } = useMyUsername()
  const energy = useEnergy()
  const outOfEnergy = energy.ready && energy.energy < 1
  // Tighter type and spacing than before so the energy bar fits without the
  // banner growing (D66; checked at 375px in the browser spec).
  return (
    <section className="bg-arena overflow-hidden rounded-2xl border border-border p-4" data-testid="home-hero">
      {/* How to play shares the username line so the hero doesn't grow (D66, D69). */}
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          {username ? `@${username}` : 'Player'}
        </p>
        <Link
          to="/how-to-play"
          data-testid="hero-how-to-play"
          className="shrink-0 text-xs font-semibold text-foreground underline underline-offset-2 hover:text-primary"
        >
          How to play
        </Link>
      </div>
      <h1 className="font-display mt-1 text-4xl font-extrabold uppercase italic leading-none">Ready to clash?</h1>
      <p className="mt-1 text-xs leading-4 text-muted-foreground">Three rounds. Twenty-second clips. The crowd decides.</p>
      <EnergyBar view={energy} className="mt-3" />
      {outOfEnergy ? (
        <Button size="lg" disabled className="mt-3 font-semibold" data-testid="new-challenge">
          <Zap className="size-4" aria-hidden /> Next energy in {energy.refillIn}
        </Button>
      ) : (
        <Link to="/challenge" className={cn(buttonVariants({ size: 'lg' }), 'mt-3 font-semibold')} data-testid="new-challenge">
          <Swords className="size-4" aria-hidden /> New challenge
        </Link>
      )}
    </section>
  )
}

function SignedOutHero() {
  const [showAuth, setShowAuth] = useState(false)
  return (
    <section className="bg-arena overflow-hidden rounded-2xl border border-border p-6">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">SkillClash</p>
      <h1 className="font-display mt-1 text-5xl font-extrabold uppercase italic leading-[0.9]">
        Film it.
        <br />
        Clash it.
        <br />
        Win the crowd.
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Challenge anyone to a 3-round skill battle. Both of you film an attempt, then everyone votes.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button size="lg" className="font-semibold" onClick={() => setShowAuth(true)}>
          Sign in or sign up to battle
        </Button>
        <Link to="/how-to-play" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), 'font-semibold')} data-testid="hero-how-to-play">
          <HelpCircle className="size-4" aria-hidden /> How to play
        </Link>
      </div>
      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </section>
  )
}

function MyBattles({ userId }: { userId: string }) {
  const navigate = useNavigate()
  // Two queries: client `where` is equality-only, so "A or B" needs one per side.
  const asA = useQuery<BattleRowData>('battles', { where: { playerA: userId }, orderBy: 'createdAt', orderDir: 'desc', limit: 50 })
  const asB = useQuery<BattleRowData>('battles', { where: { playerB: userId }, orderBy: 'createdAt', orderDir: 'desc', limit: 50 })
  const loading = asA.status !== 'ready' || asB.status !== 'ready'

  const grouped = useMemo(() => {
    const map = new Map<MyBucket, Array<{ id: string; row: BattleRowData }>>()
    const seen = new Set<string>()
    for (const r of [...asA.records, ...asB.records]) {
      if (seen.has(r.recordId)) continue
      seen.add(r.recordId)
      const bucket = bucketFor(r.data.state, userId)
      if (!bucket) continue
      const list = map.get(bucket) ?? []
      list.push({ id: r.recordId, row: r.data })
      map.set(bucket, list)
    }
    for (const list of map.values()) list.sort((x, y) => y.row.state.createdAt - x.row.state.createdAt)
    return map
  }, [asA.records, asB.records, userId])

  // Finished battles are profile-only (D71); they only change the empty-state title.
  const finished = grouped.get('finished')?.length ?? 0
  const total = [...grouped.entries()].reduce((n, [b, l]) => (b === 'finished' ? n : n + l.length), 0)

  return (
    <section data-testid="my-battles" className="space-y-6">
      {loading && total === 0 ? (
        <SkeletonList />
      ) : total === 0 ? (
        <EmptyState
          icon={<Trophy className="size-8 text-primary" />}
          title={finished > 0 ? 'No active battles' : 'No battles yet'}
          description="Challenge someone by their username: 3 rounds in Standard, or one quick round in Rapid Fire."
          action={{ label: 'Start your first battle', onClick: () => navigate('/challenge') }}
        />
      ) : (
        <>
        {GROUPS.map(({ bucket, title }) => {
          const list = grouped.get(bucket)
          if (!list?.length) return null
          return (
            <div key={bucket} data-testid={`group-${bucket}`}>
              <SectionTitle count={list.length}>{title}</SectionTitle>
              <div className="space-y-3">
                {list.map(({ id, row }) =>
                  bucket === 'sent' ? (
                    // The cancel control sits outside the card's link (no button inside an <a>).
                    <div key={id} className="space-y-2" data-testid="sent-item">
                      <BattleCard battleId={id} state={row.state} viewerId={userId} />
                      <CancelChallenge battleId={id} className="px-1" />
                    </div>
                  ) : (
                    <BattleCard
                      key={id}
                      battleId={id}
                      state={row.state}
                      viewerId={userId}
                      highlight={bucket === 'invite' || bucket === 'my_turn'}
                    />
                  ),
                )}
              </div>
            </div>
          )
        })}
        </>
      )}
    </section>
  )
}

function VotingNow({ viewerId }: { viewerId: string | null }) {
  const { records, status } = useQuery<BattleRowData>('battles', {
    where: { status: 'active', phase: 'vote' },
    orderBy: 'nextDeadline',
    orderDir: 'asc',
    limit: 50,
  })
  // Public stored stats (D56) drive the order: biggest combined points first (D58).
  const statsQ = useQuery<PlayerStats & { userId: string }>('player_stats', { limit: 500 })
  const sorted = useMemo(() => {
    const points = new Map(statsQ.records.map((r) => [r.data.userId, Number(r.data.points) || 0]))
    return sortVotingNow(
      records.map((r) => ({ id: r.recordId, state: r.data.state, playerA: r.data.playerA, playerB: r.data.playerB, nextDeadline: r.data.nextDeadline })),
      (u) => points.get(u) ?? 0,
    )
  }, [records, statsQ.records])
  return (
    <section data-testid="voting-now" className={status === 'ready' && records.length > 0 ? '' : 'pb-16'}>
      <SectionTitle count={status === 'ready' ? records.length : undefined}>
        {status === 'ready' && records.length > 0 ? (
          // Tapping the heading brings the first card under the top bar; the
          // slot's scroll-margin-top supplies the header offset (D59, D62).
          <button
            type="button"
            data-testid="voting-now-jump"
            aria-label="Voting now: jump to the first battle"
            onClick={() =>
              document
                .querySelector('[data-testid="voting-now-slot"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="-mx-1 flex cursor-pointer items-center gap-2 rounded-md px-1 uppercase italic hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Flame className="size-5 text-destructive" aria-hidden /> Voting now
            <ChevronDown className="size-5 text-muted-foreground" aria-hidden />
          </button>
        ) : (
          <>
            <Flame className="size-5 text-destructive" aria-hidden /> Voting now
          </>
        )}
      </SectionTitle>
      {status !== 'ready' ? (
        <SkeletonList />
      ) : records.length === 0 ? (
        <EmptyState
          icon={<Flame className="size-8 text-muted-foreground" />}
          title="No votes open right now"
          description="When both players in a round have filmed, the videos drop here and anyone can vote."
        />
      ) : (
        // Reels: each card is one screen tall under the sticky top bar and is
        // a gentle snap point on the page itself. No inner scroller (D59).
        <div data-testid="voting-now-list">
          {sorted.map((r) => (
            <div key={r.id} className="feed-snap py-2" data-testid="voting-now-slot">
              <FeedVoteCard battleId={r.id} state={r.state} viewerId={viewerId} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SkeletonList() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-2xl border border-border bg-card" />
      ))}
    </div>
  )
}
