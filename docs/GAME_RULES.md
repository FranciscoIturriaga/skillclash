# SkillClash — Game Rules

This document is the source of truth for SkillClash game behavior. If code and this document disagree, this document wins until it is deliberately changed.

## Battles

- Player A challenges Player B by username and picks a mode. To send the challenge, A names round 1's skill AND records or uploads a video of it (same limits as every video: 20 s, 50 MB).
- **Blind invite:** B sees only "@A challenged you", the mode and when the invite expires. B can't see round 1's skill or A's video before accepting.
- B accepts or declines. To accept, B names round 2's skill (it must differ from round 1's; checked on the server) AND records or uploads a video of it. A can't see round 2's skill or B's video until round 2 opens.
- The battle starts only when B accepts.
- Two players can have only one open (invited or active) battle with each other **per mode** at a time, in either direction: one open Standard battle and one open Rapid Fire battle at once is fine, two open battles of the same mode is not ("You already have an open [mode] battle with @username.").

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

| Round | Setter (names and films the skill first)        | Replicator |
| ----- | ----------------------------------------------- | ---------- |
| 1     | Player A, when sending the challenge.           | Player B   |
| 2     | Player B, when accepting (a different skill).   | Player A   |
| 3     | Freestyle: no setter; each player picks their own skill. | — |

### Rounds 1 and 2: set and match

- The round opens with the setter's skill and video revealed to everyone. Round 1 opens when B accepts; round 2 opens when round 1 closes.
- The setter's video counts as the setter's submission for that round.
- The replicator has the submission window to film their attempt. As soon as they submit, the submission window ends and voting opens.
- If the replicator misses the deadline, the setter wins the round automatically (+10). No vote is held.

### Round 3: freestyle (blind)

- Both players submit a video before ONE shared submission deadline, each naming their own skill.
- Videos stay hidden from everyone, including the opponent, until the submission window ends.
- The submission window ends when both videos are submitted OR the deadline passes, whichever comes first.

### Hiding is enforced on the server

- An unrevealed skill name or video never reaches the other player or voters: not in the page, the network traffic or record subscriptions. The setter always sees their own skill and video.

### Voting window

- After the submission window ends, a voting window opens and always runs its full duration.
- Vote counts per player and percentages stay hidden until voting closes. A total vote count may be shown live.
- Any signed-in user may vote, one vote per round.
- Competitors cannot vote in their own battle.
- These voting rules are enforced server-side, not just in the UI.

## Modes

Modes are stored as config, not hard-coded.

Modes are config (`src/battle/modes.ts`): each mode sets the number of rounds, the invite, submission and voting windows, and whether the battle bonus applies. The rules engine reads these values; nothing else differs per mode.

| Mode       | Rounds | Invite window | Submission window | Voting window | Battle bonus | Who can pick it |
| ---------- | ------ | ------------- | ----------------- | ------------- | ------------ | --------------- |
| Standard   | 3      | 24h           | 12h per round     | 3h per round  | Yes          | Everyone        |
| Rapid Fire | 1      | 5 min         | 5 min             | 15 min        | No           | Everyone        |
| Demo       | 1      | n/a (seeded)  | n/a (seeded)      | 7 days        | No           | Owner only (seeded for reviewers) |

Hidden test modes (automated tests only, `/challenge?test=1`): Test (3 rounds, 5-minute invite, 3-minute submission, 20-second voting) and Rapid Fire test (Rapid Fire rules with a 3-minute submission and 20-second voting window). Test and demo battles send no email.

### Rapid Fire

- **One round only.** There is no round 2 or round 3.
- **Challenge:** the challenger names the skill and records the video when challenging, the same as Standard round 1.
- **Blind invite:** the opponent sees only who challenged them, the mode and when the invite expires. Nothing to name or film to accept.
- **Invite expiry:** 5 minutes.
- **Accept:** the round opens at once. The opponent sees the skill and the challenger's video and has **5 minutes** to record their match. The accept screen says the clock starts the moment they tap Accept.
- **Voting:** opens as soon as the opponent submits and runs for **15 minutes**.
- **Scoring:** round win +10, tie +5 each, zero votes = tie. If the opponent misses the 5-minute deadline, the challenger wins the round (+10). **No battle bonus.** Points go into the same stored player stats as Standard.
- Rapid Fire battles show a "Rapid Fire" badge on cards, the battle page, invites and profile history.

### Demo battle

- A demo battle between two demo players (@demo_ava and @demo_ben), already in voting with a 7-day window, so reviewers with a single account can vote. It shows a "Demo" badge. Only the app owner can create one (see PROJECT_NOTES.md); one open demo battle at a time.

## Energy

- Each player has up to **5 energy**. New players start full.
- **Sending a challenge** (Standard or Rapid Fire) costs **1 energy**. Accepting is free. Demo battles don't use energy.
- **Refill:** +1 energy every **5 hours**, up to 5. The refill timer only runs while energy is below 5: it starts when energy drops below 5, keeps its progress while energy stays below 5 (spending more doesn't restart it), and stops at 5.
- **Refund:** the challenger gets the 1 energy back if the challenge is declined, cancelled or expires.
- **Win reward:** the winner of a battle (either mode, challenger or opponent) gets **+1 energy**. Draws give nothing.
- Energy never goes above 5: a refill, refund or win reward at 5 is lost.
- **With 0 energy** a player can't send a challenge. The server refuses with "Out of energy. Next refill in Xh Ym." (under an hour: "Next refill in Ym").
- Enforced on the server: the challenge action checks and deducts energy together with creating the battle; clients can't write energy. Refunds and win rewards happen at most once per battle, even if the battle's end is processed twice.
- The home banner shows the energy bar (5 segments, the count, and "Next refill in 2h 14m" when below 5). At 0 the "New challenge" button is disabled and reads "Next energy in 2h 14m". The challenge form shows current energy too.

## Scoring

### Round scoring

| Outcome    | Points        |
| ---------- | ------------- |
| Win        | +10           |
| Tie        | +5 each       |
| Loss       | 0             |
| Zero votes | Tie (+5 each) |

### Missed deadlines

- If one player misses the submission deadline, the player who submitted wins the round automatically (+10). No vote is held. (In rounds 1 and 2 the setter has always submitted, so only the replicator can miss.)
- If both players miss round 3, the round is a tie worth 0 points for both.

### Battles from before the set-and-match rules

- Battles already active when these rules shipped finish under the old rules (round 1 and 2 skills public, both players film blind in every round).
- An old-rules invite still open can't be accepted; B can decline it or A can cancel it.

### Battle bonus

Standard only (Rapid Fire and Demo battles have no battle bonus).

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
