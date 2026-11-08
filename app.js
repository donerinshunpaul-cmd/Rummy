/* Rummy Room — app: Play with AI (offline) or Play with Friends (room codes, peer-to-peer).
   Includes drag & drop, card animations and responsive layout. */
(function () {
  'use strict';
  const R = window.Rules;
  const PREFIX = 'rummyroom-v2-';
  // PeerJS library, with a second CDN in case the first is slow or blocked
  const PEERJS_URLS = ['https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'];
  // Free public STUN servers. Relay (TURN) servers come from turn.js; they let phones on mobile data connect.
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const NET_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'];
  const HB_PING_MS = 4000;      // host → guests heartbeat
  const HB_OFFLINE_MS = 15000;  // no word for this long = shown as offline
  const HB_DEAD_MS = 45000;     // host closes a connection that has been silent this long
  const JOIN_TIMEOUT_MS = 25000;

  // ---------- storage & utils ----------
  // Testing switch: ?as=Name makes that tab a separate player (own id, name and saved games) in the same browser.
  const AS = (new URLSearchParams(location.search).get('as') || '').replace(/[^\w-]/g, '').slice(0, 16);
  const NS = 'rr-' + (AS ? AS + '-' : '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) {} }
  };
  // Invite links carry the room code after '#', which never reaches the web host's server logs. Old ?room= links still work.
  function linkRoomCode() {
    const m = (location.hash || '').replace(/^#/, '').match(/^(?:room=)?([A-Za-z0-9]{4,6})$/);
    return ((m && m[1]) || new URLSearchParams(location.search).get('room') || '').toUpperCase();
  }
  let linkCode = linkRoomCode();
  function clearLinkFromUrl() {   // keep the address bar clean once the code has been used
    const u = new URL(location.href);
    if (!u.hash && !u.searchParams.has('room')) return;
    u.searchParams.delete('room'); u.hash = '';
    try { history.replaceState(null, '', u.pathname + u.search); } catch (e) {}
  }
  const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  const genCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[R.secureInt(31)]).join('');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FAST = /[?&]fast=1/.test(location.search); // test switch only
  if (FAST) { R.setTurnMs(6000); R.setShowMs(8000); }
  const inDealPhase = ph => ph === 'play' || ph === 'show';   // 'show': someone declared, the others group their cards
  const wait = (a, b) => (a + Math.random() * (b - a)) / (FAST ? 8 : 1);

  let myId = store.get('pid'); if (!myId) { myId = rid(12); store.set('pid', myId); }
  let myName = store.get('name', AS);

  // ---------- state ----------
  let mode = null;          // 'solo' | 'host' | 'guest' | null
  let screen = 'home';      // when mode is null: 'home' | 'ai' | 'friends'
  let code = null, G = null, V = null;
  let peer = null, hostConn = null, retryTimer = null, botTimer = null;
  const conns = new Map();
  let sel = new Set();
  let modal = null, lastModal = '';
  let nBots = store.get('nbots', 2);
  let matchDeals = store.get('deals', 0);           // 0 = unlimited, else fixed (min 3)
  let botSpeed = store.get('botspeed', 'normal');     // 'quick' | 'normal' | 'slow'
  // computer pauses in ms: draw = before picking, think = before throwing, long = [chance, extra ms] of a longer think
  const BOT_PACE = {
    quick: { draw: [800, 1600], think: [700, 1600], long: [0.15, 800] },
    normal: { draw: [1300, 2300], think: [1800, 3400], long: [0.2, 1500] },
    slow: { draw: [2200, 3600], think: [3000, 5500], long: [0.25, 2500] }
  };
  const SPEED_LABEL = { quick: 'Quick', normal: 'Normal', slow: 'Slow' };
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
  function loadScript(src, ms) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      const t = setTimeout(() => { fail(new Error('timeout')); }, ms);
      s.onload = () => { clearTimeout(t); if (window.Peer) ok(); else fail(new Error('no Peer')); };
      s.onerror = () => { clearTimeout(t); s.remove(); fail(new Error('offline')); };
      document.head.appendChild(s);
    });
  }
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    if (!peerLoading) {
      peerLoading = PEERJS_URLS.reduce((p, url) => p.catch(() => (window.Peer ? undefined : loadScript(url, 10000))), Promise.reject(new Error('start')))
        .catch(e => { peerLoading = null; if (window.Peer) return; throw e; });
    }
    return peerLoading;
  }
  // STUN + relay servers. turn.js can list relay servers directly (RUMMY_TURN) or give a URL that returns them (RUMMY_TURN_URL).
  let iceList = null;
  function iceServers() {
    if (iceList) return iceList;
    const fixed = Array.isArray(window.RUMMY_TURN) ? window.RUMMY_TURN.filter(s => s && s.urls) : [];
    const url = typeof window.RUMMY_TURN_URL === 'string' ? window.RUMMY_TURN_URL.trim() : '';
    let fetched = Promise.resolve([]);
    if (url) {
      const ctl = window.AbortController ? new AbortController() : null;
      const t = setTimeout(() => ctl && ctl.abort(), 6000);
      fetched = fetch(url, ctl ? { signal: ctl.signal } : {}).then(r => r.json()).then(l => (Array.isArray(l) ? l.filter(s => s && s.urls) : []))
        .catch(() => { iceList = null; return []; }).finally(() => clearTimeout(t));
    }
    iceList = fetched.then(extra => STUN.concat(fixed, extra));
    return iceList;
  }
  const peerOpts = ice => ({ config: { iceServers: ice }, debug: 1 });

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
    if (mode !== 'host' || !G || !inDealPhase(G.phase) || !G.deal || !G.deal.turnEnds) return;
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
    // human-like pauses: a moment to look at the open card, longer to decide what to throw, now and then a long think
    const pace = BOT_PACE[botSpeed] || BOT_PACE.normal;
    const ms = D.step === 'draw' ? wait(pace.draw[0], pace.draw[1])
      : wait(pace.think[0], pace.think[1]) + (Math.random() < pace.long[0] ? pace.long[1] / (FAST ? 8 : 1) : 0);
    botTimer = setTimeout(() => {
      botTimer = null;
      if (mode !== 'solo' || !G.deal || G.deal.order[G.deal.turn] !== pid) return;
      R.botStep(G, pid);
      commit();
    }, ms);
  }

  // ---------- ROOM ADDRESSES & HAND-OVER ----------
  // A room's address is its code. One other player is the backup host: the host keeps that phone updated with the game.
  // If the host leaves or vanishes, the backup takes over at the next address (CODE-1, CODE-2, …) and also claims the
  // plain code again, so players can still join with it. Everyone else finds the new host by trying both addresses.
  const roomAddr = e => PREFIX + code + (e ? '-' + e : '');
  const GRACE_MS = 10000;   // how long players wait for a vanished host before the backup takes over
  const onlineCount = () => (G ? G.players.filter(p => !p.bot && p.online).length : 0);
  // two devices both hosting the same room (rare race): the one with more players keeps it, then the newer one
  const probeWins = (a, b) => (a.n !== b.n ? a.n > b.n : (a.epoch || 0) !== (b.epoch || 0) ? (a.epoch || 0) > (b.epoch || 0) : String(a.pid) > String(b.pid));

  // ---------- HOST ----------
  let deputyPid = null, snapTimer = null, basePeer = null, baseTimer = null, prevAddr = null, probeUntil = 0, lastProbe = 0, hostLeaving = false;
  async function hostStart(resume) {
    try { await loadPeer(); } catch (e) { toast('Play with Friends needs an internet connection.'); return; }
    clearLinkFromUrl();
    if (resume) {   // coming back to a saved room: if another player took it over meanwhile, join them instead
      code = resume.code;
      status('Checking room ' + code + '…');
      const live = await findLiveHost(resume.epoch || 0);
      status('');
      if (mode) return;
      if (live) { nlog('room is hosted elsewhere now → ' + live); store.del('hostGame'); guestJoin(resume.code, live); toast('Someone else is hosting now — joining as a player'); return; }
      probeUntil = Date.now() + 600000; lastProbe = 0;   // keep checking for a newer host that the first check missed
    }
    hostBegin(resume || Object.assign(R.newGame(genCode(), { id: myId, name: myName }), { matchDeals }));
  }
  function hostBegin(g) {
    mode = 'host'; G = g; code = G.code;
    G.players.forEach(p => { p.online = p.id === myId; });
    if (G.deal && inDealPhase(G.phase) && G.deal.turnEnds) G.deal.turnEnds = Date.now() + (G.phase === 'show' ? R.SHOW_MS : R.TURN_MS); // fresh time after a pause
    store.set('last', { mode: 'host', code });
    openHostPeer(); commit();
  }
  // Ask some room addresses whether a host already runs there. Resolves with that host's reply (+ addr) if it should
  // keep the room rather than us, else null (nobody there, or we have the better claim).
  function probeAddrs(targets, mine, ms) {
    return new Promise(resolve => {
      let done = false, dead = 0, p = null;
      const finish = r => { if (done) return; done = true; clearTimeout(t); setTimeout(() => { try { p && p.destroy(); } catch (x) {} }, 300); resolve(r); };
      const t = setTimeout(() => finish(null), ms || 5000);
      iceServers().then(ice => {
        if (done) return;
        p = new Peer(peerOpts(ice));
        p.on('open', () => targets.forEach(addr => {
          const c = p.connect(addr, { reliable: true });
          c.on('open', () => c.send({ t: 'probe', n: mine.n, epoch: mine.epoch, pid: myId }));
          c.on('data', m => { if (m && m.t === 'probe' && m.pid !== myId) { nlog('probe: ' + addr.slice(PREFIX.length) + ' has ' + m.n + ' online'); finish(probeWins(mine, m) ? null : Object.assign({ addr }, m)); } });
        }));
        p.on('error', err => {
          nlog('probe error ' + err.type);
          if (err.type === 'peer-unavailable') { if (++dead >= targets.length) finish(null); }
          else if (!NET_ERRORS.includes(err.type)) finish(null);   // a server hiccup: keep waiting for answers until the timeout
        });
      });
    });
  }
  function findLiveHost(e) {   // before reopening a saved room: is it already hosted at the next address or the plain code?
    return probeAddrs([...new Set([roomAddr(e + 1), roomAddr(0)])], { n: 1, epoch: e, pid: myId }, 8000).then(r => (r ? r.addr : null));
  }
  // The room lives on the host's PeerJS id. The PeerJS server is only needed for new joins: if the host's link to it
  // drops, games already connected keep running, so we reconnect quietly and never tear down players' connections.
  let hostGen = 0, hostRetryTimer = null, lastPing = 0;
  function hostConnection(conn) {
    conn.on('data', m => onHostMsg(conn, m));
    conn.on('close', () => dropConn(conn));
    conn.on('error', () => dropConn(conn));
  }
  function openHostPeer() {
    if (mode !== 'host') return;
    clearTimeout(hostRetryTimer); hostRetryTimer = null;
    const my = ++hostGen;
    if (!conns.size) status('Opening room…');
    iceServers().then(ice => {
      if (my !== hostGen || mode !== 'host') return;
      if (peer && !peer.destroyed) peer.destroy();
      const p = peer = new Peer(roomAddr(G.epoch || 0), peerOpts(ice));
      p.on('open', () => { if (p !== peer) return; p.rrOpened = true; status(''); nlog('hosting at ' + p.id.slice(PREFIX.length)); });
      p.on('connection', hostConnection);
      if (G.epoch) claimBase(ice);
      p.on('disconnected', () => { if (p === peer) hostServerRetry(p, 1500); });
      p.on('error', e => {
        if (p !== peer || mode !== 'host') return;
        if (e.type === 'unavailable-id') { p.rrTaken = true; hostServerRetry(p, p.rrOpened ? 5000 : 1500); }
        else if (NET_ERRORS.includes(e.type)) hostServerRetry(p, 3000);
        else console.warn('peer error', e.type);
      });
    });
  }
  function hostServerRetry(p, ms) {
    if (hostRetryTimer) return;
    hostRetryTimer = setTimeout(() => {
      hostRetryTimer = null;
      if (mode !== 'host' || p !== peer) return;
      if (p.destroyed) {   // first open failed: our address is taken
        status('Reopening room ' + code + '… (can take up to a minute)');
        if (!p.rrTaken) { openHostPeer(); return; }
        // is it a live host (another player took the room over), or just our own old connection the server hasn't dropped yet?
        const e = G.epoch || 0;
        probeAddrs([roomAddr(e)], { n: onlineCount(), epoch: e, pid: myId }, 6000).then(r => {
          if (mode !== 'host' || p !== peer) return;
          if (r) stepDown(r.epoch || 0); else hostRetryTimer = setTimeout(() => { hostRetryTimer = null; openHostPeer(); }, 2500);
        });
      } else if (p.disconnected) {
        if (!conns.size) status('Reconnecting…');
        try { p.reconnect(); } catch (x) { openHostPeer(); }
      }
    }, ms);
  }
  function claimBase(ice) {   // after a takeover: also answer on the plain room code, for players joining with it
    clearTimeout(baseTimer); baseTimer = null;
    if (mode !== 'host' || !G.epoch || (basePeer && !basePeer.destroyed)) return;
    const b = basePeer = new Peer(roomAddr(0), peerOpts(ice));
    b.on('open', () => nlog('also answering at ' + code));
    b.on('connection', hostConnection);
    const again = () => {
      clearTimeout(baseTimer);
      baseTimer = setTimeout(() => {
        if (b !== basePeer || mode !== 'host') return;
        if (b.destroyed) { basePeer = null; claimBase(ice); }
        else if (b.disconnected) { try { b.reconnect(); } catch (x) { b.destroy(); basePeer = null; claimBase(ice); } }
      }, 6000);
    };
    b.on('disconnected', () => { if (b === basePeer) again(); });
    b.on('error', e => { if (b === basePeer && (e.type === 'unavailable-id' || NET_ERRORS.includes(e.type))) again(); });
  }
  function hostProbeTick() {   // after a takeover or a resume, look for another device that also hosts this room
    if (mode !== 'host' || !peer || !peer.open || Date.now() > probeUntil || Date.now() - lastProbe < 10000) return;
    lastProbe = Date.now();
    const e = G.epoch || 0, mine = [roomAddr(e)].concat(basePeer && basePeer.open ? [roomAddr(0)] : []);
    [...new Set([prevAddr, roomAddr(e + 1), roomAddr(0)])].filter(a => a && !mine.includes(a)).forEach(addr => {
      const c = peer.connect(addr, { reliable: true });
      const t = setTimeout(() => { try { c.close(); } catch (x) {} }, 6000);
      c.on('open', () => c.send({ t: 'probe', n: onlineCount(), epoch: G.epoch || 0, pid: myId }));
      c.on('data', m => {
        if (!m || m.t !== 'probe' || m.pid === myId) return;
        clearTimeout(t); setTimeout(() => { try { c.close(); } catch (x) {} }, 300);
        if (mode === 'host' && !probeWins({ n: onlineCount(), epoch: G.epoch || 0, pid: myId }, m)) stepDown(m.epoch || 0);
      });
    });
  }
  function stepDown(e) {   // another device runs this room with more players: hand our players over and join it
    if (mode !== 'host') return;
    const addr = roomAddr(e), c = code;
    nlog('another host has the room → joining ' + addr.slice(PREFIX.length));
    for (const x of conns.values()) { try { x.conn.send({ t: 'moved', addr }); } catch (y) {} }
    setTimeout(() => { if (mode !== 'host' || code !== c) return; leave('end'); guestJoin(c, addr); }, 700);
  }
  function pickDeputy() {   // the backup host: a connected player whose app is open on screen; keep the current one while it qualifies
    const live = pid => [...conns.values()].find(e => e.pid === pid && e.conn.open && e.hb && !e.quiet);
    const ok = pid => { const p = G.players.find(x => x.id === pid); return p && !p.bot && p.online && pid !== myId && !!live(pid); };
    const awake = pid => ok(pid) && live(pid).vis !== false;   // a phone with the app in the background may be paused and can't take over
    if (deputyPid && awake(deputyPid)) return deputyPid;
    const p = G.players.find(x => awake(x.id)) || (deputyPid && ok(deputyPid) ? { id: deputyPid } : G.players.find(x => ok(x.id)));
    return p ? p.id : null;
  }
  function scheduleSnap(now) {
    if (!deputyPid) return;
    if (now) { clearTimeout(snapTimer); snapTimer = null; sendSnap(); return; }
    if (!snapTimer) snapTimer = setTimeout(() => { snapTimer = null; sendSnap(); }, 400);
  }
  function sendSnap() {   // the backup host's copy of the whole game, so it can carry on if we disappear
    if (mode !== 'host' || !deputyPid) return;
    for (const e of conns.values()) if (e.pid === deputyPid && e.conn.open) { try { e.conn.send({ t: 'snap', g: G }); } catch (x) {} return; }
  }
  function hostLeave(kind) {   // 'handover': the backup host carries on; 'end': close the room for everyone
    if (mode !== 'host') return;
    const open = [...conns.values()].filter(x => x.conn.open).map(x => x.conn);
    const c = code, next = (G.epoch || 0) + 1, handing = kind === 'handover' && !!deputyPid;
    hostLeaving = true;   // from here on nothing changes: no new backup host, no new copies of the game
    if (handing) sendSnap();
    for (const x of open) { try { x.send(kind === 'end' ? { t: 'ended' } : { t: 'bye', epoch: next, deputy: deputyPid }); } catch (y) {} }
    status(kind === 'end' ? 'Ending the room…' : 'Handing the room over…');
    whenFlushed(open, 1500).then(() => {
      if (mode !== 'host' || code !== c) return;
      if (kind === 'end') { leave('end'); return; }
      if (handing) { store.del('hostGame'); lastEpoch = next; }
      leave('pause');
      if (handing) store.set('last', { mode: 'guest', code: c, epoch: next, paused: true });
      render();
    });
  }
  function whenFlushed(cs, max) {   // wait until queued messages have left, so closing doesn't cut them off
    return new Promise(res => {
      const t0 = Date.now();
      (function chk() {
        const busy = cs.some(c => c.open && ((c.dataChannel && c.dataChannel.bufferedAmount) || c.bufferSize));
        if (!busy || Date.now() - t0 > max) setTimeout(res, 200); else setTimeout(chk, 50);
      })();
    });
  }
  function setOnline(pid, on) {
    const p = G && G.players.find(x => x.id === pid);
    if (!p || p.online === on) return false;
    if (!on && [...conns.values()].some(x => x.pid === pid && x.conn.open && !x.quiet)) return false;
    p.online = on; return true;
  }
  function onHostMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    const e = conns.get(conn.connectionId);
    if (e) {
      e.seen = Date.now();
      if (m.t === 'pong') { e.hb = true; e.vis = m.vis !== false; if (pickDeputy() !== deputyPid) publish(); }   // publish moves the backup host role
      if (e.quiet) { e.quiet = false; if (setOnline(e.pid, true)) publish(); }
    }
    if (m.t === 'probe') {   // another device also thinks it hosts this room
      if (m.pid === myId) return;
      const mine = { n: onlineCount(), epoch: G.epoch || 0, pid: myId };
      try { conn.send({ t: 'probe', n: mine.n, epoch: mine.epoch, pid: myId }); } catch (y) {}
      if (!probeWins(mine, m)) setTimeout(() => stepDown(m.epoch || 0), 300);
      return;
    }
    if (m.t === 'join') {
      const err = R.addPlayer(G, String(m.pid).slice(0, 20), String(m.name || 'Player').slice(0, 16));
      if (err) { conn.send({ t: 'err', msg: err, fatal: true }); return; }
      for (const [k, x] of conns) if (x.pid === m.pid && x.conn !== conn) { conns.delete(k); try { x.conn.close(); } catch (y) {} }
      conns.set(conn.connectionId, { conn, pid: m.pid, seen: Date.now(), hb: false, quiet: false });
      commit();
      try { conn.send({ t: 'ping' }); } catch (y) {}
    } else if (m.t === 'act') {
      if (!e) return;
      const err = R.act(G, e.pid, m.a || {});
      if (err) conn.send({ t: 'err', msg: err });
      commit();
    } else if (m.t === 'hi') {   // a guest's app came back to the foreground: send a fresh view
      if (e && conn.open) { try { conn.send({ t: 'state', v: viewFor(e.pid) }); } catch (y) {} }
    }
  }
  function dropConn(conn) {
    const e = conns.get(conn.connectionId); if (!e) return;
    conns.delete(conn.connectionId);
    if (setOnline(e.pid, false)) publish();
  }
  function hostTick() {   // heartbeat: ping guests, mark silent ones offline, clean up dead connections
    if (mode !== 'host' || !G) return;
    const now = Date.now(), ping = now - lastPing >= HB_PING_MS;
    if (ping) lastPing = now;
    let changed = false;
    for (const [k, e] of conns) {
      const silent = now - e.seen;
      if (!e.conn.open || (e.hb && silent > HB_DEAD_MS)) { conns.delete(k); try { e.conn.close(); } catch (x) {} if (setOnline(e.pid, false)) changed = true; continue; }
      if (ping) { try { e.conn.send({ t: 'ping' }); } catch (x) {} }
      if (e.hb && silent > HB_OFFLINE_MS && !e.quiet) { e.quiet = true; if (setOnline(e.pid, false)) changed = true; }
    }
    if (changed) publish();
  }
  function viewFor(pid) {
    const v = R.view(G, pid);
    if (mode === 'host') { v.epoch = G.epoch || 0; v.deputy = deputyPid; }
    return v;
  }
  function publish() {
    if (mode === 'host' && hostLeaving) return;
    if (mode === 'host') { const d = pickDeputy(); if (d !== deputyPid) { deputyPid = d; scheduleSnap(true); } else scheduleSnap(false); }
    for (const e of conns.values()) if (e.conn.open) { try { e.conn.send({ t: 'state', v: viewFor(e.pid) }); } catch (x) {} }
    setView(viewFor(myId));
  }

  // ---------- GUEST ----------
  // Each connection attempt gets a number; handlers from older attempts are ignored, so a late timer or close event
  // from a previous try can never tear down the connection that is working now.
  let attempt = 0, attemptAt = 0, lastHeard = 0, hostHb = false, join = null;
  const netLog = [];   // recent connection events; type rrNetLog() in the browser console to see them
  function nlog(msg) { netLog.push(new Date().toISOString().slice(11, 19) + ' ' + msg); if (netLog.length > 60) netLog.shift(); }
  window.rrNetLog = () => netLog.slice();
  function newJoinInfo() { return { tries: 0, notFound: 0, noRoute: 0, step: 'Loading…' }; }
  let snap = null, lostAt = 0, handover = false, handoverTo = null, prefAddr = null, lastEpoch = 0;
  async function guestJoin(c, pref) {
    const last = store.get('last');
    lastEpoch = last && last.code === c ? last.epoch || 0 : 0;
    mode = 'guest'; code = c; V = null; join = newJoinInfo(); hostHb = false;
    snap = null; lostAt = 0; handover = false; handoverTo = null; prefAddr = pref || null;
    store.set('last', { mode: 'guest', code, epoch: lastEpoch });
    clearLinkFromUrl();
    status(''); render();
    try { await loadPeer(); } catch (e) {
      if (mode === 'guest' && code === c && !V) { leave('pause'); toast("Couldn't load the online part of the app. Check your internet and try again."); }
      return;
    }
    if (mode !== 'guest' || code !== c) return;
    connectGuest();
  }
  function joinStep(msg) {   // progress text: on the joining screen before the first view, in the status bar after
    if (!join) return;
    join.step = msg;
    if (!V) render(); else status(msg);
  }
  // where the host might be: a forwarded address, the current one, the next one (after a hand-over), and the plain code
  function guestTargets() {
    const e = V ? V.epoch || 0 : lastEpoch;
    return [...new Set([prefAddr, roomAddr(e), roomAddr(e + 1), roomAddr(0)].filter(Boolean))];
  }
  const deputyName = () => { const d = V && V.deputy && V.players.find(p => p.id === V.deputy); return d ? d.name : ''; };
  function lostText() {
    if (!lostAt) return 'Reconnecting…';
    const d = deputyName();
    if (handover || Date.now() - lostAt >= GRACE_MS) return d && V.deputy !== myId ? 'The host left — moving the game to ' + d + '…' : 'Host is offline — waiting for them to come back…';
    return 'Host disconnected — reconnecting…';
  }
  function canTakeOver() {   // on a hand-over only the named backup host may take over; otherwise the last one we heard of
    return mode === 'guest' && !!V && (handover ? handoverTo === myId : V.deputy === myId) && !!snap && snap.code === code &&
      !!lostAt && navigator.onLine !== false && (handover || Date.now() - lostAt >= GRACE_MS);
  }
  function takeOver() {   // we are the backup host and the host is gone: carry on with our copy of the game
    const g = snap, prev = g.epoch || 0, oldHost = g.hostId;
    nlog('taking over as host (address ' + (prev + 1) + ')');
    attempt++; clearTimeout(retryTimer); retryTimer = null;
    if (peer && !peer.destroyed) peer.destroy();
    peer = null; hostConn = null; join = null; snap = null; lostAt = 0; handover = false; prefAddr = null;
    g.epoch = prev + 1; g.hostId = myId;
    const me = g.players.find(p => p.id === myId); if (me && myName) me.name = myName;
    const oldName = (g.players.find(p => p.id === oldHost) || {}).name || 'The host';
    if (g.deal && g.deal.log) { g.deal.log.push(oldName + ' left — ' + (me ? me.name : 'a player') + ' is now hosting.'); while (g.deal.log.length > 8) g.deal.log.shift(); }
    prevAddr = PREFIX + g.code + (prev ? '-' + prev : ''); probeUntil = Date.now() + 10 * 60000; lastProbe = 0;
    status('');
    hostBegin(g);
    toast(oldName + ' left — you are now the host');
  }
  function connectGuest() {
    if (mode !== 'guest') return;
    clearTimeout(retryTimer); retryTimer = null;
    if (canTakeOver()) { takeOver(); return; }
    const my = ++attempt; attemptAt = Date.now();
    if (peer && !peer.destroyed) peer.destroy();
    peer = null; hostConn = null;
    join.tries++;
    joinStep(V ? lostText() : join.notFound ? 'Looking for room ' + code + '…' : 'Contacting the room server…');
    const targets = guestTargets();
    iceServers().then(ice => {
      if (my !== attempt || mode !== 'guest') return;
      const p = peer = new Peer(peerOpts(ice));
      const tries = [], dead = new Set();
      let conn = null, started = false;
      nlog('#' + my + ' start → ' + targets.map(a => a.slice(PREFIX.length)).join(' / '));
      // After 10 s: if no host answered, the room isn't there (the server doesn't always say so).
      // If one did answer, the phones are still trying to find a network path: give that the full 25 s.
      const answered = () => tries.some(c => c.peerConnection && c.peerConnection.remoteDescription);
      let openTimer = setTimeout(function check() {
        if (my !== attempt || conn) return;
        if (answered() && Date.now() - attemptAt < JOIN_TIMEOUT_MS) { openTimer = setTimeout(check, JOIN_TIMEOUT_MS - (Date.now() - attemptAt)); return; }
        const why = answered() ? 'noroute' : started ? 'notfound' : 'server';
        nlog('#' + my + ' timeout: ' + why);
        if (why === 'noroute') join.noRoute++; else if (why === 'notfound') join.notFound++;
        guestRetry(my, why);
      }, 10000);
      p.on('open', () => {
        if (my !== attempt || started) return;   // 'open' repeats after a server reconnect; keep the existing connection
        started = true;
        joinStep(V ? lostText() : join.notFound ? 'Looking for room ' + code + '…' : "Connecting to the host's phone…");
        targets.forEach(addr => {
          const c = p.connect(addr, { reliable: true });
          tries.push(c);
          c.on('open', () => {
            if (my !== attempt || conn) { try { c.close(); } catch (x) {} return; }
            conn = hostConn = c; prefAddr = null;
            tries.forEach(x => { if (x !== c) { try { x.close(); } catch (y) {} } });
            nlog('#' + my + ' connected to ' + addr.slice(PREFIX.length));
            clearTimeout(openTimer); join.tries = 0; join.notFound = 0; join.noRoute = 0; lastHeard = Date.now(); lostAt = 0; handover = false;
            status('');
            c.send({ t: 'join', pid: myId, name: myName });
          });
          c.on('data', m => { if (my === attempt && c === conn) { lastHeard = Date.now(); onGuestMsg(m); } });
          c.on('close', () => { if (c !== conn) return; nlog('#' + my + ' conn closed' + (my === attempt ? '' : ' (old)')); if (my === attempt) guestRetry(my, 'closed'); });
          c.on('error', e => {
            nlog('#' + my + ' conn error ' + (e && e.type) + ' at ' + addr.slice(PREFIX.length));
            if (my !== attempt || conn) return;
            dead.add(addr);
            if (dead.size >= targets.length) { clearTimeout(openTimer); guestRetry(my, 'closed'); }
          });
        });
      });
      p.on('error', e => {
        nlog('#' + my + ' peer error ' + e.type + (my === attempt ? '' : ' (old)'));
        if (my !== attempt || mode !== 'guest') return;
        if (e.type === 'peer-unavailable') {   // one address has no host; give up only when none has
          if (conn) return;
          const msg = String(e.message || '');
          dead.add(targets.find(a => msg.endsWith(' ' + a)) || targets.find(a => !dead.has(a)));
          if (dead.size >= targets.length) { clearTimeout(openTimer); join.notFound++; guestRetry(my, 'notfound'); }
          return;
        }
        if (conn && conn.open) return;   // only the link to the PeerJS server dropped; the game connection is fine
        clearTimeout(openTimer);
        if (e.type === 'webrtc' || e.type === 'negotiation-failed') join.noRoute++;
        guestRetry(my, NET_ERRORS.includes(e.type) ? 'server' : 'noroute');
      });
    });
  }
  function guestRetry(my, why) {
    if (my !== attempt || mode !== 'guest' || retryTimer) return;
    nlog('#' + my + ' retry: ' + why);
    attempt++;   // retire this attempt right away
    if (peer && !peer.destroyed) peer.destroy();
    peer = null; hostConn = null;
    if (V && !lostAt) lostAt = Date.now();
    if (canTakeOver()) { takeOver(); return; }
    if (!V && why === 'notfound' && join.notFound >= 5) {
      const c = code; leave('end'); screen = 'friends'; render();
      toast('Room ' + c + ' not found. Check the code, and make sure the host has the app open.'); return;
    }
    let delay = Math.min(10000, Math.round(1200 * Math.pow(1.5, Math.min(join.tries, 6))));
    if (lostAt && Date.now() - lostAt < 60000) delay = Math.min(delay, 2000);   // the room may be moving to a new host: look often
    joinStep(V ? (why === 'noroute' ? 'Connection lost — trying again…' : lostText())
      : why === 'notfound' ? 'Looking for room ' + code + '…'
      : why === 'noroute' ? "Can't reach the host's phone yet — trying again…" : 'Connection problem — trying again…');
    retryTimer = setTimeout(() => { retryTimer = null; connectGuest(); }, delay);
  }
  function guestWake() {   // app back in front, or network back
    if (mode !== 'guest' || !join) return;
    nlog('wake (' + (hostConn && hostConn.open ? 'connected' : 'not connected') + ')');
    if (hostConn && hostConn.open) {
      try { hostConn.send({ t: 'hi' }); } catch (x) {}
      if (hostHb) lastHeard = Date.now() - (HB_OFFLINE_MS - 5000);   // no reply within ~6 s → reconnect
    } else if (retryTimer || Date.now() - attemptAt > 8000) connectGuest();
  }
  function guestTick() {   // the host pings every few seconds; long silence means the connection is dead
    if (mode !== 'guest') return;
    if (canTakeOver()) { takeOver(); return; }
    if (V && lostAt && !hostConn) status(lostText());
    if (!hostHb || !hostConn || !hostConn.open) return;   // also while hidden: the backup host must notice a vanished host
    if (Date.now() - lastHeard > HB_OFFLINE_MS + 1000) guestRetry(attempt, 'silent');
  }
  function sendPong() {   // tells the host we're here, and whether the app is on screen (used to choose the backup host)
    try { hostConn && hostConn.open && hostConn.send({ t: 'pong', vis: document.visibilityState === 'visible' }); } catch (x) {}
  }
  function onGuestMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { hostHb = true; sendPong(); return; }
    if (m.t === 'state') setView(m.v);
    else if (m.t === 'snap') { if (!snap && m.g) nlog('I am the backup host'); snap = m.g || null; }   // keep the latest copy of the game
    else if (m.t === 'bye') {   // the host left on purpose and handed the room to the backup host
      nlog('host left; backup host is ' + (m.deputy === myId ? 'me' : m.deputy));
      handover = true; handoverTo = m.deputy || null; lostAt = lostAt || Date.now(); prefAddr = roomAddr(m.epoch || 0);
      if (canTakeOver()) takeOver(); else status(lostText());
    } else if (m.t === 'moved') { prefAddr = m.addr; nlog('room moved → ' + String(m.addr).slice(PREFIX.length)); }
    else if (m.t === 'ended') { const c = code; leave('end'); toast('The host ended room ' + c + '.'); }
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
    clearTimeout(hostRetryTimer); hostRetryTimer = null;
    clearTimeout(snapTimer); snapTimer = null; clearTimeout(baseTimer); baseTimer = null;
    attempt++; hostGen++; join = null; hostHb = false;
    deputyPid = null; snap = null; lostAt = 0; handover = false; handoverTo = null; prefAddr = null; prevAddr = null; probeUntil = 0; hostLeaving = false;
    if (peer && !peer.destroyed) peer.destroy();
    if (basePeer && !basePeer.destroyed) basePeer.destroy();
    peer = null; basePeer = null; hostConn = null; conns.clear();
    if (kind === 'pause' && (was === 'host' || was === 'guest')) store.set('last', { mode: was, code: pausedCode, paused: true, epoch: lastEpoch });
    else { store.del('last'); if (was === 'host') store.del('hostGame'); if (was === 'solo') store.del('soloGame'); }
    status(''); releaseWake(); render();
  }
  let deadline = null, warned = false, prevShow = false;
  const secsLeft = () => (deadline ? Math.ceil(Math.max(0, deadline - performance.now()) / 1000) : 0);
  function setView(v) {
    const prevTurn = V && V.deal ? V.deal.turnPid + ':' + V.deal.turnLeft : '';
    V = v;
    if (mode === 'guest') {   // remember where the room lives now, and drop the game copy if we're no longer the backup host
      if (V.deputy !== myId) snap = null;
      const e = V.epoch || 0;
      if (e !== lastEpoch) { lastEpoch = e; const l = store.get('last'); if (l && l.code === code) store.set('last', Object.assign(l, { epoch: e })); }
    }
    deadline = V.deal && V.deal.turnLeft != null && inDealPhase(V.phase) ? performance.now() + V.deal.turnLeft : null;
    if (V.deal && (prevTurn.split(':')[0] !== V.deal.turnPid || (V.phase === 'show') !== prevShow)) warned = false;
    prevShow = V.phase === 'show';
    const hand = myCards();
    sel.forEach(id => { if (!hand.includes(id)) sel.delete(id); });
    const mine = isMyTurn();
    if (mine && !lastTurnMine && navigator.vibrate) navigator.vibrate(40);
    lastTurnMine = mine;
    if (inDealPhase(V.phase)) requestWake();
    render();
    maybeArrangeDealt();
  }
  function maybeArrangeDealt() {   // new hands arrive as dealt; a moment later they're sorted by suit
    if (!V || V.phase !== 'play' || !V.deal || !V.deal.myGroups || arrangedDeal === V.deal.id) return;
    arrangedDeal = V.deal.id;
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
  // after someone declares: do I still need to group my cards and tap Done?
  const timerMs = () => (V && V.phase === 'show' ? V.deal.showMs || R.SHOW_MS : V.deal.turnMs);
  const mustGroup = () =>!!(V && V.phase === 'show' && V.deal && V.deal.show && V.deal.myGroups && !V.deal.show.done.includes(myId));
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
  const TYPE_LABEL = { pure: 'Pure sequence', trio: 'Pure group', itrio: 'Impure group', impure: 'Sequence', set: 'Set', invalid: 'Invalid' };
  const EXTRA_SET = 'Only 1 set';   // a second set in one hand doesn't count

  // ---------- render ----------
  function render() {
    if (drag && drag.started) { deferRender = true; return; }
    const before = snapshot();
    if (!mode) { if (screen === 'ai') renderAiSetup(); else if (screen === 'friends') renderFriends(); else renderHome(); renderModal(); return; }
    if (!V) { renderJoining(); renderModal(); return; }
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
      '<div><label>Computer speed</label><div class="row">' + ['quick', 'normal', 'slow'].map(s => '<button class="seg ' + (s === botSpeed ? 'on' : '') + '" data-a="spd" data-v="' + s + '">' + SPEED_LABEL[s] + '</button>').join('') + '</div></div>' +
      matchControl('md') +
      '<button class="primary" style="width:100%" data-a="soloNew">Start new game</button>' +
      (saved && saved.phase !== 'lobby' ? '<button style="width:100%" data-a="soloResume">Continue last game (deal ' + saved.dealNo + ')</button>' : '') +
      '</div><button class="ghost small" data-a="home">← Back</button></div>';
  }
  function renderFriends() {
    const last = store.get('last');
    let resume = '';
    const hg = store.get('hostGame');
    if (hg && (!last || last.mode !== 'guest')) resume = '<button style="width:100%" data-a="resumeHost">Back to my room ' + esc(hg.code) + (hg.phase === 'play' ? ' (game in progress)' : '') + '</button>';
    else if (last && last.mode === 'guest') resume = '<button style="width:100%" data-a="rejoin">Rejoin room ' + esc(last.code) + '</button>';
    $app.innerHTML =
      '<div class="screen center"><h2>👥 Play with Friends</h2><div class="panel stack">' + nameField() + resume +
      '<button class="primary" style="width:100%" data-a="create">Create a room</button>' +
      '<div><label>Have a code?</label><div class="row"><input id="code" maxlength="5" placeholder="CODE" value="' + esc(linkCode) + '" style="text-transform:uppercase;letter-spacing:4px;text-align:center"><button data-a="join">Join</button></div></div>' +
      '</div><button class="ghost small" data-a="home">← Back</button></div>';
  }
  function renderJoining() {
    const j = join || newJoinInfo();
    let tip = '';
    if (j.noRoute) tip = "<b>Your phone can't reach the host's phone.</b> This often happens on mobile data. Try Wi-Fi (or switch Wi-Fi off and use mobile data), then tap Try again.";
    else if (j.notFound) tip = 'Room not found yet. Check the code with the host, and make sure the host has the app open on their phone.';
    $app.innerHTML = '<div class="screen center"><div class="sub">Joining room</div><div class="code">' + esc(code) + '</div>' +
      '<div class="spin" aria-hidden="true"></div><p style="min-height:22px">' + esc(j.step) + '</p>' +
      (tip ? '<div class="panel hint" style="text-align:center">' + tip + '</div>' : '') +
      '<div class="row" style="justify-content:center;margin-top:8px">' + (j.tries > 1 ? '<button data-a="retryNow">Try again now</button>' : '') + '<button class="ghost" data-a="cancelJoin">Cancel</button></div></div>';
  }
  function renderLobby() {
    const isHost = V.hostId === myId;
    const items = V.players.map(p =>
      '<li><span class="dot ' + (p.online ? 'on' : '') + '"></span><span class="grow">' + esc(p.name) + (p.id === myId ? ' <span class="tag">you</span>' : '') + (p.id === V.hostId ? ' <span class="tag">host</span>' : '') + (p.id === V.deputy ? ' <span class="tag" title="Takes over if the host leaves">backup host</span>' : '') + '</span>' +
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
      const S = V.phase === 'show' && D.show;
      if (!p.inDeal) st = 'Next deal'; else if (p.out) st = 'Dropped';
      else if (S) st = p.id === S.winner ? '<b style="color:var(--ok)">Declared ✓</b>' : S.done.includes(p.id) ? '<span style="color:var(--ok)">Done ✓</span>' : p.online ? 'Grouping…' : 'Offline';
      else if (!p.online) st = 'Offline';
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
    const S = V.phase === 'show' && D.show;
    const table = S
      ? '<div class="showbox"><div class="sub">' + (S.winner === myId ? 'Your winning hand' : esc(playerName(S.winner)) + "'s winning hand") + '</div>' + groupsHTML(S.winnerGroups) + '</div>'
      : '<div class="table">' + jslot +
      '<div class="pile ' + (canDraw() ? 'can' : '') + '" data-pile="stock" data-a="drawStock"><div class="stackwrap" id="stock">' + backHTML('') + backHTML('<span class="cnt">' + Math.max(0, D.stockCount - 1) + '</span>') + '</div>Deck</div>' +
      '<div class="pile ' + (canDraw() && top && R.parse(top).s !== 'J' ? 'can' : '') + '" data-pile="discard" data-a="drawDiscard"><div class="stackwrap" id="openpile">' +
        (under ? cardHTML(under, { cls: 'under' }) : '') + (top ? cardHTML(top, { key: 'c:' + top }) : '<div class="empty"></div>') + '</div>Open card</div>' +
      (canThrow() ? '<div class="pile"><div class="finish" data-drop="finish" data-a="declareSel">Finish</div>Drop to declare</div>' : '') +
      '</div>';

    let banner;
    if (V.phase === 'result') banner = 'Deal over';
    else if (S) banner = S.winner === myId ? 'You declared! Others are grouping their cards…'
      : mustGroup() ? '<b>' + esc(playerName(S.winner)) + ' declared!</b> Group your cards, then tap Done'
      : esc(playerName(S.winner)) + ' declared — waiting for the others…';
    else if (!inDeal) banner = 'You will be dealt in next deal';
    else if (me.out) banner = 'You dropped this deal (' + me.out + ' pts)';
    else if (mine) banner = D.step === 'draw' ? 'Your turn — pick from the Deck or the Open card' : 'Throw a card onto the Open pile, or Finish to declare';
    else { const tp = V.players.find(p => p.id === D.turnPid) || { name: '?' }; banner = tp.bot ? esc(tp.name) + ' is thinking…' : 'Waiting for ' + esc(tp.name) + '…'; }

    let hand = '';
    if (inDeal) {
      const ev = R.evaluate(D.myGroups, wrKnown());
      hand = D.myGroups.map((g, i) => {
        const inf = g.length >= 3 ? ev.info[i] : null, t = inf ? inf.type : null;
        const canMove = sel.size && g.some(id => !sel.has(id));
        return '<div class="grp" data-grp="' + i + '">' + (canMove ? '<button class="moveto" data-a="move" data-g="' + i + '">＋ here</button>' : '') +
          '<div class="cards" style="--ov:' + (g.length > 9 ? 0.64 : g.length > 6 ? 0.56 : 0.5) + '">' + g.map(id => cardHTML(id, { hand: true, key: 'c:' + id, isNew: id === D.lastDrawn && mine && D.step === 'discard' })).join('') + '</div>' +
          '<div class="glabel ' + (t || '') + '">' + (t ? (inf.extraSet ? EXTRA_SET : TYPE_LABEL[t] + (t === 'invalid' ? '' : ' ✓')) : g.length + ' card' + (g.length > 1 ? 's' : '')) + '</div></div>';
      }).join('') + '<div class="newgrp" data-drop="new">＋<br>New group</div>';
    }

    let btns = '';
    if (inDeal && !me.out) {
      const one = sel.size === 1;
      if (canDraw()) btns += '<button class="danger small" data-a="drop">Drop</button>';
      if (sel.size >= 2) btns += '<button class="small" data-a="group">Group (' + sel.size + ')</button>';
      btns += '<button class="small ghost" data-a="sort">Sort</button><button class="small ghost" data-a="auto">Auto-arrange</button>';
      if (mustGroup()) btns += '<button class="go small" data-a="showDone">Done</button>';
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
      '<div class="banner ' + (mine || mustGroup() ? 'mine' : '') + '">' + banner + (deadline && (mine || S) ? ' <span class="tmr" data-timer>' + secsLeft() + 's</span>' : '') + '</div>' +
      (deadline ? '<div class="tbar"><i data-timerbar style="width:' + (deadline ? 100 * Math.max(0, deadline - performance.now()) / timerMs() : 0) + '%"></i></div>' : '') +
      '<div class="log">' + esc(D.log[D.log.length - 1] || '') + '</div>' +
      '<div class="hand" id="hand">' + hand + '</div>' +
      '<div class="actions">' + ptsLine + btns + '</div></div>';
  }

  function groupsHTML(groups) {
    return '<div class="gs">' + groups.map(g => {
      const t = g.ids.length >= 3 ? g.type : 'invalid';
      return '<div class="g"><div class="cards">' + g.ids.map(id => cardHTML(id, { sm: true })).join('') + '</div><div class="glabel ' + t + '">' + (g.ids.length < 3 ? 'Ungrouped' : g.extraSet ? EXTRA_SET : TYPE_LABEL[t]) + '</div></div>';
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
      if (ev.pure3 < 1) why.push(ev.pure ? 'you need a pure sequence of exactly 3 cards' : 'you need a pure sequence'); if (ev.seqs < 2) why.push('you need 2 sequences'); if (ev.info.some(x => x.extraSet)) why.push('only one set is allowed'); if (ev.info.some(x => x.type === 'invalid' && !x.extraSet)) why.push('some groups are not valid');
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
        (V.solo ? '<button style="width:100%" class="ghost" data-a="spdToggle">Computer speed: ' + SPEED_LABEL[botSpeed] + '</button>' : '') +
        (isHost && !V.solo && inDealPhase(V.phase) ? '<button style="width:100%" class="ghost" data-a="toLobby">End deal & go to lobby</button>' : '') +
        '<button style="width:100%" class="danger" data-a="leave">' + (V.solo ? 'Quit game' : 'Leave (you can rejoin)') + '</button>' +
        (isHost && !V.solo ? '<button style="width:100%" class="ghost" data-a="endRoom">End room for everyone</button>' : '') +
        '<button style="width:100%" class="ghost" data-a="close">Back</button></div></div>';
    } else if (modal === 'rules') {
      html = '<div class="modal-bg"><div class="modal rules"><h2>How to play</h2>' +
        '<p><b>Cards:</b> 3 decks with 2 printed jokers each (162 cards). The deck is shuffled once before each deal and its order never changes during the deal. Cards are dealt one at a time, 13 each.</p>' +
        '<p><b>Closed joker:</b> one card is placed face-down under the deck. You see it only after you arrange your first <b>pure sequence</b> (3 or more cards). Then every card of that rank is a joker for you.</p>' +
        '<p><b>Your turn:</b> pick from the Deck or the Open card, then throw one card onto the Open pile. Drag a card onto the pile, or tap it and press Discard.</p>' +
        '<p><b>Arranging:</b> drag cards between groups, onto <b>＋ New group</b>, or select several and press Group. <b>Auto-arrange</b> finds a good grouping.</p>' +
        '<p><b>Pure sequence:</b> 3+ in a row, same suit, no joker (4♥ 5♥ 6♥). <b>Pure group:</b> 3 identical cards, same number and same suit (7♥ 7♥ 7♥), count as a pure sequence. <b>Sequence:</b> jokers may fill gaps. <b>Impure group:</b> 2 identical cards plus a joker (2♦ 2♦ ★) count as a sequence with a joker. <b>Set:</b> 3–4 of the same number, different suits (9♣ 9♦ 9♠). <b>Only one set counts per hand</b>; a second set is not valid.</p>' +
        '<p><b>To win:</b> group all 13 cards with at least 2 sequences, one of them a <b>pure sequence of exactly 3 cards</b> (a longer pure sequence still counts as your second sequence). After picking your 14th card, drag a card to <b>Finish</b> (or select it and press Declare).</p>' +
        '<p><b>Someone declared?</b> You get 45 seconds (no limit against the computer) to group your cards, then tap <b>Done</b>. Your points are counted from your final groups.</p>' +
        '<p><b>Points:</b> A K Q J = 10, number cards = face value, jokers = 0. Losers with 2 sequences (one a 3-card pure) score their ungrouped cards (min 1, max 80). Without them, a loser scores the full <b>80</b>. Wrong show = 80. Drop before your first pick = 20, later = 40. Lowest total wins.</p>' +
        '<p><b>Match:</b> play unlimited deals, or a fixed number (3 or more). In a fixed match the <b>1st and last deal score double</b>. Lowest total after the last deal wins the match.</p>' +
        '<p><b>Your cards</b> arrive sorted by suit. Drag cards to any position, inside a group or between groups.</p>' +
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
    if (newAct && la.type === 'declare' && mustGroup()) { toast(playerName(la.pid) + ' declared! Group your cards, then tap Done.'); if (navigator.vibrate) navigator.vibrate([80, 60, 80]); }
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
    if (!V || !inDealPhase(V.phase)) return;
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
    const url = location.origin + location.pathname + '#' + V.code;
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
        if (mode === 'host') {
          const d = deputyPid && G.players.find(p => p.id === deputyPid);
          if (!confirm(d ? 'Leave the room? ' + d.name + ' takes over as host and the game goes on. You can rejoin with code ' + code + '.'
            : 'Leave the room? The game pauses until you come back (Play with Friends → join with code ' + code + ').')) break;
          modal = null; clearLinkFromUrl();
          if (d) hostLeave('handover'); else leave('pause');
          break;
        }
        if (mode === 'solo' && V && inDealPhase(V.phase) && !confirm('Quit this game?')) break;
        modal = null; leave(mode === 'solo' ? 'end' : 'pause'); clearLinkFromUrl(); break;
      case 'endRoom':
        if (!confirm('End this room for everyone? Scores will be cleared.')) break;
        modal = null; clearLinkFromUrl();
        if (mode === 'host') hostLeave('end'); else leave('end');
        break;
      case 'share': share(); break;
      case 'retryNow': if (mode === 'guest' && join) { join.tries = 0; connectGuest(); } break;
      case 'cancelJoin': leave('pause'); screen = 'friends'; render(); break;
      case 'spd': keepName(); botSpeed = el.dataset.v; store.set('botspeed', botSpeed); render(); break;
      case 'spdToggle': { const order = ['quick', 'normal', 'slow']; botSpeed = order[(order.indexOf(botSpeed) + 1) % 3]; store.set('botspeed', botSpeed); lastModal = ''; renderModal(); break; }
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
      case 'showDone': sel.clear(); doAct({ type: 'showDone' }); break;
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
    if (mode === 'guest') sendPong();   // the host moves the backup host role away from a phone that leaves the app
    if (document.visibilityState !== 'visible') return;
    guestWake();
    if (mode === 'host') {
      const now = Date.now();
      for (const e of conns.values()) e.seen = Math.max(e.seen, now - (HB_OFFLINE_MS - 5000));
      lastPing = 0;
      if (!peer || peer.destroyed) openHostPeer(); else if (peer.disconnected) hostServerRetry(peer, 0);
    }
    if (V && inDealPhase(V.phase)) requestWake();
  });
  window.addEventListener('online', () => { guestWake(); if (mode === 'host' && peer && !peer.destroyed && peer.disconnected) hostServerRetry(peer, 0); });
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 6000) {   // this phone was asleep: give the others a few seconds to answer before judging them
      lastHeard = Math.max(lastHeard, now - (HB_OFFLINE_MS - 5000));
      for (const e of conns.values()) e.seen = Math.max(e.seen, now - (HB_OFFLINE_MS - 5000));
      lastPing = 0;
    }
    lastTick = now;
    guestTick(); hostTick(); hostProbeTick();
  }, 2000);
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!drag) render(); }, 120); });

  // ---------- turn countdown ----------
  setInterval(() => {
    if (!deadline || !V || !V.deal) return;
    const left = Math.max(0, deadline - performance.now()), secs = Math.ceil(left / 1000);
    document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = secs + 's'; el.classList.toggle('low', secs <= 10); });
    document.querySelectorAll('[data-timerbar]').forEach(el => { el.style.width = (100 * left / timerMs()) + '%'; el.classList.toggle('low', secs <= 10); });
    if ((isMyTurn() || mustGroup()) && secs <= 10 && !warned) { warned = true; if (navigator.vibrate) navigator.vibrate([60, 60, 60]); toast(mustGroup() ? '10 seconds left to group your cards!' : '10 seconds left!'); }
  }, 250);

  // ---------- boot ----------
  (function boot() {
    const last = store.get('last');
    window.addEventListener('hashchange', () => { const c = linkRoomCode(); if (c && !mode) { linkCode = c; screen = 'friends'; render(); } });
    if (linkCode) { screen = 'friends'; if (last && last.mode === 'guest' && last.code === linkCode && myName && !last.paused) { guestJoin(linkCode); return; } render(); return; }
    if (last && myName && !last.paused) {
      if (last.mode === 'solo' && store.get('soloGame')) { const g = store.get('soloGame'); seenDeal = g.deal ? g.deal.id : 0; seenSeq = g.seq; arrangedDeal = g.deal ? g.deal.id : -1; soloStart(g); return; }
      if (last.mode === 'host' && store.get('hostGame')) { hostStart(store.get('hostGame')); return; }
      if (last.mode === 'guest') { guestJoin(last.code); return; }
    }
    render();
  })();
})();
