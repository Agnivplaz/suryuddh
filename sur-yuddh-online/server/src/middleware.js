/**
 * HTTP middleware: bearer-token auth + uniform error shape.
 */
import { playerFromToken } from './auth.js';

export async function attachPlayer(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.player = await playerFromToken(token); } catch { /* ignore */ }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.player) return res.status(401).json({ error: 'Not signed in.', code: 'NO_AUTH' });
  next();
}

/** Wrap an async route so thrown errors become 500s instead of unhandled rejections. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[http]', req.method, req.url, '→', err.stack || err.message);
  res.status(status).json({ error: status >= 500 ? 'Server error.' : err.message });
}
