# READ ME FIRST — how to put this on your site

One package, one upload, and **no settings to look up** — the addresses for your project are already
filled in:

| What | Where it is in this package | Already set to |
|---|---|---|
| Your server | `client/config.json` → `"server"` | `https://suryuddh.onrender.com` |
| Your Netlify site (allowed to call the server) | `server/src/config.js` → baked-in default | `https://suryuddh.netlify.app` |

Finished site: **https://suryuddh.netlify.app** · Server: **https://suryuddh.onrender.com**

---

## 1. Replace everything in your GitHub repo

1. Open your repo: `github.com/Agnivplaz/suryuddh`
2. **Delete what is there.** If everything is inside a folder called `sur-yuddh-online`, open the
   folder, select all files, and delete them. If your repo root is already flat, select all files at
   the root and delete them. (Deleting on GitHub = open the file → the **🗑 / …** menu → *Delete file*
   → *Commit changes*. Tedious but it is the last time you do it.)
   *Faster alternative:* GitHub → repo → **Settings** → scroll to the bottom → **Delete this
   repository**, then create a fresh empty repo with the same name. Either way works.
3. Unzip this package on your computer. You will see these items directly (no wrapping folder):
   `client/  server/  netlify/  netlify.toml  docs/  tools/  Dockerfile  fly.toml  render.yaml  README.md  .gitignore  README-FIRST.md`
4. On the empty repo page click **uploading an existing file**.
5. Open the unzipped folder, select **all of those items** (Ctrl+A works) and drag them onto the
   upload page. **Drag the items themselves, not the folder they live in** — that is the mistake that
   caused every "No such file or directory" error earlier.
6. Wait until every file is listed, then **Commit changes**.

Result: the repo root must contain `client/`, `server/`, `netlify/`, `docs/` — nothing else above them.

---

## 2. Render — the server

If the service already exists, you only need to check **three fields** and one button.

**Settings → Build & Deploy:**

| Field | Value |
|---|---|
| **Root Directory** | **leave EMPTY** ← you previously set this to `sur-yuddh-online`; the new repo is flat, so clear it |
| Build Command | `cd server && npm install` |
| Start Command | `cd server && npm start` |

**Environment** — these should already be there from before (add any that are missing):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DB_CLIENT` | `postgres` |
| `DB_SSL` | `true` |
| `TRUST_PROXY` | `true` |
| `JWT_SECRET` | (your existing long random string — keep it) |
| `DATABASE_URL` | (your existing Neon / Supabase URL — keep it) |
| `SIGNUP_PER_HOUR` | `60` — important: everyone on the school WiFi shares one IP |

`ALLOWED_ORIGINS` is **no longer needed** — your Netlify site is already allowed in the code.

Then **Manual Deploy → Deploy latest commit** (or just wait; pushing the repo triggers it).

---

## 3. Netlify — the game

**Site configuration → Build & deploy → Build settings → Edit settings:**

| Field | Value |
|---|---|
| **Base directory** | **leave EMPTY** ← clear the `sur-yuddh-online` value from before |
| Build command | `echo client-only` |
| Publish directory | `client` |
| Functions directory | `netlify/functions` |

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

---

## 4. Check it (2 minutes)

1. `https://suryuddh.onrender.com/healthz` → `{"ok":true,...}`
2. `https://suryuddh.onrender.com/api/leaderboard` → **JSON, not "Server error"** ← this was the bug
   fixed in this package (PostgreSQL rejects `banned = 0`; the code now uses a proper boolean).
3. Open **https://suryuddh.netlify.app** → hard refresh (**Ctrl+Shift+R**) → press F12 → Console:
   * `[Sur Yuddh] match server: https://suryuddh.onrender.com`
   * sign in, then `await SY.diagnose()` → *looks correctly configured*
4. Sign up (username + password) → **Create Profile** works → **Global Leaderboard** loads.
5. Two windows (one incognito), two accounts → **Quick Match** or **Create Room** → play a match →
   the winner's XP appears on the leaderboard and in **Profile → match history**.

### "The leaderboard is empty"

Your database is new, so it starts with zero players. That is correct behaviour, not a fault. Either
sign up a few accounts and play, or pre-fill it with demo players (needs Node.js on a computer):

```bash
cd server
set DATABASE_URL=<your Neon connection string>      # Windows cmd
# export DATABASE_URL=...                           # macOS / Linux
node tools/seed-demo.mjs --players 8 --matches 24
```

Removes them again afterwards: add `--clear`.

---

## 5. Still puzzled?

* Everything still failing? Check `/config.json` **on the Netlify site**: it must show
  `"server": "https://suryuddh.onrender.com"`. A 404 there means the new files did not deploy.
* `SY is not defined` → the page was reloaded before the scripts finished; check `typeof SY` first,
  and if it is `undefined`, open `/js/net.js` in a new tab (404/HTML there = the `js/` folder did not
  deploy, so check the Publish directory).
* The page now shows a **red banner** at the bottom if the online layer fails to load, naming the
  files — that is your signal to look at the Publish directory.
* Server logs: Render → your service → **Logs**. The real error of any 500 appears there.
* Full guides: `docs/06-NETLIFY.md` (this exact setup, click by click) and `docs/05-DEPLOYMENT.md`
  (Fly.io / laptop + tunnel alternatives, backups, monitoring).
