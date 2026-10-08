# 02 · Which backend should Sur Yuddh use?

You asked me to decide this **after** reading the code, not before. Here is the reasoning,
the comparison, the decision, and exactly what it costs.

---

## 1. What the code demands from the backend

Derived from `01-ARCHITECTURE-AUDIT.md`, in order of importance:

| Need | Why | Consequence |
|---|---|---|
| **A. Static hosting** | the game is one HTML file + a few JS files | any static host works — but see (C), it must share an origin with the API to keep things simple |
| **B. Relational store with tiny aggregates** | accounts, matches, XP ledger, one leaderboard query (`ORDER BY total_xp DESC`) | Postgres or SQLite; **no** need for NoSQL, GraphQL, sharding or caching layers |
| **C. A persistent WebSocket channel** | inputs 30 Hz + snapshots 20 Hz, per match, for minutes | serverless HTTP functions (Vercel/Netlify/Cloudflare Workers request-response) **cannot** hold this. Needs a long-running process (or a hosted pub/sub product) |
| **D. Server-side authority** | your #1 requirement: the browser must not be able to award itself XP | the decision logic has to live somewhere the client cannot reach — i.e. a real server process |
| **E. Zero budget** | you only pay for the domain | free tiers must cover it, and the exhibition demo must not hit a paywall mid-match |
| **F. Works on school WiFi** | school networks block CDNs, sometimes block non-standard ports | HTTPS/WSS on 443, assets served from our own origin, no CDN dependency |
| **G. Custom domain** | you already own it at Hostinger | needs a DNS record you can point anywhere (CNAME/A) — no need to *buy* hosting there |
| **H. One developer, one evening** | you | boring, standard, copy-pasteable deployment |

The decisive ones are **C** and **D**: whatever we pick must run server code that can hold a
socket open and hold the truth about a match. That single sentence rules out most "no-server"
options.

---

## 2. Options, honestly compared

| Option | Cost | Holds a socket? | Can validate results server-side? | Verdict |
|---|---|---|---|---|
| **Supabase only** (Auth + Postgres + Realtime *Broadcast* + Edge Functions) | ₹0 | Realtime broadcast: yes (client↔client). Edge Functions: no (short-lived) | **No** — an Edge Function only knows what a client tells it in a single request | Great database + auth, **wrong tool for the match authority**. Good as the DB half of the recommended stack. |
| **Hostinger shared hosting + PHP + MariaDB** | ₹149–₹299/mo (only if you buy hosting) | No — shared tiers kill long-lived WS; Passenger-based Node is limited | Yes (PHP can validate) | You'd pay monthly for something that cannot do the realtime part well. **Not recommended.** |
| **Hostinger VPS** | ~₹400–₹550/mo | Yes | Yes | Works, but you'd be paying for what free tiers give you. Only if you want one bill. |
| **Hostinger PaaS (Node.js app hosting)** | ~₹300+/mo | Usually yes | Yes | Fine, costs money, no advantage over free options. |
| **Vercel / Netlify (serverless)** | ₹0 | **No** (no long-lived sockets on hobby) | partially | Wrong shape for this game. |
| **Cloudflare Workers + Durable Objects** | ₹0-ish (DOs now on free plan) | Yes (Durable Objects are designed for exactly this) | Yes | Technically excellent, but the tooling/Wrangler learning curve is steep for one evening, and SQLite-in-DO adds friction. Keep as a "phase 5" idea. |
| **Replit / Glitch / similar** | ₹0 | yes | yes | Sleeping/limit policies change often; not something to gamble the exhibition on. |
| **Render free web service** | ₹0 | Yes | Yes | Works. **Sleeps after ~15 min idle** → first visitor waits ~40 s. Mitigate with a keep-alive ping. |
| **Fly.io** (small machine) | ₹0–₹450/mo depending on current allowances | Yes | Yes | Recommended; put the machine in `sin` (Singapore) for low Kolkata latency. |
| **Oracle Cloud Always Free (VM.Standard.A1.Flex, 4 OCPU/24 GB)** | **₹0, forever** | Yes | Yes | The most generous free option if you can pass signup; you manage the OS yourself. |
| **Neon / Supabase Postgres** | ₹0 (Neon: 0.5 GB + 190 compute-h; Supabase: 500 MB) | n/a | n/a | Recommended database. |
| **Exhibition laptop + Cloudflare Tunnel** | ₹0 | Yes | Yes | The **zero-risk fallback** for demo day (see §5). |

---

## 3. The decision

> ### ✅ Recommended architecture
>
> **Node.js 20 service (REST + WebSocket) on Fly.io `sin`, PostgreSQL on Neon (or Supabase)
> free tier, the game served from the same Node process, the Hostinger domain pointed at
> Fly with a CNAME. Total recurring cost: ₹0.**

```
                    ┌──────────────────────── Fly.io (Maharashtra→Singapore, ~40 ms)
 player A  ─────────┤  Node 20 · Express (REST)  +  ws (WebSocket)  ·  static game files
                    │  in-memory live matches (authority)  ──┐
 player B  ─────────┤  XP engine + validation               │  SQL (TCP 5432)
                    └───────────────────────────────────────┼─────────────────────────
                                                            ▼
                                               ┌──────────────────────────────┐
                                               │ Neon / Supabase Postgres     │
                                               │ players · matches · rooms ·  │
                                               │ match_players · xp_audit     │
                                               └──────────────────────────────┘
        suryuddh.yourdomain.com  →  CNAME  →  <app>.fly.dev   (Hostinger DNS panel)
```

**Why this shape, in one line each:**

* the **game and the API share an origin** → no CORS, no third-party cookies, one URL to deploy,
  one thing to debug;
* the **socket lives in a process we control** → 20–30 Hz relay, server-validated results;
* the **database only stores durable facts** (accounts, matches, XP, rooms) — never live game
  state (writing ~60 fps × 2 players ≈ 7,200 rows/s would destroy any database and any free
  tier);
* **free tiers cover a school-exhibition workload** by orders of magnitude (see §4);
* nothing is locked in: swapping Fly for Render/Railway/or a VPS is one deploy command, and
  swapping SQLite for Postgres is one environment variable (`DB_CLIENT`).

**What I deliberately did *not* use:** Socket.IO (heavier, hides the protocol — you want the
messages visible in DevTools when a judge asks "how does it work?"), any ORM (the SQL in
`server/src/db/schema.*.sql` is readable and is itself documentation), Redis (not needed for a
single instance; it is the one change required to run two instances), and Next/React (the game
is already a hand-written single page — adding a framework would be pure overhead).

---

## 4. What it costs — the honest table

| Item | Free tier limit | What Sur Yuddh uses | Headroom |
|---|---|---|---|
| Fly.io small machine | free allowances / or ~US$2–3 per month if you outgrow them | 1 shared-CPU-1x, 256 MB RAM, idle RAM ~45 MB | huge |
| Neon Postgres | 0.5 GB storage, 190 compute-hours/mo | one row ≈ 1 KB → **~500,000 matches**; a match costs <1 s of DB CPU | huge |
| Supabase (alternative DB) | 500 MB, 2 GB egress, 50k MAU | same | huge |
| Render (alternative host) | 750 h/mo, sleeps after 15 min | works, but cold starts | medium |
| Bandwidth | Fly/Neon include GB-scale egress | snapshots ≈ 250 B × 20/s ≈ **5 KB/s per match** → ~18 MB per hour of a single match | huge |
| **Domain** | — | **the only thing you already pay for** | — |
| Upgrade path if the school wants it | Fly ~₹250/mo; Supabase Pro US$25/mo; Hostinger VPS ~₹450/mo | not needed for inter-school | — |

Realistic worst case for the exhibition: **₹0**, with the entire cost being the domain you
already own.

---

## 5. Zero-risk fallback for demo day

If the school WiFi blocks outbound WSS or the internet dies during judging:

```
Exhibition laptop  →  node server/src/index.js   (SQLite file, DB_CLIENT=sqlite)
                   →  cloudflared tunnel --url http://localhost:8080
                   →  suryuddh.yourdomain.com  (CNAME → the tunnel)
```

* Other laptops/phones in the same room connect **directly to `http://<laptop-ip>:8080`**,
  needing no internet at all (`DB_CLIENT=sqlite` means zero external dependencies).
* If a laptop cannot even do that, the game still has its original **offline AI mode** — which
  is the demo you point at while explaining that the online part is disabled on purpose rather
  than broken.

That two-minute switch (`cp .env.sqlite .env`) is the reason the database layer has **two
engines behind one interface** instead of hard-coding Supabase.

---

## 6. Environment / deployment requirements (what a host must provide)

| Requirement | Detail |
|---|---|
| Runtime | Node ≥ 20 (uses `node:crypto`, ESM, `fetch`); no native build needed for Postgres mode |
| Memory | ~45 MB idle, ~80 MB with 20 live matches |
| Ports | one inbound HTTP port (`PORT`, default 8080) serving both REST and WSS |
| Env vars | `JWT_SECRET` (**required in production**), `DATABASE_URL` + `DB_CLIENT=postgres` (or `DB_CLIENT=sqlite` for LAN), `NODE_ENV=production`, `TRUST_PROXY=true` behind a proxy |
| Healthcheck | `GET /healthz` (Fly/Render both use it) |
| Instances | **exactly 1** while the matchmaker lives in memory. Two instances = two queues. To scale out: move the queue + presence to Redis (one file, `src/realtime/hub.js`) or pin one instance. |
| Persistence | nothing on disk is required in Postgres mode; SQLite mode needs a writable volume |
| Outbound | TCP 5432 to the database |

Full click-by-click steps: **`05-DEPLOYMENT.md`**.

---

## Addendum — hosting the game client separately (Netlify / Vercel / GitHub Pages)

The decision above stands: the *match server* must be a long-lived process, so it cannot live on a
static host. But the **game files** can, and it is a legitimate split:

* game on **Netlify** (that is what students usually already have an account for, and drag-and-drop
  deployment is genuinely 2 minutes);
* API + WebSocket on **Render/Fly** as described above.

The server already supports it: set `ALLOWED_ORIGINS` to the site's origin and put
`window.__SY_SERVER__ = 'https://your-server'` in `client/index.html`. Verified working in both
directions (cross-origin REST **and** cross-origin WebSocket). Full walkthrough:
**`06-NETLIFY.md`**. The only cost is one extra hop of latency (~20–40 ms) and one more thing to
configure; if you do not need the client hosted separately, keep it on the Node origin as designed.
