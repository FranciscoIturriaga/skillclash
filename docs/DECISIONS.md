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

#### D30. Profile stats are computed, not stored

- **Decided:** Battles played, W/L/T, round wins and total points are computed on the client from the player's completed battles (`state.result` already holds per-side totals).
- **Why:** No counters to keep in sync, no extra write per battle end, and a rules change recomputes history. Fine at MVP scale (a player has tens of battles, not thousands).

#### D31. Who can read what

- **Decided:** Anyone, signed in or not, can read `battles`, `rounds` and `usernames` (they hold nothing secret). `submissions` are readable by the uploader, and by everyone once revealed; admins get no exception. `votes` read `'own'`. `battle_transitions` is admin-only. No role can write any game collection from a client.
- **Why:** Battles in voting are meant to be watched and shared. The admin exception was removed so that "hidden until reveal" holds for everyone, including the app owner's own account.
- **Left as scaffold:** members can still update their own `users` row (display name, etc.). That row has no game data.

#### D32. Test accounts not created by the agent

- **Decided:** Creating the three `@deepspace.test` accounts for the multi-user test was blocked by the session's permission rules, so the owner has to create them (commands in PROJECT_NOTES.md). The spec skips itself when fewer than 3 usable accounts exist.

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
