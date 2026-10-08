# 01 · Architecture audit of the current Sur Yuddh

> Everything below was read out of the file you attached (`sur-yuddh (1).html`),
> not assumed. Line numbers refer to that file. The untouched original is kept at
> `client/index_offline_backup.html` so you can always diff.

---

## 1. What the project actually is

| Property | Value |
|---|---|
| Files | **One** HTML file, 124,809 bytes, 1,810 lines |
| `<style>` | 1 block, lines 11–178 (~5 KB of hand-written CSS, CSS custom properties for the palette) |
| `<script>` | 1 inline block, lines 241–1808 (**one IIFE**, `'use strict'`, no modules, no build step) |
| External deps | Three.js **r128** from cdnjs + 7 `examples/js` post-processing files from jsDelivr (bloom / EffectComposer). Google Fonts (Mukta, Yatra One) |
| Global surface | exactly one: `window.__sur = {G, INSTRUMENTS, useMove, startMatch, stepGame, Fighter}` (line 1806) |
| Networking | **none** — `grep` for `fetch|XMLHttpRequest|WebSocket|supabase` returns **0 hits** |
| Storage | `localStorage`, one key: `suryuddh_progress_v1` (lines 558–564) |
| Screens | `#select` (the home/menu screen, with the 3D preview) and `#hud` (in-match), plus `#pause` and `#over` modals |
| Game modes | Local 1v1/1v2/1v3 against AI. „Rivals 1/2/3" + „Difficulty easy/normal/hard" + „Graphics std/high" toggles |

It is a genuinely well-built single-page game: no framework, no bundler, 15 procedurally
modelled instruments, a full element wheel, 11 distinct ultimates and a difficulty-tuned AI.
The upgrade work has to respect that — which is why this package is **additive**.

---

## 2. Rendering architecture (Three.js layer)

* `renderer, composer, bloom, grade` created at lines 595–610; a `try/catch` around
  `new T.WebGLRenderer` sets `#nogl` and **returns out of the IIFE** — so on a device with
  WebGL disabled the whole script exits early. (That is why the online UI is a separate
  script: it still loads and can explain what happened.)
* `buildArena()` (line 668) builds pillars, rocks, mist, petals, fireflies; textures are
  **generated at runtime on 2D canvases** (`drawSky`, `makeFloorTex`, `makeWoodTex`,
  `makeMetalTex`) — no image assets at all.
* Every instrument is modelled from primitives (`bTabla`, `bSitar`, … `bShankha`), assembled
  by `makeRig(inst, isPlayer)` (line 764) into `{root, body, legs[2], orbs[], ring, aura,
  marker, mats[], h}`.
* Quality: `setQuality('std'|'high')` toggles bloom + pixel ratio (`Math.min(dpr, 1.5)`),
  `layout()` handles viewport/safe-area and the select-screen camera offset.

**Implication for networking:** the renderer is cleanly separated from the simulation for
*positions* (a `Fighter` is a data object; `sync(dt)` pushes data into the rig), but **not**
for *effects* — see §6.

---

## 3. Storage system (what "XP" is today)

```js
// line 558
const SAVE_KEY='suryuddh_progress_v1';
function loadProgress(){ … JSON.parse(localStorage.getItem(SAVE_KEY)) … }
function saveProgress(){ localStorage.setItem(SAVE_KEY, JSON.stringify(PROGRESS)); }
const PROGRESS = loadProgress();
function getProg(id){ … PROGRESS[id] = {level:1, exp:0} … }
function expNeeded(level){ return level<10?40:(level<20?80:160); }
function grantExp(id, amt){ … while(p.level<30 && p.exp>=expNeeded(p.level)){…p.level++} … }
function milestoneBonus(level){ 30 → {cd:.7,dmg:1.15} · 20 → {cd:.8,dmg:1.10} · 10 → {cd:.9,dmg:1.05} }
function awakenUlt(m){ … multiplies dmg/dur/reach/radius/… by 1.15–1.3 … }
```

Facts that matter a lot for the online upgrade:

1. Progression is **per instrument** (15 records), not per player. There is **no account and
   no global XP** anywhere in the current code — the concept in your brief has to be created.
2Per-instrument levels are **not cosmetic**: level ≥10/20/30 changes cooldowns (−10/−20/−30 %)
   and damage (+5/+10/+15 %), and at 30 the ultimate is replaced by an „Awakened" version.
3. Because it lives in `localStorage`, **anyone can edit it** (DevTools → Application →
   Local Storage → set `level:30`). Offline that only cheats the AI, but if local levels were
   allowed to apply in an online ranked match it would be a one-line cheat for a permanent
   stat advantage.
   → **Decision taken in this upgrade: local levels are ignored in online matches**
   (`startMatch()` now forces `levelCd=1, levelDmg=1, awakened=false` when `G.online` is set),
   and online XP never writes to `localStorage`. The two systems are deliberately kept apart.
4. `saveProgress()` writes on every `grantExp` — synchronous, cheap, fine. It stays as-is for
   offline practice.

---

## 4. Where XP is calculated and saved today

Exactly one place:

```js
// endMatch(win) — line 1591
G.expResult = grantExp(G.player.inst.id, 20);
```

* **20 EXP per finished match, win or lose**, for the instrument you played.
* No match recording: nothing is stored about opponents, duration, wins or losses — only the
  level/exp counters. There is no match history to migrate; the profile page is new data.
* The victory/defeat text is built in `showOver()` (line 1600) from that single result object.

This is the exact spot the online layer hooks: `endMatch()` now branches

```js
if(G.online && window.__mp){ G.expResult=null; window.__mp.onMatchEnd(win); }   // online
else G.expResult = grantExp(G.player.inst.id, 20);                              // practice
```

so the browser reports *what happened* and the server decides *what it is worth*.

---

## 5. Game state, combat and the frame loop

**Global state** — `G` (line 799): `state` (`select|countdown|play|over`), `paused`, `time`,
`fighters[]`, `projs[]`, `zones[]`, `fx[]`, `hz[]` (hazards), `lat[]` (scheduled callbacks),
`player`, `shake`, `cam`, `sel`, `opps`, `diff`, `q` (quality), plus match bookkeeping.

**Loop** — `frame(now)` (line 1740):

```
rAF → dt = min(0.05, now-last)  → timescale for slow-motion → (select ? preview : stepGame)
    → updParticles / updFx / updateScenery / updateCamera / updateLights
    → updateTags / updateHUD → render()
```

* `dt` is **variable** (whatever the display gives) and clamped to 50 ms.
* `later(t, fn)` schedules effects — this is how multi-stage ultimates are scripted.

**stepGame(dt)** (line 1608): countdown → `playerControl()` + `aiUpdate()` for each AI +
energy regen → all fighters `update(dt)` → pairwise body separation → `updProjs` / `updZones`
/ `updHz` / `updLat` → win/lose detection.

**Fighter** (class, line 1287) — the unit that must exist on both machines:

* `input{x,z}` → exponential velocity smoothing → position, arena clamp, facing.
* `cd{atk1,atk2,def,agi}` + `cdMax`, `energy` 0–100 (ult), `buffs[]`, `burn`, `stun`, `slow`,
  `dash` (with i-frames), `invuln`, `lockT`, `dealt`, `sc` (scale), `alive/deadT`.
* `sync(dt)` animates the rig from data — walk bob, leg swing, orb orbit, aura, marker.

**Combat pipeline** — `damage(target, amount, source)` (line 958):

```
element wheel (fire>air>ground>thunder>fire) → ×1.25 / ×0.8
  → target.takenMult() (guards) → hp -= d
  → attacker energy += d×0.5 , target energy += d×0.35   (TUNE.ultDealt / ultTaken)
  → attacker.dealt += d
  → damage number (DOM), hit sound, particles, flash, screen shake
  → reflect (Puri Meend Mirage etc.) → recursion with noRefl
  → hp<=0 → kill()
```

`dmgOf(f, mult) = 14 × (0.6 + str×0.1) × mult × f.dmgMult()` — the whole balance lives in
`TUNE` + each instrument's `stats`/`moves`, which is why the server can re-derive every
cooldown from the same table (see §8).

**Moves** are data, not code: `KINDS{shot|beam|wave|burst|strike|dash|guard|blink}` (line 1080)
and `ULT{...11 types}` (line 1145) dispatch on `move.kind` / `move.type`; `useMove(f, slot)`
(line 1251) is the single gate (cooldown, dash lock, target, energy).

**AI** — `aiUpdate(f, dt)` (line 1378), driven by `DIFF{easy|normal|hard}` = `{err, act:[min,max],
guard, dodge, dmg, lead, avoid}`:

1. re-target every 1.5–3 s, 45 % chance to prefer the human player;
2. strafe: keep a preferred band around `reach(f, atk1) × 0.65–0.75`;
3. avoid the arena rim and hazards (`G.hz`), with a difficulty-scaled dodge probability;
4. act on a timer: ult when energy is full → guard/dodge when `threat(f)` (incoming projectile
   within 11 u and closing) → `atk2` when in range → `atk1` → dash forward when far.

This is the code that becomes **dead weight in online mode**: the opponent's `Fighter` is
constructed with `ai=null` and fed `input` from the network instead, so `aiUpdate` simply
never runs for it. Offline mode keeps using it unchanged.

**Input** — `In{keys,held,pressed,stick}`; `KEYMAP` (line 1418) maps J/Z→atk1, K/X→atk2,
L/C→def, Space/V→agi, U/B/E→ult, T→target-switch. `playerControl(f)` reads it, plus on-screen
ability buttons and a virtual stick for touch.

---

## 6. What had to be separated for networking (and what I did)

| # | Concern | Current shape | What the online layer does |
|---|---|---|---|
| 1 | **Input** | `In` + `playerControl()` write straight into `Fighter.input` | Guest keeps capturing locally, but `useMove()` is intercepted (`f.net` → `window.__mpSendAction`) and inputs are shipped at 30 Hz. The local sim never runs for that fighter. |
| 2 | **Simulation** | `stepGame()` runs everything | Host runs it unmodified. Guest skips `update()`-physics, projectile/zone updates and collision, and instead eases fighters toward snapshots. |
| 3 | **Presentation coupling** | `damage()`, `kill()`, `blast()` call `spawnDN / puff / fxFlash / Snd / hurtFlash` **inline** | Left untouched for now (host-side they are exactly right). The guest re-creates hit/kill feedback from HP deltas in snapshots. Making these event-driven is the Phase-4 refactor (`sim-core.js`). |
| 4 | **Randomness** | `Math.random()` in ~30 places (particles, AI timers, strafe, spawn pool) | Not a problem for host-authoritative play (only one machine simulates). It *is* the blocker for deterministic re-simulation — Phase 4 seeds it. |
| 5 | **Timestep** | variable `dt`, clamped | Same trade-off: fine now, needed for exact replays (Phase 4). |
| 6 | **Progression** | `localStorage`, gives real stats | Split: practice EXP stays local; online XP is server-only; local bonuses disabled online. |
| 7 | **Screens** | `showScreen()` toggles `#select`/`#hud` | New screens are overlays (`#ui .ov`) that never touch that state machine; `window.__uiOpen` stops the game's key handler while they are open. |

Everything is done through **one explicit export list** (`window.__sur = {...}` at the end of
the game script) — the network code cannot reach into game internals by accident.

---

## 7. Risk notes found during the audit

* **Host authority is the weak link.** Whoever runs the simulation could, in principle, lie
  about the fight. The server compensates (it owns match creation, the clock, the activity
  floor, the result cross-check and the XP formula), and Phase 4 removes the last of it by
  re-simulating from the recorded input log. Until then the design is: *"a cheater can waste
  their own time, but cannot mint XP."*
* **`localStorage` levels were a cheat vector** — already neutralised by ignoring them online.
* **The `return` inside the WebGL `catch`** means any JS error during setup kills the whole
  game silently; the online scripts therefore load independently and the UI reports failures
  in plain language.
* **No match history existed**, so there is nothing to migrate — your `profiles`/`matches`
  tables start empty and fill from the first online match.
