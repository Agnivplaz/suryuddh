#!/usr/bin/env node
/**
 * sql-portability.mjs — catch the bug class that only appears in production.
 *
 * The project runs on two engines: SQLite locally/tests (which stores booleans
 * as 0/1 integers) and PostgreSQL in production (which has a real BOOLEAN type
 * and REFUSES an integer there). Code that works perfectly in the test suite
 * therefore 500s in production:
 *
 *     SELECT ... WHERE banned = 0        → operator does not exist: boolean = integer
 *     UPDATE matches SET validated = 1   → column is of type boolean but expression is of type integer
 *
 * This scans the source for that pattern. Run it before deploying; it is also
 * part of `npm test`.
 *
 *   node tools/sql-portability.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Columns that are BOOLEAN in PostgreSQL (and 0/1 INTEGER in SQLite). */
const BOOLEAN_COLUMNS = ['banned', 'validated', 'disconnected', 'revoked', 'used', 'verified'];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(ROOT);

const problems = [];
const boolSet = BOOLEAN_COLUMNS.join('|');

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const where = `${path.relative(path.resolve(ROOT, '..'), file)}:${i + 1}`;
    // 1. comparing a boolean column to a literal 0/1
    const cmp = line.match(new RegExp(`\\b(${boolSet})\\s*(?:=|!=|<>)\\s*([01])\\b`));
    if (cmp) problems.push([where, `"${cmp[1]} = ${cmp[2]}" compares a boolean column to an integer`, line.trim()]);
    // 2. assigning a boolean column a literal 0/1
    const set = line.match(new RegExp(`\\b(${boolSet})\\s*=\\s*([01])\\b(?!\\s*\\?)`));
    if (set && !/SET\s/i.test(line) === false) problems.push([where, `"${set[1]} = ${set[2]}" writes an integer into a boolean column`, line.trim()]);
    // 3. a ternary that yields 1/0 straight into a boolean column binding
    const tern = line.match(new RegExp(`\\b(${boolSet})\\s*=\\s*\\?[\\s\\S]*\\?\\s*1\\s*:\\s*0`));
    if (tern) problems.push([where, `"${tern[1]} = ?" is bound to a 1/0 ternary — use toDbBool(...)`, line.trim()]);
  });
}

/* the helper must exist and be used wherever a boolean is bound */
const helperSource = fs.readFileSync(path.join(ROOT, '..', 'src', 'db', 'index.js'), 'utf8');
const hasHelper = /export const toDbBool/.test(helperSource);

console.log('\n  SQL portability check (SQLite vs PostgreSQL)\n');
if (!hasHelper) {
  console.log('  FAIL  src/db/index.js must export toDbBool');
  process.exit(1);
}
if (!problems.length) {
  console.log('  PASS  no boolean column is compared to, or written with, an integer literal');
  console.log(`  PASS  toDbBool() is available for boolean parameters`);
  console.log(`  checked ${files.length} source files\n`);
  process.exit(0);
}
console.log(`  FAIL  ${problems.length} problem(s):\n`);
for (const [where, what, line] of problems) {
  console.log(`    ${where}`);
  console.log(`      ${what}`);
  console.log(`      ${line}\n`);
}
console.log('  PostgreSQL rejects integers in BOOLEAN columns. Wrap the value in toDbBool(...)\n');
process.exit(1);
