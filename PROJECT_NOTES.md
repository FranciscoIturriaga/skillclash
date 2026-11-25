# Project notes
_Last updated: 2026-11-25_

## What this project is
SkillClash: a video skill-battle app. Two players film themselves doing a skill over 3 rounds, other users vote, points go to profiles. Built for a DeepSpace build exercise, due **Wed Nov 25, 2026, 11:59 PM ET**.
Stack: DeepSpace SDK 0.44.2 (Vite + React + TypeScript + Tailwind v4 frontend, Cloudflare Worker + Durable Objects backend, RecordRoom collections for data, R2 for files). Hosted at https://skillclash.app.space. Repo: https://github.com/FranciscoIturriaga/skillclash (public).

## Current status
- MVP is built and deployed: state machine, schemas and server actions, cron sweep (confirmed running in prod logs), files guard, full arena-themed UI, two emails (challenge, battle result).
- `npx deepspace test run all --port 5181`: 12/12 pass, including `tests/battle.spec.ts` (3-user full battle, ~1.6 min; also checks video access before/after reveal, the one-open-battle rule and round order). 54 vitest unit tests pass.
- Test accounts (by name in the spec): "Player A" = fi-skillclash-a@deepspace.test, "Player B" = fi-skillclash-b@deepspace.test, "Voter C" = voter-c@deepspace.test (stored in `~/.deepspace/test-accounts.json`).
- Email delivery not yet confirmed in production logs (no real battle finished on prod). Test-mode battles send no email (D48).
- Deployed and pushed at 596dc0c (2026-11-25). After deploy, the two revealed .mov clips return 206 `video/quicktime` with Range (curl). **Not yet checked:** actual playback in desktop Chrome (the Chrome extension wasn't connected).
- Working tree clean. Decisions D1–D49 in `docs/DECISIONS.md`.

## Recent changes
- 2026-11-25: Fixed blank videos: the player URL lacked the `apps/<appId>/` key prefix, so the platform answered 403 (D43). Files proxy now serves a video only to its uploader until reveal (D44). Feed card shows the current round's skill (D45). Battle page: current round first, past rounds collapsed newest first (D46). One open battle per pair (D47). No emails for test mode (D48). iPhone uploads checked: H.264, not HEVC (D49).
- 2026-11-24: Username gate moved inside `<main>` (nav stays visible), loading state added, `/settings` and `/api-status` exempt; battle spec uses named accounts (04ad0a1, D42).
- 2026-11-24: Phase 5 three-user battle spec (496d3af), Phase 4 emails (cca9b1e), Phase 3 UI (e0628b4). All deployed.
- 2026-11-24: Phase 1 state machine (f3ec398) and Phase 2 data/actions/cron (c0c76f5).
- 2026-11-24: Scaffolded into the repo root (app name `skillclash`), registered with `app init`; first deploy claimed **GitHub source** (permanent).
- 2026-11-24: Added `docs/GAME_RULES.md` and `docs/DECISIONS.md`.

## Decisions
- **GitHub is the app's source, permanently.** Never run `npx deepspace push/pull/clone`; they refuse with `source_managed_by_github`. Deploys ship the local working tree, including uncommitted files, so commit before `npx deepspace deploy`.
- **All battle state transitions go in one pure module**, `src/battle/machine.ts`: (state + action) → new state or error, with unit tests. Server actions (`src/battle/service.ts`) and cron both call it.
- **No compare-and-set in the SDK.** Concurrency guard: `battle_transitions` collection with `uniqueOn: ['battleId','fromVersion']`; only one simultaneous transition wins (D10).
- **Votes go through the `castVote` action.** `votes` has `uniqueOn: ['roundId','voterId']`, member `create: false`, `read: 'own'`. Competitors and out-of-window votes are refused; tallies hidden until voting closes (D12).
- **Deadlines:** cron task in `src/cron.ts` every minute plus lazy deadline checks in every action; both idempotent (D11).
- **Video privacy:** videos upload to `app` scope under an unguessable key `videos/<uid>/<24 random chars>.<ext>`; the key stays on the hidden submission row until the submit window ends (reveal step), and the files proxy refuses non-uploaders until a revealed submission uses that key (D44). Limits 20 s / 50 MB (D8).
- **File keys:** submissions store the relative key (`videos/...`); `getUrl` needs the full key, so always go through `fullFileKey()` in `VideoUploader.tsx` (D43).
- **Emails** (`src/battle/notify.ts`): recipient emails read server-side only; actions never return raw `users` rows. Result email fires once via the `battle_completed` event of the winning transition.
- **Usernames:** every signed-in user must pick one (UsernameGate in `src/components/game/usernames.tsx`). Profiles live at `/u/<username>`.
- Out of scope for MVP: Stripe, followers, DMs, tournaments, rankings.

## Next steps
- [ ] Open the battle with the Photo Booth and iPhone clips in desktop Chrome and confirm both play (D43).
- [ ] Play one real battle on a phone; check `npx deepspace logs --search email` for `[email] ... sent`.
- [ ] Demo mode with short windows and a seeded demo battle.
- [ ] Let a challenger cancel a sent invite (not possible today). Matters more now: an ignored invite blocks the pair (D47).
- [ ] Cron doesn't repair a stuck `invited` battle (D25); the next action on it does.
- [ ] Server trusts the client-reported video duration; consider a server-side check.
- [ ] HEVC iPhone videos may not play in desktop Chrome; no fallback UI yet (D49).

## Gotchas
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
- UI kit quirks: `Button` has no `asChild` (use `buttonVariants` on a `Link`); `EmptyState` `action` is `{label, onClick}`.
