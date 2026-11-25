/** /me → the signed-in player's public profile. */

import { Navigate } from 'react-router-dom'
import { useMyUsername } from '../../../components/game/usernames'

export default function MePage() {
  const { username, ready } = useMyUsername()
  if (!ready || !username) return <div className="mx-auto h-64 max-w-2xl animate-pulse px-4 py-6" aria-busy="true" />
  return <Navigate to={`/u/${username}`} replace />
}
