/**
 * /api/auth — username + password only. No email, ever.
 */
import { Router } from 'express';
import config from '../config.js';
import { signUp, logIn, refreshTokens, revokeRefresh, publicPlayer } from '../auth.js';
import { requireAuth, wrap } from '../middleware.js';
import { limit, hit } from '../ratelimit.js';
import { dbx } from '../db/index.js';
import { logSecurity } from '../security.js';

const r = Router();

const loginLimiter = limit({
  max: config.limits.loginMax,
  windowMs: config.limits.loginWindowMs,
  keyFn: (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase()}`,
});

/* --------------------------------------------------------------- sign up */
r.post('/signup', wrap(async (req, res) => {
  const gate = hit(`signup:${req.ip}`, config.limits.signupPerHour, 3_600_000);
  if (!gate.ok) return res.status(429).json({ error: 'Too many accounts created from here. Try again later.' });

  const { username, password } = req.body || {};
  const out = await signUp({ username, password, ip: req.ip, userAgent: req.get('user-agent') });
  if (!out.ok) {
    if (out.error) await logSecurity({ kind: 'signup_failed', detail: out.error, ip: req.ip });
    return res.status(400).json({ error: out.error });
  }
  await logSecurity({ kind: 'signup', playerId: out.player.id, ip: req.ip });
  res.json(out);
}));

/* ----------------------------------------------------------------- login */
r.post('/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const out = await logIn({ username, password, ip: req.ip, userAgent: req.get('user-agent') });
  if (!out.ok) {
    await logSecurity({ kind: 'login_failed', detail: out.code || 'BAD', ip: req.ip, playerId: null });
    return res.status(out.code === 'BANNED' ? 403 : 401).json({ error: out.error, code: out.code });
  }
  res.json(out);
}));

/* --------------------------------------------------------------- refresh */
r.post('/refresh', wrap(async (req, res) => {
  const { refreshToken } = req.body || {};
  const out = await refreshTokens({ refreshToken, ip: req.ip, userAgent: req.get('user-agent') });
  if (!out.ok) return res.status(401).json({ error: out.error, code: out.code });
  res.json(out);
}));

/* ---------------------------------------------------------------- logout */
r.post('/logout', wrap(async (req, res) => {
  await revokeRefresh(req.body?.refreshToken);
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------- me */
r.get('/me', requireAuth, wrap(async (req, res) => {
  await dbx.run('UPDATE players SET last_seen = ? WHERE id = ?', [Date.now(), req.player.id]);
  res.json({ player: publicPlayer(req.player) });
}));

export default r;
