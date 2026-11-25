# SkillClash — Game Rules

This document is the source of truth for SkillClash game behavior. If code and this document disagree, this document wins until it is deliberately changed.

## Battles

- Player A challenges Player B by username and picks a mode.
- B accepts or declines. The battle starts only when B accepts.
- Two players can have only one open (invited or active) battle with each other at a time, in either direction.

### Cancelling an invite

- While the invite is unanswered, Player A (and only Player A) can cancel it. The battle becomes **cancelled**; B sees it as cancelled and can no longer accept it.
- A battle can't be cancelled once B has accepted or declined, or once the invite has expired.

### Invite expiry

- An invite that B hasn't answered within the mode's invite window (**24 hours** in Standard) expires automatically. The battle becomes **expired**.
- The invite expires exactly at the deadline: from that moment it can't be accepted, declined or cancelled.
- The expiry time is stored on the battle, and invites show the time left (e.g. "Expires in 23h").

### Ending without being played

- Declined, cancelled and expired battles award no points, don't count on profiles, and free the pair to challenge each other again.
- No email is sent when a challenge is cancelled or expires.

## Rounds

A battle has 3 rounds, and all 3 are always played.

| Round | Who picks the skill                         |
| ----- | ------------------------------------------- |
| 1     | Player A names the skill.                   |
| 2     | Player B names a different skill.           |
| 3     | Freestyle: each player picks their own skill. |

### Submission window

- In every round, both players submit a video before ONE shared submission deadline.
- Videos stay hidden from everyone, including the opponent, until the submission window ends.
- The submission window ends when both videos are submitted OR the deadline passes, whichever comes first.

### Voting window

- After the submission window ends, a voting window opens and always runs its full duration.
- Vote counts per player and percentages stay hidden until voting closes. A total vote count may be shown live.
- Any signed-in user may vote, one vote per round.
- Competitors cannot vote in their own battle.
- These voting rules are enforced server-side, not just in the UI.

## Modes

Modes are stored as config, not hard-coded.

| Mode     | Invite window | Submission window | Voting window | Status          |
| -------- | ------------- | ----------------- | ------------- | --------------- |
| Standard | 24h           | 12h               | 3h            | MVP             |
| Demo     | TBD           | TBD               | TBD           | Added later     |
| Quick    | TBD           | 3h                | 1h            | Optional, later |
| Casual   | TBD           | 48h               | 12h           | Optional, later |

A hidden Test mode (automated tests only) uses a 5-minute invite window, 3-minute submission window and 20-second voting window.

## Scoring

### Round scoring

| Outcome    | Points        |
| ---------- | ------------- |
| Win        | +10           |
| Tie        | +5 each       |
| Loss       | 0             |
| Zero votes | Tie (+5 each) |

### Missed deadlines

- If one player misses the submission deadline, the player who submitted wins the round automatically (+10). No vote is held.
- If both players miss, the round is a tie worth 0 points for both.

### Battle bonus

| Outcome     | Points  |
| ----------- | ------- |
| Overall win | +10     |
| Overall tie | +5 each |
| Loss        | 0       |

A battle can end in a draw.

## Profiles

Each profile shows:

- username
- battles played
- battles won / lost / tied
- round wins
- total points
- past battles

## Out of scope for MVP

- Stripe / payments
- Followers
- DMs
- Tournaments
- Rankings

## Known limitations

- Votes can be gamed with extra accounts or friend groups. This is not solved in the MVP.

## Architecture rule

- All battle state transitions live in ONE pure module (e.g. `src/battle/machine.ts`): `(current state + action) -> new state or error`, with unit tests.
- Server actions call it with an expected-state check so simultaneous actions can't both succeed.
- Scheduled jobs must be idempotent.
