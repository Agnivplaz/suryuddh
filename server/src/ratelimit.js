/**
 * In-memory sliding-window rate limiter.
 *
 * Deliberately dependency-free and single-process. If Sur Yuddh ever needs more
 * than one server instance, replace the Map with Redis (one file to change).
 */
const buckets = new Map();   // key -> [timestamps]

export function hit(key, max, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  // drop expired entries
  let i = 0;
  while (i < arr.length && now - arr[i] > windowMs) i++;
  if (i) arr.splice(0, i);
  if (arr.length >= max) return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
  arr.push(now);
  return { ok: true, remaining: max - arr.length };
}

/** Express middleware factory. */
export function limit({ max, windowMs, keyFn }) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const r = hit(key, max, windowMs);
    if (!r.ok) {
      res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
    }
    next();
  };
}

/** Periodic cleanup so the Map cannot grow forever. */
export function startSweeper(intervalMs = 300_000) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of buckets) {
      while (arr.length && now - arr[0] > 3_600_000) arr.shift();
      if (!arr.length) buckets.delete(key);
    }
  }, intervalMs);
  t.unref?.();
  return t;
}

export const stats = () => ({ buckets: buckets.size });
