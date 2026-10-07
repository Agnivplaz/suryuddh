/**
 * Accounts & tokens.
 *
 *  - Passwords: bcrypt (cost 12 in prod), never stored or logged in the clear.
 *  - Access token: short-lived JWT (stateless, verified on every socket message).
 *  - Refresh token: opaque random string, sha256-hashed at rest, rotating.
 *
 * The username is the *public* identity, `players.id` (UUID) is the internal one.
 * No email, no phone, no third-party provider — exactly what was asked for.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from './config.js';
import { dbx } from './db/index.js';

/* ------------------------------------------------------------------ usernames */
const RESERVED_PREFIX = /^system|^admin|^mod/i;

export function validateUsername(raw) {
  const username = String(raw ?? '').trim();
  if (!config.auth.userRe.test(username)) {
    return { ok: false, error: 'Username must be 3–16 characters: letters, numbers, underscore only.' };
  }
  if (config.auth.reserved.has(username.toLowerCase())) {
    return { ok: false, error: 'That username is reserved. Pick another one.' };
  }
  if (RESERVED_PREFIX.test(username)) {
    return { ok: false, error: 'Usernames cannot start with admin, mod or system.' };
  }
  return { ok: true, username };
}

export function validatePassword(raw) {
  const password = String(raw ?? '');
  if (password.length < config.auth.minPassword) {
    return { ok: false, error: `Password must be at least ${config.auth.minPassword} characters.` };
  }
  if (password.length > config.auth.maxPassword) {
    return { ok: false, error: 'Password is too long.' };
  }
  return { ok: true, password };
}

const BANNED_WEAK = new Set(['password', 'password1', '12345678', '123456789', 'qwertyui', 'suryuddh', 'iloveyou']);
export const isWeakPassword = (p) => BANNED_WEAK.has(p.toLowerCase());

/* --------------------------------------------------------------------- rows */
export const publicPlayer = (row) => row && ({
  id: row.id,
  username: row.username,
  total_xp: row.total_xp,
  games_played: row.games_played,
  wins: row.wins,
  losses: row.losses,
  draws: row.draws ?? 0,
  created_at: row.created_at,
  last_seen: row.last_seen,
});

/* --------------------------------------------------------------------- auth */
export async function signUp({ username, password, ip, userAgent }) {
  const u = validateUsername(username);
  if (!u.ok) return u;
  const p = validatePassword(password);
  if (!p.ok) return p;
  if (isWeakPassword(password)) {
    return { ok: false, error: 'That password is too common. Choose something less guessable.' };
  }

  const lower = u.username.toLowerCase();
  const existing = await dbx.one('SELECT id FROM players WHERE username_lower = ?', [lower]);
  if (existing) return { ok: false, error: 'That username is already taken.' };

  const now = Date.now();
  const id = dbx.uuid();
  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);

  try {
    await dbx.run(
      `INSERT INTO players (id, username, username_lower, password_hash, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, u.username, lower, hash, now, now],
    );
  } catch (err) {
    if (/unique|duplicate/i.test(err.message)) return { ok: false, error: 'That username is already taken.' };
    throw err;
  }

  const row = await dbx.one('SELECT * FROM players WHERE id = ?', [id]);
  const tokens = await issueTokens(row, { ip, userAgent });
  return { ok: true, player: publicPlayer(row), ...tokens };
}

export async function logIn({ username, password, ip, userAgent }) {
  const lower = String(username ?? '').trim().toLowerCase();
  const row = await dbx.one('SELECT * FROM players WHERE username_lower = ?', [lower]);
  // Always burn a comparable amount of time so account existence is not leaked
  // through response timing.
  const hash = row ? row.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const good = await bcrypt.compare(String(password ?? ''), hash);
  if (!row || !good) return { ok: false, error: 'Wrong username or password.', code: 'BAD_CREDENTIALS' };
  if (row.banned) return { ok: false, error: 'This account has been suspended.', code: 'BANNED' };

  await dbx.run('UPDATE players SET last_seen = ? WHERE id = ?', [Date.now(), row.id]);
  const tokens = await issueTokens(row, { ip, userAgent });
  return { ok: true, player: publicPlayer(row), ...tokens };
}

async function issueTokens(row, { ip, userAgent } = {}) {
  const accessToken = jwt.sign(
    { sub: row.id, name: row.username, tv: 1 },
    config.auth.secret,
    { expiresIn: config.auth.tokenTtlSec, issuer: 'suryuddh' },
  );
  const refresh = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await dbx.run(
    `INSERT INTO refresh_tokens (token_hash, player_id, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [sha(refresh), row.id, now, now + config.auth.refreshTtlSec * 1000, String(userAgent || '').slice(0, 200)],
  );
  return { accessToken, refreshToken: refresh, expiresIn: config.auth.tokenTtlSec };
}

export async function refreshTokens({ refreshToken, ip, userAgent }) {
  if (!refreshToken) return { ok: false, error: 'Missing refresh token.' };
  const now = Date.now();
  const row = await dbx.one('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha(refreshToken)]);
  if (!row || row.revoked_at || row.expires_at < now) {
    return { ok: false, error: 'Session expired. Please log in again.', code: 'REFRESH_INVALID' };
  }
  // rotate: one use per refresh token
  await dbx.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', [now, row.token_hash]);
  const player = await dbx.one('SELECT * FROM players WHERE id = ?', [row.player_id]);
  if (!player || player.banned) return { ok: false, error: 'Account unavailable.', code: 'BANNED' };
  await dbx.run('UPDATE players SET last_seen = ? WHERE id = ?', [now, player.id]);
  const tokens = await issueTokens(player, { ip, userAgent });
  return { ok: true, player: publicPlayer(player), ...tokens };
}

export async function revokeRefresh(refreshToken) {
  if (!refreshToken) return;
  await dbx.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', [Date.now(), sha(refreshToken)]);
}

/** Verify an access token; returns the DB row or null. */
export async function playerFromToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config.auth.secret, { issuer: 'suryuddh' });
  } catch { return null; }
  const row = await dbx.one('SELECT * FROM players WHERE id = ?', [payload.sub]);
  if (!row || row.banned) return null;
  return row;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export { sha };

/** Housekeeping — drop expired refresh tokens / rooms. */
export async function purgeExpired() {
  const now = Date.now();
  await dbx.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [now - 86_400_000]);
  await dbx.run("UPDATE rooms SET status = 'expired' WHERE status = 'open' AND expires_at < ?", [now]);
}
