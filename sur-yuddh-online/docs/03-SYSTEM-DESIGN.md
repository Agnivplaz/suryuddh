# 03 · System design — database, accounts, rooms, realtime, anti-cheat

Everything in this document is **implemented** in `server/` and `client/js/`, and is covered by
the two test suites (`npm test` → 34 assertions, `client/test/netcode.test.mjs` → 19 assertions).

---

## 0. The one diagram that explains the design

```
  ┌──────────────┐        REST /api/*         ┌────────────────────────────────────┐
  │   BROWSER    │ ◄────────────────────────► │  NODE SERVICE                      │
  │  (the game)  │                            │                                    │
  │              │   WebSocket /ws            │  • accounts (bcrypt + JWT)         │
  │  host: sim   │ ◄────────────────────────► │  • matchmaking + room codes        │
  │  guest: view │   input 30 Hz ↑            │  • input validation (real cooldowns│
  └──────────────┘   snapshot 20 Hz ↓         │    from balance.json)              │
                                             │  • THE MATCH AUTHORITY: clock,     │
  ┌──────────────┐        same channel        │    activity floor, result verdict  │
  │   BROWSER    │ ◄────────────────────────► │  • XP engine + audit ledger        │
  │   (player 2) │                            └──────────────┬─────────────────────┘
  └──────────────┘                                           │ SQL
                                                             ▼
                                             ┌────────────────────────────────────┐
                                             │  POSTGRES (or SQLite for a LAN)    │
                                             │  players · matches · match_players │
                                             │  rooms · xp_audit · match_replays  │
                                             │  refresh_tokens · security_events  │
                                             └────────────────────────────────────┘

  Rule of thumb enforced by the code:
    the database stores DURABLE FACTS, memory holds LIVE MATCHES, the socket carries FRAMES.
```

---

## 1. Database schema (point 10 of your brief)

Tables and why each exists — full DDL in `server/src/db/schema.sqlite.sql` and
`schema.postgres.sql`. **Timestamps are epoch milliseconds (BIGINT/INTEGER)** in both engines:
no time-zone ambiguity, identical behaviour on SQLite and Postgres, trivial arithmetic in JS.

### `players` — the account (your `profiles`)

```sql
id              UUID PK          -- internal identity, never shown
username        TEXT             -- public identity (leaderboard, match history)
username_lower  TEXT UNIQUE      -- case-insensitive uniqueness: "Raga" == "raga"
password_hash   TEXT             -- bcrypt, cost 12 in production
total_xp        INTEGER          -- THE leaderboard metric (server-only writes)
games_played, wins, losses, draws
trust_score     INTEGER          -- anti-cheat health of the account (100 → 0)
banned          BOOLEAN
created_at, last_seen
INDEX (banned, total_xp DESC, wins DESC, created_at ASC)   -- the leaderboard index
```

`CHECK (username ~ '^[A-Za-z0-9_]{3,16}$')` on Postgres, the same rule enforced in
`auth.js` for SQLite. Reserved names (`admin`, `system`, …) are blocked to stop impersonation.

### `matches` — one row per match

```sql
id, mode ('ranked_1v1'|'friendly'), room_code
status ('live'|'finished'|'void')
winner_id, loser_id, win_reason ('ko'|'disconnect'|'forfeit'|'timeout')
result_source ('both_agree'|'loser_disconnect'|'server_decided')
validated BOOLEAN, validation_note TEXT          -- why it was voided, if it was
seed BIGINT                                      -- deterministic sim seed
duration_ms, started_at, ended_at, created_at
```

### `match_players` — per-player detail (this is where I diverged from your sketch)

Your draft had `matches(player_1, player_2, winner, xp…)`. I split it, and it is worth the two
extra bytes:

* **per-player stats belong to a player**, not to a match: instrument, XP earned, HP left,
  damage dealt, input count, whether they dropped;
* XP is **per player** (the winner gets 100-ish, the loser 30-ish) — a single `xp` column on
  `matches` cannot express that;
* it extends to 2v2 / 4-player free-for-all without changing the schema (`slot` becomes 3,4,5…);
* `username` and `instrument` are **snapshotted** into the row, so match history keeps rendering
  correctly even if a player renames or deletes an account.

PK is `(match_id, slot)`; `slot 1 = host` (the simulation authority), `slot 2 = guest`.

### `xp_audit` — append-only XP ledger

Every single grant: `player_id, match_id, delta, reason (ranked_win|ranked_loss|disconnect_win|
admin_adjust), xp_before, xp_after, created_at`. Consequences: the leaderboard is reproducible
from history, the daily cap is a one-line `SUM(delta)` query, and any anomaly is visible rather
than silently baked into a total.

### `rooms` — pending room codes

`room_code PK · host_id · guest_id · status ('open'|'matched'|'live'|'closed'|'expired') ·
match_id · created_at · expires_at`.

### `match_replays` — the input log (for Phase-4 full verification)

`seed, host_slot, frames, bytes, input_log JSON` where each frame is
`[msSinceStart, x, z, actionMask]` (5 actions → 5 bits). Bounded to 400 KB per match.
This is what makes server-side re-simulation possible later **without a schema change now** —
the data is already being collected.

### `refresh_tokens` / `security_events`

Rotating refresh tokens (stored as SHA-256, single use) and an audit trail of
`login_failed`, `signup_failed`, `input_rejected`, `snap_flood`, `bad_snapshot`, `match_void`
(see §6).

### Match history: `matches` or its own table?

**Use `matches` ⨝ `match_players`** — no third table. The query is a single indexed join, it can
never disagree with the match record, and the profile page needs exactly the fields that are
already there:

```sql
SELECT m.id, m.status, m.win_reason, m.duration_ms, m.started_at,
       mp.outcome, mp.xp_earned, mp.instrument,
       opp.username AS opponent, opmp.instrument AS opponent_instrument
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id
  LEFT JOIN match_players opmp ON opmp.match_id = mp.match_id AND opmp.slot <> mp.slot
  LEFT JOIN players opp ON opp.id = opmp.player_id
 WHERE mp.player_id = ? ORDER BY m.started_at DESC LIMIT ? OFFSET ?
```

---

## 2. Accounts (point 11)

No email, no phone, no third-party login — exactly as requested.

```
POST /api/auth/signup  {username, password}   →  {player, accessToken, refreshToken}
POST /api/auth/login   {username, password}   →  same
POST /api/auth/refresh {refreshToken}         →  rotated pair (old one dies)
POST /api/auth/logout  {refreshToken}
GET  /api/auth/me                             (Bearer)
```

**Password storage:** bcrypt, cost **12** in production (10 in dev so tests are fast). Plain
passwords are never logged, stored, or sent anywhere.

**Tokens:** access = JWT HS256, 12 h, `{sub: uuid, name: username, iss: 'suryuddh'}` — verified
on every REST call **and on every socket message**; refresh = 32 random bytes, SHA-256 hashed at
rest, **single-use and rotated** (replaying a used one fails, and the test asserts that).

**Login hardening:** a constant amount of work is done whether or not the username exists (a
dummy bcrypt compare), so response timing does not reveal which usernames are taken.
Rate limits: 10 login attempts / 15 min per IP+username, 5 new accounts / hour per IP.

**Sessions in the browser:** `localStorage['suryuddh_session_v1']` (access + refresh + the
public profile). One live socket per account — a second login retires the first (`4001
replaced`), which prevents ghost players and duplicate matchmaking entries.

**Known limitation, stated plainly:** with no email there is **no self-service password reset**
(that is the price of not collecting personal data, and it is the right trade for a school
project). Recovery = the operator updates the bcrypt hash directly:

```sql
-- admin-side only
UPDATE players SET password_hash = '<bcrypt of the new password>' WHERE username_lower = 'someone';
```
Or run `node tools/reset-password.mjs <username> <newpassword>` (included).

---

## 3. The Global Leaderboard

One board, one metric, exactly as specified.

```sql
SELECT id, username, total_xp, games_played, wins, losses, draws
  FROM players WHERE banned = 0
 ORDER BY total_xp DESC, wins DESC, created_at ASC
 LIMIT 50 OFFSET 0;
```

* `GET /api/leaderboard?limit&offset&q` → `{leaderboard[], total, you}`.
* `you` is always present for a signed-in player, with their rank even if they are #412 — the UI
  renders it as a pinned row so a new player can always see progress.
* Rank is computed with `COUNT(*) WHERE total_xp > mine` (ties share a rank) — a single index
  scan, no window functions, works identically on both engines.
* The board is defined by `total_xp`, which only ever changes inside `grantXp()` — the single
  function in the entire codebase allowed to touch it (see §6).

UI: `#ovBoard` — rank #, player, **Total XP**, record, win rate; medal for the top three; your
own row highlighted; search by username; the "you are #N with X XP" line in the header.

---

## 4. Profile page

`GET /api/me/profile` → public player fields + computed `winRate`, `rank`, `xpToday` + the last
25 matches. Rendered in `#ovProfile`:

```
[ 1,240 ]   [ 14 ]    [ 9 ]    [ 5 ]     [ 64% ]    [ 240 ]
Total XP    Games     Wins     Losses    Win rate   XP today

Result | Opponent        | You played | XP   | Duration | When
WIN    | Kabir as sitar  | tabla      | +120 | 2:14     | 3 h ago
LOSS   | Meera as dhol   | bansuri    | +34  | 1:05     | yesterday
```

Note the deliberate design choice: **offline practice EXP never appears here.** Practice keeps
`localStorage` per-instrument levels (the original system, untouched); this page shows only
server-verified online results. One sentence in the UI explains it, so nobody thinks their
practice play is being lost.

---

## 5. Rooms and matchmaking (point 12)

### Room codes

* 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — **no O/0/I/1/L** because codes get read
  aloud across a classroom and typed on phones.
* Generated with `crypto.randomBytes`, retried against the DB until unique; 31^5 = **28.6 M**
  combinations, so collisions are a non-issue even with hundreds of open rooms.
* Lifecycle: `open` (waiting) → `matched` (guest joined, both choosing instruments) → `live`
  (a `matches` row exists) → `closed`/`expired` (2 h TTL, swept every second).
* A player can have at most 3 open rooms; creating a 4th re-opens the newest instead.
* Joining is blocked for: your own code (`own_room`), a full room (`room_full`), an expired one
  (`room_expired`), an offline host (`host_offline`), and a non-existent code.

```
host: room:create ──► room:created {code:"K7X4P"}         guest: room:join {code:"k7x4p"}
   ▲                     (shown big, with a Copy button)     │  (case-insensitive, sanitised)
   │                                                          ▼
   └──────── room matched → both receive queue:matched {matchId, slot} ────────┐
                                                                               ▼
                    both send match:ready {instrument} → server creates the match row →
                    m a t c h : s t a r t  { matchId, seed, startAtTs, players{1,2} }
```

### Quick Match

* `queue:join` puts the connection in an in-memory queue (no DB write).
* Pairing: **prefer somebody new** — a player is skipped if they fought you in the last 5
  minutes. If nobody else is online, a second pass pairs you after ~8 s of waiting, because two
  friends testing together must be able to rematch.
* 45 s timeout with a friendly suggestion ("create a room code, or practise against AI").
* The queue is swept every second (dead sockets removed, timeouts notified).

Room matches and quick matches use the **same** match engine; only `mode` differs
(`friendly` vs `ranked_1v1`) — both are validated and both pay XP, which matters a lot at a
school exhibition where most fights will be room-code fights between classmates.

---

## 6. Realtime multiplayer (point 13)

### Transport and protocol

Raw WebSocket at `/ws`, JSON text frames, one object per frame, everything visible in
DevTools. Deliberate choice: **no Socket.IO** — fewer dependencies, nothing hidden, and a
judge can watch the actual packets.

| Direction | Type | Payload | Rate |
|---|---|---|---|
| C→S | `auth` | `{token}` | once |
| C→S | `queue:join` / `queue:leave` | — | — |
| C→S | `room:create` / `room:join {code}` / `room:leave` | — | — |
| C→S | `match:ready {instrument}` | 15 valid ids | once |
| C→S | `input {s, x, z, a[]}` | seq, unit vector, up to 5 actions | **30 Hz** |
| C→S | `snap {ms, st, win, f[], p[], z[]}` | fighters/projectiles/zones | **20 Hz** |
| C→S | `result {o, hp, ohp, ms, dmg, r}` | a *claim*, not a fact | once |
| S→C | `hello`, `auth:ok`, `auth:error`, `pong`, `presence`, `error` | — | as needed |
| S→C | `queue:waiting/matched/timeout/cancelled` | — | — |
| S→C | `room:created/state/closed/error` | — | — |
| S→C | `match:start {matchId, seed, startAtTs, players, role, slot}` | — | once |
| S→C | `peer:input` (**to host only**) | relayed, validated | 30 Hz |
| S→C | `peer:snap` (**to guest only**) | relayed | 20 Hz |
| S→C | `peer:left/back/state` | — | — |
| S→C | `match:result {outcome, xpEarned, xpBreakdown, serverValidated}` | — | once |
| S→C | `match:void {reason}` | — | once |

Per-type payload ceilings (input 512 B, snapshot 32 KB, default 2 KB) and 200 messages/second per
connection.

### Who runs the simulation

**Host-authoritative** (slot 1 = the player who was first in the queue, or the room creator):

```
HOST  ── runs the REAL game loop (the same code as offline play)
      ── applies the guest's inputs to the guest's fighter (no AI)
      ── uploads a snapshot 20×/second

GUEST ── does not simulate; uploads inputs 30×/second
      ── renders snapshots, easing toward them (4.5/s), snapping if it drifts >7 units
      ── predicts ONLY its own avatar's movement locally, so controls feel instant
      ── its abilities are requests: useMove() on a net fighter is intercepted and shipped
```

Why not the other two options, briefly:

* **Deterministic lockstep** (both machines simulate, only inputs travel) needs a seeded RNG and
  fixed timestep everywhere *plus* bit-identical `Math.sin/cos` across browsers — fragile, and
  the game's ~30 `Math.random()` call sites (particles, AI) reach into the sim.
* **Full server simulation** is the end state (Phase 4) but requires extracting the sim from
  ~600 lines that today call `puff()`, `Snd.hit()` and `spawnDN()` inline. Doing that in the same
  pass as everything else would have been reckless. The design leaves the door open.

### Clock synchronisation

`match:start` carries `startAtTs` (server epoch ms). Clients measure offset with `ping`/`pong`
every 4 s (`serverOffset = serverTime + rtt/2 - now`) and the countdown is pinned to it, so both
fighters' screens say "3 … 2 … 1 … Sur Yuddh!" at the same moment even if the laptops' clocks
disagree by minutes.

### Disconnects, timeouts and reconnection

| Event | Server behaviour |
|---|---|
| Guest's socket closes | `markDisconnected`, peer gets `peer:left {graceMs}`; after the **15 s grace** the remaining player wins automatically (`server_decided`) — no client claim needed |
| Host's socket closes | same, except the host cannot resume (the sim lived in its tab) |
| Player clicks *Choose instrument* | `match:leave` = forfeit: recorded as a loss, opponent paid after normal validation (a sub-20 s match is voided, so rage-quitting does not hand out XP) |
| Guest reconnects within the grace | socket re-bound, `match:start` re-sent with `resumed:true`, peer notified |
| Match stalls | no snapshots for 15 s, or a claim waiting >30 s, or >30 min total → void, no XP, both locks released |
| Server error mid-payout | transaction rolls back, match marked abandoned, `match:void` to both — never a half-paid match |

Every one of these paths **releases both players** so they can immediately queue again
(`releaseMatch`), and `queue:join` self-heals a stale lock instead of erroring — a bug the
integration test caught and now guards.

---

## 7. Anti-cheat (point 14)

The requirement: *the browser must not be able to say "I earned 50 000 XP" and be believed.*
Here is the layered answer, cheapest layer first.

### Layer 1 — the client cannot name the match
Matches are created server-side (`dbx.uuid()`), slots and roles are assigned by the server,
instruments are validated against `balance.json`, and `match:start` is the only way a client
learns a `matchId`. A `result` message for a match you are not in is rejected with
`no_active_match` (asserted in both test suites).

### Layer 2 — the client sends observations, never numbers
The result message contains outcome, HP, duration and damage. There is **no XP field** in the
protocol at all; if a client adds one it is ignored (test: *"an 'xp' field in the client result
is ignored — server computes 100% of it"*). Duration is taken from the **server's** clock —
a client claiming `ms: 999999` changes nothing.

### Layer 3 — inputs are validated against the real game's balance
`tools/extract-balance.mjs` reads the game file and produces `server/src/balance.json` (stats,
cooldowns, ult rates, per-slot minimum intervals). On every input frame the server:

* rejects non-finite / out-of-range movement vectors and diagonal overflow;
* rejects unknown actions, >5 actions per frame;
* enforces per-instrument cooldowns using the same numbers the client plays with — an
  `atk1` at 20 Hz is impossible for every instrument in the game;
* caps ultimates per minute (energy is earned in-game, so more than ~3/min is impossible);
* counts valid frames and moving frames per player — that count is the **activity floor**.

Repeated violations write to `security_events` and subtract from `trust_score`.

### Layer 4 — the match must look like a match
`validateMatchResult()` (in `src/validation.js`) refuses to accept a result unless:

| Check | Value | Stops |
|---|---|---|
| duration ≥ 20 s | `MATCH_MIN_MS` | "win" in 3 seconds |
| duration ≤ 30 min | `MATCH_MAX_MS` | absurd claims |
| activity ≥ max(40 frames, 4/s of match time, capped 300) per player | role-aware (host counts snapshots, guest counts inputs) | AFK/held-open matches |
| both claims agree, **or** the loser is genuinely gone (server-observed socket close, past the grace) | — | one client inventing a whole match |
| contradictory claims (both claim "win") | void, no XP, security event, trust −2 | mutual lying |
| winner HP > 0, loser HP ≤ 0 on a KO | — | impossible physics |
| disconnect wins: the loser must have actually played (≥20 frames or a 45 s+ match) | — | "queue, pull cable, collect XP" farms |

### Layer 5 — XP is a server-side function of validated facts

```js
base        = win ? 100 : 30          // disconnect: 60 / 20
duration    = clamp(durationMs / 60_000, 0.4, 1.5)      // a 20 s match pays 40 %
opponent    = clamp(1 + (oppXp - myXp)/4000, 0.6, 1.6)   // beating someone far above pays more
repeat      = 1 | 0.75 | 0.5          // same opponent again within 2 h / 30 min
xp          = clamp(round(base × duration × opponent × repeat), 5, 400)
xp          = min(xp, dailyCapRemaining)                 // 1500 XP per rolling 24 h
```

Example: a 2-minute win against a player 800 XP above you, first time today →
`100 × 1.5 (clamped) × 1.2 × 1 = 180 XP`; the loser still gets `30 × 1.5 × 0.8 ≈ 36 XP`, because
a ladder where losing is worthless stops people from playing.

### Layer 6 — where the numbers live
`players.total_xp` is written in exactly **one** function (`grantXp()`), inside a transaction,
together with the `xp_audit` row. Nothing else in the codebase executes `UPDATE players SET
total_xp`. Grep for it: two hits, one is the seed tool.

### Layer 7 — the structural rules
* **AI practice cannot feed the leaderboard.** It has no server path at all: offline EXP goes
  to `localStorage`, which the server never reads.
* **Local per-instrument levels are disabled in online matches** (`levelCd/levelDmg/awakened`
  forced to 1/false), because `localStorage` is user-editable and those levels give real
  damage/cooldown bonuses.
* Rate limits everywhere: 300 HTTP req/min/IP, 10 logins/15 min, 5 signups/h, 200 WS msg/s,
  payload ceilings, ult/snapshot flood detection.

### Layer 8 — the endgame: server-side re-simulation (Phase 4)
The server already stores `seed` + the full input log per match (`match_replays`). Once the
simulation is extracted into a DOM-free `sim-core.js` with a seeded RNG and a fixed timestep,
the server can **replay the fight itself** and derive the winner, the duration and the damage
independently of both clients. That closes the "modified host" hole entirely. It is deliberately
*not* in this package — it is a real refactor and deserves its own phase (see `04-ROADMAP.md`).

### Honest summary of what is and is not closed

| Attack | Status |
|---|---|
| "Give me 50 000 XP" from the console | **closed** — no such field exists |
| Fabricate a match with no opponent | **closed** — server-issued matches only |
| Farm a disconnected opponent all night | **closed** — grace, activity floor, daily cap, repeat penalties |
| Spam impossible actions | **closed** — balance-derived cooldown checks |
| Two accounts farming each other | **limited** — repeat-opponent penalty + daily cap + void on contradictions; Phase 4 catches the rest |
| A modified **host** lying about the fight | **Mitigated, not eliminated** — cross-claims, server clock, activity counts, HP sanity, security events. Report it and Phase 4 (replay) settles it in seconds |
| Someone DDoS-ing the free tier | out of scope for a school project; the platform's protections apply |
