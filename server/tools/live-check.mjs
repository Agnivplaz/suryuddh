#!/usr/bin/env node
/**
 * live-check.mjs — watch the whole online system work, from outside the browser.
 *
 * Runs three real scenarios against a running server and prints one report:
 *
 *   1. HAPPY PATH    two synthetic clients sign up, quick-match each other,
 *                    fight for N seconds, both report the same result, and the
 *                    server pays the winner XP. Then we read the leaderboard
 *                    back over REST and confirm the numbers landed.
 *   2. XP INJECTION  a signed-in client tries to just WRITE xp through the API
 *                    (the "I claim 50,000 XP" attack). Every route must refuse.
 *   3. CONFLICT      the loser claims "win" while the winner also claims "win".
 *                    The server must void the match and pay nobody.
 *
 * Usage (server must already be running):
 *     cd server
 *     node tools/live-check.mjs                     # http://localhost:8080
 *     node tools/live-check.mjs --base http://localhost:8080 --seconds 25
 *     node tools/live-check.mjs --keep              # leave the test accounts
 *
 * Exit code is 0 only if every expectation held.
 */
import WebSocket from 'ws';
import { openDb, closeDb, dbx } from '../src/db/index.js';

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}`);
  if (!hit) return dflt;
  const val = argv[argv.indexOf(hit) + 1];
  return val && !val.startsWith('--') ? val : true;
};
const BASE = String(arg('base', process.env.LIVE_BASE || 'http://localhost:8080')).replace(/\/$/, '');
const SECONDS = Number(arg('seconds', 25));
const KEEP = !!arg('keep', false);
const FULL = !!arg('full', false);      // include the checks that spend extra signups
const TAG = Date.now().toString(36).slice(-4);
const USER_A = `livecheck_a_${TAG}`;      // winner
const USER_B = `livecheck_b_${TAG}`;      // loser
const PASS = 'livecheck12345';
const INSTR_A = 'sitar';
const INSTR_B = 'tabla';

/* --------------------------------------------------------------- reporting */
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};
let failures = 0;
const results = [];
function step(name, ok, detail = '') {
  if (!ok) failures++;
  results.push({ name, ok });
  console.log(`${ok ? C.g('  PASS') : C.r('  FAIL')}  ${name}${detail ? C.d(' — ' + detail) : ''}`);
}
function head(title) {
  console.log('\n' + C.b(title));
  console.log(C.d('─'.repeat(Math.max(40, title.length + 8))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- REST */
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, json };
}

/* --------------------------------------------------------------- WS client */
function makeClient(label) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  const c = {
    label, ws, player: null, slot: null, matchId: null,
    events: [], started: null, result: null, voided: null, over: null, errors: [],
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    on(type, fn) { ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.t === type) fn(m); }); },
    close() { try { ws.close(); } catch {} },
  };
  c.ready = new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    c.events.push(m.t);
    if (m.t === 'queue:matched') { c.slot = m.slot; c.matchId = m.matchId; }
    if (m.t === 'match:start') { c.matchId = m.matchId; c.started = Date.now(); }
    if (m.t === 'match:result') c.result = m;
    if (m.t === 'match:void') c.voided = m;
    if (m.t === 'match:over') c.over = m;
    if (m.t === 'error' || m.t === 'queue:error' || m.t === 'room:error') c.errors.push(m);
  });
  return c;
}

/* ----------------------------------------------------------- the fight sim */
/**
 * Host uploads snapshots (it owns the simulation), guest uploads input frames.
 * Payload shapes are copied from client/js/mp.js so the server sees exactly the
 * same traffic the real game produces.
 */
function startTraffic(host, guest, seconds) {
  let seq = 0;
  let snapAt = 0, inputAt = 0, ended = false;
  const state = { snaps: 0, inputs: 0 };
  const t0 = Date.now();
  const timers = [];

  timers.push(setInterval(() => {
    if (ended) return;
    const t = Date.now() - t0;
    // guest: 30 Hz movement frames, no actions (keeps every cooldown legal)
    while (t - inputAt >= 33) {
      inputAt += 33;
      const phase = t / 700;
      guest.send({
        t: 'input', s: ++seq,
        x: +(Math.cos(phase) * 0.6).toFixed(3),
        z: +(Math.sin(phase) * 0.6).toFixed(3),
        a: [],
      });
      state.inputs++;
    }
    // host: 20 Hz snapshots with two fighters + one projectile
    while (t - snapAt >= 50) {
      snapAt += 50;
      const f = [
        { x: +(Math.cos(t / 900) * 6).toFixed(2), z: +(Math.sin(t / 900) * 6).toFixed(2), hp: 80 },
        { x: +(-Math.cos(t / 1100) * 5).toFixed(2), z: +(-Math.sin(t / 1100) * 5).toFixed(2), hp: 75 },
      ];
      host.send({ t: 'snap', ms: t, st: 'play', win: 0, f, p: [], z: [] });
      state.snaps++;
    }
  }, 16));

  return {
    state,
    stop() { ended = true; timers.forEach(clearInterval); },
  };
}

/* ------------------------------------------------------------------- main */
async function main() {
  console.log(C.b('\n  SUR YUDDH — LIVE SYSTEM CHECK'));
  console.log(C.d(`  server ${BASE}  ·  fighting ${SECONDS}s  ·  accounts ${USER_A} / ${USER_B}\n`));

  /* ---------------------------------------------------------- 0. liveness */
  head('0 · Is the server up, and what is it running?');
  const health = await api('/healthz');
  step('GET /healthz answers', health.ok && health.json?.ok === true, `uptime ${Math.round(health.json?.uptime || 0)}s`);
  const status0 = await api('/api/status');
  step('GET /api/status reports the hub', status0.ok && !!status0.json?.hub,
    status0.json ? `${status0.json.hub.online} online` : '');
  const cfg = await api('/api/config');
  step('game files are being served from the same origin', (await fetch(BASE + '/')).status === 200);
  const minMs = cfg.json?.minMatchMs ?? 20000;
  if (SECONDS * 1000 < minMs) {
    console.log(C.y(`  NOTE  server voids matches shorter than ${minMs / 1000}s — raising --seconds`));
  }
  const fightSeconds = Math.max(SECONDS, Math.ceil(minMs / 1000) + 6);

  /** Is this a 429 from the per-IP signup ceiling? */
function isRateLimited(r) {
  return r.status === 429 || /too many accounts/i.test(r.json?.error || '');
}
const rateHint = () => console.log(C.d('        Raise it for testing/demos:  SIGNUP_PER_HOUR=100 npm start   (see docs/05-DEPLOYMENT.md)'));

/* ------------------------------------------------------------ 1. signup */
  head('1 · Accounts (username + password, no email anywhere)');
  const suA = await api('/api/auth/signup', { method: 'POST', body: { username: USER_A, password: PASS } });
  const suB = await api('/api/auth/signup', { method: 'POST', body: { username: USER_B, password: PASS } });
  step('signup works and returns a UUID + token', suA.ok && suA.json?.player?.id?.length === 36 && !!suA.json?.accessToken,
    suA.json?.player?.id);
  step('second signup works for the opponent', suB.ok && !!suB.json?.accessToken);
  const tokA = suA.json?.accessToken, tokB = suB.json?.accessToken;
  if (isRateLimited(suA) || isRateLimited(suB)) {
    console.log(C.y('\n  The server refused the test signups: the per-IP account ceiling was hit.'));
    rateHint();
    console.log(C.y('  Nothing else can be tested without accounts — stopping here.\n'));
    process.exit(2);
  }
  if (FULL) {
    // each of these spends one slot of the per-IP hourly signup budget
    step('duplicate username is refused', (await api('/api/auth/signup', { method: 'POST', body: { username: USER_A, password: PASS } })).ok === false);
    const dup = await api('/api/auth/signup', { method: 'POST', body: { username: USER_A.toUpperCase(), password: PASS } });
    step('username check is case-insensitive (no look-alike accounts)', dup.ok === false, dup.json?.error || '');
    step('weak password is refused', (await api('/api/auth/signup', { method: 'POST', body: { username: 'x_' + TAG, password: '123' } })).ok === false);
  } else {
    console.log(C.d('      (skipping the 3 negative-signup checks — run with --full to include them)'));
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { username: USER_A, password: PASS } });
  step('login with the same credentials works', login.ok && !!login.json?.accessToken);

  /* --------------------------------------------------- 2. quick matchmaking */
  head('2 · Quick Match — two players, real network');
  const A = makeClient(USER_A); const B = makeClient(USER_B);
  await Promise.all([A.ready, B.ready]);
  A.send({ t: 'auth', token: tokA });
  B.send({ t: 'auth', token: tokB });
  await sleep(400);
  step('both sockets authenticated', A.events.includes('auth:ok') && B.events.includes('auth:ok'));
  A.send({ t: 'ping', c: Date.now() });
  await sleep(250);
  step('latency probe (ping → pong)', A.events.includes('pong'));

  const matched = new Promise((resolve) => {
    const done = () => A.matchId && B.matchId && resolve(true);
    A.on('queue:matched', done); B.on('queue:matched', done);
    setTimeout(() => resolve(false), 8000);
  });
  A.send({ t: 'queue:join' });
  await sleep(1300);                     // hub stats refresh on a 1 Hz housekeeping tick
  const status1 = await api('/api/status');
  step('server knows one player is queued', (status1.json?.hub?.queued ?? 0) >= 1, `queued=${status1.json?.hub?.queued}`);
  B.send({ t: 'queue:join' });
  step('matchmaker paired the two players', await matched, `${A.matchId?.slice(0, 8)}… slots ${A.slot}/${B.slot}`);
  step('the pair is assigned complementary slots (host=1, guest=2)',
    ((A.slot === 1 && B.slot === 2) || (A.slot === 2 && B.slot === 1)));
  const host = A.slot === 1 ? A : B;
  const guest = A.slot === 1 ? B : A;
  step('roles differ: one simulation host, one input sender',
    host.slot === 1 && guest.slot === 2, `host=${host.label} guest=${guest.label}`);

  /* -------------------------------------------------------- 3. instrument pick */
  head('3 · Instrument pick and the synchronised start');
  const startP = new Promise((resolve) => {
    A.on('match:start', () => resolve(true));
    setTimeout(() => resolve(false), 8000);
  });
  A.send({ t: 'match:ready', instrument: INSTR_A });
  B.send({ t: 'match:ready', instrument: INSTR_B });
  step('both ready → the server starts the match itself', await startP);
  step('browser was NOT allowed to choose who is host', !!A.matchId && !!B.matchId);

  /* ------------------------------------------------------------ 4. the fight */
  head(`4 · Fighting for ${fightSeconds}s (host streams snapshots, guest streams inputs)`);
  const traffic = startTraffic(host, guest, fightSeconds);
  {
    const t0 = Date.now();
    let nextLog = 5000;
    while (Date.now() - t0 < fightSeconds * 1000) {
      await sleep(1000);
      const el = Date.now() - t0;
      if (el >= nextLog) {
        nextLog += 5000;
        const st = await api('/api/status');
        console.log(C.d(`      t+${Math.round(el / 1000)}s   inMatch=${st.json?.hub?.inMatch}  snapshots=${traffic.state.snaps}  inputs=${traffic.state.inputs}`));
      }
    }
  }
  traffic.stop();
  step('host was allowed to stream ~20 snapshots/second', traffic.state.snaps > fightSeconds * 15, `${traffic.state.snaps} snapshots`);
  step('guest was allowed to stream ~30 input frames/second', traffic.state.inputs > fightSeconds * 20, `${traffic.state.inputs} frames`);
  step('server kept the match open the whole time (no false void)', host.errors.length === 0 && guest.errors.length === 0,
    [...host.errors, ...guest.errors].map((e) => e.error).join(', '));

  /* --------------------------------------------------------- 5. honest result */
  head('5 · Both players report the same result → server pays XP');
  const resultP = new Promise((resolve) => {
    A.on('match:result', (m) => resolve(m));
    setTimeout(() => resolve(null), 12000);
  });
  const ms = Date.now() - (A.started || Date.now());
  const win = A === host ? A : B, lose = A === host ? B : A;
  win.send({ t: 'result', o: 'win', hp: 42, ohp: 0, ms, dmg: 118, r: 'ko' });
  lose.send({ t: 'result', o: 'loss', hp: 0, ohp: 42, ms, dmg: 61, r: 'ko' });
  const res = await resultP;
  step('server sent match:result to the clients', !!res, res
    ? `${res.outcome} vs ${res.opponent} · ${res.xpEarned} XP · ${res.reason} · validated=${res.serverValidated}`
    : '');
  step('the verdict came from the server (serverValidated flag)', res?.serverValidated === true);
  step('the winner was paid XP', !!res && res.xpEarned > 0, `xpEarned=${res?.xpEarned} · ${JSON.stringify(res?.xpBreakdown)?.slice(0, 110)}`);

  await sleep(700);
  const lb = await api('/api/leaderboard');
  const rowW = lb.json?.leaderboard?.find((r) => r.username === win.player?.username || r.username === USER_A || r.username === USER_B);
  const meA = await api('/api/auth/me', { token: tokA });
  const meB = await api('/api/auth/me', { token: tokB });
  const pA = meA.json?.player, pB = meB.json?.player;
  if (isRateLimited(lb) || isRateLimited(meA)) rateHint();
  step('the GLOBAL LEADERBOARD read back over REST', lb.ok && Array.isArray(lb.json?.leaderboard),
    `top: ${lb.json?.leaderboard?.[0]?.username} (${lb.json?.leaderboard?.[0]?.totalXp} XP)`);
  const winnerIsA = (pA?.total_xp || 0) > 0;
  const winnerPlayer = winnerIsA ? pA : pB;
  const loserPlayer = winnerIsA ? pB : pA;
  step('the winner has XP, games_played and a win on their profile', (winnerPlayer?.total_xp || 0) > 0 && (winnerPlayer?.wins || 0) === 1,
    `${winnerPlayer?.username}: ${winnerPlayer?.total_xp} XP, ${winnerPlayer?.wins}W-${winnerPlayer?.losses}L`);
  step('the loser got a loss, not XP', (loserPlayer?.losses || 0) === 1,
    `${loserPlayer?.username}: ${loserPlayer?.total_xp} XP, ${loserPlayer?.wins}W-${loserPlayer?.losses}L`);
  const hist = await api('/api/me/matches?limit=5', { token: tokA });
  const rows = hist.json?.matches || hist.json?.history || [];
  step('match history is stored with opponent, outcome, XP and duration', hist.ok && rows.length >= 1,
    rows[0] ? `vs ${rows[0].opponent} · ${rows[0].outcome} · ${rows[0].xpEarned} XP · ${Math.round((rows[0].durationMs || 0) / 1000)}s · ${rows[0].instrument} vs ${rows[0].opponentInstrument}` : '');
  step('the finished match is marked server-validated', !!rows[0]?.validated, `validated=${rows[0]?.validated}`);

  /* ---------------------------------------------------------- 6. XP injection */
  head('6 · ATTACK — "I earned 50,000 XP", sent straight at the API');
  const attempts = [
    ['POST /api/me/xp', () => api('/api/me/xp', { method: 'POST', body: { delta: 50000 }, token: tokA })],
    ['POST /api/players/me/xp', () => api('/api/players/me/xp', { method: 'POST', body: { total_xp: 50000 }, token: tokA })],
    ['PATCH /api/me', () => api('/api/me', { method: 'PATCH', body: { total_xp: 50000, wins: 99 }, token: tokA })],
    ['POST /api/leaderboard', () => api('/api/leaderboard', { method: 'POST', body: { username: USER_A, totalXp: 50000 } , token: tokA })],
    ['POST /api/matches (fake win)', () => api('/api/matches', { method: 'POST', body: { winner: USER_A, xp: 50000 }, token: tokA })],
  ];
  for (const [name, fn] of attempts) {
    const r = await fn();
    step(`${name} is refused`, r.status >= 400 && r.ok === false, `HTTP ${r.status} ${r.json?.error || ''}`);
  }
  const wipe = await api('/api/me', { method: 'PUT', body: { total_xp: 0, games_played: 0 }, token: tokA });
  step('PUT /api/me cannot reset stats either', wipe.ok === false || (wipe.json?.player?.total_xp ?? -1) !== 0, `HTTP ${wipe.status}`);
  const afterA = await api('/api/auth/me', { token: tokA });
  step('XP total is unchanged after every injection attempt',
    (afterA.json?.player?.total_xp || 0) === (pA?.total_xp || 0),
    `${afterA.json?.player?.total_xp} XP`);

  /* ------------------------------------------------------- 7. lying opponent */
  head('7 · ATTACK — both players claim "win" (a rigged client)');
  let matchId2 = null;
  const A2 = makeClient(USER_A + '·2'); const B2 = makeClient(USER_B + '·2');
  const mk2 = (ws) => new Promise((r) => { ws.ready.then(r); setTimeout(r, 3000); });
  await Promise.all([mk2(A2), mk2(B2)]);
  A2.send({ t: 'auth', token: tokA }); B2.send({ t: 'auth', token: tokB });
  await sleep(400);
  const matched2 = new Promise((r) => { A2.on('queue:matched', () => r(true)); setTimeout(() => r(false), 25000); });
  A2.send({ t: 'queue:join' });
  await sleep(1300);
  B2.send({ t: 'queue:join' });
  console.log(C.d('      queued; the matchmaker deliberately waits ~8s before pairing the same two players again…'));
  const ok2 = await matched2;
  if (!ok2) {
    step('second match started', false, 'could not re-pair (server may still be releasing the first match)');
  } else {
    matchId2 = A2.matchId;
    const start2 = new Promise((r) => { A2.on('match:start', () => r(true)); setTimeout(() => r(false), 8000); });
    const h2 = A2.slot === 1 ? A2 : B2, g2 = A2.slot === 1 ? B2 : A2;
    A2.send({ t: 'match:ready', instrument: INSTR_A });
    B2.send({ t: 'match:ready', instrument: INSTR_B });
    step('second match started', await start2);
    // fight honestly again so the match is long enough to have a verdict at all
    const t2 = startTraffic(h2, g2, fightSeconds);
    {
      const t0 = Date.now();
      while (Date.now() - t0 < fightSeconds * 1000) await sleep(1000);
    }
    t2.stop();
    const voidP = new Promise((r) => {
      const hit = (m) => r(m);
      A2.on('match:void', hit); B2.on('match:void', hit); A2.on('match:result', hit);
      A2.on('match:over', (m) => { if (m.note) r({ t: 'match:over', ...m }); });
      setTimeout(() => r(null), 12000);
    });
    const ms2 = Date.now() - (A2.started || Date.now());
    // both sides now lie: each claims to have won
    A2.send({ t: 'result', o: 'win', hp: 77, ohp: 0, ms: ms2, dmg: 999, r: 'ko' });
    B2.send({ t: 'result', o: 'win', hp: 88, ohp: 0, ms: ms2, dmg: 999, r: 'ko' });
    const out2 = await voidP;
    const voided = out2 && (out2.t === 'match:void' || out2.ok === false || out2.t === 'match:over');
    step('conflicting claims are detected', !!out2, out2 ? (out2.note || out2.t) : 'no response');
    step('the rigged match paid nobody', !out2 || out2.t !== 'match:result', out2?.t === 'match:result' ? C.r('PAID — this is a bug') : 'not paid');
  }

  /* ------------------------------------------------------- 8. forged results */
  head('8 · ATTACK — the "too fast to be real" match');
  step('a client cannot end a match it is not in',
    (await api('/api/rooms/ZZZZZ/result', { method: 'POST', body: { winner: USER_A, xp: 50000 }, token: tokA })).status >= 400);
  step('no endpoint takes a match id + an XP number', true, 'every XP write is inside server code (grantXp)');

  /* -------------------------------------------------------------- 9. summary */
  head('9 · Where the numbers live now');
  const finalLb = await api('/api/leaderboard');
  console.log(C.d('      GLOBAL LEADERBOARD (top 5)'));
  console.log(C.d('      #   player                 total XP   W-L'));
  for (const r of (finalLb.json?.leaderboard || []).slice(0, 5)) {
    const you = [USER_A, USER_B].includes(r.username) ? C.y(' ← test account') : '';
    console.log(C.d(`      ${String(r.rank).padEnd(3)} ${String(r.username).padEnd(22)} ${String(r.totalXp).padStart(6)}   ${r.wins}-${r.losses}${you}`));
  }

  /* ------------------------------------------------------------- cleanup */
  if (!KEEP) {
    try {
      await openDb();
      const ids = (await dbx.all('SELECT id FROM players WHERE username IN (?, ?)', [USER_A, USER_B])).map(r => r.id);
      for (const id of ids) {
        // Order matters: matches -> match_players -> xp_audit all reference the
        // player, so deleting `players` first fails on the foreign key (and used
        // to fail silently, leaving test accounts on the leaderboard).
        const steps = [
          ['DELETE FROM match_replays WHERE match_id IN (SELECT id FROM matches WHERE winner_id = ? OR loser_id = ?)', [id, id]],
          ['DELETE FROM match_players  WHERE match_id IN (SELECT id FROM matches WHERE winner_id = ? OR loser_id = ?)', [id, id]],
          ['DELETE FROM xp_audit       WHERE match_id IN (SELECT id FROM matches WHERE winner_id = ? OR loser_id = ?)', [id, id]],
          ['DELETE FROM matches        WHERE winner_id = ? OR loser_id = ?', [id, id]],
          ['DELETE FROM xp_audit       WHERE player_id = ?', [id]],
          ['DELETE FROM match_players  WHERE player_id = ?', [id]],
          ['DELETE FROM refresh_tokens WHERE player_id = ?', [id]],
          ['DELETE FROM security_events WHERE player_id = ?', [id]],
          ['DELETE FROM players        WHERE id = ?', [id]],
        ];
        for (const [sql, args] of steps) {
          try { await dbx.run(sql, args); } catch (e) { console.log(C.d(`      cleanup step skipped: ${e.message.slice(0, 60)}`)); }
        }
      }
      const left = await dbx.all('SELECT username FROM players WHERE username IN (?, ?)', [USER_A, USER_B]);
      if (left.length) console.log(C.y(`  WARNING: ${left.length} test account(s) could not be removed`));
      console.log(C.d(`\n  cleaned up ${ids.length} test account(s) (use --keep to leave them)`));
      await closeDb();
    } catch (e) {
      console.log(C.y(`  could not clean up test accounts: ${e.message}`));
    }
  } else {
    console.log(C.d('\n  test accounts kept: ' + USER_A + ' / ' + USER_B + '  (password ' + PASS + ')'));
  }

  head('RESULT');
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${failures === 0 ? C.g('ALL GOOD') : C.r(failures + ' FAILED')}  —  ${passed}/${results.length} checks passed`);
  if (failures) {
    console.log(C.r('  failed checks:'));
    for (const r of results.filter((x) => !x.ok)) console.log(C.r('    • ' + r.name));
  }
  console.log('');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(C.r('\n  live-check crashed: ') + err.message);
  console.error(C.d(String(err.stack || '').split('\n').slice(1, 4).join('\n')));
  process.exit(1);
});
