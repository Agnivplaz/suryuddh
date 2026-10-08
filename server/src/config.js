/**
 * Sur Yuddh — server configuration.
 * Reads optional .env file (no external dependency), exposes a frozen config object.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ----------------------------- tiny .env loader ----------------------------- */
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

/** A dev-only JWT secret. In production we refuse to boot without a real one. */
function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 24) return fromEnv;
  if (IS_PROD) {
    console.error('\n[FATAL] JWT_SECRET is missing or too short. Set it in .env before running in production.');
    console.error('        Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n');
    process.exit(1);
  }
  return 'dev-only-insecure-secret-do-not-ship-' + crypto.createHash('sha1').update(ROOT).digest('hex');
}

export const config = Object.freeze({
  env: NODE_ENV,
  isProd: IS_PROD,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  /* --- database ------------------------------------------------------------
   * DB_CLIENT = 'sqlite'  -> zero-setup single file (local dev / LAN exhibition)
   * DB_CLIENT = 'postgres'-> Supabase / Neon / Railway / self-hosted Postgres
   * ------------------------------------------------------------------------ */
  db: {
    client: (process.env.DB_CLIENT || 'sqlite').toLowerCase(),
    sqliteFile: process.env.DB_SQLITE_FILE || path.join(ROOT, 'data', 'suryuddh.db'),
    url: process.env.DATABASE_URL || '',
    ssl: bool(process.env.DB_SSL, IS_PROD),
    poolMax: num(process.env.DB_POOL_MAX, 10),
  },

  auth: {
    secret: resolveSecret(),
    // Short-lived access token. The client silently refreshes from /api/auth/refresh.
    tokenTtlSec: num(process.env.TOKEN_TTL_SEC, 60 * 60 * 12),
    refreshTtlSec: num(process.env.REFRESH_TTL_SEC, 60 * 60 * 24 * 30),
    bcryptRounds: num(process.env.BCRYPT_ROUNDS, IS_PROD ? 12 : 10),
    minPassword: 8,
    maxPassword: 128,
    userRe: /^[A-Za-z0-9_]{3,16}$/,
    reserved: new Set([
      'admin','administrator','root','system','suryuddh','sur_yuddh','moderator','mod','staff',
      'official','support','help','null','undefined','guest','bot','server','me','you','null_player',
    ]),
  },

  match: {
    /** Minimum wall-clock length (server clock) for a match to be worth XP. */
    minDurationMs: num(process.env.MATCH_MIN_MS, 20_000),
    /** Sanity ceiling — nobody plays a 2 hour duel. */
    maxDurationMs: num(process.env.MATCH_MAX_MS, 30 * 60_000),
    /** Grace window after an opponent drops before the server awards the win. */
    disconnectGraceMs: num(process.env.DISCONNECT_GRACE_MS, 15_000),
    /** How long we wait for the other side's result claim before voiding. */
    resultWaitMs: num(process.env.RESULT_WAIT_MS, 30_000),
    /** Countdown (ms) between "match:start" and the first simulated frame. */
    countdownMs: num(process.env.MATCH_COUNTDOWN_MS, 3000),
    /** Minimum input frames each player must have produced (anti-idle-farm). */
    minInputFrames: num(process.env.MIN_INPUT_FRAMES, 40),
    /** Snapshot rate the server is willing to relay to each guest (Hz). */
    maxSnapHz: num(process.env.MAX_SNAP_HZ, 30),
    /** Input rate the server is willing to relay to each host (Hz). */
    maxInputHz: num(process.env.MAX_INPUT_HZ, 60),
  },

  xp: {
    win: 100,
    loss: 30,
    winByDisconnect: 60,
    lossByDisconnect: 20,
    /** Daily ceiling per account, enforced server-side from the xp_audit ledger. */
    dailyCap: num(process.env.XP_DAILY_CAP, 1500),
    /**
     * Do room-code matches pay leaderboard XP?
     * true  → a class can play each other at the exhibition and everyone climbs the board.
     * false → only Quick Match (ranked_1v1) is ranked; room fights are friendlies.
     */
    rankedRooms: bool(process.env.XP_ROOM_MATCHES, true),
    /** Diminishing returns when you rematch the same person (anti-farm). */
    repeatPenalty30m: 0.5,
    repeatPenalty2h: 0.75,
    /** A match must be at least this long to earn the full base grant. */
    fullDurationMs: 60_000,
    minDurationScale: 0.4,
  },

  rooms: {
    codeLength: 5,
    /** No 0/O/1/I/L — codes get read aloud and typed on phones. */
    codeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
    ttlMs: num(process.env.ROOM_TTL_MS, 2 * 60 * 60_000),
    maxOpenPerPlayer: 3,
  },

  queue: {
    timeoutMs: num(process.env.QUEUE_TIMEOUT_MS, 45_000),
    /**
     * Prefer somebody new, but if two people are the only ones online they must
     * still be allowed to play each other — a rematch after this long waiting
     * beats an empty lobby.
     */
    avoidLastOpponentMs: 5 * 60_000,
    rematchAfterMs: num(process.env.QUEUE_REMATCH_MS, 8_000),
  },

  limits: {
    httpWindowMs: 60_000,
    httpMax: num(process.env.HTTP_MAX_PER_MIN, 300),
    loginWindowMs: num(process.env.LOGIN_WINDOW_MIN, 15) * 60_000,
    loginMax: num(process.env.LOGIN_MAX, 10),
    /**
     * New accounts per IP per hour.
     *
     * IMPORTANT for the exhibition: every visitor on the school WiFi arrives from
     * the SAME public IP, so this is effectively a cap on the whole event. The
     * default of 5 is right for a public server, but raise it (e.g. 60) before a
     * demo where a class signs up together — see docs/05-DEPLOYMENT.md.
     */
    signupPerHour: num(process.env.SIGNUP_PER_HOUR, 5),
    wsMessagesPerSec: 200,
    wsMaxPayloadBytes: 64 * 1024,
  },

  /**
   * Extra browser origins allowed to call the API, comma-separated.
   *
   *   '' (default)             → same-origin only (server serves the game itself)
   *   'https://x.netlify.app'  → the game is hosted elsewhere and calls us
   *
   * Only needed for SPLIT deployments (game on Netlify, server on Render/Fly).
   * See docs/06-NETLIFY.md.
   */
  allowedOrigins: [
    // This project's own Netlify site. Baked in so the split deployment (game on
    // Netlify, server here) works with no configuration at all. Change or remove
    // it if you rename the site, and add extra origins with ALLOWED_ORIGINS.
    'https://suryuddh.netlify.app',
    ...(process.env.ALLOWED_ORIGINS || '')
      .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
  ].filter((o, i, a) => a.indexOf(o) === i),

  publicDir: path.resolve(ROOT, process.env.PUBLIC_DIR || '../client'),
  trustProxy: bool(process.env.TRUST_PROXY, IS_PROD),
});

export default config;
