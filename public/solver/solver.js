// Solver page: set up a heads-up postflop spot, solve it in a Web Worker, browse the answer.
// Card ids follow the engine: id = 4 * rank + suit (rank 0 = deuce .. 12 = ace; suits c, d, h, s).
import { RK, cellName, cellCombos, parseRange, formatRange, comboCount, PRESETS, guessRanges } from "./range.js";

const $ = id => document.getElementById(id);
const RANKS = "23456789TJQKA", SUITS = "cdhs", SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const cardStr = id => RANKS[id >> 2] + SUITS[id & 3];
const cardId = s => 4 * RANKS.indexOf(s[0].toUpperCase()) + SUITS.indexOf(s[1].toLowerCase());
const usd = cents => "$" + (Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
const pct = x => (Math.round(x * 1000) / 10).toFixed(1) + "%";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cardHTML = (id, cls = "", tag = "span", attrs = "") => {
  const s = cardStr(id);
  return `<${tag} class="pc ${s[1]} ${cls}" ${attrs} aria-label="${s[0] === "T" ? "10" : s[0]}${SYM[s[1]]}"><span class="r">${s[0] === "T" ? "10" : s[0]}</span><span class="s">${SYM[s[1]]}</span></${tag}>`;
};
const cardsTxt = (a, b) => [a, b].map(id => { const s = cardStr(id); return `<span class="${s[1]}">${s[0]}${SYM[s[1]]}</span>`; }).join("");

const TREES = {
  quick: ["50%", "", "66%", "", "75%", ""],
  standard: ["50%", "3x", "66%", "3x", "75%", "3x"],
  detailed: ["33%, 75%", "3x", "66%, 125%", "3x", "50%, 100%, 150%", "3x"],
};
const SIZE_IDS = ["fb", "fr", "tb", "tr", "rb", "rr"];

/* ---------- theme ---------- */
function syncTheme() { $("themeBtn").textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode"; }
$("themeBtn").onclick = () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = t; try { localStorage.setItem("hsp-theme", t); } catch (e) {}
  syncTheme();
};
syncTheme();

/* ---------- setup state ---------- */
let solved = null, busy = false;
const st = {
  board: [cardId("Qs"), cardId("Jh"), cardId("2h")],
  ranges: [PRESETS["BB defend vs late open"], PRESETS["Open BTN"]],
  names: ["BB", "BTN"],
  tab: 0, paintW: 1,
};

function renderBoard() {
  const slots = [];
  for (let k = 0; k < 5; k++) slots.push(st.board[k] !== undefined ? cardHTML(st.board[k]) : `<span class="pc slot" aria-hidden="true"></span>`);
  $("boardShow").innerHTML = slots.join("");
  let h = "";
  for (const s of [3, 2, 1, 0]) for (let r = 12; r >= 0; r--) {
    const id = 4 * r + s, on = st.board.includes(id);
    h += cardHTML(id, on ? "cur" : "", "button", `type="button" data-card="${id}" aria-pressed="${on}"${!on && st.board.length >= 5 ? " disabled" : ""}`);
  }
  $("deck").innerHTML = h;
}
$("deck").onclick = e => {
  const b = e.target.closest("[data-card]"); if (!b) return;
  const id = +b.dataset.card, i = st.board.indexOf(id);
  if (i >= 0) st.board.splice(i, 1); else if (st.board.length < 5) st.board.push(id);
  renderBoard(); dirty();
};

/* ---------- range editor ---------- */
let cur = parseRange(st.ranges[0]);
function renderRangeGrid() {
  const w = cur.w; let h = "";
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const v = w[r * 13 + c];
    h += `<button type="button" class="rc" data-cell="${r * 13 + c}" aria-label="${cellName(r, c)} ${Math.round(v * 100)}%"><div class="fill" style="height:${v * 100}%"></div><span>${cellName(r, c)}</span></button>`;
  }
  $("rgrid").innerHTML = h;
}
function updateCell(i) {
  const el = $("rgrid").children[i]; if (!el) return;
  el.firstElementChild.style.height = cur.w[i] * 100 + "%";
}
function rangeInfo() {
  if (cur.err) { $("rinfo").textContent = cur.err; $("rinfo").className = "err"; return; }
  const n = comboCount(cur.w);
  $("rinfo").className = "note";
  $("rinfo").textContent = `${Math.round(n)} combos, ${pct(n / 1326)} of all hands.`;
}
function selectTab(t) {
  st.tab = t;
  $("tabOop").setAttribute("aria-selected", t === 0); $("tabIp").setAttribute("aria-selected", t === 1);
  $("who").value = st.names[t];
  $("rtext").value = st.ranges[t];
  cur = parseRange(st.ranges[t]);
  renderRangeGrid(); rangeInfo();
  $("preset").value = "";
}
$("tabOop").onclick = () => selectTab(0);
$("tabIp").onclick = () => selectTab(1);
$("who").oninput = () => { st.names[st.tab] = $("who").value.slice(0, 24); };
$("preset").innerHTML += Object.keys(PRESETS).map(k => `<option>${esc(k)}</option>`).join("");
$("preset").onchange = () => {
  const k = $("preset").value; if (!k) return;
  st.ranges[st.tab] = PRESETS[k]; $("rtext").value = PRESETS[k];
  cur = parseRange(PRESETS[k]); renderRangeGrid(); rangeInfo(); dirty();
};
$("rtext").oninput = () => {
  st.ranges[st.tab] = $("rtext").value;
  const p = parseRange($("rtext").value);
  if (!p.err) { cur = p; renderRangeGrid(); } else cur = { w: cur.w, err: p.err };
  rangeInfo(); dirty();
};
$("paintW").oninput = () => { st.paintW = +$("paintW").value / 100; $("paintTxt").textContent = $("paintW").value + "%"; };
$("clearR").onclick = () => { cur = { w: new Float32Array(169), err: "" }; commitGrid(); renderRangeGrid(); };
function commitGrid() { st.ranges[st.tab] = formatRange(cur.w); $("rtext").value = st.ranges[st.tab]; rangeInfo(); dirty(); }
// drag to paint: the first cell decides whether this stroke adds (at the paint weight) or clears
let paint = null;
$("rgrid").addEventListener("pointerdown", e => {
  const b = e.target.closest("[data-cell]"); if (!b) return;
  e.preventDefault();
  if (cur.err) { cur = { w: cur.w, err: "" }; }
  const i = +b.dataset.cell;
  paint = { v: Math.abs(cur.w[i] - st.paintW) < 1e-6 ? 0 : st.paintW, seen: new Set() };
  apply(i);
});
function apply(i) { if (!paint || paint.seen.has(i)) return; paint.seen.add(i); cur.w[i] = paint.v; updateCell(i); }
window.addEventListener("pointermove", e => {
  if (!paint) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const b = el && el.closest && el.closest("#rgrid [data-cell]");
  if (b) apply(+b.dataset.cell);
});
window.addEventListener("pointerup", () => { if (paint) { paint = null; commitGrid(); } });
window.addEventListener("pointercancel", () => { if (paint) { paint = null; commitGrid(); } });

/* ---------- bet sizes ---------- */
function setTree(name) { TREES[name].forEach((v, k) => { $(SIZE_IDS[k]).value = v; }); dirty(); }
document.querySelectorAll("[data-tree]").forEach(b => { b.onclick = () => setTree(b.dataset.tree); });
setTree("quick");
["pot", "eff", "rakePct", "rakeCap", ...SIZE_IDS, "acc", "maxIt", "allinT", "forceT"].forEach(id => { $(id).addEventListener("input", () => dirty()); });

/* ---------- a spot sent from the table: #s=<base64 JSON> ---------- */
function fromHash() {
  const m = /[#&]s=([^&]+)/.exec(location.hash); if (!m) return;
  let sp;
  try { const b = atob(m[1].replace(/-/g, "+").replace(/_/g, "/")); sp = JSON.parse(decodeURIComponent(escape(b))); } catch (e) { return; }
  if (!sp || !Array.isArray(sp.b) || !Array.isArray(sp.pl) || sp.pl.length !== 2) return;
  const board = sp.b.map(cardId).filter(x => x >= 0);
  if (board.length < 3) return;
  st.board = board.slice(0, 5);
  $("pot").value = +sp.pot || 1;
  $("eff").value = Math.max(0.01, Math.min(...sp.pl.map(p => +p.stack || 0)));
  if (sp.rake) { $("rakePct").value = +sp.rake.pct || 0; $("rakeCap").value = +sp.rake.cap || 0; }
  const guess = guessRanges(sp);
  st.ranges = guess.map(k => PRESETS[k]);
  st.names = sp.pl.map(p => [p.pos, p.name].filter(Boolean).join(" · ").slice(0, 24));
  setTree(st.board.length === 3 ? "quick" : "standard");
  const street = { 3: "flop", 4: "turn", 5: "river" }[st.board.length];
  $("fromTable").hidden = false;
  $("fromTable").textContent = `From the table: the ${street} of hand #${sp.hand || "?"}. Ranges are a starting guess (${guess[0]} vs ${guess[1]}); edit them to match your players.`;
}

/* ---------- the worker ---------- */
const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
let W = null, threads = 1, wantMT = self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" && !isSafari;
let onMsg = () => {};
function startWorker() {
  return new Promise(resolve => {
    if (W) W.terminate();
    W = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    $("engineChip").textContent = "Loading the solver…"; $("solveBtn").disabled = true;
    W.onmessage = ({ data }) => {
      if (data.t === "loaded") {
        threads = data.threads;
        $("engineChip").textContent = threads > 1 ? `Solver ready · ${threads} threads` : "Solver ready · 1 thread";
        $("solveBtn").disabled = false; onMsg = () => {}; resolve(true); return;
      }
      if (data.t === "error" && data.during === "load") {
        if (wantMT) { wantMT = false; startWorker().then(resolve); return; }
        $("engineChip").textContent = "The solver couldn't load in this browser"; msg("Error: " + data.msg); resolve(false); return;
      }
      onMsg(data);
    };
    W.onerror = e => { if (wantMT) { wantMT = false; startWorker().then(resolve); } else { msg("The solver stopped: " + (e.message || "unknown error")); resolve(false); } };
    W.postMessage({ t: "load", mt: wantMT });
  });
}
const ask = (m, until) => new Promise(resolve => { onMsg = d => { if (until(d)) resolve(d); else if (d.t === "progress") progress(d); }; W.postMessage(m); });

/* ---------- solving ---------- */
const msg = t => { $("msg").textContent = t || ""; };
function dirty() { if (solved && !busy) $("solveBtn").textContent = "Solve again"; }
function readSpot() {
  if (st.board.length < 3) throw "Pick at least three board cards (the flop).";
  const p = Math.round(+$("pot").value * 100), e = Math.round(+$("eff").value * 100);
  if (!(p > 0)) throw "The pot must be more than $0.";
  if (!(e > 0)) throw "The effective stack must be more than $0.";
  const rs = st.ranges.map(parseRange);
  rs.forEach((r, k) => { if (r.err) throw `${k ? "In position" : "Out of position"} range: ${r.err}`; if (!comboCount(r.w)) throw `The ${k ? "in position" : "out of position"} range is empty.`; });
  const cap = +$("rakeCap").value;
  return {
    oop: formatRange(rs[0].w), ip: formatRange(rs[1].w), board: st.board.slice(), pot: p, eff: e,
    rake: Math.max(0, Math.min(25, +$("rakePct").value || 0)) / 100, rakeCap: cap > 0 ? Math.round(cap * 100) : 1e12,
    fb: $("fb").value, fr: $("fr").value, tb: $("tb").value, tr: $("tr").value, rb: $("rb").value, rr: $("rr").value,
    allinT: Math.max(0, +$("allinT").value || 0), forceT: Math.max(0, +$("forceT").value || 0),
    names: st.names.slice(),
  };
}
let e0 = null, targetCents = 0, maxIt = 1000;
function progress(d) {
  $("prog").hidden = false;
  if (d.e == null) { $("progTxt").textContent = "Starting…"; $("progBar").style.width = "0"; return; }
  if (e0 == null) e0 = Math.max(d.e, targetCents * 1.01);
  const f = Math.max(Math.min(Math.log(e0 / Math.max(d.e, 1e-9)) / Math.log(e0 / targetCents), 1), d.i / maxIt, 0);
  $("progBar").style.width = Math.min(100, f * 100) + "%";
  $("progTxt").textContent = `Iteration ${d.i} · within ${pct(d.e / solved.pot)} of perfect play (aiming for ${$("acc").value}%)`;
}
const GB = n => (n / 1e9).toFixed(n < 1e9 ? 2 : 1) + " GB";
$("solveBtn").onclick = async () => {
  if (busy) return;
  let sp;
  try { sp = readSpot(); } catch (e) { msg(String(e)); return; }
  msg(""); busy = true; $("solveBtn").disabled = true; $("stopBtn").hidden = false; $("stopBtn").disabled = false;
  $("prog").hidden = false; $("progBar").style.width = "0"; $("progTxt").textContent = "Building the game tree…";
  try {
    const s = await ask({ t: "setup", spot: sp }, d => d.t === "setup" || d.t === "error");
    if (s.t === "error") throw "Error: " + s.msg;
    if (s.err) throw s.err;
    const [full, small] = s.mem, LIMIT = 3.8e9;
    let compress = full > 1.5e9;
    if ((compress ? small : full) > LIMIT) throw `This spot needs about ${GB(small)} of memory, more than a browser can use. Try the Quick sizes, fewer bet sizes, or narrower ranges.`;
    const need = compress ? small : full;
    if (navigator.deviceMemory && need > navigator.deviceMemory * 1e9 * 0.6) msg(`Heads up: this spot needs about ${GB(need)}, a lot for this device. If the page crashes, try the Quick sizes.`);
    solved = { ...sp, cards: s.cards, mem: need };
    e0 = null; targetCents = Math.max(1, sp.pot * (+$("acc").value || 0.5) / 100); maxIt = Math.max(10, Math.min(5000, +$("maxIt").value || 1000));
    $("progTxt").textContent = `Using ${GB(need)} of memory${compress ? " (compressed)" : ""}…`;
    const t0 = Date.now();
    const r = await ask({ t: "solve", compress, target: targetCents, maxIter: maxIt }, d => d.t === "solved" || d.t === "error");
    if (r.t === "error") throw "The solver ran out of memory or hit an error: " + r.msg;
    $("progBar").style.width = "100%";
    $("progTxt").textContent = `${r.stopped ? "Stopped" : "Done"} after ${r.i} iterations in ${((Date.now() - t0) / 1000).toFixed(1)} s · within ${pct(r.e / sp.pot)} of perfect play.`;
    $("solveBtn").textContent = "Solve again";
    path = [{ hist: [], label: "Start" }];
    await show();
  } catch (e) {
    msg(String(e)); if (/memory|error/i.test(String(e))) { solved = null; await startWorker(); }
  } finally {
    busy = false; $("solveBtn").disabled = !W; $("stopBtn").hidden = true;
  }
};
$("stopBtn").onclick = () => { if (busy && W) { W.postMessage({ t: "stop" }); $("stopBtn").disabled = true; } };

/* ---------- results ---------- */
let path = [], node = null, view = "strat", selCell = null;
const COLORS = { Fold: "#5b8def", Check: "#4caf73", Call: "#4caf73" };
const AGG = ["#e8a33d", "#e0703c", "#d1453b", "#b02f4a", "#8e2a63"];
function actionList(acts, potNow) {
  let k = 0;
  return acts.split("/").filter(Boolean).map(s => {
    const [type, a] = s.split(":"), amt = +a;
    let label = type, color = COLORS[type];
    if (type === "Bet") label = `Bet ${usd(amt)} (${Math.round(amt / potNow * 100)}%)`;
    else if (type === "Raise") label = `Raise to ${usd(amt)}`;
    else if (type === "Allin") label = `All-in ${usd(amt)}`;
    if (!color) color = type === "Allin" ? "#7a1f3d" : AGG[Math.min(k++, AGG.length - 1)];
    return { type, amt, label, color };
  });
}
function parseRes(buf, p, na) {
  const [n0, n1] = [solved.cards[0].length, solved.cards[1].length];
  let o = 3; const take = n => buf.subarray(o, o += n);
  const flag = buf[2];
  const r = { pot: [buf[0], buf[1]], flag, w: [take(n0), take(n1)], norm: [take(n0), take(n1)] };
  if (!flag) { r.eq = [take(n0), take(n1)]; r.ev = [take(n0), take(n1)]; r.eqr = [take(n0), take(n1)]; }
  if (na) { const nc = p === "oop" ? n0 : n1; r.strat = take(na * nc); if (!flag) r.aev = take(na * nc); }
  return r;
}
function cellOf(code) {
  const a = code & 255, b = code >> 8, ra = a >> 2, rb = b >> 2;
  const hi = 12 - Math.max(ra, rb), lo = 12 - Math.min(ra, rb);
  if (ra === rb) return hi * 13 + hi;
  return (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
}
async function show() {
  const cur = path[path.length - 1];
  node = await ask({ t: "node", hist: cur.hist }, d => d.t === "node" || d.t === "error");
  if (node.t === "error") { msg("Error: " + node.msg); return; }
  const potNow = solved.pot + node.tb[0] + node.tb[1];
  node.potNow = potNow;
  node.actions = node.p === "oop" || node.p === "ip" ? actionList(node.acts, potNow) : [];
  node.r = parseRes(node.res, node.p, node.actions.length);
  if (node.p !== "oop" && node.p !== "ip" && view === "strat") view = "eq0";
  if ((node.p === "oop" || node.p === "ip") && view !== "strat" && cur.autoStrat !== false) view = "strat";
  renderResults();
}
function boardNow() {
  const dealt = path.map(s => s.card).filter(c => c !== undefined);
  return solved.board.concat(dealt);
}
function renderResults() {
  $("resEmpty").hidden = true; $("resBody").hidden = false;
  const bd = boardNow(), street = { 3: "Flop", 4: "Turn", 5: "River" }[bd.length];
  // path
  $("path").innerHTML = path.map((s, i) => i === path.length - 1 ? `<span class="chip">${esc(s.label)}</span>` : `<button class="b sm" type="button" data-back="${i}">${esc(s.label)}</button><span class="muted">›</span>`).join("");
  // header
  const who = node.p === "oop" ? solved.names[0] || "Out of position" : node.p === "ip" ? solved.names[1] || "In position" : "";
  const what = node.p === "chance" ? `Next card` : node.p === "terminal" ? "The hand is over on this line" : `${esc(who)} to act`;
  $("nodeHead").innerHTML = `<span class="boardrow">${bd.map(c => cardHTML(c)).join("")}</span><b>${street} · ${what}</b><span class="muted">Pot ${usd(node.potNow)}</span>`;
  // summary of both players
  const r = node.r;
  const avg = (vals, k) => { let s = 0, t = 0; const nw = r.norm[k]; for (let i = 0; i < nw.length; i++) { s += nw[i] * vals[i]; t += nw[i]; } return t ? s / t : 0; };
  let sum = "";
  if (!r.flag) sum = [0, 1].map(k => `<span>${esc(solved.names[k] || (k ? "In position" : "Out of position"))}: equity <b>${pct(avg(r.eq[k], k))}</b>, EV <b>${usd(avg(r.ev[k], k))}</b></span>`).join("");
  // actions or next-card picker
  let acts = "";
  if (node.actions.length) {
    const k = node.p === "oop" ? 0 : 1, nc = solved.cards[k].length, nw = r.norm[k];
    let tot = 0; for (let i = 0; i < nc; i++) tot += nw[i];
    node.actions.forEach((a, ai) => { let f = 0; for (let i = 0; i < nc; i++) f += nw[i] * r.strat[ai * nc + i]; a.freq = tot ? f / tot : 0; });
    acts = node.actions.map((a, ai) => `<button class="b" type="button" data-act="${ai}" style="border-left-color:${a.color}"><span>${esc(a.label)}</span><small>${pct(a.freq)} of hands</small></button>`).join("");
  } else if (node.p === "chance") {
    let h = `<p class="note" style="width:100%;margin:0">Pick the ${bd.length === 3 ? "turn" : "river"} card to keep going.</p><div class="deck sdeck">`;
    for (const s of [3, 2, 1, 0]) for (let rr = 12; rr >= 0; rr--) {
      const id = 4 * rr + s, ok = Math.floor(node.possible / 2 ** id) % 2 === 1;
      h += cardHTML(id, "", "button", `type="button" data-deal="${id}"${ok ? "" : " disabled"}`);
    }
    acts = h + "</div>";
  } else if (node.p === "terminal") acts = `<p class="note">Someone folded, or the hand went to showdown. Go back with the buttons above.</p>`;
  $("acts").innerHTML = `<div class="summary" style="width:100%">${sum}</div>` + acts;
  // view tabs
  const tabs = [];
  if (node.actions.length) tabs.push(["strat", "Strategy"]);
  if (!r.flag) tabs.push(["eq0", (solved.names[0] || "OOP") + " equity"], ["eq1", (solved.names[1] || "IP") + " equity"]);
  $("legend").innerHTML = `<div class="tabs" style="width:100%;margin:0">${tabs.map(([v, l]) => `<button class="tab" type="button" data-view="${v}" aria-selected="${view === v}">${esc(l)}</button>`).join("")}</div>` +
    (view === "strat" ? node.actions.map(a => `<span><i style="background:${a.color}"></i>${esc(a.label)}</span>`).join("") : `<span><i style="background:#d1453b"></i>low equity</span><span><i style="background:#e8a33d"></i>middle</span><span><i style="background:#4caf73"></i>high equity</span><span>Fill height = how much of that hand is still in the range</span>`);
  renderGrid();
  renderDetail();
}
function eqColor(x) { // red -> amber -> green
  const a = [209, 69, 59], b = [232, 163, 61], c = [76, 175, 115];
  const [p, q, t] = x < 0.5 ? [a, b, x * 2] : [b, c, (x - 0.5) * 2];
  return `rgb(${p.map((v, i) => Math.round(v + (q[i] - v) * t)).join(",")})`;
}
function cellStats(k) {
  // per cell: list of combo indexes, reach weight, normalized weight
  const cells = Array.from({ length: 169 }, () => ({ hs: [], w: 0, nw: 0 }));
  const cs = solved.cards[k], r = node.r;
  for (let i = 0; i < cs.length; i++) { const c = cells[cellOf(cs[i])]; c.hs.push(i); c.w += r.w[k][i]; c.nw += r.norm[k][i]; }
  return cells;
}
function renderGrid() {
  const k = view === "strat" ? (node.p === "oop" ? 0 : 1) : view === "eq1" ? 1 : 0;
  const cells = cellStats(k), r = node.r, nc = solved.cards[k].length, bd = new Set(boardNow());
  let h = "";
  for (let ro = 0; ro < 13; ro++) for (let co = 0; co < 13; co++) {
    const i = ro * 13 + co, c = cells[i];
    // combos of this hand class not blocked by the board
    let live = cellCombos(ro, co);
    { const r1 = 12 - ro, r2 = 12 - co; let n = 0;
      for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
        const a = 4 * (ro <= co ? r1 : r2) + s1, b = 4 * (ro <= co ? r2 : r1) + s2;
        if (ro === co ? s2 <= s1 : ro < co ? s1 !== s2 : s1 === s2) continue;
        if (!bd.has(a) && !bd.has(b)) n++;
      }
      live = n; }
    const hgt = live ? Math.min(1, c.w / live) : 0;
    let bars = "";
    if (c.nw > 0 && hgt > 0.001) {
      if (view === "strat") {
        bars = node.actions.map((a, ai) => { let f = 0; for (const hI of c.hs) f += r.norm[k][hI] * r.strat[ai * nc + hI]; return `<i style="width:${f / c.nw * 100}%;background:${a.color}"></i>`; }).join("");
      } else if (!r.eq) {
        bars = `<i style="width:100%;background:var(--brass)"></i>`;
      } else {
        let e = 0; for (const hI of c.hs) e += r.norm[k][hI] * r.eq[k][hI];
        bars = `<i style="width:100%;background:${eqColor(e / c.nw)}"></i>`;
      }
    }
    h += `<button type="button" class="rc${hgt <= 0.001 ? " empty" : ""}${selCell === i ? " sel" : ""}" data-cell="${i}"><div class="bars" style="height:${hgt * 100}%">${bars}</div><span>${cellName(ro, co)}</span></button>`;
  }
  $("sgrid").innerHTML = h;
}
function renderDetail() {
  if (selCell == null) { $("detail").innerHTML = `<p class="note">Tap a hand to see each combo.</p>`; return; }
  const k = view === "strat" ? (node.p === "oop" ? 0 : 1) : view === "eq1" ? 1 : 0;
  const cells = cellStats(k), c = cells[selCell], r = node.r, nc = solved.cards[k].length, cs = solved.cards[k];
  const name = cellName(Math.floor(selCell / 13), selCell % 13);
  const rows = c.hs.filter(i => r.w[k][i] > 0.0005);
  if (!rows.length) { $("detail").innerHTML = `<p class="note">${name}: not in ${esc(solved.names[k] || "this")} range here.</p>`; return; }
  if (!r.flag) rows.sort((a, b) => r.ev[k][b] - r.ev[k][a]);
  const strat = view === "strat";
  const head = `<tr><th>${name}</th><th>In range</th>${r.flag ? "" : "<th>Equity</th><th>EV</th>"}${strat ? node.actions.map(a => `<th style="color:${a.color}">${esc(a.label.replace(/ \(.*\)/, ""))}</th>`).join("") : ""}</tr>`;
  const body = rows.map(i => `<tr><td class="cards">${cardsTxt(cs[i] & 255, cs[i] >> 8)}</td><td>${pct(r.w[k][i])}</td>${r.flag ? "" : `<td>${pct(r.eq[k][i])}</td><td>${usd(r.ev[k][i])}</td>`}${strat ? node.actions.map((a, ai) => `<td>${pct(r.strat[ai * nc + i])}</td>`).join("") : ""}</tr>`).join("");
  $("detail").innerHTML = `<table>${head}${body}</table>`;
}
$("resBody").addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t || busy) return;
  if (t.dataset.back !== undefined) { path = path.slice(0, +t.dataset.back + 1); return show(); }
  if (t.dataset.act !== undefined) {
    const a = node.actions[+t.dataset.act], who = node.p === "oop" ? (solved.names[0] || "OOP") : (solved.names[1] || "IP");
    path.push({ hist: path[path.length - 1].hist.concat(+t.dataset.act), label: `${who.split(" · ")[0]} ${a.label.replace(/ \(.*\)/, "").toLowerCase()}` });
    return show();
  }
  if (t.dataset.deal !== undefined) {
    const id = +t.dataset.deal, s = cardStr(id);
    path.push({ hist: path[path.length - 1].hist.concat(id), label: (s[0] === "T" ? "10" : s[0]) + SYM[s[1]], card: id });
    return show();
  }
  if (t.dataset.view) { view = t.dataset.view; path[path.length - 1].autoStrat = view === "strat"; renderResults(); return; }
  if (t.dataset.cell !== undefined) { selCell = selCell === +t.dataset.cell ? null : +t.dataset.cell; renderGrid(); renderDetail(); }
});

/* ---------- start ---------- */
fromHash();
renderBoard();
selectTab(0);
startWorker();
window.__solverReady = () => !$("solveBtn").disabled;
