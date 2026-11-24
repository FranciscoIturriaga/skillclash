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
