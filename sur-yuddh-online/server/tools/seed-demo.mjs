/**
 * Seed demo accounts + matches so the Global Leaderboard is not empty when the
 * judges walk over.
 *
 *   node tools/seed-demo.mjs                  # 8 players, 24 matches
 *   node tools/seed-demo.mjs --players 12 --matches 40
 *   node tools/seed-demo.mjs --clear          # remove them again
 *
 * The seeded rows are REAL rows written through the same code paths the server
 * uses (matches + match_players + xp_audit + players totals), so nothing about
 * the leaderboard is fake — it just saves you waiting for 24 real fights.
 * Every seeded username is prefixed so you can spot/delete them easily.
 */
import bcrypt from 'bcryptjs';
import { openDb, closeDb, dbx } from '../src/db/index.js';
import config from '../src/config.js';
import { grantXp } from '../src/xp.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CLEAR = argv.includes('--clear');
const COUNT = Number(arg('players', 8));
const MATCHES = Number(arg('matches', 24));
const PREFIX = 'demo_';

const NAMES = ['Aarav', 'Ishita', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Vihaan', 'Sanya',
  'Devansh', 'Tara', 'Arjun', 'Nisha', 'Rudra', 'Diya', 'Yash', 'Prisha'];
const INST = ['tabla', 'sitar', 'dhol', 'bansuri', 'harmonium', 'shehnai', 'guitar',
  'trumpet', 'violin', 'djembe', 'veena', 'santoor', 'mridangam', 'cello', 'shankha'];

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function clear() {
  const rows = await dbx.all("SELECT id FROM players WHERE username_lower LIKE ?", [`${PREFIX}%`]);
  for (const r of rows) {
    await dbx.run('DELETE FROM match_players WHERE player_id = ? OR match_id IN (SELECT id FROM matches WHERE winner_id = ? OR loser_id = ?)', [r.id, r.id, r.id]);
    await dbx.run('DELETE FROM matches WHERE winner_id = ? OR loser_id = ?', [r.id, r.id]);
    await dbx.run('DELETE FROM xp_audit WHERE player_id = ?', [r.id]);
    await dbx.run('DELETE FROM players WHERE id = ?', [r.id]);
  }
  console.log(`Removed ${rows.length} demo players and their matches.`);
}

async function main() {
  await openDb();
  if (CLEAR) { await clear(); return; }

  const hash = await bcrypt.hash('demopassword123', config.auth.bcryptRounds);
  const players = [];

  for (let i = 0; i < COUNT; i++) {
    const name = PREFIX + (NAMES[i % NAMES.length]).toLowerCase() + (i >= NAMES.length ? i : '');
    let existing = await dbx.one('SELECT * FROM players WHERE username_lower = ?', [name.toLowerCase()]);
    if (!existing) {
      const id = dbx.uuid();
      const now = Date.now() - rand(3, 30) * 86_400_000;
      await dbx.run(
        `INSERT INTO players (id, username, username_lower, password_hash, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, name.toLowerCase(), hash, now, Date.now() - rand(1, 500) * 60_000],
      );
      existing = await dbx.one('SELECT * FROM players WHERE username_lower = ?', [name.toLowerCase()]);
    }
    players.push(existing);
  }
  console.log(`Accounts ready (${players.length}). Password for all of them: demopassword123`);

  let made = 0;
  for (let n = 0; n < MATCHES; n++) {
    const a = pick(players);
    let b = pick(players);
    let guard = 0;
    while (b.id === a.id && guard++ < 20) b = pick(players);
    if (b.id === a.id) continue;

    const winner = Math.random() < 0.5 ? a : b;
    const loser = winner === a ? b : a;
    const durationMs = rand(25_000, 260_000);
    const startedAt = Date.now() - rand(1, 20 * 24 * 60) * 60_000;
    const id = dbx.uuid();
    const seed = rand(1, 2 ** 30);
    const xpWin = rand(70, 190);
    const xpLose = rand(18, 55);
    const room = Math.random() < 0.35 ? 'DEMO' + rand(10, 99) : null;

    await dbx.run(
      `INSERT INTO matches (id, mode, room_code, status, winner_id, loser_id, win_reason, result_source,
                            validated, seed, duration_ms, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'finished', ?, ?, 'ko', 'both_agree', 1, ?, ?, ?, ?, ?)`,
      [id, room ? 'friendly' : 'ranked_1v1', room, winner.id, loser.id, seed,
        durationMs, startedAt, startedAt + durationMs, startedAt],
    );
    for (const [s, p, outcome, xp] of [[1, winner, 'win', xpWin], [2, loser, 'loss', xpLose]]) {
      await dbx.run(
        `INSERT INTO match_players (match_id, slot, player_id, username, instrument, outcome,
                                    xp_earned, damage_dealt, inputs_count, hp_left)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, s, p.id, p.username, pick(INST), outcome, xp, rand(120, 900), rand(300, 1400), outcome === 'win' ? rand(40, 200) : 0],
      );
    }
    // the same transaction shape the real payout uses
    await dbx.tx(async (tx) => {
      for (const [p, outcome, xp] of [[winner, 'win', xpWin], [loser, 'loss', xpLose]]) {
        await tx.query(
          'UPDATE players SET games_played = games_played + 1, wins = wins + ?, losses = losses + ? WHERE id = ?',
          [outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, p.id],
        );
        await grantXp(tx, { playerId: p.id, matchId: id, delta: xp, reason: outcome === 'win' ? 'ranked_win' : 'ranked_loss' });
      }
    });
    made++;
  }
  console.log(`Created ${made} demo matches.`);

  const board = await dbx.all(
    'SELECT username, total_xp, wins, losses FROM players ORDER BY total_xp DESC LIMIT 10', []);
  console.table(board.map((r, i) => ({ rank: i + 1, player: r.username, xp: r.total_xp, w: r.wins, l: r.losses })));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
