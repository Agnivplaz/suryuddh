/**
 * Database access layer.
 *
 * One tiny async interface over two engines so the same application code runs on:
 *   - SQLite   (better-sqlite3)  → zero-setup local dev, LAN exhibition laptop
 *   - Postgres (pg)             → Supabase / Neon / Railway / self-hosted VPS
 *
 * Everything is async (`await db.query(...)`) so swapping engines never changes
 * call sites. SQL is written with `?` placeholders; the Postgres adapter rewrites
 * them to $1,$2,... (safe here because we never put '?' inside string literals).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const uuid = () => crypto.randomUUID();
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** ---------------------------------------------------------------- SQLite */
async function openSQLite() {
  // imported lazily so a Postgres-only deployment never needs the native module
  const { default: Database } = await import('better-sqlite3');
  const file = config.db.sqliteFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const api = {
    dialect: 'sqlite',
    raw,
    async exec(sql) { raw.exec(sql); },
    async query(sql, params = []) {
      const stmt = raw.prepare(sql);
      if (stmt.reader) return { rows: stmt.all(...params), rowCount: null };
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes };
    },
    /**
     * better-sqlite3 is synchronous, so the awaited body only yields on non-DB
     * awaits. Keep transaction bodies free of network/IO work (we do).
     */
    async transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await fn(api); raw.exec('COMMIT'); return out; }
      catch (err) { try { raw.exec('ROLLBACK'); } catch {} throw err; }
    },
    async close() { raw.close(); },
  };
  return api;
}

/** -------------------------------------------------------------- Postgres */
async function openPostgres() {
  const mod = await import('pg');
  const Pool = mod.default?.Pool || mod.Pool;
  const pool = new Pool({
    connectionString: config.db.url,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    max: config.db.poolMax,
  });

  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const clean = (params) => params.map(p => (p === undefined ? null : p));

  const api = {
    dialect: 'postgres',
    raw: pool,
    async exec(sql) { await pool.query(sql); },
    async query(sql, params = []) {
      const res = await pool.query(toPg(sql), clean(params));
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped = {
          dialect: 'postgres',
          async exec(sql) { await client.query(sql); },
          async query(sql, params = []) {
            const res = await client.query(toPg(sql), clean(params));
            return { rows: res.rows, rowCount: res.rowCount };
          },
        };
        const out = await fn(scoped);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
  return api;
}

/** ------------------------------------------------------------------ open */
let db = null;

export async function openDb() {
  if (db) return db;
  const client = config.db.client;
  if (client === 'postgres' || client === 'pg') {
    if (!config.db.url) throw new Error('DB_CLIENT=postgres requires DATABASE_URL');
    db = await openPostgres();
  } else if (client === 'sqlite') {
    db = await openSQLite();
  } else {
    throw new Error(`Unknown DB_CLIENT "${client}" (use "sqlite" or "postgres")`);
  }
  await migrate(db);
  return db;
}

export const getDb = () => {
  if (!db) throw new Error('Database not opened yet — call openDb() during boot.');
  return db;
};
export const closeDb = async () => { if (db) { await db.close(); db = null; } };

/** Apply the schema (idempotent). */
async function migrate(handle) {
  const file = path.join(HERE, handle.dialect === 'postgres' ? 'schema.postgres.sql' : 'schema.sqlite.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const stmt of statements) {
    try { await handle.exec(stmt); }
    catch (err) {
      if (/already exists/i.test(err.message)) continue;
      throw new Error(`Migration failed on:\n${stmt.slice(0, 220)}\n→ ${err.message}`);
    }
  }
}

/** Helpers used all over the codebase. */
export const dbx = {
  uuid,
  now: () => Date.now(),
  async one(sql, params) {
    const { rows } = await getDb().query(sql, params);
    return rows[0] || null;
  },
  async all(sql, params) {
    const { rows } = await getDb().query(sql, params);
    return rows;
  },
  async run(sql, params) { return getDb().query(sql, params); },
  async tx(fn) { return getDb().transaction(fn); },
};

export default { openDb, getDb, closeDb, dbx };
