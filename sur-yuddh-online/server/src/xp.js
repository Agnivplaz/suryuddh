/**
 * Server-side XP engine.
 *
 * RULE #1 of this project: the client never sends an XP number. It cannot.
 * The browser only ever reports *what happened* (win/loss + reason); the server
 * decides whether to believe it and computes the reward itself:
 *
 *     player → game/server → validate result → calculate XP → database → leaderboard
 *
 * Every grant also lands in the `xp_audit` ledger, so the leaderboard is always
 * reconstructable from an append-only history.
 */
import config from './config.js';
import { dbx } from './db/index.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Pure function: no DB access, so it is trivially unit-testable.
 * @param {object} o
 * @param {'win'|'loss'} o.outcome
 * @param {'ko'|'disconnect'|'timeout'} o.reason
 * @param {number} o.durationMs      server-measured duration
 * @param {number} o.myTotalXp
 * @param {number} o.oppTotalXp
 * @param {number} o.repeatScale     1 | 0.75 | 0.5 (anti-farm, from match history)
 * @param {number} o.dayCapRemaining
 */
export function computeXp(o) {
  const cfg = config.xp;
  const won = o.outcome === 'win';
  const byDisconnect = o.reason === 'disconnect';

  const base = byDisconnect ? (won ? cfg.winByDisconnect : cfg.lossByDisconnect) : (won ? cfg.win : cfg.loss);

  // Long, real fights are worth more than 5-second tap-outs.
  const durationScale = clamp(o.durationMs / cfg.fullDurationMs, cfg.minDurationScale, 1.5);

  // Beating someone far above you on the ladder pays more (and vice versa).
  const opponentScale = clamp(1 + (o.oppTotalXp - o.myTotalXp) / 4000, 0.6, 1.6);

  const repeatScale = clamp(o.repeatScale ?? 1, 0.25, 1);

  const raw = base * durationScale * opponentScale * repeatScale;
  const capped = clamp(Math.round(raw), 5, 400);
  const granted = Math.max(0, Math.min(capped, o.dayCapRemaining ?? Number.MAX_SAFE_INTEGER));

  return {
    xp: granted,
    breakdown: {
      base,
      durationScale: +durationScale.toFixed(3),
      opponentScale: +opponentScale.toFixed(3),
      repeatScale,
      raw: +raw.toFixed(2),
      capped,
      granted,
      trimmedByDailyCap: capped - granted,
    },
  };
}

/** How much XP this player has already earned in the last 24h (server clock). */
export async function xpToday(playerId) {
  const since = Date.now() - 86_400_000;
  const row = await dbx.one(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM xp_audit WHERE player_id = ? AND delta > 0 AND created_at >= ?',
    [playerId, since],
  );
  return Number(row?.total || 0);
}

/**
 * Anti-farm: if these two players have been grinding each other, the reward
 * shrinks. Returns the multiplier only — no writes.
 */
export async function repeatOpponentScale(playerA, playerB, now = Date.now()) {
  const row = await dbx.one(
    `SELECT MAX(m.started_at) AS last_time
       FROM matches m
       JOIN match_players p1 ON p1.match_id = m.id AND p1.player_id = ?
       JOIN match_players p2 ON p2.match_id = m.id AND p2.player_id = ?
      WHERE m.status = 'finished'`,
    [playerA, playerB],
  );
  if (!row?.last_time) return 1;
  const age = now - Number(row.last_time);
  if (age < 30 * 60_000) return config.xp.repeatPenalty30m;
  if (age < 2 * 60 * 60_000) return config.xp.repeatPenalty2h;
  return 1;
}

/**
 * The ONLY place in the codebase that is allowed to change `players.total_xp`.
 * Runs inside a transaction together with the audit row and the match update.
 */
export async function grantXp(tx, { playerId, matchId, delta, reason }) {
  const row = await tx.query('SELECT total_xp FROM players WHERE id = ?', [playerId]);
  const before = Number(row.rows[0]?.total_xp ?? 0);
  const after = before + delta;
  const now = Date.now();

  await tx.query('UPDATE players SET total_xp = ? WHERE id = ?', [after, playerId]);
  await tx.query(
    `INSERT INTO xp_audit (player_id, match_id, delta, reason, xp_before, xp_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [playerId, matchId, delta, reason, before, after, now],
  );
  return { before, after, delta };
}
