# Project notes
_Last updated: 2026-11-24_

## What this project is
SkillClash: a video skill-battle app. Two players film themselves doing a skill over 3 rounds, other users vote, points go to profiles. Built for a DeepSpace build exercise, due **Wed Nov 25, 2026, 11:59 PM ET**.
Stack: DeepSpace SDK 0.44.2 (Vite + React + TypeScript frontend, Cloudflare Worker + Durable Objects backend, RecordRoom collections for data, R2 for files). Hosted at https://skillclash.app.space. Repo: https://github.com/FranciscoIturriaga/skillclash (public).

## Current status
- Setup only. The unmodified DeepSpace starter scaffold is deployed and serving. No app features built yet.
- `npx deepspace test run` passes 8/8 (smoke + api). `tests/collab.spec.ts` only runs with `test run all`.
- Product rules are final in `docs/GAME_RULES.md` (source of truth). Setup choices and research-based plan changes are in `docs/DECISIONS.md` (D1–D13).
- No uncommitted work.

## Recent changes
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
- [ ] Pick the video reveal approach (D8: cap at 25 MiB and copy, unguessable `'app'` key, or custom R2 binding).
- [ ] Write `src/battle/machine.ts` + unit tests covering every rule in GAME_RULES.md (scoring, missed deadlines, draws).
- [ ] Define schemas in `src/schemas.ts`: battles, rounds, submissions, votes, battle_transitions, mode config; extend `users` with profile stats (keep the `users` schema name).
- [ ] Server actions in `src/actions/`: challenge, accept/decline, set skill, submit video, castVote.
- [ ] `battle-sweep` cron task in `src/cron.ts`.
- [ ] UI: challenge flow, battle page, voting, profile. Replace the starter theme and home page.
- [ ] Two-user tests (`npx deepspace test run all`), then deploy. Add a Demo mode with short windows for grading.

## Gotchas
- **Port 5173 is used by another project** (HAVEN admin). Never kill it. Run `npx deepspace dev start --port 5180` and `npx deepspace test run --port 5181` (test run starts its own server, so it needs a separate free port).
- `npx deepspace auth login` needs a real interactive terminal. Run it yourself (e.g. `! npx deepspace auth login`), not from an agent shell.
- Storage: the account shows 1.0 GiB total for the app's files (the docs claim 128 MiB on free). Keep demo videos small, roughly ≤60s / ≤25 MiB.
- Email (`email/send`) always sends from `notifications@updates.app.space` whatever `from` you pass (the live CLI disagrees with the docs). $0.013 per email from owner credits.
- File uploads return 401 locally until the app has been deployed at least once (it has been).
- `.claude/settings.local.json` is excluded via `.git/info/exclude` only, not `.gitignore`.
- A thrown error in a cron task appears as a `log` line, not an `exception`. Check `npx deepspace logs --search cron`.
