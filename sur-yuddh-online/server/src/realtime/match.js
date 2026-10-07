/**
 * The server's authoritative view of ONE live match.
 *
 * The browser does the pixel work; this object owns the truth that matters:
 * who is in the match, which instrument they picked, how long the match lasted
 * on the SERVER's clock, how many valid input frames each side produced, who
 * disconnected and when, and what the final result is allowed to be.
 *
 * Nothing here trusts a number the client sent. Client values are stored as
 * "claims" and are only used as *evidence*, never as *facts*.
 */
import crypto from 'node:crypto';
import config from '../config.js';
import { dbx } from '../db/index.js';
import { send } from './protocol.js';
import { validateInputFrame, validateSnapshot, validateMatchResult, isInstrument, activityOfSlot } from '../validation.js';
import { computeXp, xpToday, repeatOpponentScale, grantXp } from '../xp.js';
import { logSecurity } from '../security.js';

let seqCounter = 0;

export class LiveMatch {
  constructor({ mode, roomCode = null, host, guest, hub }) {
    this.id = dbx.uuid();
    this.seq = ++seqCounter;
    this.mode = mode;                         // 'ranked_1v1' (Quick Match) | 'friendly' (room code)
    this.roomCode = roomCode;
    this.hub = hub;

    // Slot 1 = host = the simulation authority (runs the fight, streams state).
    // Slot 2 = guest = sends inputs, renders snapshots.
    this.slots = {
      1: this.makeSlot(host, 1),
      2: this.makeSlot(guest, 2),
    };

    this.createdAt = Date.now();
    this.startedAt = null;
    this.startAtTs = null;
    this.endedAt = null;
    this.status = 'readying';                 // readying | live | finished | void | abandoned
    this.seed = crypto.randomInt(1, 2 ** 31 - 1);
    this.finalizing = false;
    this.inputLog = { 1: [], 2: [] };
    this.snapCount = 0;
    this.lastSnapAt = 0;
    this.inputBytes = 0;
    this.notes = [];
  }

  makeSlot(player, slot) {
    return {
      slot,
      playerId: player.id,
      username: player.username,
      instrument: null,
      ready: false,
      joinedAt: Date.now(),
      frames: 0,            // validated input frames received
      movingFrames: 0,
      snaps: 0,
      actionCounts: {},
      lastAction: {},
      disconnectedAt: null,
      claim: null,
      hpLeft: null,
      damageDealt: 0,       // client-reported, display only
      cooldowns: null,
      socket: null,
      reconnects: 0,
    };
  }

  other(slot) { return this.slots[slot === 1 ? 2 : 1]; }
  slotOf(playerId) {
    if (this.slots[1].playerId === playerId) return 1;
    if (this.slots[2].playerId === playerId) return 2;
    return 0;
  }

  /* ------------------------------------------------------------- readiness */
  setReady(playerId, instrument) {
    const slot = this.slotOf(playerId);
    if (!slot) return { ok: false, error: 'not_in_match' };
    if (this.status !== 'readying') return { ok: false, error: 'already_started' };
    if (!isInstrument(instrument)) return { ok: false, error: 'bad_instrument' };
    const s = this.slots[slot];
    s.instrument = instrument;
    s.ready = true;
    return { ok: true, slot };
  }

  get bothReady() {
    return this.slots[1].ready && this.slots[2].ready && this.slots[1].instrument && this.slots[2].instrument;
  }

  /** Begin the fight. `startAtTs` is a server timestamp both clients sync to. */
  start() {
    if (!this.bothReady) return false;
    this.status = 'live';
    this.startedAt = Date.now();
    this.startAtTs = this.startedAt + config.match.countdownMs;
    return true;
  }

  /** Everything a joining client needs to build the fight locally. */
  startPayload() {
    return {
      t: 'match:start',
      matchId: this.id,
      seed: this.seed,
      startAtTs: this.startAtTs,
      serverNow: Date.now(),
      mode: this.mode,
      players: {
        1: { username: this.slots[1].username, instrument: this.slots[1].instrument },
        2: { username: this.slots[2].username, instrument: this.slots[2].instrument },
      },
    };
  }

  /* ---------------------------------------------------------------- inputs */
  /** Guest → host. Validated against the game's real cooldowns before relaying. */
  acceptInput(playerId, msg) {
    const slot = this.slotOf(playerId);
    if (!slot) return { ok: false, error: 'not_in_match' };
    if (this.status !== 'live') return { ok: false, error: 'not_live' };
    const s = this.slots[slot];
    const now = Date.now();
    const v = validateInputFrame(s, msg, now);
    if (!v.ok) {
      s.rejectedInputs = (s.rejectedInputs || 0) + 1;
      if (s.rejectedInputs === 12 || s.rejectedInputs % 60 === 0) {
        logSecurity({
          kind: 'input_rejected', playerId, detail: `${v.reason} x${s.rejectedInputs}`,
          trustDelta: s.rejectedInputs === 12 ? -3 : 0,
        });
      }
      return v;
    }
    // compact log for later re-simulation: [msSinceStart, x, z, actionMask]
    const mask = (v.actions.includes('atk1') ? 1 : 0) | (v.actions.includes('atk2') ? 2 : 0)
               | (v.actions.includes('def') ? 4 : 0) | (v.actions.includes('agi') ? 8 : 0)
               | (v.actions.includes('ult') ? 16 : 0);
    const log = this.inputLog[slot];
    const elapsed = now - this.startedAt;
    const last = log[log.length - 1];
    if (!last || elapsed - last[0] >= 33 || mask) {
      if (log.length < 40_000) log.push([elapsed, +v.x.toFixed(3), +v.z.toFixed(3), mask]);
    }
    this.inputBytes = JSON.stringify(this.inputLog[slot]).length;
    this.quantisedInput = { t: 'peer:input', x: v.x, z: v.z, a: v.actions, ms: elapsed };
    return { ok: true, relay: this.quantisedInput };
  }

  /* ------------------------------------------------------------- snapshots */
  acceptSnapshot(playerId, msg) {
    const slot = this.slotOf(playerId);
    if (!slot) return { ok: false, error: 'not_in_match' };
    if (slot !== 1) return { ok: false, error: 'not_host' };      // only the sim authority streams state
    if (this.status !== 'live') return { ok: false, error: 'not_live' };
    const now = Date.now();
    const maxHz = config.match.maxSnapHz;
    if (now - this.lastSnapAt < 1000 / (maxHz + 5)) {
      this.snapFlood = (this.snapFlood || 0) + 1;
      if (this.snapFlood > 30) {
        logSecurity({ kind: 'snap_flood', playerId, detail: `>${maxHz}Hz`, trustDelta: -2 });
        this.snapFlood = 0;
      }
      return { ok: false, error: 'rate_limited' };
    }
    const v = validateSnapshot(msg);
    if (!v.ok) {
      logSecurity({ kind: 'bad_snapshot', playerId, detail: v.reason, trustDelta: -3 });
      return v;
    }
    this.lastSnapAt = now;
    this.snapCount++;
    this.slots[slot].snaps++;          // this is the host's "liveness" evidence
    return { ok: true, relay: { t: 'peer:snap', ms: now - this.startedAt, d: msg } };
  }

  /* ------------------------------------------------------ end-of-match path */
  setClaim(playerId, claim) {
    const slot = this.slotOf(playerId);
    if (!slot || !claim.outcome) return { ok: false, error: 'bad_claim' };
    const s = this.slots[slot];
    if (this.status !== 'live') return { ok: false, error: 'not_live' };
    if (!s.claim) {
      s.claim = claim;
      if (claim.hpLeft !== null) s.hpLeft = claim.hpLeft;
      if (claim.reason === 'disconnect') s.claimDisconnect = true;
    }
    // First claim ends the match clock; the server owns `endedAt`.
    if (!this.endedAt) this.endedAt = Date.now();
    return { ok: true };
  }

  markDisconnected(playerId) {
    const slot = this.slotOf(playerId);
    if (!slot || this.status !== 'live') return null;
    const s = this.slots[slot];
    if (!s.disconnectedAt) s.disconnectedAt = Date.now();
    return slot;
  }

  markReconnected(playerId) {
    const slot = this.slotOf(playerId);
    if (!slot) return null;
    const s = this.slots[slot];
    if (!s.disconnectedAt) return null;
    if (slot === 1) return null;               // the sim authority cannot resume (state lives in its tab)
    s.disconnectedAt = null;
    s.reconnects++;
    return slot;
  }

  /** Is the match beyond saving? */
  isExpired(now = Date.now()) {
    if (this.status !== 'live') return false;
    if (this.endedAt && now - this.endedAt > config.match.resultWaitMs) return true;
    if (this.startedAt && now - this.startedAt > config.match.maxDurationMs) return true;
    return false;
  }

  /** Run the validator; returns the verdict without touching the DB. */
  verdict(now = Date.now()) {
    return validateMatchResult(this, now);
  }

  /**
   * The single funnel through which a match can end and XP can be paid out.
   * Idempotent: `finalizing` + `status` guards mean it can only ever run once.
   */
  async finalize(now = Date.now()) {
    if (this.finalizing || this.status === 'finished' || this.status === 'void' || this.status === 'abandoned') {
      return { changed: false };
    }
    const verdict = this.verdict(now);
    if (verdict.decision === 'wait') return { changed: false, verdict };

    this.finalizing = true;
    try {
      if (verdict.decision === 'reject') {
        await this.voidMatch(verdict.note || 'rejected');
        return { changed: true, void: true, verdict };
      }

      const winnerSlot = verdict.winnerSlot;
      const loserSlot = verdict.loserSlot;
      const w = this.slots[winnerSlot];
      const l = this.slots[loserSlot];
      const durationMs = (this.endedAt ?? now) - this.startedAt;

      // -------- compute rewards OUTSIDE the transaction (read-only queries) --
      const [wPlayer, lPlayer] = await Promise.all([
        dbx.one('SELECT * FROM players WHERE id = ?', [w.playerId]),
        dbx.one('SELECT * FROM players WHERE id = ?', [l.playerId]),
      ]);
      const [wToday, lToday, repeat] = await Promise.all([
        xpToday(w.playerId), xpToday(l.playerId),
        repeatOpponentScale(w.playerId, l.playerId, this.startedAt),
      ]);

      const wXp = computeXp({
        outcome: 'win', reason: verdict.reason, durationMs,
        myTotalXp: wPlayer.total_xp, oppTotalXp: lPlayer.total_xp,
        repeatScale: repeat, dayCapRemaining: Math.max(0, config.xp.dailyCap - wToday),
      });
      const lXp = computeXp({
        outcome: 'loss', reason: verdict.reason, durationMs,
        myTotalXp: lPlayer.total_xp, oppTotalXp: wPlayer.total_xp,
        repeatScale: repeat, dayCapRemaining: Math.max(0, config.xp.dailyCap - lToday),
      });

      // ------------------------------- single atomic payout ------------------
      await dbx.tx(async (tx) => {
        await tx.query(
          `UPDATE matches SET status = ?, winner_id = ?, loser_id = ?, win_reason = ?, result_source = ?,
                  validated = ?, validation_note = ?, duration_ms = ?, ended_at = ?
             WHERE id = ?`,
          ['finished', w.playerId, l.playerId, verdict.reason, verdict.source, 1, null,
            durationMs, this.endedAt ?? now, this.id],
        );

        const rows = [
          { s: w, xp: wXp, outcome: 'win' },
          { s: l, xp: lXp, outcome: 'loss' },
        ];
        for (const { s, xp, outcome } of rows) {
          await tx.query(
            `UPDATE match_players SET outcome = ?, xp_earned = ?, damage_dealt = ?, inputs_count = ?,
                    hp_left = ?, disconnected = ?, client_claim = ?
               WHERE match_id = ? AND slot = ?`,
            [outcome, xp.xp, s.damageDealt || 0, activityOfSlot(s), s.hpLeft,
              s.disconnectedAt ? 1 : 0, JSON.stringify(s.claim || null), this.id, s.slot],
          );
          await tx.query(
            `UPDATE players SET games_played = games_played + 1,
                    wins = wins + ?, losses = losses + ?
              WHERE id = ?`,
            [outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, s.playerId],
          );
          // A friendly (room) match can be configured as non-ranked: it is still
          // recorded in full, it just does not move the global leaderboard.
          if (!config.xp.rankedRooms && this.mode === 'friendly') {
            xp.xp = 0;
            xp.breakdown.note = 'friendly_match_not_ranked';
            await tx.query(
              'UPDATE match_players SET xp_earned = 0 WHERE match_id = ? AND slot = ?',
              [this.id, s.slot],
            );
          } else if (xp.xp > 0) {
            await grantXp(tx, {
              playerId: s.playerId, matchId: this.id, delta: xp.xp,
              reason: outcome === 'win'
                ? (verdict.reason === 'disconnect' ? 'disconnect_win' : 'ranked_win')
                : (verdict.reason === 'disconnect' ? 'disconnect_loss' : 'ranked_loss'),
            });
          }
          s.xpResult = xp;
        }

        // keep the replay (bounded) for future server-side re-simulation
        const log = JSON.stringify(this.inputLog);
        const capped = log.length > 400_000 ? log.slice(0, 400_000) : log;
        await tx.query(
          `INSERT INTO match_replays (match_id, seed, host_slot, frames, bytes, input_log, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [this.id, this.seed, 1, this.slots[1].frames + this.slots[2].frames,
            log.length, capped, Date.now()],
        );
      });

      this.status = 'finished';
      this.result = {
        verdict, durationMs,
        xp: { 1: this.slots[1].xpResult, 2: this.slots[2].xpResult },
      };
      this.broadcastResult();
      return { changed: true, result: this.result };
    } catch (err) {
      console.error('[match] finalize failed:', err);
      this.status = 'abandoned';                      // DB failure → no XP, no lies
      this.broadcast('match:void', { matchId: this.id, reason: 'server_error' });
      return { changed: true, error: err.message };
    } finally {
      this.finalizing = false;
    }
  }

  async voidMatch(reason) {
    this.status = 'void';
    await dbx.run(
      "UPDATE matches SET status = 'void', validation_note = ?, ended_at = ? WHERE id = ?",
      [reason, this.endedAt ?? Date.now(), this.id],
    ).catch(() => {});
    await dbx.run(
      "UPDATE match_players SET outcome = 'void' WHERE match_id = ?",
      [this.id],
    ).catch(() => {});
    const flagged = reason !== 'abandoned' && reason !== 'expired';
    if (flagged) {
      await logSecurity({
        kind: 'match_void', detail: reason, playerId: this.slots[1].playerId, trustDelta: -2,
      });
      await logSecurity({ kind: 'match_void', detail: reason, playerId: this.slots[2].playerId, trustDelta: -2 });
    }
    this.broadcast('match:void', { matchId: this.id, reason });
  }

  broadcastResult() {
    for (const slot of [1, 2]) {
      const s = this.slots[slot];
      const xp = this.result.xp[slot];
      const opp = this.other(slot);
      this.sendTo(slot, {
        t: 'match:result',
        matchId: this.id,
        outcome: this.result.verdict.winnerSlot === slot ? 'win' : 'loss',
        reason: this.result.verdict.reason,
        xpEarned: xp.xp,
        xpBreakdown: xp.breakdown,
        durationMs: this.result.durationMs,
        opponent: opp.username,
        // The client only ever *displays* these numbers. It never computed them.
        serverValidated: true,
      });
    }
  }

  /* ------------------------------------------------------------- messaging */
  sendTo(slot, obj) {
    const s = this.slots[slot];
    if (s?.socket) send(s.socket, obj);
  }

  broadcast(type, payload) {
    this.sendTo(1, { t: type, ...payload });
    this.sendTo(2, { t: type, ...payload });
  }

  sendToPlayer(playerId, obj) {
    const slot = this.slotOf(playerId);
    if (slot) send(this.slots[slot].socket, obj);
  }
}

export default LiveMatch;
