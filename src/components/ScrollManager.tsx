/**
 * Scroll position for the app shell (D60).
 *
 * The shell scrolls inside `<main id="app-main">`, not the window, so React
 * Router's <ScrollRestoration> (window only) doesn't apply. Rules:
 *   - a new navigation (push/replace) starts at the top;
 *   - back/forward (POP) restores that history entry's position;
 *   - signing in resets to the top;
 *   - while signed out, closing the keyboard (a field loses focus and no other
 *     field takes it) resets to the top, because iOS Safari scrolls the
 *     window to make room for the keyboard and leaves it there.
 * Every reset also zeroes the window scroll, which is where iOS leaves that
 * keyboard offset.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useAuth } from 'deepspace'

export const MAIN_ID = 'app-main'

function main(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(MAIN_ID)
}

/** Scroll the window and the app's main area to the very top. */
export function resetScroll(): void {
  if (typeof window === 'undefined') return
  window.scrollTo(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
  const m = main()
  if (m) m.scrollTop = 0
}

function isField(el: Element | null): boolean {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

export function ScrollManager() {
  const location = useLocation()
  const navType = useNavigationType()
  const { isSignedIn } = useAuth()
  const saved = useRef(new Map<string, number>())

  // Remember each history entry's position as the user scrolls.
  useEffect(() => {
    const m = main()
    if (!m) return
    const key = location.key
    const onScroll = () => saved.current.set(key, m.scrollTop)
    m.addEventListener('scroll', onScroll, { passive: true })
    return () => m.removeEventListener('scroll', onScroll)
  }, [location.key])

  // New navigation → top. Back/forward → restore (retrying while content loads).
  useLayoutEffect(() => {
    const target = navType === 'POP' ? saved.current.get(location.key) : undefined
    if (target === undefined) return resetScroll()
    window.scrollTo(0, 0)
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    const restore = () => {
      const m = main()
      if (!m) return
      m.scrollTop = target
      if (Math.abs(m.scrollTop - target) > 2 && ++tries < 20) timer = setTimeout(restore, 50)
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
