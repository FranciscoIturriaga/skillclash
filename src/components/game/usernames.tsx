/**
 * Username directory + first-sign-in picker.
 *
 * `usernames` is public and small, so one subscription for the whole app is
 * cheaper than a lookup per battle card. `UsernameGate` blocks the app for a
 * signed-in user who hasn't picked a name yet.
 */

import { createContext, useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { Button, Input } from '@/components/ui'
import { callAction } from '../../lib/api'

interface UsernameRow {
  username: string
  userId: string
}

interface Directory {
  ready: boolean
  nameOf: (userId: string) => string | null
  idOf: (username: string) => string | null
  all: UsernameRow[]
}

const Ctx = createContext<Directory>({ ready: false, nameOf: () => null, idOf: () => null, all: [] })

export function UsernamesProvider({ children }: { children: ReactNode }) {
  const { records, status } = useQuery<UsernameRow>('usernames')
  const value = useMemo<Directory>(() => {
    const byId = new Map<string, string>()
    const byName = new Map<string, string>()
    for (const r of records) {
      byId.set(r.data.userId, r.data.username)
      byName.set(r.data.username, r.data.userId)
    }
    return {
      ready: status === 'ready',
      nameOf: (id) => byId.get(id) ?? null,
      idOf: (name) => byName.get(name.toLowerCase()) ?? null,
      all: records.map((r) => r.data),
    }
  }, [records, status])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUsernames(): Directory {
  return useContext(Ctx)
}

/** The signed-in user's username, or null (also null while loading). */
export function useMyUsername(): { username: string | null; ready: boolean } {
  const { userId } = useAuth()
  const dir = useUsernames()
  return { username: userId ? dir.nameOf(userId) : null, ready: dir.ready }
}

/** Utility pages that work without a username (account settings, debug). */
const UNGATED = ['/settings', '/api-status']

export function UsernameGate({ children }: { children: ReactNode }) {
  const { isSignedIn, userId } = useAuth()
  const dir = useUsernames()
  const { pathname } = useLocation()
  if (!isSignedIn || !userId || UNGATED.some((p) => pathname.startsWith(p))) return <>{children}</>
  // Hold the page until we know whether this player has a name, so the app
  // doesn't flash and then swap to the picker.
  if (!dir.ready) return <div aria-busy="true" data-testid="username-loading" className="h-full" />
  if (dir.nameOf(userId)) return <>{children}</>
  return <UsernamePicker />
}

function UsernamePicker() {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cleaned = value.trim().toLowerCase()
  const valid = /^[a-z0-9_]{3,20}$/.test(cleaned)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const r = await callAction<{ username: string }>('setUsername', { username: cleaned })
    setBusy(false)
    // On success the usernames subscription updates and the gate opens by itself.
    if (!r.success) setError(r.error)
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <form
        onSubmit={submit}
        data-testid="username-picker"
        className="bg-arena w-full max-w-sm rounded-2xl border border-border p-6"
      >
        <p className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-primary">Step into the arena</p>
        <h1 className="font-display mt-1 text-4xl font-extrabold uppercase italic leading-none">Pick your tag</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This is how opponents find and challenge you. 3–20 characters: letters, numbers and _.
        </p>
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:border-ring">
          <span className="font-display text-xl font-bold text-muted-foreground">@</span>
          <Input
            autoFocus
            aria-label="Username"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={20}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="yourname"
            className="h-12 border-0 bg-transparent px-0 text-lg shadow-none focus-visible:ring-0"
          />
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="mt-5 w-full font-semibold" disabled={!valid} loading={busy}>
          Lock it in
        </Button>
      </form>
    </div>
  )
}
