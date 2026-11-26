import { test, expect } from '@playwright/test'
import { captureConsoleErrors } from './helpers/errors'

/**
 * Smoke tests covering both page kinds this template ships:
 *   - '/'      → the static landing (top level of src/pages/): no providers,
 *                so no auth fetch and no records WebSocket on load.
 *   - '/home'  → a dynamic page (under src/pages/(app)/): the providers mount,
 *                the nav shell renders, and the records WebSocket connects.
 *
 * The "static contract" test is the guardrail for the per-page opt-out: if
 * someone moves the providers back up into _app.tsx, it fails.
 */

/** Wait for the React app shell (present on every page). */
async function waitForApp(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 15000 })
}

test.describe('Smoke tests', () => {
  test('static landing loads without JS errors', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.goto('/')
    await waitForApp(page)
    await expect(page.getByTestId('static-landing')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('landing carries one title, one description, one canonical', async ({ page }) => {
    // <Seo> (src/pages/index.tsx, values from src/seo.ts) hoists these into
    // <head>. Exactly one of each: index.html ships no static description or
    // canonical, because React 19 would not dedupe against them on mount.
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    await expect(page).toHaveTitle(/\S/)
    expect(await page.locator('head meta[name="description"]').count()).toBe(1)
    expect(await page.locator('head link[rel="canonical"]').count()).toBe(1)
  })

  test('static contract: landing fires no auth request, opens no websocket', async ({ page }) => {
    const offenders: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/')) offenders.push(req.url())
    })
    // Only the DO room route counts — vite's own HMR socket is a dev artifact.
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname.startsWith('/ws/')) offenders.push(`ws: ${ws.url()}`)
    })
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(offenders).toEqual([])
  })

  test('dynamic app boundary mounts on /home', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 15000 })
  })

  test('sign-in button visible when logged out', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('nav-user-name')).toHaveCount(0)
  })

  test('how to play loads signed out and the header offers sign up (D69)', async ({ page }) => {
    await page.goto('/how-to-play')
    await expect(page.getByRole('heading', { name: 'How to play', level: 1 })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Rapid Fire: 1 round')).toBeVisible()
    await expect(page.getByTestId('nav-sign-in-button')).toHaveText('Sign in / Sign up')
  })

  test('reload splash: in the HTML shell, hidden once the app mounts', async ({ page }) => {
    const html = await (await page.request.get('/how-to-play')).text()
    expect(html).toContain('id="splash"')
    await page.goto('/how-to-play')
    await expect(page.getByRole('heading', { name: 'How to play', level: 1 })).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#splash')).toBeHidden()
  })

  test('back arrow: fits at 375px, goes home when opened directly, back in app history otherwise', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/how-to-play')
    const back = page.getByTestId('nav-back')
    await expect(back).toBeVisible({ timeout: 15000 })
    await expect(back).toHaveAttribute('aria-label', 'Back')
    const signIn = page.getByTestId('nav-sign-in-button')
    await expect(signIn).toBeVisible()
    const [b, logo, btn] = await Promise.all([back.boundingBox(), page.getByTestId('nav-logo').boundingBox(), signIn.boundingBox()])
    expect(b!.width).toBeGreaterThanOrEqual(44)
    expect(b!.height).toBeGreaterThanOrEqual(44)
    expect(b!.x).toBeGreaterThanOrEqual(0)
    expect(b!.x + b!.width).toBeLessThanOrEqual(logo!.x)
    expect(logo!.x + logo!.width).toBeLessThan(btn!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    // Opened directly: no in-app page behind it, so Back goes to /home, which has no arrow.
    await back.click()
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByTestId('nav-back')).toHaveCount(0)

    // In-app history: home → How to play → menu → Settings, then Back twice.
    await page.getByTestId('hero-how-to-play').click()
    await expect(page).toHaveURL(/\/how-to-play$/)
    await page.getByRole('button', { name: 'Toggle menu' }).click()
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await page.getByTestId('nav-back').click()
    await expect(page).toHaveURL(/\/how-to-play$/)
    await page.getByTestId('nav-back').click()
    await expect(page).toHaveURL(/\/home$/)
  })

  test('unknown route shows 404', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz')
    await waitForApp(page)
    await expect(page.locator('text=404')).toBeVisible()
  })
})
