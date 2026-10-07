/**
 * Extract the game's balance data out of client/index.html into balance.json.
 *
 * Why: the server must know each instrument's stats and cooldowns to run
 * anti-cheat checks (e.g. "you cannot fire atk1 six times per second") and to
 * re-simulate matches later. Keeping ONE source of truth (the game file) avoids
 * the classic bug where the server balance drifts from the game balance.
 *
 *   node tools/extract-balance.mjs ../client/index.html > src/balance.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', '..', 'client', 'index.html');
const html = fs.readFileSync(file, 'utf8');

function grab(re, label) {
  const m = re.exec(html);
  if (!m) throw new Error(`Could not find ${label} in ${file}`);
  return m[1];
}

/* --- TUNE / ELEM / DIFF are plain object literals ------------------------- */
const tuneSrc = grab(/const TUNE\s*=\s*(\{[\s\S]*?\});\n/, 'TUNE');
const DIFF = eval('(' + grab(/const DIFF\s*=\s*(\{[\s\S]*?\});\n/, 'DIFF') + ')');

/* --- INSTRUMENTS is an array literal that references builder functions ---- */
const arrSrc = grab(/const INSTRUMENTS\s*=\s*(\[[\s\S]*?\n\]);\n/, 'INSTRUMENTS');

/**
 * Evaluate the array with every free identifier resolving to a stub, so
 * `build: bTabla` (a 3D model function) becomes a no-op instead of a crash.
 * The data we care about (id, stats, moves, ultRate) is pure JSON-like values.
 */
const scoped = new Proxy({}, {
  has: () => true,
  get: (_, key) => (typeof key === 'string' && key !== 'Symbol(Symbol.unscopables)' ? (() => {}) : undefined),
});
// eslint-disable-next-line no-new-func
const INSTRUMENTS = new Function('__scope', `with(__scope){ return (${arrSrc}); }`)(scoped);

const TUNE = eval('(' + tuneSrc + ')');

const COMBAT_KEYS = [
  'kind', 'type', 'cd', 'dmg', 'delay', 'dur', 'speed', 'size', 'len', 'width', 'range', 'arc',
  'radius', 'count', 'scatter', 'gap', 'n', 'spread', 'homing', 'pierce', 'aoe', 'kb', 'rng',
  'iframe', 'dist', 'taken', 'reflect', 'heal', 'healRate', 'haste', 'status', 'trail', 'leave',
  'start', 'end', 'hit', 'aura', 'stomp', 'swirl', 'reach', 'tick',
];

const out = {
  _source: path.relative(process.cwd(), file),
  _generated: new Date().toISOString(),
  tune: TUNE,
  difficulty: DIFF,
  /** Server-side sanity ceilings, derived from the fastest move in the game. */
  limits: {},
  instruments: INSTRUMENTS.map((it) => {
    const moves = {};
    for (const [slot, m] of Object.entries(it.moves)) {
      const trimmed = {};
      for (const [k, v] of Object.entries(m)) if (COMBAT_KEYS.includes(k)) trimmed[k] = v;
      moves[slot] = trimmed;
    }
    return {
      id: it.id,
      name: it.name,
      el: it.el,
      role: it.role || '',
      ultRate: it.ultRate || 1,
      stats: it.stats,
      moves,
    };
  }),
};

/* --- derive per-slot action ceilings (used to reject impossible inputs) ---- */
const slotCeilings = { atk1: Infinity, atk2: Infinity, def: Infinity, agi: Infinity, ult: Infinity };
for (const it of out.instruments) {
  for (const slot of Object.keys(slotCeilings)) {
    const m = it.moves[slot];
    if (m && typeof m.cd === 'number' && m.cd > 0) {
      // allow a 15% grace for cooldown-reduction buffs (levelCd 0.7, haste, ...)
      slotCeilings[slot] = Math.min(slotCeilings[slot], m.cd * 0.55);
    }
  }
}
// `ult` has no cooldown in the game (it is gated by an energy bar), so give it a
// conservative floor of its own instead of leaving it unbounded.
if (!Number.isFinite(slotCeilings.ult)) slotCeilings.ult = 3.0;
out.limits.minActionIntervalSec = {
  atk1: +slotCeilings.atk1.toFixed(3),
  atk2: +slotCeilings.atk2.toFixed(3),
  def: +slotCeilings.def.toFixed(3),
  agi: +slotCeilings.agi.toFixed(3),
  ult: +slotCeilings.ult.toFixed(3),
};
/** At most one ultimate per N seconds of match time (energy regen ~1.6%/s ⇒ ~60s). */
out.limits.ultsPerMinute = 3;
out.limits.instrumentIds = out.instruments.map(i => i.id);
out.limits.maxStat = out.instruments.reduce((acc, i) => {
  for (const [k, v] of Object.entries(i.stats)) acc[k] = Math.max(acc[k] || 0, v);
  return acc;
}, {});

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
