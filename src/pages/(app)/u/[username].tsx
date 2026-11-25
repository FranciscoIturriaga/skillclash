/**
 * Public profile: username, record, points and past battles. Stats come from
 * the server-written `player_stats` row (D56, replaces D30's client count).
 */

import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { History, UserX } from 'lucide-react'
import { EmptyState } from '@/components/ui'
import type { BattleRowData } from '../../../battle/view'
import { EMPTY_STATS, statsFromRow, type PlayerStats } from '../../../battle/stats'
import { BattleCard } from '../../../components/game/BattleCard'
import { SectionTitle } from '../../../components/game/bits'
import { useUsernames } from '../../../components/game/usernames'

export default function ProfilePage() {
  const { username = '' } = useParams()
  const dir = useUsernames()
  const userId = dir.idOf(username)
  if (!dir.ready) return <div className="mx-auto h-64 max-w-2xl animate-pulse px-4 py-6" aria-busy="true" />
  if (!userId) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <EmptyState icon={<UserX className="size-8 text-muted-foreground" />} title={`No player called @${username}`} description="Check the spelling of the username." />
      </div>
    )
  }
  return <Profile userId={userId} username={username.toLowerCase()} />
}

function Profile({ userId, username }: { userId: string; username: string }) {
  const { userId: me } = useAuth()
  const asA = useQuery<BattleRowData>('battles', { where: { playerA: userId }, limit: 200 })
  const asB = useQuery<BattleRowData>('battles', { where: { playerB: userId }, limit: 200 })

  const battles = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ id: string; row: BattleRowData }> = []
    for (const r of [...asA.records, ...asB.records]) {
      if (seen.has(r.recordId)) continue
      seen.add(r.recordId)
      out.push({ id: r.recordId, row: r.data })
    }
    return out.sort((x, y) => y.row.state.createdAt - x.row.state.createdAt)
  }, [asA.records, asB.records])

  const statsQ = useQuery<PlayerStats & { userId: string }>('player_stats', { where: { userId }, limit: 1 })
  const stats = statsQ.records[0] ? statsFromRow(statsQ.records[0].data) : EMPTY_STATS
  const past = battles.filter((b) => b.row.state.status === 'complete' || b.row.state.status === 'declined')
  const live = battles.filter((b) => b.row.state.status === 'active')
  const loading = asA.status !== 'ready' || asB.status !== 'ready'
  const statsLoading = statsQ.status !== 'ready'

  const tiles: Array<[string, number, string?]> = [
    ['Battles', stats.played],
    ['Won', stats.won, 'text-primary'],
    ['Lost', stats.lost, 'text-destructive'],
    ['Tied', stats.tied],
    ['Round wins', stats.roundWins],
    ['Points', stats.points, 'text-primary'],
  ]

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-6 pb-16" data-testid="profile-page">
      <header className="bg-arena rounded-2xl border border-border p-5">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-muted-foreground">{me === userId ? 'Your profile' : 'Player'}</p>
        <h1 className="font-display mt-1 truncate text-4xl font-extrabold italic leading-none" data-testid="profile-username">
          @{username}
        </h1>
        <dl className="mt-5 grid grid-cols-3 gap-3" data-testid="profile-stats">
          {tiles.map(([label, value, color]) => (
            <div key={label} className="rounded-xl bg-background/70 px-3 py-2.5">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
              <dd className={`font-display text-3xl font-extrabold tabular-nums ${color ?? ''}`}>{statsLoading ? '–' : value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {live.length > 0 && (
        <section>
          <SectionTitle count={live.length}>Live now</SectionTitle>
          <div className="space-y-3">
            {live.map((b) => (
              <BattleCard key={b.id} battleId={b.id} state={b.row.state} viewerId={me} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle count={loading ? undefined : past.length}>Past battles</SectionTitle>
        {!loading && past.length === 0 ? (
          <EmptyState icon={<History className="size-8 text-muted-foreground" />} title="No finished battles yet" description="Results show up here once a battle's last vote closes." />
        ) : (
          <div className="space-y-3">
            {past.map((b) => (
              <BattleCard key={b.id} battleId={b.id} state={b.row.state} viewerId={me} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
