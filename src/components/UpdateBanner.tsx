/**
 * Tells a tab that was left open across a deploy to reload (D55).
 *
 * The SPA keeps running the JS it loaded, so after a deploy an old tab can
 * talk to the new server with an outdated UI (for example an accept panel
 * without the video picker). Production only: compares this page's entry
 * script with the one the server now serves, on focus and every 5 minutes.
 */
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'

const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js/

function loadedEntry(): string | null {
  for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
    const m = s.src.match(ENTRY)
    if (m) return m[0]
  }
  return null
}

export function UpdateBanner() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (!import.meta.env.PROD) return
    const mine = loadedEntry()
    if (!mine) return
    let cancelled = false
    async function check() {
      if (document.visibilityState !== 'visible') return
      try {
        const html = await (await fetch('/home', { cache: 'no-store' })).text()
        const live = html.match(ENTRY)?.[0]
        if (!cancelled && live && live !== mine) setStale(true)
      } catch {
        // Offline or a blip: try again later.
      }
    }
    const timer = window.setInterval(check, 5 * 60_000)
    document.addEventListener('visibilitychange', check)
    void check()
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  if (!stale) return null
  return (
    <div role="status" className="flex items-center justify-center gap-3 border-b border-primary/40 bg-primary/10 px-4 py-2 text-sm" data-testid="update-banner">
      <span>SkillClash was updated. Reload to get the latest version.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        <RefreshCw className="size-3.5" aria-hidden /> Reload
      </Button>
    </div>
  )
}
