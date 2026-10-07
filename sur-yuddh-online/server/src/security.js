/**
 * Security event log. Every rejected result, refused input and failed login
 * lands here so a moderator (or you, before the judges walk over) can see what
 * is happening. Also nudges `players.trust_score` down on real violations.
 */
import { dbx } from './db/index.js';

export async function logSecurity({ kind, detail = null, ip = null, playerId = null, trustDelta = 0 }) {
  try {
    await dbx.run(
      'INSERT INTO security_events (player_id, kind, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)',
      [playerId, kind, detail, ip, Date.now()],
    );
    if (playerId && trustDelta) {
      await dbx.run(
        'UPDATE players SET trust_score = MAX(0, MIN(100, trust_score + ?)) WHERE id = ?',
        [trustDelta, playerId],
      );
    }
  } catch (err) {
    console.error('[security] log failed:', err.message);
  }
}

export default { logSecurity };
