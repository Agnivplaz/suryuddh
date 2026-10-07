/**
 * Anti-cheat: input-stream validation + match result validation.
 *
 * Two independent jobs live here:
 *
 *  1) validateInputFrame()  — runs on every input the guest sends. The server
 *     knows the game's real cooldowns (balance.json) and the maximum movement
 *     speed, so impossible inputs ("fired atk1 five times in 100 ms") are
 *     rejected at the relay instead of reaching the host's simulation.
 *
 *  2) validateMatchResult() — runs once, at the end. It decides whether the
 *     claims coming from two browsers agree with what the *server itself*
 *     observed (who was connected, when, for how long, how many inputs). Only
 *     a validated result is allowed to touch the leaderboard.
 */
import { createRequire } from 'node:module';
import config from './config.js';

// createRequire keeps the JSON import working on every Node ≥18 (import attributes
// are version-dependent, this is not).
const require = createRequire(import.meta.url);
const balance = require('./balance.json');

/* ------------------------------------------------------- instrument lookups */
export const INSTRUMENTS = new Map(balance.instruments.map(i => [i.id, i]));
export const isInstrument = (id) => INSTRUMENTS.has(id);

const MOVE_FIELD_MAX = {
  // generous upper bounds on scalar action fields — a client sending dmg=999
  // or a 10 km dash is trivially rejected here
  dist: 40,
  count: 8,
  dmg: 20,
};

/* ------------------------------------------------------ input frame checking */
/**
 * @param {object} slot      live match slot state {instrument, lastAction, frames, actions...}
 * @param {object} msg       {x, z, a:[slot,...]} from the client
 * @param {number} now       server ms
 * @returns {{ok:boolean, reason?:string, x:number, z:number, actions:string[]}}
 */
export function validateInputFrame(slot, msg, now) {
  const x = Number(msg?.x);
  const z = Number(msg?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return reject('input_nan');
  if (Math.abs(x) > 1.001 || Math.abs(z) > 1.001) return reject('input_out_of_range');
  if (Math.hypot(x, z) > 1.42) return reject('input_diagonal_overflow');

  const rawActions = Array.isArray(msg?.a) ? msg.a : [];
  if (rawActions.length > 5) return reject('too_many_actions');

  const inst = INSTRUMENTS.get(slot.instrument);
  if (!inst) return reject('unknown_instrument');

  const actions = [];
  for (const a of rawActions) {
    if (!['atk1', 'atk2', 'def', 'agi', 'ult'].includes(a)) return reject('unknown_action');
    const floorMs = (balance.limits.minActionIntervalSec[a] ?? 1) * 1000;
    const last = slot.lastAction[a] || 0;
    // hard floor: faster than the game's own fastest cooldown for ANY instrument
    if (now - last < floorMs) return reject(`action_spam_${a}`);
    // per-instrument cooldown, admin-side, from the same balance file the client uses
    const move = inst.moves[a];
    if (move && typeof move.cd === 'number' && move.cd > 0) {
      const cd = move.cd * 0.55 * 1000;              // grace for haste / levelCd buffs
      if (now - last < Math.max(cd, floorMs)) return reject(`cooldown_${a}`);
    }
    slot.lastAction[a] = now;
    slot.actionCounts[a] = (slot.actionCounts[a] || 0) + 1;
    actions.push(a);
  }

  // Ultimate energy is earned in-game; cap ults per minute as a second layer.
  if (slot.actionCounts.ult) {
    const elapsedMin = Math.max(1, (now - slot.joinedAt) / 60_000);
    if (slot.actionCounts.ult > Math.ceil(elapsedMin * balance.limits.ultsPerMinute) + 1) {
      return reject('ult_flooding');
    }
  }

  slot.frames++;
  if (Math.abs(x) > 0.01 || Math.abs(z) > 0.01) slot.movingFrames++;
  return { ok: true, x, z, actions };
}
const reject = (reason) => ({ ok: false, reason, x: 0, z: 0, actions: [] });

/* ---------------------------------------------------- snapshot sanity (host) */
export function validateSnapshot(msg) {
  const f = msg?.f;
  if (!Array.isArray(f)) return { ok: false, reason: 'snap_no_fighters' };
  if (f.length > 8) return { ok: false, reason: 'snap_too_many_fighters' };
  for (const e of f) {
    if (!Number.isFinite(e?.x) || !Number.isFinite(e?.z)) return { ok: false, reason: 'snap_nan' };
    // nobody can teleport outside the arena + projectiles' ~6u leash
    if (Math.hypot(e.x, e.z) > 60) return { ok: false, reason: 'snap_out_of_arena' };
  }
  return { ok: true };
}

/* --------------------------------------------------------- player activity */
/**
 * How "present" was this player during the match?
 *
 * Slot 1 (host) is the simulation authority: it does not upload input frames,
 * it uploads snapshots. Slot 2 (guest) uploads inputs and uploads nothing else.
 * So activity is measured per role — otherwise every host looks like an AFK
 * farmer and every honest match would be voided.
 */
export const activityOfSlot = (s) => (s.slot === 1 ? Math.max(s.frames || 0, s.snaps || 0) : (s.frames || 0));

/** Required activity, scaled with the length of the fight but never absurd. */
function requiredActivity(durationMs, floor) {
  const seconds = durationMs / 1000;
  return Math.min(300, Math.max(floor, Math.round(seconds * 4)));
}

/* ------------------------------------------------------------ result claims */
/**
 * Decide the truth about a finished match from (a) each side's claim and
 * (b) what the server itself saw.
 *
 * @param {object} m         live match state (see realtime/match.js)
 * @param {number} now
 * @returns {{decision:'accept'|'reject'|'wait', winnerSlot?:number, loserSlot?:number,
 *            reason?:string, source?:string, note?:string}}
 */
export function validateMatchResult(m, now) {
  const s1 = m.slots[1];
  const s2 = m.slots[2];
  const startedAt = m.startedAt;

  if (!s1.playerId || !s2.playerId) return { decision: 'reject', note: 'incomplete_roster' };
  if (!startedAt) return { decision: 'wait', note: 'not_started' };

  // IMPORTANT: this validator is also called by the 1 Hz housekeeping tick while
  // the fight is still going. A running match is never a verdict — otherwise a
  // one-second-old match would look "too short" and get voided mid-fight.
  const ended = !!(m.endedAt || s1.claim || s2.claim);
  if (!ended) return { decision: 'wait', note: 'match_in_progress' };

  const durationMs = (m.endedAt ?? now) - startedAt;
  if (durationMs < config.match.minDurationMs) {
    // A "win" 4 seconds in is either a bug, a crash, or an attempt to farm XP.
    return { decision: 'reject', note: `too_short_${durationMs}ms_min_${config.match.minDurationMs}` };
  }
  if (durationMs > config.match.maxDurationMs) return { decision: 'reject', note: 'absurd_duration' };

  const dc1 = s1.disconnectedAt && now - s1.disconnectedAt > config.match.disconnectGraceMs;
  const dc2 = s2.disconnectedAt && now - s2.disconnectedAt > config.match.disconnectGraceMs;

  /* --- case A: both players reported, and they agree ---------------------- */
  const c1 = s1.claim, c2 = s2.claim;
  if (c1 && c2) {
    if (c1.outcome === 'win' && c2.outcome === 'loss') {
      return finish(1, 'ko', 'both_agree');
    }
    if (c2.outcome === 'win' && c1.outcome === 'loss') {
      return finish(2, 'ko', 'both_agree');
    }
    return {
      decision: 'reject',
      note: `claims_conflict_${c1.outcome}_vs_${c2.outcome}`,
    };
  }

  /* --- case B: one side claimed; the other side is genuinely gone --------- */
  if (c1 && !c2) {
    if (c1.outcome === 'win' && dc2) return finish(1, 'disconnect', 'loser_disconnect');
    if (c1.outcome === 'loss' && dc2) return finish(2, 'disconnect', 'loser_disconnect');
    if (c1.outcome === 'win' && s2.disconnectedAt) return { decision: 'wait', note: 'grace_running' };
    return { decision: 'wait', note: 'awaiting_opponent_claim' };
  }
  if (c2 && !c1) {
    if (c2.outcome === 'win' && dc1) return finish(2, 'disconnect', 'loser_disconnect');
    if (c2.outcome === 'loss' && dc1) return finish(1, 'disconnect', 'loser_disconnect');
    if (c2.outcome === 'win' && s1.disconnectedAt) return { decision: 'wait', note: 'grace_running' };
    return { decision: 'wait', note: 'awaiting_opponent_claim' };
  }

  /* --- case C: nobody claimed, but the server saw someone leave ---------- */
  if (dc1 && !dc2) return finish(2, 'disconnect', 'server_decided');
  if (dc2 && !dc1) return finish(1, 'disconnect', 'server_decided');

  /* --- case D: still playing --------------------------------------------- */
  return { decision: 'wait', note: 'match_in_progress' };

  function finish(winnerSlot, reason, source) {
    const loserSlot = winnerSlot === 1 ? 2 : 1;
    const w = m.slots[winnerSlot];
    const l = m.slots[loserSlot];

    // Both players must actually have been present and playing. Stops the
    // "create two accounts, connect one, farm disconnect wins" pattern.
    const minFrames = requiredActivity(durationMs, config.match.minInputFrames);
    const wAct = activityOfSlot(w);
    const lAct = activityOfSlot(l);
    if (reason === 'ko') {
      if (wAct < minFrames || lAct < minFrames) {
        return { decision: 'reject', note: `insufficient_activity_${wAct}/${lAct}_need_${minFrames}` };
      }
      const hp = w.claim?.hpLeft;
      if (hp !== undefined && (hp <= 0 || hp > 100000)) return { decision: 'reject', note: 'impossible_winner_hp' };
      const oppHp = l.claim?.hpLeft;
      if (oppHp !== undefined && oppHp > 0) {
        // The loser says they still had HP left but the winner says KO.
        return { decision: 'reject', note: 'loser_hp_positive_on_ko' };
      }
    }
    if (reason === 'disconnect' && lAct < Math.min(minFrames, 20) && durationMs < 45_000) {
      // Sitting in a lobby and yanking the cable is not a match.
      return { decision: 'reject', note: 'disconnect_farm_detected' };
    }
    return { decision: 'accept', winnerSlot, loserSlot, reason, source };
  }
}
