/**
 * Operator-only password reset.
 *
 * With no email on an account there is no self-service reset — this is the
 * replacement, and it is why it lives in `tools/` and not behind an endpoint.
 * Run it on the machine that can reach the database:
 *
 *   node tools/reset-password.mjs <username> <new-password>
 *   node tools/reset-password.mjs --list
 *   node tools/reset-password.mjs --ban <username>      (and --unban)
 *
 * Every run is written to security_events so an instructor can see it happened.
 */
import bcrypt from 'bcryptjs';
import { openDb, closeDb, dbx, toDbBool } from '../src/db/index.js';
import config from '../src/config.js';
import { logSecurity } from '../src/security.js';
import { validatePassword, isWeakPassword } from '../src/auth.js';

const args = process.argv.slice(2);
// `--flag` style commands, or "<username> <password>"
const cmd = args[0] && args[0].startsWith('--') ? args[0] : null;
const a = cmd ? args[1] : args[0];
const b = cmd ? args[2] : args[1];

async function main() {
  await openDb();

  if (cmd === '--list') {
    const rows = await dbx.all(
      'SELECT username, total_xp, wins, losses, banned, trust_score FROM players ORDER BY total_xp DESC LIMIT 200', []);
    console.table(rows);
    return;
  }

  if (cmd === '--ban' || cmd === '--unban') {
    if (!a) throw new Error('Usage: --ban <username>');
    const banned = cmd === '--ban';
    const row = await dbx.one('SELECT id FROM players WHERE username_lower = ?', [a.toLowerCase()]);
    if (!row) throw new Error(`No player "${a}"`);
    await dbx.run('UPDATE players SET banned = ? WHERE id = ?', [toDbBool(banned), row.id]);
    await logSecurity({ kind: banned ? 'admin_ban' : 'admin_unban', playerId: row.id, detail: a });
    console.log(`${banned ? 'Banned' : 'Unbanned'} ${a}`);
    return;
  }

  if (!a) {
    console.log(`Usage:
  node tools/reset-password.mjs <username> <new-password>
  node tools/reset-password.mjs --list
  node tools/reset-password.mjs --ban <username>`);
    return;
  }

  const check = validatePassword(b || '');
  if (!check.ok) throw new Error(check.error);
  if (isWeakPassword(b)) throw new Error('That password is on the weak list — pick another.');

  const row = await dbx.one('SELECT id, username FROM players WHERE username_lower = ?', [a.toLowerCase()]);
  if (!row) throw new Error(`No player "${a}"`);

  const hash = await bcrypt.hash(b, config.auth.bcryptRounds);
  await dbx.run('UPDATE players SET password_hash = ? WHERE id = ?', [hash, row.id]);
  await dbx.run('DELETE FROM refresh_tokens WHERE player_id = ?', [row.id]);   // kick old sessions
  await logSecurity({ kind: 'admin_password_reset', playerId: row.id, detail: row.username });
  console.log(`Password updated for ${row.username}. Existing sessions were signed out.`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
