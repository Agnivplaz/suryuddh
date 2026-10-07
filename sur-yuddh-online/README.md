# Sur Yuddh — Online Edition

The school Science Exhibition 2026 project **Sur Yuddh** (instrument-battle game, originally a
single HTML file) extended into a proper online game: real accounts, real opponents over the
network, a server that decides who won, and one global leaderboard.

**Live at:** `https://<your-domain>` (see `docs/05-DEPLOYMENT.md`)

---

## What's in here

| Piece | Where | What it does |
|---|---|---|
| The game | `client/index.html` + `client/js/` + `client/vendor/` | The original game, plus the online layer (auth, lobby, profile, leaderboard, netcode) |
| The server | `server/src/` | REST API + WebSocket relay: accounts, matchmaking, rooms, authoritative match results, XP |
| The database | `server/src/db/` | Two interchangeable engines — SQLite (zero setup) and PostgreSQL (production) |
| Tests | `server/test/`, `client/test/` | 34 backend assertions + a two-client netcode test |
| Docs | `docs/` | Architecture audit, backend decision, system design, roadmap, deployment |

## Quick start (first time)

```bash
cd server
npm install            # ~1–2 min; compiles SQLite
cp .env.example .env   # JWT_SECRET can stay empty in development
npm start
```

Open **<http://localhost:8080>**. The game loads straight away; **Play Online** in the top bar
creates an account and finds you an opponent.

Want a populated leaderboard for a demo?

```bash
cd server
node tools/seed-demo.mjs --players 8 --matches 24     # demo_* accounts, password demopassword123
node tools/seed-demo.mjs --clear                      # remove them again
```

## Testing on one computer (two players)

Open two browser windows — a normal one and a private/incognito one (they need separate
sessions) — sign up as two different usernames, and use **Create Room** in one + **Join Room**
with the code in the other. Or hit **Quick Match** in both windows.

## Everyday commands

```bash
cd server
npm start                       # run (http://0.0.0.0:8080)
npm run dev                     # run with auto-reload
npm test                        # backend suite
npm run seed                    # demo players for the leaderboard
npm run balance                 # regenerate XP/balance tables from the game file

node tools/reset-password.mjs <username> <new-password>
node tools/reset-password.mjs --list
node tools/reset-password.mjs --ban <username>

cd ../client && node test/netcode.test.mjs        # two-client netcode test
```

## Playing without internet

The original offline mode is untouched: pick **vs Computer** on the title screen and the whole
game runs in the browser exactly as before, with local practice progress. Online matches never
use that local progress (it lives in your browser and can be edited), so leaderboard XP can only
come from the server.

## Deploying

Three routes, all free, in `docs/05-DEPLOYMENT.md`:

* **Fly.io (Singapore) + Neon Postgres** — recommended, always on
* **Render free** — simplest, but sleeps after ~15 min idle
* **Exhibition laptop + SQLite + Cloudflare Tunnel** — the no-internet demo-day fallback

Config files are already in the repo: `Dockerfile`, `fly.toml`, `render.yaml`.

## Docs, in reading order

1. `docs/01-ARCHITECTURE-AUDIT.md` — the original file, audited: renderer, storage, XP site, AI, the 7 things that had to be separated
2. `docs/02-BACKEND-DECISION.md` — every hosting option compared, the choice and why it costs ₹0
3. `docs/03-SYSTEM-DESIGN.md` — database schema, accounts, leaderboard, rooms, realtime protocol, the 8 anti-cheat layers
4. `docs/04-ROADMAP.md` — phase-by-phase plan and the exhibition checklist
5. `docs/05-DEPLOYMENT.md` — click-by-click deployment, environment variables, monitoring, backups

## Honest limitations

* A browser cannot be fully trusted; the server validates every result, but a determined
  attacker running modified game code can still play *slightly* better than the physics allow.
  Layer 8 in `docs/03` (deterministic replay) closes most of that gap and is Phase 4.
* The matchmaker and rooms live in the server's memory, so the app runs as **one instance**
  (`fly scale count 1`). Making it multi-instance needs a Postgres-backed hub — not worth it at
  this scale.
* If the judge's network blocks WebSockets, online play fails; offline mode always works.
