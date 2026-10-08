# 05 · Deployment — from laptop to custom domain

Three routes, in the order I recommend them. All three are **₹0** except your existing domain.
(This document assumes the Node server also serves the game. If you want the game hosted
separately — e.g. on Netlify — read `06-NETLIFY.md` first.)

* **A. Fly.io + Neon** — recommended (always on, no cold starts, Singapore region ≈ 40 ms from Kolkata)
* **B. Render free** — simplest UI, but sleeps after ~15 min idle
* **C. Exhibition laptop + SQLite + Cloudflare Tunnel** — the demo-day safety net, no internet needed on the LAN

---

## 0. One-time prep (any route)

```bash
cd sur-yuddh-online/server
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → JWT_SECRET
```

Also create the `fly.toml` / `render.yaml` if you want them (Fly: `fly launch` generates one; a
ready-made `fly.toml` is included in `server/`).

---

## A. Fly.io (app) + Neon (database)

### A1. Database — Neon

1. Sign up at <https://neon.tech> (GitHub login is fastest, no card).
2. Create a project → region **Singapore (aws-ap-southeast-1)** → copy the **connection string**:
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
3. Apply the schema once:

```bash
cd sur-yuddh-online/server
psql "postgresql://…your neon url…" -f src/db/schema.postgres.sql
```

*(No `psql` installed? Either install the Postgres client, or start the server once locally with
`DB_CLIENT=postgres` — it applies the schema itself on boot.)*

### A2. App — Fly.io

> **Before you start — is your repo flat?** These commands assume the repository root contains
> `server/` and `client/`. If everything sits inside a `sur-yuddh-online/` folder (what you get by
> dragging the zip's folder onto GitHub), then either set **Root Directory** = `sur-yuddh-online` in
> the service settings, or prefix commands with `cd sur-yuddh-online/server && …`. Same story for
> Netlify's **Base directory** — see `06-NETLIFY.md`, Part 5.5.

```bash
# install the CLI: https://fly.io/docs/flyctl/install/
fly auth signup            # or: fly auth login
cd sur-yuddh-online/server
fly launch --no-deploy     # accept the detected Dockerfile/Node app; pick Singapore (sin)
```

Set the secrets (never commit these):

```bash
fly secrets set \
  JWT_SECRET="<the 48-byte string you generated>" \
  DATABASE_URL="<the Neon connection string>" \
  DB_CLIENT=postgres \
  DB_SSL=true \
  NODE_ENV=production \
  TRUST_PROXY=true \
  XP_ROOM_MATCHES=true
fly deploy
```

Commands you will actually use:

```bash
fly logs                 # live server logs
fly status               # is it running?
fly ssh console          # shell inside the machine (then: node tools/seed-demo.mjs)
fly scale count 1        # KEEP AT 1 while the matchmaker is in memory
```

### A3. Domain — Hostinger → Fly

In **hPanel → Domains → DNS / Nameservers → DNS records**, add:

| Type | Name | Value | TTL |
|---|---|---|---|
| `CNAME` | `suryuddh` (or `@` for the root, see note) | `your-app.fly.dev` | 3600 |
| `A` (only if you use the root) | `@` | the IP from `fly ips list` | 3600 |

Then tell Fly about the certificate:

```bash
fly certs add suryuddh.yourdomain.com
fly certs show suryuddh.yourdomain.com     # wait for "issued"
```

DNS usually propagates in minutes; the TLS certificate can take a little longer. Notes:

* **Subdomain (`suryuddh.example.com`) is the easy path** — a plain CNAME just works.
* **Root domain (`example.com`, no subdomain)** — DNS does not allow a CNAME at the root on most
  providers; either use Hostinger's A record with the Fly IPv4, or move the domain's nameservers
  to Cloudflare (free) and use a CNAME flattening record.
* **Do not** add an `AAAA`/`A` record pointing to Hostinger's parking page at the same time — that
  record will win and you will see a parking page instead of your game.

### A4. Verify

```bash
curl -s https://suryuddh.yourdomain.com/healthz          # {"ok":true,...}
curl -s https://suryuddh.yourdomain.com/api/status        # hub stats, online counts
```

Then open the site on a phone **on mobile data**, sign up, and play one room-code match.

---

## B. Render (simpler UI, free tier sleeps)

1. Push the project to GitHub (a private repo is fine).
2. <https://render.com> → **New → Web Service** → connect the repo.
3. Settings:
   * **Root directory:** `server`
   * **Build command:** `npm install`
   * **Start command:** `npm start`
   * **Health check path:** `/healthz`
   * **Instance type:** Free
4. Environment variables: the same set as A2 (`DB_CLIENT=postgres`, `DATABASE_URL`, `JWT_SECRET`,
   `NODE_ENV=production`, `TRUST_PROXY=true`).
5. Render gives you `https://sur-yuddh.onrender.com`; add a **Custom Domain** in Render and the
   matching CNAME in Hostinger (Render shows the exact value).

**The catch:** the free instance spins down after ~15 minutes of inactivity, so the first visitor
waits ~30–60 s while it boots (the WebSocket then works normally). Two mitigations:

* Free **keep-alive**: create a cron job at <https://cron-job.org> hitting
  `https://your-app.onrender.com/healthz` every 10 minutes. During exhibition hours this keeps it warm.
* Or just open the site yourself 2 minutes before judging.

---

## C. Exhibition laptop + Cloudflare Tunnel (demo-day safety net)

No hosting, no internet required for the players, works even if the school WiFi blocks WSS.

```bash
cd sur-yuddh-online/server
cp .env.example .env                 # DB_CLIENT=sqlite (the default)
npm start                            # http://0.0.0.0:8080, data/suryuddh.db
```

* **Players in the same room / same WiFi:** tell them to open
  `http://<laptop-ip>:8080` (find it with `ipconfig` / `ifconfig` / `ip addr`). Everyone plays
  through the laptop, no internet needed at all. Allow Node through the laptop firewall on port 8080.
* **Players outside the room, or the judges' phones on 4G:** expose it with a free tunnel:

```bash
# one-time: install cloudflared  (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
cloudflared tunnel --url http://localhost:8080
# → prints https://random-words-1234.trycloudflare.com — use that URL, or
#   add a CNAME in Hostinger pointing your subdomain at that hostname.
```

* **Optional robustness:** give SQLite mode a checkpoint before judging:
  `cp data/suryuddh.db data/suryuddh.backup.db`, and reset the board with
  `node tools/seed-demo.mjs --clear`.

Trade-off to state honestly if asked: in this mode everything runs on one laptop, so if the
laptop sleeps or the lid closes, the arena goes down. That is why route A/B exists.

---

## Reference

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket |
| `HOST` | `0.0.0.0` | must stay `0.0.0.0` in a container |
| `NODE_ENV` | `development` | production enforces a real `JWT_SECRET` and bcrypt cost 12 |
| `DB_CLIENT` | `sqlite` | `sqlite` or `postgres` |
| `DB_SQLITE_FILE` | `./data/suryuddh.db` | SQLite path |
| `DATABASE_URL` | — | required for `DB_CLIENT=postgres` |
| `DB_SSL` | `true` in production | Neon/Supabase need `true` |
| `JWT_SECRET` | dev fallback | **required** in production (≥24 chars) |
| `TOKEN_TTL_SEC` | `43200` | access token lifetime (12 h) |
| `MATCH_MIN_MS` | `20000` | matches shorter than this are voided (anti-cheat) |
| `DISCONNECT_GRACE_MS` | `15000` | how long a dropped player has before losing |
| `MIN_INPUT_FRAMES` | `40` | activity floor per player |
| `XP_DAILY_CAP` | `1500` | rolling 24 h XP ceiling per account |
| `XP_ROOM_MATCHES` | `true` | do room-code matches count for the leaderboard |
| `SIGNUP_PER_HOUR` | `5` | new accounts per IP per hour — **raise this for the exhibition**, see below |
| `LOGIN_MAX` | `10` | login attempts per IP + username per window |
| `LOGIN_WINDOW_MIN` | `15` | that window, in minutes |
| `ALLOWED_ORIGINS` | *(empty)* | extra browser origins allowed to call the API, comma-separated. Only for split deployments (game on Netlify, server here) — see `06-NETLIFY.md` |
| `QUEUE_TIMEOUT_MS` | `45000` | quick-match patience |
| `QUEUE_REMATCH_MS` | `8000` | wait before being allowed to rematch the same person |
| `ROOM_TTL_MS` | `7200000` | room code lifetime (2 h) |
| `TRUST_PROXY` | `true` in production | set `true` behind Fly/Render so IPs are real |
| `PUBLIC_DIR` | `../client` | where the game files live |

> ⚠️ **The shared-IP trap.** `SIGNUP_PER_HOUR` counts *per IP address*. At the exhibition
> every phone and laptop on the school WiFi arrives from the **same public IP**, so the default of
> 5 means only five students can create accounts in an hour — no matter how many devices there
> are. Set `SIGNUP_PER_HOUR=60` (or higher) the day before, and restart the server. This is the
> single most likely way the demo breaks.

### Take a screenshot of it working, without a browser

```bash
cd server
npm start                                       # in one terminal
node tools/live-check.mjs --seconds 26          # in another
```

It signs up two accounts, quick-matches them, fights for 26 seconds, reports the result, then
attacks the API (fake 50,000 XP, rigged winner claims) and prints a pass/fail line for each.
Finish with `ALL GOOD` and you have proof the whole chain works — accounts → matchmaking →
authoritative result → XP → leaderboard. Point it at production with
`--base https://your-app.fly.dev`, and use `--keep` if you want the test accounts to stay on the
board for a demo.

### Operational commands

```bash
npm start                      # run
npm run dev                    # run with auto-reload
npm test                       # backend suite (34 assertions)
npm run balance                # regenerate src/balance.json from the game file
npm run seed                   # fill the leaderboard with demo players
node tools/seed-demo.mjs --clear
node tools/reset-password.mjs <username> <new-password>
node tools/reset-password.mjs --list
node tools/reset-password.mjs --ban <username>
node tools/live-check.mjs --seconds 26   # full online round-trip + anti-cheat attacks
node ../client/test/netcode.test.mjs      # two-client netcode test
```

### Database engines differ — and one difference bites in production

The test suite runs on SQLite; production runs on PostgreSQL. A query that is valid on one can be
invalid on the other — most commonly boolean columns (`banned`, `validated`, `disconnected`), because
SQLite stores them as 0/1 integers and PostgreSQL has a real BOOLEAN type that rejects integers:

```sql
WHERE banned = 0        -- fine on SQLite, ERROR on PostgreSQL:
                        --   operator does not exist: boolean = integer
```

`npm run portability` scans the source for that class of mistake, and it runs as part of
`npm test`. If the deployed leaderboard returns 500 while everything else works, that is the thing
to check first.

### Monitoring a live event

* `GET /api/status` → `{online, queued, inMatch, openRooms}` — or just watch the Online Arena header.
* `GET /healthz` → uptime, for uptime monitors.
* Suspicious behaviour: `SELECT kind, detail, created_at FROM security_events ORDER BY id DESC LIMIT 50;`
* Leaderboard integrity at any time:
  `SELECT player_id, SUM(delta) AS audit_total FROM xp_audit GROUP BY player_id` should equal
  `players.total_xp` — if it ever doesn't, that is a bug, not a cheater.

### Backups

* Postgres: Neon/Supabase both keep automatic backups on the free tier; take a manual dump before
  demo day: `pg_dump "$DATABASE_URL" > backup.sql`.
* SQLite: copy `server/data/suryuddh.db` (plus `-wal`/`-shm` if present) while the server is stopped.
