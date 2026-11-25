/**
 * Guard for the `/api/files/*` proxy on `scope=app` (public-with-link) files.
 *
 * Videos are uploaded as app-scope files so anyone with the key can play them.
 * The key is the secret until reveal (DECISIONS D14), so non-owners must not
 * be able to list app files, delete them, or choose arbitrary keys:
 *   - GET/HEAD of a single file: allowed for anyone (that's the public link).
 *   - Listing (GET on the collection root): owner only.
 *   - Uploads: signed-in users only, and only to `videos/<their id>/<random>.<ext>`.
 *   - Multipart part/complete/abort: allowed (they need the session's secret uploadId).
 *   - Everything else (DELETE of a file, other verbs): owner only.
 * Non-app scopes are left to the platform (they're private to the uploader).
 */

export interface FilesRequest {
  method: string
  /** Path after `/api/files`, e.g. '', '/', '/upload', '/multipart', '/videos/u/x.mp4'. */
  subPath: string
  scope: string | null
  key: string | null
  userId: string | null
  ownerId: string
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; error: string }

const deny = (status: 401 | 403, error: string): GuardResult => ({ ok: false, status, error })

export function videoUploadKeyRe(userId: string): RegExp {
  const esc = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^videos/${esc}/[A-Za-z0-9_-]{16,64}\\.[a-z0-9]{2,5}$`)
}

export function guardAppFiles(req: FilesRequest): GuardResult {
  if (req.scope !== 'app') return { ok: true }
  if (req.userId && req.userId === req.ownerId) return { ok: true }

  const method = req.method.toUpperCase()
  const path = req.subPath.replace(/\/+$/, '')

  if (method === 'GET' || method === 'HEAD') {
    if (path === '') return deny(403, 'Listing files is not allowed.')
    if (path.startsWith('/multipart')) return deny(403, 'Not allowed.')
    return { ok: true }
  }

  if (!req.userId) return deny(401, 'Sign in to upload.')

  if (method === 'POST' && (path === '/upload' || path === '/multipart')) {
    if (!req.key || !videoUploadKeyRe(req.userId).test(req.key)) {
      return deny(403, 'Uploads must use a videos/<your id>/ key.')
    }
    return { ok: true }
  }
  if (method === 'PUT' && path === '/multipart/part') return { ok: true }
  if (method === 'POST' && path === '/multipart/complete') return { ok: true }
  if (method === 'DELETE' && path === '/multipart') return { ok: true }

  return deny(403, 'Not allowed.')
}
