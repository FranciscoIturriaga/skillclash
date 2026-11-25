# Project notes
_Last updated: 2026-11-24 (MVP build)_

## What this project is
SkillClash: a video skill-battle app. Two players film themselves doing a skill over 3 rounds, other users vote, points go to profiles. Built for a DeepSpace build exercise, due **Wed Nov 25, 2026, 11:59 PM ET**.
Stack: DeepSpace SDK 0.44.2 (Vite + React + TypeScript frontend, Cloudflare Worker + Durable Objects backend, RecordRoom collections for data, R2 for files). Hosted at https://skillclash.app.space. Repo: https://github.com/FranciscoIturriaga/skillclash (public).

## Current status
- MVP core is built and deployed: state machine, schemas and server actions, cron sweep, files guard, full UI (arena theme), two emails.
- `npx deepspace test run all`: 8 pass, 4 skip. `tests/battle.spec.ts` (3-user full battle) and `tests/collab.spec.ts` skip until test accounts exist. 47 vitest unit tests pass.
- **Test accounts don't exist yet.** The agent was not allowed to create them (DECISIONS D32). Create 3 yourself, then run `npx deepspace test run all --port 5181`.
- Emails have not been seen live yet: no battle has finished on production.
- Decisions D1–D41 in `docs/DECISIONS.md`.

## Recent changes
- 2026-11-24: Phase 3 UI (e0628b4), Phase 4 emails, Phase 5 battle spec. All deployed.
- 2026-11-24: Phase 1 state machine (f3ec398) and Phase 2 data/actions/cron (c0c76f5).
- 2026-11-24: Scaffolded into the repo root (app name `skillclash`), registered with `app init` (app id in `wrangler.toml`).
- 2026-11-24: Created the GitHub repo, pushed `main`, first deploy claimed **GitHub source** (permanent).
- 2026-11-24: Added `docs/GAME_RULES.md` and `docs/DECISIONS.md`.

## Decisions
- **GitHub is the app's source, permanently.** Never run `npx deepspace push/pull/clone`; they refuse with `source_managed_by_github`. Use normal git. Deploys ship the local working tree, including uncommitted files, so commit before `npx deepspace deploy`.
- **All battle state transitions go in one pure module**, `src/battle/machine.ts`: (state + action) → new state or error, with unit tests. Server actions and cron both call it.
- **No compare-and-set in the SDK** (`tools.update` has no version check). Concurrency guard plan: a `battle_transitions` collection with `uniqueOn: ['battleId','fromVersion']`. Only one simultaneous transition can be created; the loser gets a conflict. See DECISIONS D10.
- **Votes go through a `castVote` server action.** The `votes` collection has `uniqueOn: ['roundId','voterId']`, member `create: false`, `read: 'own'`. The action blocks competitors and votes outside the window. Per-player tallies stay hidden via `visibilityField` until voting closes. See D12.
- **Deadlines:** a cron task in `src/cron.ts` with `intervalMinutes: 1` (the finest available), plus lazy deadline checks in every action. Both are idempotent. See D11.
- **Video privacy needs a reveal step.** `useR2Files` scope `'self'` is uploader-only and `'app'` is public by URL. Server-side `appFiles` uploads max 25 MiB per call. The reveal approach is still open, with options in D8.
- Out of scope for MVP: Stripe, followers, DMs, tournaments, rankings.

## Next steps
- [ ] Create 3 test accounts and run the battle spec (`npx deepspace test run all --port 5181`).
- [ ] Play one real battle on a phone; check `npx deepspace logs --search email` for `[email] ... sent`.
- [ ] Demo mode with short windows and a seeded demo battle (next session).
- [ ] Known gap: cron doesn't repair a stuck `invited` battle (D25); the next action on it does.

## Gotchas
- **Port 5173 is used by another project** (HAVEN admin). Never kill it. Run `npx deepspace dev start --port 5180` and `npx deepspace test run --port 5181` (test run starts its own server, so it needs a separate free port).
- `npx deepspace auth login` needs a real interactive terminal. Run it yourself (e.g. `! npx deepspace auth login`), not from an agent shell.
- Storage: the account shows 1.0 GiB total for the app's files (the docs claim 128 MiB on free). Keep demo videos small, roughly ≤60s / ≤25 MiB.
- Email (`email/send`) always sends from `notifications@updates.app.space` whatever `from` you pass (the live CLI disagrees with the docs). $0.013 per email from owner credits.
- File uploads return 401 locally until the app has been deployed at least once (it has been).
- `.claude/settings.local.json` is excluded via `.git/info/exclude` only, not `.gitignore`.
- Client `useQuery` `where` matches data columns only, never the record id. That's why battles carry a `battleId` column.
- Playwright's Chromium can't decode H.264: test videos must be WebM.
- A thrown error in a cron task appears as a `log` line, not an `exception`. Check `npx deepspace logs --search cron`.
