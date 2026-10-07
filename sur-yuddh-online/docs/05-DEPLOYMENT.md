# 05 · Deployment — from laptop to custom domain

Three routes, in the order I recommend them. All three are **₹0** except your existing domain.

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
| `QUEUE_TIMEOUT_MS` | `45000` | quick-match patience |
| `QUEUE_REMATCH_MS` | `8000` | wait before being allowed to rematch the same person |
| `ROOM_TTL_MS` | `7200000` | room code lifetime (2 h) |
| `TRUST_PROXY` | `true` in production | set `true` behind Fly/Render so IPs are real |
| `PUBLIC_DIR` | `../client` | where the game files live |

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
node ../client/test/netcode.test.mjs      # two-client netcode test
```

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
