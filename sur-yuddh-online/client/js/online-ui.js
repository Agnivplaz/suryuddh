/* =====================================================================
   Sur Yuddh — online UI
   Accounts · Online Arena (quick match + room codes) · Profile · Leaderboard
   Everything renders into the overlay markup in index.html; the game's own
   screen state machine is never touched.
   ===================================================================== */
(function () {
  'use strict';

  const S = window.__sur;
  const SYnet = window.SY;
  const $ = (id) => document.getElementById(id);

  const state = {
    onlineInstrument: null,
    queueing: false,
    room: null,
    lastLobbyFocus: null,
    noticeShown: false,          // "no match server configured" notice, once per page
  };

  /* ============================================================ overlays */
  const OPEN = new Set();
  function open(id) {
    if (OPEN.has(id)) return;
    OPEN.add(id);
    $(id).classList.add('on');
    window.__uiOpen = true;
    if (id === 'ovOnline') refreshLobby();
  }
  function close(id) {
    OPEN.delete(id);
    $(id).classList.remove('on');
    window.__uiOpen = OPEN.size > 0;
  }
  function closeAll() { [...OPEN].forEach(close); }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && OPEN.size) {
      const last = [...OPEN].pop();
      close(last);
      e.stopPropagation();
    }
  }, true);
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => close(b.getAttribute('data-close')));
  });
  // clicking the dark backdrop closes the panel
  document.querySelectorAll('.ov').forEach((ov) => {
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(ov.id); });
  });

  /* ============================================================== toasts */
  function toast(text, bad) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 3200);
    setTimeout(() => el.remove(), 3600);
  }

  /* ============================================================= session */
  function renderSession() {
    const p = SYnet.player();
    const chip = $('navUser');
    if (p) {
      chip.innerHTML = '<b>' + esc(p.username) + '</b><i>' + fmt(p.total_xp) + ' XP</i>';
      $('navProfile').textContent = '👤 ' + p.username;
      $('btnProfOut').style.display = '';
      $('lobbyWho').textContent = p.username + ' · ' + fmt(p.total_xp) + ' XP';
    } else {
      chip.innerHTML = '<b>Guest</b><i>not signed in</i>';
      $('navProfile').textContent = '👤 Profile';
      $('btnProfOut').style.display = 'none';
      $('lobbyWho').textContent = 'signed out';
    }
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN'));

  function requireLogin(then) {
    if (SYnet.signedIn()) { then(); return; }
    open('ovAuth');
    $('loginUser').focus();
    pendingAfterLogin = then;
  }
  let pendingAfterLogin = null;

  /* ================================================================ auth */
  const tabLogin = $('tabLogin'), tabSignup = $('tabSignup');
  const formLogin = $('formLogin'), formSignup = $('formSignup');
  tabLogin.addEventListener('click', () => switchTab(true));
  tabSignup.addEventListener('click', () => switchTab(false));
  function switchTab(login) {
    tabLogin.classList.toggle('on', login);
    tabSignup.classList.toggle('on', !login);
    formLogin.style.display = login ? '' : 'none';
    formSignup.style.display = login ? 'none' : '';
    $('loginErr').textContent = ''; $('signErr').textContent = '';
  }

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginGo');
    btn.disabled = true; $('loginErr').textContent = '';
    try {
      const p = await SYnet.login($('loginUser').value.trim(), $('loginPass').value);
      toast('Welcome back, ' + p.username);
      close('ovAuth');
      afterAuth();
    } catch (err) {
      $('loginErr').textContent = err.message || 'Could not sign in.';
      if (err.hint) toast(err.hint, true);
    } finally { btn.disabled = false; }
  });

  formSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signGo');
    $('signErr').textContent = '';
    const u = $('signUser').value.trim(), p1 = $('signPass').value, p2 = $('signPass2').value;
    if (p1 !== p2) { $('signErr').textContent = 'The two passwords do not match.'; return; }
    btn.disabled = true;
    try {
      const p = await SYnet.signup(u, p1);
      toast('Profile created — welcome, ' + p.username);
      close('ovAuth');
      afterAuth();
    } catch (err) {
      $('signErr').textContent = err.message || 'Could not create the profile.';
      if (err.hint) toast(err.hint, true);
    } finally { btn.disabled = false; }
  });

  function afterAuth() {
    renderSession();
    const then = pendingAfterLogin; pendingAfterLogin = null;
    if (then) then(); else open('ovOnline');
  }

  $('btnProfOut').addEventListener('click', async () => {
    await SYnet.logout();
    renderSession();
    close('ovProfile');
    toast('Signed out');
  });

  /* =============================================================== lobby */
  $('navPlay').addEventListener('click', () => requireLogin(() => open('ovOnline')));
  $('navProfile').addEventListener('click', () => requireLogin(() => openProfile()));
  $('navBoard').addEventListener('click', () => openBoard());

  function buildInstrumentGrid() {
    const box = $('lobbyInstruments');
    if (box.dataset.built === '1') return;
    const cur = currentInstrument();
    S.INSTRUMENTS.forEach((it) => {
      const b = document.createElement('button');
      b.style.setProperty('--c', S.ELEM[it.el].css);
      b.innerHTML = '<svg><use href="#i-' + it.el + '"/></svg><span>' + esc(it.name) + '</span>';
      b.title = it.role + ' · ' + S.ELEM[it.el].name + ' · Lv ' + S.getProg(it.id).level;
      b.addEventListener('click', () => {
        state.onlineInstrument = it.id;
        [...box.children].forEach((c) => c.classList.remove('on'));
        b.classList.add('on');
      });
      if (it.id === cur) b.classList.add('on');
      box.appendChild(b);
    });
    box.dataset.built = '1';
  }
  const currentInstrument = () => state.onlineInstrument || (S.INSTRUMENTS[S.G.sel] && S.INSTRUMENTS[S.G.sel].id);

  function refreshLobby() {
    buildInstrumentGrid();
    const st = SYnet.rt.state;
    $('lobbyDot').className = 'dot' + (st === 'open' ? ' on' : st === 'connecting' ? ' busy' : '');
    const p = presence;
    $('lobbyStatus').textContent = st === 'open'
      ? (p.players + ' player' + (p.players === 1 ? '' : 's') + ' online · ' + p.queued + ' searching · ' + p.inMatch + ' playing')
      : (SYnet.signedIn() ? 'connecting to the arena…' : 'sign in to play online');
  }

  /* ------------------------------------------------------- quick match */
  $('btnQuick').addEventListener('click', () => {
    if (!SYnet.signedIn()) { requireLogin(() => open('ovOnline')); return; }
    state.queueing = true;
    SYnet.rt.send({ t: 'queue:join' });
    setQueueUI(true, 'Searching for an opponent…');
  });
  $('btnQuickCancel').addEventListener('click', () => {
    state.queueing = false;
    SYnet.rt.send({ t: 'queue:leave' });
    setQueueUI(false, 'Search cancelled.');
  });

  function setQueueUI(on, message) {
    $('btnQuick').style.display = on ? 'none' : '';
    $('btnQuickCancel').style.display = on ? '' : 'none';
    const hint = $('queueHint');
    hint.innerHTML = on ? '<span class="spin"></span>' + esc(message) : esc(message || '');
  }

  /* -------------------------------------------------------- room codes */
  $('btnCreateRoom').addEventListener('click', () => {
    if (!SYnet.signedIn()) { requireLogin(() => open('ovOnline')); return; }
    SYnet.rt.send({ t: 'room:create' });
  });
  $('btnJoinRoom').addEventListener('click', () => {
    if (!SYnet.signedIn()) { requireLogin(() => open('ovOnline')); return; }
    const code = $('joinCode').value.trim().toUpperCase();
    if (code.length < 4) { toast('Enter the 5-character room code', true); return; }
    SYnet.rt.send({ t: 'room:join', code });
  });
  $('joinCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('btnCopyCode').addEventListener('click', async () => {
    if (!state.room) return;
    try { await navigator.clipboard.writeText(state.room); toast('Room code ' + state.room + ' copied'); }
    catch (e) { toast('Room code: ' + state.room); }
  });
  $('btnCloseRoom').addEventListener('click', () => {
    SYnet.rt.send({ t: 'room:leave' });
    state.room = null;
    $('roomBox').style.display = 'none';
    $('btnCreateRoom').style.display = '';
  });

  /* ============================================================= profile */
  async function openProfile() {
    open('ovProfile');
    const body = $('profBody');
    $('profName').textContent = SYnet.player() ? SYnet.player().username : 'Profile';
    $('profMeta').textContent = 'loading…';
    body.innerHTML = '<div class="empty"><span class="spin"></span> Loading your stats…</div>';
    try {
      const { player, history } = await SYnet.me();
      renderProfile(player, history);
    } catch (e) {
      body.innerHTML = '<div class="empty">Could not load your profile. ' + esc(e.message) + '</div>';
      $('profMeta').textContent = '';
    }
  }

  function renderProfile(p, history) {
    $('profName').textContent = p.username;
    $('profMeta').textContent = 'member since ' + new Date(p.created_at).toLocaleDateString()
      + ' · global rank #' + (p.rank == null ? '—' : p.rank);
    const wins = p.wins, losses = p.losses, games = p.games_played;
    $('profBody').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${fmt(p.total_xp)}</b><span>Total XP</span></div>
        <div class="stat"><b>${fmt(games)}</b><span>Games played</span></div>
        <div class="stat"><b>${fmt(wins)}</b><span>Wins</span></div>
        <div class="stat"><b>${fmt(losses)}</b><span>Losses</span></div>
        <div class="stat"><b>${p.winRate}%</b><span>Win rate</span></div>
        <div class="stat"><b>${fmt(p.xpToday)}</b><span>XP today</span></div>
      </div>
      <h3 style="margin:22px 0 8px;color:var(--gold2);font-size:17px">Match history</h3>
      ${history.length ? `
      <table class="tbl">
        <thead><tr><th>Result</th><th>Opponent</th><th>You played</th><th>XP</th><th>Duration</th><th>When</th></tr></thead>
        <tbody>${history.map(histRow).join('')}</tbody>
      </table>` : '<div class="empty">No matches yet — your online fights will appear here.</div>'}
      <p class="hint" style="margin-top:14px">Every match listed here was validated by the server before any XP was awarded.</p>
    `;
  }

  function histRow(m) {
    const cls = m.outcome === 'win' ? 'win' : m.outcome === 'loss' ? 'loss' : 'void';
    const label = m.outcome === 'win' ? 'WIN' : m.outcome === 'loss' ? 'LOSS' : 'VOID';
    const secs = Math.round((m.durationMs || 0) / 1000);
    const dur = m.durationMs ? Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2) : '—';
    const when = new Date(m.playedAt);
    const ago = timeAgo(when);
    const inst = S.INSTRUMENTS.find((i) => i.id === m.instrument);
    return `<tr>
      <td class="${cls}">${label}</td>
      <td>${esc(m.opponent || '—')}${m.opponentInstrument ? ' <span class="subtle">as ' + esc(m.opponentInstrument) + '</span>' : ''}</td>
      <td>${esc(inst ? inst.name : m.instrument)}</td>
      <td>${m.xpEarned ? '+' + fmt(m.xpEarned) : '0'}</td>
      <td>${dur}</td>
      <td><span title="${when.toLocaleString()}">${ago}</span></td>
    </tr>`;
  }

  function timeAgo(d) {
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 86400 * 2) return Math.round(s / 3600) + ' h ago';
    return d.toLocaleDateString();
  }

  /* ========================================================= leaderboard */
  async function openBoard() {
    open('ovBoard');
    await loadBoard();
  }
  $('btnBoardRefresh').addEventListener('click', loadBoard);
  let searchTimer = null;
  $('boardSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadBoard, 260);
  });

  async function loadBoard() {
    const body = $('boardBody');
    body.innerHTML = '<div class="empty"><span class="spin"></span> Loading the global board…</div>';
    try {
      const data = await SYnet.leaderboard({ limit: 50, q: $('boardSearch').value.trim() });
      renderBoard(data);
    } catch (e) {
      const hint = e.hint
        ? '<div class="empty" style="margin-top:-10px;font-size:13px;opacity:.85">' + esc(e.hint) + '</div>'
        : '';
      body.innerHTML = '<div class="empty">Could not load the leaderboard. ' + esc(e.message) + '</div>' + hint;
    }
  }

  function renderBoard(data) {
    const me = data.you;
    $('boardMeta').textContent = data.total + ' ranked player' + (data.total === 1 ? '' : 's')
      + (me ? ' · you are #' + (me.rank == null ? '—' : me.rank) + ' with ' + fmt(me.totalXp) + ' XP' : '');

    if (!data.leaderboard.length) {
      $('boardBody').innerHTML = '<div class="empty">Nobody on the board yet. Win an online match to claim rank #1.</div>';
      return;
    }
    const rows = data.leaderboard.map((e) => {
      const isMe = me && e.id === me.id;
      const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : '';
      return `<tr class="${isMe ? 'me' : ''}">
        <td class="rank ${e.rank === 1 ? 'p1' : ''}">#${e.rank} ${medal}</td>
        <td>${esc(e.username)}${isMe ? ' <span class="subtle">(you)</span>' : ''}</td>
        <td><b>${fmt(e.totalXp)}</b> XP</td>
        <td>${fmt(e.wins)}W · ${fmt(e.losses)}L</td>
        <td>${e.gamesPlayed ? e.winRate + '%' : '—'}</td>
      </tr>`;
    }).join('');

    let youRow = '';
    if (me && !me.inTop && me.rank) {
      youRow = `<tr class="me"><td class="rank">#${me.rank}</td><td>${esc(me.username)} <span class="subtle">(you)</span></td>
        <td><b>${fmt(me.totalXp)}</b> XP</td><td>${fmt(me.wins)}W · ${fmt(me.losses)}L</td><td>${me.winRate}%</td></tr>`;
    }

    $('boardBody').innerHTML = `
      <table class="tbl">
        <thead><tr><th>#</th><th>Player</th><th>Total XP</th><th>Record</th><th>Win rate</th></tr></thead>
        <tbody>${rows}${youRow}</tbody>
      </table>
      <p class="hint" style="margin-top:14px">Ranked by <b>total XP</b>, earned only from server-validated online matches. Practice against AI never appears here.</p>`;
  }

  /* ==================================================== realtime events */
  let presence = { online: 0, players: 0, queued: 0, inMatch: 0, openRooms: 0 };

  SYnet.on('presence', (p) => {
    presence = p;
    if (OPEN.has('ovOnline')) refreshLobby();
  });
  SYnet.on('rt:state', () => { if (OPEN.has('ovOnline')) refreshLobby(); });
  SYnet.on('session', () => renderSession());

  SYnet.on('queue:waiting', (m) => {
    state.queueing = true;
    setQueueUI(true, 'Searching for an opponent…');
    if (m.pending) setQueueUI(true, 'Waiting for your current match to be verified…');
  });
  SYnet.on('queue:cancelled', () => { state.queueing = false; setQueueUI(false, ''); });
  SYnet.on('queue:timeout', (m) => {
    state.queueing = false;
    setQueueUI(false, m.suggestion || 'Nobody else is online right now.');
    toast('No opponent found — try a room code', true);
  });
  SYnet.on('queue:matched', (m) => {
    state.queueing = false;
    setQueueUI(true, 'Opponent found: ' + m.opponent + ' — picking instruments…');
    toast('Opponent found: ' + m.opponent);
    // tell the server which instrument we are taking
    SYnet.rt.send({ t: 'match:ready', instrument: currentInstrument() });
  });
  SYnet.on('room:created', (m) => {
    state.room = m.code;
    $('roomCode').textContent = m.code;
    $('roomBox').style.display = '';
    $('btnCreateRoom').style.display = 'none';
    $('roomHint').textContent = 'Waiting for a challenger… share this code with your friend.';
    toast('Room ' + m.code + ' created');
  });
  SYnet.on('room:state', (m) => {
    if (m.status === 'open' && !m.guestId) {
      state.room = m.code;
      $('roomCode').textContent = m.code;
      $('roomBox').style.display = '';
      $('btnCreateRoom').style.display = 'none';
    }
  });
  SYnet.on('room:closed', (m) => {
    state.room = null;
    $('roomBox').style.display = 'none';
    $('btnCreateRoom').style.display = '';
    if (m.reason === 'guest_left') toast('Your opponent left the room', true);
    if (m.reason === 'expired') toast('That room expired', true);
  });
  SYnet.on('room:error', (m) => {
    const msg = {
      no_such_room: 'No room with that code.',
      room_full: 'That room is already full.',
      room_expired: 'That room code has expired.',
      own_room: 'That is your own room code.',
      host_offline: 'The host is offline now.',
      bad_code: 'That code does not look right.',
    }[m.error] || 'Could not join that room.';
    toast(msg, true);
  });
  SYnet.on('error', (m) => {
    if (m.error === 'in_match') toast('You are already in a match', true);
    else if (m.error === 'signed_in_elsewhere') toast('This account signed in somewhere else', true);
    else if (m.error !== 'not_authenticated') toast('Server: ' + m.error, true);
  });

  SYnet.on('match:start', () => closeAll());
  SYnet.on('match:result', () => { if (OPEN.has('ovProfile')) openProfile(); });
  SYnet.on('toast', (t) => toast(typeof t === 'string' ? t : t.text));

  /* The page is on a static host and no match server is configured: /api/* 404s.
     Say what to do once, instead of leaving the player with "HTTP 404". */
  SYnet.on('server:missing', () => {
    if (state.noticeShown) return;
    state.noticeShown = true;
    toast('Offline only: this page cannot reach the match server. Set window.__SY_SERVER__ (see docs/06-NETLIFY.md). Type SY.diagnose() for details.', true);
  });
  SYnet.on('ui:openLobby', (m) => {
    requireLogin(() => {
      open('ovOnline');
      if (m && m.requeue) setTimeout(() => $('btnQuick').click(), 250);
    });
  });

  /* ================================================================ boot */
  renderSession();
  SYnet.resume().then(() => renderSession());
  setInterval(() => { if (OPEN.has('ovOnline')) refreshLobby(); }, 4000);

  // expose a couple of things for debugging in the console
  window.__ui = { open, close, closeAll, toast, state };
})();
