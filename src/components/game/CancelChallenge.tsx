/**
 * "Cancel challenge" for the challenger, with an inline confirm step (D50).
 * Used on the battle page's invite panel and under each card in "Sent challenges".
 */

import { useState } from 'react'
import { Button, cn, useToast } from '@/components/ui'
import { callAction } from '../../lib/api'

export function CancelChallenge({
  battleId,
  disabled,
  className,
}: {
  battleId: string
  disabled?: boolean
  className?: string
}) {
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    setBusy(true)
    setError(null)
    const r = await callAction('cancelChallenge', { battleId })
    setBusy(false)
    if (!r.success) {
      setError(r.error)
      return
    }
    setConfirming(false)
    toast.success('Challenge cancelled')
  }

  if (!confirming) {
    return (
      <div className={className}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          data-testid="cancel-challenge"
        >
          Cancel challenge
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('space-y-2', className)} data-testid="cancel-confirm">
      <p className="text-sm font-medium">Cancel this challenge? Your opponent will see it as cancelled.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
          Keep it
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={cancel}
          loading={busy}
          disabled={busy || disabled}
          data-testid="confirm-cancel-challenge"
        >
          Yes, cancel
        </Button>
      </div>
    </div>
  )
}
