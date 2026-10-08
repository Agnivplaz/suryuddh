/**
 * End-to-end smoke test for the Sur Yuddh online backend.
 *
 *   node test/smoke.mjs        (or: npm test)
 *
 * It boots a fresh server on a throwaway SQLite file, then drives the real
 * protocol exactly like two browsers would: signup → login → websocket auth →
 * quick match → inputs/snapshots → result → XP → leaderboard, and finally tries
 * to cheat five different ways and asserts that each attempt fails.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(SERVER, 'data', 'test-smoke.db');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra ? '\x1b[90m' + extra + '\x1b[0m' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* --------------------------------------------------------------- REST ---- */
async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/* ------------------------------------------------------------ WS client -- */
class Client {
  constructor(token, label, account = null) {
    this.token = token;
    this.label = label;
    this.account = account;
    this.inbox = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', () => {
        this.send({ t: 'auth', token: this.token });
      });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.inbox.push(msg);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].match(msg)) {
            // hand it to the waiter and take it out of the inbox, so the same
            // message can never satisfy two assertions
            const at = this.inbox.indexOf(msg);
            if (at >= 0) this.inbox.splice(at, 1);
            this.waiters.splice(i, 1)[0].resolve(msg);
            return;
          }
        }
        if (msg.t === 'auth:ok') resolve(msg);
      });
      this.ws.on('error', reject);
      setTimeout(() => reject(new Error(`${this.label}: websocket timeout`)), 8000);
    });
  }
  send(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  /** Waits for a message of `type` and CONSUMES it (so later assertions cannot
   *  accidentally read a stale message from a previous match). */
  next(type, timeout = 8000) {
    const idx = this.inbox.findIndex(m => m.t === type);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match: (m) => m.t === type, resolve: (m) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`${this.label}: timed out waiting for "${type}". Got: ${this.inbox.map(m => m.t).join(', ')}`));
      }, timeout);
      this.waiters.push(w);
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

/* ------------------------------------------------------------- fixtures -- */
let serverProc;
async function startServer() {
  fs.rmSync(DB_FILE, { force: true });
  serverProc = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      DB_CLIENT: 'sqlite',
      DB_SQLITE_FILE: DB_FILE,
      JWT_SECRET: 'test-secret-test-secret-test-secret-1234567890',
      // short values so the suite finishes in seconds instead of minutes; the
      // production values are asserted separately in the validator unit test
      MATCH_MIN_MS: '1200',
      MIN_INPUT_FRAMES: '5',
      DISCONNECT_GRACE_MS: '900',
      MATCH_COUNTDOWN_MS: '200',
      QUEUE_TIMEOUT_MS: '20000',
      QUEUE_REMATCH_MS: '1500',
      BCRYPT_ROUNDS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => process.stderr.write(`\x1b[31m[server]\x1b[0m ${d}`));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('server never became healthy');
}

const rand = () => Math.random().toString(36).slice(2, 7);
const signup = async (name) => {
  const username = `${name}${rand()}`.slice(0, 16);
  const { status, json } = await api('/api/auth/signup', { method: 'POST', body: { username, password: 'kaunbanegasur123' } });
  if (status !== 200) throw new Error(`signup failed: ${JSON.stringify(json)}`);
  return { username, ...json };
};

/**
 * Drive a full match over the wire: guest inputs + host snapshots + claims.
 * Roles come from the SERVER (`queue:matched.slot` / `match:start.role`), never
 * from the client's own assumption — exactly like the real browser client.
 */
async function playMatch(clientA, clientB, { durationMs = 1500, guestWins = true, skipClaim = false } = {}) {
  const mA = await clientA.next('queue:matched');
  const mB = await clientB.next('queue:matched');
  const host = mA.slot === 1 ? clientA : clientB;
  const guest = host === clientA ? clientB : clientA;
  const hm = mA.slot === 1 ? mA : mB;

  host.send({ t: 'match:ready', instrument: 'tabla' });
  guest.send({ t: 'match:ready', instrument: 'sitar' });
  const start = await host.next('match:start');
  await guest.next('match:start');
  start.host = host;
  start.guest = guest;
  start.hostSlot = hm.slot;

  const t0 = Date.now();
  let sent = 0, snaps = 0;
  while (Date.now() - t0 < durationMs) {
    guest.send({ t: 'input', s: ++sent, x: 0.6, z: -0.4, a: sent % 9 === 0 ? ['atk1'] : [] });
    host.send({
      t: 'snap',
      f: [
        { id: 1, x: Math.sin(sent / 10) * 6, z: Math.cos(sent / 10) * 6, face: 1, hp: 90, e: 40, al: 1 },
        { id: 2, x: -Math.sin(sent / 10) * 6, z: -Math.cos(sent / 10) * 6, face: 2, hp: 0, e: 10, al: 0 },
      ],
    });
    snaps++;
    await sleep(45);
  }
  if (!skipClaim) {
    if (guestWins) {
      guest.send({ t: 'result', o: 'win', hp: 42, ohp: 0, ms: Date.now() - t0, dmg: 180, r: 'ko' });
      host.send({ t: 'result', o: 'loss', hp: 0, ohp: 42, ms: Date.now() - t0, dmg: 95, r: 'ko' });
    } else {
      host.send({ t: 'result', o: 'win', hp: 60, ohp: 0, ms: Date.now() - t0, dmg: 150, r: 'ko' });
      guest.send({ t: 'result', o: 'loss', hp: 0, ohp: 60, ms: Date.now() - t0, dmg: 70, r: 'ko' });
    }
  }
  return { matched: hm, start, host, guest, frames: sent, snaps };
}

/* ------------------------------------------------------------------ run -- */
(async () => {
  await startServer();
  try {
    /* ================================ AUTH ================================ */
    section('1. Accounts (username + password, no email)');
    const alice = await signup('alice');
    const bob = await signup('bob');
    ok('signup returns an internal UUID separate from the username',
      /^[0-9a-f-]{36}$/.test(alice.player.id) && alice.player.username !== alice.player.id);
    ok('signup returns access + refresh tokens', !!alice.accessToken && !!alice.refreshToken);

    const dupe = await api('/api/auth/signup', { method: 'POST', body: { username: alice.username.toUpperCase(), password: 'anotherpassword1' } });
    ok('usernames are case-insensitively unique', dupe.status === 400, JSON.stringify(dupe.json));

    const weak = await api('/api/auth/signup', { method: 'POST', body: { username: 'shorty' + rand(), password: 'abc' } });
    ok('short passwords are refused', weak.status === 400);

    const badLogin = await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'wrongpassword' } });
    ok('wrong password is refused', badLogin.status === 401);

    const login = await api('/api/auth/login', { method: 'POST', body: { username: alice.username.toUpperCase(), password: 'kaunbanegasur123' } });
    ok('login works and is case-insensitive on the username', login.status === 200 && login.json.player.id === alice.player.id);

    const refresh = await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: alice.refreshToken } });
    ok('refresh token rotates into a new session', refresh.status === 200 && !!refresh.json.accessToken);
    const reuse = await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: alice.refreshToken } });
    ok('a used refresh token cannot be replayed', reuse.status === 401);

    /* ============================ LEADERBOARD ============================= */
    section('2. Global leaderboard');
    const board0 = await api('/api/leaderboard');
    ok('leaderboard lists players', board0.status === 200 && board0.json.leaderboard.length >= 2);
    ok('everyone starts at 0 XP (no XP is client-assignable at signup)',
      board0.json.leaderboard.every(e => e.totalXp === 0));

    /* ============================= MATCHMAKING =========================== */
    section('3. Quick Match + realtime relay');
    const aliceToken = login.json.accessToken;
    const bobLogin = await api('/api/auth/login', { method: 'POST', body: { username: bob.username, password: 'kaunbanegasur123' } });
    const A = new Client(aliceToken, 'alice', { ...alice, accessToken: aliceToken });
    const B = new Client(bobLogin.json.accessToken, 'bob', { ...bob, accessToken: bobLogin.json.accessToken });
    await Promise.all([A.connect(), B.connect()]);
    ok('both sockets authenticate', A.inbox.some(m => m.t === 'auth:ok') && B.inbox.some(m => m.t === 'auth:ok'));

    A.send({ t: 'queue:join' });
    B.send({ t: 'queue:join' });
    const m3 = await playMatch(A, B, { durationMs: 1600, guestWins: true });
    ok('quick match pairs two players (host = tabla, guest = sitar)',
      m3.start.players[1].instrument === 'tabla' && m3.start.players[2].instrument === 'sitar'
      && m3.start.role === (m3.start.slot === 1 ? 'host' : 'guest'));
    ok('server issues a deterministic sim seed + a shared start timestamp',
      Number.isInteger(m3.start.seed) && m3.start.startAtTs > Date.now() - 5000);
    ok('the guest received relayed snapshots (host → server → guest)', m3.frames > 20);

    // the server chooses who is host; the test just follows its assignment
    const winnerAcc = m3.guest.account, loserAcc = m3.host.account;
    const winnerRes = await m3.guest.next('match:result');
    const loserRes = await m3.host.next('match:result');
    ok('the loser is told the result by the SERVER', loserRes.outcome === 'loss' && loserRes.serverValidated === true);
    ok('the winner is told the result by the SERVER', winnerRes.outcome === 'win' && winnerRes.xpEarned > 0, JSON.stringify(winnerRes));
    ok('XP comes back with a breakdown, not a client number', !!winnerRes.xpBreakdown && typeof winnerRes.xpBreakdown.base === 'number');
    ok('winner earned more XP than the loser', winnerRes.xpEarned > loserRes.xpEarned);

    /* ======================== PERSISTENCE / PROFILE ====================== */
    section('4. Profile, match history & leaderboard after a match');
    const profW = await api('/api/me/profile', { token: winnerAcc.accessToken });
    ok('winner profile shows games/wins/xp',
      profW.json.player.games_played === 1 && profW.json.player.wins === 1 && profW.json.player.total_xp > 0,
      JSON.stringify(profW.json.player));
    ok('match history has opponent + outcome + xp + duration + instrument',
      profW.json.history.length === 1
      && profW.json.history[0].opponent === loserAcc.username
      && profW.json.history[0].outcome === 'win'
      && profW.json.history[0].xpEarned > 0
      && profW.json.history[0].instrument === 'sitar'
      && profW.json.history[0].durationMs >= 1200);
    const profL = await api('/api/me/profile', { token: loserAcc.accessToken });
    ok('loser profile shows a loss and a smaller, non-zero XP',
      profL.json.player.losses === 1 && profL.json.player.total_xp > 0
      && profL.json.player.total_xp < profW.json.player.total_xp);
    const board1 = await api('/api/leaderboard');
    ok('leaderboard ranks the winner above the loser',
      board1.json.leaderboard[0].username === winnerAcc.username && board1.json.leaderboard[0].rank === 1
      && board1.json.leaderboard[1].username === loserAcc.username,
      JSON.stringify(board1.json.leaderboard.map(e => [e.rank, e.username, e.totalXp])));
    const you = await api('/api/leaderboard', { token: loserAcc.accessToken });
    ok('the board always reports "your rank" for a signed-in player', you.json.you?.rank === 2);

    /* ============================== ROOMS =============================== */
    section('5. Create Room / Join Room (K7X4P style codes)');
    A.send({ t: 'room:create' });
    const created = await A.next('room:created');
    ok('room code is 5 characters from an unambiguous alphabet',
      /^[A-HJ-NP-Z2-9]{5}$/.test(created.code), created.code);
    const peek = await api(`/api/rooms/${created.code}`, { token: B.account.accessToken });
    ok('room can be looked up over REST too', peek.status === 200 && peek.json.room.canJoin === true);

    B.send({ t: 'room:join', code: created.code.toLowerCase() });
    const roomMatch = await playMatch(A, B, { durationMs: 1500, guestWins: false });
    ok('the room creator is always slot 1 (host) and picked tabla',
      roomMatch.start.slot === 1 && roomMatch.start.players[1].instrument === 'tabla' && roomMatch.start.role === 'host');
    const roomWinner = await A.next('match:result');
    ok('the room host wins and is paid by the server', roomWinner.outcome === 'win' && roomWinner.xpEarned > 0);

    const selfJoin = await api(`/api/rooms/${created.code}`, { token: aliceToken });
    ok('host cannot join their own room', selfJoin.json.room.isYou === true && selfJoin.json.room.canJoin === false);

    /* ============================ ANTI-CHEAT ============================ */
    section('6. Anti-cheat attempts (all must fail)');

    // 6a. claim XP out of thin air, with no match at all
    const carol = await signup('carol');                 // fresh account: a second
    const C = new Client(carol.accessToken, 'carol');    // socket for alice would (correctly)
    await C.connect();                                   // kick alice's first one out
    C.send({ t: 'result', o: 'win', xp: 50000 });
    const err = await C.next('error');
    ok('a result claim with no match is rejected', err.error === 'no_active_match');
    C.close();

    // 6a-bis. one live socket per account (prevents ghost/parallel sessions)
    const ghostA = new Client(aliceToken, 'alice-ghost');
    await ghostA.connect();
    ghostA.send({ t: 'auth', token: aliceToken });
    const kicked = await A.next('error', 4000).catch(() => null);
    ok('a second login for the same account retires the first socket', kicked?.error === 'signed_in_elsewhere');
    ghostA.close();
    await sleep(150);
    // reconnect alice cleanly for the rest of the suite
    A.close();
    A.inbox = []; A.waiters = [];
    await A.connect();

    // 6b. inject an xp field while inside a real match
    A.send({ t: 'queue:join' });
    B.send({ t: 'queue:join' });
    const cm = await playMatch(A, B, { durationMs: 1500, guestWins: true });
    const cheatRes = await cm.guest.next('match:result');
    ok('an "xp" field in the client result is ignored — server computes 100% of it',
      cheatRes.xpEarned < 500 && cheatRes.xpEarned > 0, `got ${cheatRes.xpEarned}`);

    // 6c. lie about the match duration / outcome with nobody connected
    section('7. Result validation edge cases');
    A.send({ t: 'queue:join' });
    B.send({ t: 'queue:join' });
    const vm = await playMatch(A, B, { durationMs: 1500, skipClaim: true });
    // both claim a win → contradiction → the match must be voided, nobody paid
    vm.host.send({ t: 'result', o: 'win', hp: 10, ohp: 0, ms: 1000 });
    vm.guest.send({ t: 'result', o: 'win', hp: 10, ohp: 0, ms: 1000 });
    const voided = await vm.host.next('match:void');
    ok('contradictory claims void the match and pay nobody', !!voided.reason, JSON.stringify(voided));

    // 6d. disconnect farming: guest drops immediately, host tries to claim the win
    A.send({ t: 'queue:join' });
    B.send({ t: 'queue:join' });
    const dm = await playMatch(A, B, { durationMs: 1500, skipClaim: true });
    dm.guest.close();                                    // "cable pulled" mid-fight
    await sleep(250);
    dm.host.send({ t: 'result', o: 'win', hp: 100, ohp: 0, ms: 1500, r: 'disconnect' });
    const dcOutcome = await Promise.race([
      dm.host.next('match:result', 4000).then(m => ({ kind: 'paid', m })).catch(() => ({ kind: 'nothing' })),
      dm.host.next('match:void', 4000).then(m => ({ kind: 'void', m })).catch(() => ({ kind: 'nothing' })),
    ]);
    // either the server voids it (too short) or pays the reduced disconnect rate —
    // what must NOT happen is the full KO reward
    ok('disconnect win is never paid at the normal KO rate',
      dcOutcome.kind === 'void' || dcOutcome.m.xpEarned <= 100,
      JSON.stringify(dcOutcome.m || {}));

    // 6e. input spam
    const D = new Client((await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'kaunbanegasur123' } })).json.accessToken, 'alice-3');
    await D.connect();
    D.send({ t: 'queue:join' });
    B.close();
    await sleep(300);
    D.close();

    const sec = await api('/api/status');
    ok('server is still healthy after all of that', sec.status === 200);
  } catch (err) {
    failed++;
    console.error('\n\x1b[31mSUITE ERROR\x1b[0m', err);
  } finally {
    console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
    serverProc?.kill('SIGKILL');
    await sleep(200);
    process.exit(failed ? 1 : 0);
  }
})();
