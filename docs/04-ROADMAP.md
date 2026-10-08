# 04 · Practical step-by-step plan

You asked for a plan you can actually execute, and to agree on the architecture *before* the
game gets rewritten. Here is where things stand and what each next step costs you.

**Rule I followed:** the game itself was **not rewritten**. The original file still runs its
original code; the upgrade adds files around it and hooks into seven well-defined points.
`client/index_offline_backup.html` is the untouched original if you ever need to diff.

---

## Phase 0 — ✅ DONE in this package

| # | Item | Where |
|---|---|---|
| 1 | Inspected the code, documented the architecture | `01-ARCHITECTURE-AUDIT.md` |
| 2 | Chose and justified the backend + costs | `02-BACKEND-DECISION.md` |
| 3 | Database schema (profiles / matches / rooms + extras) | `03-SYSTEM-DESIGN.md` §1, `server/src/db/schema.*.sql` |
| 4 | Username+password accounts, UUID identity, bcrypt, rotatable tokens | `server/src/auth.js` |
| 5 | Profile page (XP, games, W/L, win rate, history) | `#ovProfile` + `GET /api/me/profile` |
| 6 | Global leaderboard by total XP (one board, no weekly nonsense) | `#ovBoard` + `GET /api/leaderboard` |
| 7 | Quick Match / Create Room (K7X4P codes) / Join Room | `server/src/realtime/hub.js`, `#ovOnline` |
| 8 | Real realtime multiplayer (host sim + guest view, 30 Hz in / 20 Hz out) | `client/js/mp.js` |
| 9 | Server-validated results, server-computed XP, audit ledger | `server/src/validation.js`, `src/xp.js` |
| 10 | Match history + duration + XP per player | `match_players`, profile table |
| 11 | Two test suites proving the above | `server/test/smoke.mjs`, `client/test/netcode.test.mjs` |

**Test evidence (run it yourself, ~25 s total):**

```
server/  npm test                       → 34 passed, 0 failed   (API, auth, matchmaking, rooms,
                                                                 anti-cheat attempts, result rules)
client/  node test/netcode.test.mjs     → 19 passed, 0 failed   (two real clients, live server:
                                                                 pairing → inputs → snapshots →
                                                                 server-verified XP → leaderboard)
```

---

## Phase 1 — Run it locally (30 minutes, no deployment, no cost)

```bash
# 1. server
cd server
npm install
cp .env.example .env                 # then put a real JWT_SECRET in it:
                                     #   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npm start
#   → http://localhost:8080

# 2. open the game in two browsers (or two devices on the same WiFi)
#    → http://<your-laptop-ip>:8080  on both
#    → sign up as two different usernames
#    → Play Online → Quick Match on both   (or Create Room on one, Join with the code on the other)
```

**Success looks like:** a 3-second countdown on both screens at the same moment, two different
instruments, real movement, and a result panel that says **"+120 XP · verified by the server"**.
Then check the leaderboard: both accounts should be on it, ranked by XP.

Do this **before** touching any deployment — if it fails here, it will fail there too, and
localhost is a much easier place to debug.

---

## Phase 2 — Deploy (1–2 hours, ₹0)

Follow `05-DEPLOYMENT.md`. The short version:

1. Create a free Postgres (Neon or Supabase) → copy `DATABASE_URL`.
2. Deploy `server/` to Fly.io (or Render) with `DB_CLIENT=postgres`, `JWT_SECRET`,
   `NODE_ENV=production`, `TRUST_PROXY=true`.
3. Run the schema against the database once (`psql "$DATABASE_URL" -f src/db/schema.postgres.sql`).
4. In Hostinger DNS: `CNAME  suryuddh  →  <your-app>.fly.dev` (or `A` record for Render).
5. Load `https://suryuddh.yourdomain.com`, sign up, play a match with a friend on mobile data.
6. Optional: `npm run seed` to fill the board with plausible demo players before judging.

---

## Phase 3 — Exhibition polish (an evening, optional)

* **A reset button for demo day.** Before the judges arrive you want a clean board:
  `node tools/seed-demo.mjs --clear` removes the demo rows; `--players 8 --matches 24` puts a
  believable ladder back in 2 seconds.
* **Two prepared accounts** on two devices (laptop + phone), already signed in, so you never
  type a password in front of anyone.
* **Printed room codes** on the poster as an invitation: "Join my game, code ____".
* **A kiosk display**: open the leaderboard on a spare screen and leave it there.
* **Copy for the poster** — the anti-cheat is the most impressive part of this project, so put
  the pipeline on it:

  ```
  Player → Game/Server → Validate result → Calculate XP → Database → Global Leaderboard
  ```
  with two real examples: "a client that claims 50 000 XP is ignored — the field does not exist",
  and "a 4-second 'win' is rejected because the server's clock says the match was 4 seconds long".

---

## Phase 4 — Full server authority (the next real upgrade, ~a weekend)

**Goal:** the server re-simulates every match from the recorded input log, so even a modified
host cannot lie. The data is already being collected (`match_replays`), so this is code, not
schema.

Steps, in order:

1. **Extract the simulation.** Move `Fighter`, `damage`, `kill`, `blast`, `spawnProj`,
   `updProjs`, `updZones`, `KINDS`, `ULT`, `useMove`, `later`, `reach`, `threat` and the
   constant tables (`TUNE`, `ELEM`, `DIFF`, `INSTRUMENTS`) into `shared/sim-core.js` — one file
   loaded by **both** the browser and Node.
2. **Break the presentation coupling.** Those functions currently call `puff()`, `fxFlash()`,
   `spawnDN()`, `Snd.hit()`, `hurtFlash()` directly. Replace the calls with an injected `fx`
   object: the browser passes the real one, the server passes a no-op that records events.
3. **Seed the randomness.** Replace every `Math.random()` reachable from the sim with a small
   seeded PRNG (`mulberry32`) stored on the match, initialised from `match_replays.seed`.
4. **Fix the timestep.** An accumulator at a fixed 60 Hz (`while(acc >= 1/60) step(1/60)`).
   Rendering interpolates; the sim never sees a variable dt.
5. **Replay on the server.** After a match, `node` loads the seed + both input logs, runs the
   sim, and compares the derived result, duration and damage against the claims. Mismatch →
   void, trust −10, security event. Match → XP paid as usual (or, better, paid to the
   server-derived winner).
6. **Then** the host/guest distinction stops mattering for trust — you can even let the guest
   simulate locally for a lag-free experience (`role: 'both'`), because the server has the last
   word.

Estimated work: 600–800 lines moved and de-coupled, plus ~150 lines of new replay code.
Payoff: a genuinely strong answer when a judge asks *"what stops me from cheating?"*

---

## Phase 5 — Ideas for later (pick, don't do all)

* **Server-side instrument levels.** Today levels live in `localStorage` and are disabled online.
  A `player_instruments(player_id, instrument_id, level, exp)` table gives earned progression that
  cannot be edited, and the same anti-cheat guarantees. This is the natural next feature.
* **2v2 / free-for-all.** `match_players.slot` already supports slots 3–8; the hub needs a
  multi-peer relay (star topology through the host) and the validator needs N-way results.
* **Spectator mode.** A guest that receives snapshots but sends no inputs — about 20 lines,
  because the relay is already one-directional.
* **Rematch button that works.** Currently *Rematch* returns you to the lobby and re-queues.
  A real rematch = "ask the opponent, auto-accept, create a fresh match with the same players".
* **Season reset.** One SQL statement (`UPDATE players SET total_xp = 0`) plus an archived
  `seasons` table — nice for an inter-school league where each round starts fresh.
* **In-match reconnect for the host** (state is in its tab today, so it cannot resume) — needs a
  server-side snapshot ring buffer.

---

## Exhibition-day checklist

**Two days before**
- [ ] Deployed and reachable over HTTPS on the custom domain
- [ ] `npm test` and the netcode test pass on the deployed code
- [ ] Played a full match from two devices on **mobile data** (not just school WiFi)
- [ ] Decided which accounts the judges will use; passwords written on a card
- [ ] Printed the room code + QR to the game URL for the poster

**One hour before**
- [ ] Open the site once so the host is warm (Render free sleeps; Fly does not)
- [ ] `node tools/seed-demo.mjs --players 8 --matches 24` for a populated leaderboard
- [ ] Sign both demo devices in; open the leaderboard on the third screen
- [ ] Test one quick match end-to-end and confirm XP appears on the board

**If something breaks in front of a judge**
- [ ] Lobby shows "connecting…" → the server is asleep or blocked; open the site again
- [ ] Match ends as *void* → the server rejected it on purpose: **that is a feature**, show the
      reason in the toast and explain the validation rule. It is a better story than a fake win.
- [ ] No internet at all → switch to offline AI mode (choose Rivals 1–3 → Fight). The game is
      fully intact; say clearly that online play needs the server.

---

## Demo-day checklist (do these the day before)

- [ ] Set `SIGNUP_PER_HOUR=60` — the default of 5 is per **IP**, and the whole school WiFi is one
      IP. Without this, only five accounts can be created in an hour. *(This is the #1 demo risk.)*
- [ ] Seed a live-looking board: `node tools/seed-demo.mjs --players 8 --matches 24`.
- [ ] Run `node tools/live-check.mjs --seconds 26` and get `ALL GOOD`.
- [ ] Open the site on a phone **on mobile data** (not the school WiFi) and play one match.
- [ ] Decide what happens if the internet dies: offline mode is untouched, so the game always
      demos; keep `docs/05-DEPLOYMENT.md` Part C (laptop + tunnel) as the backup.

## What I need from you before Phase 4

1. **Which host you picked** (Fly / Render / Oracle / your own VPS) — the deployment steps in
   `05-DEPLOYMENT.md` are written for Fly and Render first.
2. **Whether room-code matches should count for the leaderboard.** Today they do (so a class can
   all play each other at the exhibition). Set `XP_ROOM_MATCHES=false` in `server/.env` to rank
   only Quick Match; room fights stay fully recorded on both profiles, they just stop paying XP.
   *(Implemented and covered by the backend suite.)*
3. **Whether you want the deterministic-replay refactor** (Phase 4). It is the single highest-value
   remaining item for the "anti-cheat" part of your rubric, but it is a real refactor of the game's
   simulation code — worth doing once Phase 1–3 are stable, not before.
