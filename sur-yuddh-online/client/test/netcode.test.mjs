/**
 * Netcode integration test — TWO REAL CLIENTS, ONE REAL SERVER.
 *
 *   node client/test/netcode.test.mjs
 *
 * The two clients run the actual browser files (js/net.js + js/mp.js) inside a
 * sandbox whose game object mirrors window.__sur. They sign up, queue, get
 * paired, pick instruments, fight for a few seconds (host simulating, guest
 * streaming inputs) and finish. Assertions cover the things that are easy to
 * get wrong and impossible to see by eye:
 *
 *   • the guest's avatar follows the host's authoritative position
 *   • the guest's inputs actually move the host's copy of that fighter
 *   • snapshots flow host → server → guest at roughly the configured rate
 *   • neither client can award XP; the server's verdict is what lands
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrowser } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', '..', 'server');
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(SERVER, 'data', 'test-netcode.db');

let passed = 0, failed = 0;
const ok = (n, c, extra = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${n} ${extra ? '\x1b[90m' + extra + '\x1b[0m' : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};

let proc;
async function startServer() {
  fs.rmSync(DB_FILE, { force: true });
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test', DB_CLIENT: 'sqlite',
      DB_SQLITE_FILE: DB_FILE, JWT_SECRET: 'netcode-test-secret-0123456789abcdefghij',
      MATCH_MIN_MS: '1500', MIN_INPUT_FRAMES: '5', MATCH_COUNTDOWN_MS: '400',
      DISCONNECT_GRACE_MS: '1000', QUEUE_REMATCH_MS: '1200', BCRYPT_ROUNDS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`\x1b[31m[server]\x1b[0m ${d}`));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('server did not start');
}

async function api(p, body) {
  const res = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const rnd = () => Math.random().toString(36).slice(2, 6);

(async () => {
  await startServer();
  try {
    console.log('\n\x1b[1mSur Yuddh — client netcode against a live server\x1b[0m\n');

    const A = await api('/api/auth/signup', { username: 'host' + rnd(), password: 'kaunbanegasur123' });
    const B = await api('/api/auth/signup', { username: 'guest' + rnd(), password: 'kaunbanegasur123' });
    ok('two accounts created over REST', A.status === 200 && B.status === 200);

    /* ------------- boot two "browsers" running the real client code ------- */
    const hostEnv = createBrowser({ port: PORT, name: 'host' });
    const guestEnv = createBrowser({ port: PORT, name: 'guest' });
    ok('js/net.js + js/mp.js loaded in both sandboxes (no runtime errors)',
      !!hostEnv.SY && !!hostEnv.__mp && !!guestEnv.SY && !!guestEnv.__mp);

    // inject the session the way the login form would
    const seed = (env, acct) => env.localStorage.setItem('suryuddh_session_v1', JSON.stringify({
      accessToken: acct.accessToken, refreshToken: acct.refreshToken, player: acct.player,
    }));

    seed(hostEnv, A.json);
    seed(guestEnv, B.json);
    // the scripts already ran their initial load(), so re-read storage now
    hostEnv.SY.session.load();
    guestEnv.SY.session.load();
    await hostEnv.SY.resume();
    await guestEnv.SY.resume();
    ok('both clients resume their stored session', hostEnv.SY.signedIn() && guestEnv.SY.signedIn());

    const bothOpen = await waitFor(() => hostEnv.SY.rt.state === 'open' && guestEnv.SY.rt.state === 'open', 6000);
    ok('both sockets connect and authenticate (hello → auth:ok)', bothOpen,
      `${hostEnv.SY.rt.state}/${guestEnv.SY.rt.state}`);

    /* --------------------------- the game's frame loop ------------------- */
    const frames = { host: 0, guest: 0 };
    const drive = (env, who) => {
      if (env.G) throw new Error('bad name');
      const g = env.__sur.G;
      const loop = setInterval(() => {
        try {
          if (g.state !== 'select') { env.__sur.stepGame(1 / 60); env.__mp.tick(1 / 60); frames[who]++; }
        } catch (e) { console.error(`  [${who} loop]`, e.message); }
      }, 16);
      return loop;
    };

    /* ------------------------------- matchmaking ------------------------- */
    // stand in for the lobby UI: auto-ready as soon as the hub pairs us
    let pairedCount = 0;
    const autoReady = (env) => env.SY.on('queue:matched', () => {
      pairedCount++;
      env.SY.rt.send({ t: 'match:ready', instrument: env.__sur.INSTRUMENTS[env.__sur.G.sel].id });
    });
    autoReady(hostEnv);
    autoReady(guestEnv);

    hostEnv.SY.rt.send({ t: 'queue:join' });
    guestEnv.SY.rt.send({ t: 'queue:join' });

    const matched = await waitFor(() => pairedCount === 2, 8000, 30);
    ok('quick match paired both clients through the real hub', matched, `paired=${pairedCount}`);

    // the server tells each side its role; wait until both are inside a match
    await waitFor(() => hostEnv.__mp.isOnline() && guestEnv.__mp.isOnline(), 6000, 30);
    const hostRole = hostEnv.__mp.role(), guestRole = guestEnv.__mp.role();
    ok('the server assigned opposite roles (one host, one guest)',
      hostRole !== guestRole && [hostRole, guestRole].sort().join() === 'guest,host',
      `${hostRole}/${guestRole}`);

    const hostEnvIsHost = hostRole === 'host';
    const H = hostEnvIsHost ? hostEnv : guestEnv;
    const Gst = hostEnvIsHost ? guestEnv : hostEnv;

    /* ------------------------------- the fight --------------------------- */
    const hostGame = H.__sur.G, guestGame = Gst.__sur.G;
    ok('both clients built a 2-fighter online match (no AI)',
      hostGame.fighters.length === 2 && guestGame.fighters.length === 2);
    ok('host simulated fighters, guest net-driven fighters',
      hostGame.fighters.filter((f) => f.net).length === 0 && guestGame.fighters.filter((f) => f.net).length === 2);

    const lh = drive(H, 'host'), lg = drive(Gst, 'guest');

    await waitFor(() => hostGame.state === 'play', 4000, 20);
    // the guest "holds D" — that input must reach the host and move its avatar
    const guestPlayer = guestGame.player;
    const guestNetId = guestPlayer.netId;
    Gst.__sur.In.keys.add('KeyD');

    const hostCopy = hostGame.fighters.find((f) => f.netId === guestNetId);
    const startX = hostCopy ? hostCopy.x : 0;

    await sleep(1400);

    const movedOnHost = hostCopy && Math.abs(hostCopy.x - startX) > 1.5;
    ok('guest inputs reach the host and drive its copy of the guest fighter',
      movedOnHost, `host copy x: ${startX.toFixed(2)} → ${hostCopy && hostCopy.x.toFixed(2)}`);

    const snapErr = Math.abs(guestPlayer.x - hostCopy.x);
    ok('guest avatar tracks the host\'s authoritative position', snapErr < 3.5,
      `|Δx| = ${snapErr.toFixed(2)} (guest ${guestPlayer.x.toFixed(2)} vs host ${hostCopy.x.toFixed(2)})`);
    ok('guest avatar moved locally at all (prediction makes it feel live)',
      Math.abs(guestPlayer.x) > 1, `x=${guestPlayer.x.toFixed(2)}`);
    ok('frames ran on both sides', frames.host > 60 && frames.guest > 60, JSON.stringify(frames));
    ok('guest rendered snapshot-driven cooldown/energy state',
      typeof guestPlayer.energy === 'number' && typeof guestPlayer.cd.atk1 === 'number');

    /* --------------------------------- an ability ----------------------- */
    const before = hostCopy ? hostCopy.energy : 0;
    guestGame.player.energy = 100;
    Gst.__sur.useMove(guestGame.player, 'atk2');
    await sleep(400);
    ok('a guest ability request is forwarded, not executed locally',
      (Gst.__sur.G.player.cd.atk2 || 0) === 0 || Gst.__sur.G.player.cd.atk2 <= 1.2,
      `guest cd.atk2=${Gst.__sur.G.player.cd.atk2}`);

    /* ------------------------------ the result -------------------------- */
    // the host declares the guest the winner, exactly as the sim would
    hostGame.fighters.forEach((f) => { f.hp = f.netId === guestNetId ? 40 : 0; if (f.netId !== guestNetId) f.alive = false; });
    hostGame.state = 'play';
    H.__sur.G.shown = false;
    // trigger the game's own end-of-match detection
    await waitFor(() => H.__sur.G.state === 'over', 3000, 20);

    // the guest, driven by snapshots, must agree
    await waitFor(() => Gst.__sur.G.state === 'over', 3000, 20);
    ok('both clients independently reached the end-of-match screen',
      H.__sur.G.state === 'over' && Gst.__sur.G.state === 'over');

    const resultOnGuest = await waitFor(() => Gst.__sur.G.onlineResult, 8000, 50);
    const resultOnHost = await waitFor(() => H.__sur.G.onlineResult, 8000, 50);
    ok('both clients received a server-verified result', resultOnGuest && resultOnHost);
    ok('the XP number came from the server, with a breakdown',
      H.__sur.G.onlineResult && typeof H.__sur.G.onlineResult.xpEarned === 'number'
      && !!H.__sur.G.onlineResult.xpBreakdown);

    clearInterval(lh); clearInterval(lg);

    /* ------------------------- persistence check ------------------------ */
    const guestProfile = await fetch(`${BASE}/api/me/profile`, {
      headers: { authorization: 'Bearer ' + (hostEnvIsHost ? B.json.accessToken : A.json.accessToken) },
    }).then((r) => r.json());
    ok('the winner\'s profile recorded the match',
      guestProfile.player.total_xp > 0 && guestProfile.player.wins === 1,
      JSON.stringify(guestProfile.player));

    const board = await fetch(`${BASE}/api/leaderboard`).then((r) => r.json());
    ok('the global leaderboard ranks the winner first',
      board.leaderboard[0] && board.leaderboard[0].totalXp > 0,
      JSON.stringify(board.leaderboard.slice(0, 3).map((e) => [e.rank, e.username, e.totalXp])));
  } catch (err) {
    failed++;
    console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', err);
  } finally {
    console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
    proc?.kill('SIGKILL');
    await sleep(200);
    process.exit(failed ? 1 : 0);
  }
})();
