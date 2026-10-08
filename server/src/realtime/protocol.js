/**
 * Wire protocol: shapes, limits and validation for every WebSocket message.
 *
 * Transport: raw WebSocket (ws), JSON text frames, one JSON object per frame.
 * Why not Socket.IO: we control both ends, we want the smallest possible
 * dependency surface, and this keeps the "networking layer" readable for a
 * school project — every message is visible in the browser's network tab.
 *
 * Channels:
 *   client → server : auth, ping, queue:*, room:*, match:*, input, snap, result
 *   server → client : hello, auth:*, presence, queue:*, room:*, match:*, peer:*
 */
import config from '../config.js';

export const C2S = new Set([
  'auth', 'ping',
  'queue:join', 'queue:leave',
  'room:create', 'room:join', 'room:leave',
  'match:ready', 'match:resume', 'match:leave', 'match:state',
  'input', 'snap', 'result',
]);

export const S2C = new Set([
  'hello', 'auth:ok', 'auth:error', 'pong', 'presence', 'error',
  'queue:waiting', 'queue:matched', 'queue:timeout', 'queue:cancelled',
  'room:created', 'room:joined', 'room:state', 'room:closed', 'room:error',
  'match:start', 'match:ready:ack', 'match:countdown',
  'peer:input', 'peer:snap', 'peer:left', 'peer:back', 'peer:state',
  'match:result', 'match:void', 'match:over',
]);

/** Per-type payload ceilings (bytes of JSON) — spam and abuse guard. */
export const PAYLOAD_LIMIT = {
  default: 2 * 1024,
  input: 512,
  snap: 32 * 1024,
  result: 2 * 1024,
  auth: 4 * 1024,
};

export function parseMessage(raw, isBinary) {
  if (isBinary) return { ok: false, error: 'binary_not_supported' };
  if (raw.length > config.limits.wsMaxPayloadBytes) return { ok: false, error: 'payload_too_large' };
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); }
  catch { return { ok: false, error: 'bad_json' }; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'bad_message' };
  const type = msg.t;
  if (typeof type !== 'string' || !C2S.has(type)) return { ok: false, error: 'unknown_type' };
  const size = raw.length;
  const limit = PAYLOAD_LIMIT[type] || PAYLOAD_LIMIT.default;
  if (size > limit) return { ok: false, error: 'payload_too_large' };
  return { ok: true, type, msg, size };
}

/** Input frame: {t:'input', s:seq, x,y?, z, a:[slot,...]} → normalised. */
export function normaliseInput(msg) {
  return {
    seq: Number.isFinite(msg.s) ? msg.s : 0,
    x: Number(msg.x) || 0,
    z: Number(msg.z) || 0,
    a: Array.isArray(msg.a) ? msg.a.slice(0, 5) : [],
    c: Array.isArray(msg.c) ? msg.c.slice(0, 4).map(n => Number(n) || 0) : null, // cooldowns (diagnostics)
  };
}

/** Result claim: {t:'result', o:'win'|'loss', hp:number, ohp:number, ms:number, r:'ko'|'disconnect'} */
export function normaliseResult(msg) {
  return {
    outcome: msg.o === 'win' ? 'win' : msg.o === 'loss' ? 'loss' : null,
    hpLeft: Number.isFinite(Number(msg.hp)) ? Math.round(Number(msg.hp)) : null,
    oppHpLeft: Number.isFinite(Number(msg.ohp)) ? Math.round(Number(msg.ohp)) : null,
    clientDurationMs: Number.isFinite(Number(msg.ms)) ? Math.round(Number(msg.ms)) : null,
    reason: msg.r === 'disconnect' ? 'disconnect' : 'ko',
    at: Date.now(),
  };
}

export const send = (ws, obj) => {
  if (ws.readyState === 1) {           // OPEN
    try { ws.send(JSON.stringify(obj)); } catch { /* socket died mid-send */ }
  }
};
