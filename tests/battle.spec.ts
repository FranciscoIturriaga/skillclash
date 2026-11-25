/**
 * End-to-end battle with three real accounts (multi-user fixture):
 * A challenges B in test mode, B accepts, both submit, C votes, the server
 * refuses a competitor's vote and a duplicate vote, and results appear once
 * voting closes. Rounds 2 and 3 get no votes, so they end as 0–0 ties.
 * Also: a second open battle between the pair is refused (D47); a video loads
 * for its uploader before reveal but not for the opponent or a voter, and for
 * everyone after (D44); rounds show current first, then past newest first (D46).
 *
 * Test mode: 3 min to submit, 20 s to vote (src/battle/modes.ts).
 * Needs the three named test accounts below; skips otherwise (DECISIONS D32, D42).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect, findTestAccountByName } from 'deepspace/testing'

// Roles matter here (challenger, opponent, voter), so the spec asks for the
// project's accounts by name:
//   Player A = fi-skillclash-a@deepspace.test
//   Player B = fi-skillclash-b@deepspace.test
//   Voter C  = voter-c@deepspace.test
const ACCOUNTS = ['Player A', 'Player B', 'Voter C']
const missing = ACCOUNTS.filter((n) => !findTestAccountByName(n))
test.skip(
  missing.length > 0,
  `Missing test accounts: ${missing.join(', ')}. Create them with ` +
    '`npx deepspace test accounts create --email <email> --name "<name>" --password-stdin` ' +
    '(fi-skillclash-a@, fi-skillclash-b@, voter-c@deepspace.test).',
)

const CLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'clip.webm')

/** Make sure the account has a username; return it. */
async function ensureUsername(page: Page, email: string): Promise<string> {
  await page.goto('/home')
  // The gate shows either the picker or the page once usernames have loaded.
  await expect(page.getByTestId('username-picker').or(page.getByTestId('new-challenge'))).toBeVisible({ timeout: 20_000 })
  const picker = page.getByTestId('username-picker')
  if (await picker.isVisible()) {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 12)
    const name = `${base}_${Math.random().toString(36).slice(2, 6)}`.padEnd(3, 'x')
    await picker.getByLabel('Username').fill(name)
    await picker.getByRole('button', { name: 'Lock it in' }).click()
    await expect(picker).toBeHidden({ timeout: 15_000 })
  }
  await page.goto('/me')
  await page.waitForURL(/\/u\/[a-z0-9_]+$/, { timeout: 15_000 })
  return page.url().split('/u/')[1]
}

async function callAction(page: Page, name: string, params: Record<string, unknown>) {
  await page.waitForFunction(() => typeof (window as any).__callAction === 'function')
  return page.evaluate(
    ([n, p]) => (window as any).__callAction(n, p) as Promise<{ success: boolean; code?: string; error?: string }>,
    [name, params] as const,
  )
}

/** Status of a same-origin Range request for a video URL, the way <video> loads it. */
async function videoStatus(page: Page, url: string): Promise<number> {
  return page.evaluate(async (u) => (await fetch(u, { headers: { Range: 'bytes=0-' } })).status, url)
}

/** data-testids of the result panel and round sections, in page order. */
async function sectionOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="battle-result"], section[data-testid^="round-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
}

async function submitRound(page: Page, round: number) {
  const section = page.getByTestId(`round-${round}`)
  await expect(section.getByTestId('video-uploader')).toBeVisible({ timeout: 20_000 })
  if (round === 3) await section.getByLabel('Your freestyle skill').fill('Handstand')
  await section.getByTestId('video-input').setInputFiles(CLIP)
  await section.getByTestId('submit-video').click()
  await expect(section.getByTestId('submitted-hidden').or(section.getByTestId(`round-${round}-phase`).filter({ hasText: 'Voting' }))).toBeVisible({ timeout: 30_000 })
}

test('full battle: challenge, accept, submit, vote rules, results', async ({ users }) => {
  test.setTimeout(240_000)
  const [a, b, c] = await users(ACCOUNTS)
  const nameA = await ensureUsername(a.page, a.email)
  const nameB = await ensureUsername(b.page, b.email)
  await ensureUsername(c.page, c.email)

  // A failed earlier run can leave an invite open, which would now block a new
  // challenge between the pair (D47). B declines any pending invites first.
  const myBattlesLoaded = () =>
    expect(
      b.page.getByTestId('my-battles').getByTestId('battle-card').first().or(b.page.getByText('No battles yet')),
    ).toBeVisible({ timeout: 20_000 })
  await b.page.goto('/home')
  await myBattlesLoaded()
  const invites = b.page.getByTestId('group-invite').getByTestId('battle-card')
  while ((await invites.count()) > 0) {
    await invites.first().click()
    await b.page.getByTestId('decline-challenge').click()
    await expect(b.page.getByTestId('battle-status')).toHaveText('Declined', { timeout: 15_000 })
    await b.page.goto('/home')
    await myBattlesLoaded()
  }

  // A challenges B in test mode.
  await a.page.goto('/challenge?test=1')
  await a.page.getByLabel('Opponent').fill(nameB)
  await a.page.getByLabel('Round 1 skill').fill('Keepy-ups')
  await a.page.getByTestId('send-challenge').click()
  await a.page.waitForURL(/\/battle\/[A-Za-z0-9]+$/, { timeout: 20_000 })
  const battleUrl = new URL(a.page.url()).pathname

  // One open battle per pair, in either direction (server-enforced).
  const again = await callAction(a.page, 'challenge', { opponentUsername: nameB, skill: 'Again', modeId: 'test' })
  expect(again.success).toBe(false)
  expect(again.code).toBe('open_battle_exists')
  expect(again.error).toBe(`You already have an open battle with @${nameB}.`)
  const reverse = await callAction(b.page, 'challenge', { opponentUsername: nameA, skill: 'Reverse', modeId: 'test' })
  expect(reverse.success).toBe(false)
  expect(reverse.error).toBe(`You already have an open battle with @${nameA}.`)

  // B sees it on home and accepts.
  await b.page.goto('/home')
  await expect(b.page.getByTestId('group-invite').getByTestId('battle-card').first()).toBeVisible({ timeout: 20_000 })
  await b.page.goto(battleUrl)
  await b.page.getByLabel('Round 2 skill').fill('Backflip')
  await b.page.getByTestId('accept-challenge').click()
  await expect(b.page.getByTestId('round-1-phase')).toHaveText('Filming', { timeout: 20_000 })

  // Round 1: both submit. A's video is hidden from B until both are in.
  await a.page.goto(battleUrl)
  await submitRound(a.page, 1)
  await expect(b.page.getByTestId('round-1-a-status')).toHaveText(/Filmed/, { timeout: 20_000 })

  // Before reveal, A's video loads for A only, even if B or C learn its URL.
  const videoA = a.page.getByTestId('round-1').locator('video')
  await expect(videoA).toHaveAttribute('src', /\/api\/files\/apps\/[^/]+\/videos\//, { timeout: 20_000 })
  const urlA = (await videoA.getAttribute('src'))!
  await c.page.goto(battleUrl)
  expect(await videoStatus(a.page, urlA)).toBe(206)
  expect(await videoStatus(b.page, urlA)).toBe(404)
  expect(await videoStatus(c.page, urlA)).toBe(404)

  await submitRound(b.page, 1)
  await expect(a.page.getByTestId('round-1-phase')).toHaveText('Voting', { timeout: 20_000 })

  // After reveal, everyone signed in can load it, with Range support.
  for (const p of [a.page, b.page, c.page]) expect(await videoStatus(p, urlA)).toBe(206)

  // C votes for A.
  await c.page.goto(battleUrl)
  const round1 = c.page.getByTestId('round-1')
  await round1.getByTestId('vote-a').click()
  await expect(round1.getByTestId('my-vote')).toBeVisible({ timeout: 15_000 })
  await expect(round1.getByTestId('round-1-total-votes')).toContainText('1 vote', { timeout: 15_000 })

  // Duplicate vote from C is refused by the database (uniqueOn roundId+voterId).
  const id = battleUrl.split('/').pop()!
  const dup = await callAction(c.page, 'castVote', { battleId: id, round: 1, side: 'b' })
  expect(dup.success).toBe(false)
  expect(dup.code).toBe('already_voted')

  // A competitor can't vote: no button in the UI, and the server refuses.
  await expect(a.page.getByTestId('round-1').getByTestId('vote-a')).toHaveCount(0)
  const own = await callAction(a.page, 'castVote', { battleId: id, round: 1, side: 'a' })
  expect(own.success).toBe(false)
  expect(own.code).toBe('competitor')

  // Per-side counts are hidden while voting is open...
  await expect(c.page.getByTestId('round-1-outcome')).toHaveCount(0)
  // ...and appear once it closes (20 s window + settle grace).
  await expect(c.page.getByTestId('round-1-outcome')).toContainText('takes the round', { timeout: 60_000 })

  // Round 2 is current and on top; round 1 is collapsed below it.
  await expect(c.page.getByTestId('round-2-phase')).toHaveText('Filming', { timeout: 30_000 })
  expect(await sectionOrder(c.page)).toEqual(['round-2', 'round-1', 'round-3'])
  await expect(c.page.getByTestId('round-1-summary')).toContainText('+10 pts')
  await expect(c.page.getByTestId('round-1-a')).toBeHidden()
  await c.page.getByTestId('round-1-toggle').click()
  await expect(c.page.getByTestId('round-1-a')).toBeVisible()

  // Rounds 2 and 3: both submit, nobody votes → ties.
  for (const round of [2, 3]) {
    await expect(a.page.getByTestId(`round-${round}-phase`)).toHaveText('Filming', { timeout: 30_000 })
    await submitRound(a.page, round)
    await submitRound(b.page, round)
    await expect(c.page.getByTestId(`round-${round}-outcome`)).toContainText('tie', { timeout: 60_000 })
  }

  // Final result: A won round 1 (10 + 5 + 5 = 20, +10 bonus), B tied two (10).
  const result = c.page.getByTestId('battle-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).toContainText('wins')
  await expect(c.page.getByTestId('battle-score')).toHaveText(/30\s*:\s*10/)
  // Finished: result first, then rounds 3, 2, 1.
  expect(await sectionOrder(c.page)).toEqual(['battle-result', 'round-3', 'round-2', 'round-1'])
})
