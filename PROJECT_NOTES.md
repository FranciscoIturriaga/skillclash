# Project notes
_Last updated: 2026-11-25_

## What this project is
SkillClash: a video skill-battle app. Two players film themselves doing a skill over 3 rounds, other users vote, points go to profiles. Built for a DeepSpace build exercise, due **Wed Nov 25, 2026, 11:59 PM ET**.
Stack: DeepSpace SDK 0.44.2 (Vite + React + TypeScript + Tailwind v4 frontend, Cloudflare Worker + Durable Objects backend, RecordRoom collections for data, R2 for files). Hosted at https://skillclash.app.space. Repo: https://github.com/FranciscoIturriaga/skillclash (public).

## Current status
- MVP is built and deployed: state machine, schemas and server actions, cron sweep (confirmed running in prod logs), files guard, full arena-themed UI, two emails (challenge, battle result).
- **Set-and-match rules (D53, D54):** setters film first in rounds 1–2 (A with the challenge, B with the accept); blind invite; unrevealed skills live on hidden setter submission rows, not the public battle state. Old active battles finish under the old rules; old open invites can't be accepted.
- `npx deepspace test run all --port 5181`: 13/13 pass (101 unit tests), including `tests/battle.spec.ts` (3-user set-and-match battle with network-level leak checks and feed reel swipe/arrow/vote checks, ~1.6 min, plus a 375px layout check; and a cancel-invite test that re-challenges the pair). 
- Test accounts (by name in the spec): "Player A" = fi-skillclash-a@deepspace.test, "Player B" = fi-skillclash-b@deepspace.test, "Voter C" = voter-c@deepspace.test (stored in `~/.deepspace/test-accounts.json`).
- Email delivery not yet confirmed in production logs (no real battle finished on prod). Test-mode battles send no email (D48).
- Deployed and pushed at dcaf8e9 (2026-11-25): set-and-match rules (b3323c1) plus D55 (compact locked rounds, blind accept copy, reload banner). Live bundle verified to carry the new copy. Prod sweep logs `active=2 invited=0 ... failed=0`. Working tree clean.
- **Not yet checked by a person:** the D55 fix on a fully reloaded tab (the reported accept-panel bug was a stale tab), the set-and-match flow on a real phone (record in the challenge form and accept panel, "Match this"), the earlier phone checks (expanded rounds, Expires in, Cancel flow), and video playback in desktop Chrome (D43).
- Deployed and pushed at af741ed (2026-11-25): stored stats, reels feed, points sort. Prod backfill ran once: `battles=0 counted=0` (no battle had completed on prod yet; 3 active). Marker written, so later completions count via the hook.
- Decisions D1–D58 in `docs/DECISIONS.md`.

## Recent changes
- 2026-11-25: iOS zoom fix: an unlayered rule in `styles.css` forces 16px on inputs/textarea/select on phones and touch devices (the SDK sign-in overlay uses 14px `text-sm`); viewport zoom untouched. Profile stat tiles are equal height with the number pinned to the bottom. Spec checks both at 375px.
- 2026-11-25: Stored player stats (D56): `stats_entries` ledger (uniqueOn battleId+playerId) + public `player_stats`, written from the `battle_completed` hook and the repair path; one-time backfill from the cron (marker `app_migrations/stats-backfill-v1`). Profile reads `player_stats`. "Voting now" cards are reels with vote-from-feed (D57), sorted by combined points then deadline (D58).
- 2026-11-25: D55: the accept-panel bug report was a stale tab (old JS, new server). Added a production-only "SkillClash was updated, Reload" banner, compact one-line locked rounds with per-viewer copy (`lockedRoundCopy`), and new accept panel copy.
- 2026-11-25: Set-and-match rounds 1–2 (D53): A must film round 1's skill to challenge, B must name and film round 2's to accept; B's invite is blind; replicator-only deadlines; "Match this" box. Skills hidden server-side on setter submission rows; `publicSubmissions()` decides reveals. Old battles: D54.
- 2026-11-25: Challenger can cancel an unanswered invite (`cancelled`, D50). Invites expire after the mode's `inviteWindowMs` (24h Standard, 5 min Test) via cron + lazy check (`expired`, D51). Expanded past rounds show only videos/skills; missed players get a one-line row; summary has keyboard-only focus ring (D52).
- 2026-11-25: Fixed blank videos: the player URL lacked the `apps/<appId>/` key prefix, so the platform answered 403 (D43). Files proxy now serves a video only to its uploader until reveal (D44). Feed card shows the current round's skill (D45). Battle page: current round first, past rounds collapsed newest first (D46). One open battle per pair (D47). No emails for test mode (D48). iPhone uploads checked: H.264, not HEVC (D49).
- 2026-11-24: Username gate inside `<main>`, battle spec uses named accounts (D42). Phases 1–5 built and deployed: state machine, data/actions/cron, UI, emails, three-user spec.
- 2026-11-24: Scaffolded into the repo root (app `skillclash`); first deploy claimed **GitHub source** (permanent). Added `docs/GAME_RULES.md` and `docs/DECISIONS.md`.

## Decisions
- **GitHub is the app's source, permanently.** Never run `npx deepspace push/pull/clone`; they refuse with `source_managed_by_github`. Deploys ship the local working tree, including uncommitted files, so commit before `npx deepspace deploy`.
- **All battle state transitions go in one pure module**, `src/battle/machine.ts`: (state + action) → new state or error, with unit tests. Server actions (`src/battle/service.ts`) and cron both call it.
- **No compare-and-set in the SDK.** Concurrency guard: `battle_transitions` collection with `uniqueOn: ['battleId','fromVersion']`; only one simultaneous transition wins (D10).
- **Votes go through the `castVote` action.** `votes` has `uniqueOn: ['roundId','voterId']`, member `create: false`, `read: 'own'`. Competitors and out-of-window votes are refused; tallies hidden until voting closes (D12).
- **Deadlines:** cron task in `src/cron.ts` every minute plus lazy deadline checks in every action; both idempotent (D11). The sweep reads `active` and `invited` battles and uses `dueAction(state)`, not `nextDeadline` (older invite rows have it null).
- **Video privacy:** videos upload to `app` scope under an unguessable key `videos/<uid>/<24 random chars>.<ext>`; the key stays on the hidden submission row until the submit window ends (reveal step), and the files proxy refuses non-uploaders until a revealed submission uses that key (D44). Limits 20 s / 50 MB (D8).
- **File keys:** submissions store the relative key (`videos/...`); `getUrl` needs the full key, so always go through `fullFileKey()` in `VideoUploader.tsx` (D43).
- **Emails** (`src/battle/notify.ts`): recipient emails read server-side only; actions never return raw `users` rows. Result email fires once via the `battle_completed` event of the winning transition.
- **Setter rules (D53):** `state.rules = 2` marks new battles. Never put an unrevealed skill in the battle state: the server passes it into the action that opens the round (`accept.round1Skill`, `nextSkill`). Battles without `rules` are legacy (D54).
- **Stats (D56):** never increment `player_stats`; write a ledger row then recount (`recordBattleStats` in `src/battle/stats.ts`). Any new completion path must call it.
- **Locked rounds** are one-line rows; their copy comes from `lockedRoundCopy()` in `src/battle/view.ts` and is worded per viewer (D55).
- **Stale tabs:** `src/components/UpdateBanner.tsx` (prod only) compares the loaded `/assets/index-*.js` with the live one and offers Reload; it never forces a reload (D55).
- **Invites:** cancel (challenger only) and expiry (`inviteExpiresAt` in state; `inviteDeadline()` falls back to createdAt + window for old rows) both free the pair rule. No emails for either (D50, D51).
- **Usernames:** every signed-in user must pick one (UsernameGate in `src/components/game/usernames.tsx`). Profiles live at `/u/<username>`.
- Out of scope for MVP: Stripe, followers, DMs, tournaments, rankings.

## Next steps
- [ ] On a phone: swipe between the two videos on a "Voting now" card, unmute, vote, and check the card's header still opens the battle page.
- [ ] Fully reload a battle page as B on an open invite: uploader button, new copy, three compact locked rows (D55).
- [ ] After a deploy, leave a tab open and confirm the "SkillClash was updated" banner appears on refocus (D55).
- [ ] On a phone: send a challenge (record in the form), accept with a recorded video, check B's invite shows no skill, and the "Match this" box in rounds 1 and 2.
- [ ] Clean up unused setter videos: they stay in storage when a challenge is declined, cancelled or expires (D53).
- [ ] On a phone: expand a past round (videos only, no outline on tap), check "Expires in" on a new invite, and test Cancel challenge → Keep it / Yes, cancel, then re-challenge.
- [ ] Open the battle with the Photo Booth and iPhone clips in desktop Chrome and confirm both play (D43).
- [ ] Play one real battle on a phone; check `npx deepspace logs --search email` for `[email] ... sent`.
- [ ] Demo mode with short windows and a seeded demo battle.
- [ ] Cron doesn't repair a stuck `invited` battle (D25); the next action on it does.
- [ ] Server trusts the client-reported video duration; consider a server-side check.
- [ ] HEVC iPhone videos may not play in desktop Chrome; no fallback UI yet (D49).

## Gotchas
- A bug report that shows copy not in `src` is probably a stale tab: grep the live bundle (`curl /home`, then its `assets/index-*.js` and chunks) before changing code.
- `challenge`/`acceptChallenge` now need a video; specs send challenges through the form (`sendChallenge` in `battle.spec.ts`). The spec's `sniff()` records responses and WS frames to prove a secret never reached a browser.
- Round results in the browser spec are read from the summary chips (`round-N-summary`); the old `round-N-outcome` line was removed (D52). The cancel test and the full battle test share Player A/B, so `battle.spec.ts` runs serially.
- **Port 5173 is used by another project** (HAVEN admin). Never kill it. Use `npx deepspace dev start --port 5180` and `npx deepspace test run --port 5181` (test run starts its own server).
- `npx deepspace auth login` needs a real interactive terminal. Run it yourself (`! npx deepspace auth login`), not from an agent shell.
- Battle spec runs use test mode, which sends no email (D48). Real battles cost $0.013 per email from owner credits.
- To see where a video fails: `npx deepspace app files list --json` gives keys; request `/api/files/apps/<appId>/<key>?scope=app` with `Range: bytes=0-`. A 404 from our proxy means "not revealed"; a 403 "key outside scope" means the URL lacks the `apps/<appId>/` prefix. `videos/M2mP8…/biBS…mov` is an orphan upload (404 is expected).
- Email (`email/send`) always sends from `notifications@updates.app.space`, whatever `from` you pass (D40).
- Storage: the account shows 1.0 GiB for app files (docs claim 128 MiB on free). Keep demo videos small.
- File uploads return 401 locally until the app has been deployed once (it has been).
- `.claude/settings.local.json` is excluded via `.git/info/exclude` only, not `.gitignore`.
- Client `useQuery` `where` matches data columns only, never the record id; that's why battles carry a `battleId` column. `where` is equality-only (home uses two queries for playerA/playerB).
- Playwright's Chromium can't decode H.264: test videos must be WebM (`tests/fixtures/clip.webm`).
- A thrown error in a cron task appears as a `log` line, not an `exception`. Check `npx deepspace logs --search cron`.
- Dev builds expose `window.__callAction` (`src/lib/api.ts`, `import.meta.env.DEV` only) so specs can test server refusals.
- The test-only battle mode appears in the challenge form only with `/challenge?test=1`.
- Any field under 16px makes iOS Safari zoom in and stay zoomed; keep the 16px rule at the end of `styles.css` (it must stay outside `@layer` to beat the SDK's classes).
- UI kit quirks: `Button` has no `asChild` (use `buttonVariants` on a `Link`); `EmptyState` `action` is `{label, onClick}`.
