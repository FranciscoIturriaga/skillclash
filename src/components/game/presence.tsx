/**
 * Who's online (D67), from the SDK's built-in presence room.
 *
 * Every signed-in tab joins one app-wide `PresenceRoom` (in-memory, nothing
 * stored). Closing the tab removes the player from everyone's peer list within
 * about a second. The UI only ever shows online/offline for past opponents and
 * search results: never a list of everyone, never a "last seen" time.
 *
 * Why not `usePresence`: in SDK 0.44 its heartbeat updates `lastSeenAt` but
 * doesn't rebroadcast the roster, so other tabs keep a stale copy and can't
 * see players come online or leave.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAuth, usePresenceRoom } from 'deepspace'

const ROOM = 'online'

interface Online {
  /** False until this tab has joined the room; treat everyone as unknown until then. */
  ready: boolean
  isOnline: (userId: string) => boolean
}

const Ctx = createContext<Online>({ ready: false, isOnline: () => false })

export function OnlineProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, userId } = useAuth()
  if (!isSignedIn || !userId) return <Ctx.Provider value={{ ready: false, isOnline: () => false }}>{children}</Ctx.Provider>
  return <SignedInPresence>{children}</SignedInPresence>
}

function SignedInPresence({ children }: { children: ReactNode }) {
  const { peers, connected } = usePresenceRoom(ROOM)
  const value = useMemo<Online>(() => {
    const ids = new Set(peers.map((p) => p.userId))
    return { ready: connected, isOnline: (id) => ids.has(id) }
  }, [peers, connected])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOnline(): Online {
  return useContext(Ctx)
}

/** Green dot for an online player. */
export function OnlineDot({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="online-dot"
      role="img"
      aria-label="online"
      className={`inline-block size-2.5 shrink-0 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25 ${className}`}
    />
  )
}
