/**
 * Scroll position for the app (D60).
 *
 * The window is the only vertical scroller (no inner scroll containers: they
 * break iOS Safari's tap-to-top, pull-to-refresh and gesture hand-off). Rules:
 *   - a new navigation (push/replace) starts at the top;
 *   - back/forward (POP) restores that history entry's window position;
 *   - signing in resets to the top;
 *   - while signed out, closing the keyboard (a field loses focus and no other
 *     field takes it) resets to the top, because iOS Safari scrolls the
 *     window to make room for the keyboard and leaves it there.
 * We keep our own per-entry positions (the browser's automatic restoration is
 * turned off) because content loads after the route renders.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useAuth } from 'deepspace'

export const MAIN_ID = 'app-main'

/** Jump (no smooth animation: html has scroll-behavior: smooth) to `top`. */
function jumpTo(top: number): void {
  window.scrollTo({ top, left: 0, behavior: 'instant' as ScrollBehavior })
}

/** Scroll the window to the very top. */
export function resetScroll(): void {
  if (typeof window === 'undefined') return
  jumpTo(0)
}

function isField(el: Element | null): boolean {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

export function ScrollManager() {
  const location = useLocation()
  const navType = useNavigationType()
  const { isSignedIn } = useAuth()
  const saved = useRef(new Map<string, number>())
  // The entry on screen now; a late scroll event from the old page's listener
  // (e.g. the reset itself) must not overwrite that page's saved position.
  const current = useRef(location.key)

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  }, [])

  // Remember each history entry's position as the user scrolls.
  useEffect(() => {
    const key = location.key
    const onScroll = () => {
      if (current.current === key) saved.current.set(key, window.scrollY)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [location.key])

  // New navigation → top. Back/forward → restore (retrying while content loads).
  useLayoutEffect(() => {
    current.current = location.key
    const target = navType === 'POP' ? saved.current.get(location.key) : undefined
    if (target === undefined) return resetScroll()
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    const restore = () => {
      jumpTo(target)
      if (Math.abs(window.scrollY - target) > 2 && ++tries < 20) timer = setTimeout(restore, 50)
    }
    restore()
    return () => clearTimeout(timer)
  }, [location.key, navType])

  // Signing in → top.
  const wasSignedIn = useRef(isSignedIn)
  useEffect(() => {
    if (isSignedIn && !wasSignedIn.current) {
      resetScroll()
      // The sign-in overlay closes over a frame or two; reset once more after.
      const t = setTimeout(resetScroll, 150)
      wasSignedIn.current = isSignedIn
      return () => clearTimeout(t)
    }
    wasSignedIn.current = isSignedIn
  }, [isSignedIn])

  // Signed out: keyboard closed on the sign-in screen → top.
  useEffect(() => {
    if (isSignedIn) return
    let t: ReturnType<typeof setTimeout>
    const onFocusOut = (e: FocusEvent) => {
      if (!isField(e.target as Element)) return
      clearTimeout(t)
      t = setTimeout(() => {
        if (!isField(document.activeElement)) resetScroll()
      }, 100)
    }
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusout', onFocusOut)
      clearTimeout(t)
    }
  }, [isSignedIn])

  return null
}
