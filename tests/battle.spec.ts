/**
 * End-to-end battle with three real accounts (multi-user fixture), setter
 * rules (D53): A challenges B with a round 1 skill and video, B accepts with a
 * round 2 skill and video, B matches round 1, A matches round 2, both film
 * round 3 blind, C votes, the server refuses a competitor's vote and a
 * duplicate vote, and results appear once voting closes. Rounds 2 and 3 get no
 * votes, so they end as 0–0 ties.
 * Hiding is checked at the network level: unrevealed skill names never appear
 * in any HTTP response or WebSocket frame the other player or a voter
 * receives, and unrevealed video URLs return 404 for them (D44, D53).
 * Also: a second open battle between the pair is refused (D47); rounds show
 * current first, then past newest first (D46); an expanded past round adds
 * only the videos and fits a 375px screen (D52).
 * A second test covers cancelling an invite and challenging again (D50, D51).
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

// Both tests use the same pair, and an open battle blocks the pair (D47).
test.describe.configure({ mode: 'serial' })

const CLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'clip.webm')

/**
 * Records the text of every HTTP response and WebSocket frame a page receives,
 * so a test can assert that a secret never reached that browser.
 */
function sniff(page: Page) {
  let seen: string[] = []
  const pending: Promise<void>[] = []
  page.on('response', (res) => {
    const type = res.headers()['content-type'] ?? ''
    if (type.startsWith('video/') || type.startsWith('image/') || type.includes('font')) return
    pending.push(res.text().then((t) => void seen.push(t), () => {}))
  })
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      seen.push(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'))
    })
  })
  return {
    /** Whether `secret` appeared (case-insensitive) in anything received so far. */
    async saw(secret: string): Promise<boolean> {
      await Promise.all(pending.splice(0))
      const needle = secret.toLowerCase()
      return seen.some((t) => t.toLowerCase().includes(needle))
    },
    reset() {
      seen = []
    },
  }
}

const uniqueSkill = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`

/** Send a test-mode challenge through the form, with a round 1 video; returns the battle path. */
async function sendChallenge(page: Page, opponent: string, skill: string): Promise<string> {
  await page.goto('/challenge?test=1')
  await page.getByLabel('Opponent').fill(opponent)
  await page.getByLabel('Round 1 skill').fill(skill)
  await expect(page.getByTestId('send-challenge')).toBeDisabled() // a video is required
  const form = page.getByTestId('challenge-form')
  await expect(form).toContainText('Show them the skill: record it now')
  await expect(form.getByRole('button', { name: 'Record or choose a video' })).toBeVisible()
  await page.getByTestId('challenge-form').getByTestId('video-input').setInputFiles(CLIP)
  await page.getByTestId('send-challenge').click()
  await page.waitForURL(/\/battle\/[A-Za-z0-9]+$/, { timeout: 30_000 })
  return new URL(page.url()).pathname
}

/** The src of the first <video> inside a locator, once it has loaded a URL. */
async function videoSrc(scope: ReturnType<Page['getByTestId']>): Promise<string> {
  const video = scope.locator('video').first()
  await expect(video).toHaveAttribute('src', /\/api\/files\/apps\/[^/]+\/videos\//, { timeout: 20_000 })
  return (await video.getAttribute('src'))!
}

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
  await expect(section.getByTestId('video-uploader')).toBeVisible({ timeout: 30_000 })
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

  const SKILL1 = uniqueSkill('Keepy-ups')
  const SKILL2 = uniqueSkill('Backflip')
  const sniffB = sniff(b.page)
  const sniffC = sniff(c.page)

  // A challenges B in test mode, filming the round 1 skill as part of it.
  const battleUrl = await sendChallenge(a.page, nameB, SKILL1)
  const id = battleUrl.split('/').pop()!
  // A (the setter) always sees their own skill and video.
  await expect(a.page.getByTestId('own-round-1-skill')).toHaveText(SKILL1, { timeout: 20_000 })
  const setterUrlA = await videoSrc(a.page.getByTestId('invite-waiting'))

  // One open battle per pair, in either direction (server-enforced).
  const again = await callAction(a.page, 'challenge', { opponentUsername: nameB, skill: 'Again', modeId: 'test' })
  expect(again.success).toBe(false)
  expect(again.code).toBe('open_battle_exists')
  expect(again.error).toBe(`You already have an open battle with @${nameB}.`)
  const reverse = await callAction(b.page, 'challenge', { opponentUsername: nameA, skill: 'Reverse', modeId: 'test' })
  expect(reverse.success).toBe(false)
  expect(reverse.error).toBe(`You already have an open battle with @${nameA}.`)

  // Blind invite: B sees only who, the mode and the expiry. No skill, no video.
  await b.page.goto('/home')
  await expect(b.page.getByTestId('group-invite').getByTestId('battle-card').first()).toBeVisible({ timeout: 20_000 })
  await b.page.goto(battleUrl)
  await expect(b.page.getByTestId('invite-headline')).toHaveText(`@${nameA} challenged you`, { timeout: 20_000 })
  await expect(b.page.getByTestId('invite-panel')).toContainText('Test (short windows) mode')
  await expect(b.page.getByTestId('invite-expires')).toContainText('Expires in')
  await expect(b.page.getByTestId('round-1-skill')).not.toContainText(SKILL1)
  // The accept panel has a visible, working video recorder/uploader (D55).
  const panel = b.page.getByTestId('invite-panel')
  await expect(panel).toContainText('Show them the skill: record it now')
  await expect(panel.getByRole('button', { name: 'Record or choose a video' })).toBeVisible()
  await expect(panel).toContainText('Max 20 seconds and 50 MB. Record in 1080p')
  await expect(panel.getByTestId('video-input')).toHaveAttribute('accept', 'video/*')
  await expect(b.page.getByTestId('invite-copy')).toContainText("Accept by recording your round 2 skill. You'll see their skill when round 1 starts.")
  // Locked rounds: one compact line each, worded for B, never "round 0".
  await expect(b.page.getByTestId('round-1-skill')).toHaveText(`Set by @${nameA}. Revealed when you accept`)
  await expect(b.page.getByTestId('round-2-skill')).toHaveText("You'll set this when accepting")
  await expect(b.page.getByTestId('round-3-skill')).toHaveText('Freestyle. Opens after round 2')
  await expect(b.page.locator('body')).not.toContainText(/round 0|round 1 skill/i)
  await c.page.goto(battleUrl)
  await expect(c.page.getByTestId('round-1-skill')).toBeVisible({ timeout: 20_000 })
  // Not in the page, and not anywhere in the network traffic or subscriptions.
  await expect(b.page.locator('body')).not.toContainText(SKILL1)
  await expect(c.page.locator('body')).not.toContainText(SKILL1)
  expect(await sniffB.saw(SKILL1)).toBe(false)
  expect(await sniffC.saw(SKILL1)).toBe(false)
  // A's video is refused even if B or C learn its URL.
  expect(await videoStatus(a.page, setterUrlA)).toBe(206)
  expect(await videoStatus(b.page, setterUrlA)).toBe(404)
  expect(await videoStatus(c.page, setterUrlA)).toBe(404)

  // Accepting needs a round 2 skill different from round 1's (checked on the
  // server, where round 1's skill lives) and a video.
  const sameSkill = await callAction(b.page, 'acceptChallenge', { battleId: id, round2Skill: SKILL1.toUpperCase() })
  expect(sameSkill.success).toBe(false)
  expect(sameSkill.code).toBe('same_skill')
  const noVideo = await callAction(b.page, 'acceptChallenge', { battleId: id, round2Skill: SKILL2 })
  expect(noVideo.success).toBe(false)
  expect(await sniffB.saw(SKILL1)).toBe(false) // the refusal doesn't leak it either

  const sniffA = sniff(a.page)
  await a.page.goto(battleUrl)
  await b.page.getByLabel('Round 2 skill').fill(SKILL2)
  await panel.getByTestId('video-input').setInputFiles(CLIP)
  await expect(panel).toContainText('clip.webm') // picked: name, length and size shown
  await b.page.getByTestId('accept-challenge').click()

  // Round 1 opens: B now sees A's skill and video above their own upload.
  await expect(b.page.getByTestId('round-1-phase')).toHaveText('Filming', { timeout: 30_000 })
  await expect(b.page.getByTestId('round-1-skill')).toHaveText(SKILL1)
  const match1 = b.page.getByTestId('round-1').getByTestId('match-this')
  await expect(match1).toContainText('Match this')
  expect(await videoSrc(match1)).toBe(setterUrlA)
  for (const p of [b.page, c.page]) expect(await videoStatus(p, setterUrlA)).toBe(206)
  // Control: the sniffer does see a skill once it's public, so "not seen" above means something.
  await expect.poll(() => sniffB.saw(SKILL1), { timeout: 10_000 }).toBe(true)
  // B still sees their own round 2 skill and video; A and C see neither.
  await expect(b.page.getByTestId('round-2-skill')).toHaveText(`Your skill: ${SKILL2}. Revealed to @${nameA} when round 2 starts`)
  const setterUrlB = await videoSrc(b.page.getByTestId('round-2-own-setter'))
  await expect(a.page.getByTestId('round-1').getByTestId('setter-waiting')).toBeVisible({ timeout: 20_000 })
  await expect(a.page.getByTestId('round-2-skill')).toHaveText(`Set by @${nameB}. Revealed when round 2 starts`)
  expect(await videoStatus(a.page, setterUrlB)).toBe(404)
  expect(await videoStatus(c.page, setterUrlB)).toBe(404)

  // Round 1: only B (the replicator) submits, and voting opens at once. C
  // watches the home feed and A opens it in a second tab, so the card shows
  // up live (D57). Test mode's vote window is 20 s, so the feed checks run in
  // parallel and the battle-page checks use pages that are already open.
  await c.page.goto('/home')
  const aFeed = await a.page.context().newPage()
  await aFeed.goto('/home')
  await submitRound(b.page, 1)
  await expect(a.page.getByTestId('round-1-phase')).toHaveText('Voting', { timeout: 20_000 })

  const feedCard = (p: Page) => p.locator(`[data-testid="feed-vote-card"][data-battle-id="${id}"]`)
  await Promise.all([
    (async () => {
      // C: one video at a time, 1/2 → 2/2 by arrow and by swipe, then votes from the feed.
      const card = feedCard(c.page)
      await expect(card).toBeVisible({ timeout: 20_000 })
      await card.scrollIntoViewIfNeeded()
      const indicator = card.getByTestId('reel-indicator')
      await expect(indicator).toHaveText('1/2')
      await expect(card.getByTestId('reel-slide-a').getByTestId('reel-label')).toHaveText(`@${nameA}'s video`)
      await expect(card.getByTestId('reel-video-a')).toHaveAttribute('src', /videos\//)
      // The off-screen video hasn't loaded yet (D57).
      expect(await card.getByTestId('reel-video-b').getAttribute('src')).toBeNull()
      await card.getByTestId('reel-next').click()
      await expect(indicator).toHaveText('2/2')
      await expect(card.getByTestId('reel-slide-b').getByTestId('reel-label')).toHaveText(`@${nameB}'s video`)
      await expect(card.getByTestId('reel-video-b')).toHaveAttribute('src', /videos\//)
      await card.getByTestId('reel-prev').click()
      await expect(indicator).toHaveText('1/2')
      // Swipe left, then right, with a synthetic touch gesture on the track.
      const box = (await card.getByTestId('reel-track').boundingBox())!
      const cdp = await c.page.context().newCDPSession(c.page)
      const swipe = (dx: number) =>
        cdp.send('Input.synthesizeScrollGesture', {
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 3),
          xDistance: dx,
          yDistance: 0,
          gestureSourceType: 'touch',
          speed: 2000,
        })
      await swipe(-Math.round(box.width * 0.8))
      await expect(indicator).toHaveText('2/2')
      await swipe(Math.round(box.width * 0.8))
      await expect(indicator).toHaveText('1/2')
      // Vote for A from the feed: "You voted", and both buttons lock.
      await card.getByTestId('reel-vote-a').click()
      await expect(card.getByTestId('reel-vote-a')).toHaveText(/You voted/, { timeout: 15_000 })
      await expect(card.getByTestId('reel-vote-a')).toBeDisabled()
      await expect(card.getByTestId('reel-vote-b')).toBeDisabled()
      await expect(card.getByTestId('reel-you-voted')).toContainText(`@${nameA}`)
    })(),
    (async () => {
      // A (a competitor) sees the card but no vote button on their own battle.
      const card = feedCard(aFeed)
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card.getByTestId('reel-competitor')).toBeVisible()
      await expect(card.locator('[data-testid^="reel-vote-"]')).toHaveCount(0)
    })(),
  ])
  await aFeed.close()
  // The feed vote counted: A's open battle page shows the live total.
  await expect(a.page.getByTestId('round-1').getByTestId('round-1-total-votes')).toContainText('1 vote', { timeout: 15_000 })

  // Duplicate vote from C is refused by the database (uniqueOn roundId+voterId).
  const dup = await callAction(c.page, 'castVote', { battleId: id, round: 1, side: 'b' })
  expect(dup.success).toBe(false)
  expect(dup.code).toBe('already_voted')

  // A competitor can't vote: no button in the UI, and the server refuses.
  await expect(a.page.getByTestId('round-1').getByTestId('vote-a')).toHaveCount(0)
  const own = await callAction(a.page, 'castVote', { battleId: id, round: 1, side: 'a' })
  expect(own.success).toBe(false)
  expect(own.code).toBe('competitor')

  // Per-side counts are hidden while voting is open...
  await expect(a.page.getByTestId('round-1-summary')).toHaveCount(0)
  await c.page.goto(battleUrl)
  // Round 2's skill and B's video are still hidden from A and the voter.
  await expect(a.page.getByTestId('round-2-skill')).not.toContainText(SKILL2)
  expect(await sniffA.saw(SKILL2)).toBe(false)
  expect(await sniffC.saw(SKILL2)).toBe(false)
  expect(await videoStatus(a.page, setterUrlB)).toBe(404)
  expect(await videoStatus(c.page, setterUrlB)).toBe(404)
  // ...and appear in the round's summary once it closes (20 s window + settle grace).
  await expect(c.page.getByTestId('round-1-summary')).toContainText('1 vote', { timeout: 60_000 })
  await expect(c.page.getByTestId('round-1-summary')).toContainText('+10 pts')

  // Round 2 is current and on top; round 1 is collapsed below it.
  await expect(c.page.getByTestId('round-2-phase')).toHaveText('Filming', { timeout: 30_000 })
  expect(await sectionOrder(c.page)).toEqual(['round-2', 'round-1', 'round-3'])
  await expect(c.page.getByTestId('round-1-a')).toBeHidden()
  await c.page.getByTestId('round-1-toggle').click()
  await expect(c.page.getByTestId('round-1-a')).toBeVisible()
  // No outline left on the header after clicking it (keyboard focus keeps a ring).
  await expect(c.page.getByTestId('round-1-toggle')).toHaveCSS('outline-style', 'none')
  // Expanded adds the videos only; votes and points stay in the summary chips (D52).
  await expect(c.page.getByTestId('round-1-total-votes')).toHaveCount(0)

  // Round 2 opens: A sees B's skill and video, labeled "Match this".
  await expect(a.page.getByTestId('round-2-phase')).toHaveText('Filming', { timeout: 30_000 })
  await expect(a.page.getByTestId('round-2-skill')).toHaveText(SKILL2, { timeout: 20_000 })
  const match2 = a.page.getByTestId('round-2').getByTestId('match-this')
  await expect(match2).toContainText('Match this')
  expect(await videoSrc(match2)).toBe(setterUrlB)
  for (const p of [a.page, c.page]) expect(await videoStatus(p, setterUrlB)).toBe(206)
  await expect.poll(() => sniffA.saw(SKILL2), { timeout: 10_000 }).toBe(true)
  await expect(b.page.getByTestId('round-2').getByTestId('setter-waiting')).toBeVisible({ timeout: 20_000 })

  // Round 2: only A submits; nobody votes → tie.
  await submitRound(a.page, 2)
  await expect(c.page.getByTestId('round-2-summary')).toContainText('+5 pts', { timeout: 60_000 })

  // Round 3 (freestyle) is blind: both film, and A's video loads for A only
  // until both are in, even if B or C learn its URL (D44).
  await expect(a.page.getByTestId('round-3-phase')).toHaveText('Filming', { timeout: 30_000 })
  await submitRound(a.page, 3)
  const urlA3 = await videoSrc(a.page.getByTestId('round-3'))
  await expect(b.page.getByTestId('round-3-a-status')).toHaveText(/Filmed/, { timeout: 20_000 })
  expect(await videoStatus(a.page, urlA3)).toBe(206)
  expect(await videoStatus(b.page, urlA3)).toBe(404)
  expect(await videoStatus(c.page, urlA3)).toBe(404)
  await submitRound(b.page, 3)
  await expect(a.page.getByTestId('round-3-phase')).toHaveText('Voting', { timeout: 20_000 })
  for (const p of [a.page, b.page, c.page]) expect(await videoStatus(p, urlA3)).toBe(206)
  await expect(c.page.getByTestId('round-3-summary')).toContainText('+5 pts', { timeout: 60_000 })

  // Final result: A won round 1 (10 + 5 + 5 = 20, +10 bonus), B tied two (10).
  const result = c.page.getByTestId('battle-result')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).toContainText('wins')
  await expect(c.page.getByTestId('battle-score')).toHaveText(/30\s*:\s*10/)
  // Finished: result first, then rounds 3, 2, 1.
  expect(await sectionOrder(c.page)).toEqual(['battle-result', 'round-3', 'round-2', 'round-1'])

  // Phone width: an expanded round's video cards use the full width and nothing overflows.
  await c.page.setViewportSize({ width: 375, height: 812 })
  await c.page.reload()
  await c.page.getByTestId('round-3-toggle').click()
  const card = c.page.getByTestId('round-3-a')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText('Handstand')
  const cardBox = (await card.boundingBox())!
  const videoBox = (await card.locator('video').boundingBox())!
  const cardB = (await c.page.getByTestId('round-3-b').boundingBox())!
  expect(cardB.y).toBeGreaterThan(cardBox.y) // stacked, not side by side
  expect(videoBox.width).toBeGreaterThanOrEqual(cardBox.width - 26) // only the card's padding
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(375)
  const overflow = await c.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // Profile tiles at 375px: same height, numbers on one line per row even
  // though "Round wins" wraps.
  await c.page.goto(`/u/${nameA}`)
  const tiles = c.page.getByTestId('profile-stat-tile')
  await expect(tiles).toHaveCount(6)
  await expect(tiles.nth(5).locator('dd')).not.toHaveText('–', { timeout: 20_000 })
  const boxes = await tiles.evaluateAll((els) =>
    els.map((el) => ({ h: el.getBoundingClientRect().height, num: el.querySelector('dd')!.getBoundingClientRect().bottom })),
  )
  for (const b of boxes) expect(Math.abs(b.h - boxes[0].h)).toBeLessThanOrEqual(1)
  for (const row of [boxes.slice(0, 3), boxes.slice(3)]) {
    for (const b of row) expect(Math.abs(b.num - row[0].num)).toBeLessThanOrEqual(1)
  }

  // Text fields are at least 16px on a phone, so iOS Safari doesn't zoom in.
  await c.page.goto('/challenge?test=1')
  const skill = c.page.getByLabel('Round 1 skill')
  await expect(skill).toBeVisible({ timeout: 20_000 })
  expect(await skill.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
})

test('cancel an invite, then the pair can challenge again', async ({ users }) => {
  test.setTimeout(120_000)
  const [a, b] = await users(['Player A', 'Player B'])
  await ensureUsername(a.page, a.email)
  const nameB = await ensureUsername(b.page, b.email)

  // A challenges B; the invite shows when it expires (test mode: 5 minutes).
  const battleUrl = await sendChallenge(a.page, nameB, uniqueSkill('Juggling'))
  const id = battleUrl.split('/').pop()!
  await expect(a.page.getByTestId('invite-expires')).toHaveText(/Expires in [45]m/, { timeout: 20_000 })

  // Only the challenger can cancel (server-enforced).
  const byB = await callAction(b.page, 'cancelChallenge', { battleId: id })
  expect(byB.success).toBe(false)
  expect(byB.code).toBe('wrong_player')

  // A cancels from the "Sent challenges" list, with a confirm step.
  await a.page.goto('/home')
  const sent = a.page.getByTestId('group-sent').getByTestId('sent-item').filter({
    has: a.page.locator(`a[href="${battleUrl}"]`),
  })
  await expect(sent).toBeVisible({ timeout: 20_000 })
  await expect(sent.getByTestId('invite-expires')).toContainText('Expires in')
  await sent.getByTestId('cancel-challenge').click()
  await expect(sent.getByTestId('cancel-confirm')).toBeVisible()
  await sent.getByTestId('confirm-cancel-challenge').click()
  await expect(sent).toHaveCount(0, { timeout: 15_000 })

  // B sees it as cancelled and can no longer accept it.
  await b.page.goto(battleUrl)
  await expect(b.page.getByTestId('battle-status')).toHaveText('Cancelled', { timeout: 20_000 })
  await expect(b.page.getByTestId('battle-cancelled')).toBeVisible()
  await expect(b.page.getByTestId('accept-challenge')).toHaveCount(0)
  const accept = await callAction(b.page, 'acceptChallenge', { battleId: id, round2Skill: 'Backflip' })
  expect(accept.success).toBe(false)

  // The pair is free again: A can challenge B right away.
  const againUrl = await sendChallenge(a.page, nameB, uniqueSkill('Again'))
  expect(againUrl).not.toBe(battleUrl)

  // Cancel from the battle page too, so the pair is left free.
  await expect(a.page.getByTestId('invite-waiting')).toBeVisible({ timeout: 20_000 })
  await a.page.getByTestId('cancel-challenge').click()
  await a.page.getByTestId('confirm-cancel-challenge').click()
  await expect(a.page.getByTestId('battle-status')).toHaveText('Cancelled', { timeout: 15_000 })
  await expect(a.page.getByTestId('battle-cancelled')).toContainText('You cancelled')
})
