# SkillClash

SkillClash: a soccer skill battle game. Film a skill, your opponent matches it, the crowd votes.

**Live:** https://skillclash.app.space

## Try it in a minute

1. **Sign in / Sign up** (your first sign-in creates the account) and pick a username.
2. On Home, find the **Demo battle** under **Voting now**: swipe (or tap the edges) to switch between the two clips, then vote.
3. Read **How to play** at [/how-to-play](https://skillclash.app.space/how-to-play).

A full battle needs two accounts to play plus a third to vote. Rapid Fire takes about 20 minutes end to end.

## How it works

- **Standard:** 3 rounds. Round 1 is the challenger's skill, round 2 the opponent's, round 3 a freestyle. Picks are blind: the setter films first, then the opponent sees the skill and matches it.
- **Rapid Fire:** 1 round, 5 minutes to accept and match, 15 minutes of voting.
- **Voting:** players can't vote in their own battle, and everyone else gets one vote per round. Counts stay hidden until voting closes.
- **Scoring:** round win +10, tie +5 each (zero votes counts as a tie). Missing the deadline loses the round. Standard adds a battle bonus (+10 for the win, +5 each for a draw).
- **Energy:** up to 5 challenges, +1 every 5 hours. Declined, cancelled or expired challenges are refunded, and winning a battle gives +1.
- Invites expire, and each pair can have only one open battle per mode.

The full rules are in [docs/GAME_RULES.md](docs/GAME_RULES.md).

## DeepSpace features used

| Feature | How SkillClash uses it |
| --- | --- |
| Auth | Sign-in and sign-up, a required username, public profiles at `/u/<name>` |
| Records + per-collection permissions | Battles, submissions, votes, stats, energy and email prefs. Clients can read but never write any of the game data. |
| Server actions | Every game write. Clients never write battle state, votes, stats, energy or email prefs. |
| File storage | Clips get unguessable keys, and the files proxy refuses anyone but the uploader until the round reveals the clip |
| Scheduled jobs | A sweep every minute handles deadlines and invite expiry (every action also checks deadlines itself) |
| Email (`email/send`) | Challenge and result emails, with a per-player opt-out in Settings |
| Presence | `usePresenceRoom` powers "Online now" on the challenge form, showing only your past opponents |
| Realtime sync | Live battle pages, feed, energy and home lists |
| Playwright multi-user fixture | 3-user browser specs (challenger, opponent, voter), including network-level checks that hidden skills never reach a browser |

**Left out:** Stripe (it needs Connect onboarding; the energy bar is groundwork for subscriptions and energy packs), AI, messaging, LiveKit. None were needed for the core loop.

## Architecture

| Path | What it is |
| --- | --- |
| [src/battle/machine.ts](src/battle/machine.ts) | Pure rules engine: (state + action) → new state or error. Unit-tested. |
| [src/battle/modes.ts](src/battle/modes.ts) | Mode config: Standard, Rapid Fire, Demo |
| [src/battle/service.ts](src/battle/service.ts) | Applies transitions. A `battle_transitions` table that allows one row per battle version makes sure only one transition is accepted per version. |
| [src/actions/battle-actions.ts](src/actions/battle-actions.ts) | Server actions: challenge, accept, submit, vote, cancel, … |
| [src/cron.ts](src/cron.ts) | Sweep every minute for deadlines and expiry |
| [src/components/game/FeedVoteCard.tsx](src/components/game/FeedVoteCard.tsx) | Reels-style voting feed |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Every decision, D1–D71 |

**Main tradeoff:** correct game state over speed of building. Every state change goes through one pure, tested module and a concurrency guard, so the cron, two players and voters acting at once can't corrupt a battle. The cost is more code per feature.

## Running locally

```sh
npm install
npx deepspace auth login                 # once, in an interactive terminal
npx deepspace dev start --port 5180      # dev server (5180 by convention)
npx vitest run                           # unit tests only
npx deepspace test run all --port 5181   # unit + browser tests (starts its own server)
```

Never run `npx deepspace push`: GitHub is this app's source, and deploys run with `npx deepspace deploy`.

The browser specs need three DeepSpace test accounts named **Player A**, **Player B** and **Voter C**. Create each one with your own password, entered on stdin:

```sh
npx deepspace test accounts create --email <email>@deepspace.test --name "Player A" --password-stdin
```

Specs that are missing their accounts skip and say what to create. Current counts: **155 unit tests, 20 browser specs.**

## Known limitations and next steps

- Votes can be gamed with extra accounts.
- No content moderation yet (a report button is planned).
- No self-serve account deletion; players ask by email.
- Camera-only recording adds friction but doesn't prove a clip is live.
- Unused setter videos (from declined, cancelled or expired challenges) aren't cleaned up.
- Pull-to-refresh reloads the whole page instead of just the data.
- Next: Stripe energy packs and subscriptions, rewards for voters.
