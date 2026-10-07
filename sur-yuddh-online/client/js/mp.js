/* =====================================================================
   Sur Yuddh — online match sync (the "netcode" layer)
   ---------------------------------------------------------------------
   Model: HOST-AUTHORITATIVE SIMULATION, SERVER-ARBITRATED RESULT.

     slot 1 (host)   runs the real game loop (the same code as offline play),
                     applies the opponent's inputs, uploads 20 Hz snapshots.
     slot 2 (guest)  does NOT simulate: it uploads 30 Hz inputs and renders the
                     host's snapshots, with local prediction for its own avatar
                     so the controls still feel direct.
     the server      relays both, counts valid input frames, measures the length
                     of the match on its own clock, and is the ONLY thing that
                     decides the winner and pays XP. See docs/03-SYSTEM-DESIGN.md.

   Everything here is additive: offline play is untouched.
   ===================================================================== */
window.__mp = (function () {
  'use strict';

  const S = window.__sur;                    // game internals (index.html exports these)
  const G = S.G;
  const SYnet = window.SY;

  const SNAP_HZ = 20;                        // host → guest state updates
  const INPUT_HZ = 30;                       // guest → host inputs
  const INTERP = 0.10;                       // guest renders this far in the past (s)

  let role = null;                           // 'host' | 'guest' | null
  let matchId = null;
  let slot = 1;
  let mode = 'ranked_1v1';
  let opponent = { username: '', instrument: '' };
  let startAtLocal = 0;
  let localStart = 0;
  let snapTimer = 0, inputTimer = 0, seq = 0;
  let claimsSent = false;
  const pendingActions = [];                 // guest actions waiting to be uploaded
  const projIds = new WeakMap();             // proj obj → stable id (for the guest's meshes)
  const zoneIds = new WeakMap();
  let projSeq = 0, zoneSeq = 0;
  let netProjs = new Map();                  // id → mesh (guest)
  let netZones = new Map();

  /* ===================================================================
     input capture — the guest's keys/buttons never touch the local sim,
     they are queued and shipped to the host instead.
     =================================================================== */
  const KEYMAP = { KeyJ: 'atk1', KeyZ: 'atk1', KeyK: 'atk2', KeyX: 'atk2', KeyL: 'def', KeyC: 'def', Space: 'agi', KeyV: 'agi', KeyU: 'ult', KeyB: 'ult', KeyE: 'ult' };

  function queueAction(slotName) {
    if (pendingActions.length < 12) pendingActions.push(slotName);
  }
  function drainActions() {
    const a = pendingActions.slice(0, 5);
    pendingActions.length = 0;
    return a;
  }

  window.addEventListener('keydown', (e) => {
    if (!role || role !== 'guest' || window.__uiOpen) return;
    if (e.repeat) return;
    const a = KEYMAP[e.code];
    if (a) { queueAction(a); e.preventDefault(); }
  });

  /**
   * Called by the game whenever an ability is used (keyboard OR the on-screen
   * buttons). For a net-driven fighter we never run it locally — we ask the host.
   */
  window.__mpSendAction = function (fighter, slotName) {
    if (!fighter || !fighter.net) return false;
    if (G.state !== 'play') return false;
    queueAction(slotName);
    fighter.pulse = 1;                       // instant visual feedback
    try { S.Snd.inst(fighter.inst, slotName); } catch (e) {}
    return true;
  };

  /* ===================================================================
     helpers
     =================================================================== */
  const r2 = (v) => Math.round(v * 100) / 100;
  const other = (f) => (G.fighters.find((x) => x !== f) || null);

  function fighterByNetId(id) { return G.fighters.find((f) => f.netId === id) || null; }

  function arenaClamp(f) {
    const d = S.hyp(f.x, f.z), lim = S.TUNE.arenaR - 0.8;
    if (d > lim) { f.x *= lim / d; f.z *= lim / d; }
  }

  /* ===================================================================
     match lifecycle
     =================================================================== */

  /** Server said GO. `payload` is the match:start message. */
  function begin(payload) {
    role = payload.role;
    matchId = payload.matchId;
    slot = payload.slot;
    mode = payload.mode;
    opponent = payload.players[slot === 1 ? 2 : 1];
    claimsSent = false;
    pendingActions.length = 0;
    netProjs.forEach((m) => { S.scene.remove(m); });
    netProjs = new Map();
    netZones = new Map();

    // the server picked our instrument — make the game use it
    const mine = payload.players[slot].instrument;
    const idx = S.INSTRUMENTS.findIndex((i) => i.id === mine);
    if (idx >= 0) G.sel = idx;

    G.online = {
      role, slot, matchId, mode, opponent: opponent.username,
      opponentInstrument: opponent.instrument,
    };
    G.onlineResult = null;
    startAtLocal = SYnet.rt.serverToLocal(payload.startAtTs);
    localStart = Date.now();

    S.startMatch();                          // the normal game start; it branches on G.online

    // lock the countdown to the server's start timestamp
    const left = (startAtLocal - Date.now()) / 1000;
    G.cdT = S.clamp(left, 0.15, 12);

    if (role === 'guest') {
      SYnet.emit('toast', 'You are the guest — the host is running the match.');
    }
  }

  /** Called from the game's startMatch() to build the human opponent. */
  function buildOpponent(pl) {
    const inst = S.INSTRUMENTS.find((i) => i.id === opponent.instrument) || S.INSTRUMENTS[0];
    const isHost = role === 'host';
    const spawnZ = isHost ? -20 : -20;
    pl.x = 0; pl.z = 20; pl.face = S.PI;
    pl.netId = isHost ? 1 : 2;

    const opp = new S.Fighter(inst, { x: 0, z: spawnZ, face: 0 });
    opp.netId = isHost ? 2 : 1;
    opp.username = opponent.username;
    opp.target = pl;
    // authoritative targets start at the spawn point
    for (const f of [pl, opp]) { f.tx = f.x; f.tz = f.z; f.tfa = f.face; f.tvx = 0; f.tvz = 0; }
    if (!isHost) {
      // the guest renders BOTH fighters from snapshots
      opp.net = true;
      pl.net = true;
    } else {
      opp.remoteInput = true;               // host simulates it from the wire
      opp.ai = null;
    }
    // show the player's name on the floating tag
    try {
      opp.tag.firstChild.textContent = opponent.username || inst.name;
      pl.tag.firstChild.textContent = (SYnet.player() && SYnet.player().username) || inst.name;
    } catch (e) {}
    G.fighters.push(opp);
  }

  /** Called from the game's endMatch() — report what happened; never award XP. */
  function onMatchEnd(win) {
    if (!matchId || claimsSent) return;
    claimsSent = true;
    const me = G.player, them = other(me);
    SYnet.rt.send({
      t: 'result',
      o: win ? 'win' : 'loss',
      hp: Math.round(Math.max(0, me.hp)),
      ohp: Math.round(Math.max(0, them ? them.hp : 0)),
      ms: Date.now() - localStart,
      dmg: Math.round(me.dealt || 0),
      r: 'ko',
    });
    SYnet.emit('online:claimed', { win });
  }

  function leave(reason) {
    if (matchId) SYnet.rt.send({ t: 'match:leave', reason: reason || 'menu' });
    role = null; matchId = null;
    G.online = null;
    G.onlineResult = null;
    netProjs.forEach((m) => S.scene.remove(m));
    netProjs = new Map();
    netZones = new Map();
    pendingActions.length = 0;
  }

  function rematch() {
    leave('rematch');
    S.toMenu();
    SYnet.emit('ui:openLobby', { requeue: mode === 'ranked_1v1' });
  }

  /* ===================================================================
     per-frame work
     =================================================================== */
  function tick(dt) {
    if (!matchId) return;

    // keep the countdown pinned to the server's start timestamp
    if (startAtLocal && G.state === 'countdown') {
      const left = (startAtLocal - Date.now()) / 1000;
      G.cdT = Math.max(0.001, Math.min(G.cdT, left + 0.05));
    }

    if (role === 'host') hostTick(dt); else guestTick(dt);
  }

  /* ------------------------------------------------------------- host ---- */
  function hostTick(dt) {
    snapTimer += dt;
    if (snapTimer < 1 / SNAP_HZ) return;
    snapTimer = 0;
    if (G.state !== 'play' && G.state !== 'over') return;
    SYnet.rt.send(snapshot());
  }

  function snapshot() {
    const t = Date.now() - localStart;
    const f = G.fighters.map((x) => ({
      i: x.netId,
      x: r2(x.x), z: r2(x.z), vx: r2(x.vx || 0), vz: r2(x.vz || 0), fa: r2(x.face),
      hp: Math.round(Math.max(0, x.hp)), mx: Math.round(x.maxHp),
      e: Math.round(x.energy), al: x.alive ? 1 : 0, sc: r2(x.sc),
      cd: [r2(Math.max(0, x.cd.atk1)), r2(Math.max(0, x.cd.atk2)), r2(Math.max(0, x.cd.def)), r2(Math.max(0, x.cd.agi))],
      cdm: [r2(x.cdMax.atk1 || 1), r2(x.cdMax.atk2 || 1), r2(x.cdMax.def || 1), r2(x.cdMax.agi || 1)],
      dl: Math.round(x.dealt || 0),
      st: statusFlags(x),
    }));
    const p = G.projs.slice(0, 24).map((pr) => {
      let id = projIds.get(pr);
      if (id === undefined) { id = ++projSeq; projIds.set(pr, id); }
      return { i: id, x: r2(pr.x), z: r2(pr.z), dx: r2(pr.dx), dz: r2(pr.dz), s: pr.size, c: pr.color || S.ELEM[pr.el].color, sh: pr.shape || 'orb' };
    });
    const z = G.zones.slice(0, 12).map((zn) => {
      let id = zoneIds.get(zn);
      if (id === undefined) { id = ++zoneSeq; zoneIds.set(zn, id); }
      return { i: id, x: r2(zn.x), z: r2(zn.z), r: zn.r };
    });
    // Flat payload: {t:'snap', ms, st, win, f, p, z}
    // The server validates `f` directly, and every byte here travels through the
    // relay 20 times a second — so no nesting, no redundant keys.
    return { t: 'snap', ms: t, st: G.state, win: G.win ? 1 : 0, f, p, z };
  }

  function statusFlags(x) {
    let m = 0;
    if (x.dash) m |= 1;
    if (x.stun > 0) m |= 2;
    if (x.burn) m |= 4;
    if (x.slow) m |= 8;
    if (x.buffs.some((b) => b.taken)) m |= 16;
    if (x.buffs.some((b) => b.vis)) m |= 32;
    if (x.invuln > 0) m |= 64;
    return m;
  }

  /* ------------------------------------------------------------ guest ---- */
  function guestTick(dt) {
    inputTimer += dt;
    if (inputTimer >= 1 / INPUT_HZ) {
      inputTimer = 0;
      if (G.state === 'play') {
        const mv = S.moveVec();
        const acts = drainActions();
        if (S.In.held && S.In.held.atk1) acts.push('atk1');   // holding the button keeps firing
        SYnet.rt.send({ t: 'input', s: ++seq, x: r2(mv.x), z: r2(mv.z), a: acts.slice(0, 4) });
      }
    }
  }

  /** A fighter on the guest side: no physics, just authoritative state + easing. */
  window.netFighterUpdate = function netFighterUpdate(f, dt) {
    const rig = f.rig;

    if (!f.alive) {
      f.deadT += dt;
      const k = S.clamp(f.deadT / 0.7, 0, 1);
      rig.root.scale.setScalar(Math.max(0.001, 1 - k));
      rig.root.rotation.z = k * 1.4;
      rig.root.position.y = k * 1.2;
      if (k >= 1) rig.root.visible = false;
      return;
    }

    // local prediction for my own avatar so the controls feel immediate
    if (f.isPlayer && G.state === 'play') {
      const mv = S.moveVec();
      const sp = (S.TUNE.spdBase + f.inst.stats.spd * S.TUNE.spdPer) * (Number.isFinite(f._spMult) ? f._spMult : 1);
      f.x += mv.x * sp * dt;
      f.z += mv.z * sp * dt;
      f.vx = mv.x * sp; f.vz = mv.z * sp;
      arenaClamp(f);
    }

    // ease toward the authoritative position; snap if we drifted badly.
    // (before the first snapshot arrives there is nothing to ease toward)
    if (Number.isFinite(f.tx) && Number.isFinite(f.tz)) {
      const k = Math.min(1, dt * 4.5);
      f.x += (f.tx - f.x) * k;
      f.z += (f.tz - f.z) * k;
      if (S.hyp(f.x - f.tx, f.z - f.tz) > 7) { f.x = f.tx; f.z = f.tz; }
    }
    if (Number.isFinite(f.tfa)) {
      let d = f.tfa - f.face;
      while (d > S.PI) d -= S.TAU;
      while (d < -S.PI) d += S.TAU;
      f.face += d * Math.min(1, dt * 12);
    }
    if (!f.isPlayer) { f.vx = f.tvx; f.vz = f.tvz; }

    // cooldown ticks down locally too (smoothed, for the HUD rings)
    for (const key in f.cd) if (f.cd[key] > 0) f.cd[key] = Math.max(0, f.cd[key] - dt);

    f.pulse = Math.max(0, (f.pulse || 0) - dt * 5);
    f.sync(dt);
  };

  /** Apply one host snapshot (guest side). */
  function applySnapshot(s) {
    if (!s || !Array.isArray(s.f)) return;
    if (G.state === 'countdown' && s.st === 'play') G.state = 'play';
    if (s.ms !== undefined) lastSnapT = s.ms;

    for (const fd of s.f) {
      const f = fighterByNetId(fd.i);
      if (!f) continue;

      // --- health / energy / presentation ---------------------------------
      const prevHp = f.hp;
      if (fd.hp < prevHp - 0.5) fxLocalHit(f, prevHp - fd.hp);
      f.hp = fd.hp;
      if (fd.mx) f.maxHp = fd.mx;
      f.energy = fd.e;
      f._netCd = fd.cd;
      f._netCdMax = fd.cdm;
      f.cd.atk1 = fd.cd[0]; f.cd.atk2 = fd.cd[1]; f.cd.def = fd.cd[2]; f.cd.agi = fd.cd[3];
      if (fd.cdm) { f.cdMax.atk1 = fd.cdm[0]; f.cdMax.atk2 = fd.cdm[1]; f.cdMax.def = fd.cdm[2]; f.cdMax.agi = fd.cdm[3]; }
      f.dealt = fd.dl;
      f._spMult = (fd.st & 8) ? 0.55 : ((fd.st & 32) ? 1.5 : 1);

      // --- death ----------------------------------------------------------
      const wasAlive = f.alive;
      f.alive = !!fd.al;
      if (wasAlive && !f.alive) fxLocalKill(f);
      if (!f.alive && fd.al) f.deadT = 0;

      // --- transform (targets for the easing in netFighterUpdate) ---------
      if (f.tx === undefined) { f.x = fd.x; f.z = fd.z; f.face = fd.fa; }
      f.tx = fd.x; f.tz = fd.z; f.tfa = fd.fa; f.tvx = fd.vx; f.tvz = fd.vz;

      // --- status visuals --------------------------------------------------
      f.flash = (fd.st & 64) ? 0.15 : f.flash;
      syncStatusVisual(f, fd.st);
    }

    // --- projectiles ------------------------------------------------------
    const seen = new Set();
    for (const p of s.p || []) {
      seen.add(p.i);
      let mesh = netProjs.get(p.i);
      if (!mesh) {
        mesh = makeProjMesh(p);
        netProjs.set(p.i, mesh);
        S.scene.add(mesh);
      }
      mesh.position.x = p.x; mesh.position.z = p.z;
      mesh.rotation.y = Math.atan2(p.dx, p.dz);
    }
    for (const [id, mesh] of netProjs) {
      if (!seen.has(id)) { S.scene.remove(mesh); netProjs.delete(id); }
    }

    // --- ground zones -----------------------------------------------------
    const zseen = new Set();
    for (const zn of s.z || []) {
      zseen.add(zn.i);
      let mesh = netZones.get(zn.i);
      if (!mesh) {
        mesh = new S.T.Mesh(S.GEO.circle, S.bmat(0xffffff, 0.22));
        mesh.rotation.x = -S.PI / 2;
        mesh.position.y = 0.08;
        S.scene.add(mesh);
        netZones.set(zn.i, mesh);
      }
      mesh.position.x = zn.x; mesh.position.z = zn.z;
      mesh.scale.set(zn.r, zn.r, 1);
    }
    for (const [id, mesh] of netZones) {
      if (!zseen.has(id)) { S.scene.remove(mesh); netZones.delete(id); }
    }

    // --- end of match -----------------------------------------------------
    if (s.st === 'over' && G.state === 'play') {
      // let the normal end-of-match flow run; it will claim the result
      G.state = 'play';
    }
  }

  let lastSnapT = 0;

  function syncStatusVisual(f, st) {
    // reuse the game's own aura for "buff visible" so the look matches offline
    const rig = f.rig;
    if (!rig || !rig.aura) return;
    if (st & 32) { rig.aura.visible = true; rig.aura.material.opacity = 0.18; }
    else if (rig.aura.visible && !(st & 16)) rig.aura.visible = false;
  }

  /* ---------------------------------------------- guest-side eye candy ---- */
  function fxLocalHit(f, dmg) {
    const d = Math.min(60, dmg);
    try {
      S.spawnDN(f.x + S.rand(-0.5, 0.5), f.rig.h + 1.6, f.z, Math.round(d), '#ffd08a');
      S.puff(f.x, 1.6, f.z, 0xffffff, 5, 5, 0.2, 0.3, 6, 4);
      S.fxFlash(f.x, 1.6, f.z, 2.4, 0xffffff, 0.13);
      S.Snd.hit(d);
      if (f.isPlayer) { G.shake = Math.max(G.shake, S.clamp(d / 70, 0.12, 0.6)); }
    } catch (e) {}
  }

  function fxLocalKill(f) {
    try {
      S.puff(f.x, 1.5, f.z, S.ELEM[f.inst.el].color, 24, 11, 0.32, 0.9, 8, 6);
      S.fxRing(f.x, f.z, 1, 8, 0.6, S.ELEM[f.inst.el].color);
      S.Snd.boom(0.8);
      G.shake = Math.max(G.shake, 0.6);
      if (f.tag) f.tag.style.display = 'none';
    } catch (e) {}
  }

  function makeProjMesh(p) {
    const g = new S.T.Group();
    const col = p.c;
    const s = p.s;
    if (p.sh === 'dart') {
      const c = new S.T.Mesh(new S.T.ConeGeometry(s * 0.7, s * 4, 8), S.bmat(col, 0.95));
      c.rotation.x = S.PI / 2; g.add(c);
    } else if (p.sh === 'disc') {
      const t = new S.T.Mesh(new S.T.TorusGeometry(s, s * 0.12, 6, 20), S.bmat(col, 0.9));
      t.rotation.x = -1.0; g.add(t);
    } else {
      const c = new S.T.Mesh(S.GEO.sph, S.bmat(0xffffff, 1)); c.scale.setScalar(s * 0.55); g.add(c);
      const o = new S.T.Mesh(S.GEO.sph, S.bmat(col, 0.5)); o.scale.setScalar(s); g.add(o);
    }
    g.add(S.glow(col, s * 5 + 1, 0.6));
    g.position.y = 1.4;
    return g;
  }

  /* ===================================================================
     socket wiring
     =================================================================== */
  SYnet.on('match:start', (msg) => {
    // ignore our own echo of match:state requests
    if (matchId === msg.matchId && role) return;
    begin(msg);
  });

  SYnet.on('peer:input', (msg) => {
    if (role !== 'host') return;
    const f = G.fighters.find((x) => x.netId === 2);
    if (!f || !f.alive) return;
    f.input.x = msg.x;
    f.input.z = msg.z;
    for (const a of msg.a || []) {
      try { S.useMove(f, a); } catch (e) {}
    }
  });

  SYnet.on('peer:snap', (msg) => {
    if (role !== 'guest') return;
    const snap = msg.d || msg;                 // relayed payload lives in .d
    applySnapshot(snap.s && snap.s.f ? snap.s : snap);
  });

  SYnet.on('match:result', (msg) => {
    if (msg.matchId !== matchId) return;
    G.onlineResult = msg;
    G.win = msg.outcome === 'win';
    // correct the local screen if the server disagrees with what we guessed
    const title = document.getElementById('overTitle');
    const txt = document.getElementById('overTxt');
    if (title) title.textContent = G.win ? 'Victory' : 'Defeated';
    if (txt && G.online) {
      const secs = Math.floor((msg.durationMs || 0) / 1000);
      txt.textContent = 'Match time ' + Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2)
        + '. ' + (msg.opponent ? 'Opponent ' + msg.opponent + '. ' : '');
    }
    const xpBox = document.getElementById('overXp');
    if (xpBox) {
      xpBox.classList.add('on');
      xpBox.innerHTML = '<b>+' + (msg.xpEarned | 0) + ' XP</b> <span>verified by the server · '
        + (msg.reason === 'disconnect' ? 'opponent disconnected' : 'knockout') + '</span>';
    }
    const over = document.getElementById('over');
    if (over && !over.classList.contains('on') && !G.shown) {
      G.overT = 0.2;                       // let showOver() render the panel
    }
    SYnet.emit('toast', (G.win ? 'Victory' : 'Defeat') + ' — +' + (msg.xpEarned | 0) + ' XP (server verified)');
    SYnet.emit('profile:stale', {});
    claimsSent = true;
  });

  SYnet.on('match:void', (msg) => {
    if (msg.matchId && msg.matchId !== matchId) return;
    SYnet.emit('toast', 'Match not counted: ' + (msg.reason || 'rejected by the server'));
    G.onlineResult = { serverValidated: false, xpEarned: 0 };
    claimsSent = true;
  });

  SYnet.on('peer:left', (msg) => {
    SYnet.emit('toast', 'Opponent left the match…');
    try { S.banner('Opponent disconnected', 2200, 'The server is checking the result'); } catch (e) {}
    // The server awards this on its own after the grace window; sending a claim
    // just makes it instant — and it is validated against the server's own socket log.
    if (matchId && !claimsSent) {
      setTimeout(() => {
        if (!claimsSent && matchId) {
          claimsSent = true;
          SYnet.rt.send({ t: 'result', o: 'win', hp: Math.round(Math.max(0, G.player.hp)), ohp: 0, ms: Date.now() - localStart, r: 'disconnect' });
        }
      }, 400);
    }
  });

  SYnet.on('peer:back', () => SYnet.emit('toast', 'Opponent reconnected'));

  SYnet.on('rt:state', (e) => {
    if (e.state === 'closed' && matchId) {
      SYnet.emit('toast', 'Connection lost — trying to reconnect…');
    }
  });

  /* ===================================================================
     public API
     =================================================================== */
  return {
    isOnline: () => !!role,
    role: () => role,
    matchId: () => matchId,
    begin, buildOpponent, tick, onMatchEnd, leave, rematch,
    actionHook: true,
  };
})();
