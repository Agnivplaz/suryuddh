/**
 * The realtime hub: one WebSocket endpoint that powers Quick Match, room codes,
 * the input/snapshot relay and the authoritative match lifecycle.
 *
 * Design notes (see docs/03-SYSTEM-DESIGN.md for the long version):
 *
 *  • Host-authoritative simulation + server-arbitrated results.
 *    Slot 1 (host) runs the existing game loop and streams 20 Hz snapshots.
 *    Slot 2 (guest) uploads 30 Hz inputs and renders the snapshots.
 *    The SERVER is the only thing that decides who won, how long it took, and
 *    how much XP is paid — and only after the checks in ../validation.js pass.
 *
 *  • Everything is a message on one socket. No polling, no DB writes per frame,
 *    no game state in the database (that would be far too slow).
 */
import { WebSocketServer } from 'ws';
import config from '../config.js';
import { dbx } from '../db/index.js';
import { playerFromToken } from '../auth.js';
import { logSecurity } from '../security.js';
import { createRoomCode } from '../routes/rooms.js';
import { parseMessage, normaliseInput, normaliseResult, send } from './protocol.js';
import { LiveMatch } from './match.js';

export function createHub({ server, onStats } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.limits.wsMaxPayloadBytes });

  /** ws -> client record */
  const clients = new Map();
  /** playerId -> ws (one live socket per account) */
  const byPlayer = new Map();
  /** matchId -> LiveMatch */
  const matches = new Map();
  /** quick-match queue of client records */
  const queue = [];
  /** roomCode -> {code, hostId, guestId, matchId, status, expiresAt} */
  const rooms = new Map();
  /** playerId -> matchId (last opponent, used by the matchmaker) */
  const lastOpponent = new Map();

  const stats = { online: 0, queued: 0, inMatch: 0, rooms: 0, matches: 0 };

  /* ------------------------------------------------------------ connection */
  wss.on('connection', (ws, req) => {
    const client = {
      ws,
      id: ++handler.connId,
      ip: (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown',
      player: null,
      roomCode: null,
      matchId: null,
      alive: true,
      connectedAt: Date.now(),
      msgWindow: Date.now(),
      msgCount: 0,
      closed: false,
    };
    clients.set(ws, client);

    ws.on('pong', () => { client.alive = true; });

    send(ws, {
      t: 'hello',
      serverTime: Date.now(),
      version: 1,
      countdownMs: config.match.countdownMs,
      minMatchMs: config.match.minDurationMs,
    });

    ws.on('message', (raw, isBinary) => {
      // cheap flood guard before any parsing
      const now = Date.now();
      if (now - client.msgWindow > 1000) { client.msgWindow = now; client.msgCount = 0; }
      if (++client.msgCount > config.limits.wsMessagesPerSec) {
        if (client.msgCount === config.limits.wsMessagesPerSec + 1) {
          logSecurity({ kind: 'ws_flood', playerId: client.player?.id, ip: client.ip, detail: '>200 msg/s' });
        }
        return;
      }
      const parsed = parseMessage(raw, isBinary);
      if (!parsed.ok) return send(ws, { t: 'error', error: parsed.error });
      handle(parsed.type, parsed.msg, client).catch((err) => {
        console.error('[ws] handler error', parsed.type, err);
        send(ws, { t: 'error', error: 'server_error' });
      });
    });

    ws.on('close', () => { onClose(client); });
    ws.on('error', () => { onClose(client); });

    broadcastPresence();
  });

  /* --------------------------------------------------------------- dispatch */
  const handler = { connId: 0 };

  async function handle(type, msg, client) {
    /* ------------------------------------------------------------- auth */
    if (type === 'auth') {
      const player = await playerFromToken(msg.token);
      if (!player) return send(client.ws, { t: 'auth:error', error: 'invalid_token' });

      // one socket per account: the older one is retired (prevents ghost players)
      const prev = byPlayer.get(player.id);
      if (prev && prev !== client.ws) {
        send(prev, { t: 'error', error: 'signed_in_elsewhere' });
        try { prev.close(4001, 'replaced'); } catch {}
      }
      client.player = player;
      byPlayer.set(player.id, client.ws);

      await dbx.run('UPDATE players SET last_seen = ? WHERE id = ?', [Date.now(), player.id]);
      send(client.ws, {
        t: 'auth:ok',
        player: {
          id: player.id, username: player.username, total_xp: player.total_xp,
          games_played: player.games_played, wins: player.wins, losses: player.losses,
        },
      });

      // resume a match this player was dragged out of (guest only — see match.js)
      const live = findLiveMatchFor(player.id);
      if (live) {
        const slot = live.slotOf(player.id);
        const resumed = live.markReconnected(player.id);
        if (resumed) {
          live.slots[slot].socket = client.ws;
          client.matchId = live.id;
          send(client.ws, { ...live.startPayload(), resumed: true });
          live.sendTo(slot === 1 ? 2 : 1, { t: 'peer:back', slot });
        } else {
          send(client.ws, { t: 'match:over', matchId: live.id, reason: 'cannot_resume' });
        }
      }
      broadcastPresence();
      return;
    }

    if (type === 'ping') return send(client.ws, { t: 'pong', c: msg.c ?? null, serverTime: Date.now() });

    /* everything below needs a signed-in player */
    const player = client.player;
    if (!player) return send(client.ws, { t: 'error', error: 'not_authenticated' });

    switch (type) {
      /* --------------------------------------------------- quick match */
      case 'queue:join': return queueJoin(client);
      case 'queue:leave': return queueLeave(client, 'left_queue');

      /* --------------------------------------------------------- rooms */
      case 'room:create': return roomCreate(client);
      case 'room:join': return roomJoin(client, msg.code);
      case 'room:leave': return roomLeave(client);

      /* -------------------------------------------------------- matches */
      case 'match:ready': return matchReady(client, msg.instrument);
      case 'match:state': return matchState(client);
      case 'match:leave': return matchLeave(client, 'forfeit');

      /* ------------------------------------------------- relay channels */
      case 'input': return relayInput(client, msg);
      case 'snap': return relaySnapshot(client, msg);

      /* --------------------------------------------------------- results */
      case 'result': return resultClaim(client, msg);
      default: return;
    }
  }

  /* ----------------------------------------------------------------- queue */
  function queueJoin(client) {
    const p = client.player;
    if (client.matchId) {
      const m = matches.get(client.matchId);
      if (m && (m.status === 'live' || m.status === 'readying')) {
        const slot = m.slotOf(p.id);
        const mine = slot ? m.slots[slot] : null;
        if (!mine?.claim) {
          // genuinely still fighting
          return send(client.ws, { t: 'queue:error', error: 'in_match' });
        }
        // They already reported a result and just want to play again: the match
        // is only waiting on the opponent / the DB write. Remember the intent and
        // queue them the moment the match is released (usually < 1 second).
        client.wantQueue = true;
        return send(client.ws, { t: 'queue:waiting', pending: true, since: Date.now(), online: queue.length });
      }
      client.matchId = null;            // stale lock from an already-settled match
    }
    if (queue.some(c => c.player.id === p.id)) return send(client.ws, { t: 'queue:waiting', again: true });

    // If they are sitting in a room that is still waiting for a guest, put them
    // back in it instead of queueing them silently.
    if (client.roomCode) {
      const rec = rooms.get(client.roomCode);
      if (rec && rec.status === 'open' && !rec.guestId && rec.hostId === p.id) {
        return send(client.ws, { t: 'room:state', ...roomStatePayload(client.roomCode) });
      }
      client.roomCode = null;      // that room is done/consumed — free the client
    }

    queue.push(client);
    send(client.ws, { t: 'queue:waiting', since: Date.now(), online: queue.length });
    tryPair();
    broadcastPresence();
  }

  function queueLeave(client, reason) {
    const i = queue.indexOf(client);
    if (i >= 0) queue.splice(i, 1);
    send(client.ws, { t: 'queue:cancelled', reason });
    broadcastPresence();
  }

  function tryPair() {
    const now = Date.now();
    const pair = (a, b) => {
      queue.splice(queue.indexOf(b), 1);
      queue.splice(queue.indexOf(a), 1);
      createMatch({ mode: 'ranked_1v1', hostClient: a, guestClient: b });
      return true;
    };

    // ---- pass 1: prefer somebody you have not just played -----------------
    for (let i = 0; i < queue.length; i++) {
      for (let j = i + 1; j < queue.length; j++) {
        const a = queue[i], b = queue[j];
        if (!a.player || !b.player) continue;
        if (!isAlive(a) || !isAlive(b)) continue;
        if (a.player.id === b.player.id) continue;
        const recent = lastOpponent.get(a.player.id);
        if (recent && recent.opponentId === b.player.id && now - recent.at < config.queue.avoidLastOpponentMs) continue;
        return pair(a, b);
      }
    }

    // ---- pass 2: two lonely players who have waited long enough -----------
    // (otherwise two friends testing the game together would never match twice)
    const ready = queue.filter(c => isAlive(c) && c.player && now - (c.queueSince || c.connectedAt) > config.queue.rematchAfterMs);
    if (ready.length >= 2) {
      for (let i = 0; i < ready.length; i++) {
        for (let j = i + 1; j < ready.length; j++) {
          if (ready[i].player.id === ready[j].player.id) continue;
          return pair(ready[i], ready[j]);
        }
      }
    }

    // bots? never. Offline AI practice stays a client-side feature — it must
    // never feed the online leaderboard.
    return false;
  }

  /* ----------------------------------------------------------------- rooms */
  async function roomCreate(client) {
    const p = client.player;
    const open = await dbx.all(
      "SELECT room_code FROM rooms WHERE host_id = ? AND status IN ('open','matched')",
      [p.id],
    );
    if (open.length >= config.rooms.maxOpenPerPlayer) {
      // reuse the newest one instead of stacking rooms
      client.roomCode = open[0].room_code;
      rooms.set(open[0].room_code, rooms.get(open[0].room_code) || {
        code: open[0].room_code, hostId: p.id, guestId: null, status: 'open',
      });
      return send(client.ws, { t: 'room:created', ...roomStatePayload(open[0].room_code), reused: true });
    }

    const code = await createRoomCode();
    const now = Date.now();
    await dbx.run(
      'INSERT INTO rooms (room_code, host_id, guest_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [code, p.id, null, 'open', now, now + config.rooms.ttlMs],
    );
    rooms.set(code, { code, hostId: p.id, guestId: null, status: 'open', expiresAt: now + config.rooms.ttlMs });
    client.roomCode = code;
    send(client.ws, { t: 'room:created', ...roomStatePayload(code) });
    broadcastPresence();
  }

  async function roomJoin(client, rawCode) {
    const p = client.player;
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code.length < 4) return send(client.ws, { t: 'room:error', error: 'bad_code' });

    const row = await dbx.one('SELECT * FROM rooms WHERE room_code = ?', [code]);
    if (!row) return send(client.ws, { t: 'room:error', error: 'no_such_room', code });
    if (Number(row.expires_at) < Date.now()) return send(client.ws, { t: 'room:error', error: 'room_expired', code });
    if (row.host_id === p.id) return send(client.ws, { t: 'room:error', error: 'own_room', code });
    if (row.guest_id && row.guest_id !== p.id) return send(client.ws, { t: 'room:error', error: 'room_full', code });

    const hostWs = byPlayer.get(row.host_id);
    if (!hostWs) return send(client.ws, { t: 'room:error', error: 'host_offline', code });

    const hostClient = clients.get(hostWs);
    if (!isAlive(hostClient)) return send(client.ws, { t: 'room:error', error: 'host_offline', code });

    await dbx.run("UPDATE rooms SET guest_id = ?, status = 'matched' WHERE room_code = ?", [p.id, code]);
    const rec = rooms.get(code) || { code, hostId: row.host_id, guestId: p.id, status: 'matched' };
    rec.guestId = p.id; rec.status = 'matched';
    rooms.set(code, rec);
    client.roomCode = code;

    createMatch({ mode: 'friendly', roomCode: code, hostClient, guestClient: client });
    return true;
  }

  async function roomLeave(client) {
    const code = client.roomCode;
    client.roomCode = null;
    if (!code) return;
    const rec = rooms.get(code);
    if (rec && !rec.matchId) {
      rooms.delete(code);
      await dbx.run("UPDATE rooms SET status = 'closed' WHERE room_code = ? AND status <> 'live'", [code]);
      const hostWs = byPlayer.get(rec.hostId);
      const hostClient = hostWs && clients.get(hostWs);
      if (hostClient && hostClient !== client) {
        send(hostClient.ws, { t: 'room:closed', code, reason: 'guest_left' });
        hostClient.roomCode = null;
      }
      send(client.ws, { t: 'room:closed', code, reason: 'left' });
    }
    broadcastPresence();
  }

  function roomStatePayload(code) {
    const rec = rooms.get(code);
    if (!rec) return { code, status: 'closed' };
    return { code, status: rec.status, hostId: rec.hostId, guestId: rec.guestId, expiresAt: rec.expiresAt };
  }

  /* --------------------------------------------------------------- matches */
  async function createMatch({ mode, roomCode = null, hostClient, guestClient }) {
    const host = hostClient.player, guest = guestClient.player;
    const m = new LiveMatch({ mode, roomCode, host, guest, hub: api });
    m.slots[1].socket = hostClient.ws;
    m.slots[2].socket = guestClient.ws;
    matches.set(m.id, m);

    hostClient.matchId = m.id; guestClient.matchId = m.id;
    hostClient.roomCode = null; guestClient.roomCode = null;   // the room is consumed
    lastOpponent.set(host.id, { opponentId: guest.id, at: Date.now() });
    lastOpponent.set(guest.id, { opponentId: host.id, at: Date.now() });

    // The DB row is written immediately: a match exists on the server before a
    // single frame is simulated, so no XP can ever reference a match that the
    // client invented.
    const now = Date.now();
    await dbx.run(
      `INSERT INTO matches (id, mode, room_code, status, seed, started_at, created_at)
       VALUES (?, ?, ?, 'live', ?, ?, ?)`,
      [m.id, mode, roomCode, m.seed, now, now],
    );
    for (const slot of [1, 2]) {
      const s = m.slots[slot];
      await dbx.run(
        `INSERT INTO match_players (match_id, slot, player_id, username, instrument, outcome)
         VALUES (?, ?, ?, ?, ?, 'void')`,
        [m.id, slot, s.playerId, s.username, 'pending'],
      );
    }
    if (roomCode) await dbx.run("UPDATE rooms SET status = 'live', match_id = ? WHERE room_code = ?", [m.id, roomCode]);
    if (roomCode) { const rec = rooms.get(roomCode); if (rec) rec.matchId = m.id; }

    send(hostClient.ws, { t: 'queue:matched', matchId: m.id, slot: 1, mode, opponent: guest.username });
    send(guestClient.ws, { t: 'queue:matched', matchId: m.id, slot: 2, mode, opponent: host.username });
    stats.matches = matches.size;
    broadcastPresence();
    return m;
  }

  function matchReady(client, instrument) {
    const m = matches.get(client.matchId);
    if (!m) return send(client.ws, { t: 'error', error: 'no_active_match' });
    const r = m.setReady(client.player.id, instrument);
    if (!r.ok) return send(client.ws, { t: 'error', error: r.error });
    send(client.ws, { t: 'match:ready:ack', slot: r.slot, instrument });
    m.sendTo(r.slot === 1 ? 2 : 1, { t: 'peer:state', ready: true, instrument });

    if (m.bothReady && m.start()) {
      // persist the chosen instruments now that they are final
      for (const slot of [1, 2]) {
        dbx.run('UPDATE match_players SET instrument = ? WHERE match_id = ? AND slot = ?',
          [m.slots[slot].instrument, m.id, slot]).catch(() => {});
      }
      const payload = m.startPayload();
      m.sendTo(1, { ...payload, role: 'host', slot: 1 });
      m.sendTo(2, { ...payload, role: 'guest', slot: 2 });
      broadcastPresence();
    }
  }

  function matchState(client) {
    const m = matches.get(client.matchId);
    if (!m) return send(client.ws, { t: 'error', error: 'no_active_match' });
    const slot = m.slotOf(client.player.id);
    send(client.ws, { ...m.startPayload(), resumed: true, role: slot === 1 ? 'host' : 'guest', slot });
  }

  function matchLeave(client, reason) {
    const m = matches.get(client.matchId);
    if (!m) return;
    const slot = m.slotOf(client.player.id);
    if (!slot) return;
    // Leaving = forfeit. The server treats it exactly like a drop: the opponent
    // is paid only after the standard validation, and a sub-20s match is voided.
    m.slots[slot].claim = m.slots[slot].claim || { outcome: 'loss', reason: 'forfeit', at: Date.now() };
    m.markDisconnected(client.player.id);
    client.matchId = null;
    m.sendTo(slot === 1 ? 2 : 1, { t: 'peer:left', slot, reason: 'forfeit', graceMs: 0 });
    m.finalize().then(() => releaseMatch(m)).catch(() => {});
  }

  /* ----------------------------------------------------------------- relay */
  function relayInput(client, msg) {
    const m = matches.get(client.matchId);
    if (!m) return;
    const slot = m.slotOf(client.player.id);
    if (slot !== 2) return;                                  // only the guest uploads inputs
    const out = m.acceptInput(client.player.id, normaliseInput(msg));
    if (!out.ok) return;
    const hostSlot = m.slots[1];
    if (hostSlot.socket) send(hostSlot.socket, { ...out.relay, from: 2 });
  }

  function relaySnapshot(client, msg) {
    const m = matches.get(client.matchId);
    if (!m) return;
    const out = m.acceptSnapshot(client.player.id, msg);
    if (!out.ok) return;
    const guest = m.slots[2];
    if (guest.socket) send(guest.socket, out.relay);
  }

  /* -------------------------------------------------------------- results */
  async function resultClaim(client, msg) {
    const m = matches.get(client.matchId);
    if (!m) return send(client.ws, { t: 'error', error: 'no_active_match' });
    const claim = normaliseResult(msg);
    if (!claim.outcome) return send(client.ws, { t: 'error', error: 'bad_result' });
    const r = m.setClaim(client.player.id, claim);
    if (!r.ok) return send(client.ws, { t: 'error', error: r.error });

    const slot = m.slotOf(client.player.id);
    m.slots[slot].damageDealt = Number(msg.dmg) || m.slots[slot].damageDealt;
    m.sendTo(slot === 1 ? 2 : 1, { t: 'peer:state', claim: claim.outcome });

    const out = await m.finalize();
    if (out.changed) {
      // the match is settled: both clients are free to queue again immediately
      releaseMatch(m);
    } else {
      send(client.ws, { t: 'match:over', matchId: m.id, awaiting: true, note: out.verdict?.note });
    }
  }

  /* ------------------------------------------------------------ lifecycle */
  function onClose(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client.ws);
    if (client.player && byPlayer.get(client.player.id) === client.ws) byPlayer.delete(client.player.id);

    const qi = queue.indexOf(client);
    if (qi >= 0) queue.splice(qi, 1);

    if (client.matchId) {
      const m = matches.get(client.matchId);
      if (m) {
        const slot = m.markDisconnected(client.player.id);
        if (slot) {
          m.slots[slot].socket = null;
          m.sendTo(slot === 1 ? 2 : 1, {
            t: 'peer:left', slot, reason: 'disconnected',
            graceMs: config.match.disconnectGraceMs,
          });
        }
      }
    }
    if (client.roomCode) {
      const rec = rooms.get(client.roomCode);
      if (rec && rec.hostId === client.player?.id && !rec.matchId) {
        rooms.delete(client.roomCode);
        dbx.run("UPDATE rooms SET status = 'closed' WHERE room_code = ? AND status <> 'live'", [client.roomCode]).catch(() => {});
      }
    }
    broadcastPresence();
  }

  /* ------------------------------------------------------------------ tick */
  const tick = setInterval(async () => {
    const now = Date.now();

    /* 0. retry matchmaking: pass 2 of tryPair() only becomes eligible once
       people have been waiting, and waiting changes without any new message. */
    tryPair();

    /* 1. queue timeouts ------------------------------------------------- */
    for (let i = queue.length - 1; i >= 0; i--) {
      const c = queue[i];
      if (!isAlive(c)) { queue.splice(i, 1); continue; }
      if (now - c.connectedAt > 4 * 60 * 60_000) { queue.splice(i, 1); continue; }
      const waited = now - (c.queueSince || c.connectedAt);
      if (waited > config.queue.timeoutMs) {
        queue.splice(i, 1);
        send(c.ws, {
          t: 'queue:timeout',
          waitedMs: waited,
          suggestion: 'Nobody else is queueing right now — create a room code and share it, or practise against AI.',
        });
      }
    }
    for (const c of queue) if (!c.queueSince) c.queueSince = now;

    /* 2. rooms that timed out ------------------------------------------- */
    for (const [code, rec] of rooms) {
      if (rec.expiresAt && now > rec.expiresAt && !rec.matchId) {
        rooms.delete(code);
        await dbx.run("UPDATE rooms SET status = 'expired' WHERE room_code = ?", [code]).catch(() => {});
        const ws = byPlayer.get(rec.hostId);
        const c = ws && clients.get(ws);
        if (c) { send(c.ws, { t: 'room:closed', code, reason: 'expired' }); if (c.roomCode === code) c.roomCode = null; }
      }
    }

    /* 3. match lifecycle ------------------------------------------------ */
    for (const [id, m] of matches) {
      if (m.status === 'finished' || m.status === 'void' || m.status === 'abandoned') {
        releaseMatch(m);                       // belt and braces: never leave a stale lock
        if (now - (m.result?.at || m.endedAt || m.createdAt) > 120_000) {
          matches.delete(id);
          if (m.roomCode) {
            const rec = rooms.get(m.roomCode);
            if (rec) { rooms.delete(m.roomCode); }
            await dbx.run("UPDATE rooms SET status = 'closed' WHERE room_code = ?", [m.roomCode]).catch(() => {});
          }
        }
        continue;
      }

      // still readying but somebody never came back → abandon, no XP, no blame
      if (m.status === 'readying' && now - m.createdAt > 90_000) {
        m.status = 'abandoned';
        m.broadcast('match:void', { matchId: m.id, reason: 'ready_timeout' });
        releaseMatch(m);
        continue;
      }

      if (m.status !== 'live') continue;

      // try to settle: verdicts only resolve once evidence is sufficient
      const out = await m.finalize(now);
      if (out.changed) { releaseMatch(m); continue; }

      if (m.isExpired(now)) {
        m.endedAt = m.endedAt || now;
        await m.voidMatch('expired');
        releaseMatch(m);
      }
    }

    /* 4. dead sockets ---------------------------------------------------- */
    for (const [ws, c] of clients) {
      if (c.alive === false) { try { ws.terminate(); } catch {} continue; }
      c.alive = false;
      try { ws.ping(); } catch {}
    }

    stats.online = clients.size;
    stats.queued = queue.length;
    stats.inMatch = [...matches.values()].filter(m => m.status === 'live').length;
    stats.rooms = rooms.size;
    onStats?.(stats);
  }, 1000);
  tick.unref?.();

  /* -------------------------------------------------------------- helpers */
  function isAlive(client) {
    return client && !client.closed && client.ws.readyState === 1;
  }

  /**
   * Free both players from a finished match so they can queue again.
   * Without this a player keeps a stale `matchId` and the hub answers every
   * later queue:join with "in_match".
   */
  function releaseMatch(m) {
    for (const slot of [1, 2]) {
      const ws = byPlayer.get(m.slots[slot].playerId);
      const c = ws && clients.get(ws);
      if (!c || c.matchId !== m.id) continue;
      c.matchId = null;
      if (c.wantQueue && isAlive(c)) {         // they hit "find another match" already
        c.wantQueue = false;
        try { queueJoin(c); } catch {}
      }
    }
  }

  function findLiveMatchFor(playerId) {
    for (const m of matches.values()) {
      if (m.status === 'live' && m.slotOf(playerId)) return m;
    }
    return null;
  }

  let lastPresence = '';
  function broadcastPresence() {
    const payload = presence();
    const key = JSON.stringify(payload);
    if (key === lastPresence) return;
    lastPresence = key;
    for (const c of clients.values()) if (c.player && c.ws.readyState === 1) send(c.ws, { t: 'presence', ...payload });
  }

  const presence = () => ({
    online: clients.size,
    players: [...clients.values()].filter(c => c.player).length,
    queued: queue.length,
    inMatch: [...matches.values()].filter(m => m.status === 'live').length,
    openRooms: [...rooms.values()].filter(r => r.status === 'open').length,
  });

  /* ------------------------------------------------------------------ api */
  const api = {
    wss, clients, matches, queue, rooms, stats,
    presence,
    async close() {
      clearInterval(tick);
      for (const c of clients.values()) { try { c.ws.close(1001, 'server shutting down'); } catch {} }
      await new Promise(res => wss.close(res));
    },
  };
  return api;
}

export default createHub;
