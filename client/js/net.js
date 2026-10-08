/* =====================================================================
   Sur Yuddh — networking layer (browser side)
   ---------------------------------------------------------------------
   One place that knows how to talk to the server:

     • REST   /api/auth, /api/me, /api/players, /api/leaderboard, /api/rooms
     • WS     /ws   (matchmaking, rooms, inputs, snapshots)

   Notes
     • Access token lives in memory + localStorage; it is refreshed silently.
     • Every socket message is a small JSON object with a `t` field.
     • Server clock offset is measured so both players can start a fight at the
       same instant even if their laptops' clocks disagree.
   ===================================================================== */
window.SY = (function () {
  'use strict';

  const SESSION_KEY = 'suryuddh_session_v1';
  const RECONNECT_MS = [800, 1600, 3000, 5000, 8000, 12000];

  /* ------------------------------------------------- where is the server? --
     Default: same origin (the Node server serves the game AND the API, which
     is the recommended setup — no CORS, one URL, one certificate).

     Split deployment (e.g. the game on Netlify, the match server on Render /
     Fly.io): set window.__SY_SERVER__ before this file loads. One line in
     index.html, or a small server-url.js — see docs/06-NETLIFY.md.

         window.__SY_SERVER__ = 'https://sur-yuddh.onrender.com';
  */
  let SERVER = (() => {
    const raw = (typeof window !== 'undefined' && window.__SY_SERVER__) || '';
    return String(raw).trim().replace(/\/+$/, '');   // '' → same origin
  })();
  let API = SERVER;                                 // REST base
  let WS_URL = '';

  function computeUrls() {
    API = SERVER;
    WS_URL = SERVER
      ? SERVER.replace(/^http/, 'ws') + '/ws'       // https:// → wss://
      : (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  }
  computeUrls();

  /* --------------------------------------------------------------------------
     The server address can also live in `config.json`, next to this file:

         { "server": "https://sur-yuddh.onrender.com" }

     That file exists so that putting the game on a static host (Netlify, GitHub
     Pages) never means editing JavaScript or HTML — you change one JSON string,
     and you cannot accidentally break the page. Precedence:

       1. window.__SY_SERVER__   (set in index.html, wins if present)
       2. config.json  → "server"
       3. same origin            (the Node server serving this very page)

     Resolution happens once, lazily, on the first API call or socket connect.
  -------------------------------------------------------------------------- */
  let serverReady = null;

  function resolveServer() {
    if (serverReady) return serverReady;
    serverReady = (async () => {
      if (SERVER) return SERVER;
      try {
        const res = await fetch('config.json', { cache: 'no-store' });
        if (res.ok) {
          const cfg = await res.json();
          const raw = cfg && typeof cfg.server === 'string' ? cfg.server : '';
          const clean = raw.trim().replace(/\/+$/, '');
          if (clean) { SERVER = clean; computeUrls(); }
        }
      } catch (e) { /* no config.json, or offline: stay same-origin */ }
      try {
        console.log('[Sur Yuddh] match server: ' + (SERVER || 'same origin (' + location.origin + ')'));
      } catch (e) {}
      return SERVER;
    })();
    return serverReady;
  }

  /* ------------------------------------------------------------- session */
  const session = {
    accessToken: null,
    refreshToken: null,
    player: null,
    load() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') {
          this.accessToken = typeof d.accessToken === 'string' ? d.accessToken : null;
          this.refreshToken = typeof d.refreshToken === 'string' ? d.refreshToken : null;
          this.player = d.player && typeof d.player === 'object' ? d.player : null;
        }
      } catch (e) { /* corrupted storage: start fresh */ }
    },
    save() {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
          accessToken: this.accessToken, refreshToken: this.refreshToken, player: this.player,
        }));
      } catch (e) { /* private mode */ }
    },
    clear() {
      this.accessToken = this.refreshToken = this.player = null;
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    },
    get signedIn() { return !!(this.accessToken && this.player); },
  };
  session.load();

  /* ----------------------------------------------------------- REST ------- */
  let refreshing = null;
  let warnedNoServer = false;

  /**
   * Diagnostics for a bare "HTTP 404".
   *
   * If the page is on a static host (Netlify, GitHub Pages, a plain web host)
   * and no server URL was configured, every call to /api/* is answered by that
   * host's 404 page: the body is HTML, so there is no `error` field, and the
   * user just sees "HTTP 404". That is a configuration problem, not a server
   * failure, so it deserves a sentence rather than a status code.
   */
  function looksLikeStaticHost404(res, json) {
    return res.status === 404 && !SERVER && (!json || typeof json.error !== 'string');
  }

  const MISSING_SERVER_HINT =
    "This page is not being served by the Sur Yuddh server, so /api/* returned 404. "
    + "Tell the game where your server is: open client/config.json and put its address in "
    + '"server" (docs/06-NETLIFY.md, Part 2) - or simply open your server URL directly, '
    + "where the game and the API share one origin.";


  async function api(path, { method = 'GET', body, auth = true } = {}) {
    await resolveServer();
    const headers = { 'content-type': 'application/json' };
    if (auth && session.accessToken) headers.authorization = 'Bearer ' + session.accessToken;
    const res = await fetch(API + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (res.status === 401 && auth && session.refreshToken && !path.startsWith('/api/auth/refresh')) {
      const ok = await tryRefresh();
      if (ok) return api(path, { method, body, auth });
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = json && json.code;
      if (looksLikeStaticHost404(res, json)) {
        err.hint = MISSING_SERVER_HINT;
        if (!warnedNoServer) {
          warnedNoServer = true;
          console.warn(
            '%c[Sur Yuddh] %c' + MISSING_SERVER_HINT + '\n\n'
            + '  The page is being served by:  ' + location.origin + '\n'
            + '  Configured match server:      (none)\n\n'
            + '  Fix, in the deployed copy of client/config.json:\n'
            + '      { "server": "https://your-server.example" }\n\n'
            + '  Then reload and run:  await SY.diagnose()',
            'color:#e0b64a;font-weight:bold', 'color:inherit',
          );
          emit('server:missing', { path, origin: location.origin });
        }
      }
      throw err;
    }
    return json;
  }

  async function tryRefresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const out = await api('/api/auth/refresh', {
          method: 'POST', body: { refreshToken: session.refreshToken }, auth: false,
        });
        adopt(out);
        return true;
      } catch (e) {
        session.clear();
        emit('session:lost', {});
        return false;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function adopt(out) {
    session.accessToken = out.accessToken;
    session.refreshToken = out.refreshToken;
    session.player = out.player;
    session.save();
    emit('session', { player: session.player });
  }

  /* -------------------------------------------------------- WS client ---- */
  const listeners = {};                            // type -> [fn]
  const rt = {
    ws: null,
    state: 'idle',                                 // idle | connecting | open | closed
    attempts: 0,
    serverOffset: 0,                               // serverNow - localNow (ms)
    rtt: 0,
    lastPongAt: 0,
    _pingTimer: null,
    _seq: 0,

    connect() {
      if (!session.signedIn) return;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      resolveServer().then(() => this.openSocket()).catch(() => {});
    },

    openSocket() {
      if (!session.signedIn) return;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      this.state = 'connecting';
      emit('rt:state', { state: this.state });

      let ws;
      try { ws = new WebSocket(WS_URL); }
      catch (e) { this.scheduleReconnect(); return; }
      this.ws = ws;

      ws.onopen = () => {
        this.state = 'open';
        this.attempts = 0;
        emit('rt:state', { state: 'open' });
        this.send({ t: 'auth', token: session.accessToken });
        this._pingTimer = setInterval(() => {
          this.send({ t: 'ping', c: Date.now() });
        }, 4000);
        this.send({ t: 'ping', c: Date.now() });
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.t === 'pong') {
          const rtt = Date.now() - msg.c;
          this.rtt = rtt;
          this.lastPongAt = Date.now();
          if (Number.isFinite(msg.serverTime)) {
            // assume symmetric latency: server time was measured ~rtt/2 ago
            this.serverOffset = msg.serverTime + rtt / 2 - Date.now();
          }
        }
        if (msg.t === 'hello' && Number.isFinite(msg.serverTime)) {
          this.serverOffset = msg.serverTime + (this.rtt ? this.rtt / 2 : 0) - Date.now();
        }
        if (msg.t === 'auth:error') {
          // token expired while we were away → refresh and try again
          tryRefresh().then((ok) => { if (ok) { this.ws = null; this.connect(); } });
          return;
        }
        if (msg.t === 'auth:ok' && msg.player) {
          session.player = msg.player;
          session.save();
          emit('session', { player: session.player });
        }
        emit(msg.t, msg);
        emit('*', msg);
      };

      ws.onclose = () => {
        this.state = 'closed';
        clearInterval(this._pingTimer);
        emit('rt:state', { state: 'closed' });
        this.scheduleReconnect();
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    },

    scheduleReconnect() {
      if (!session.signedIn) return;
      const wait = RECONNECT_MS[Math.min(this.attempts++, RECONNECT_MS.length - 1)];
      setTimeout(() => { if (session.signedIn && (!this.ws || this.ws.readyState > 1)) this.connect(); }, wait);
    },

    send(obj) {
      if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
      return false;
    },

    close() {
      clearInterval(this._pingTimer);
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.ws = null;
      this.state = 'idle';
    },

    /** Local wall-clock time of a server timestamp. */
    serverToLocal(ts) { return ts - this.serverOffset; },
  };

  /* ------------------------------------------------------- mini emitter -- */
  function on(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
    return () => { const a = listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  }
  function emit(type, payload) {
    const a = listeners[type];
    if (!a) return;
    for (const fn of a.slice()) { try { fn(payload); } catch (e) { console.error('[SY]', type, e); } }
  }

  /* ------------------------------------------------------------- public -- */
  return {
    session, rt, api, on, emit,
    get serverUrl() { return SERVER || location.origin; },

    /**
     * Everything you need to answer "why can't it connect?".
     * Type `SY.diagnose()` in the browser console on the deployed page.
     */
    async diagnose() {
      await resolveServer();
      const info = {
        pageServedBy: location.origin,
        configuredServer: SERVER || null,
        apiBase: API || location.origin,
        socketUrl: WS_URL,
        socketState: rt.state,               // idle | connecting | open | closed
        signedIn: session.signedIn,
        sameOrigin: !SERVER,                 // true -> the page host must be the server
      };
      info.problems = [];
      if (!SERVER && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(location.origin)) {
        info.problems.push(
          'No match server is configured and this page is not on localhost. If this is Netlify, '
          + 'GitHub Pages or similar, put your server address in client/config.json -> "server" '
          + '(docs/06-NETLIFY.md Part 2), or set window.__SY_SERVER__ in index.html.',
        );
      }
      if (session.signedIn && rt.state !== 'open') {
        info.problems.push('Signed in but the WebSocket is not open - online matches will not start.');
      }
      info.advice = info.problems.length ? info.problems : ['looks correctly configured'];
      try {
        console.log('%c[Sur Yuddh] configuration report', 'color:#e0b64a;font-weight:bold');
        console.log('  page served by      :', info.pageServedBy);
        console.log('  configured server   :', info.configuredServer || '(same origin / not set)');
        console.log('  REST base           :', info.apiBase);
        console.log('  WebSocket URL       :', info.socketUrl);
        console.log('  socket state        :', info.socketState);
        console.log('  signed in           :', info.signedIn);
        if (info.problems.length) console.warn('[Sur Yuddh] problems:', info.problems);
        else console.log('%c  everything looks correctly configured', 'color:#7fd18a');
      } catch (e) {}
      return info;
    },
    signedIn: () => session.signedIn,
    player: () => session.player,

    async signup(username, password) {
      const out = await api('/api/auth/signup', { method: 'POST', body: { username, password }, auth: false });
      adopt(out);
      rt.connect();
      return out.player;
    },

    async login(username, password) {
      const out = await api('/api/auth/login', { method: 'POST', body: { username, password }, auth: false });
      adopt(out);
      rt.connect();
      return out.player;
    },

    async logout() {
      try { await api('/api/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } }); } catch (e) {}
      session.clear();
      rt.close();
      emit('session', { player: null });
    },

    /** Re-validate a stored session on page load. */
    async resume() {
      if (!session.accessToken) { emit('session', { player: null }); return null; }
      try {
        const out = await api('/api/auth/me');
        session.player = out.player;
        session.save();
        rt.connect();
        emit('session', { player: session.player });
        return out.player;
      } catch (e) {
        if (e.status === 401) { session.clear(); emit('session', { player: null }); }
        return null;
      }
    },

    me: () => api('/api/me/profile'),
    leaderboard: (opts) => {
      const q = new URLSearchParams();
      if (opts && opts.limit) q.set('limit', opts.limit);
      if (opts && opts.offset) q.set('offset', opts.offset);
      if (opts && opts.q) q.set('q', opts.q);
      const s = q.toString();
      return api('/api/leaderboard' + (s ? '?' + s : ''));
    },
    playerProfile: (username) => api('/api/players/' + encodeURIComponent(username)),
    room: (code) => api('/api/rooms/' + encodeURIComponent(code)),
    serverConfig: () => api('/api/config', { auth: false }),
    status: () => api('/api/status', { auth: false }),
  };
})();
