/**
 * Challenge flow: find an opponent by username, name the round 1 skill, film
 * it (D53), pick a mode, send. The skill and video stay hidden from the
 * opponent until they accept. The opponent sees it under "Challenges for you" on their home.
 * The test mode only appears with ?test=1 (used by the Playwright spec).
 */

import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { Swords } from 'lucide-react'
import { Button, Input, cn } from '@/components/ui'
import { getMode, pickableModes } from '../../../battle/modes'
import { callAction } from '../../../lib/api'
import { useUsernames } from '../../../components/game/usernames'
import { VideoPicker, useVideoUpload, type PickedVideo } from '../../../components/game/VideoUploader'
import { EnergyBar, useEnergy } from '../../../components/game/energy'
import { OnlineDot, useOnline } from '../../../components/game/presence'
import { onlinePastOpponents } from '../../../battle/opponents'
import type { BattleRowData } from '../../../battle/view'

export default function ChallengePage() {
  const { userId } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const dir = useUsernames()
  const [opponent, setOpponent] = useState(params.get('to') ?? '')
  const [skill, setSkill] = useState('')
  const [video, setVideo] = useState<PickedVideo | null>(null)
  const { uploadVideo, progress, done } = useVideoUpload()
  const testing = params.get('test') === '1'
  const [modeId, setModeId] = useState<string>(() => {
    const asked = params.get('mode')
    if (asked && pickableModes(testing).some((m) => m.id === asked)) return asked
    return testing ? 'test' : 'standard'
  })
  const oneRound = getMode(modeId)?.rounds === 1
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const modes = pickableModes(testing)
  const query = opponent.trim().replace(/^@/, '').toLowerCase()
  const exact = query ? dir.idOf(query) : null
  const suggestions = useMemo(() => {
    if (!query || exact) return []
    return dir.all
      .filter((u) => u.userId !== userId && u.username.includes(query))
      .sort((a, b) => a.username.indexOf(query) - b.username.indexOf(query) || a.username.localeCompare(b.username))
      .slice(0, 6)
  }, [dir.all, query, exact, userId])

  const isSelf = exact !== null && exact === userId

  // "Online now": past opponents (any mode, any status) who are online, most
  // recent first, max 8 (D67). Never a list of everyone online.
  const online = useOnline()
  const asA = useQuery<BattleRowData>('battles', { where: { playerA: userId }, orderBy: 'createdAt', orderDir: 'desc', limit: 100 })
  const asB = useQuery<BattleRowData>('battles', { where: { playerB: userId }, orderBy: 'createdAt', orderDir: 'desc', limit: 100 })
  const historyReady = asA.status === 'ready' && asB.status === 'ready'
  const onlineNow = useMemo(() => {
    if (!userId || !online.ready) return []
    const rows = [...asA.records, ...asB.records].map((r) => r.data)
    return onlinePastOpponents(rows, userId, online.isOnline)
      .map((id) => ({ id, username: dir.nameOf(id) }))
      .filter((u): u is { id: string; username: string } => !!u.username)
  }, [asA.records, asB.records, userId, online, dir])
  const mode = getMode(modeId)
  const opponentOffline = !!exact && !isSelf && online.ready && !online.isOnline(exact)
  const rapidOfflineWarning = !!mode && mode.id.startsWith('rapid') && opponentOffline
  // Every pickable mode costs 1 energy to send (D66); the server has the final say.
  const energy = useEnergy()
  const outOfEnergy = energy.ready && energy.energy < 1 && getMode(modeId)?.energy !== false
  const canSend = !!exact && !isSelf && skill.trim().length > 0 && !!video && dir.ready && !outOfEnergy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSend || busy || !video) return
    setBusy(true)
    setError(null)
    const up = await uploadVideo(video)
    if (!up.ok) {
      setBusy(false)
      return setError(up.error)
    }
    const r = await callAction<{ battleId: string }>('challenge', { opponentUsername: query, modeId, skill: skill.trim(), ...up.video })
    done()
    setBusy(false)
    if (!r.success) return setError(r.error)
    navigate(`/battle/${r.data.battleId}`)
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-6 pb-16">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">New battle</p>
      <h1 className="font-display mt-1 text-4xl font-extrabold uppercase italic leading-none">Throw down</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {oneRound
          ? 'Rapid Fire: one round. Name a skill and film it. They see it when they accept, then have 5 minutes to match it.'
          : 'You set round 1: name a skill and film it. They only see it after they accept, and they set round 2 the same way. Round 3 is freestyle.'}
      </p>

      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3" data-testid="challenge-energy">
        <EnergyBar view={energy} />
        <p className="mt-1 text-xs text-muted-foreground">
          {outOfEnergy
            ? `Out of energy. Next refill in ${energy.refillIn}. Win a battle or wait for the refill.`
            : 'Sending costs 1 energy. You get it back if they decline or the invite expires or is cancelled.'}
        </p>
      </div>

      <form onSubmit={submit} className="mt-6 space-y-6" data-testid="challenge-form">
        <fieldset>
          <legend className="mb-2 block text-sm font-semibold">Mode</legend>
          <div className="grid gap-2">
            {modes.map((m) => (
              <label
                key={m.id}
                data-testid={`mode-${m.id}`}
                className={cn(
                  'flex cursor-pointer items-center justify-between rounded-xl border bg-card p-4',
                  modeId === m.id ? 'border-primary' : 'border-border',
                )}
              >
                <span>
                  <span className="block font-semibold">{m.label}</span>
                  <span className="text-sm text-muted-foreground">
                    {m.hidden
                      ? `${m.rounds} round${m.rounds > 1 ? 's' : ''} · ${fmt(m.submitWindowMs)} to film · ${fmt(m.voteWindowMs)} to vote`
                      : m.description}
                  </span>
                </span>
                <input
                  type="radio"
                  name="mode"
                  value={m.id}
                  checked={modeId === m.id}
                  onChange={() => setModeId(m.id)}
                  className="size-4 accent-[var(--color-primary)]"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div data-testid="online-now">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <OnlineDot /> Online now
          </p>
          {onlineNow.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Online now">
              {onlineNow.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    data-testid="online-opponent"
                    aria-pressed={query === u.username}
                    onClick={() => setOpponent(u.username)}
                    className={cn(
                      'flex min-h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-semibold hover:bg-accent',
                      query === u.username ? 'border-primary' : 'border-border',
                    )}
                  >
                    <OnlineDot />@{u.username}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="online-none">
              {!online.ready || !historyReady || !dir.ready
                ? 'Checking who\u2019s online…'
                : 'None of your past opponents are online. Search by username.'}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="opponent" className="mb-2 block text-sm font-semibold">
            Opponent
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-input bg-card px-3 focus-within:border-ring">
            <span className="font-display text-lg font-bold text-muted-foreground">@</span>
            <Input
              id="opponent"
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
              placeholder="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          {query && !exact && dir.ready && suggestions.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">No player called @{query}.</p>
          )}
          {isSelf && <p className="mt-2 text-sm text-destructive">You can't challenge yourself.</p>}
          {exact && !isSelf && (
            <p className="mt-2 flex items-center gap-2 text-sm text-primary" data-testid="opponent-found">
              @{query} found.
              {online.isOnline(exact) && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <OnlineDot /> Online
                </span>
              )}
            </p>
          )}
          {rapidOfflineWarning && (
            <p
              role="status"
              data-testid="rapid-offline-warning"
              className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-medium text-foreground"
            >
              @{query} is offline. They have {fmt(mode!.inviteWindowMs).replace(' min', ' minutes')} to accept.
            </p>
          )}
          {suggestions.length > 0 && (
            <ul className="mt-2 overflow-hidden rounded-lg border border-border bg-card" role="listbox" aria-label="Matching players">
              {suggestions.map((u) => (
                <li key={u.userId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => setOpponent(u.username)}
                    data-testid="suggestion"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    @{u.username}
                    {online.isOnline(u.userId) && <OnlineDot />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label htmlFor="skill" className="mb-2 block text-sm font-semibold">
            {oneRound ? 'Skill' : 'Round 1 skill'}
          </label>
          <Input
            id="skill"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            maxLength={60}
            placeholder="e.g. 10 keepy-ups with your weak foot"
            className="h-12 bg-card"
          />
        </div>

        <div>
          <p className="mb-1 block text-sm font-semibold">Show them the skill: record it now</p>
          <p className="mb-2 text-sm text-muted-foreground">
            {oneRound ? 'This is your video.' : 'This is your round 1 video.'} They'll have to match it. Hidden until they accept.
          </p>
          <VideoPicker value={video} onChange={setVideo} disabled={busy} progress={progress} />
        </div>


        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full font-semibold" disabled={!canSend} loading={busy} data-testid="send-challenge">
          <Swords className="size-4" aria-hidden />{' '}
          {progress !== null ? `Uploading ${progress}%` : outOfEnergy ? `Next energy in ${energy.refillIn}` : 'Send challenge'}
        </Button>
      </form>
    </div>
  )
}

function fmt(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 1000)} s`
}
