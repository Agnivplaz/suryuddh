# Sur Yuddh — Online Edition

The school Science Exhibition 2026 project **Sur Yuddh** (instrument-battle game, originally a
single HTML file) extended into a proper online game: real accounts, real opponents over the
network, a server that decides who won, and one global leaderboard.

**Live at:** `https://<your-domain>` (see `docs/05-DEPLOYMENT.md`)

> **Deploying this copy?** Read **`README-FIRST.md`** first — it is the one-page upload guide, and the
> addresses for the Netlify site and the server are already filled in.

---

## What's in here

| Piece | Where | What it does |
|---|---|---|
| The game | `client/index.html` + `client/js/` + `client/vendor/` | The original game, plus the online layer (auth, lobby, profile, leaderboard, netcode) |
| The server | `server/src/` | REST API + WebSocket relay: accounts, matchmaking, rooms, authoritative match results, XP |
| The database | `server/src/db/` | Two interchangeable engines — SQLite (zero setup) and PostgreSQL (production) |
| Tests | `server/test/`, `client/test/` | 34 backend assertions + a two-client netcode test |
| Docs | `docs/` | Architecture audit, backend decision, system design, roadmap, deployment, **Netlify guide** |
| Netlify config | `netlify.toml`, `netlify/functions/` | Ready-made settings for hosting the game client on Netlify |

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

## Prove the whole thing works, without a browser

```bash
cd server
npm start                      # terminal 1
npm run selfcheck              # terminal 2 — plays a real match, then attacks the API
```

`selfcheck` signs up two accounts, quick-matches them over the real WebSocket, fights for 26
seconds, reports the result, checks the XP landed on the leaderboard, and then tries to cheat
(fake 50,000 XP through every plausible endpoint, plus two clients both claiming victory). It
prints one line per check and ends with `ALL GOOD`. Point it at a deployed server with
`npm run selfcheck -- --base https://your-app.fly.dev`.

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

**Everything on one host (simplest, recommended)** — `docs/05-DEPLOYMENT.md`:

* **Fly.io (Singapore) + Neon Postgres** — recommended, always on
* **Render free** — easiest UI, but sleeps after ~15 min idle
* **Exhibition laptop + SQLite + Cloudflare Tunnel** — the no-internet demo-day fallback

**Game on Netlify + server elsewhere** — `docs/06-NETLIFY.md`, start to finish. The one setting you
change is `client/config.json` (`"server": "https://your-server"`); nothing else needs editing. Netlify can host
the game (static files) but **cannot** host the match server: its functions are short-lived, and a
match needs one connection that stays open for minutes. The guide walks through Render (free) for
the server, the one-line `window.__SY_SERVER__` switch, `ALLOWED_ORIGINS`, the Hostinger DNS step,
and a troubleshooting table. Both halves are verified working cross-origin.

Config files are already in the repo: `Dockerfile`, `fly.toml`, `render.yaml`, `netlify.toml`.

## Docs, in reading order

1. `docs/01-ARCHITECTURE-AUDIT.md` — the original file, audited: renderer, storage, XP site, AI, the 7 things that had to be separated
2. `docs/02-BACKEND-DECISION.md` — every hosting option compared, the choice and why it costs ₹0
3. `docs/03-SYSTEM-DESIGN.md` — database schema, accounts, leaderboard, rooms, realtime protocol, the 8 anti-cheat layers
4. `docs/04-ROADMAP.md` — phase-by-phase plan and the exhibition checklist
5. `docs/05-DEPLOYMENT.md` — click-by-click deployment, environment variables, monitoring, backups
6. `docs/06-NETLIFY.md` — hosting the game on Netlify and the server on Render, with DNS and troubleshooting

## Honest limitations

* A browser cannot be fully trusted; the server validates every result, but a determined
  attacker running modified game code can still play *slightly* better than the physics allow.
  Layer 8 in `docs/03` (deterministic replay) closes most of that gap and is Phase 4.
* The matchmaker and rooms live in the server's memory, so the app runs as **one instance**
  (`fly scale count 1`). Making it multi-instance needs a Postgres-backed hub — not worth it at
  this scale.
* If the judge's network blocks WebSockets, online play fails; offline mode always works.
* Split hosting (game on Netlify, server elsewhere) adds one configuration step and ~20–40 ms of
  latency. If you do not need it, keep the game on the Node server — one URL, no CORS.
