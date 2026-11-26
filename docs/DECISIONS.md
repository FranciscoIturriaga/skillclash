# Decisions Log

Decisions made during setup without the product owner present. Each entry records what was decided, why, and the alternatives considered. Product rules live in [GAME_RULES.md](GAME_RULES.md); this file covers process and technical choices.

---

## Setup session — 2026-11-24

### D1. Scaffold directly into the existing folder with `.`

- **Decided:** Ran `npm create deepspace@latest .` inside `~/Developer/SkillClash`.
- **Why:** `create-deepspace --help` (v0.44.2) documents `.` as "scaffold into the current directory". The scaffolder derived the app name `skillclash` from the folder name, lowercased (confirmed in `wrangler.toml` and `package.json`). This avoids a temp folder and a hidden-file move.
- **Alternatives:** Scaffold into a temp folder and move everything, including dotfiles. That was the fallback in the instructions and was not needed.

### D2. Register with `npx deepspace app init` before the first commit

- **Decided:** Ran `app init` right after scaffolding. It registered `app_01M87XNN6HMWEAKM2XFP7G4R39` on production to the signed-in account and made the initial commit itself ("Initial commit (DeepSpace scaffold + working tree)", 82 files).
- **Why:** The installation docs say that once the `__APP_ID__` placeholder is committed, the app no longer registers itself on first use. The product owner approved this deviation. The source-control guide confirms `app init` does not claim a source; only deploy and push do.
- **Alternatives:** Commit first, then register. The docs warn against this. Hand-committing after `app init` was unnecessary because `app init` already committed.

### D3. Keep `.claude/settings.local.json` out of git via `.git/info/exclude`

- **Decided:** Added `.claude/settings.local.json` to `.git/info/exclude`, the local, uncommitted ignore file.
- **Why:** The folder already contained this per-machine Claude Code settings file. Local settings files can hold personal or secret-adjacent config and should not go to a public repo. Using `.git/info/exclude` keeps the scaffold's `.gitignore` unmodified, as instructed.
- **Alternatives:** Add it to `.gitignore`. This modifies the scaffold, so it's a candidate for a later session. Commit it: rejected.
- **Follow-up:** Consider adding `.claude/settings.local.json` to `.gitignore` so other clones are protected too.

### D4. Rename the default branch `master` → `main`

- **Decided:** `git branch -m master main` before creating the GitHub repo.
- **Why:** The scaffolder or `app init` created `master`, but the instructions say to push `main`. The rename happened before any remote existed, so nothing else was affected. The deploy recorded `branch: main`.
- **Alternatives:** Push `master` and rename later on GitHub. This adds churn and contradicts the instructions.

### D5. GitHub repo created with `gh repo create --source=. --remote=origin --push`

- **Decided:** One command created the public repo `FranciscoIturriaga/skillclash`, set `origin`, and pushed `main`.
- **Why:** The active `gh` account is `FranciscoIturriaga`. A second logged-in account, `FranciscoIturriaga16`, is inactive and was not used.
- **Alternatives:** Separate `gh repo create`, `git remote add`, and `git push` steps. The result is the same.

### D6. Local dev on port 5180, tests on port 5181

- **Decided:** `npx deepspace dev start --port 5180` and `npx deepspace test run --port 5181`.
- **Why:** Port 5173 was held by an unrelated project's Vite server (`~/Developer/HAVEN/haven-web-app/admin`). `dev start` refused with `port_in_use`, and its shipped action was `dev kill --port 5173`. Running that would have killed another project's server, and the DeepSpace skill says never to kill a sibling session's server. The refusal itself offers `--port <other>` as the alternative. `test run` starts its own web server, so it needed a second free port while dev was running.
- **Alternatives:** Run the shipped `dev kill` action. Rejected because it would kill another project. Stopping the dev server before tests also works.

### D7. First deploy claimed GitHub source

- **Decided:** Deployed only after `npx deepspace status --json` reported `sourceInference: "github"` and the working tree was clean.
- **Result:** `serving: confirmed`, `dataPlane: confirmed`, `https://skillclash.app.space`, release `rel_01M87XX27THVJQFXD2NN53TM0Y`. `npx deepspace app source --json` shows `{"provider":"github","repository":"franciscoiturriaga/skillclash"}`, revision 1. This is permanent.
- **Implication:** `deepspace push/pull/clone` and workspace verbs will now refuse with `source_managed_by_github`. Deploys ship the local working tree, dirty bytes included, so commit before deploying to keep releases traceable.

---

## Research findings that change the plan

### D8. Video visibility needs a "reveal" step. Neither built-in file scope fits on its own.

- **Finding:** `useR2Files` has two scopes. `'self'` files are readable only by the uploader (not the opponent, not voters, not even the owner). `'app'` files are public to anyone with the URL.
- **Decided (plan, not built):** Upload round videos under `'self'` scope, so they're hidden while the window is open. Store metadata in a `submissions` collection whose `read` rule is `'published'` with a `visibilityField` (e.g. `revealed: 'yes'`). When the submission window closes, a server action or cron step copies or publishes each video to a location voters can read and flips `revealed`.
- **Open question:** `appFiles` (worker-side) uploads at most 25 MiB per call, so server-side copying of large videos may hit that ceiling. The options to evaluate in the build session:
  - (a) Cap videos at 25 MiB.
  - (b) Upload to `'app'` scope under an unguessable key that lives only in the hidden record. This relies on key secrecy, not access control, and needs a check of whether `'app'` scope can be listed by clients.
  - (c) Declare a custom R2 bucket via custom bindings with our own access checks.
- **Alternatives considered:** `'app'` scope with a plain key. Rejected because videos would leak before the window ends.

### D9. Storage budget: 1 GiB on the current free plan

- **Finding:** The docs say the free plan allows 128 MiB per app, but `npx deepspace app files list` on this account shows `0 B of 1.0 GiB`. The single-file maximum is 1 GiB, with automatic multipart above 20 MiB. Only HTML, SVG, and JS are refused, so video types are allowed.
- **Decided (plan):** Enforce a client-side video cap (duration and size, e.g. ≤60s / ≤25 MiB, which also fits D8 option a). 1 GiB is roughly 40 videos at 25 MiB, which is about 6–7 full battles, so the demo should keep sizes small. Exceeding the cap returns `storage_quota_exceeded` (409).

### D10. No compare-and-set exists. Use `uniqueOn` as the concurrency guard.

- **Finding:** `ActionTools.update(collection, id, patch)` has no version or precondition parameter, according to the installed `node_modules/deepspace/dist/worker.d.ts` (0.44.2). The full docs corpus has no CAS, optimistic-concurrency, or transaction API. A `tools.get` followed by `tools.update` is therefore racy.
- **Decided (plan):** Implement the "expected-state check" from GAME_RULES as a `battle_transitions` collection with `uniqueOn: ['battleId', 'fromVersion']`. The Durable Object checks `uniqueOn` on every create before writing. A server action:
  1. reads the battle at version N
  2. runs the pure state machine
  3. creates a transition row `(battleId, fromVersion: N)`. Only one concurrent caller can succeed; the loser gets a `Duplicate` refusal and returns a conflict error.
  4. updates the battle to version N+1

  If step 4 fails after step 3, the next cron sweep or action can repair it by replaying the recorded transition, which must be idempotent.
- **Alternatives:** Plain get-then-update. Rejected because simultaneous accepts or submits could both succeed. A custom Durable Object with in-memory serialization would be stronger but goes beyond the scaffold.

### D11. Deadlines are enforced by a once-per-minute sweep plus lazy checks

- **Finding:** Cron tasks are declared in `src/cron.ts` with `intervalMinutes: N` or a 5-field cron + IANA timezone. The finest granularity is 1 minute. There are no per-record one-shot timers. A schedule arms on the app's first request after deploy (deploy sends one). A thrown error in a task shows up as a `log` line, not an `exception`.
- **Decided (plan):** Add one `battle-sweep` task with `intervalMinutes: 1` that advances any round whose deadline has passed: submit → vote → closed. It goes through the same state machine and D10 guard, so it is idempotent. Server actions also check deadlines lazily on every call, so state is correct even between sweeps. The UI shows deadlines from stored timestamps, not from the sweep.

### D12. Voting goes through a server action, not direct client writes

- **Finding:** `uniqueOn` plus a `userBound` user column gives one row per user per round, enforced server-side. RBAC cannot express "competitors in this battle cannot vote" or "voting window is open".
- **Decided (plan):**
  - A `votes` collection with `uniqueOn: ['roundId', 'voterId']`, `voterId` `userBound` + `immutable`.
  - Member `create: false` and `read: 'own'`, so clients cannot write votes directly or see others' votes.
  - A `castVote` server action that checks the caller is signed in, is not a competitor, and that the round is in the voting window, then `tools.create`s the vote. It also increments a live `totalVotes` on the round record.
  - Per-player tallies are written to a results record that stays hidden via `visibilityField` until voting closes.
- **Alternatives:** Client `useMutations().create` on votes with `uniqueOn`. Rejected because it can't block competitors or enforce the window.

### D13. Email sender address: trust the live catalog over the docs

- **Finding:** The docs say to send as `skillclash@app.space`. The live `npx deepspace integrations info email/send` says the sender is always `DeepSpace Apps <notifications@updates.app.space>` and any `from` is ignored. Cost is $0.013 per email, billed to the owner's credits (500 free credits = $5 ≈ 380 emails).
- **Decided (plan):** If we add email notifications (challenge received, round revealed), expect the fixed sender and put SkillClash branding in the subject and body. Treat email as optional for the MVP.

---

## MVP build session — 2026-11-24

### Decisions handed to me by the product owner

#### D14. Video reveal: "public with link" files, key hidden until reveal (resolves D8)

- **Decided (by owner):** Videos upload as public-with-link files (`'app'` scope) under an unguessable key. The key is stored only on a `submissions` record that the server hides from everyone except the uploader until the round's submission window ends; then it is revealed.
- **Accepted tradeoff:** A player could share their own link early. That only helps their opponent.
- **Alternatives (from D8):** copy from `'self'` scope at reveal (25 MiB server-side cap), or a custom R2 binding with our own access checks (more work).

#### D15. Concurrency: transitions table (confirms D10)

- **Decided (by owner):** One accepted transition per battle version via a `battle_transitions` collection with `uniqueOn: ['battleId', 'fromVersion']`. A second concurrent attempt gets a conflict error.

#### D16. Upload limits: 20 seconds, 50 MB, `accept="video/*"`

- **Decided (by owner):** Client-side checks for ≤20 s duration and ≤50 MB size, with a clear error. A plain file input with `accept="video/*"` so phones offer "record" or "choose from library". A hint tells players to record in 1080p.
- **Note:** This replaces the ≤60 s / ≤25 MiB plan in D9. 1 GiB of storage ≈ 20 videos at the 50 MB cap, about 3 full battles at worst; typical 20 s phone clips are 10–40 MB.

### Phase 1: state machine

#### D17. When skills are named

- **Decided:** Player A names round 1's skill in the challenge. Player B names round 2's skill when accepting (it must differ from round 1, compared case-insensitively after trimming). Round 3 is freestyle: each player types their skill name on their own submission.
- **Why:** GAME_RULES says who picks, not when. Naming at challenge/accept time avoids extra "waiting for skill" phases with their own deadlines and missed-deadline rules, which GAME_RULES does not define.
- **Alternatives:** A separate skill-picking phase before rounds 1 and 2, with its own timer. Rejected: more states, and the rules don't say what happens if the picker never picks.

#### D18. Rounds run one after another

- **Decided:** Round N+1's submission window opens at the moment round N closes (after its voting, or immediately on a forfeit / both-missed). A Standard battle where everyone submits late takes up to 3 × (12 h + 3 h) = 45 h.
- **Why:** GAME_RULES doesn't say whether rounds overlap. Sequential is the simplest model to explain and test, and players see the previous result before the next round.
- **Alternatives:** Open round N+1's submissions as soon as round N's voting opens (faster battles, but two live phases at once).

#### D19. Late sweeps are anchored to the deadline, not to "now"

- **Decided:** When a submission or voting deadline is processed, the round closes at the deadline timestamp, and the next round's deadline is computed from that timestamp. A sweep that runs 45 s late produces exactly the same state as an on-time one.
- **Why:** Makes the cron sweep and the lazy checks deterministic and idempotent, and lets a long-idle battle be caught up by looping `dueAction` until it returns null.

#### D20. Battle winner = more round points

- **Decided:** Overall winner is whoever has more round points; equal is a draw. Since every round is either 10/0, 5/5, or 0/0, this is identical to comparing round wins.
- **Why:** GAME_RULES says "overall win" without defining it; both readings give the same answer.

#### D21. Machine API shape

- **Decided:** `createBattle(input, now)` and `transition(state, action, now)` both return `{ ok: true, state, events } | { ok: false, error: { code, message } }`. Actions: `accept`, `decline`, `submit`, `submissionDeadline`, `closeVoting` (with the vote tally, since counting votes needs the database). `dueAction(state, now)` tells callers which deadline action is due. `events` (`battle_started`, `round_revealed`, `battle_completed`, …) let callers send emails without diffing states.
- **Alternatives:** One generic `tick` action. Rejected: closing votes needs a tally the pure module can't fetch, so the caller has to know which deadline it is handling anyway.

#### D22. Test mode: 3 min submit / 20 s vote, hidden from the UI

- **Decided:** A `test` mode in `src/battle/modes.ts` with `hidden: true`. The challenge picker only shows it when the page URL has `?test=1`; the server accepts it from anyone (a test battle is harmless).
- **Why:** The two-user Playwright test has to play a round, vote, and see results within a test timeout. 3 minutes leaves room for uploading; 20 s of voting keeps the test short.
- **Alternatives:** Allow it only in dev builds. Rejected because the e2e test may run against a deployed build later.
- **No invite expiry:** an unanswered challenge stays `invited` forever. GAME_RULES has no rule for it; out of MVP scope.

### Phase 2: data, permissions, server actions

#### D23. Usernames live in their own public `usernames` collection

- **Decided:** `usernames` (record id = user id, `uniqueOn: ['username']`, public read, no client writes) is the source of truth for names. `users.username` is a private mirror written by the same `setUsername` action.
- **Why:** The `users` collection reads `'own'` and contains email, so it can't be made public for opponent search. A separate table gives a database-enforced unique name that anyone can look up without exposing user rows.
- **Alternatives:** Make `users` publicly readable (leaks email), or search through a server action over `users` (more code, still needs a uniqueness guard).
- **Names can change:** `setUsername` upserts the same row, and battles store user ids, so a rename just changes what's displayed.

#### D24. Transition conflicts: re-validate up to 3 times, then report

- **Decided:** `runAction` re-reads the battle and re-runs the machine after a lost claim (another write took that version). After 3 lost claims it returns `conflict` ("This battle is busy right now. Try again."). An action that's no longer valid after the re-read (e.g. a second accept) gets the machine's normal error.
- **Alternatives:** Fail on the first conflict (worse UX when the cron sweep and a player collide).

#### D25. Half-finished transitions are repaired from the claim row

- **Decided:** A transition is "claim row in `battle_transitions` (holds `toState`), then write the battle". If the write fails after the claim, the next action or sweep finds a claim for the battle's current version and writes its `toState`.
- **Why:** Without compare-and-set there's no atomic multi-row write; this makes the claim the commit point. Replaying is idempotent and only happens when the battle is still at the claimed version, so it never moves a battle backwards.
- **Known gap:** The cron sweep only looks at `active` battles, so a stuck accept/decline (still `invited`) is repaired on the next action that touches it, not by cron.

#### D26. Submissions: write the hidden row first, then commit the transition

- **Decided:** `submitVideo` dry-runs the machine, upserts the submission (`revealed: 'no'`, id `<battle>_r<n>_<side>`), then commits. Reveal only flips sides the state machine counted as submitted.
- **Why:** If the commit loses or fails, the row stays hidden forever instead of leaking. The dry run stops a refused second upload from overwriting an accepted one.

#### D27. Votes are tallied 3 s after the voting deadline

- **Decided:** `closeVoting` is applied only once `now >= voteDeadline + 3s`. `castVote` refuses at `now >= voteDeadline`.
- **Why:** A vote accepted a millisecond before the deadline may still be in flight when the deadline passes; the grace keeps it from being missed by the tally.

#### D28. Live total vote count is recounted on every vote

- **Decided:** After a successful vote, `castVote` counts that round's votes and writes `rounds.totalVotes` (public). Per-side counts are never stored anywhere public until `closeVoting` puts them into the battle state.
- **Why:** A recount heals itself if two votes race (last writer still writes a correct count, or the next vote fixes it). An increment would need compare-and-set.

#### D29. The files proxy guards public-with-link (`scope=app`) files

- **Decided:** `src/server/files-guard.ts` runs inside the app's `/api/files/*` proxy. For non-owners on `scope=app`: single-file GET is allowed (the public link), listing is refused, uploads must use `videos/<caller id>/<16–64 random chars>.<ext>`, multipart continuation is allowed, deletes are refused. `submitVideo` checks the key has the same shape for the caller.
- **Why:** The secret in D14 is the file key. Without this guard anyone could list app files and find unrevealed videos, delete an opponent's video, or point a submission at someone else's file.

#### D30. Profile stats are computed, not stored (superseded by D56, 2026-11-25)

- **Superseded:** profile stats are now stored by the server (D56), because the feed sort (D58) needs every player's points without loading their battles. The text below is the original decision.
- **Decided:** Battles played, W/L/T, round wins and total points are computed on the client from the player's completed battles (`state.result` already holds per-side totals).
- **Why:** No counters to keep in sync, no extra write per battle end, and a rules change recomputes history. Fine at MVP scale (a player has tens of battles, not thousands).

#### D31. Who can read what

- **Decided:** Anyone, signed in or not, can read `battles`, `rounds` and `usernames` (they hold nothing secret). `submissions` are readable by the uploader, and by everyone once revealed; admins get no exception. `votes` read `'own'`. `battle_transitions` is admin-only. No role can write any game collection from a client.
- **Why:** Battles in voting are meant to be watched and shared. The admin exception was removed so that "hidden until reveal" holds for everyone, including the app owner's own account.
- **Left as scaffold:** members can still update their own `users` row (display name, etc.). That row has no game data.

#### D32. Test accounts not created by the agent

- **Decided:** Creating the three `@deepspace.test` accounts for the multi-user test was blocked by the session's permission rules, so the owner has to create them (commands in PROJECT_NOTES.md). The spec skips itself when fewer than 3 usable accounts exist.
- **Update (2026-11-24):** the owner created them: `fi-skillclash-a@deepspace.test` ("Player A"), `fi-skillclash-b@deepspace.test` ("Player B") and `voter-c@deepspace.test` ("Voter C"). `player-a@`/`player-b@` were already taken in the global pool. See D42.

## Phase 3: UI

### D33. `battleId` column on battles
- **What:** battles carry a `battleId` column equal to the record id.
- **Why:** client `useQuery` `where` only matches data columns, not the record id, so the battle page couldn't subscribe to one battle without it.
- **Alternatives:** query all battles and filter on the client (doesn't scale, leaks nothing but wastes bandwidth).

### D34. Own visual identity
- **What:** one dark "arena" theme (near-black, acid-lime accent `#c8ff2e`, cyan for the challenger, pink for the opponent), Barlow Condensed for display type and Inter for body text, loaded from Google Fonts. The scaffold's paper theme was removed.
- **Why:** the brief asks for a sporty match-screen feel; corner colours make "who is who" readable at a glance.
- **Alternatives:** keep the theme switcher with several themes (more surface to test, no product value now).

### D35. Write controls gated on data readiness, not `useMutations().ready`
- **What:** buttons that write are disabled until the page's `useQuery` is `ready` and the user is signed in.
- **Why:** every write is an HTTP server action (`/api/actions/*`), not a record mutation, so `useMutations().ready` doesn't describe whether a write can succeed. Readiness of the data the button acts on does.
- **Alternatives:** also wait for `useMutations().ready` (it would add a dependency on the WebSocket that the action doesn't need).

### D36. Pages nudge the server when a countdown hits zero
- **What:** when a submit or vote countdown expires, a signed-in viewer's page calls `syncBattle` (after 1.5 s, or 3.5 s for votes to clear the settle grace).
- **Why:** the cron runs once a minute; without the nudge a viewer would stare at 0:00 for up to a minute. `advance` is idempotent, so many viewers calling it at once is safe (losers get a conflict and re-read).
- **Alternatives:** wait for the cron only (slow), or let anonymous viewers trigger it too (actions require a signed-in caller).

### D37. Username directory loaded once per session
- **What:** `UsernamesProvider` subscribes to the public `usernames` collection once and maps id ↔ name for every page. Opponent search filters it on the client. `UsernameGate` shows the "pick your tag" screen to a signed-in user with no username.
- **Why:** usernames are small and public; one subscription is cheaper and simpler than a lookup per card.
- **Alternatives:** a search server action (needed once there are many thousands of players).

### D38. Vote status via `myVote`
- **What:** whether the viewer already voted comes from the `myVote` action, not a client query.
- **Why:** votes are `read: 'own'`, but keeping the client off the votes collection entirely is simpler to reason about; the action already exists.
- **Alternatives:** `useQuery('votes', { where: { roundId, voterId: me } })`.

### D39. Your own submitted video is shown back to you
- **What:** after submitting, the player sees their own video under "Submitted. Hidden from everyone until the round ends."
- **Why:** reassurance that the upload worked; the RBAC rule already lets the uploader read their own row.
- **Alternatives:** show only a checkmark.

## Phase 4: email

### D40. Two emails through `email/send`, sender fixed by the platform
- **What:** "You've been challenged" goes to the opponent from the `challenge` action. "Battle result" goes to each player (personalised: won/lost/draw and the score) from the event hook when `battle_completed` fires. Both have HTML and plain-text bodies and link to the battle page.
- **Sender behaviour observed:** `npx deepspace integrations info email/send` (live CLI) says it sends from `DeepSpace Apps <notifications@updates.app.space>` and that any `from` value is ignored. So the code sends no `from` at all. Replies would need `reply_to`; we don't set one. Billing is `developer` mode (owner pays, $0.013 per email): the result email costs $0.026 per battle.
- **Exactly once:** the hook only runs for the caller whose transition claim won (D10), so a completed battle triggers one result email per player even when the cron and a viewer's sync race.
- **Privacy:** recipient emails are read server-side from `users` and never returned to clients or logged (logs carry only battle id and side).
- **Not verified live yet:** no real email has been sent, because the two-user flow needs test accounts (D32). After the owner plays a battle, `npx deepspace logs --search email` shows `[email] ... sent id=...` or the failure.
- **Alternatives:** an email per round (noisy, more cost); a digest via cron (more moving parts).

## Phase 5: tests and verification

### D41. One 3-user spec plays a whole battle
- **What:** `tests/battle.spec.ts` uses `users(3)`. A challenges B in test mode, B accepts, both upload `tests/fixtures/clip.webm` (2 s, 9 KB) each round, C votes in round 1, then a duplicate vote and a competitor vote are both refused, round 1's result appears after voting closes, rounds 2–3 end as 0–0 ties, and the final score must be 30:10.
- **Why WebM:** Playwright's Chromium has no H.264 decoder, so an MP4 would fail the client's duration check.
- **Why a dev-only `window.__callAction`:** the UI never shows a vote button to a competitor or a second vote button, so the only way to prove the *server* refuses those votes is to call the action as that user. It is only defined under `import.meta.env.DEV`, and it carries the same token the UI uses, so it grants nothing new.
- **Status:** skips until 3 test accounts exist on this machine (D32).
- **Alternatives:** a raw `request` call with a token taken from storage state (couples the spec to the auth implementation).

### D42. Fixes from the first run with real accounts
First `npx deepspace test run all` with accounts: 9 passed, 3 failed (the battle spec and two scaffold collab specs). Fixes:
- **Spec asks for accounts by name.** `users(['Player A', 'Player B', 'Voter C'])` instead of `users(3)`, because the roles (challenger, opponent, voter) matter and the pool may hold other accounts. It skips naming whichever accounts are missing.
- **Username gate moved inside `<main>`.** It used to replace the whole app shell, so a new player saw no nav (couldn't sign out), and the collab spec couldn't find `app-navigation`. Now only the page area shows the picker.
- **Gate waits for the username list.** It used to render the page while `usernames` was still loading, then swap to the picker. The spec saw the page, decided no picker was coming, and then failed at `/me`. Users would have seen the same flash. Now a signed-in user sees an empty loading area until the list arrives.
- **`/settings` and `/api-status` are exempt from the gate.** They're account and debug pages that don't need a username, and the scaffold's api-status spec runs with whichever account it gets.
- **Spec waits for the picker or the home page's "New challenge" button**, which only renders once the gate has decided, instead of the nav.
- **Cost note:** each run of the battle spec sends real emails through `email/send` (1 challenge + 2 results ≈ $0.04) to the `@deepspace.test` addresses.
After the fixes: 12 passed, 0 failed, 0 skipped; 47 unit tests pass.

## Phase 6: pre-deadline fixes (2026-11-25)

### D43. Video player URLs use the full stored key (root cause of blank videos)
- **Symptom:** revealed videos showed a blank player at 0:00 on the live site, for a Photo Booth .mov and an iPhone .mov alike.
- **Diagnosis (live, before the fix):** the `<video>` src was `/api/files/videos/<uid>/<file>.mov?scope=app`. Requesting it the way the tag does (same-origin, session cookie, no bearer) returned **403 `application/json` `{"error":"Access denied: key outside scope"}`**, with or without `Range`. The 403 came from the platform, not from our guard. The same file at `/api/files/apps/<appId>/videos/...` returned 200 `video/quicktime`, `Accept-Ranges: bytes`; with `Range: bytes=0-` it returned **206** with `Content-Range: bytes 0-14686103/14686104`. So the proxy already passes Range through and keeps the headers.
- **Cause:** submissions store `upload().relativeKey` (`videos/...`, the form `upload({key})` and `list` take), but `getUrl()` needs the full stored `key` (`apps/<appId>/videos/...`). The docs say so (files reference: "`key`: what download, delete and getUrl take; `relativeKey`: what upload({ key }) and list take").
- **Fix:** `VideoPlayer` builds the URL from `fullFileKey(fileKey)`, which adds `apps/<APP_ID>/` when missing. Stored rows keep the relative key (the server's key-shape check and existing data depend on it), so old submissions play without a migration.

### D44. The files proxy only serves a video to its uploader until it's revealed
- **Decided:** for a single-file GET/HEAD on `scope=app`, `guardAppFiles` lets the uploader (`videos/<their id>/…`) through. For anyone else, the app owner included, it returns `revealCheck`, and the route serves the file only if a submission with that exact `fileKey` has `revealed: 'yes'`. Otherwise it returns 404, the same answer whether the file exists or not. Positive lookups are cached per isolate (a reveal never goes back), so a player's many Range requests cost one query. Paths with `..`, backslashes or bad encoding are refused.
- **Why:** before this, hiding a video depended only on the key staying secret (D14). The task asked that unrevealed videos be unavailable to everyone except the uploader, so the file read now checks that too. Revealed videos stay public, as battles are meant to be shared (D31).
- **Tested:** `tests/battle.spec.ts` takes A's round 1 video URL from A's page before reveal: A gets 206, B and C get 404. After reveal, all three get 206. Unit tests cover the guard's decisions.
- **Limit:** this covers reads through the app's `/api/files` proxy. If the platform serves `scope=app` files on another host, that path isn't covered; the key is still unguessable (24 random chars).

### D45. Feed cards show the current round's skill
- **Decided:** `BattleCard` labels a battle with the round being played or voted on (`currentRoundState`, which is "Freestyle" for round 3), falling back to round 1 before the battle starts.
- **Was:** it always showed round 1's skill.

### D46. Battle page round order: current, then past newest first
- **Decided:** one rule for players and voters, in the pure `roundDisplayOrder` (view.ts, unit tested): the current round on top, expanded; then closed rounds newest first, collapsed (`<details>`) to a one-line summary of each player's votes/result and points; then rounds not reached yet. A finished battle shows the result panel, then rounds 3, 2, 1, all collapsed.
- **Why `<details>`:** native, keyboard-accessible, no state to keep. Collapsed content stays in the DOM, so links and test ids inside still exist.

### D47. One open battle per pair *(now per pair per mode, D64)*
- **Decided:** `challenge` refuses with `open_battle_exists` and "You already have an open battle with @username." when the two players already have an `invited` or `active` battle in either direction. The check (`findOpenBattle`) is pure and unit tested. The spec checks both directions against the server.
- **Known gap:** it's a read-then-write check, not a database constraint, so two challenges sent within milliseconds of each other could both pass. A unique "pair lock" row would close that but needs releasing on decline and completion. Not worth the risk before the deadline.
- **Interaction:** a sent invite can't be cancelled by the challenger and never expires, so an ignored invite blocks the pair until the opponent declines or accepts. The battle spec now declines B's leftover invites before challenging. *(Superseded by D50 and D51: invites can now be cancelled and expire after 24h.)*

### D48. Test-mode battles send no email
- **Decided:** `emailsEnabledFor(state)` is false for `modeId === 'test'`. Both the challenge email and the result emails are skipped, and the skip is logged (`[email] ... skipped (test mode)`).
- **Why:** test runs were spending owner credits (about $0.04 per battle spec run) and mailing `@deepspace.test` addresses.

### D49. iPhone video format: H.264, not HEVC. No HEVC fallback built
- **Finding:** the live iPhone upload (`biBS3…mov`, iPhone 14) is H.264 (`avc1`) 1920×1080 with AAC audio, plus Apple metadata (`mebx`) tracks that browsers ignore. The Photo Booth upload is also H.264 (1620×1080). Both played as 403s because of D43, not because of their codec.
- **Decided:** the requested fallback message and uploader hint were conditional on HEVC being the problem. It isn't, so neither was built (no scope added on deadline day).
- **Known limitation:** an iPhone set to "High Efficiency" can record HEVC (`hvc1`), which desktop Chrome may not decode depending on OS and hardware. Such a video would show a blank player in that browser. Workaround: on iPhone, Settings > Camera > Formats > Most Compatible. No transcoding.

## Phase 7: cancel, expiry, past-round view (2026-11-25)

### D50. The challenger can cancel an unanswered invite
- **Decided:** new machine action `cancel` (by the challenger only, only while `invited` and before the invite deadline) moves the battle to a new final status, `cancelled`. It goes through the same path as every other change: the `cancelChallenge` server action calls `runAction` (lazy deadline check, then the `battle_transitions` claim, D10). Errors: `wrong_player` for anyone but Player A, `wrong_status` once answered/cancelled, `invite_expired` at or after the deadline.
- **UI:** "Cancel challenge" with an inline confirm ("Keep it" / "Yes, cancel") on the challenger's invite panel and under each card in "Sent challenges". The control sits outside the card's link, so there's no button inside an `<a>`. The opponent's page says "@a cancelled this challenge"; both players see it under Finished with the label "Cancelled".
- **Pair rule:** `cancelled` isn't in `OPEN_STATUSES`, so the pair can challenge again at once (tested in the browser spec).
- **No email** for a cancel: the event hook only reacts to `battle_completed`.
- **Accepting a cancelled invite** now says "The challenger cancelled this challenge." instead of the generic "already answered".

### D51. Invites expire after the mode's invite window (24h in Standard)
- **Decided:** each mode has `inviteWindowMs` (Standard 24h, Test 5 min). `createBattle` stores `inviteExpiresAt = createdAt + inviteWindowMs` in the battle state, and `rowFromState` mirrors it into the row's `nextDeadline` while the battle is `invited`. A new time-driven action `inviteExpiry` moves the battle to `expired`, stamped with the deadline itself (`respondedAt = inviteExpiresAt`), so a late sweep gives exactly the same state as an on-time one.
- **Exactly at the deadline** the invite is expired: `dueAction` returns `inviteExpiry` when `now >= inviteExpiresAt`, and accept/decline/cancel at that moment fail with `invite_expired` even before any sweep runs. One millisecond earlier, B can still accept.
- **Who applies it:** the every-minute cron sweep now reads `invited` battles as well as `active` ones and advances any battle `dueAction` says is due; `advance` (the lazy check every action runs) handles `inviteExpiry` like the other deadlines. Both are idempotent: an expired battle has nothing due, and a second `inviteExpiry` is refused with no change. The battle page also calls `syncBattle` when the countdown reaches zero.
- **Battles created before this change** have no `inviteExpiresAt`. `inviteDeadline()` falls back to `createdAt + inviteWindowMs`, and the sweep decides from the state (not `nextDeadline`, which is null on those rows), so old invites older than 24h expire on the first sweep after deploy.
- **Pair rule:** `expired` frees the pair. `findOpenBattle` also ignores an `invited` row whose `nextDeadline` has passed, so a lapsed invite doesn't block a new challenge in the up-to-a-minute gap before the sweep marks it.
- **UI:** "Expires in 23h" (coarse, rounded down; minutes under an hour) on invite cards and the invite panel. Expired battles say "This challenge expired: @b didn't answer in time." and show under Finished as "Expired".
- **No email** for expiry.
- **Schema:** `battles.status` select options gain `cancelled` and `expired`.

### D52. Expanded past rounds don't repeat the summary
- **Decided:** a closed round is always shown collapsed under summary chips that already hold each player's votes/result and points (D46). Expanded, it now adds only the videos and round 3's skill names. Removed from the expanded view: per-player vote counts and points, the round total, and the "takes the round" line. A player who missed the deadline gets one short full-width row ("@name · Missed the deadline · +0 pts") instead of a tall empty video box. If both missed: "Both players missed the deadline. No points awarded."
- **Focus:** the round header (`<summary>`) has no outline on tap/click and no mobile tap highlight; keyboard focus shows the same 3px `ring-ring/50` ring the Buttons use (`focus-visible` only).
- **Mobile:** the video grid is one column below `sm` (two only when both filmed, on wider screens); cards and tags have `min-w-0` and long skill names wrap. The browser spec checks at 375px that the cards stack, the video spans the card minus its padding, and the page has no horizontal overflow.
- **Tests:** the spec now reads round results from the summary chips (`round-N-summary`), since the old outcome line is gone.

## Phase 8: set-and-match rounds 1–2 (2026-11-25)

### D53. Setters film first; unrevealed skills live on hidden rows, not in the battle state
- **Rules:** A names round 1's skill and must upload its video to send a challenge; B names round 2's skill (different, case-insensitive, checked on the server) and must upload its video to accept. B's invite shows only "@A challenged you", the mode and the expiry. Round 1 opens on accept with A's skill and video revealed; A's video counts as A's submission, so B's submit ends the window and opens voting at once; B missing the deadline forfeits the round to A. Round 2 mirrors it when round 1 closes. Round 3, voting, scoring, bonus, cancel, expiry and the pair rule are unchanged.
- **Storage (the security part):** the `battles` row is readable by everyone, so it must not hold an unrevealed skill. New battles carry `state.rules = 2` and `rounds[0].skill = null` at creation. Each setter's skill and video key live on their own submission row (`<battleId>_r1_a`, `<battleId>_r2_b`, in the existing `skill` column), which is owner-only until `revealed = 'yes'`, like every submission (D44). The files proxy keeps refusing the video to anyone else until that row is revealed.
- **Opening a round:** the server reads the setter's skill from the hidden row and passes it in the action that opens the round: `accept.round1Skill`, or `nextSkill` on `submissionDeadline`/`closeVoting` (`nextSkillFor` in service.ts). The machine writes it into `rounds[n].skill` and marks the setter submitted (`openRound`). The `same_skill` check therefore runs in the machine with round 1's skill supplied by the server; B never receives it. The accept transition's stored `toState` holds only round 1's skill (public at that moment); round 2's is never in any state until round 2 opens.
- **What gets revealed when:** `publicSubmissions(state)` (machine.ts) is the one rule: every counted video of a round whose window ended, plus a setter's video as soon as its round opens. `revealEndedRounds` applies it after every transition. The replicator's video stays hidden until they submit, which ends the window anyway.
- **Order of writes:** `challenge` and `acceptChallenge` validate the transition and the video first, write the hidden setter row, then commit the transition through `runAction` (transitions table, D10). If the commit loses, the hidden row is an orphan nobody can read (same pattern as `submitVideo`).
- **Email:** the challenge email no longer names the skill.
- **UI:** "Show them the skill: record it now" upload in the challenge form and the accept panel; the replicator sees the setter's video in a "Match this" box above their upload; the setter sees "You set this skill. Waiting for @X to match it." Pending rounds show their skill and video only to their setter.
- **Tests:** machine tests cover the setter pre-submitted, replicator-only deadlines in rounds 1–2, round 3 unchanged and `publicSubmissions`. The browser spec records every HTTP response and WebSocket frame B, C (and A for round 2) receive and checks the unrevealed skill never appears, with a positive control once it is revealed; it also checks the setter video URLs return 404 to the others before the round opens and 206 after.
- **Known gap:** setter videos stay in storage when a challenge is declined, cancelled or expires (TODO in PROJECT_NOTES).

### D54. Old battles: finish active ones under the old rules; old open invites can't be accepted
- **Simplest safe option:** a battle without `state.rules` is a legacy battle and keeps the old flow end to end (both film blind every round, skills already public in the state). `setterOf` returns null for it, so nothing new applies. The last prod sweep before this change logged 2 active battles and 0 open invites.
- **Legacy invites:** accepting one would need a round 1 video that doesn't exist, so `accept` refuses it with `legacy_invite` ("This challenge was sent under the old rules. Ask for a new one."). B can still decline and A can still cancel, and invite expiry frees the pair within 24h anyway. The invite panel shows that message and disables Accept.
- **No data migration:** nothing on the live site is rewritten.

### D55. Accept panel report: stale tab, plus compact per-viewer locked rounds and a reload banner
- **Finding:** the report (no video picker in the accept panel, "Round 1 skill: . Accept by picking round 2's skill.", "Unlocks when round 0 ends") matched the pre-D53 client. The live bundle after the D53 deploy already had the picker ("Show them the skill: record it now", 20 s / 50 MB / `accept="video/*"` / 1080p hint) and none of that copy; the server error "Record or choose a video first." came from the new server. So the tab was still running the old JS against the new server.
- **Decided, stale tabs:** `UpdateBanner` (app layout, production only) compares the page's `/assets/index-*.js` with the one `/home` now serves, on focus and every 5 minutes, and shows "SkillClash was updated. Reload to get the latest version." with a Reload button. No forced reload, so nobody loses a half-filled form.
- **Decided, copy:** the accept panel says "{mode} mode. Accept by recording your round 2 skill. You'll see their skill when round 1 starts." It never mentions round 1's skill.
- **Decided, locked rounds:** every pending round is one compact row (R{n}, one line of copy, lock icon) instead of a tall card, so the live panel stays the focus. Copy comes from `lockedRoundCopy()` (view.ts, unit tested) and depends on the viewer:
  - Round 1: B "Set by @A. Revealed when you accept"; A "Your skill: X. Revealed to @B when they accept"; others "Revealed when the battle starts".
  - Round 2: B "You'll set this when accepting" (then "Your skill: X. Revealed to @A when round 2 starts"); A "Set by @B. Revealed when round 2 starts"; others "Revealed when round 2 starts".
  - Round 3: "Freestyle. Opens after round 2".
  - Legacy battles (D54) show their public skill plus "Opens when the challenge is accepted" / "Opens after round 1".
  - A setter's own hidden video sits under a "Watch your skill video" disclosure on the row (round 1's stays in A's invite panel).
- **Tests:** the browser spec checks B's invite shows the uploader (visible button, hint, `accept`), picks a file through it, shows the per-viewer locked copy, and has no "round 0" and no round 1 skill text; the challenge form check is the same.

## Phase 9: stored stats and the reels feed (2026-11-25)

### D56. Player stats are stored by the server: a ledger plus a recount
- **Collections:** `stats_entries` is the ledger: one row per player per completed battle (points, played, won, lost, tied, roundWins), with `uniqueOn [battleId, playerId]`; admin read only. `player_stats` is the public row per player (record id = user id), readable by everyone, written by no client. Both are `NO_WRITES` for every role.
- **Write path:** the event hook (`makeEventHook`, notify.ts) calls `recordBattleStats` when `battle_completed` fires, which only happens for the transition claim that won (D10). `repairIfStuck` also calls it when it replays a completion, since repairs fire no events. `statsEntriesFor(battleId, state)` (pure, stats.ts) reads `state.result`: points = `total[side]`, won/lost/tied from `winner`, round wins from `roundWins[side]`. Forfeits and both-missed rounds are already in the result, so they need no special case.
- **Idempotent:** a replayed completion, a repair or the backfill hits the ledger's `uniqueOn` and gets a Duplicate, which counts as "already counted". `player_stats` is then recomputed as the sum of the player's ledger rows (an upsert keyed on the user id), never incremented. With no compare-and-set (D10), a recount heals itself; same idea as the live vote total (D28).
- **Known gap:** if two of one player's battles complete at the same instant, one recount can read the ledger before the other's row lands and write a stale total. The next battle, repair or backfill run fixes it. Acceptable at this scale.
- **Backfill:** the cron sweep calls `runStatsBackfillOnce` first. If the `app_migrations` row `stats-backfill-v1` exists, it does nothing. Otherwise it records every `complete` battle through the same ledger and then writes the marker. Running it twice, or after the live hook already counted a battle, counts nothing extra (unit tested). It needs no manual step after deploy and runs within a minute.
- **Failures:** a stats error is logged (`[stats] …`) and never undoes the state change or blocks the result email.
- **Profile:** `/u/<username>` reads `player_stats` (shows "–" while loading and zeros for a player with no row). `profileStats` (client count) is removed.

### D57. "Voting now" cards are reels: one video at a time, vote from the feed
- **Layout:** the card keeps the battle header (status, countdown, players, score, skill name), which still links to the battle page. Under it is a horizontal scroll-snap track with two slides, one per player: "@name's video" label, round 3's own skill name under it, a 9:16 video (width `min(100%, 70vh × 9/16)`), and "Vote for this". A "1/2"/"2/2" indicator sits top right.
- **Moving:** swipe on touch (native scroll-snap; the slide index is read from the scroll position) or the 44 px prev/next buttons on the sides (disabled at the ends). Off-screen slides get `aria-hidden` and their button `tabIndex=-1`.
- **Voting:** the same `castVote` action and rules as the battle page. Competitors see no buttons and "It's your battle, so you can't vote on it." Signed-out users get "Sign in to vote". After voting, the chosen button reads "You voted", both are disabled, and a line says who you voted for and that counts show when voting closes. Per-player counts are never shown on the card. The viewer's existing vote is fetched (`myVote`) once the card is first on screen.
- **Performance:** a video gets its `src` only once its slide has been on screen (card ≥50% in view and slide current); before that it has no `src` and `preload="none"`. Only the current slide of an in-view card plays. Videos are muted, looped, `playsInline`, no controls (tap to pause/play, a "Tap to unmute" button), never fullscreen.
- **Tests:** the browser spec has C open the feed before voting starts, check 1/2 with the second video not loaded, go to 2/2 and back with the arrows and with synthetic touch swipes, vote for A from the feed and see both buttons locked. In parallel A opens the feed in a second tab and sees the card with no vote buttons. The vote then shows as "1 vote" on A's battle page and decides round 1 as before.

### D58. "Voting now" order: combined stored points, then soonest deadline
- **Decided:** `sortVotingNow` (view.ts, unit tested) orders by `points(A) + points(B)` from `player_stats`, highest first, then by `nextDeadline` ascending (null last). Players without a stats row count as 0.
- **How:** the feed loads up to 50 vote-phase battles and up to 500 `player_stats` rows (public) and sorts on the client. That's fine at this scale; past 500 players, unknown players would sort as 0 and this should move to a server query.

## Phase 10: phone layout, snapping and scroll position (2026-11-25)

### D59. "Voting now" cards fill one phone screen, gentle snap on the page
- **Revised 2026-11-25 (same day):** the first version made `<main>` the scroll container and the "Voting now" list a second, nested scroller with `snap-y snap-mandatory` and `snap-always`, sized with `h-dvh` / `100cqh`. On iPhone Safari that broke: scrolling up out of the top card was trapped inside the list, the address bar showing and hiding fought the `dvh` heights (black gap at the bottom, header partly hidden), tap-the-status-bar-to-top stopped working (it only scrolls the window) and the header could stay cut off after sign-in. **Nested vertical scroll containers break iOS Safari**, so they were removed.
- **Now:** the window is the only vertical scroller. `<html>` has `scroll-snap-type: y proximity`; only "Voting now" slots (`.feed-snap` in `styles.css`) are snap points (`scroll-snap-align: start`, `scroll-margin-top: var(--app-header-h)`), so a snapped card sits right under the sticky top bar and the hero, "Your battles" and every other page have no snap points. No `mandatory`, no `scroll-snap-stop: always`: scrolling up past the first card moves freely. Native pull-to-refresh and tap-to-top work again; we build neither.
- **Size:** each slot is `calc(100svh - var(--app-header-h))`. `svh` (the small viewport, address bar shown) doesn't change as Safari's bars show and hide, so nothing resizes mid-scroll. `--app-header-h` is the sticky top bar's height (nav + update banner when shown), measured by `StickyHeader` in the app layout with a ResizeObserver (49 px default). Inside the card the header is fixed height (`BattleCard compact`) and the video area takes the rest (`flex-1 min-h-0`); the video box is `aspect-[9/16] h-full max-w-full`, `object-contain`, so the label, skill line and "Vote for this" always fit.
- **Horizontal snap (unchanged):** the video track is `snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain`, slides `snap-center snap-always`. Mandatory is fine there because it is horizontal: the browser locks each gesture to one axis, so a vertical swipe that starts on a video scrolls the page. The index is read on `scrollend`, with the 80 ms scroll debounce as fallback.
- **Tests:** at 375×667 and 390×844 the sticky top bar is at y=0, the card header starts below it, the whole card and the vote button are inside the viewport and the video box is 9:16. No element in the header or `<main>` has `overflow-y: auto|scroll`. A synthetic vertical touch swipe starting on a video scrolls the window and leaves the reel on 1/2. The horizontal swipe check waits for the track to sit still first (a touch gesture sent during a smooth scroll is swallowed; browser behaviour).

### D60. Scroll position: new pages start at the top, back/forward restores
- **Problem:** on iPhone, the keyboard on the sign-in screen scrolled the page and the offset carried into the home page, hiding the top bar.
- **Revised 2026-11-25:** `<main>` no longer scrolls (see D59); the window does, and the top bar is `sticky top-0`. `ScrollManager` now works on the window only: `resetScroll()` is `window.scrollTo` to 0, instant (html has `scroll-behavior: smooth`, which would animate it). `history.scrollRestoration = 'manual'` and we keep our own per-entry positions because content loads after the route renders; React Router's `ScrollRestoration` would need a data router.
- **Decided:** a push/replace navigation resets to the top; a back/forward (POP) restores that entry's saved `window.scrollY` (retrying for up to 1 s while content loads). A position is saved only while its entry is the one on screen, so the reset's own scroll event can't overwrite the previous page's position. Signing in resets (now and again after 150 ms, as the overlay closes). While signed out, a field losing focus with no other field taking it (keyboard closing) resets. The home page also resets on mount unless it was a POP.
- **Tests:** a signed-in load of home at 375×667 has `scrollY` 0 and the top bar at y=0; after scrolling the window the bar is still at y=0; opening a battle starts at 0 and back restores the position.

## Phase 11: camera-only recording (2026-11-25)

### D61. Video inputs open the camera on phones
- **Decided:** every video input (challenge form, accept panel, round submissions; all go through `VideoPicker`) has `accept="video/*"` and `capture="environment"`, so phones open the rear camera directly instead of offering the photo library. The button reads "Record video". Desktop browsers ignore `capture` and show a file chooser, so on devices without a coarse pointer the picker adds "Record on your phone for the best experience." The 20 s / 50 MB checks are unchanged (browser and server).
- **This is friction, not anti-cheat.** It nudges players to film live, but anyone can upload an old or edited clip from a desktop, a browser that ignores `capture`, or a modified page. Nothing on the server can tell a fresh recording from an old file. Real verification (in-app recording with a server-issued nonce, metadata checks, review) is out of scope for the MVP.
- **Tests:** the spec checks `capture="environment"` and `accept="video/*"` on the challenge form, accept panel and round inputs, and the desktop hint on the accept panel.

### D62. Tapping the "Voting now" heading jumps to the first card
- **Decided:** when the feed has battles, the "Voting now" heading on home is a `<button>` inside the `h2` (flame, label, down chevron, pointer cursor, hover colour, keyboard focus ring, `aria-label` "Voting now: jump to the first battle"). It calls `scrollIntoView({ behavior: 'smooth', block: 'start' })` on the first slot; the slot's `scroll-margin-top: var(--app-header-h)` puts it right under the sticky top bar, which is also its snap point. While loading or empty it stays a plain heading. There is no "Voting now" link in the nav or menu, so nothing else changed.
- **Tests:** from the top of home at 375×667, the heading is a button with a pointer cursor, and after a click the first slot's top settles at the top bar's bottom edge.

## Phase 12: Rapid Fire, per-mode pairs, demo battle (2026-11-25)

### D63. Rapid Fire mode; rounds, windows and bonus are mode config
- **Decided:** `BattleMode` (modes.ts) now carries `rounds` (1 or 3), `inviteWindowMs`, `submitWindowMs`, `voteWindowMs`, `battleBonus`, plus display fields (`name`, `description`, `badge`) and `emails`. Rapid Fire: 1 round, 5 min invite, 5 min to match, 15 min vote, no bonus.
- **Machine:** `rounds` is an array of the mode's length (was a 3-tuple). "Last round" is `round >= rounds.length`, freestyle is round 3 of a 3-round battle, and `battleResult(outcomes, bonusForMode(modeId))` skips the bonus when the mode has none. No other per-mode branches. In a 1-round battle `accept` needs only round 1's skill (passed by the server from A's hidden row, as before); the round opens with A already submitted and B's 5-minute clock running, so a miss is a forfeit win for A (+10) through the existing setter rules.
- **Server:** `acceptChallenge` writes B's round 2 setter row only when the battle has more than one round; `challenge` creates one `rounds` row per round. Rapid Fire sends the same emails as Standard; the hidden `rapid_test` mode (3 min / 20 s) sends none, like Test.
- **UI:** the challenge form opens with a mode picker (Standard / Rapid Fire, each with its one-line description and timers; `?mode=rapid` preselects). A `ModeBadge` ("Rapid Fire", "Demo", "Test") replaces the old " · test mode" suffix on cards, and shows on the battle page header and so on invites, the feed and profile history. One-round battles drop "Round N" from the status ("Voting", "Your turn"), title the section "The round", and hide the Bonus column in the result. The Rapid Fire accept panel has no skill or video fields, says "your 3/5-minute clock to match it starts immediately", shows a warning box, and the button reads "Accept · start 5 min". Countdowns of a day or more show as "6d 23h".
- **Standard unchanged:** all existing machine tests pass unchanged; new tests cover the Rapid Fire flow, expiry at 5 min, forfeit, ties, no bonus, stats, and that Standard still needs a round 2 skill and keeps 3 rounds and the bonus.

### D64. One open battle per pair, per mode
- **Decided:** `findOpenBattle(rows, x, y, now, modeId)` counts only open battles of the same mode, so a pair can have one open Standard and one open Rapid Fire battle at once, but not two of the same mode. Each mode is its own group (the hidden test modes too). The error is now "You already have an open [mode name] battle with @username." (`mode.name`: "Standard", "Rapid Fire", "Test"...).
- The D47 race (read-then-write, not a constraint) is unchanged.
- **Tests:** unit tests for both modes open at once and each blocking only itself; the spec checks the Test-mode message, that a Rapid Fire challenge gets past the pair rule while a Test battle is open, and the Rapid Fire message.

### D65. Seeded demo battle for reviewers
- **Why:** reviewers usually have one account, so they can't play or watch a battle reach voting.
- **Decided:** a hidden `demo` mode (1 round, no bonus, 7-day voting, no emails) and `seedDemoBattle` (src/battle/demo.ts) that builds the battle through the normal path: `createBattle`, A's hidden setter row, then `accept` and B's `submit` through `runAction` (machine + `battle_transitions` claims), which opens voting and reveals both videos. Demo players are fixed ids `demo_player_a` / `demo_player_b` with usernames `demo_ava` / `demo_ben`. One open demo battle at a time (409 otherwise).
- **Owner only:** exposed as `POST /api/admin/seed-demo`, which needs `Authorization: Bearer <DEMO_SEED_TOKEN>` (a worker secret, constant-time compare, at least 24 characters) and answers 404 when the secret is missing or wrong. It is not an action, so no signed-in user can call it, and `challenge` refuses the demo mode (`invalid_mode`). `scripts/seed-demo.sh` converts the test fixture clip to H.264 MP4 (B's copy mirrored and tinted), uploads both with `npx deepspace app files put` under `videos/<demo id>/<random>.mp4` (the files proxy rule from D44 applies unchanged), then calls the route.
- **Label:** the "Demo" badge on the feed card and battle page. When voting closes after 7 days the battle completes like any other and its points go to the demo players' stats.

## Phase 13: energy (2026-11-25)

### D66. Energy: a ledger replayed into a stored snapshot, refill computed on read
- **Rules:** GAME_RULES.md "Energy": max 5, new players full, challenge costs 1 (Standard, Rapid Fire, and the hidden test modes, which mirror them so the browser tests exercise energy), accept free, demo battles exempt (`BattleMode.energy`), +1 every 5 h while below 5, refund on decline/cancel/expire, +1 to the winner, draws nothing, capped at 5.
- **Collections:** `energy_entries` is the ledger (admin read only): one row per change with a unique `key`. `player_energy` is the public row per player (record id = user id): `{ energy, lastRefillAt }`, the ledger replayed (`replay`, energy.ts). `lastRefillAt` is the last-refill timestamp: null when full, otherwise when the timer started or last ticked. Both are `NO_WRITES` for every role. Energy isn't secret, so `player_energy` is public like `player_stats`.
- **Refill without cron:** `currentEnergy(row, now)` adds `floor((now - lastRefillAt) / 5h)`, capped at 5. The server and the client use the same pure function; nothing is written when a refill lands.
- **Spend is atomic with the challenge:** there's no compare-and-set (D10), so the guard is the ledger key `spend:<player>:<n>`, where n is how many spends the player already has. Two simultaneous challenges read the same n: one create wins, the other gets a Duplicate, re-reads (now seeing the first spend), re-checks, and refuses at 0. The action checks energy early (so a 0-energy player gets "Out of energy" before any other error), validates the input, then spends, then writes A's setter row and the battle. If either write fails after the spend, it refunds the same battle (`refund:<battleId>`), so a failed challenge costs nothing.
- **Refunds and win rewards are idempotent:** keys `refund:<battleId>` and `win:<battleId>`. They run from the event hook on `battle_declined`/`battle_cancelled`/`battle_expired`/`battle_completed` (only the winning transition fires events) and from `repairIfStuck`, which fires no events. A replay hits the Duplicate and changes nothing, same as stats (D56). A refund needs a spend for that battle, so challenges sent before energy existed refund nothing.
- **Snapshot staleness:** after every ledger write the snapshot is recomputed from the whole ledger (never incremented). Two writes for one player at the same instant could leave a stale snapshot until the player's next change; the server's own check always replays the ledger, so this can only affect what the bar shows, never what's allowed.
- **Message format:** "Out of energy. Next refill in 2h 14m." rounded up to the minute; under an hour it reads "14m" (never "0h 14m").
- **UI:** the home hero (the "Ready to clash?" card) has the bar: 5 segments, "3/5", and "Next refill in 2h 14m" below 5. To fit without growing, the hero went from `p-5` to `p-4`, the username line and subtitle to `text-xs`, and the gaps to `mt-1`/`mt-3`; it measured 210 px at 375 px before and the spec asserts it stays ≤ 210 px at 5/5 and 0/5. At 0 the "New challenge" link becomes a disabled button reading "Next energy in 2h 14m". The challenge form shows the bar with one line of copy and disables "Send challenge" at 0 (it reads "Next energy in …"). Everything reads the live `player_energy` query, so spends, refunds and wins show without reloading.
- **Dev-only reset:** `devSetMyEnergy` writes a `set` ledger entry for the caller. It only runs when `ALLOW_DEBUG_ROUTES === 'true'`, which `deepspace dev`/`test run` write into `.dev.vars` and production never sets; elsewhere it answers "Unknown action." The browser spec uses it so every run starts from known energy.
- **Tests:** unit tests for refill math (partial periods, cap, timer only below 5, rolling timer), spend, refusing at 0 with the message, two simultaneous spends of the last energy, refund on decline/cancel/expire with replay, no refund for unpaid challenges, win reward to either side with replay, cap, draw, the repair path, the challenge action (spends with the battle, refuses at 0 before writing anything, bad input costs nothing, accept/decline free) and the dev action's gate. The browser spec checks the spend and the cancel refund live on home, both win rewards (A in Standard test, B in Rapid Fire test, where accepting stayed free), and a 0-energy test at 375 px (disabled button, refill copy, hero height, server refusal in three modes, challenge form disabled).

## Phase 14: online presence in the opponent picker (2026-11-25)

### D67. "Online now" from the SDK's presence room; only past opponents are listed
- **Primitive:** every signed-in tab joins one app-wide `usePresenceRoom('online')` (`OnlineProvider` in `src/components/game/presence.tsx`, mounted in the app layout). It's the SDK's built-in `PresenceRoom` Durable Object (already bound in `worker.ts`): in-memory, nothing stored, identity from the verified JWT, and a closed tab leaves every peer list within about a second. No heartbeat of our own.
- **Why not `usePresence`:** in SDK 0.44.2 its 60 s heartbeat rewrites `lastSeenAt` server-side (`handleUserUpdate`) but never rebroadcasts the roster (`broadcastUserList` only runs on registration changes), so other tabs keep the `lastSeenAt` they got on connect: a player who opens the app later never shows as online, and leaving takes the 5 min timeout. It also only knows "last seen", which we don't want to show.
- **What the form shows (challenge page):** "Online now" lists past opponents (any battle with me, any mode, any status) who are online, most recent battle first (`state.createdAt`), max 8 (`onlinePastOpponents`, `src/battle/opponents.ts`, reading up to 100 battles per side). Tapping one fills in the opponent. With none online: "None of your past opponents are online. Search by username." Search suggestions and the "@name found." line get a green dot when that player is online. Nothing lists everyone online, and there are no "last seen" times anywhere.
- **Rapid Fire:** with a Rapid Fire mode selected and an offline opponent, a soft warning: "@name is offline. They have 5 minutes to accept." (minutes come from the mode's `inviteWindowMs`). Sending stays allowed. Before this tab has joined the room nobody is treated as offline, so the warning doesn't flash on load.
- **Privacy limit:** the presence socket delivers every online signed-in peer's user id and display name to every signed-in tab. The UI filters that to past opponents and search results, but a technical user could read the raw list. Acceptable for the MVP (the public roster already carries names and `lastSeenAt`); a scoped server-side check would be the fix if it matters later.
- **Tests:** unit tests for ordering (both sides, latest battle per opponent, no createdAt last, never self) and the cap of 8 counted after the online filter. Browser test (`battle.spec.ts`, serial with the other Player A/B tests): A challenges B and cancels (so they've battled), with B's home open A sees B under "Online now", tapping fills the field with the online dot, B's search suggestion has the dot, Rapid Fire shows no warning; after B's page closes B leaves "Online now" (within 15 s), the dot goes, the Rapid Fire warning appears and sending is still enabled.

## Phase 15: Reels-style feed cards (2026-11-25)

### D68. "Voting now" cards are a full-bleed video with overlays
- **Supersedes the layout part of D57** (and D59's "header + 9:16 box" inside the card). The slot size (D59), horizontal snap, lazy loading, single playing video and voting rules are unchanged.
- **Video:** each slide fills the whole card. The video is `object-contain`, never cropped (feet and the ball at the edges matter). Behind it, a blurred, darkened backdrop of the same clip fills the empty space instead of black bars.
- **Backdrop choice: a canvas frame, not a second `<video>`.** A second video element would mean a second download (range requests aren't reliably shared) and a second decoder on phones. Instead a 36×64 `<canvas>` copies the current frame on `loadeddata`, `seeked` and `timeupdate` (about 4 per second), scaled to cover with CSS blur, brightness 50% and saturation. It only draws, never reads pixels, so a tainted canvas is fine. Before the first frame the card is black.
- **Top overlay** (dark gradient, text shadow): "Round N · Voting · m:ss" with the live dot and the mode badge (Rapid Fire / Demo), skill below (round 3: the skill of the player on screen). The whole text block links to the battle page (≥44 px tall). A 44 px mute icon button sits in the top-right corner, outside the link.
- **Bottom overlay, per slide** (dark gradient): the "@name" chip and a pill "Vote" button (44 px) on one row. After voting both slides show "✓ Voted @name", disabled. Competitors get a small "Your battle" chip instead of a button; signed-out viewers get "Sign in to vote". The footer line under the card is gone. Per-player counts still never show.
- **Removed:** the score ("0 – 0"), the players row, the "@name's video" label row, the "1/2" text (now two dots above the bottom row plus a screen-reader-only "1 of 2" live region), the visible arrow buttons and the "Tap to unmute" bar.
- **Moving:** swipe as before. Tapping the left or right 25% of a slide goes to the previous or next video, and tapping the middle pauses or plays. These zones come from the tap position in the slide's click handler, not overlay elements, so a swipe can still start anywhere (a swipe never fires a click). Keyboard users get "Previous video" / "Next video" buttons that are visually hidden until focused.
- **Trade-off:** a swipe that starts on the top overlay (the link) doesn't move the track. It's about 60 px tall.
- **Tests:** `battle.spec.ts` checks no score and no old header on the card, "Round 1 · Voting" and a skill in the top overlay, a right-edge tap goes to video 2, keyboard "Previous video" goes back, swipes both ways, the vertical swipe scrolls the page, voting gives "Voted @A" on both slides (both disabled), and the competitor sees "Your battle" and no vote button. At 375×667 and 390×844: the video box fills the card, the video is `object-contain`, header/mute sit above the dots, the dots sit above the chip and button, the chip is left of the button, and the vote button, mute button and header are each ≥44 px tall.

## Phase 16: settings, how to play, home cleanup (2026-11-25)

### D69. Settings page, email opt-out, How to play, Finished link on home, sign-up copy
- **Home:** the "Finished" group is gone. The bottom of "Your battles" has one row, "Finished battles (N) →", linking to `/u/<username>` (the profile lists past battles). Hidden when N is 0. N is the home `finished` bucket (complete, declined, cancelled, expired), so it can be higher than the profile's "Past battles" count, which lists only complete and declined.
- **Settings** (`/settings`, signed in): Account (`@username` read-only, email, Sign out), Notifications (one switch), Energy (the existing `EnergyBar`), a How to play link, and "To delete your account, contact iturriaga.francisco@gmail.com". No sign-in method row: the SDK's user object doesn't expose the provider.
- **Email opt-out:** new collection `email_prefs` (record id = user id, `emails: 'on' | 'off'`, owner reads own, no client writes). Only the `setEmailPrefs` action writes it (it requires a boolean). No row means on. `notify.ts` reads it for every recipient: the challenge email and each player's result email are skipped with `[email] … skipped (opted out)` when off. The mode check (test/demo send nothing) still runs first. Stored in its own collection, not on `users`, because members can update their own `users` row from the client.
- **Known gap: no account deletion in the MVP.** Players ask by email; the owner would delete by hand.
- **How to play** (`/how-to-play`, public, under `(app)` so it has the nav): Standard, Rapid Fire, voting, scoring, energy and invite expiry, worded from GAME_RULES.md. Linked from the nav/menu, the home hero (signed in: on the `@username` line so the hero doesn't grow past the D66 210 px check; signed out: an outline button next to the sign-in button) and Settings.
- **Sign-up copy:** header button "Sign in / Sign up", home "Sign in or sign up to battle", feed card pill "Sign in or sign up to vote" (shorter, it shares a row with the name chip), battle page "Sign in or create an account to vote", protected pages "Sign in / Sign up" plus "Signing in creates your account". The SDK's AuthOverlay is unchanged.
- **Tests:** unit tests for the opt-out (default on, challenge skipped, result skipped only for the opted-out side, log text). Browser: the cancel test checks no Finished group and the link's count and href; a Settings test (Voter C) checks username, email, energy, the delete note, toggle off survives a reload, a bad value is refused, toggle back on, and the How to play link; a smoke test loads `/how-to-play` signed out and checks the header copy. The D60 scroll-restore check moved from home to A's profile, since home may now be too short to scroll. The "my battles loaded" waits also accept the Finished link.
