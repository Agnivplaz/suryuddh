/**
 * /api/leaderboard — THE global leaderboard. One board, ranked by total XP.
 * Deliberately no weekly/monthly split and no per-instrument boards: less UI,
 * and one number that the judges can understand at a glance.
 */
import { Router } from 'express';
import { wrap } from '../middleware.js';
import { dbx, toDbBool } from '../db/index.js';

const r = Router();

export const BOARD_COLUMNS = `
  id, username, total_xp, games_played, wins, losses, draws, created_at, last_seen`;

/** 1-based global rank of a single player (ties share a rank). */
export async function rankOf(playerId) {
  const me = await dbx.one('SELECT total_xp FROM players WHERE id = ?', [playerId]);
  if (!me) return null;
  const row = await dbx.one(
    'SELECT COUNT(*) AS c FROM players WHERE banned = ? AND total_xp > ?',
    [toDbBool(false), me.total_xp],
  );
  return Number(row?.c || 0) + 1;
}

r.get('/', wrap(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const q = String(req.query.q || '').trim().toLowerCase();

  let rows;
  let total;
  if (q) {
    const like = `%${q}%`;
    rows = await dbx.all(
      `SELECT ${BOARD_COLUMNS} FROM players
        WHERE banned = ? AND username_lower LIKE ?
        ORDER BY total_xp DESC, wins DESC, created_at ASC
        LIMIT ? OFFSET ?`,
      [toDbBool(false), like, limit, offset],
    );
    const c = await dbx.one('SELECT COUNT(*) AS c FROM players WHERE banned = ? AND username_lower LIKE ?',
      [toDbBool(false), like]);
    total = Number(c?.c || 0);
  } else {
    rows = await dbx.all(
      `SELECT ${BOARD_COLUMNS} FROM players
        WHERE banned = ?
        ORDER BY total_xp DESC, wins DESC, created_at ASC
        LIMIT ? OFFSET ?`,
      [toDbBool(false), limit, offset],
    );
    const c = await dbx.one('SELECT COUNT(*) AS c FROM players WHERE banned = ?', [toDbBool(false)]);
    total = Number(c?.c || 0);
  }

  const entries = rows.map((row, i) => ({
    rank: offset + i + 1,
    id: row.id,
    username: row.username,
    totalXp: row.total_xp,
    gamesPlayed: row.games_played,
    wins: row.wins,
    losses: row.losses,
    winRate: row.games_played ? +(row.wins / row.games_played * 100).toFixed(1) : 0,
    // never leak more than the board needs
  }));

  // "Where am I?" row — always present for a signed-in player, even at rank 400.
  let you = null;
  if (req.player) {
    const rank = await rankOf(req.player.id);
    you = {
      rank,
      id: req.player.id,
      username: req.player.username,
      totalXp: req.player.total_xp,
      wins: req.player.wins,
      losses: req.player.losses,
      gamesPlayed: req.player.games_played,
      winRate: req.player.games_played ? +(req.player.wins / req.player.games_played * 100).toFixed(1) : 0,
      inTop: entries.some(e => e.id === req.player.id),
    };
  }

  res.json({ leaderboard: entries, total, limit, offset, you });
}));

export default r;
