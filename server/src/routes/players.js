/**
 * /api/players — profiles + match history.
 * /api/me      — the signed-in player's own dashboard data.
 */
import { Router } from 'express';
import { publicPlayer } from '../auth.js';
import { requireAuth, wrap } from '../middleware.js';
import { dbx } from '../db/index.js';
import { rankOf } from './leaderboard.js';

const r = Router();

const HISTORY_SQL = `
  SELECT m.id                AS match_id,
         m.mode,
         m.status,
         m.win_reason,
         m.result_source,
         m.validated,
         m.duration_ms,
         m.started_at,
         m.ended_at,
         mp.slot,
         mp.outcome,
         mp.xp_earned,
         mp.instrument,
         mp.damage_dealt,
         mp.hp_left,
         opp.id         AS opponent_id,
         opp.username   AS opponent,
         opmp.instrument AS opponent_instrument,
         opmp.xp_earned  AS opponent_xp
    FROM match_players mp
    JOIN matches m        ON m.id = mp.match_id
    LEFT JOIN match_players opmp ON opmp.match_id = mp.match_id AND opmp.slot <> mp.slot
    LEFT JOIN players opp        ON opp.id = opmp.player_id
   WHERE mp.player_id = ?
   ORDER BY m.started_at DESC
   LIMIT ? OFFSET ?`;

export const fetchHistory = async (playerId, limit = 25, offset = 0) => {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  const off = Math.max(0, Number(offset) || 0);
  const rows = await dbx.all(HISTORY_SQL, [playerId, lim, off]);
  return rows.map(row => ({
    matchId: row.match_id,
    mode: row.mode,
    status: row.status,
    outcome: row.outcome,
    xpEarned: row.xp_earned,
    instrument: row.instrument,
    opponent: row.opponent,
    opponentInstrument: row.opponent_instrument,
    opponentXp: row.opponent_xp,
    slot: row.slot,
    winReason: row.win_reason,
    validated: !!row.validated,
    durationMs: row.duration_ms,
    playedAt: row.started_at,
    endedAt: row.ended_at,
  }));
};

/* ------------------------------------------------------- public profile */
r.get('/:username', wrap(async (req, res) => {
  const lower = String(req.params.username || '').toLowerCase();
  const row = await dbx.one('SELECT * FROM players WHERE username_lower = ?', [lower]);
  if (!row) return res.status(404).json({ error: 'No such player.' });
  const recent = await fetchHistory(row.id, 10, 0);
  const rank = await rankOf(row.id);
  res.json({
    player: {
      ...publicPlayer(row),
      // Never expose password_hash / refresh tokens / trust details to the client.
      winRate: row.games_played ? +(row.wins / row.games_played * 100).toFixed(1) : 0,
      rank,
    },
    recent,
  });
}));

export default r;

/* -------------------------------------------------------------- own data */
export const me = Router();

me.get('/profile', requireAuth, wrap(async (req, res) => {
  const p = req.player;
  const history = await fetchHistory(p.id, 25, 0);
  const rank = await rankOf(p.id);
  const today = await dbx.one(
    'SELECT COALESCE(SUM(delta),0) AS t FROM xp_audit WHERE player_id = ? AND delta > 0 AND created_at >= ?',
    [p.id, Date.now() - 86_400_000],
  );
  res.json({
    player: {
      ...publicPlayer(p),
      winRate: p.games_played ? +(p.wins / p.games_played * 100).toFixed(1) : 0,
      rank,
      xpToday: Number(today?.t || 0),
    },
    history,
  });
}));

me.get('/matches', requireAuth, wrap(async (req, res) => {
  res.json({ matches: await fetchHistory(req.player.id, req.query.limit, req.query.offset) });
}));
