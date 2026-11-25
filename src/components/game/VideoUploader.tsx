/**
 * Submit-attempt upload for one round.
 *
 * Checks size and duration in the browser first (20 s / 50 MB, DECISIONS),
 * uploads to an unguessable `videos/<me>/<random>.<ext>` key in app scope,
 * then calls `submitVideo`, which re-checks everything server-side. The key is
 * only stored on the hidden submission row until the round's window ends.
 */

import { useRef, useState, type ChangeEvent } from 'react'
import { useAuth, useR2Files } from 'deepspace'
import { Upload, Video } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { callAction } from '../../lib/api'
import { APP_ID } from '../../constants'

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 20

function randomToken(len = 24): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (/^[a-z0-9]{2,5}$/.test(fromName)) return fromName
  if (file.type.includes('quicktime')) return 'mov'
  if (file.type.includes('webm')) return 'webm'
  return 'mp4'
}

/** Read a video's duration from its metadata without uploading it. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const done = (d: number | null) => {
      URL.revokeObjectURL(url)
      resolve(d)
    }
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null)
    v.onerror = () => done(null)
    setTimeout(() => done(null), 8000)
    v.src = url
  })
}

export function VideoUploader({
  battleId,
  round,
  needsSkill,
  disabled,
  onSubmitted,
}: {
  battleId: string
  round: number
  /** Round 3 (freestyle): each player names their own skill. */
  needsSkill: boolean
  disabled?: boolean
  onSubmitted?: () => void
}) {
  const { userId } = useAuth()
  const { upload } = useR2Files({ scope: 'app' })
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [skill, setSkill] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const busy = progress !== null

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    setError(null)
    const f = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('video/')) return setError('That file is not a video.')
    if (f.size > MAX_VIDEO_BYTES) {
      return setError(`That video is ${(f.size / 1024 / 1024).toFixed(0)} MB. The limit is 50 MB; trim it or record at a lower setting.`)
    }
    const d = await readDuration(f)
    if (d === null) return setError("Couldn't read that video's length. Try recording again, or pick an MP4/MOV file.")
    if (d > MAX_VIDEO_SECONDS + 0.75) {
      return setError(`That video is ${Math.round(d)} seconds. The limit is ${MAX_VIDEO_SECONDS} seconds; trim it and try again.`)
    }
    setFile(f)
    setDuration(d)
  }

  async function submit() {
    if (!file || !userId || busy) return
    if (needsSkill && !skill.trim()) return setError('Name your freestyle skill first.')
    setError(null)
    setProgress(0)
    const key = `videos/${userId}/${randomToken()}.${extensionFor(file)}`
    const up = await upload(file, file.name, {
      key,
      onProgress: (sent, total) => setProgress(total ? Math.round((sent / total) * 100) : 0),
    })
    if (!up.success) {
      setProgress(null)
      return setError(up.error ?? 'Upload failed. Check your connection and try again.')
    }
    const r = await callAction('submitVideo', {
      battleId,
      round,
      fileKey: up.relativeKey ?? key,
      mimeType: file.type,
      sizeBytes: file.size,
      durationSec: duration,
      ...(needsSkill ? { skill: skill.trim() } : {}),
    })
    setProgress(null)
    if (!r.success) return setError(r.error)
    setFile(null)
    onSubmitted?.()
  }

  return (
    <div className="space-y-3" data-testid="video-uploader">
      {needsSkill && (
        <Input
          aria-label="Your freestyle skill"
          placeholder="Name your freestyle skill"
          value={skill}
          maxLength={60}
          onChange={(e) => setSkill(e.target.value)}
          disabled={busy || disabled}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        data-testid="video-input"
        onChange={pick}
        disabled={busy || disabled}
      />
      {file ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background p-3">
          <Video className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-muted-foreground">
              {duration?.toFixed(1)} s · {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
          {!busy && (
            <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
              Change
            </Button>
          )}
        </div>
      ) : (
        <Button
          variant="outline"
          size="lg"
          className="w-full border-dashed"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          <Upload className="size-4" aria-hidden /> Record or choose a video
        </Button>
      )}
      {progress !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {file && (
        <Button size="lg" className="w-full font-semibold" onClick={submit} loading={busy} disabled={disabled} data-testid="submit-video">
          {busy ? `Uploading ${progress ?? 0}%` : 'Submit attempt'}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Max 20 seconds and 50 MB. Record in 1080p for the best look. Your video stays hidden until the round's
        submission window ends.
      </p>
    </div>
  )
}

/**
 * Submissions store the scope-relative key (`videos/<uid>/<file>`), which is
 * what upload/list take. `getUrl` needs the full stored key
 * (`apps/<appId>/videos/...`); the relative one gets a 403 "key outside
 * scope" from the platform and a blank player (D43).
 */
export function fullFileKey(fileKey: string, appId: string = APP_ID): string {
  return fileKey.startsWith('apps/') ? fileKey : `apps/${appId}/${fileKey}`
}

export function VideoPlayer({ fileKey, label }: { fileKey: string; label: string }) {
  const { getUrl } = useR2Files({ scope: 'app' })
  return (
    <video
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      src={getUrl(fullFileKey(fileKey))}
      className="aspect-[9/16] max-h-[60vh] w-full rounded-xl bg-black object-contain"
    />
  )
}
