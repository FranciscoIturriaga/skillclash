/**
 * Call a server action (src/actions). Always resolves; never throws.
 * `code` is the stable error code (e.g. 'already_voted', 'competitor').
 */
import { getAuthToken } from 'deepspace'

export type ActionResponse<T> = { success: true; data: T } | { success: false; error: string; code?: string }

export async function callAction<T = unknown>(
  name: string,
  params: Record<string, unknown>,
): Promise<ActionResponse<T>> {
  try {
    const token = await getAuthToken()
    if (!token) return { success: false, error: 'Sign in first.', code: 'signed_out' }
    const res = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
    const body = (await res.json().catch(() => null)) as ActionResponse<T> | { error?: string } | null
    if (body && 'success' in body) return body
    return { success: false, error: (body && 'error' in body && body.error) || `Request failed (${res.status}).` }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Network error.' }
  }
}
