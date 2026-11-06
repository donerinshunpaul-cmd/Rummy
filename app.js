/* Rummy Room — app: Play with AI (offline) or Play with Friends (room codes, peer-to-peer).
   Includes drag & drop, card animations and responsive layout. */
(function () {
  'use strict';
  const R = window.Rules;
  const PREFIX = 'rummyroom-v2-';
  const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  // Free public STUN servers. To help friends on strict mobile networks, add a TURN server here
  // (e.g. a free key from metered.ca):  { urls: 'turn:...', username: '...', credential: '...' }
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const PEER_OPTS = { config: { iceServers: ICE }, debug: 1 };

  // ---------- storage & utils ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rr-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rr-' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('rr-' + k); } catch (e) {} }
  };
  const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[R.secureInt(31)]).join('');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FAST = /[?&]fast=1/.test(location.search); // test switch only
  if (FAST) R.setTurnMs(6000);
  const wait = (a, b) => (a + Math.random() * (b - a)) / (FAST ? 8 : 1);

  let myId = store.get('pid'); if (!myId) { myId = rid(12); store.set('pid', myId); }
  let myName = store.get('name', '');

  // ---------- state ----------
  let mode = null;          // 'solo' | 'host' | 'guest' | null
  let screen = 'home';      // when mode is null: 'home' | 'ai' | 'friends'
  let code = null, G = null, V = null;
  let peer = null, hostConn = null, retryTimer = null, joinFails = 0, botTimer = null;
  const conns = new Map();
  let sel = new Set();
  let modal = null, lastModal = '';
  let nBots = store.get('nbots', 2);
  let matchDeals = store.get('deals', 0);           // 0 = unlimited, else fixed (min 3)
  let arrangePref = store.get('arrange', 'sorted');  // 'sorted' | 'dealt'
  let arrangedDeal = -1;
  let lastTurnMine = false, wakeLock = null;
  // animation memory
  let seenSeq = 0, seenDeal = 0, seenRevealed = false, pendingFrom = null, drag = null, suppressClick = false, deferRender = false;

  const $app = document.getElementById('app');
  const $status = document.getElementById('status');
  const $modal = document.getElementById('modal');
  function status(msg) { $status.hidden = !msg; $status.textContent = msg || ''; }
  function toast(msg) { document.querySelectorAll('.toast').forEach(x => x.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2900); }

  // ---------- PeerJS (only loaded for Play with Friends, so AI mode works fully offline) ----------
  let peerLoading = null;
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    if (peerLoading) return peerLoading;
    peerLoading = new Promise((ok, fail) => {
      const s = document.createElement('script'); s.src = PEERJS_URL; s.onload = ok;
      s.onerror = () => { peerLoading = null; s.remove(); fail(new Error('offline')); };
      document.head.appendChild(s);
    });
    return peerLoading;
  }

  // ---------- SOLO (vs computer, offline) ----------
  function soloStart(resume) {
    mode = 'solo';
    G = resume || R.newSoloGame({ id: myId, name: myName }, nBots, matchDeals);
    if (!resume) R.act(G, myId, { type: 'start' });
    store.set('last', { mode: 'solo' });
    commit();
  }
  let toTimer = null;
  function scheduleTimeout() {
    clearTimeout(toTimer); toTimer = null;
    if (mode !== 'host' || !G || G.phase !== 'play' || !G.deal || !G.deal.turnEnds) return;
    toTimer = setTimeout(() => {
      toTimer = null;
      if (mode !== 'host') return;
      if (!R.act(G, myId, { type: 'timeout' })) commit(); else scheduleTimeout();
    }, Math.max(0, G.deal.turnEnds - Date.now()) + 300);
  }
  function commit() {   // after any change on the authoritative device
    if (mode === 'solo') store.set('soloGame', G); else if (mode === 'host') store.set('hostGame', G);
    publish();
    if (mode === 'solo') scheduleBot();
    if (mode === 'host') scheduleTimeout();
  }
  function scheduleBot() {
    if (botTimer || !G || G.phase !== 'play') return;
    const D = G.deal, pid = D.order[D.turn];
    const p = G.players.find(x => x.id === pid);
    if (!p || !p.bot) return;
    // human-like pauses: a moment to look at the open card, a little longer to decide what to throw
    const ms = Math.min(4500, D.step === 'draw' ? wait(800, 1600) : wait(700, 1600) + (Math.random() < 0.15 ? 800 : 0));
    botTimer = setTimeout(() => {
      botTimer = null;
      if (mode !== 'solo' || !G.deal || G.deal.order[G.deal.turn] !== pid) return;
      R.botStep(G, pid);
      commit();
    }, ms);
  }

  // ---------- HOST ----------
  async function hostStart(resume) {
    try { await loadPeer(); } catch (e) { toast('Play with Friends needs an internet connection.'); return; }
    mode = 'host';
    G = resume || Object.assign(R.newGame(genCode(), { id: myId, name: myName }), { matchDeals });
    code = G.code;
    G.players.forEach(p => { p.online = p.id === myId; });
    if (G.deal && G.phase === 'play' && G.deal.turnEnds) G.deal.turnEnds = Date.now() + R.TURN_MS; // fresh time after a pause
    store.set('last', { mode: 'host', code });
    openHostPeer(); commit();
  }
  function openHostPeer() {
    if (mode !== 'host') return;
    status('Opening room…');
    peer = new Peer(PREFIX + code, PEER_OPTS);
    peer.on('open', () => status(''));
    peer.on('connection', conn => {
      conn.on('data', m => onHostMsg(conn, m));
      conn.on('close', () => dropConn(conn));
      conn.on('error', () => dropConn(conn));
    });
    peer.on('disconnected', () => setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500));
    peer.on('error', e => {
      if (mode !== 'host') return;
      if (e.type === 'unavailable-id') { status('Reopening room ' + code + '… (can take up to a minute)'); peer.destroy(); setTimeout(openHostPeer, 4000); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(e.type)) {
        status('Connection lost, retrying…');
        setTimeout(() => { if (!peer || peer.destroyed) openHostPeer(); else if (peer.disconnected) peer.reconnect(); }, 3000);
      } else console.warn('peer error', e.type);
    });
  }
  function onHostMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      const err = R.addPlayer(G, String(m.pid).slice(0, 20), String(m.name || 'Player').slice(0, 16));
      if (err) { conn.send({ t: 'err', msg: err, fatal: true }); return; }
      for (const [k, e] of conns) if (e.pid === m.pid && e.conn !== conn) { conns.delete(k); try { e.conn.close(); } catch (x) {} }
      conns.set(conn.connectionId, { conn, pid: m.pid });
      commit();
    } else if (m.t === 'act') {
      const e = conns.get(conn.connectionId); if (!e) return;
      const err = R.act(G, e.pid, m.a || {});
      if (err) conn.send({ t: 'err', msg: err });
      commit();
    }
  }
  function dropConn(conn) {
    const e = conns.get(conn.connectionId); if (!e) return;
    conns.delete(conn.connectionId);
    const still = [...conns.values()].some(x => x.pid === e.pid);
    const p = G && G.players.find(x => x.id === e.pid);
    if (p && !still) { p.online = false; publish(); }
  }
  function publish() {
    for (const e of conns.values()) if (e.conn.open) { try { e.conn.send({ t: 'state', v: R.view(G, e.pid) }); } catch (x) {} }
    setView(R.view(G, myId));
  }

  // ---------- GUEST ----------
  async function guestJoin(c) {
    try { await loadPeer(); } catch (e) { toast('Play with Friends needs an internet connection.'); return; }
    mode = 'guest'; code = c; joinFails = 0; V = null;
    store.set('last', { mode: 'guest', code });
    connectGuest(); render();
  }
  function connectGuest() {
    if (mode !== 'guest') return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (peer && !peer.destroyed) peer.destroy();
    status(V ? 'Reconnecting…' : 'Connecting to room ' + code + '…');
    peer = new Peer(PEER_OPTS);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true });
      hostConn = conn;
      const to = setTimeout(() => { if (!conn.open) retry(); }, 15000);
      conn.on('open', () => { clearTimeout(to); joinFails = 0; status(''); conn.send({ t: 'join', pid: myId, name: myName }); });
      conn.on('data', onGuestMsg);
      conn.on('close', () => { if (hostConn === conn) retry(); });
      conn.on('error', () => { if (hostConn === conn) retry(); });
    });
    peer.on('error', e => {
      if (mode !== 'guest') return;
      if (e.type === 'peer-unavailable') {
        joinFails++;
        if (!V && joinFails >= 3) { leave('end'); toast('Room ' + code + ' not found. Check the code, or ask the host to open the app.'); return; }
        status(V ? 'Host is offline — waiting for them to reopen the app…' : 'Looking for room ' + code + '…');
      } else status('Connection problem, retrying…');
      retry();
    });
  }
  function retry() { if (mode !== 'guest' || retryTimer) return; retryTimer = setTimeout(() => { retryTimer = null; connectGuest(); }, 3000); }
  function onGuestMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') setView(m.v);
    else if (m.t === 'err') { toast(m.msg); if (m.fatal) leave('end'); }
  }

  // ---------- shared ----------
  function doAct(a) {
    if (mode === 'solo' || mode === 'host') { const err = R.act(G, myId, a); if (err) toast(err); commit(); }
    else if (hostConn && hostConn.open) hostConn.send({ t: 'act', a });
    else toast('Not connected — reconnecting…');
  }
  function leave(kind) {   // kind: 'pause' keeps your seat so you can rejoin; otherwise the game is forgotten
    const was = mode, pausedCode = code;
    clearTimeout(toTimer); toTimer = null;
    mode = null; V = null; G = null; code = null; sel.clear(); modal = null; screen = 'home';
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (peer && !peer.destroyed) peer.destroy();
    peer = null; hostConn = null; conns.clear();
    if (kind === 'pause' && (was === 'host' || was === 'guest')) store.set('last', { mode: was, code: pausedCode, paused: true });
    else { store.del('last'); if (was === 'host') store.del('hostGame'); if (was === 'solo') store.del('soloGame'); }
    status(''); releaseWake(); render();
  }
  let deadline = null, warned = false;
  const secsLeft = () => (deadline ? Math.ceil(Math.max(0, deadline - performance.now()) / 1000) : 0);
  function setView(v) {
    const prevTurn = V && V.deal ? V.deal.turnPid + ':' + V.deal.turnLeft : '';
    V = v;
    deadline = V.deal && V.deal.turnLeft != null && V.phase === 'play' ? performance.now() + V.deal.turnLeft : null;
    if (V.deal && prevTurn.split(':')[0] !== V.deal.turnPid) warned = false;
    const hand = myCards();
    sel.forEach(id => { if (!hand.includes(id)) sel.delete(id); });
    const mine = isMyTurn();
    if (mine && !lastTurnMine && navigator.vibrate) navigator.vibrate(40);
    lastTurnMine = mine;
    if (V.phase === 'play') requestWake();
    render();
    maybeArrangeDealt();
  }
  function maybeArrangeDealt() {
    if (!V || V.phase !== 'play' || !V.deal || !V.deal.myGroups || arrangedDeal === V.deal.id) return;
    arrangedDeal = V.deal.id;
    if (arrangePref !== 'sorted') return;
    const dealId = V.deal.id;
    setTimeout(() => {
      if (!V || !V.deal || V.deal.id !== dealId || !V.deal || !V.deal.myGroups || V.deal.myGroups.length !== 1 || (drag && drag.started)) return;
      setGroups(R.groupBySuit(myCards(), wrKnown()), false);
    }, 1500);
  }
  const myGroups = () => (V && V.deal && V.deal.myGroups) || [];
  const myCards = () => R.flat(myGroups());
  const isMyTurn = () => !!(V && V.phase === 'play' && V.deal && V.deal.turnPid === myId);
  const canDraw = () => isMyTurn() && V.deal.step === 'draw';
  const canThrow = () => isMyTurn() && V.deal.step === 'discard';
  const wrKnown = () => (V && V.deal && V.deal.wildRank != null ? V.deal.wildRank : R.NO_WILD);
  const playerName = pid => ((V.players.find(p => p.id === pid)) || {}).name || '?';
  async function requestWake() { try { if (!wakeLock && navigator.wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) {} }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

  // ---------- hand editing ----------
  function setGroups(groups, sortEach) {
    groups = groups.map(g => (sortEach ? R.sortGroup(g) : g)).filter(g => g.length);
    V.deal.myGroups = groups;
    render();
    doAct({ type: 'groups', groups });
  }
  function removeIds(groups, ids) { const s = new Set(ids); return groups.map(g => g.filter(x => !s.has(x))); }
  function groupSelected() {
    if (!sel.size) return;
    const pick = orderedSel(); const rest = removeIds(myGroups(), pick);
    sel.clear(); setGroups(rest.concat([pick]));
  }
  function moveSelectedTo(i) {
    const target = myGroups()[i];
    const pick = [...sel].filter(id => !target.includes(id));
    const out = myGroups().map((g, j) => (j === i ? g.concat(pick) : g.filter(id => !sel.has(id))));
    sel.clear(); setGroups(out);
  }
  function sortHand() { sel.clear(); setGroups(R.groupBySuit(myCards(), wrKnown())); }
  function autoArrange() { sel.clear(); setGroups(R.bestArrangement(myCards(), wrKnown(), 'score').groups); }
  function orderedSel() { return myCards().filter(id => sel.has(id)); }

  // ---------- card html ----------
  function cardHTML(id, opt) {
    opt = opt || {};
    const c = R.parse(id);
    const cls = ['card']; if (opt.sm) cls.push('sm'); if (opt.hand && sel.has(id)) cls.push('sel'); if (opt.isNew) cls.push('new'); if (opt.cls) cls.push(opt.cls);
    let attrs = opt.hand ? ' data-card="' + id + '"' : '';
    if (opt.key) attrs += ' data-k="' + opt.key + '"';
    if (c.s === 'J') return '<div class="' + cls.join(' ') + ' joker"' + attrs + '><span class="r">JOKER</span><span class="big">★</span></div>';
    if (c.s === 'H' || c.s === 'D') cls.push('red');
    const sym = R.SUIT_SYM[c.s];
    const wild = !opt.noWild && c.r === wrKnown();
    return '<div class="' + cls.join(' ') + '"' + attrs + '><span class="r">' + R.RANK_LABEL[c.r] + '<br>' + sym + '</span><span class="big">' + sym + '</span>' + (wild ? '<span class="jk">J</span>' : '') + '</div>';
  }
  const backHTML = (extra, key) => '<div class="card back"' + (key ? ' data-k="' + key + '"' : '') + '>' + (extra || '') + '</div>';
  const TYPE_LABEL = { pure: 'Pure sequence', trio: 'Trio · pure', impure: 'Sequence', set: 'Set', invalid: 'Invalid' };

  // ---------- render ----------
  function render() {
    if (drag && drag.started) { deferRender = true; return; }
    const before = snapshot();
    if (!mode) { if (screen === 'ai') renderAiSetup(); else if (screen === 'friends') renderFriends(); else renderHome(); renderModal(); return; }
    if (!V) { $app.innerHTML = '<div class="screen center"><p>Connecting to room <b>' + esc(code) + '</b>…</p><button class="ghost" data-a="leave">Cancel</button></div>'; renderModal(); return; }
    if (V.phase === 'lobby') renderLobby(); else renderGame();
    renderModal();
    if (V.phase !== 'lobby') animate(before);
  }

  function matchControl(act) {
    const fixed = matchDeals > 0, n = fixed ? matchDeals : 5;
    return '<div><label>Match length</label><div class="row">' +
      '<button class="seg ' + (!fixed ? 'on' : '') + '" data-a="' + act + '" data-n="0">Unlimited deals</button>' +
      '<button class="seg ' + (fixed ? 'on' : '') + '" data-a="' + act + '" data-n="' + n + '">Fixed deals</button></div>' +
      (fixed ? '<div class="row" style="margin-top:8px;justify-content:center"><button class="small ghost" data-a="' + act + '" data-n="' + Math.max(3, n - 1) + '" ' + (n <= 3 ? 'disabled' : '') + '>−</button>' +
        '<b style="min-width:110px;text-align:center">' + n + ' deals</b><button class="small ghost" data-a="' + act + '" data-n="' + Math.min(30, n + 1) + '">＋</button></div>' +
        '<div class="hint" style="text-align:center;margin-top:6px">1st and last deal score double points</div>' : '') + '</div>';
  }
  function arrangeControl() {
    return '<div><label>My cards when dealt</label><div class="row">' +
      '<button class="seg ' + (arrangePref === 'sorted' ? 'on' : '') + '" data-a="arr" data-v="sorted">Sort by suit</button>' +
      '<button class="seg ' + (arrangePref === 'dealt' ? 'on' : '') + '" data-a="arr" data-v="dealt">As dealt · I arrange</button></div></div>';
  }
  function keepName() { const ne = document.getElementById('name'); if (ne) { myName = ne.value.trim().slice(0, 16); store.set('name', myName); } }
  function nameField() { return '<label>Your name</label><input id="name" maxlength="16" placeholder="Your name" value="' + esc(myName) + '" autocomplete="nickname">'; }
  function renderHome() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    $app.innerHTML =
      '<div class="screen center" style="position:relative">' +
      '<button class="ghost small corner" data-a="rules" aria-label="How to play">?</button>' +
      '<div class="logo">' + cardHTML('1-H-0', { noWild: true }) + '<div class="card joker"><span class="r">JOKER</span><span class="big">★</span></div>' + cardHTML('1-S-0', { noWild: true }) + '</div>' +
      '<h1>Rummy Room</h1><div class="sub" style="margin-bottom:22px">Indian Rummy · 13 cards</div>' +
      '<button class="bigbtn primary" data-a="goAi"><span class="ic">🤖</span><span>Play with AI<small>Offline · just you and the computer</small></span></button>' +
      '<button class="bigbtn" data-a="goFriends"><span class="ic">👥</span><span>Play with Friends<small>Create or join a room with a code</small></span></button>' +
      (standalone ? '' : '<div class="hint" style="margin-top:22px;max-width:340px">Install: ' + (ios ? 'tap <b>Share</b> → <b>Add to Home Screen</b>' : 'browser menu <b>⋮</b> → <b>Install app</b>') + '</div>') +
      '</div>';
  }
  function renderAiSetup() {
    const saved = store.get('soloGame');
    $app.innerHTML =
      '<div class="screen center"><h2>🤖 Play with AI</h2><div class="panel stack">' + nameField() +
      '<div><label>Computer players</label><div class="row">' + [1, 2, 3, 4, 5].map(n => '<button class="seg ' + (n === nBots ? 'on' : '') + '" data-a="nb" data-n="' + n + '">' + n + '</button>').join('') + '</div></div>' +
      matchControl('md') + arrangeControl() +
      '<button class="primary" style="width:100%" data-a="soloNew">Start new game</button>' +
      (saved && saved.phase !== 'lobby' ? '<button style="width:100%" data-a="soloResume">Continue last game (deal ' + saved.dealNo + ')</button>' : '') +
      '</div><button class="ghost small" data-a="home">← Back</button></div>';
  }
  function renderFriends() {
    const last = store.get('last');
    const params = new URLSearchParams(location.search);
    const linkCode = (params.get('room') || '').toUpperCase();
    let resume = '';
    const hg = store.get('hostGame');
    if (hg && (!last || last.mode !== 'guest')) resume = '<button style="width:100%" data-a="resumeHost">Back to my room ' + esc(hg.code) + (hg.phase === 'play' ? ' (game in progress)' : '') + '</button>';
    else if (last && last.mode === 'guest') resume = '<button style="width:100%" data-a="rejoin">Rejoin room ' + esc(last.code) + '</button>';
    $app.innerHTML =
      '<div class="screen center"><h2>👥 Play with Friends</h2><div class="panel stack">' + nameField() + resume +
      arrangeControl() +
      '<button class="primary" style="width:100%" data-a="create">Create a room</button>' +
      '<div><label>Have a code?</label><div class="row"><input id="code" maxlength="5" placeholder="CODE" value="' + esc(linkCode) + '" style="text-transform:uppercase;letter-spacing:4px;text-align:center"><button data-a="join">Join</button></div></div>' +
      '</div><button class="ghost small" data-a="home">← Back</button></div>';
  }
  function renderLobby() {
    const isHost = V.hostId === myId;
    const items = V.players.map(p =>
      '<li><span class="dot ' + (p.online ? 'on' : '') + '"></span><span class="grow">' + esc(p.name) + (p.id === myId ? ' <span class="tag">you</span>' : '') + (p.id === V.hostId ? ' <span class="tag">host</span>' : '') + '</span>' +
      (V.dealNo ? '<span class="tag">' + p.total + ' pts</span>' : '') +
      (isHost && p.id !== myId ? ' <button class="small ghost" data-a="remove" data-p="' + esc(p.id) + '">✕</button>' : '') + '</li>').join('');
    $app.innerHTML =
      '<div class="screen center"><div class="sub">Room code</div><div class="code">' + esc(V.code) + '</div>' +
      '<div class="row" style="justify-content:center;margin:6px 0 4px"><button class="small" data-a="share">Share invite link</button></div>' +
      '<div class="panel"><b>Players (' + V.players.length + '/6)</b><ul class="plist">' + items + '</ul>' +
      (isHost && (!V.dealNo || V.matchOver) ? '<div class="stack" style="margin-bottom:12px">' + (matchDeals = V.matchDeals, matchControl('cfg')) + '</div>'
        : '<p class="sub" style="text-align:center">Match: ' + (V.matchDeals ? V.matchDeals + ' deals · 1st & last double' : 'unlimited deals') + '</p>') +
      (isHost
        ? '<button class="primary" style="width:100%" data-a="' + (V.matchOver ? 'newMatch' : 'start') + '" ' + (V.players.length < 2 ? 'disabled' : '') + '>' + (V.players.length < 2 ? 'Waiting for friends to join…' : V.matchOver ? 'Start new match' : (V.dealNo ? 'Start next deal' : 'Start game')) + '</button>' +
          (V.dealNo ? '<button class="small ghost" style="margin-top:8px" data-a="reset">Reset scores</button>' : '')
        : '<div class="sub">Waiting for the host to start…</div>') +
      '</div><div class="row" style="justify-content:center"><button class="ghost small" data-a="rules">How to play</button>' + (V.dealNo ? '<button class="ghost small" data-a="scores">Scores</button>' : '') + '<button class="ghost small" data-a="leave">Leave</button>' + (isHost ? '<button class="ghost small" data-a="endRoom">End room</button>' : '') + '</div></div>';
  }

  function renderGame() {
    const D = V.deal; if (!D) return;
    const isHost = V.hostId === myId;
    const mine = isMyTurn();
    const inDeal = !!D.myGroups;
    const me = V.players.find(p => p.id === myId) || {};
    const ord = D.order.slice(), k = ord.indexOf(myId);
    const others = (k >= 0 ? ord.slice(k + 1).concat(ord.slice(0, k)) : ord).map(pid => V.players.find(p => p.id === pid)).filter(Boolean);
    V.players.forEach(p => { if (!ord.includes(p.id) && p.id !== myId) others.push(p); });
    const opps = others.map(p => {
      const turn = D.turnPid === p.id && V.phase === 'play';
      let st;
      if (!p.inDeal) st = 'Next deal'; else if (p.out) st = 'Dropped'; else if (!p.online) st = 'Offline';
      else if (turn && p.bot) st = '<span class="think"><i></i><i></i><i></i></span>';
      else st = '<span class="mini"></span>' + p.count;
      if (turn && deadline) st += ' <span class="tmr" data-timer>' + secsLeft() + 's</span>';
      return '<div class="opp ' + (turn ? 'turn ' : '') + (p.out || !p.inDeal ? 'out' : '') + '" data-k="p:' + esc(p.id) + '"><div class="n">' + (p.bot ? '🤖 ' : '') + (p.online ? '' : '⚠ ') + esc(p.name) + (p.revealed ? ' 🔓' : '') + '</div><div>' + st + '</div><div class="sub" style="font-size:11px">' + p.total + ' pts</div>' +
        (isHost && turn && !p.online && !p.bot ? '<button class="small danger" style="margin-top:4px;padding:4px 8px" data-a="kick" data-p="' + esc(p.id) + '">Drop them</button>' : '') + '</div>';
    }).join('');

    const top = D.discardTop, under = D.discardUnder;
    const jslot = D.wild
      ? '<div class="pile jslot" id="jslot"><div class="stackwrap">' + cardHTML(D.wild, { noWild: true }) + '</div>Joker: all ' + R.RANK_LABEL[D.wildRank] + 's</div>'
      : '<div class="pile jslot" id="jslot"><div class="stackwrap"><div class="card closed"><span class="cnt">🔒</span></div></div>Closed joker</div>';
    const table =
      '<div class="table">' + jslot +
      '<div class="pile ' + (canDraw() ? 'can' : '') + '" data-pile="stock" data-a="drawStock"><div class="stackwrap" id="stock">' + backHTML('') + backHTML('<span class="cnt">' + Math.max(0, D.stockCount - 1) + '</span>') + '</div>Deck</div>' +
      '<div class="pile ' + (canDraw() && top && R.parse(top).s !== 'J' ? 'can' : '') + '" data-pile="discard" data-a="drawDiscard"><div class="stackwrap" id="openpile">' +
        (under ? cardHTML(under, { cls: 'under' }) : '') + (top ? cardHTML(top, { key: 'c:' + top }) : '<div class="empty"></div>') + '</div>Open card</div>' +
      (canThrow() ? '<div class="pile"><div class="finish" data-drop="finish" data-a="declareSel">Finish</div>Drop to declare</div>' : '') +
      '</div>';

    let banner;
    if (V.phase === 'result') banner = 'Deal over';
    else if (!inDeal) banner = 'You will be dealt in next deal';
    else if (me.out) banner = 'You dropped this deal (' + me.out + ' pts)';
    else if (mine) banner = D.step === 'draw' ? 'Your turn — pick from the Deck or the Open card' : 'Throw a card onto the Open pile, or Finish to declare';
    else { const tp = V.players.find(p => p.id === D.turnPid) || { name: '?' }; banner = tp.bot ? esc(tp.name) + ' is thinking…' : 'Waiting for ' + esc(tp.name) + '…'; }

    let hand = '';
    if (inDeal) {
      const ev = R.evaluate(D.myGroups, wrKnown());
      hand = D.myGroups.map((g, i) => {
        const t = g.length >= 3 ? ev.info[i].type : null;
        const canMove = sel.size && g.some(id => !sel.has(id));
        return '<div class="grp" data-grp="' + i + '">' + (canMove ? '<button class="moveto" data-a="move" data-g="' + i + '">＋ here</button>' : '') +
          '<div class="cards" style="--ov:' + (g.length > 9 ? 0.64 : g.length > 6 ? 0.56 : 0.5) + '">' + g.map(id => cardHTML(id, { hand: true, key: 'c:' + id, isNew: id === D.lastDrawn && mine && D.step === 'discard' })).join('') + '</div>' +
          '<div class="glabel ' + (t || '') + '">' + (t ? TYPE_LABEL[t] + (t === 'invalid' ? '' : ' ✓') : g.length + ' card' + (g.length > 1 ? 's' : '')) + '</div></div>';
      }).join('') + '<div class="newgrp" data-drop="new">＋<br>New group</div>';
    }

    let btns = '';
    if (inDeal && !me.out) {
      const one = sel.size === 1;
      if (canDraw()) btns += '<button class="danger small" data-a="drop">Drop</button>';
      if (sel.size >= 2) btns += '<button class="small" data-a="group">Group (' + sel.size + ')</button>';
      btns += '<button class="small ghost" data-a="sort">Sort</button><button class="small ghost" data-a="auto">Auto-arrange</button>';
      if (canThrow()) {
        btns += '<button class="primary small" data-a="discard" ' + (one ? '' : 'disabled') + '>Discard</button>';
        btns += '<button class="go small" data-a="declareSel" ' + (one ? '' : 'disabled') + '>Declare</button>';
      }
    }
    const ptsLine = inDeal && !me.out ? '<div class="pts">Hand value: <b>' + R.evaluate(D.myGroups, wrKnown()).pts + '</b> pts' + (sel.size ? ' · ' + sel.size + ' selected' : ' · drag cards to arrange, or tap to select') + '</div>' : '';

    $app.innerHTML = '<div class="game">' +
      '<div class="topbar"><span>' + (V.solo ? 'vs Computer' : 'Room <b>' + esc(V.code) + '</b>') + ' · Deal ' + V.dealNo + (V.matchDeals ? ' of ' + V.matchDeals : '') + (V.mult > 1 ? ' <span class="tag" style="background:var(--gold);color:#2a2100">×2 points</span>' : '') + '</span><span class="grow"></span>' +
      '<button class="small ghost" data-a="scores">Scores</button><button class="small ghost" data-a="menu">☰</button></div>' +
      '<div class="top"><div class="opps">' + opps + '</div>' + table + '</div>' +
      '<div class="banner ' + (mine ? 'mine' : '') + '">' + banner + (deadline && mine ? ' <span class="tmr" data-timer>' + secsLeft() + 's</span>' : '') + '</div>' +
      (deadline ? '<div class="tbar"><i data-timerbar style="width:' + (deadline ? 100 * Math.max(0, deadline - performance.now()) / V.deal.turnMs : 0) + '%"></i></div>' : '') +
      '<div class="log">' + esc(D.log[D.log.length - 1] || '') + '</div>' +
      '<div class="hand" id="hand">' + hand + '</div>' +
      '<div class="actions">' + ptsLine + btns + '</div></div>';
  }

  function groupsHTML(groups) {
    return '<div class="gs">' + groups.map(g => {
      const t = g.ids.length >= 3 ? g.type : 'invalid';
      return '<div class="g"><div class="cards">' + g.ids.map(id => cardHTML(id, { sm: true })).join('') + '</div><div class="glabel ' + t + '">' + (g.ids.length >= 3 ? TYPE_LABEL[t] : 'Ungrouped') + '</div></div>';
    }).join('') + '</div>';
  }
  function renderModal() {
    let html = '';
    const D = V && V.deal;
    if (V && V.phase === 'result' && D && D.result && !['scores', 'menu', 'rules'].includes(modal)) {
      const r = D.result; const isHost = V.hostId === myId;
      const title = r.wrongBy ? playerName(r.wrongBy) + ' made a wrong show!' : (r.winner === myId ? 'You win deal ' + V.dealNo + '! 🎉' : playerName(r.winner) + ' wins deal ' + V.dealNo);
      const st = r.final && r.standings;
      html = '<div class="modal-bg"><div class="modal">' +
        (st ? '<h2>🏆 Match over — ' + esc(st[0].pid === myId ? 'you win!' : st[0].name + ' wins!') + '</h2><table class="sc" style="margin-bottom:14px">' +
          st.map((x, i) => '<tr><td>' + (i + 1) + '</td><td style="text-align:left">' + esc(x.name) + '</td><td style="color:var(--gold)"><b>' + x.total + '</b> pts</td></tr>').join('') + '</table><h2 style="font-size:16px">Last deal: ' + esc(title) + '</h2>'
          : '<h2>' + esc(title) + '</h2>') +
        (r.mult > 1 ? '<div class="tag" style="display:inline-block;background:var(--gold);color:#2a2100;margin-bottom:8px">Double points deal — all scores ×2</div>' : '') +
        (D.wild ? '<div class="row sub" style="margin-bottom:6px">Joker was ' + cardHTML(D.wild, { sm: true, noWild: true }) + ' (all ' + R.RANK_LABEL[D.wildRank] + 's)</div>' : '') +
        r.rows.slice().sort((a, b) => a.pts - b.pts).map(row => {
          const p = V.players.find(x => x.id === row.pid) || { total: 0 };
          return '<div class="res"><div class="hd"><b class="grow">' + esc(row.name) + '</b>' + (row.note ? '<span class="tag">' + esc(row.note) + '</span>' : '') +
            '<b style="color:var(--gold)">+' + row.pts + '</b>' + (r.mult > 1 ? '<span class="tag">' + row.base + ' ×2</span>' : '') + '<span class="tag">Total ' + p.total + '</span></div>' + groupsHTML(row.groups) + '</div>';
        }).join('') +
        '<div class="row" style="margin-top:12px;justify-content:center;flex-wrap:wrap">' +
        (isHost ? (r.final ? '<button class="primary" data-a="newMatch">New match</button>' : '<button class="primary" data-a="next">Next deal' + (V.matchDeals && V.dealNo + 1 === V.matchDeals ? ' (last · ×2)' : '') + '</button>') + (V.solo ? '<button class="ghost" data-a="leave">' + (r.final ? 'Home' : 'Quit') + '</button>' : '<button class="ghost" data-a="toLobby">Lobby</button>')
          : '<div class="sub">' + (r.final ? 'Waiting for the host…' : 'Waiting for the host to start the next deal…') + '</div>') +
        '</div></div></div>';
    } else if (modal === 'declare' && D && sel.size === 1 && canThrow()) {
      const card = [...sel][0];
      const rest = D.myGroups.map(g => g.filter(id => id !== card)).filter(g => g.length);
      const ev = R.evaluate(rest, wrKnown());
      const why = [];
      if (ev.pure < 1) why.push('you need a pure sequence'); if (ev.seqs < 2) why.push('you need 2 sequences'); if (ev.info.some(x => x.type === 'invalid')) why.push('some groups are not valid');
      html = '<div class="modal-bg"><div class="modal"><h2>Declare?</h2><div class="row sub" style="margin-bottom:8px">Finishing card ' + cardHTML(card, { sm: true }) + '</div>' + groupsHTML(ev.info) +
        '<p style="font-weight:700;color:' + (ev.valid ? 'var(--ok)' : 'var(--danger)') + '">' + (ev.valid ? '✓ Valid — you win this deal!' : '✕ Not valid: ' + why.join(', ') + '. A wrong show costs 80 points.') + '</p>' +
        '<div class="row" style="justify-content:flex-end"><button class="ghost" data-a="close">Cancel</button><button class="' + (ev.valid ? 'go' : 'danger') + '" data-a="confirmDeclare">Declare</button></div></div></div>';
    } else if (modal === 'scores' && V) {
      const ps = V.players;
      html = '<div class="modal-bg"><div class="modal"><h2>Scoreboard</h2><p class="sub">' + (V.matchDeals ? 'Match of ' + V.matchDeals + ' deals (1st & last double). ' : '') + 'Lowest total is winning.</p><table class="sc"><tr><th>Deal</th>' + ps.map(p => '<th>' + esc(p.name) + '</th>').join('') + '</tr>' +
        V.history.map(h => '<tr><td>' + h.deal + (h.mult > 1 ? ' <span class="tag">×2</span>' : '') + '</td>' + ps.map(p => '<td>' + (h.pts[p.id] == null ? '–' : h.pts[p.id]) + '</td>').join('') + '</tr>').join('') +
        '<tr><th>Total</th>' + ps.map(p => '<th style="color:var(--gold)">' + p.total + '</th>').join('') + '</tr></table>' +
        '<div class="row" style="justify-content:flex-end;margin-top:12px"><button data-a="close">Close</button></div></div></div>';
    } else if (modal === 'menu' && V) {
      const isHost = V.hostId === myId;
      html = '<div class="modal-bg" data-a="close"><div class="modal stack" style="max-width:340px">' +
        (V.solo ? '' : '<button style="width:100%" data-a="share">Invite friends (code ' + esc(V.code) + ')</button>') +
        '<button style="width:100%" data-a="rules">How to play</button>' +
        '<button style="width:100%" class="ghost" data-a="arrToggle">New deals: ' + (arrangePref === 'sorted' ? 'sort my cards by suit' : 'leave as dealt (I arrange)') + '</button>' +
        (isHost && !V.solo && V.phase === 'play' ? '<button style="width:100%" class="ghost" data-a="toLobby">End deal & go to lobby</button>' : '') +
        '<button style="width:100%" class="danger" data-a="leave">' + (V.solo ? 'Quit game' : 'Leave (you can rejoin)') + '</button>' +
        (isHost && !V.solo ? '<button style="width:100%" class="ghost" data-a="endRoom">End room for everyone</button>' : '') +
        '<button style="width:100%" class="ghost" data-a="close">Back</button></div></div>';
    } else if (modal === 'rules') {
      html = '<div class="modal-bg"><div class="modal rules"><h2>How to play</h2>' +
        '<p><b>Cards:</b> 3 decks with 2 printed jokers each (162 cards). The deck is shuffled once before each deal and its order never changes during the deal. Cards are dealt one at a time, 13 each.</p>' +
        '<p><b>Closed joker:</b> one card is placed face-down under the deck. You see it only after you arrange your first <b>pure sequence</b>. Then every card of that rank is a joker for you.</p>' +
        '<p><b>Your turn:</b> pick from the Deck or the Open card, then throw one card onto the Open pile. Drag a card onto the pile, or tap it and press Discard.</p>' +
        '<p><b>Arranging:</b> drag cards between groups, onto <b>＋ New group</b>, or select several and press Group. <b>Auto-arrange</b> finds a good grouping.</p>' +
        '<p><b>Pure sequence:</b> 3+ in a row, same suit, no joker (4♥ 5♥ 6♥). <b>Trio:</b> 3 identical cards (7♥ 7♥ 7♥) count as a pure sequence; only one trio counts. <b>Sequence:</b> jokers may fill gaps. <b>Set:</b> 3–4 of the same rank, different suits.</p>' +
        '<p><b>To win:</b> group all 13 cards with at least 2 sequences, one of them pure. After picking your 14th card, drag a card to <b>Finish</b> (or select it and press Declare).</p>' +
        '<p><b>Points:</b> A K Q J = 10, number cards = face value, jokers = 0. Losers score their ungrouped cards (min 1, max 80). With no pure sequence, every card counts. Wrong show = 80. Drop before your first pick = 20, later = 40. Lowest total wins.</p>' +
        '<p><b>Match:</b> play unlimited deals, or a fixed number (3 or more). In a fixed match the <b>1st and last deal score double</b>. Lowest total after the last deal wins the match.</p>' +
        '<p><b>Your cards:</b> choose to get them sorted by suit, or exactly as dealt and arrange them yourself. Drag cards to any position, inside a group or between groups.</p>' +
        '<p><b>Turn timer (Play with Friends):</b> 45 seconds per turn. If time runs out, the turn passes: a card you picked goes back to the open pile; if you had not picked, the top deck card is turned onto the open pile.</p>' +
        '<p><b>Deck finished?</b> The open pile is turned over (no shuffle) and play continues.</p>' +
        '<div class="row" style="justify-content:flex-end"><button data-a="close">Got it</button></div></div></div>';
    }
    if (lastModal !== html) { lastModal = html; $modal.innerHTML = html; }
  }

  // ---------- animation ----------
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  function snapshot() {
    const m = new Map();
    $app.querySelectorAll('[data-k]').forEach(el => m.set(el.dataset.k, el.getBoundingClientRect()));
    const st = document.getElementById('stock'); if (st) m.set('stock', st.getBoundingClientRect());
    const op = document.getElementById('openpile'); if (op) m.set('open', op.getBoundingClientRect());
    if (pendingFrom) { for (const k in pendingFrom) m.set(k, pendingFrom[k]); pendingFrom = null; }
    return m;
  }
  function flyFrom(el, from, o) {
    o = o || {};
    const to = el.getBoundingClientRect();
    if (!to.width || !from || !from.width) return;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2), dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const sc = from.width / to.width;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sc - 1) < 0.02) return;
    const k0 = { translate: dx + 'px ' + dy + 'px', scale: String(sc) }; if (o.fade) k0.opacity = 0;
    el.animate([k0, { translate: '0px 0px', scale: '1', opacity: 1 }], { duration: o.dur || 420, delay: o.delay || 0, easing: EASE, fill: 'backwards' });
  }
  function ghost(html, from, to, o) {
    if (!from || !to) return;
    o = o || {};
    const wrap = document.createElement('div'); wrap.innerHTML = html;
    const el = wrap.firstElementChild; el.classList.add('fly');
    el.style.left = from.left + 'px'; el.style.top = from.top + 'px';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    const dx = (to.left + to.width / 2) - (r.left + r.width / 2), dy = (to.top + to.height / 2) - (r.top + r.height / 2);
    const sc = o.scale || 1;
    const a = el.animate([{ translate: '0px 0px', scale: '1', opacity: 1 }, { translate: dx + 'px ' + dy + 'px', scale: String(sc), opacity: o.fadeOut ? 0 : 1 }],
      { duration: o.dur || 480, delay: o.delay || 0, easing: EASE, fill: 'both' });
    a.onfinish = () => el.remove();
  }
  function animate(before) {
    const D = V && V.deal; if (!D) return;
    const la = D.lastAct;
    const newAct = la && la.seq > seenSeq;
    const newDeal = D.id !== seenDeal;
    const stockR = (document.getElementById('stock') || {}).getBoundingClientRect ? document.getElementById('stock').getBoundingClientRect() : null;
    const chip = pid => { const el = $app.querySelector('[data-k="p:' + CSS.escape(pid) + '"]'); return el ? el.getBoundingClientRect() : null; };
    let dealIdx = 0;
    $app.querySelectorAll('[data-k]').forEach(el => {
      const key = el.dataset.k;
      if (!key.startsWith('c:')) return;
      const prev = before.get(key);
      const inHand = !!el.closest('#hand');
      if (newDeal && inHand) { flyFrom(el, stockR, { delay: 120 + dealIdx++ * 55, dur: 460, fade: true }); return; }
      if (prev) { flyFrom(el, prev, { dur: drag ? 300 : 420 }); return; }
      if (!newAct) return;
      if (inHand && la.type === 'draw' && la.pid === myId) flyFrom(el, before.get('dragdrop') || before.get(la.from === 'discard' ? 'open' : 'stock') || stockR, { dur: 480 });
      else if (!inHand && (la.type === 'discard' || la.type === 'declare') && la.pid !== myId) flyFrom(el, chip(la.pid), { dur: 520 });
      else if (!inHand && la.type === 'timeout') flyFrom(el, la.from === 'stock' ? stockR : (la.pid === myId ? null : chip(la.pid)), { dur: 520 });
    });
    if (newDeal) {
      // a few cards flying to each opponent while dealing
      (D.order || []).filter(p => p !== myId).forEach((pid, i) => { for (let j = 0; j < 3; j++) ghost(backHTML(''), stockR, chip(pid), { delay: 120 + (j * 4 + i) * 90, dur: 420, scale: 0.4, fadeOut: true }); });
    } else if (newAct && la.type === 'draw' && la.pid !== myId) {
      const from = la.from === 'discard' ? before.get('c:' + la.card) || before.get('open') : stockR;
      ghost(la.from === 'discard' && la.card ? cardHTML(la.card) : backHTML(''), from, chip(la.pid), { dur: 520, scale: 0.45, fadeOut: true });
    }
    // closed joker flips open the first time you see it
    if (D.revealed && !seenRevealed && !newDeal) {
      const j = document.getElementById('jslot'); if (j) { j.classList.add('flip'); }
      toast('Joker unlocked: every ' + R.RANK_LABEL[D.wildRank] + ' is now a joker for you!');
    }
    if (newAct && la.type === 'timeout' && la.pid === myId) toast("Time's up — your turn was passed");
    if (newDeal && V.mult > 1) toast('Deal ' + V.dealNo + ': double points!');
    seenRevealed = !!D.revealed; seenDeal = D.id; if (la) seenSeq = Math.max(seenSeq, la.seq);
  }

  // ---------- drag & drop ----------
  function clearHot() { document.querySelectorAll('.hot,.ins-before,.ins-after').forEach(el => el.classList.remove('hot', 'ins-before', 'ins-after')); }
  function findTarget(x, y) {
    const el = document.elementFromPoint(x, y); if (!el) return null;
    if (drag.kind === 'pile') { const h = el.closest('#hand'); return h ? { type: 'draw', el: h } : null; }
    const pile = el.closest('[data-pile="discard"]'); if (pile) return canThrow() && drag.ids.length === 1 ? { type: 'discard', el: pile } : null;
    const fin = el.closest('[data-drop="finish"]'); if (fin) return drag.ids.length === 1 ? { type: 'finish', el: fin } : null;
    const ng = el.closest('[data-drop="new"]'); if (ng) return { type: 'new', el: ng };
    const card = el.closest('#hand [data-card]');
    if (card && !drag.ids.includes(card.dataset.card)) {
      const r = card.getBoundingClientRect();
      const isLast = !card.nextElementSibling;
      const vis = isLast ? r.width : r.width * 0.5;
      return { type: 'card', el: card, id: card.dataset.card, side: x < r.left + vis / 2 ? 'before' : 'after' };
    }
    const grp = el.closest('[data-grp]'); if (grp) return { type: 'grp', el: grp, i: +grp.dataset.grp };
    const hand = el.closest('#hand'); if (hand) return { type: 'new', el: hand };
    return null;
  }
  function startDrag(e) {
    drag.started = true;
    document.body.classList.add('dragging');
    let html = '';
    if (drag.kind === 'hand') {
      drag.ids = sel.has(drag.id) && sel.size > 1 ? orderedSel() : [drag.id];
      drag.ids.forEach(id => { const c = $app.querySelector('[data-card="' + id + '"]'); if (c) { c.classList.add('ghosted'); c.classList.remove('sel'); } });
      html = drag.ids.map(id => cardHTML(id)).join('');
    } else {
      html = drag.from === 'discard' && V.deal.discardTop ? cardHTML(V.deal.discardTop) : backHTML('');
    }
    const r = drag.el.getBoundingClientRect();
    drag.offX = drag.x0 - r.left; drag.offY = drag.y0 - r.top;
    const g = document.createElement('div'); g.className = 'drag-ghost'; g.innerHTML = html;
    document.body.appendChild(g); drag.ghost = g;
    g.animate([{ scale: '1' }, { scale: '1.08' }], { duration: 160, easing: EASE, fill: 'forwards' });
  }
  function moveDrag(e) {
    drag.ghost.style.transform = 'translate(' + (e.clientX - drag.offX) + 'px,' + (e.clientY - drag.offY) + 'px) rotate(' + Math.max(-8, Math.min(8, (e.clientX - drag.x0) / 30)) + 'deg)';
    clearHot();
    const t = findTarget(e.clientX, e.clientY); drag.target = t;
    if (!t) return;
    if (t.type === 'card') t.el.classList.add(t.side === 'before' ? 'ins-before' : 'ins-after');
    else t.el.classList.add('hot');
  }
  function endDrag() {
    const t = drag.target, g = drag.ghost;
    const gr = g.firstElementChild ? g.firstElementChild.getBoundingClientRect() : null;
    clearHot(); document.body.classList.remove('dragging');
    const d = drag; drag = null;
    g.remove();
    if (!t) { deferRender = false; render(); return; }
    if (d.kind === 'pile') {
      pendingFrom = { dragdrop: gr };
      doAct({ type: 'draw', from: d.from === 'discard' ? 'discard' : 'stock' });
      return;
    }
    if (t.type === 'discard') {
      const id = d.ids[0]; sel.clear();
      pendingFrom = { ['c:' + id]: gr };
      doAct({ type: 'discard', card: id });
      return;
    }
    if (t.type === 'finish') { sel = new Set(d.ids); modal = 'declare'; deferRender = false; render(); return; }
    // rearrange
    const groups = removeIds(myGroups(), d.ids);
    if (t.type === 'new') groups.push(d.ids.slice());
    else if (t.type === 'grp') groups[t.i] = groups[t.i].concat(d.ids);
    else if (t.type === 'card') {
      const gi = groups.findIndex(gg => gg.includes(t.id));
      const idx = groups[gi].indexOf(t.id) + (t.side === 'after' ? 1 : 0);
      groups[gi].splice(idx, 0, ...d.ids);
    }
    pendingFrom = {}; d.ids.forEach((id, i) => { pendingFrom['c:' + id] = gr ? { left: gr.left + i * gr.width * 0.4, top: gr.top, width: gr.width, height: gr.height } : null; });
    sel.clear(); deferRender = false;
    setGroups(groups, false);
  }
  $app.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!V || V.phase !== 'play') return;
    const cardEl = e.target.closest('#hand [data-card]');
    const pileEl = e.target.closest('[data-pile]');
    if (cardEl) drag = { kind: 'hand', id: cardEl.dataset.card, el: cardEl, x0: e.clientX, y0: e.clientY, pid: e.pointerId, started: false };
    else if (pileEl && canDraw() && !(pileEl.dataset.pile === 'discard' && (!V.deal.discardTop || R.parse(V.deal.discardTop).s === 'J'))) {
      drag = { kind: 'pile', from: pileEl.dataset.pile, el: pileEl.querySelector('.stackwrap .card:last-child'), x0: e.clientX, y0: e.clientY, pid: e.pointerId, started: false };
    }
  });
  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.started) { if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 7) return; startDrag(e); }
    e.preventDefault(); moveDrag(e);
  }, { passive: false });
  window.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (drag.started) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 60); endDrag(); }
    else drag = null;
  });
  window.addEventListener('pointercancel', () => {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    clearHot(); document.body.classList.remove('dragging'); drag = null; deferRender = false; render();
  });

  // ---------- events ----------
  function readName() {
    const el = document.getElementById('name');
    const n = (el && el.value || '').trim().slice(0, 16);
    if (!n) { toast('Enter your name first'); el && el.focus(); return false; }
    myName = n; store.set('name', n); return true;
  }
  async function share() {
    const url = location.origin + location.pathname + '?room=' + V.code;
    const text = 'Join my Rummy room! Code: ' + V.code;
    try { if (navigator.share) await navigator.share({ title: 'Rummy Room', text, url }); else { await navigator.clipboard.writeText(text + ' ' + url); toast('Invite link copied'); } } catch (e) {}
  }
  function openDeclare() { if (sel.size === 1 && canThrow()) { modal = 'declare'; renderModal(); } else toast('Select the one card you want to finish with'); }

  document.addEventListener('click', ev => {
    if (suppressClick) { ev.preventDefault(); return; }
    const cardEl = ev.target.closest('#hand [data-card]');
    if (cardEl) { const id = cardEl.dataset.card; if (sel.has(id)) sel.delete(id); else sel.add(id); render(); return; }
    const el = ev.target.closest('[data-a]'); if (!el) return;
    if (el.classList.contains('modal-bg') && ev.target !== el) return;
    const a = el.dataset.a;
    switch (a) {
      case 'home': screen = 'home'; render(); break;
      case 'goAi': screen = 'ai'; render(); break;
      case 'goFriends': screen = 'friends'; render(); break;
      case 'nb': { const ne = document.getElementById('name'); if (ne) { myName = ne.value.trim().slice(0, 16); store.set('name', myName); } nBots = +el.dataset.n; store.set('nbots', nBots); render(); break; }
      case 'md': keepName(); matchDeals = +el.dataset.n; store.set('deals', matchDeals); render(); break;
      case 'cfg': matchDeals = +el.dataset.n; store.set('deals', matchDeals); doAct({ type: 'config', deals: matchDeals }); break;
      case 'arr': keepName(); arrangePref = el.dataset.v; store.set('arrange', arrangePref); render(); break;
      case 'arrToggle': arrangePref = arrangePref === 'sorted' ? 'dealt' : 'sorted'; store.set('arrange', arrangePref); modal = null; render(); toast(arrangePref === 'sorted' ? 'New deals will be sorted by suit' : 'New deals will stay as dealt'); break;
      case 'newMatch': doAct({ type: 'newMatch' }); break;
      case 'soloNew': if (readName()) { store.del('soloGame'); seenDeal = 0; soloStart(null); } break;
      case 'soloResume': if (readName()) { const g = store.get('soloGame'); if (g) { g.players[0].name = myName; soloStart(g); } } break;
      case 'create': if (readName()) { store.del('hostGame'); hostStart(null); } break;
      case 'resumeHost': if (readName()) { const g = store.get('hostGame'); if (g) { g.players.forEach(p => { if (p.id === myId) p.name = myName; }); hostStart(g); } } break;
      case 'join': {
        if (!readName()) break;
        const c = (document.getElementById('code').value || '').trim().toUpperCase();
        if (c.length < 4) { toast('Enter the room code'); break; }
        const own = store.get('hostGame');
        if (own && own.code === c) { own.players.forEach(p => { if (p.id === myId) p.name = myName; }); hostStart(own); break; }  // the host coming back
        guestJoin(c); break;
      }
      case 'rejoin': if (readName()) guestJoin(store.get('last').code); break;
      case 'leave':
        if (mode === 'host' && !confirm('Leave the room? The game pauses until you come back (Play with Friends → join with code ' + code + ').')) break;
        if (mode === 'solo' && V && V.phase === 'play' && !confirm('Quit this game?')) break;
        modal = null; leave(mode === 'solo' ? 'end' : 'pause'); history.replaceState(null, '', location.pathname); break;
      case 'endRoom':
        if (!confirm('End this room for everyone? Scores will be cleared.')) break;
        modal = null; leave('end'); history.replaceState(null, '', location.pathname); break;
      case 'share': share(); break;
      case 'start': doAct({ type: 'start' }); break;
      case 'next': doAct({ type: 'next' }); break;
      case 'toLobby': modal = null; doAct({ type: 'lobby' }); break;
      case 'reset': if (confirm('Reset all scores?')) doAct({ type: 'reset' }); break;
      case 'remove': doAct({ type: 'remove', target: el.dataset.p }); break;
      case 'kick': if (confirm('Drop this offline player from the deal?')) doAct({ type: 'kick', target: el.dataset.p }); break;
      case 'drawStock': if (canDraw()) doAct({ type: 'draw', from: 'stock' }); break;
      case 'drawDiscard':
        if (!canDraw() || !V.deal.discardTop) break;
        if (R.parse(V.deal.discardTop).s === 'J') { toast("Printed jokers can't be picked from the open pile"); break; }
        doAct({ type: 'draw', from: 'discard' }); break;
      case 'drop': if (confirm('Drop this deal? You get ' + (V.deal.lastDrawn ? 40 : 20) + ' points.')) doAct({ type: 'drop' }); break;
      case 'group': groupSelected(); break;
      case 'move': moveSelectedTo(+el.dataset.g); break;
      case 'sort': sortHand(); break;
      case 'auto': autoArrange(); break;
      case 'discard': if (sel.size === 1) { const c = [...sel][0]; sel.clear(); doAct({ type: 'discard', card: c }); } break;
      case 'declareSel': openDeclare(); break;
      case 'confirmDeclare': {
        const c = [...sel][0]; modal = null; sel.clear();
        const groups = V.deal.myGroups.map(g => g.filter(id => id !== c)).filter(g => g.length);
        doAct({ type: 'declare', card: c, groups }); break;
      }
      case 'scores': modal = 'scores'; renderModal(); break;
      case 'menu': modal = 'menu'; renderModal(); break;
      case 'rules': modal = 'rules'; renderModal(); break;
      case 'close': modal = null; renderModal(); render(); break;
    }
  });
  // desktop shortcut: double-click a card to throw it
  document.addEventListener('dblclick', ev => {
    const cardEl = ev.target.closest('#hand [data-card]');
    if (cardEl && canThrow()) { const id = cardEl.dataset.card; sel.clear(); doAct({ type: 'discard', card: id }); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'code') { const b = document.querySelector('[data-a=join]'); b && b.click(); }
    if (e.key === 'Escape' && modal) { modal = null; renderModal(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (mode === 'guest' && (!hostConn || !hostConn.open)) connectGuest();
    if (mode === 'host') { if (!peer || peer.destroyed) openHostPeer(); else if (peer.disconnected) peer.reconnect(); }
    if (V && V.phase === 'play') requestWake();
  });
  window.addEventListener('online', () => { if (mode === 'guest' && (!hostConn || !hostConn.open)) connectGuest(); });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!drag) render(); }, 120); });

  // ---------- turn countdown ----------
  setInterval(() => {
    if (!deadline || !V || !V.deal) return;
    const left = Math.max(0, deadline - performance.now()), secs = Math.ceil(left / 1000);
    document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = secs + 's'; el.classList.toggle('low', secs <= 10); });
    document.querySelectorAll('[data-timerbar]').forEach(el => { el.style.width = (100 * left / V.deal.turnMs) + '%'; el.classList.toggle('low', secs <= 10); });
    if (isMyTurn() && secs <= 10 && !warned) { warned = true; if (navigator.vibrate) navigator.vibrate([60, 60, 60]); toast('10 seconds left!'); }
  }, 250);

  // ---------- boot ----------
  (function boot() {
    const last = store.get('last');
    const linkCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if (linkCode) { screen = 'friends'; if (last && last.mode === 'guest' && last.code === linkCode && myName && !last.paused) { guestJoin(linkCode); return; } render(); return; }
    if (last && myName && !last.paused) {
      if (last.mode === 'solo' && store.get('soloGame')) { const g = store.get('soloGame'); seenDeal = g.deal ? g.deal.id : 0; seenSeq = g.seq; arrangedDeal = g.deal ? g.deal.id : -1; soloStart(g); return; }
      if (last.mode === 'host' && store.get('hostGame')) { hostStart(store.get('hostGame')); return; }
      if (last.mode === 'guest') { guestJoin(last.code); return; }
    }
    render();
  })();
})();
