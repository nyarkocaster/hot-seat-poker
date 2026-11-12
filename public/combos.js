// Combo counter: how many two-card hands a player can hold, before and after the board and your own
// cards take some away, and what a range looks like on that board (sorted into made hands and draws).
// Card ids: 4 * rank + suit (rank 0 = deuce .. 12 = ace, suits c d h s).
import { parseCards, parseHolding, cardStr } from "./equity.js";
import { classify, MADE, DRAWS } from "./solver/classify.js";
import { RK, cellName, presetOptions, PRESETS } from "./solver/range.js";

const SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const chip = (c, cls = "") => { const s = cardStr(c); return `<span class="tcard ${s[1]}${cls ? " " + cls : ""}">${s[0] === "T" ? "10" : s[0]}${SYM[s[1]]}</span>`; };
const fmt = n => { const r = Math.round(n * 10) / 10; return (Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : r.toFixed(1)).toLocaleString("en-US"); };
const pc = x => (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + "%";
const C2 = n => n * (n - 1) / 2;
const NORMAL = [6, 4, 12]; // pair, suited, offsuit
// grid cell of a hand: row/col 0 = ace; suited above the diagonal, offsuit below
export function cellOf(a, b) {
  const ra = 12 - (a >> 2), rb = 12 - (b >> 2), hi = Math.min(ra, rb), lo = Math.max(ra, rb);
  if (ra === rb) return ra * 14;
  return (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
}
const kindOf = cell => { const r = Math.floor(cell / 13), c = cell % 13; return r === c ? 0 : r < c ? 1 : 2; };

/* the counting itself, kept free of the page so it can be tested */
export function countCombos({ board = [], known = [], combos }) {
  const boardSet = new Set(board), knownSet = new Set(known), dead = new Set([...board, ...known]);
  const unseen = 52 - dead.size;
  const cells = Array.from({ length: 169 }, () => ({ full: 0, live: 0, byBoard: 0, byKnown: 0, list: [], gone: [] }));
  const made = new Array(MADE.length).fill(0), draws = new Array(DRAWS.length).fill(0);
  const madeCells = MADE.map(() => new Float64Array(169)), drawCells = DRAWS.map(() => new Float64Array(169));
  let full = 0, live = 0, byBoard = 0, byKnown = 0;
  const any = !combos;
  const src = combos || (() => { const o = []; for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) o.push([a, b, 1]); return o; })();
  const classed = board.length >= 3;
  for (const [a, b, w0] of src) {
    const w = w0 == null ? 1 : w0; if (!(w > 0)) continue;
    const k = cellOf(a, b), c = cells[k];
    c.full += w; full += w;
    if (boardSet.has(a) || boardSet.has(b)) { c.byBoard += w; byBoard += w; c.gone.push([a, b, w]); continue; }
    if (knownSet.has(a) || knownSet.has(b)) { c.byKnown += w; byKnown += w; c.gone.push([a, b, w]); continue; }
    c.live += w; live += w; c.list.push([a, b, w]);
    if (classed) {
      const x = classify(a, b, board);
      made[x.made] += w; madeCells[x.made][k] += w;
      if (x.draw >= 0) { draws[x.draw] += w; drawCells[x.draw][k] += w; }
    }
  }
  return { any, unseen, possible: C2(unseen), full, live, byBoard, byKnown, cells, made, draws, madeCells, drawCells, classed };
}

// how many cards of each rank (grid row index) and each exact card are still unseen
function leftOf(dead) {
  const n = new Array(13).fill(4);
  for (const c of dead) n[12 - (c >> 2)]--;
  return n;
}

export function createCombos(el, opt = {}) {
  let board = "", known = "", range = "", ext = null, focus = null, filt = null, preset = "", presetKey = "";
  el.innerHTML = `
    <h2>Combo counter</h2>
    <div class="combos">
      <p class="note">How many hands can your opponent have here? Every starting hand is one of 1,326 two-card combinations. Cards you can see (the board and your own hand) take some away.</p>
      <div class="row stools"><button class="b sm" type="button" data-c="table">Use the table</button><button class="b sm" type="button" data-c="solver">Use the solver's spot</button><button class="b sm" type="button" data-c="clear">Clear</button></div>
      <div class="sfields">
        <label>Board <span class="muted">(0 to 5 cards)</span><input type="text" data-c="board" placeholder="Like Qs Jh 2h" spellcheck="false" autocomplete="off"></label>
        <label>Your cards <span class="muted">(or any other cards you've seen)</span><input type="text" data-c="known" placeholder="Like As Kh" spellcheck="false" autocomplete="off"></label>
      </div>
      <div class="sfields">
        <label class="cwide">Opponent's range <span class="muted">(blank = any two cards)</span><input type="text" data-c="range" placeholder="Like QQ+,AKs,AQo or 22+:0.5" spellcheck="false" autocomplete="off"></label>
        <label>Load a range<select data-c="preset" aria-label="Load a range for the opponent"><option value="">Range…</option></select></label>
      </div>
      <div class="cout" aria-live="polite"></div>
    </div>`;
  const q = s => el.querySelector(s);
  // the range menu: rebuilt only when what it lists changes (never while someone opens it), showing the range in use
  const fillPresets = () => {
    const S = opt.solver && opt.solver(), nm = S && S.names ? S.names() : null, nr = S && S.nodeRanges ? S.nodeRanges() : null;
    if (!ext && preset && !preset.startsWith("sv") && PRESETS[preset] !== range) preset = "";
    const key = JSON.stringify([!!S, nm, !!nr, Object.keys(PRESETS), Object.values(PRESETS)]);
    const sel = q('[data-c="preset"]');
    if (key !== presetKey) { presetKey = key; sel.innerHTML = `<option value="">Range…</option>${S ? `<optgroup label="From the solver">${[0, 1].map(k => `<option value="sv${k}">${esc(nm ? nm[k] : k ? "IP" : "OOP")} (${k ? "IP" : "OOP"})${nr ? " · at the spot on screen" : " · starting range"}</option>`).join("")}</optgroup>` : ""}<optgroup label="Charts">${presetOptions()}</optgroup>`; }
    if (preset && ![...sel.options].some(o => o.value === preset)) preset = "";
    sel.value = preset;
  };

  function parsed() {
    const b = parseCards(board), k = parseCards(known);
    let err = b.err || k.err;
    if (!err && b.cards.length > 5) err = "The board has at most five cards.";
    if (!err) { const seen = new Set(); for (const c of [...b.cards, ...k.cards]) { if (seen.has(c)) { err = `${cardStr(c)} is used twice`; break; } seen.add(c); } }
    let combos = null, rerr = "";
    if (ext) combos = ext.combos;
    else if (range.trim()) { const h = parseHolding(range); if (h.err) rerr = h.err; else if (h.kind !== "any") combos = h.combos; }
    return { b: b.cards, k: k.cards, err, combos, rerr };
  }

  function explainCell(R, cell, dead) {
    const r = Math.floor(cell / 13), c = cell % 13, kind = kindOf(cell), name = cellName(r, c), x = R.cells[cell];
    const left = leftOf(dead), hi = Math.min(r, c), lo = Math.max(r, c);
    const X = RK[hi], Y = RK[lo];
    let how;
    if (kind === 0) {
      const n = left[r];
      how = `A pair needs two of the ${n === 4 ? "four" : n} ${X}s still unseen. Ways to choose 2 from ${n}: ${n} × ${Math.max(0, n - 1)} ÷ 2 = <b>${C2(n)}</b> (from 6 with a full deck).`;
    } else {
      // suits where both cards are still unseen
      const dset = new Set(dead); let suited = 0;
      for (let s = 0; s < 4; s++) if (!dset.has(4 * (12 - hi) + s) && !dset.has(4 * (12 - lo) + s)) suited++;
      const all = left[hi] * left[lo];
      how = kind === 1
        ? `Suited means the same suit: one combo per suit where both the ${X} and the ${Y} are unseen. That's <b>${suited}</b> (from 4).`
        : `${left[hi]} ${X}s × ${left[lo]} ${Y}s = ${all} ways to pair them up, minus the ${suited} suited ones = <b>${all - suited}</b> offsuit (from 12).`;
    }
    const wt = x.full / NORMAL[kind];
    const wNote = !R.any && x.full > 0 && wt < 0.999 ? ` The range plays ${ext ? "some" : pc(wt)} of ${name}, so it holds <b>${fmt(x.live)}</b> weighted combos here.` : "";
    const list = [...x.list.map(([a, b]) => `<span class="cpair">${chip(a)}${chip(b)}</span>`), ...x.gone.map(([a, b]) => `<span class="cpair gone" title="Not possible: a card is already out">${chip(a)}${chip(b)}</span>`)].join("");
    return `<div class="cdet"><h3>${esc(name)} <span class="muted">· ${fmt(x.live)} of ${fmt(x.full || NORMAL[kind])}</span><button type="button" class="linkbtn" data-c="unfocus">Close</button></h3>
      <p>${how}${wNote}</p>${list ? `<div class="clist">${list}</div>` : `<p class="note">${R.any ? "" : "Not in the range."}</p>`}</div>`;
  }

  function draw() {
    const out = q(".cout");
    fillPresets();
    const { b, k, err, combos, rerr } = parsed();
    if (err || rerr) { out.innerHTML = `<p class="err">${esc(err || rerr)}</p>`; return; }
    const R = countCombos({ board: b, known: k, combos });
    const dead = [...b, ...k];
    // the headline numbers
    const steps = [`A full deck: 52 cards → 52 × 51 ÷ 2 = <b>1,326</b> hands.`];
    if (b.length) steps.push(`The board shows ${b.length} card${b.length > 1 ? "s" : ""}: ${52 - b.length} unseen → <b>${fmt(C2(52 - b.length))}</b>.`);
    if (k.length) steps.push(`You can also see ${k.length} more: ${R.unseen} unseen → ${R.unseen} × ${R.unseen - 1} ÷ 2 = <b>${fmt(R.possible)}</b>.`);
    let h = `<div class="chead"><div class="cbig"><b>${fmt(R.live)}</b><span>${R.any ? "hands your opponent can hold" : "combos left in the range"}</span></div>
      <ol class="csteps">${steps.map(s => `<li>${s}</li>`).join("")}</ol></div>`;
    if (!R.any) {
      const parts = [`The range starts with <b>${fmt(R.full)}</b> combos${ext ? "" : ` (${pc(R.full / 1326)} of all hands)`}.`];
      if (R.byBoard > 0) parts.push(`The board removes <b>${fmt(R.byBoard)}</b>.`);
      if (R.byKnown > 0) parts.push(`Your cards remove <b>${fmt(R.byKnown)}</b>: that's the blocker effect.`);
      parts.push(`<b>${fmt(R.live)}</b> are left${R.possible ? `, ${pc(R.live / R.possible)} of the ${fmt(R.possible)} possible hands` : ""}.`);
      h += `<p class="csum">${parts.join(" ")}${ext ? ` <span class="muted">${esc(ext.label)}</span>` : ""}</p>`;
    }
    // grid
    const flt = filt ? (filt.t === "m" ? R.madeCells[filt.i] : R.drawCells[filt.i]) : null;
    let maxV = 0; for (let i = 0; i < 169; i++) maxV = Math.max(maxV, flt ? flt[i] : R.cells[i].live);
    let g = "";
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const i = r * 13 + c, x = R.cells[i], kind = kindOf(i), v = flt ? flt[i] : x.live;
      const inRange = R.any || x.full > 0;
      const share = flt ? (maxV ? v / maxV : 0) : v / NORMAL[kind];
      const cls = ["cc", kind === 0 ? "pp" : kind === 1 ? "su" : "of", !inRange ? "out" : "", focus === i ? "on" : "", inRange && !(v > 0) ? "zero" : "", share > 0.55 ? "hi" : ""].filter(Boolean).join(" ");
      g += `<button type="button" class="${cls}" data-cell="${i}" style="--f:${Math.max(0, Math.min(1, share)).toFixed(3)}" aria-label="${cellName(r, c)}: ${fmt(v)} combos" title="${cellName(r, c)}: ${fmt(v)} of ${NORMAL[kind]}"><span class="cn">${cellName(r, c)}</span><span class="cv">${inRange ? fmt(v) : ""}</span></button>`;
    }
    h += `<div class="cgridwrap"><div class="cgrid" role="group" aria-label="Combos left for each starting hand">${g}</div>
      <p class="note">${flt ? `Showing only <b>${esc(filt.t === "m" ? MADE[filt.i] : DRAWS[filt.i])}</b> combos. <button type="button" class="linkbtn" data-c="unfilter">Show every combo</button>` : "Each square shows how many combos of that hand are still possible: pairs start at 6, suited hands at 4, offsuit hands at 12. Click a square to see the math and the exact combos."}</p></div>`;
    if (focus != null) h += explainCell(R, focus, dead);
    // made hands and draws
    if (R.classed && R.live > 0) {
      const row = (name, v, t, i) => v > 0.0005 ? `<button type="button" class="crow${filt && filt.t === t && filt.i === i ? " on" : ""}" data-f="${t}${i}"><span>${esc(name)}</span><span class="cbar"><i style="width:${Math.min(100, v / R.live * 100).toFixed(1)}%"></i></span><b>${fmt(v)}</b><span class="muted">${pc(v / R.live)}</span></button>` : "";
      const m = MADE.map((n, i) => row(n, R.made[i], "m", i)).join(""), d = DRAWS.map((n, i) => row(n, R.draws[i], "d", i)).join("");
      h += `<div class="ccats"><div><h3>What ${R.any ? "those hands" : "the range"} ${b.length === 5 ? "made" : "has now"}</h3>${m}</div>${d ? `<div><h3>Draws</h3>${d}<p class="note">Draws are counted on top of the made hand (a flush draw with a pair shows in both).</p></div>` : ""}
        <p class="note">Click a row to see where those combos sit in the grid.</p></div>`;
    } else if (b.length && b.length < 3) h += `<p class="note">Add the whole flop to sort the combos into made hands and draws.</p>`;
    out.innerHTML = h;
  }

  el.addEventListener("input", e => {
    const t = e.target, c = t.dataset.c;
    if (c === "board") { board = t.value; draw(); }
    else if (c === "known") { known = t.value; draw(); }
    else if (c === "range") { range = t.value; ext = null; filt = null; preset = ""; draw(); }
  });
  el.addEventListener("change", e => {
    const t = e.target; if (t.dataset.c !== "preset" || !t.value) return;
    const v = t.value;
    if (v.startsWith("sv")) { fromSolver(+v[2]); preset = ext || range ? v : ""; draw(); }
    else { ext = null; preset = v; range = PRESETS[v] || ""; const r = q('[data-c="range"]'); r.value = range; r.placeholder = "Like QQ+,AKs,AQo or 22+:0.5"; filt = null; focus = null; draw(); }
  });
  el.addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.cell != null) { const i = +t.dataset.cell; focus = focus === i ? null : i; draw(); return; }
    if (t.dataset.f) { const f = { t: t.dataset.f[0], i: +t.dataset.f.slice(1) }; filt = filt && filt.t === f.t && filt.i === f.i ? null : f; draw(); return; }
    const c = t.dataset.c;
    if (c === "unfocus") { focus = null; draw(); }
    else if (c === "unfilter") { filt = null; draw(); }
    else if (c === "clear") { preset = ""; setAll("", "", ""); }
    else if (c === "table") fromTable();
    else if (c === "solver") fromSolver(null);
  });
  function setAll(b, k, r, x) {
    board = b; known = k; range = r; ext = x || null; focus = null; filt = null;
    q('[data-c="board"]').value = board; q('[data-c="known"]').value = known; q('[data-c="range"]').value = ext ? "" : range;
    q('[data-c="range"]').placeholder = ext ? `Using ${ext.label} (type to replace it)` : "Like QQ+,AKs,AQo or 22+:0.5";
    draw();
  }
  // the table: its board, and your hand (a teacher gets the cards of the player to act)
  function fromTable() {
    const P = opt.table && opt.table.current(); if (!P) return;
    const T = opt.table.isTeacher(), me = opt.table.mySeat();
    let cards = null;
    if (!T && me >= 0) cards = opt.table.myCards() || (P.seats[me] && P.seats[me].cards);
    else if (T) { const i = P.toAct != null ? P.toAct : P.seats.findIndex(s => s.has && !s.folded); cards = i >= 0 && P.seats[i] ? P.seats[i].cards : null; }
    setAll((P.board || []).join(" "), cards ? cards.join(" ") : "", range, ext);
    if (opt.flash && !(P.board || []).length) opt.flash("No board yet: the counter shows preflop combos");
  }
  // the solver: its board, and one player's range (at the spot on screen after a solve)
  function fromSolver(k) {
    const S = opt.solver && opt.solver();
    if (!S) { if (opt.flash) opt.flash("The solver isn't open to you right now"); return; }
    const sp = S.state && S.state.spot, nr = S.nodeRanges && S.nodeRanges(), nm = S.names ? S.names() : ["OOP", "IP"];
    if (k == null) k = 1;
    if (nr) { setAll(nr.board.map(cardStr).join(" "), known, "", { combos: nr.combos[k], label: `· ${nr.names[k]}'s range after ${nr.at}, each hand weighted by how often it gets there` }); return; }
    const r = S.ranges ? S.ranges()[k] : "";
    setAll(sp && sp.board ? sp.board.map(cardStr).join(" ") : board, known, r || "", null);
    if (!r && opt.flash) opt.flash(`The solver's ${nm[k]} range is blank`);
  }
  draw();
  addEventListener("hsp-charts", () => draw());
  return { draw, fromTable, fromSolver, setAll, state: () => ({ board, known, range }) };
}
