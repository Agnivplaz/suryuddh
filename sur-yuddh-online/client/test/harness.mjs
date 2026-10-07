/**
 * A tiny "browser" for the client netcode (js/net.js + js/mp.js).
 *
 * It provides just enough of the platform — window, document, localStorage,
 * location, WebSocket, fetch — plus a STUB game that exposes exactly the same
 * window.__sur surface as index.html. That lets the real netcode run in Node
 * against the real server, with no browser required.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '..');
// the test drives a real socket, so it borrows the server's `ws` dependency
const require = createRequire(path.join(CLIENT, '..', 'server', 'package.json'));
const WebSocket = require('ws');
const read = (p) => fs.readFileSync(path.join(CLIENT, p), 'utf8');

const PI = Math.PI, TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const hyp = Math.hypot;
const rand = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------ DOM stubs -- */
function el(id = '') {
  const classList = new Set();
  return {
    id, textContent: '', innerHTML: '', value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }),
    classList: {
      add: (c) => classList.add(c), remove: (c) => classList.delete(c),
      contains: (c) => classList.has(c), toggle: (c, on) => (on ? classList.add(c) : classList.delete(c)),
    },
    _classes: classList,
    appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => el('sub'), querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, focus() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

/* --------------------------------------------------------- THREE-ish stub */
const T = new Proxy({
  Group: class { constructor() { this.children = []; this.position = { x: 0, y: 0, z: 0, set() {} }; this.rotation = { x: 0, y: 0, z: 0 }; this.scale = { setScalar() {}, set() {} }; }
    add(c) { this.children.push(c); } },
}, {
  get(t, k) {
    if (k in t) return t[k];
    // every other THREE class becomes a no-op constructor
    return class { constructor() { this.position = { x: 0, y: 0, z: 0, set() {} }; this.rotation = { x: 0, y: 0, z: 0 }; this.scale = { setScalar() {}, set() {} }; this.children = []; this.material = { color: {}, opacity: 1, dispose() {} }; }
      add(c) { this.children.push(c); } traverse(f) { f(this); } };
  },
});

/* ---------------------------------------------------------------- game -- */
const INSTRUMENTS = [
  { id: 'tabla', name: 'Tabla', el: 'fire', role: 'Drums', ultRate: 1, stats: { spd: 4, rng: 6, str: 9, def: 6 } },
  { id: 'sitar', name: 'Sitar', el: 'thunder', role: 'Strings', ultRate: 1, stats: { spd: 7, rng: 8, str: 7, def: 4 } },
  { id: 'dhol', name: 'Dhol', el: 'ground', role: 'Drums', ultRate: 1, stats: { spd: 5, rng: 5, str: 8, def: 7 } },
];
const ELEM = {
  fire: { name: 'Fire', color: 0xff5a2a, css: '#ff5a2a' },
  thunder: { name: 'Thunder', color: 0xffd83a, css: '#ffd83a' },
  ground: { name: 'Ground', color: 0xc98f45, css: '#c98f45' },
  air: { name: 'Air', color: 0x8fdcf0, css: '#8fdcf0' },
};
const TUNE = { baseDmg: 14, arenaR: 32, charR: 1.15, hpBase: 180, hpPerDef: 14, spdBase: 6, spdPer: 0.75, rngBase: 10.5, rngPer: 3.5 };

export function makeGame(win) {
  const scene = { children: [], add(o) { this.children.push(o); }, remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } };
  const GEO = { sph: {}, ring: {}, circle: {}, box: {} };
  const G = {
    state: 'select', paused: false, time: 0, fighters: [], projs: [], zones: [], fx: [], lat: [],
    player: null, shake: 0, win: false, shown: false, overT: 2, sel: 0, opps: 2, diff: 'normal',
    cdT: 2, lastN: 0, online: null, onlineResult: null, cam: { x: 0, z: 0 }, hz: [],
  };
  const In = { keys: new Set(), held: {}, pressed: {}, stick: { x: 0, y: 0 } };

  class Fighter {
    constructor(inst, o = {}) {
      this.inst = inst; this.isPlayer = !!o.isPlayer;
      this.x = o.x || 0; this.z = o.z || 0; this.vx = 0; this.vz = 0; this.kx = 0; this.kz = 0;
      this.face = o.face || 0;
      this.maxHp = TUNE.hpBase + inst.stats.def * TUNE.hpPerDef; this.hp = this.maxHp;
      this.energy = 0; this.cd = { atk1: 0, atk2: 0, def: 0, agi: 0 }; this.cdMax = { atk1: 1, atk2: 1, def: 1, agi: 1 };
      this.buffs = []; this.burn = null; this.stun = 0; this.slow = null; this.invuln = 0; this.dash = null;
      this.alive = true; this.deadT = 0; this.input = { x: 0, z: 0 }; this.target = null; this.flash = 0;
      this.dealt = 0; this.sc = 1; this.ph = 0; this.pulse = 0; this.ur = 1;
      this.rig = { root: { position: { x: 0, y: 0, z: 0, set() {} }, rotation: { x: 0, y: 0, z: 0, set() {} }, scale: { setScalar() {}, set() {} }, visible: true },
        body: { position: { y: 0, set() {} }, rotation: { x: 0, z: 0 }, scale: { set() {} } },
        legs: [{ rotation: { x: 0 } }, { rotation: { x: 0 } }], orbs: [], ring: { material: { opacity: 1 } },
        aura: { visible: false, material: { color: { setHex() {} }, opacity: 1 }, scale: { setScalar() {} } },
        marker: null, mats: [], h: 2.2 };
      this.tag = { style: {}, firstChild: { textContent: '' }, querySelector: () => ({ textContent: '' }) };
    }
    update(dt) {
      if (this.net && win.netFighterUpdate) return win.netFighterUpdate(this, dt);
      if (!this.alive) { this.deadT += dt; return; }
      const sp = TUNE.spdBase + this.inst.stats.spd * TUNE.spdPer;
      this.x += this.input.x * sp * dt;
      this.z += this.input.z * sp * dt;
      this.sync(dt);
    }
    sync() { this.synced = (this.synced || 0) + 1; }
  }

  function moveVec() {
    let x = (In.keys.has('KeyD') || In.keys.has('ArrowRight') ? 1 : 0) - (In.keys.has('KeyA') || In.keys.has('ArrowLeft') ? 1 : 0);
    let z = (In.keys.has('KeyS') || In.keys.has('ArrowDown') ? 1 : 0) - (In.keys.has('KeyW') || In.keys.has('ArrowUp') ? 1 : 0);
    x += In.stick.x; z += In.stick.y;
    const l = hyp(x, z); if (l > 1) { x /= l; z /= l; }
    return { x, z };
  }

  function useMove(f, slot) {
    if (f && f.net && win.__mpSendAction) return win.__mpSendAction(f, slot);
    if (f.cd[slot] > 0) return false;
    f.cd[slot] = 1.2;
    return true;
  }

  function startMatch() {
    G.state = 'countdown'; G.cdT = 2; G.lastN = 0; G.time = 0; G.fighters = []; G.player = null;
    G.win = false; G.shown = false; G.overT = 2;
    const inst = INSTRUMENTS[G.sel];
    const pl = new Fighter(inst, { isPlayer: true, x: 0, z: 20, face: PI });
    G.player = pl; G.fighters.push(pl);
    pl.levelCd = 1; pl.levelDmg = 1; pl.awakened = false;
    if (G.online && win.__mp) {
      win.__mp.buildOpponent(pl);
    } else {
      const o = new Fighter(INSTRUMENTS[1], { x: 0, z: -20 });
      o.netId = 2; G.fighters.push(o); pl.target = o;
    }
    G.player.target = G.fighters.find((f) => f !== pl) || null;
  }

  let endCalled = false;
  function endMatch(win_) {
    if (endCalled) return;
    endCalled = true;
    G.state = 'over'; G.win = !!win_; G.overT = 0.1; G.shown = false;
    if (G.online && win.__mp) { G.expResult = null; win.__mp.onMatchEnd(!!win_); }
    else G.expResult = { leveled: false };
  }

  function stepGame(dt) {
    G.time += dt;
    const F = G.fighters;
    if (G.state === 'countdown') {
      G.cdT -= dt;
      if (G.cdT <= 0) G.state = 'play';
    }
    // mirrors the patched stepGame() in index.html
    const netGuest = !!(G.online && G.online.role === 'guest');
    const play = G.state === 'play';
    if (play) {
      if (!netGuest) {
        // host: its own player from the local keyboard, the guest from the wire
        const p = G.player;
        if (p && p.alive && !p.net) {
          p.input.x = (In.keys.has('KeyD') ? 1 : 0) - (In.keys.has('KeyA') ? 1 : 0);
          p.input.z = (In.keys.has('KeyS') ? 1 : 0) - (In.keys.has('KeyW') ? 1 : 0);
        }
      }
    } else for (const f of F) { f.input.x = 0; f.input.z = 0; }
    In.pressed = {};
    for (const f of F) f.update(dt);           // net fighters are eased, simmed ones simulated
    if (play) {
      if (!G.player.alive) endMatch(false);
      else if (!F.some((f) => f.netId !== G.player.netId && f.alive)) endMatch(true);
    }
    if (G.state === 'over') { G.overT -= dt; }
  }

  function toMenu() { G.state = 'select'; G.fighters = []; G.player = null; G.online = null; }

  const stub = {
    G, INSTRUMENTS, ELEM, TUNE, In, useMove, startMatch, stepGame, Fighter, toMenu,
    banner() {}, nearestEnemy: () => null, enemiesOf: (f) => G.fighters.filter((x) => x !== f && x.alive),
    moveVec, damage() {}, spawnProj() {}, fxFlash() {}, fxRing() {}, puff() {}, spawnDN() {}, kill() {}, addZone() {},
    Snd: { inst() {}, hit() {}, boom() {}, setMute() {}, init() {}, tone() {} },
    getProg: () => ({ level: 1, exp: 0 }), grantExp: () => ({ leveled: false }), refreshProgressUI() {}, layout() {},
    scene, camera: {}, bmat: () => ({}), glow: () => ({}), GEO, T, PI, TAU, clamp, lerp, hyp, rand,
    __reset: () => { endCalled = false; },
  };
  return stub;
}

/* -------------------------------------------------------------- browser -- */
export function createBrowser({ port, name }) {
  const store = new Map();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = { log: (...a) => console.log(`  [${name}]`, ...a), warn() {}, error: (...a) => console.error(`  [${name}]`, ...a) };
  sandbox.document = {
    getElementById: (id) => (sandbox.__els[id] = sandbox.__els[id] || el(id)),
    querySelectorAll: () => [], querySelector: () => el(),
    createElement: () => el(), addEventListener() {}, body: el('body'),
  };
  sandbox.__els = {};
  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  sandbox.location = { protocol: 'http:', host: `127.0.0.1:${port}`, href: `http://127.0.0.1:${port}/`, search: '' };
  sandbox.navigator = { userAgent: 'netcode-harness' };
  sandbox.WebSocket = WebSocket;
  sandbox.fetch = (url, opts) => fetch(url.startsWith('http') ? url : `http://127.0.0.1:${port}${url}`, opts);
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval; sandbox.clearInterval = clearInterval;
  sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  sandbox.innerWidth = 1280; sandbox.innerHeight = 720;
  sandbox.__uiOpen = false;

  const ctx = vm.createContext(sandbox);
  sandbox.__sur = makeGame(sandbox);
  vm.runInContext(read('js/net.js'), ctx, { filename: 'net.js' });
  vm.runInContext(read('js/mp.js'), ctx, { filename: 'mp.js' });
  sandbox.__ctx = ctx;
  return sandbox;
}

export function loadScripts() { return { net: read('js/net.js'), mp: read('js/mp.js') }; }
