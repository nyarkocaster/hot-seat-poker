// Hold'em equity: a fast 5-7 card evaluator, exact enumeration when the job is small and
// Monte Carlo when it isn't, plus an outs counter. Cards are ids 4*rank+suit, rank 0 = deuce,
// suits in the order c d h s (the same ids the solver uses).
import { parseRange } from "./solver/range.js";

export const RANKCH = "23456789TJQKA", SUITCH = "cdhs";
export const CATS = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];
export const cardId = s => { const r = RANKCH.indexOf(String(s)[0].toUpperCase()), u = SUITCH.indexOf(String(s)[1].toLowerCase()); return r < 0 || u < 0 ? -1 : r * 4 + u; };
export const cardStr = id => RANKCH[id >> 2] + SUITCH[id & 3];

// "Ah Kd 7c", "AhKd7c", "ah,kd" -> ids (or an error)
export function parseCards(text) {
  const t = String(text || "").replace(/10/g, "T").replace(/[\s,]+/g, "");
  if (!t) return { cards: [], err: "" };
  if (t.length % 2) return { cards: [], err: `“${text.trim()}” isn't a list of cards, like Ah Kd 7c` };
  const out = [];
  for (let i = 0; i < t.length; i += 2) {
    const id = cardId(t.slice(i, i + 2));
    if (id < 0) return { cards: [], err: `“${t.slice(i, i + 2)}” isn't a card. Use a rank (2-9, T, J, Q, K, A) and a suit (c, d, h, s), like Ah` };
    if (out.includes(id)) return { cards: [], err: `${t.slice(i, i + 2)} is listed twice` };
    out.push(id);
  }
  return { cards: out, err: "" };
}

/* ---------- evaluator: bigger score = better hand; score >> 20 is the category ---------- */
const RC = new Int8Array(13), SM = new Int32Array(4), SC = new Int8Array(4);
function straightTop(mask) { // highest rank index of a straight in the mask, or -1
  const m = (mask << 1) | ((mask >> 12) & 1); // bit 0 = ace played low
  for (let h = 13; h >= 4; h--) if (((m >> (h - 4)) & 31) === 31) return h - 1;
  return -1;
}
function topN(mask, n, skip1 = -1, skip2 = -1) {
  let v = 0, k = 0;
  for (let r = 12; r >= 0 && k < n; r--) if (mask & (1 << r) && r !== skip1 && r !== skip2) { v = (v << 4) | r; k++; }
  return v;
}
export function score(cs, n = cs.length) {
  RC.fill(0); SM.fill(0); SC.fill(0);
  let all = 0;
  for (let i = 0; i < n; i++) { const c = cs[i], r = c >> 2, s = c & 3; RC[r]++; SM[s] |= 1 << r; SC[s]++; all |= 1 << r; }
  let flush = 0;
  for (let s = 0; s < 4; s++) if (SC[s] >= 5) { const sf = straightTop(SM[s]); if (sf >= 0) return (8 << 20) | sf; flush = SM[s]; }
  let quad = -1, trip = -1, trip2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = RC[r];
    if (k === 4) quad = r; else if (k === 3) { if (trip < 0) trip = r; else if (trip2 < 0) trip2 = r; }
    else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (quad >= 0) return (7 << 20) | (quad << 4) | topN(all, 1, quad);
  if (trip >= 0 && (trip2 >= 0 || p1 >= 0)) return (6 << 20) | (trip << 4) | Math.max(trip2, p1);
  if (flush) return (5 << 20) | topN(flush, 5);
  const st = straightTop(all); if (st >= 0) return (4 << 20) | st;
  if (trip >= 0) return (3 << 20) | (trip << 8) | topN(all, 2, trip);
  if (p2 >= 0) return (2 << 20) | (p1 << 8) | (p2 << 4) | topN(all, 1, p1, p2);
  if (p1 >= 0) return (1 << 20) | (p1 << 12) | topN(all, 3, p1);
  return topN(all, 5);
}

/* ---------- a player's holding: one hand, a range, or anything ---------- */
// cell (r,c) of the 13x13 grid: RK = "AKQJT98765432" (row/col 0 = ace)
function cellCombos(r, c) {
  const hi = 12 - Math.min(r, c), lo = 12 - Math.max(r, c), out = [];
  if (r === c) { for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) out.push([hi * 4 + a, hi * 4 + b]); }
  else if (r < c) { for (let s = 0; s < 4; s++) out.push([hi * 4 + s, lo * 4 + s]); }
  else { for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (a !== b) out.push([hi * 4 + a, lo * 4 + b]); }
  return out;
}
// text -> {kind:"hand"|"range"|"any", combos:[[c1,c2,w]], err}
export function parseHolding(text) {
  const t = String(text || "").trim();
  if (!t || /^(random|any|\?+)$/i.test(t)) {
    const combos = []; for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) combos.push([a, b, 1]);
    return { kind: "any", combos, err: "" };
  }
  const compact = t.replace(/10/g, "T").replace(/[\s,]+/g, "");
  if (/^([2-9TJQKA][cdhs]){2}$/i.test(compact)) {
    const p = parseCards(compact); if (p.err) return { kind: "hand", combos: [], err: p.err };
    return { kind: "hand", combos: [[p.cards[0], p.cards[1], 1]], err: "" };
  }
  const r = parseRange(t);
  if (r.err) return { kind: "range", combos: [], err: r.err };
  const combos = [];
  for (let a = 0; a < 13; a++) for (let b = 0; b < 13; b++) { const w = r.w[a * 13 + b]; if (w > 0) for (const [x, y] of cellCombos(a, b)) combos.push([x, y, w]); }
  if (!combos.length) return { kind: "range", combos: [], err: "That range has no hands in it" };
  return { kind: "range", combos, err: "" };
}

/* ---------- equity ---------- */
// job: {players:[combos], board:[ids], dead:[ids]}
// returns a runner: step(ms) does work for about ms milliseconds and returns progress; result() at any time.
export function equityRunner(job) {
  const N = job.players.length, board = job.board.slice(), dead = new Set([...board, ...(job.dead || [])]);
  const need = 5 - board.length;
  const players = job.players.map(cs => cs.filter(([a, b]) => !dead.has(a) && !dead.has(b)));
  const R = { win: new Float64Array(N), tie: new Float64Array(N), eq: new Float64Array(N), cat: players.map(() => new Float64Array(9)), total: 0, trials: 0, exact: false, done: false, err: "" };
  const emptyAt = players.findIndex(p => !p.length);
  if (emptyAt >= 0) { R.err = `Player ${emptyAt + 1} has no possible hands with these cards`; R.done = true; return { step: () => 1, result: () => R }; }
  // size of exact enumeration
  const deckLeft = 52 - dead.size - 2 * N;
  const choose = (n, k) => { let v = 1; for (let i = 0; i < k; i++) v = (v * (n - i)) / (i + 1); return v; };
  let size = choose(deckLeft, need); for (const p of players) size *= p.length;
  const cards = new Int32Array(7), sc = new Int32Array(N), hole = new Int32Array(2 * N);
  function showdown(full, w) {
    let best = -1, nb = 0;
    for (let i = 0; i < N; i++) {
      cards[0] = hole[2 * i]; cards[1] = hole[2 * i + 1];
      for (let k = 0; k < 5; k++) cards[2 + k] = full[k];
      const s = score(cards, 7); sc[i] = s; R.cat[i][s >> 20] += w;
      if (s > best) { best = s; nb = 1; } else if (s === best) nb++;
    }
    for (let i = 0; i < N; i++) if (sc[i] === best) { if (nb === 1) R.win[i] += w; else R.tie[i] += w; R.eq[i] += w / nb; }
    R.total += w;
  }
  const full = new Int32Array(5); for (let k = 0; k < board.length; k++) full[k] = board[k];

  if (size <= 2.5e6) { // exact, as a generator so it can pause
    R.exact = true;
    const gen = (function* () {
      const used = new Uint8Array(52); for (const c of dead) used[c] = 1;
      function* assign(i, w) {
        if (i === N) {
          const deck = []; for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
          const L = deck.length, idx = new Int32Array(need);
          if (!need) { showdown(full, w); yield 1; return; }
          for (let k = 0; k < need; k++) idx[k] = k;
          let n = 0;
          while (true) {
            for (let k = 0; k < need; k++) full[board.length + k] = deck[idx[k]];
            showdown(full, w); if (++n % 2000 === 0) yield n;
            let k = need - 1; while (k >= 0 && idx[k] === L - need + k) k--;
            if (k < 0) break;
            idx[k]++; for (let j = k + 1; j < need; j++) idx[j] = idx[j - 1] + 1;
          }
          yield n; return;
        }
        for (const [a, b, cw] of players[i]) {
          if (used[a] || used[b]) continue;
          used[a] = used[b] = 1; hole[2 * i] = a; hole[2 * i + 1] = b;
          yield* assign(i + 1, w * cw);
          used[a] = used[b] = 0;
        }
      }
      yield* assign(0, 1);
    })();
    let doneN = 0;
    return {
      size,
      step(ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = gen.next(); if (r.done) { R.done = true; break; } doneN++; } R.trials = R.total; return R.done ? 1 : Math.min(0.99, (doneN * 2000) / size); },
      result: () => R,
    };
  }
  // Monte Carlo: draw every player's hand (by weight) and the rest of the board, reject clashes
  const cum = players.map(cs => { const a = new Float64Array(cs.length); let s = 0; cs.forEach((c, i) => { s += c[2]; a[i] = s; }); return a; });
  const pick = i => { const a = cum[i], x = Math.random() * a[a.length - 1]; let lo = 0, hi = a.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return players[i][lo]; };
  const used = new Uint8Array(52), deck = new Int32Array(52);
  const MAX = 3e6;
  return {
    size,
    step(ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms && R.trials < MAX) {
        for (let n = 0; n < 500; n++) {
          used.fill(0); for (const c of dead) used[c] = 1;
          let ok = true;
          for (let i = 0; i < N && ok; i++) { const [a, b] = pick(i); if (used[a] || used[b]) ok = false; else { used[a] = used[b] = 1; hole[2 * i] = a; hole[2 * i + 1] = b; } }
          if (!ok) continue;
          let L = 0; for (let c = 0; c < 52; c++) if (!used[c]) deck[L++] = c;
          for (let k = 0; k < need; k++) { const j = k + Math.floor(Math.random() * (L - k)); const t = deck[k]; deck[k] = deck[j]; deck[j] = t; full[board.length + k] = deck[k]; }
          showdown(full, 1); R.trials++;
        }
      }
      if (R.trials >= MAX) R.done = true;
      return R.done ? 1 : R.trials / MAX;
    },
    result: () => R,
  };
}
// for the page: equity in %, plus a rough margin for estimates
export function summarize(R) {
  const t = R.total || 1;
  return {
    exact: R.exact, done: R.done, trials: R.trials, err: R.err,
    players: [...R.eq].map((e, i) => {
      const eq = e / t;
      return { eq, win: R.win[i] / t, tie: R.tie[i] / t, margin: R.exact ? 0 : 1.96 * Math.sqrt(Math.max(eq * (1 - eq), 1e-4) / Math.max(1, R.trials)), cats: [...R.cat[i]].map(x => x / t) };
    }),
  };
}

/* ---------- outs: which next card puts a player ahead (known hands only) ---------- */
export function countOuts(hero, others, board) {
  if (board.length < 3 || board.length > 4) return null;
  const known = new Set([...hero, ...others.flat(), ...board]);
  const best = b => { const h = score([...hero, ...b]); let o = -1; for (const x of others) o = Math.max(o, score([...x, ...b])); return h > o ? 1 : h === o ? 0 : -1; };
  const now = best(board), win = [], tie = [], lose = [];
  for (let c = 0; c < 52; c++) {
    if (known.has(c)) continue;
    const r = best([...board, c]);
    (r > 0 ? win : r === 0 ? tie : lose).push(c);
  }
  const out = { now, win, tie, lose, unseen: 52 - known.size };
  // on the flop, also deal every turn-and-river pair: the exact chance by the river, and how much of it
  // comes from runner-runner hands (both cards needed, neither one an out by itself)
  if (board.length === 3) {
    const rest = []; for (let c = 0; c < 52; c++) if (!known.has(c)) rest.push(c);
    const outSet = new Set(win); let n = 0, eq = 0, rr = 0; const rrCat = new Array(9).fill(0);
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) {
      const b = [...board, rest[i], rest[j]], r = best(b); n++;
      if (r > 0) { eq += 1; if (!outSet.has(rest[i]) && !outSet.has(rest[j])) { rr++; rrCat[score([...hero, ...b]) >> 20]++; } }
      else if (r === 0) eq += 0.5;
    }
    out.river = { pairs: n, eq: eq / n, rr: rr / n, rrCat: rrCat.map(x => x / n) };
  }
  return out;
}
