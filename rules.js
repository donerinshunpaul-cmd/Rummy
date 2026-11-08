/* Rummy Room — Indian Rummy rules engine + computer player.
   13 cards · 3 decks with 2 printed jokers each · closed wild joker (revealed to a player
   after their first pure sequence) · trio (3 identical cards) counts as a pure sequence, max 1 ·
   wrong show 80 · losers score min 1, max 80 · drops 20 / 40. */
(function (root) {
  'use strict';
  const SUITS = ['S', 'H', 'C', 'D'];
  const RANK_LABEL = ['★', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUIT_SYM = { S: '♠', H: '♥', C: '♣', D: '♦', J: '★' };
  const MAX_PLAYERS = 6, DECKS = 3;
  const FULL_COUNT = 80, FIRST_DROP = 20, MIDDLE_DROP = 40, MIN_LOSS = 1;
  const NO_WILD = -1;
  let TURN_MS = 45000;   // turn timer for Play with Friends
  let SHOW_MS = 45000;   // after a valid show, the others get this long to group their cards (no limit vs computer)

  // Card id: "<rank>-<suit>-<copy>", printed joker "0-J-<copy>"
  function parse(id) { const p = id.split('-'); return { id, r: +p[0], s: p[1], d: +p[2] }; }
  function makeDeck(nDecks) {
    const ids = [];
    for (let d = 0; d < nDecks; d++) {
      for (const s of SUITS) for (let r = 1; r <= 13; r++) ids.push(r + '-' + s + '-' + d);
      ids.push('0-J-' + (d * 2)); ids.push('0-J-' + (d * 2 + 1));
    }
    return ids;
  }
  // Secure, unbiased random integer in [0, n)
  function secureInt(n) {
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (!c) return Math.floor(Math.random() * n);
    const lim = Math.floor(0x100000000 / n) * n, buf = new Uint32Array(1);
    let x; do { c.getRandomValues(buf); x = buf[0]; } while (x >= lim);
    return x % n;
  }
  /** Fisher-Yates shuffle. Without rand it uses secure randomness (real games); rand is only for tests. */
  function shuffle(a, rand) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand ? Math.floor(rand() * (i + 1)) : secureInt(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  const isJoker = (c, wr) => c.s === 'J' || c.r === wr;
  const cardPoints = (c, wr) => (isJoker(c, wr) ? 0 : (c.r === 1 || c.r >= 11) ? 10 : c.r);

  function consecutive(vals) {
    const v = vals.slice().sort((a, b) => a - b);
    for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] + 1) return false;
    return true;
  }
  function isTrio(cards) {
    return cards.length === 3 && cards[0].s !== 'J' && cards.every(c => c.s === cards[0].s && c.r === cards[0].r);
  }
  function isPureSeq(cards) {
    if (cards.length < 3 || cards.some(c => c.s === 'J')) return false;
    if (cards.some(c => c.s !== cards[0].s)) return false;
    const lo = cards.map(c => c.r);
    return consecutive(lo) || consecutive(lo.map(r => (r === 1 ? 14 : r)));
  }
  function fitsWindow(vals, n) {
    if (new Set(vals).size !== vals.length) return false;
    return !vals.length || Math.max(...vals) - Math.min(...vals) + 1 <= n;
  }
  function isImpureSeq(cards, wr) {
    if (cards.length < 3) return false;
    const nat = cards.filter(c => !isJoker(c, wr));
    if (!nat.length) return true;
    if (nat.some(c => c.s !== nat[0].s)) return false;
    const lo = nat.map(c => c.r);
    return fitsWindow(lo, cards.length) || fitsWindow(lo.map(r => (r === 1 ? 14 : r)), cards.length);
  }
  function isSet(cards, wr) {
    if (cards.length < 3 || cards.length > 4) return false;
    const nat = cards.filter(c => !isJoker(c, wr));
    if (nat.some(c => c.r !== nat[0].r)) return false;
    return new Set(nat.map(c => c.s)).size === nat.length;
  }
  function classify(ids, wr) {
    const cards = ids.map(parse);
    if (isTrio(cards)) return 'trio';
    if (isPureSeq(cards)) return 'pure';
    if (isImpureSeq(cards, wr)) return 'impure';
    if (isSet(cards, wr)) return 'set';
    return 'invalid';
  }
  const isPureType = t => t === 'pure' || t === 'trio';
  const isSeqType = t => t === 'pure' || t === 'trio' || t === 'impure';

  /** Evaluate an arrangement (array of groups of card ids) for a player who knows wild rank wr. */
  function evaluate(groups, wr) {
    let trioSeen = false;
    const info = groups.filter(g => g.length).map(g => {
      let t = classify(g, wr);
      if (t === 'trio') { if (trioSeen) t = 'invalid'; else trioSeen = true; }
      return { ids: g, type: t };
    });
    const pure = info.filter(x => isPureType(x.type)).length;
    const seqs = info.filter(x => isSeqType(x.type)).length;
    const sum = list => list.reduce((a, g) => a + g.ids.reduce((b, id) => b + cardPoints(parse(id), wr), 0), 0);
    const valid = pure >= 1 && seqs >= 2 && info.every(x => x.type !== 'invalid');
    // without both "lives" (a pure sequence plus a second sequence, pure or not) a loser pays the full count
    const pts = pure === 0 || seqs < 2 ? FULL_COUNT : sum(info.filter(x => x.type === 'invalid'));
    return { valid, info, pure, seqs, pts: valid ? 0 : Math.min(FULL_COUNT, pts) };
  }

  // ---------- display helpers ----------
  function sortGroup(ids) {
    const cards = ids.map(parse);
    const hasHigh = cards.some(c => c.r >= 12 && c.s !== 'J');
    const val = c => (c.s === 'J' ? 99 : c.r === 1 && hasHigh ? 14 : c.r);
    return cards.sort((a, b) => val(a) - val(b) || a.s.localeCompare(b.s) || a.d - b.d).map(c => c.id);
  }
  function groupBySuit(ids, wr) {
    const by = { S: [], H: [], C: [], D: [], J: [] };
    ids.forEach(id => { const c = parse(id); by[isJoker(c, wr) ? 'J' : c.s].push(id); });
    return ['S', 'H', 'C', 'D', 'J'].map(s => sortGroup(by[s])).filter(g => g.length);
  }
  const flat = groups => groups.reduce((a, g) => a.concat(g), []);
  function sameCards(a, b) {
    if (a.length !== b.length) return false;
    const x = a.slice().sort(), y = b.slice().sort();
    return x.every((v, i) => v === y[i]);
  }
  const cleanGroups = groups => groups.map(g => g.slice()).filter(g => g.length);
  function label(id) { const c = parse(id); return c.s === 'J' ? 'Joker' : RANK_LABEL[c.r] + SUIT_SYM[c.s]; }

  // ---------- Hand solver (used by the computer and by "Auto arrange") ----------
  /** Find the best grouping of ids. mode 'score' = lowest real points; 'ai' = best progress heuristic. */
  function bestArrangement(ids, wr, mode, budget) {
    mode = mode || 'score'; budget = budget || 40000;
    const nat = {}, wild = {}, printed = [];
    const order = [];
    for (const s of SUITS) for (let r = 1; r <= 13; r++) order.push(s + r);
    ids.forEach(id => {
      const c = parse(id);
      if (c.s === 'J') printed.push(id);
      else if (c.r === wr) (wild[c.s + c.r] = wild[c.s + c.r] || []).push(id);
      else (nat[c.s + c.r] = nat[c.s + c.r] || []).push(id);
    });
    const melds = [], dead = [];
    let trioUsed = false, nodes = 0, best = null;

    function jokerCount() { let n = printed.length; for (const k in wild) n += wild[k].length; return n; }
    function takeJoker() {
      if (printed.length) return { id: printed.pop(), back: id => printed.push(id) };
      for (const k in wild) if (wild[k].length) { const arr = wild[k]; return { id: arr.pop(), back: id => arr.push(id) }; }
      return null;
    }
    function takeNatural(key) {
      if (nat[key] && nat[key].length) { const arr = nat[key]; return { id: arr.pop(), back: id => arr.push(id) }; }
      if (wild[key] && wild[key].length) { const arr = wild[key]; return { id: arr.pop(), back: id => arr.push(id) }; }
      return null;
    }
    function leaf() {
      // leftover jokers attach to groups
      const groups = melds.map(m => ({ ids: m.ids.slice(), type: m.type }));
      const left = printed.slice(); for (const k in wild) left.push(...wild[k]);
      const extra = [];
      while (left.length) {
        const j = left.pop();
        let g = groups.find(x => x.type === 'impure' && x.ids.length < 13);
        if (!g) g = groups.find(x => x.type === 'set' && x.ids.length < 4);
        if (!g && left.length >= 2) { groups.push({ ids: [j, left.pop(), left.pop()], type: 'impure' }); continue; }
        if (!g && groups.filter(x => isPureType(x.type)).length >= 2) { g = groups.find(x => x.type === 'pure'); if (g) g.type = 'impure'; }
        if (g) g.ids.push(j); else extra.push(j);
      }
      const pure = groups.filter(x => isPureType(x.type)).length;
      const seqs = groups.filter(x => isSeqType(x.type)).length;
      const pts = id => cardPoints(parse(id), wr);
      const deadPts = dead.reduce((a, id) => a + pts(id), 0) + extra.reduce((a, id) => a + pts(id), 0);
      const valid = pure >= 1 && seqs >= 2 && !dead.length && !extra.length;
      let cost = pure === 0 || seqs < 2 ? FULL_COUNT : deadPts;   // same rule as evaluate(): no two sequences = full count
      cost = valid ? 0 : Math.min(FULL_COUNT, cost);
      let score;
      if (mode === 'ai') {
        // deadwood weighted: cards close to others count half (they may become melds)
        const dc = dead.map(parse);
        let w = 0;
        dc.forEach((c, i) => {
          const near = dc.some((o, j) => j !== i && ((o.s === c.s && Math.abs(o.r - c.r) <= 2) || (o.r === c.r && o.s !== c.s)));
          w += cardPoints(c, wr) * (near ? 0.45 : 1);
        });
        score = valid ? -1 : w + (pure ? 0 : 28) + (seqs >= 2 ? 0 : 12) + extra.length;
      } else score = valid ? -1 : cost * 1000 + deadPts;
      if (!best || score < best.score) {
        best = { score, cost, valid, groups: groups.map(g => g.ids).concat(extra.length ? [extra] : []), dead: dead.slice() };
      }
    }
    function pivot() { for (const k of order) if (nat[k] && nat[k].length) return k; return null; }
    function dfs() {
      if (++nodes > budget) return;
      const key = pivot();
      if (!key) { leaf(); return; }
      const s = key[0], r = +key.slice(1);
      const pid = nat[key].pop();
      // 1) trio
      if (!trioUsed && nat[key].length >= 2) {
        const a = nat[key].pop(), b = nat[key].pop();
        trioUsed = true; melds.push({ ids: [pid, a, b], type: 'trio' }); dfs(); melds.pop(); trioUsed = false;
        nat[key].push(b, a);
      }
      // 2) sequences containing the pivot
      const vs = r === 1 ? [1, 14] : [r];
      const jAvail = jokerCount();
      for (const v of vs) {
        for (let L = 3; L <= 13; L++) {
          for (let a = Math.max(1, v - L + 1); a <= Math.min(v, 14 - L + 1); a++) {
            const taken = []; let jokers = 0, ok = true, natCount = 1;
            for (let x = a; x < a + L && ok; x++) {
              if (x === v) continue;
              const rr = x === 14 ? 1 : x;
              if (rr === r && x !== v) { ok = false; break; }
              const t = takeNatural(s + rr);
              if (t) { taken.push(t); natCount++; continue; }
              if (L > 3 && (x === a || x === a + L - 1)) { ok = false; break; }
              if (jokers + 1 > jAvail) { ok = false; break; }
              const j = takeJoker(); if (!j) { ok = false; break; }
              taken.push(j); jokers++;
            }
            if (ok) {
              melds.push({ ids: [pid].concat(taken.map(t => t.id)), type: jokers ? 'impure' : 'pure' });
              dfs(); melds.pop();
            }
            for (let i = taken.length - 1; i >= 0; i--) taken[i].back(taken[i].id);
          }
        }
      }
      // 3) sets containing the pivot
      const others = SUITS.filter(x => x !== s && nat[x + r] && nat[x + r].length);
      for (let mask = 0; mask < (1 << others.length); mask++) {
        const pick = others.filter((_, i) => mask & (1 << i));
        const n = 1 + pick.length; if (n > 4) continue;
        const need = Math.max(0, 3 - n); if (need > jAvail) continue;
        const taken = pick.map(x => { const arr = nat[x + r]; return { id: arr.pop(), back: id => arr.push(id) }; });
        for (let k = 0; k < need; k++) taken.push(takeJoker());
        melds.push({ ids: [pid].concat(taken.map(t => t.id)), type: 'set' }); dfs(); melds.pop();
        for (let i = taken.length - 1; i >= 0; i--) taken[i].back(taken[i].id);
      }
      // 4) pivot as deadwood
      dead.push(pid); dfs(); dead.pop();
      nat[key].push(pid);
    }
    dfs();
    if (!best) leaf();
    // tidy: deadwood grouped by suit after melds
    const meldGroups = best.groups.filter(g => !g.every(id => best.dead.includes(id)));
    const deadGroups = groupBySuit(best.dead, wr);
    best.groups = meldGroups.map(sortGroup).concat(deadGroups);
    return best;
  }

  // ---------- Game engine (authoritative on host / offline device) ----------
  const BOT_NAMES = ['Arjun', 'Meera', 'Kabir', 'Priya', 'Vikram'];
  function newGame(code, host) {
    return { v: 3, code, hostId: host.id, phase: 'lobby', dealNo: 0, dealer: -1, seq: 0, matchDeals: 0, matchOver: false,
      players: [{ id: host.id, name: host.name, online: true, total: 0 }], deal: null, history: [] };
  }
  function newSoloGame(human, nBots, deals) {
    const G = newGame('SOLO', human); G.solo = true; G.matchDeals = deals || 0;
    for (let i = 0; i < nBots; i++) G.players.push({ id: 'bot' + i, name: BOT_NAMES[i], online: true, total: 0, bot: true });
    return G;
  }
  function addPlayer(G, id, name) {
    const p = G.players.find(x => x.id === id);
    if (p) { p.online = true; if (name) p.name = name; return null; }
    if (G.players.length >= MAX_PLAYERS) return 'Room is full (6 players max)';
    G.players.push({ id, name: name || 'Player', online: true, total: 0 });
    return null;
  }
  function log(D, msg) { D.log.push(msg); if (D.log.length > 8) D.log.shift(); }
  const nameOf = (G, pid) => (G.players.find(p => p.id === pid) || {}).name || '?';
  const wrFor = (D, pid) => (D.revealed[pid] ? D.wildRank : NO_WILD);
  function setAct(G, pid, type, extra) { G.seq++; G.deal.lastAct = Object.assign({ seq: G.seq, pid, type }, extra || {}); }

  function startDeal(G, rand) {
    const pids = G.players.map(p => p.id);
    if (pids.length < 2) return 'Need at least 2 players';
    if (G.matchOver || (G.matchDeals && G.dealNo >= G.matchDeals)) return 'Match is over — start a new match';
    G.dealNo++;
    G.dealer = (G.dealer + 1) % pids.length;
    const order = pids.slice(G.dealer + 1).concat(pids.slice(0, G.dealer + 1));
    const stock = shuffle(makeDeck(DECKS), rand);
    const hands = {};
    order.forEach(pid => { hands[pid] = []; });
    for (let i = 0; i < 13; i++) order.forEach(pid => hands[pid].push(stock.pop()));
    const wild = stock.pop();                       // closed joker, kept face-down under the deck
    const wc = parse(wild);
    const wildRank = wc.s === 'J' ? 1 : wc.r;
    stock.unshift(wild);
    const open = stock.pop();   // the next card is turned face-up, exactly as dealt
    order.forEach(pid => { hands[pid] = [hands[pid]]; });   // exactly as dealt; each player arranges their own
    G.deal = { order, hands, stock, discard: [open], wild, wildRank, turn: 0, step: 'draw', picked: null,
      lastDrawn: {}, drawn: {}, out: {}, revealed: {}, log: [], result: null, lastAct: null, mult: multiplier(G, G.dealNo) };
    G.seq++; G.deal.lastAct = { seq: G.seq, type: 'deal' };
    G.deal.id = G.seq;
    G.deal.timeouts = {};
    G.deal.turnEnds = G.solo ? 0 : Date.now() + TURN_MS;
    log(G.deal, 'Deal ' + G.dealNo + (G.matchDeals ? ' of ' + G.matchDeals : '') + (G.deal.mult > 1 ? ' (double points)' : '') + ' — ' + nameOf(G, order[0]) + ' plays first.');
    G.phase = 'play';
    order.forEach(pid => checkReveal(G, pid));
    return null;
  }
  function checkReveal(G, pid) {
    const D = G.deal;
    if (!D || D.revealed[pid] || !D.hands[pid]) return;
    if (D.hands[pid].some(g => g.length >= 3 && isPureType(classify(g, NO_WILD)))) {
      D.revealed[pid] = true;
      log(D, nameOf(G, pid) + ' made a pure sequence and unlocked the joker.');
    }
  }
  const activeIds = D => D.order.filter(pid => !D.out[pid]);
  /** First and last deal of a fixed-length match score double. */
  const multiplier = (G, n) => (G.matchDeals && (n === 1 || n === G.matchDeals) ? 2 : 1);
  function nextTurn(G) {
    const D = G.deal, n = D.order.length;
    for (let k = 1; k <= n; k++) { const i = (D.turn + k) % n; if (!D.out[D.order[i]]) { D.turn = i; break; } }
    D.step = 'draw'; D.picked = null;
    D.turnEnds = G.solo ? 0 : Date.now() + TURN_MS;
  }
  function endDeal(G, winner, wrongBy) {
    const D = G.deal;
    const rows = D.order.map(pid => {
      const ev = evaluate(D.hands[pid], wrFor(D, pid));
      let pts, note;
      if (D.out[pid]) { pts = D.out[pid]; note = pts === FIRST_DROP ? 'First drop' : 'Middle drop'; }
      else if (wrongBy) { pts = pid === wrongBy ? FULL_COUNT : 0; note = pid === wrongBy ? 'Wrong show' : ''; }
      else if (pid === winner) { pts = 0; note = 'Winner'; }
      else { pts = Math.max(MIN_LOSS, ev.pts); note = ev.pure < 1 || ev.seqs < 2 ? 'Full count · no 2 sequences' : ''; }
      return { pid, name: nameOf(G, pid), pts, note, groups: ev.info };
    });
    const mult = D.mult || 1;
    rows.forEach(r => { r.base = r.pts; r.pts *= mult; const p = G.players.find(x => x.id === r.pid); if (p) p.total += r.pts; });
    const final = !!(G.matchDeals && G.dealNo >= G.matchDeals);
    if (final) G.matchOver = true;
    const standings = final ? G.players.slice().sort((a, b) => a.total - b.total).map(p => ({ pid: p.id, name: p.name, total: p.total })) : null;
    D.result = { winner, wrongBy: wrongBy || null, rows, mult, final, standings };
    G.history.push({ deal: G.dealNo, mult, pts: Object.fromEntries(rows.map(r => [r.pid, r.pts])) });
    G.phase = 'result';
  }
  // A valid show doesn't end the deal at once: like at a real table, everyone else first groups their cards
  // (scores are counted from their final groups). Computer players group instantly.
  function startShow(G, winner) {
    const D = G.deal;
    G.phase = 'show';
    D.show = { winner, done: { [winner]: true } };
    D.order.forEach(pid => {
      if (D.out[pid]) { D.show.done[pid] = true; return; }
      const p = G.players.find(x => x.id === pid);
      if (!p || !p.bot || pid === winner) return;
      const ids = flat(D.hands[pid]);
      D.hands[pid] = bestArrangement(ids, wrFor(D, pid), 'score', 6000).groups; checkReveal(G, pid);
      if (D.revealed[pid]) D.hands[pid] = bestArrangement(ids, D.wildRank, 'score', 6000).groups;
      D.show.done[pid] = true;
    });
    D.turnEnds = G.solo ? 0 : Date.now() + SHOW_MS;
    maybeEndShow(G, false);
  }
  function maybeEndShow(G, force) {   // ends when everyone still connected is done, or time is up
    const D = G.deal, S = D.show;
    const waiting = D.order.filter(pid => !S.done[pid] && (G.players.find(p => p.id === pid) || {}).online !== false);
    if (!force && waiting.length) return false;
    log(D, nameOf(G, S.winner) + ' won the deal!');
    endDeal(G, S.winner, null);
    return true;
  }
  function checkLastStanding(G) {
    const act = activeIds(G.deal);
    if (act.length === 1) { log(G.deal, nameOf(G, act[0]) + ' wins — everyone else dropped.'); endDeal(G, act[0], null); return true; }
    return false;
  }

  /** Apply an action from player pid. Returns an error string, or null on success. */
  function act(G, pid, a, rand) {
    const isHost = pid === G.hostId;
    if (a.type === 'start' || a.type === 'next') {
      if (!isHost) return 'Only the host can start';
      if (G.phase === 'play' || G.phase === 'show') return 'Deal in progress';
      return startDeal(G, rand);
    }
    if (a.type === 'lobby') { if (!isHost) return 'Host only'; G.phase = 'lobby'; G.deal = null; return null; }
    if (a.type === 'config') {
      if (!isHost) return 'Only the host can change the match';
      if (G.phase === 'play' || (G.dealNo && !G.matchOver)) return 'Change the match length before the first deal';
      const n = a.deals | 0; G.matchDeals = n === 0 ? 0 : Math.max(3, Math.min(30, n)); return null;
    }
    if (a.type === 'newMatch') {
      if (!isHost) return 'Host only';
      if (G.phase === 'play' || G.phase === 'show') return 'Deal in progress';
      G.players.forEach(p => { p.total = 0; }); G.history = []; G.dealNo = 0; G.matchOver = false;
      return startDeal(G, rand);
    }
    if (a.type === 'reset') { if (!isHost) return 'Host only'; G.players.forEach(p => { p.total = 0; }); G.history = []; G.dealNo = 0; G.matchOver = false; G.phase = 'lobby'; G.deal = null; return null; }
    if (a.type === 'remove') {
      if (!isHost || G.phase === 'play' || G.phase === 'show') return 'Can only remove players between deals';
      if (a.target === G.hostId) return 'Host cannot be removed';
      G.players = G.players.filter(p => p.id !== a.target); return null;
    }
    const D = G.deal;
    if ((G.phase !== 'play' && G.phase !== 'show') || !D) return 'No deal in progress';
    if (G.phase === 'show') {   // someone declared: the others may only group their cards and say they're done
      if (a.type === 'timeout') {
        if (!isHost) return 'Host only';
        if (!a.force && (!D.turnEnds || Date.now() < D.turnEnds - 1000)) return 'Time is not up yet';
        maybeEndShow(G, true); return null;
      }
      if (!D.hands[pid]) return 'You will join from the next deal';
      if (a.type === 'groups') {
        const g = cleanGroups(a.groups || []);
        if (!sameCards(flat(g), flat(D.hands[pid]))) return 'Hand changed — try again';
        D.hands[pid] = g; checkReveal(G, pid); return null;
      }
      if (a.type === 'showDone') { D.show.done[pid] = true; maybeEndShow(G, false); return null; }
      return 'Someone declared — group your cards, then tap Done';
    }
    if (!D.hands[pid]) return 'You will join from the next deal';
    const hand = D.hands[pid];

    if (a.type === 'groups') {
      const g = cleanGroups(a.groups || []);
      if (!sameCards(flat(g), flat(hand))) return 'Hand changed — try again';
      D.hands[pid] = g; checkReveal(G, pid); return null;
    }
    if (a.type === 'kick') {
      if (!isHost) return 'Host only';
      const t = a.target;
      if (!D.hands[t] || D.out[t]) return 'Not in play';
      D.out[t] = D.drawn[t] ? MIDDLE_DROP : FIRST_DROP;
      log(D, nameOf(G, t) + ' was dropped by the host (' + D.out[t] + ' pts).');
      if (checkLastStanding(G)) return null;
      if (D.order[D.turn] === t) {
        if (D.step === 'discard') { const all = flat(D.hands[t]); const c = all[all.length - 1]; D.hands[t] = D.hands[t].map(g => g.filter(x => x !== c)).filter(g => g.length); D.discard.push(c); }
        nextTurn(G);
      }
      return null;
    }
    if (a.type === 'timeout') {
      // Sent by the host's device when the current player's time runs out.
      if (!isHost) return 'Host only';
      if (!a.force && (!D.turnEnds || Date.now() < D.turnEnds - 1000)) return 'Time is not up yet';
      const t = D.order[D.turn];
      let moved;
      if (D.step === 'discard') {
        // they had picked a card: it goes back onto the open pile
        const all = flat(D.hands[t]);
        moved = all.includes(D.lastDrawn[t]) ? D.lastDrawn[t] : all[all.length - 1];
        D.hands[t] = D.hands[t].map(g => g.filter(x => x !== moved)).filter(g => g.length);
      } else {
        // they had not picked: the top card of the deck is turned onto the open pile
        if (D.stock.length <= 1) { const top = D.discard.pop(); D.stock = D.stock.slice(0, 1).concat(D.discard.slice().reverse()); D.discard = [top]; }
        moved = D.stock.length > 1 ? D.stock.pop() : null;
      }
      if (moved) D.discard.push(moved);
      D.timeouts[t] = (D.timeouts[t] || 0) + 1;
      log(D, nameOf(G, t) + ' timed out — turn passed' + (moved ? ' (' + label(moved) + ' to the open pile)' : '') + '.');
      setAct(G, t, 'timeout', { card: moved, from: D.step === 'discard' ? 'hand' : 'stock' });
      nextTurn(G);
      return null;
    }
    if (D.order[D.turn] !== pid) return 'Not your turn';
    if (D.out[pid]) return 'You dropped';

    if (a.type === 'drop') {
      if (D.step !== 'draw') return 'You can only drop before picking a card';
      D.out[pid] = D.drawn[pid] ? MIDDLE_DROP : FIRST_DROP;
      log(D, nameOf(G, pid) + ' dropped (' + D.out[pid] + ' pts).');
      setAct(G, pid, 'drop');
      if (!checkLastStanding(G)) nextTurn(G);
      return null;
    }
    if (a.type === 'draw') {
      if (D.step !== 'draw') return 'You already picked a card';
      let card;
      if (a.from === 'discard') {
        if (!D.discard.length) return 'Open pile is empty';
        if (parse(D.discard[D.discard.length - 1]).s === 'J') return "Printed jokers can't be picked from the open pile";
        card = D.discard.pop(); D.picked = card;
        log(D, nameOf(G, pid) + ' picked ' + label(card) + ' from the open pile.');
      } else {
        if (D.stock.length <= 1) {
          // Like a real table: keep the top open card, turn the rest of the open pile over (no shuffle).
          // The closed joker stays at the very bottom. Oldest discard becomes the next card drawn.
          const top = D.discard.pop();
          D.stock = D.stock.slice(0, 1).concat(D.discard.slice().reverse());
          D.discard = [top];
          log(D, 'Deck finished — open pile turned over.');
        }
        if (D.stock.length <= 1) return 'No cards left';
        card = D.stock.pop(); D.picked = null;
        log(D, nameOf(G, pid) + ' drew from the deck.');
      }
      D.hands[pid] = hand.concat([[card]]);
      D.lastDrawn[pid] = card; D.drawn[pid] = true; D.step = 'discard';
      setAct(G, pid, 'draw', { from: a.from === 'discard' ? 'discard' : 'stock', card: a.from === 'discard' ? card : null });
      return null;
    }
    if (a.type === 'discard' || a.type === 'declare') {
      if (D.step !== 'discard') return 'Pick a card first';
      const c = a.card, all = flat(hand);
      if (all.indexOf(c) < 0) return 'Card not in hand';
      if (a.type === 'discard' && D.picked === c) return "You can't throw back the card you just picked";
      let rest = hand.map(g => g.filter(x => x !== c)).filter(g => g.length);
      if (a.groups) { const g = cleanGroups(a.groups); if (sameCards(flat(g), flat(rest))) rest = g; }
      D.hands[pid] = rest; D.discard.push(c);
      checkReveal(G, pid);
      setAct(G, pid, a.type, { card: c });
      if (a.type === 'discard') { log(D, nameOf(G, pid) + ' discarded ' + label(c) + '.'); nextTurn(G); return null; }
      const ev = evaluate(rest, wrFor(D, pid));
      if (ev.valid) { log(D, nameOf(G, pid) + ' declared! Everyone else: group your cards.'); startShow(G, pid); }
      else { log(D, nameOf(G, pid) + ' made a wrong show (80 pts).'); endDeal(G, null, pid); }
      return null;
    }
    return 'Unknown action';
  }

  // ---------- computer player ----------
  function aiKey(id) { const c = parse(id); return c.s + c.r; }
  function bestDiscard(hand14, wr, picked) {
    let best = null; const seen = new Set();
    for (const id of hand14) {
      const c = parse(id); const k = aiKey(id);
      if (seen.has(k) || id === picked || isJoker(c, wr)) continue;
      seen.add(k);
      const rest = hand14.filter(x => x !== id);
      const arr = bestArrangement(rest, wr, 'ai', 6000);
      const sc = arr.score - cardPoints(c, wr) * 0.05;
      if (!best || sc < best.sc) best = { sc, card: id, arr };
    }
    if (!best) { const id = hand14.find(x => x !== picked) || hand14[0]; best = { card: id, arr: bestArrangement(hand14.filter(x => x !== id), wr, 'ai', 6000) }; }
    return best;
  }
  /** Perform one step of a computer player's turn (draw, or discard/declare). */
  function botStep(G, pid, rand) {
    const D = G.deal; if (!D || G.phase !== 'play' || D.order[D.turn] !== pid) return;
    const wr = wrFor(D, pid);
    const hand = flat(D.hands[pid]);
    if (D.step === 'draw') {
      if (!D.drawn[pid] && activeIds(D).length > 2) {
        const first = bestArrangement(hand, wr, 'ai', 6000);
        const jokers = hand.filter(id => parse(id).s === 'J').length;
        if (!jokers && first.score > 62 && (rand || Math.random)() < 0.35) { act(G, pid, { type: 'drop' }, rand); return; }
      }
      const top = D.discard[D.discard.length - 1];
      let from = 'stock';
      if (top && parse(top).s !== 'J') {
        const now = bestArrangement(hand, wr, 'ai', 6000).score;
        const withTop = bestDiscard(hand.concat([top]), wr, top);
        if (withTop.arr.valid || withTop.arr.score < now - 3.5) from = 'discard';
      }
      act(G, pid, { type: 'draw', from }, rand);
      const h = flat(D.hands[pid]);
      D.hands[pid] = bestArrangement(h, wr, 'ai', 6000).groups;
      checkReveal(G, pid);
      return;
    }
    const wr2 = wrFor(D, pid);
    const pick = bestDiscard(hand, wr2, D.picked);
    const slip = 0.08; // now and then, like a person, it keeps a card a perfect player would throw
    if (!evaluate(pick.arr.groups, wr2).valid && pick.arr.dead.length && (rand || Math.random)() < slip) {
      // a less careful player: throw some other loose card instead
      const loose = pick.arr.dead.concat([pick.card]).filter(id => id !== D.picked && !isJoker(parse(id), wr2));
      const alt = loose[Math.floor((rand || Math.random)() * loose.length)];
      if (alt && alt !== pick.card) {
        const rest = hand.filter(x => x !== alt);
        pick.card = alt; pick.arr = bestArrangement(rest, wr2, 'ai', 6000);
      }
    }
    D.hands[pid] = pick.arr.groups.concat([[pick.card]]);
    const ev = evaluate(pick.arr.groups, wr2);
    if (ev.valid) act(G, pid, { type: 'declare', card: pick.card, groups: pick.arr.groups }, rand);
    else act(G, pid, { type: 'discard', card: pick.card }, rand);
    if (G.phase === 'play') checkReveal(G, pid);
  }

  /** What one player is allowed to see. */
  function view(G, pid) {
    const D = G.deal;
    const v = { code: G.code, solo: !!G.solo, me: pid, hostId: G.hostId, phase: G.phase, dealNo: G.dealNo, history: G.history,
      matchDeals: G.matchDeals || 0, matchOver: !!G.matchOver, mult: D ? D.mult || 1 : multiplier(G, G.dealNo + 1),
      players: G.players.map(p => ({ id: p.id, name: p.name, online: p.online, total: p.total, bot: !!p.bot,
        count: D && D.hands[p.id] ? flat(D.hands[p.id]).length : 0,
        inDeal: !!(D && D.hands[p.id]), out: D ? D.out[p.id] || 0 : 0, revealed: !!(D && D.revealed[p.id]) })) };
    if (D) {
      const show = !!D.revealed[pid] || G.phase === 'result';
      const la = D.lastAct ? Object.assign({}, D.lastAct) : null;
      if (la && la.type === 'draw' && la.from === 'stock' && la.pid !== pid) la.card = null;
      v.deal = { id: D.id || 0, order: D.order, wild: show ? D.wild : null, wildRank: show ? D.wildRank : null, revealed: !!D.revealed[pid],
        stockCount: D.stock.length, discardTop: D.discard[D.discard.length - 1] || null,
        discardUnder: D.discard[D.discard.length - 2] || null, discardCount: D.discard.length,
        turnPid: D.order[D.turn], step: D.step, turnLeft: D.turnEnds ? Math.max(0, D.turnEnds - Date.now()) : null, turnMs: TURN_MS,
        timeouts: D.timeouts || {}, log: D.log.slice(-4), result: D.result, lastAct: la,
        myGroups: D.hands[pid] || null, picked: D.order[D.turn] === pid ? D.picked : null,
        lastDrawn: D.lastDrawn[pid] || null, showMs: SHOW_MS };
      if (G.phase === 'show' && D.show) {   // everyone sees the winning hand while they group their own cards
        const w = D.show.winner;
        v.deal.show = { winner: w, done: Object.keys(D.show.done), winnerGroups: evaluate(D.hands[w], wrFor(D, w)).info, winnerWild: D.revealed[w] ? D.wildRank : null };
      }
    }
    return v;
  }

  const api = { get TURN_MS() { return TURN_MS; }, setTurnMs(ms) { TURN_MS = ms; }, get SHOW_MS() { return SHOW_MS; }, setShowMs(ms) { SHOW_MS = ms; }, multiplier, parse, makeDeck, shuffle, secureInt, isJoker, cardPoints, classify, evaluate, sortGroup, groupBySuit, flat, label,
    bestArrangement, newGame, newSoloGame, addPlayer, startDeal, act, botStep, view, isPureType,
    RANK_LABEL, SUIT_SYM, MAX_PLAYERS, NO_WILD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Rules = api;
})(typeof self !== 'undefined' ? self : this);
