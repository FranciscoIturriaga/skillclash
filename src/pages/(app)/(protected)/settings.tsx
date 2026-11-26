/**
 * Settings: account, email notifications, energy, links (D69). Sign-in is
 * required by (protected)/_layout.tsx.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { signOut, useAuth, useQuery, useUser } from 'deepspace'
import { BookOpen, ChevronRight, LogOut } from 'lucide-react'
import { Button, Switch, useToast } from '@/components/ui'
import { Panel, SectionTitle } from '../../../components/game/bits'
import { useMyUsername } from '../../../components/game/usernames'
import { EnergyBar, useEnergy } from '../../../components/game/energy'
import { callAction } from '../../../lib/api'

const CONTACT_EMAIL = 'iturriaga.francisco@gmail.com'

export default function SettingsPage() {
  const { user } = useUser()
  const { username } = useMyUsername()
  const energy = useEnergy()

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 pb-16 pt-6">
      <h1 className="font-display text-4xl font-extrabold uppercase italic leading-none">Settings</h1>

      <section>
        <SectionTitle>Account</SectionTitle>
        <Panel className="p-4">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Username</dt>
              <dd className="font-semibold text-foreground" data-testid="settings-username">
                {username ? `@${username}` : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all text-foreground" data-testid="settings-email">
                {user?.email ?? '—'}
              </dd>
            </div>
          </dl>
          <Button variant="outline" className="mt-4" onClick={() => signOut()} data-testid="settings-sign-out">
            <LogOut className="size-4" aria-hidden /> Sign out
          </Button>
        </Panel>
      </section>

      <section>
        <SectionTitle>Notifications</SectionTitle>
        <EmailToggle />
      </section>

      <section>
        <SectionTitle>Energy</SectionTitle>
        <Panel className="p-4">
          <EnergyBar view={energy} />
          <p className="mt-2 text-xs text-muted-foreground">Each challenge costs 1 energy. You get 1 back every 5 hours, up to 5.</p>
        </Panel>
      </section>

      <section>
        <SectionTitle>Help</SectionTitle>
        <Link
          to="/how-to-play"
          data-testid="settings-how-to-play"
          className="flex min-h-11 items-center justify-between rounded-2xl border border-border bg-card px-4 py-3 text-sm font-semibold hover:border-primary/60 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="flex items-center gap-2">
            <BookOpen className="size-4" aria-hidden /> How to play
          </span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </Link>
      </section>

      {/* No account deletion in the MVP (D69). */}
      <p className="text-xs text-muted-foreground" data-testid="settings-delete-note">
        To delete your account, contact{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2 hover:text-foreground">
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </div>
  )
}

/** Email on/off, stored server-side in `email_prefs` (no row = on). */
function EmailToggle() {
  const { userId } = useAuth()
  const toast = useToast()
  const q = useQuery<{ userId: string; emails: 'on' | 'off' }>('email_prefs', { where: { userId: userId ?? '' }, limit: 1 })
  const stored = q.records[0]?.data.emails !== 'off'
  // Optimistic value while the action runs; the live query takes over after.
  const [pending, setPending] = useState<boolean | null>(null)
  useEffect(() => {
    if (pending !== null && pending === stored) setPending(null)
  }, [pending, stored])
  const checked = pending ?? stored

  async function change(next: boolean) {
    setPending(next)
    const r = await callAction<{ emailsOn: boolean }>('setEmailPrefs', { emailsOn: next })
    if (!r.success) {
      setPending(null)
      toast.error("Couldn't save", r.error)
    }
  }

  return (
    <Panel className="flex items-center justify-between gap-4 p-4">
      <label htmlFor="email-toggle" className="text-sm">
        <span className="font-semibold">Email me about challenges and results</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">When someone challenges you, and when a battle ends.</span>
      </label>
      <Switch
        id="email-toggle"
        data-testid="email-toggle"
        checked={checked}
        disabled={q.status !== 'ready'}
        onCheckedChange={(v) => void change(v)}
      />
    </Panel>
  )
}
