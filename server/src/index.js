/**
 * Sur Yuddh — application entry point.
 *
 *   HTTP  :  REST API  (/api/*)  +  the game itself (static files from ../client)
 *   WS    :  /ws  → realtime hub (matchmaking, rooms, input/snapshot relay)
 *
 * One process, one port, one origin. That means no CORS, no cookie/SameSite
 * headaches, and a single URL you can point your Hostinger domain at.
 */
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import config from './config.js';
import { openDb, closeDb, dbx } from './db/index.js';
import { attachPlayer, errorHandler } from './middleware.js';
import { startSweeper, limit } from './ratelimit.js';
import { purgeExpired } from './auth.js';
import createHub from './realtime/hub.js';

import authRoutes from './routes/auth.js';
import playerRoutes, { me } from './routes/players.js';
import leaderboardRoutes from './routes/leaderboard.js';
import roomRoutes from './routes/rooms.js';

async function main() {
  await openDb();

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  /* ------------------------------- security headers (no external deps) --- */
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    next();
  });

  /* ------------------------------------------------------------------ CORS --
     Same-origin setup (the normal one) sends no Origin header and nothing here
     fires. It exists for split deployments, where the game is on one host
     (e.g. Netlify) and this server is on another — the browser then needs the
     API to say it is allowed. Only origins in ALLOWED_ORIGINS are answered;
     with the list empty, cross-origin requests are refused exactly as before.
     WebSockets are not subject to CORS, so they are not covered here. */
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Headers', 'authorization, content-type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
      res.append('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);   // preflight, not rate-limited
    next();
  });

  /* ------------------------------------------------ per-IP request ceiling */
  app.use('/api', limit({ max: config.limits.httpMax, windowMs: config.limits.httpWindowMs }));
  app.use(attachPlayer);

  /* -------------------------------------------------------------- routes */
  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/api/status', (_req, res) => res.json({ ok: true, hub: hub.stats, serverTime: Date.now() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/me', me);
  app.use('/api/players', playerRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/rooms', roomRoutes);
  app.get('/api/config', (_req, res) => res.json({
    countdownMs: config.match.countdownMs,
    minMatchMs: config.match.minDurationMs,
    xp: config.xp,
    rooms: { codeLength: config.rooms.codeLength },
  }));

  /* ------------------------------------------------------- static game ---- */
  app.use(express.static(config.publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      else res.set('Cache-Control', 'public, max-age=3600');
    },
  }));

  /* ------------------------------------------------------- error handler -- */
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use(errorHandler);

  /* --------------------------------------------------------------- server */
  const server = http.createServer(app);
  const hub = globalThis.__hub = createHub({
    server,
    onStats: (s) => { globalThis.__hubStats = s; },
  });

  const sweep = startSweeper();
  const housekeeping = setInterval(() => purgeExpired().catch(() => {}), 15 * 60_000);
  housekeeping.unref?.();

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`\n  सुर युद्ध  Sur Yuddh — online server`);
    console.log(`  ---------------------------------------------------------`);
    console.log(`  game + API   http://${shown}:${config.port}/`);
    console.log(`  websocket    ws://${shown}:${config.port}/ws`);
    console.log(`  database     ${config.db.client}${config.db.client === 'sqlite' ? ` (${config.db.sqliteFile})` : ''}`);
    console.log(`  environment  ${config.env}`);
    console.log(`  ---------------------------------------------------------\n`);
  });

  /* ------------------------------------------------------- shutdown ------ */
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[server] ${signal} received — shutting down…`);
    clearInterval(sweep); clearInterval(housekeeping);
    try { await hub.close(); } catch {}
    server.close(async () => {
      await closeDb().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
