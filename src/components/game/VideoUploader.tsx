/**
 * Video picking and uploading.
 *
 * Checks size and duration in the browser first (20 s / 50 MB, DECISIONS),
 * uploads to an unguessable `videos/<me>/<random>.<ext>` key in app scope,
 * then a server action (challenge, acceptChallenge, submitVideo) re-checks
 * everything and stores the key on a hidden submission row.
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

/** A video picked and checked in the browser, not uploaded yet. */
export interface PickedVideo {
  file: File
  duration: number
}

/** What the server actions take for an uploaded video. */
export interface UploadedVideo {
  fileKey: string
  mimeType: string
  sizeBytes: number
  durationSec: number
}

/** Check a picked file against the limits (20 s / 50 MB). Returns an error message or the video. */
async function checkVideo(f: File): Promise<PickedVideo | string> {
  if (!f.type.startsWith('video/')) return 'That file is not a video.'
  if (f.size > MAX_VIDEO_BYTES) {
    return `That video is ${(f.size / 1024 / 1024).toFixed(0)} MB. The limit is 50 MB; trim it or record at a lower setting.`
  }
  const d = await readDuration(f)
  if (d === null) return "Couldn't read that video's length. Try recording again, or pick an MP4/MOV file."
  if (d > MAX_VIDEO_SECONDS + 0.75) {
    return `That video is ${Math.round(d)} seconds. The limit is ${MAX_VIDEO_SECONDS} seconds; trim it and try again.`
  }
  return { file: f, duration: d }
}

/**
 * Upload a picked video to an unguessable `videos/<me>/<random>.<ext>` key in
 * app scope. Nothing can find it until a server action stores the key on a
 * submission row, and the files proxy serves it only to its uploader until
 * that row is revealed (D44).
 */
export function useVideoUpload() {
  const { userId } = useAuth()
  const { upload } = useR2Files({ scope: 'app' })
  const [progress, setProgress] = useState<number | null>(null)

  async function uploadVideo(v: PickedVideo): Promise<{ ok: true; video: UploadedVideo } | { ok: false; error: string }> {
    if (!userId) return { ok: false, error: 'Sign in first.' }
    setProgress(0)
    const key = `videos/${userId}/${randomToken()}.${extensionFor(v.file)}`
    const up = await upload(v.file, v.file.name, {
      key,
      onProgress: (sent, total) => setProgress(total ? Math.round((sent / total) * 100) : 0),
    })
    if (!up.success) {
      setProgress(null)
      return { ok: false, error: up.error ?? 'Upload failed. Check your connection and try again.' }
    }
    return {
      ok: true,
      video: { fileKey: up.relativeKey ?? key, mimeType: v.file.type, sizeBytes: v.file.size, durationSec: v.duration },
    }
  }

  return { uploadVideo, progress, done: () => setProgress(null) }
}

/**
 * Record-or-choose button plus the picked file's summary. Checks the limits
 * before anything uploads. Controlled: the parent holds the picked video.
 */
export function VideoPicker({
  value,
  onChange,
  disabled,
  progress,
  label = 'Record or choose a video',
}: {
  value: PickedVideo | null
  onChange: (v: PickedVideo | null) => void
  disabled?: boolean
  /** Upload progress (0–100) while the parent uploads, else null. */
  progress?: number | null
  label?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = progress != null

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    setError(null)
    const f = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!f) return
    const checked = await checkVideo(f)
    if (typeof checked === 'string') {
      setError(checked)
      return onChange(null)
    }
    onChange(checked)
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        data-testid="video-input"
        onChange={pick}
        disabled={busy || disabled}
      />
      {value ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background p-3">
          <Video className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{value.file.name}</p>
            <p className="text-muted-foreground">
              {value.duration.toFixed(1)} s · {(value.file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
          {!busy && (
            <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>
              Change
            </Button>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full border-dashed"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          <Upload className="size-4" aria-hidden /> {label}
        </Button>
      )}
      {busy && (
        <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Max 20 seconds and 50 MB. Record in 1080p for the best look.</p>
    </div>
  )
}

/** Submit-attempt upload for one round of a running battle. */
export function VideoUploader({
  battleId,
  round,
  needsSkill,
  disabled,
  onSubmitted,
  hint = "Your video stays hidden until the round's submission window ends.",
}: {
  battleId: string
  round: number
  /** Round 3 (freestyle): each player names their own skill. */
  needsSkill: boolean
  disabled?: boolean
  onSubmitted?: () => void
  hint?: string
}) {
  const { uploadVideo, progress, done } = useVideoUpload()
  const [picked, setPicked] = useState<PickedVideo | null>(null)
  const [skill, setSkill] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = progress !== null

  async function submit() {
    if (!picked || busy) return
    if (needsSkill && !skill.trim()) return setError('Name your freestyle skill first.')
    setError(null)
    const up = await uploadVideo(picked)
    if (!up.ok) return setError(up.error)
    const r = await callAction('submitVideo', {
      battleId,
      round,
      ...up.video,
      ...(needsSkill ? { skill: skill.trim() } : {}),
    })
    done()
    if (!r.success) return setError(r.error)
    setPicked(null)
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
      <VideoPicker value={picked} onChange={setPicked} disabled={disabled} progress={progress} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {picked && (
        <Button size="lg" className="w-full font-semibold" onClick={submit} loading={busy} disabled={disabled} data-testid="submit-video">
          {busy ? `Uploading ${progress ?? 0}%` : 'Submit attempt'}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
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
