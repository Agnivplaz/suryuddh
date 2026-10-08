# 06 · Deploying on Netlify — complete walkthrough

You asked for the full path from "I have a Netlify account" to "the game is live and working".
Here it is, in order, with nothing skipped. Read Part 0 first — it is 60 seconds and it decides
whether the rest makes sense.

---

## Part 0 · What Netlify can and cannot do for this project

Netlify serves **files**. It does not run a program that stays alive.

| Part of Sur Yuddh | Needs | Netlify |
|---|---|---|
| The game itself (`client/index.html`, `js/`, `vendor/`) | static files | ✅ perfect |
| The GLOBAL LEADERBOARD, profile pages, match history | a REST API reading a database | ❌ |
| Quick Match, Create/Join Room, live fights | one long-lived, always-open connection per player (WebSocket) | ❌ |
| Deciding who won and paying XP | a process that watched the match | ❌ |

Netlify Functions are **short-lived** — they start when a request arrives and are frozen seconds
later. A WebSocket match lasts minutes, so a function cannot host one. This is not a Netlify
limitation to work around; it is true of every static host (Vercel, GitHub Pages, Cloudflare
Pages) and it is why the architecture separates the two.

So there are exactly three honest routes:

| Route | Where the game is | Where the match server is | Verdict |
|---|---|---|---|
| **A** | Netlify | Render free tier | ✅ **works, ₹0, do this** |
| **B** | Netlify | nowhere | loads and plays offline mode only — a nice-looking demo, no leaderboard |
| **C** | the Node server itself (Render/Fly/laptop) | same place | the simplest of all, but the game is not "on Netlify" |

I verified Route A works end-to-end from this exact codebase (cross-origin REST **and**
cross-origin WebSocket, both against a real server) before writing the steps below.

**Total time: about 25 minutes.** No card, no paid plan, no command line required if you follow
the GitHub-web-UI variant.

---

## Part 1 · Deploy the match server first (Render, free)

You need its URL before Netlify can be pointed at it.

### 1.1 Put the project on GitHub (browser only — no git needed)

1. Go to <https://github.com> → **Sign up** (skip if you have an account).
2. Top-right **+** → **New repository**.
3. Name it `sur-yuddh`. Choose **Private** (fine for free plans) or Public. **Do not** tick any
   "Add a README" box. Click **Create repository**.
4. On the empty repo page click **uploading an existing file**.
5. Unzip `sur-yuddh-repo.zip` on your computer. Open the `sur-yuddh-online` folder, select
   **everything inside it** (not the outer folder), and drag it onto the GitHub upload page.
   *Drag folders, not just files* — `client`, `server`, `docs`, `netlify`, plus `README.md`,
   `Dockerfile`, `fly.toml`, `render.yaml`, `netlify.toml`.
   Wait for all files to list, then **Commit changes**.
   Do **not** upload `node_modules` or `server/.env` (they are intentionally not in the zip).
6. The repo should show `client/`, `server/`, `netlify/`, `docs/` at the top level.

### 1.2 Render: create the service

1. Go to <https://render.com> → **Get Started** → sign up **with GitHub** (authorise Render to
   read your repos; choosing "Only select repositories" → `sur-yuddh` is fine).
2. Dashboard → **New +** → **Web Service**.
3. Under "Git Provider", pick the `sur-yuddh` repo → **Connect**.
4. Fill the form exactly like this:

   | Field | Value |
   |---|---|
   | Name | `sur-yuddh` |
   | Region | **Singapore** (closest to India) |
   | Branch | `main` |
   | **Root Directory** | leave **empty** |
   | Runtime | Node |
   | **Build Command** | `cd server && npm install` |
   | **Start Command** | `cd server && npm start` |
   | Instance Type | **Free** |

   *(Render reads `render.yaml` in the repo root and will offer to create this for you —
   accepting that is fine too; the values end up the same.)*

5. Scroll to **Environment Variables** → **Add Environment Variable**, one row each:

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `HOST` | `0.0.0.0` |
   | `DB_CLIENT` | `postgres` |
   | `DB_SSL` | `true` |
   | `TRUST_PROXY` | `true` |
   | `JWT_SECRET` | paste any long random text, ≥ 32 characters (e.g. three random sentences mashed together) |
   | `DATABASE_URL` | *see step 1.3 — add after you create the database* |
   | `SIGNUP_PER_HOUR` | `60` — **important, see the note below** |

   > ⚠️ `SIGNUP_PER_HOUR` defaults to 5 **per IP**. At the exhibition every visitor on the school
   > WiFi shares one public IP, so the default would let only 5 students create accounts *in the
   > whole hour*. Set it to 60 (or more) before demo day.

6. Click **Create Web Service** (if it does not let you save without `DATABASE_URL`, pick
   "Create" anyway and add it in the next step — the service will just restart once).

### 1.3 A free PostgreSQL database (Neon)

1. <https://neon.tech> → **Sign Up** (GitHub login works) → **Create project**.
2. Name: `suryuddh`. Region: **AWS ap-southeast-1 (Singapore)**. Postgres version: default. **Create**.
3. On the project page click **Connect** → copy the **connection string**. It looks like:
   `postgresql://neondb_owner:AbC123@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
4. Back in Render → your service → **Environment** → add `DATABASE_URL` with that string → **Save**.
   Render redeploys automatically.
   *(No need to run the schema by hand: the server applies `schema.postgres.sql` on first boot,
   and it is idempotent.)*

### 1.4 Confirm the server is alive

When the Render log shows `Sur Yuddh — online server` and **Live**, open:

```
https://sur-yuddh.onrender.com/healthz     →  {"ok":true,"uptime":...}
https://sur-yuddh.onrender.com/            →  the game (it works here too!)
https://sur-yuddh.onrender.com/api/leaderboard
```

Note your exact URL — that is the `MATCH_SERVER_URL` for everything below.
(Render names it after the service; if the name was taken it may be `sur-yuddh-abc1.onrender.com`.)

**Free-tier behaviour to expect:** the instance sleeps after ~15 minutes with no traffic. The next
visitor waits ~30–60 s for it to wake, then everything is normal. Fix it for demo day by creating
a free cron job at <https://cron-job.org> hitting `https://<your-app>.onrender.com/healthz` every
10 minutes, or simply open the site 2 minutes before judging.

---

## Part 2 · Point the game at that server (one JSON line)

The game files are plain HTML/JS; the only thing they need to know is *where the API lives*.
Do this in **`client/config.json`** — a separate small file, so you never edit JavaScript or HTML:

1. In the GitHub repo open `client/config.json`, click the **pencil** (Edit) icon.
2. It looks like this:

   ```json
   {
     "_help": "…",
     "server": ""
   }
   ```

3. Put your server address between the quotes of `"server"` — with `https://`, **no trailing
   slash**:

   ```json
   {
     "_help": "…",
     "server": "https://sur-yuddh.onrender.com"
   }
   ```

   Keep the quotes, the comma, and the curly braces exactly as they are. JSON is strict: a missing
   quote breaks it, and the game will tell you so in the console rather than failing silently.

4. **Commit changes** (green button) → Netlify rebuilds in ~30 s → hard-refresh the page
   (`Ctrl+Shift+R`).
5. Leave `"server": ""` when the Node server is serving the page itself (Route C / local play) —
   the game then uses the same origin, which always works.

*Precedence, for the record: `window.__SY_SERVER__` in `index.html` (if you ever set it) wins over
`config.json`, which wins over same-origin. You only need one of them.*

### 2.2 Tell the server to accept calls from Netlify

The browser will refuse to call a different domain unless that domain is allowed. So:

1. Decide your Netlify address now (you can choose it when creating the site, e.g.
   `suryuddh-exhibition.netlify.app`) — that way you know the origin before you need it.
2. Render → your service → **Environment** → add a new variable:

   | Key | Value |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://suryuddh-exhibition.netlify.app` |

   Add your custom domain later in the same variable, comma-separated, no spaces:
   `https://suryuddh-exhibition.netlify.app,https://suryuddh.yourdomain.com`
3. **Save** → Render redeploys (about a minute). Skipping this step is the single most common
   reason the game loads on Netlify but cannot sign in.

---

## Part 3 · Netlify: add the project

### 3.1 If you used GitHub (recommended)

1. Log in at <https://app.netlify.com>.
2. **Add new project** → **Import an existing project**.
   (Newer dashboards say **Add new site** → *Import an existing project* / *Deploy with GitHub*.)
3. **GitHub** → **Authorize Netlify** (grant access to the `sur-yuddh` repo) → pick the repo.
4. Netlify reads `netlify.toml` from the repo and pre-fills the form. Confirm it says:

   | Field | Value |
   |---|---|
   | Branch to deploy | `main` |
   | Build command | `echo 'static client only — nothing to build'` (or just `echo hi`) |
   | Publish directory | `client` |
   | Functions directory | `netlify/functions` |

   If the fields are empty, type those values in by hand. There is nothing to compile — the game
   is already finished HTML/JS.
5. Under **Site name** (or later in *Site configuration → Change site name*) set something you
   like: `suryuddh-exhibition` → your site becomes `https://suryuddh-exhibition.netlify.app`.
   Make sure this matches what you put in `ALLOWED_ORIGINS` in step 2.2.
6. Click **Deploy site**. The first build takes ~30 seconds.
7. When it says **Published**, click **Open production deploy**. The game should load.

### 3.2 If you do not want a GitHub account (drag & drop)

1. On <https://app.netlify.com> → **Add new project** → **Deploy manually**
   (the drop zone at the bottom of the page).
2. Unzip the project, open the `sur-yuddh-online` folder and drag the **`client` folder's
   contents** (`index.html`, `js`, `vendor`, …) into the drop zone.
   *(Netlify deploys exactly what you drop as the site root, so drop the *contents*, not the folder.)*
3. Wait for "Site deployed" → **Open production deploy**.

   Trade-off, stated plainly: this route has no functions and no automatic rebuild. You must
   re-drag the files after every change, and `/api/*` will 404 instead of explaining itself. It is
   fine for showing the game, and the online features still work because they go straight to
   Render. The GitHub route is what the rest of this document assumes.

---

## Part 4 · Your own domain (Hostinger → Netlify)

You already own the domain; this is the part that makes the project look finished.

1. Netlify → your site → **Domain management** (or **Domain settings**) → **Add a domain**.
2. Type your domain → **Verify** → **Add domain**.
   * Use a subdomain (`suryuddh.yourdomain.com`) — a CNAME just works.
   * The bare root domain (`yourdomain.com`) also works, but Netlify will ask you to either move
     your nameservers to Netlify or use their DNS panel; a CNAME at the root is not allowed by DNS
     itself. Using a subdomain avoids the whole problem.
3. Netlify now shows, e.g., **`suryuddh` → `suryuddh-exhibition.netlify.app`**. Copy that value.
4. Open Hostinger **hPanel** → **Domains** → your domain → **DNS / Nameservers** → **DNS records**.
5. Add a record:

   | Type | Name | Value / Points to | TTL |
   |---|---|---|---|
   | `CNAME` | `suryuddh` | `suryuddh-exhibition.netlify.app` | 3600 |

   **Delete any conflicting record** for that same name first — especially an old `A` record or a
   Hostinger parking/forwarding record. A leftover `A` record wins over the CNAME and you will see
   a parking page instead of your game. Hostinger's "Parking"/"Forwarding" features may also need
   to be switched off for the subdomain.
6. Wait 5–30 minutes (usually much less). Back in Netlify → **Domain management**, the entry turns
   green with **Netlify DNS** / **HTTPS** when it is live. Netlify issues the TLS certificate
   automatically — do **not** buy an SSL certificate.
7. Add the new domain to `ALLOWED_ORIGINS` on Render (step 2.2) and redeploy, otherwise sign-in
   will fail on the custom domain even though the page loads.

---

## Part 5 · Test it exactly as a judge would (10 minutes)

Run these in order. If one fails, the troubleshooting table below says why.

1. **Page loads** — open `https://suryuddh-exhibition.netlify.app`. The title screen, the three.js
   scene and the menu buttons appear. *(If the arena is black, see #3 below.)*
2. **Offline still works** — **vs Computer** → play 30 seconds. This needs no server at all, so it
   proves the game itself is fine.
3. **The connection is real** — open the browser console (F12 → Console). Type:
   `SY.serverUrl` → it must print your Render URL, not the netlify.app one.
   If it prints `netlify.app`, step 2.1 did not get committed.

   Then sign in and type `SY.rt.state`:

   | It prints | Meaning |
   |---|---|
   | `"open"` | the WebSocket is connected — live matches will work |
   | `"connecting"` | still handshaking, or the server is waking up (Render cold start) |
   | `"closed"` | something between you and the server is blocking WebSockets: wrong URL, wrong scheme (`http://` instead of `https://`), or a school/office firewall. Try a phone on mobile data to tell the two apart. |

   This one line is the fastest way to diagnose "the buttons do nothing". If anything still looks
   wrong, `SY.diagnose()` prints the page origin, the configured server, the socket URL and state,
   and a plain-English list of what is misconfigured.
4. **Sign up** — **Play Online** → create a username + password → you land in the lobby.
   A "could not reach the server" toast here means `ALLOWED_ORIGINS` is wrong (troubleshooting #2).
5. **Leaderboard** — the GLOBAL LEADERBOARD tab lists seeded/demo players with XP, or says it is
   empty. Either is fine; what matters is that it does not say "unavailable".
6. **Two devices** — phone on **mobile data** + laptop: sign up as two players, one **Create Room**,
   the other **Join Room** with the code, play the match to the end.
7. **Profile** — the winner's Profile shows Total XP, Games played, Wins/Losses and a match-history
   row with opponent, result, XP and duration.
8. **Anti-cheat, live** — from the project folder on any computer:

   ```bash
   cd server
   node tools/live-check.mjs --base https://sur-yuddh.onrender.com --seconds 26
   ```

   It plays a real match against your deployed server and then attacks it (fake XP, rigged
   results). It should finish with **ALL GOOD**. This is also the single best thing to show a
   science-exhibition judge.

---

## Part 5.5 · "My repo has an extra folder level" (the most common first-deploy failure)

**Symptom.** Render says:

```
bash: line 1: cd: server: No such file or directory
Build failed 😞
```

and the line above it betrays the real layout: `Using Node.js … via sur-yuddh-online/server/package.json`.
Netlify fails the same way, with a build error and no site.

**Cause.** When you drag the *folder* `sur-yuddh-online` (the one inside the zip) onto GitHub, GitHub
keeps the folder. The repo root therefore contains one folder, `sur-yuddh-online/`, and every path in
these guides is off by one level: the real paths are `sur-yuddh-online/client`, `sur-yuddh-online/server`.

> **Update:** the package shipped with this project is now **flat** — `client/`, `server/`, `docs/`
> and the rest sit at the top of the zip, so the repo root *is* the project root. If you use that
> package and drag the items themselves (not the folder they came in), none of this section is
> needed. It stays here for repos that already have the extra level.

**Fix — Render (3 fields).** Settings → **Build & Deploy**:

| Field | Value |
|---|---|
| **Root Directory** | `sur-yuddh-online` |
| Build Command | `cd server && npm install` |
| Start Command | `cd server && npm start` |

*Alternative, if you prefer leaving Root Directory empty:* keep the commands as
`cd sur-yuddh-online/server && npm install` and `cd sur-yuddh-online/server && npm start`.

Save → Render redeploys by itself. **This was verified against the exact nested layout**: from a repo
root containing only `sur-yuddh-online/`, those commands install and serve the game, the API and the
WebSocket.

**Fix — Netlify (1 field).** Site configuration → **Build & deploy** → **Build settings** → **Edit
settings** → set **Base directory** to `sur-yuddh-online`. Now Netlify finds
`sur-yuddh-online/netlify.toml` (which already declares everything else) and the paths resolve.
While you are there, confirm the three fields read:

| Field | Value |
|---|---|
| Base directory | `sur-yuddh-online` |
| Build command | `echo client-only` |
| Publish directory | `client` |
| Functions directory | `netlify/functions` |

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

> Tip for next time: when uploading, open the `sur-yuddh-online` folder and drag the items **inside**
> it (client, server, netlify, docs, README.md, …) — not the folder itself. Then the repo root *is*
> the project root and none of this is needed.

**Optional tidy-up (later, once it all works).** Flattening a repo through the GitHub website means
editing every file's path one at a time — not worth it. Leave the folder in place; the two settings
above are all it costs.

**One more thing while you are in the file editor:** your server's `package.json` currently accepts
any Node ≥ 20, and Render picked Node **26** for you. Node 26 is very new and the native SQLite
module may not have a prebuilt binary for it, which would fail the install. Pin it:

`sur-yuddh-online/server/package.json` → change

```json
  "engines": {
    "node": ">=20"
  },
```

to

```json
  "engines": {
    "node": ">=20 <26"
  },
```

Commit that (pencil icon → Commit changes) and Render will use Node 22 or 24 — both battle-tested
with this project.

## Part 5.6 · "Create Profile" and the leaderboard say **HTTP 404** on the Netlify page

This is the exact symptom of one thing: **the page is asking Netlify for the API.** Netlify is a
static host, it has no `/api/*`, so it answers 404. The game itself is fine — it simply has not been
told where the server lives.

**Confirm it in one line.** Open the Netlify page, press F12, and paste:

```js
SY.diagnose()
```

If you see `configuredServer: null` together with a line about `window.__SY_SERVER__`, that is the
cause, confirmed. (From now on the page also shows a toast and a console message saying so, instead
of leaving you with a bare status code.)

**The fix has two parts — the first is easy to forget:**

1. **Tell the game where the server is** — edit `client/config.json` (pencil icon in GitHub) and
   put your real server URL in `"server"` — `https://`, **no trailing slash**:

   ```json
   { "server": "https://sur-yuddh.onrender.com" }
   ```

   Commit → Netlify rebuilds (~30 s) → hard-refresh the page (`Ctrl+Shift+R`).

2. **Let the server accept calls from that page.** Render → your service → **Environment** → add

   | Key | Value |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://your-site.netlify.app` |

   Save (it redeploys). Without this the next error is a CORS failure instead — the request leaves
   the browser and is refused for a different reason. Both halves are needed.

**Is your server even up?** Open `https://<your-app>.onrender.com/healthz` in a new tab:

* `{"ok":true,...}` → the server is fine; the problem was only step 1/2 above.
* A Render error page or a 404 → the server never deployed; go back to **Part 5.5** (Root Directory)
  and check the Render log.

> **Fastest way to see it working at all:** open `https://<your-app>.onrender.com/` directly. The
> game and the API are on the *same* origin there, so everything works with no configuration —
> sign up, leaderboard, matches. Use that for "is my site working?" checks, and treat the Netlify
> URL as the polished front door once steps 1 and 2 are done.

**If you deployed to Netlify by drag-and-drop** there is no repo behind it, so: edit
`client/config.json` on your computer, then drag the `client` folder's contents in again. (This is
why the GitHub route is worth the five minutes — a commit replaces that.)

### "SY is not defined" in the console

That message means **`client/js/net.js` never ran** — the online layer is simply not there, so no
amount of configuring the server address will help. It is always a *file-delivery* problem, and
there are exactly three causes:

| Check | How | Fix |
|---|---|---|
| The `js/` folder was not deployed | Open `https://your-site.netlify.app/js/net.js` in a new tab. A wall of JavaScript = fine. A Netlify 404 page, or **HTML** (you see `<html>`), = this is it | Publish directory must point at the folder that **contains** `index.html`, with `js/` and `vendor/` beside it. If you dragged the `client` folder itself into Netlify, the site needs `/client/...` in the URL — drop the folder's *contents* instead. GitHub route: set **Base directory** = `sur-yuddh-online` (Part 5.5) |
| Something between Netlify and the browser rewrites unknown paths to `index.html` | The same test as above returns the game's HTML instead of JavaScript | Remove a catch-all `/*` → `/index.html` redirect, or make sure it does not swallow `/js/*`. The bundled `netlify.toml` only rewrites unknown paths, and `/api/*` on purpose |
| The edit to this file broke the HTML | View source of the page and check the block near the bottom is intact | Replace that whole block with the shipped version — the easiest way is to re-copy `client/index.html` from the project, or use `config.json` (Part 2) so you never touch this file again |

The page now also **shows a red banner** in this situation instead of staying silent:
*"the online layer did not load (js/net.js)"*. If you see that banner, it is one of the three rows
above — the banner text tells you which files failed.

## Part 5.7 · The leaderboard says "Server error" (HTTP 500) — PostgreSQL vs SQLite

If the **game and sign-in work** but `/api/leaderboard` returns `{"error":"Server error."}` with a 500,
the cause is almost always this one:

```sql
SELECT ... FROM players WHERE banned = 0     -- final SQLite syntax
ERROR:  operator does not exist: boolean = integer
```

Production uses PostgreSQL, where `banned`, `validated` and `disconnected` are real **BOOLEAN**
columns; SQLite (used by the local test suite) stores them as 0/1 integers. The old code compared
them to `0` and wrote `1` into them, which SQLite accepts and PostgreSQL rejects — which is why it
passed every local test and failed in production.

The current code passes booleans through a small dialect-aware helper (`toDbBool`), and there is a
static guard so this cannot come back:

```bash
cd server
npm run portability      # scans the source for boolean/integer mismatches (also part of npm test)
```

Symptom seen in the browser: the leaderboard shows *"Could not load the leaderboard. HTTP 500"* and
the Render log contains `operator does not exist: boolean = integer`.
**Fix:** make sure your deployed `server/src/` is the current package (the same "replace the files"
step from Part 5.5) and redeploy.

## Part 6 · Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Leaderboard shows "HTTP 500" / "Server error" while sign-in works** | PostgreSQL rejecting integer literals in BOOLEAN columns (production-only bug) | Deploy the current `server/` package — see **Part 5.7**. Confirm with `npm run portability`. |
| **`SY is not defined` in the console** | `js/net.js` never ran — a file-delivery problem, not a settings one | See **Part 5.6.1** below. Open `/js/net.js` in a new tab: if you get HTML or a 404, fix the publish directory. |
| **A red banner at the bottom of the page: "the online layer did not load"** | Same as above — the page now detects it for you | Same fix. The banner lists exactly which files (`js/net.js`, `js/online-ui.js`, `js/mp.js`) did not load. |
| **"Create Profile" shows `HTTP 404`; leaderboard says `HTTP 404`** | The page is asking a static host for the API — `window.__SY_SERVER__` is empty | See **Part 5.6**. Run `SY.diagnose()` to confirm in one line. |
| **Game loads but "cannot reach the server", console shows a CORS error** | `ALLOWED_ORIGINS` on Render does not match the URL in your address bar | Make them identical, including `https://` and **no trailing slash**; save → wait for redeploy. Both your netlify.app and custom-domain URLs must be listed. |
| `SY.serverUrl` prints the netlify.app host | `window.__SY_SERVER__` is still empty in `client/index.html` | Edit it (Part 2.1) and commit; Netlify rebuilds in ~30 s. |
| First action works, everything after fails; console shows `WebSocket` errors | `__SY_SERVER__` set to `http://…`; an https page cannot open `ws://` | Use the `https://` form. The client converts it to `wss://` itself. |
| The page says "this site is static only" / a `netlify_static_only` JSON reply | Something hit `/api/*` on Netlify — `__SY_SERVER__` is unset or the API host is wrong | Same as row 2. (That reply is the signal function `netlify/functions/signal.mjs` explaining itself on purpose.) |
| Works, then stops working after 15 idle minutes; first click hangs ~45 s | Render free tier woke the instance up | Expected. Add the cron-job.org keep-alive for demo day. |
| "Too many accounts created from here" | Per-IP signup ceiling (default 5/hour) | Set `SIGNUP_PER_HOUR=60` on Render. |
| Netlify build fails: "publish directory not found" | Publish directory is not `client` | Site configuration → Build & deploy → set Publish directory to `client`, then **Trigger deploy → Clear cache and deploy site**. |
| **Render: `cd: server: No such file or directory`** | The repo has an extra `sur-yuddh-online/` folder level | See **Part 5.5** above — set Root Directory / Base directory. |
| **Netlify: build failed, exit code 2, no site** | Same extra folder level — Netlify never found `netlify.toml`, so it used whatever the UI had, and the publish directory did not exist | See **Part 5.5**: set Base directory = `sur-yuddh-online`. |
| Render build fails while installing `better-sqlite3` | Node 26 is too new for the prebuilt native binary | Pin `"node": ">=20 <26"` in `server/package.json` (Part 5.5). |
| Render/Netlify built fine but the *next* deploy also fails after you edit a file | You edited the file in a fork/branch, not `main` | Check the branch selector; both hosts deploy `main` by default. |
| Custom domain shows a Hostinger parking page | A leftover `A`/forwarding record on that name | Delete the conflicting DNS record; leave only the CNAME. |
| Sign-in works on netlify.app but not on the custom domain | The custom domain was never added to `ALLOWED_ORIGINS` | Add it, redeploy Render. |
| Leaderboard is empty | Fresh database | `node tools/seed-demo.mjs --players 8 --matches 24` against the deployed DB, or just play a few matches. |

---

## Part 7 · If you truly want Netlify-only

You can, and it is a legitimate fallback, as long as you are honest about what it demonstrates:

* Set `window.__SY_SERVER__ = ''` and deploy just the client.
* The game plays in **offline vs Computer** mode with local practice progress — the exhibition
  project is fully playable, on your own domain, with no servers at all.
* Accounts, the GLOBAL LEADERBOARD, online matches and match history will not work: they need the
  Node server.
* For judging, a good compromise is: game on Netlify for anyone to open, **plus** the Node server
  running on your exhibition laptop with `cloudflared tunnel` for the online demos
  (see `docs/05-DEPLOYMENT.md`, Part C).

---

## Part 8 · Costs and limits (all ₹0)

| Service | Free tier | What runs out first |
|---|---|---|
| **Netlify** | 100 GB bandwidth/month, 300 build minutes | nothing you will hit — this site is ~1 MB |
| **Render** | 750 instance-hours/month, sleeps after ~15 min idle | cold-start wait, not a quota |
| **Neon** | 0.5 GB storage, generous compute | months of match history |
| **Fly.io** | small always-on machine included in the allowance | needs a card on file |
| **Hostinger domain** | — | the only real money, and you already pay it |

---

## Part 9 · Changing things after it is live

| You changed | What to do |
|---|---|
| Anything in `client/` (game, styles, `__SY_SERVER__`) | GitHub → commit → Netlify rebuilds automatically (~30 s). Hard-refresh the browser (`Ctrl+Shift+R`). |
| Anything in `server/src/` (API, XP rules, anti-cheat) | GitHub → commit → Render redeploys automatically (~1 min). |
| Environment variables (`ALLOWED_ORIGINS`, `SIGNUP_PER_HOUR`, …) | Save in Render → it redeploys itself. On Netlify, changing a variable requires **Deploys → Trigger deploy**. |
| Nothing, and you just want to reset the board before judging | `node server/tools/seed-demo.mjs --clear` (pointed at the deployed `DATABASE_URL`) → then seed again. |

That is the whole loop. Once Route A is running, the exhibition version of this project is:
**your own domain → Netlify (the game) → Render (the authority) → Neon (the record)**.
