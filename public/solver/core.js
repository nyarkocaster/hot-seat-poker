// Hot Seat Poker solver, as a component. Used by the standalone /solver/ page and inside the table page.
// - Setup (board, ranges, sizes) and the place in the game tree can be shared with a lobby: every
//   change is sent as a patch, and one computer (whoever pressed Solve) runs the solve and answers
//   everyone else's "show me this node" requests through the lobby server.
// - Solves run in this browser (small trees) or in the Hot Seat Solver app on this computer (any size).
// - Linked to a table hand, it follows the table's cards and bets, and a teacher picking the next card
//   in the solver sets that card on the table.
// Card ids follow the engine: id = 4 * rank + suit (rank 0 = deuce .. 12 = ace; suits c, d, h, s).
import { cellName, cellCombos, parseRange, formatRange, comboCount, PRESETS } from "./range.js";

const RANKS = "23456789TJQKA", SUITS = "cdhs", SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const APP_PORT = 47123;
export const APP_PAGE = "/solver/app.html";
const cardStr = id => RANKS[id >> 2] + SUITS[id & 3];
const cardId = s => 4 * RANKS.indexOf(String(s)[0].toUpperCase()) + SUITS.indexOf(String(s)[1].toLowerCase());
const cardLabel = id => { const s = cardStr(id); return (s[0] === "T" ? "10" : s[0]) + SYM[s[1]]; };
const usd = cents => "$" + (Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: Math.round(cents) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const pct = x => (Math.round(x * 1000) / 10).toFixed(1) + "%";
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const GB = n => n < 1e9 ? Math.max(1, Math.round(n / 1e6)) + " MB" : (n / 1e9).toFixed(1) + " GB";
const rid = () => Math.random().toString(36).slice(2, 10);
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const cardHTML = (id, cls = "", tag = "span", attrs = "") => {
  const s = cardStr(id), r = s[0] === "T" ? "10" : s[0];
  return `<${tag} class="pc ${s[1]} ${cls}" ${attrs} aria-label="${r}${SYM[s[1]]}"><span class="r">${r}</span><span class="s">${SYM[s[1]]}</span></${tag}>`;
};
const cardsTxt = (a, b) => [a, b].map(id => { const s = cardStr(id); return `<span class="${s[1]}">${s[0]}${SYM[s[1]]}</span>`; }).join("");
const hasCard = (mask, id) => Math.floor(mask / 2 ** id) % 2 === 1;

export const TREES = {
  quick: ["50%", "", "66%", "", "75%", ""],
  standard: ["50%", "3x", "66%", "3x", "75%", "3x"],
  detailed: ["33%, 75%", "3x", "66%, 125%", "3x", "50%, 100%, 150%", "3x"],
};
const SIZE_KEYS = ["fb", "fr", "tb", "tr", "rb", "rr"];
const BROWSER_LIMIT = 3.8e9;

/* ---------- engines: the browser (Web Worker + WebAssembly) or the solver app (localhost) ---------- */
class Engine {
  constructor(kind) { this.kind = kind; this.q = Promise.resolve(); this.listener = null; this.threads = 1; this.ram = 0; }
  _onmsg(d) { if (this.listener) this.listener(d); }
  ask(m, until, onOther) {
    const run = () => new Promise((resolve, reject) => {
      this.listener = d => {
        if (d.t === "error") { this.listener = null; reject(new Error(d.msg || "The solver hit an error.")); }
        else if (until(d)) { this.listener = null; resolve(d); }
        else if (onOther) onOther(d);
      };
      this._post(m);
    });
    const p = this.q.then(run, run); this.q = p.catch(() => {}); return p;
  }
  stop() { this._post({ t: "stop" }); }
  async node(hist) {
    const d = await this.ask({ t: "node", hist }, d => d.t === "node");
    return { p: d.p, acts: d.acts, tb: d.tb, possible: d.possible, res: d.res instanceof Float64Array ? d.res : Float64Array.from(d.res) };
  }
}
class BrowserEngine extends Engine {
  constructor() { super("browser"); }
  async init(mt) {
    this.w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.w.onmessage = ({ data }) => this._onmsg(data);
    this.w.onerror = e => this._onmsg({ t: "error", msg: e.message || "The solver stopped." });
    const d = await this.ask({ t: "load", mt }, d => d.t === "loaded");
    this.threads = d.threads;
  }
  _post(m) { this.w.postMessage(m); }
  close() { try { this.w.terminate(); } catch (e) {} }
}
class AppEngine extends Engine {
  constructor() { super("app"); this.ready = false; }
  init() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}`); } catch (e) { reject(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { reject(new Error("timeout")); try { ws.close(); } catch (e) {} }, 4000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "load" }));
      ws.onmessage = e => {
        let d; try { d = JSON.parse(e.data); } catch (x) { return; }
        if (d.t === "loaded" && !this.ready) { this.ready = true; clearTimeout(to); this.threads = d.threads; this.ram = d.ram; resolve(); return; }
        this._onmsg(d);
      };
      ws.onclose = () => {
        clearTimeout(to);
        if (!this.ready) { reject(new Error("closed")); return; }
        this.closed = true; this._onmsg({ t: "error", msg: "The solver app was closed." });
        if (this.onclose) this.onclose();
      };
    });
  }
  _post(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); else this._onmsg({ t: "error", msg: "The solver app isn't connected." }); }
  close() { try { this.ws.close(); } catch (e) {} }
}
const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
async function startBrowserEngine() {
  const mt = self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" && !isSafari;
  if (mt) { const e = new BrowserEngine(); try { await e.init(true); return e; } catch (x) { e.close(); } }
  const e = new BrowserEngine(); await e.init(false); return e;
}

/* node results travel between computers as base64 Float32 */
function encodeNode(n) {
  const f = Float32Array.from(n.res), b = new Uint8Array(f.buffer); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return { p: n.p, acts: n.acts, tb: n.tb, possible: n.possible, r: btoa(s) };
}
function decodeNode(d) {
  const s = atob(d.r), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return { p: d.p, acts: d.acts, tb: d.tb, possible: d.possible, res: new Float32Array(b.buffer) };
}

export function applySpotPatch(spot, d) {
  for (const k of Object.keys(d)) {
    const m = /^(ranges|names|sizes)\.(\d)$/.exec(k);
    if (m) { spot[m[1]] = (spot[m[1]] || []).slice(); spot[m[1]][+m[2]] = d[k]; }
    else spot[k] = d[k];
  }
  return spot;
}
export function defaultSpot() {
  return { board: ["Qs", "Jh", "2h"].map(cardId), pot: 5.5, eff: 97.5, rakePct: 0, rakeCap: 0,
    ranges: ["", ""], names: ["BB", "BTN"],
    sizes: TREES.quick.slice(), acc: 0.5, maxIt: 1000, allinT: 1.5, forceT: 0.15, note: "" };
}
// fill in anything missing (a lobby's saved setup can hold only the fields someone edited)
export function normalizeSpot(sp) {
  const d = defaultSpot(), o = { ...d, ...(sp || {}) };
  for (const k of ["ranges", "names", "sizes"]) o[k] = d[k].map((v, i) => (Array.isArray(o[k]) && typeof o[k][i] === "string" ? o[k][i] : v));
  if (!Array.isArray(o.board) || o.board.some(c => !(c >= 0 && c < 52))) o.board = d.board;
  for (const k of ["pot", "eff", "rakePct", "rakeCap", "acc", "maxIt", "allinT", "forceT"]) if (!Number.isFinite(+o[k])) o[k] = d[k];
  if (typeof o.note !== "string") o.note = "";
  return o;
}
export function defaultShared() {
  return { spot: defaultSpot(), link: null, sync: true, status: "idle", host: null, hostName: "", where: "", threads: 0,
    prog: null, info: null, cards: null, solved: null, path: [{ hist: [], label: "Start" }], solveId: null, err: "", mem: 0 };
}

/* A spot recorded by the table (engine noteSpot) turned into solver setup. The solver plays two
   players, so in a multiway pot it studies two of them (seats = their seat numbers, or a default pair)
   with the whole pot in the middle. sp.pl is in postflop order: first to act first. */
export function spotFromTable(sp, P, seats) {
  const r = (P && P.rules) || {};
  const street = { flop: "flop", turn: "turn", river: "river" }[sp.st];
  const all = sp.pl;
  let pick = Array.isArray(seats) && seats.length === 2 ? all.filter(p => seats.includes(p.i)) : [];
  if (pick.length !== 2) {
    if (all.length <= 2) pick = all.slice();
    else { const ag = all.find(p => p.agg); const last = all[all.length - 1];
      pick = ag ? [ag, ag === last ? all[0] : last] : [all[0], last]; }
    pick.sort((a, b) => all.indexOf(a) - all.indexOf(b));
  }
  const who = l => l.map(p => p.pos || p.name).join(" vs ");
  const multi = all.length > 2;
  return {
    spot: { ...defaultSpot(), board: sp.board.map(cardId), pot: sp.pot, eff: Math.max(0.01, Math.min(...pick.map(p => +p.stack || 0))),
      rakePct: r.rakePct || 0, rakeCap: r.rakeCap || 0,
      names: pick.map(p => [p.pos, p.name].filter(Boolean).join(" · ").slice(0, 24)),
      sizes: (sp.board.length === 3 ? TREES.quick : TREES.standard).slice(),
      note: multi
        ? `From the table: the ${street} of hand #${P ? P.hand : "?"}, ${all.length} players (${all.map(p => p.pos || p.name).join(", ")}). The solver plays two at a time, so this studies ${who(pick)} with the whole pot. Change who under “Players to study”. Set both ranges with “Load a starting range” or by painting the grid.`
        : `From the table: the ${street} of hand #${P ? P.hand : "?"}, ${who(pick)}. Set both ranges with “Load a starting range” or by painting the grid.` },
    link: { hand: P ? P.hand : 0, st: sp.st, seats: pick.map(p => p.i), ...(multi ? { all: all.map(p => ({ i: p.i, pos: p.pos || "", name: p.name || "" })) } : {}) },
  };
}

/* ---------- the component ---------- */
// opt.transport: {send(msg), peer(), name(), canEdit()} to share with a lobby (null = this device only)
// opt.table: {current() -> public table view, canPush(), push(boardIndex, "8d")} for table sync
// opt.anchors: add data-anc attributes so lobby pointers can show on the solver
export function createSolver(root, opt = {}) {
  const T = opt.transport || null, TB = opt.table || null, shared = !!T;
  const me = () => (shared ? T.peer() : "me");
  let sv = defaultShared();
  let tab = 0, paintW = 1, explore = false, myPath = null, selCell = null, view = "strat";
  let engine = null, engineSolveId = null, appTried = false, bigMsg = null, localErr = "", viewPinned = false;
  const cache = new Map(), pending = new Map();
  let tablePath = null, tableKey = "", node = null, nodeKey = "", gen = 0;

  const anc = a => (opt.anchors ? ` data-anc="${a}"` : "");
  root.classList.add("svroot");
  root.innerHTML = `
  <div class="svbar" id="sv-bar"></div>
  <div class="sgrid">
    <section class="main sv-setup">
      <div class="panel" id="sv-pSpot"${anc("svspot")}>
        <h2>Spot</h2>
        <p class="note" id="sv-note" hidden></p>
        <div class="field" id="sv-pairF" hidden><label for="sv-pair">Players to study</label><select id="sv-pair"></select></div>
        <div class="field"><label>Board <span class="muted">(3 to 5 cards, tap to add or remove)</span></label>
          <div class="boardrow" id="sv-boardShow"></div>
          <div class="deck sdeck" id="sv-deck"${anc("svdeck")}></div>
        </div>
        <div class="fields">
          <div class="field"><label for="sv-pot">Pot at the start of this street ($)</label><input type="number" id="sv-pot" data-k="pot" min="0.01" step="0.01"></div>
          <div class="field"><label for="sv-eff">Effective stack ($)</label><input type="number" id="sv-eff" data-k="eff" min="0.01" step="0.01"></div>
          <div class="field"><label for="sv-rakePct">Rake (%)</label><input type="number" id="sv-rakePct" data-k="rakePct" min="0" max="25" step="0.5"></div>
          <div class="field"><label for="sv-rakeCap">Rake cap ($, 0 = none)</label><input type="number" id="sv-rakeCap" data-k="rakeCap" min="0" step="0.5"></div>
        </div>
      </div>
      <div class="panel" id="sv-pRange"${anc("svrange")}>
        <h2>Ranges</h2>
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" type="button" id="sv-tab0" aria-selected="true">Out of position</button>
          <button class="tab" role="tab" type="button" id="sv-tab1" aria-selected="false">In position</button>
        </div>
        <div class="fields">
          <div class="field"><label for="sv-who">Player</label><input type="text" id="sv-who" maxlength="24"></div>
          <div class="field"><label for="sv-preset">Load a starting range</label><select id="sv-preset"><option value="">Choose…</option>${Object.keys(PRESETS).map(k => `<option>${esc(k)}</option>`).join("")}</select></div>
        </div>
        <div class="rgrid" id="sv-rgrid"${anc("svrgrid")} aria-label="Range grid"></div>
        <div class="row paint"><label for="sv-paintW">Tap paints</label><input type="range" id="sv-paintW" min="0" max="100" step="5" value="100"><span id="sv-paintTxt">100%</span>
          <button class="b sm" type="button" id="sv-clearR">Clear</button></div>
        <div class="field"><label for="sv-rtext">Range text</label><textarea id="sv-rtext" rows="3" spellcheck="false"></textarea></div>
        <p class="note" id="sv-rinfo"></p>
      </div>
      <div class="panel" id="sv-pSizes"${anc("svsizes")}>
        <h2>Bet sizes</h2>
        <div class="row"><button class="b sm" type="button" data-tree="quick">Quick</button><button class="b sm" type="button" data-tree="standard">Standard</button><button class="b sm" type="button" data-tree="detailed">Detailed</button></div>
        <p class="note">Both players use the same sizes. Bets are a percentage of the pot; raises like “3x” are multiples of the bet. Leave raises empty for no raises. Quick and Standard trees run right in the browser. Bigger trees need the free <a href="${APP_PAGE}" target="_blank" rel="noopener">Hot Seat Solver app</a>.</p>
        <div class="sizes">
          <span></span><span class="muted">Bets</span><span class="muted">Raises</span>
          <span>Flop</span><input type="text" id="sv-fb" data-szi="0" aria-label="Flop bets"><input type="text" id="sv-fr" data-szi="1" aria-label="Flop raises">
          <span>Turn</span><input type="text" id="sv-tb" data-szi="2" aria-label="Turn bets"><input type="text" id="sv-tr" data-szi="3" aria-label="Turn raises">
          <span>River</span><input type="text" id="sv-rb" data-szi="4" aria-label="River bets"><input type="text" id="sv-rr" data-szi="5" aria-label="River raises">
        </div>
        <details class="adv"><summary>More settings</summary>
          <div class="fields">
            <div class="field"><label for="sv-acc">Stop at accuracy (% of pot)</label><input type="number" id="sv-acc" data-k="acc" min="0.05" max="10" step="0.05"></div>
            <div class="field"><label for="sv-maxIt">Most iterations</label><input type="number" id="sv-maxIt" data-k="maxIt" min="10" max="5000" step="10"></div>
            <div class="field"><label for="sv-allinT">Add all-in when stack is under (× pot)</label><input type="number" id="sv-allinT" data-k="allinT" min="0" step="0.5"></div>
            <div class="field"><label for="sv-forceT">Force all-in when a bet leaves under (× pot)</label><input type="number" id="sv-forceT" data-k="forceT" min="0" step="0.05"></div>
          </div>
        </details>
      </div>
      <div class="panel" id="sv-pRun"${anc("svrun")}>
        <div class="row"><button class="b primary big" type="button" id="sv-solve">Solve</button><button class="b" type="button" id="sv-stop" hidden>Stop</button></div>
        <div class="prog" id="sv-prog" hidden><div class="bar"><span id="sv-progBar"></span></div><p class="note" id="sv-progTxt"></p></div>
        <div class="err" id="sv-msg" role="status"></div>
        <div class="engline note" id="sv-eng"></div>
      </div>
    </section>
    <section class="main sv-results">
      <div class="panel" id="sv-pRes"${anc("svres")}>
        <h2>Results</h2>
        <p class="note" id="sv-resEmpty">Set up a spot and press Solve. The answer shows here: how often each hand should check, bet, call or fold, street by street.</p>
        <div id="sv-resBody" hidden>
          <div class="path" id="sv-path"></div>
          <div class="nodehead" id="sv-nodeHead"></div>
          <div class="acts" id="sv-acts"${anc("svacts")}></div>
          <div class="rgrid res" id="sv-sgrid"${anc("svgrid")}></div>
          <div class="legend" id="sv-legend"></div>
          <div class="detail" id="sv-detail"></div>
          <details class="eqgd" id="sv-eqgD" open><summary>Equity graph</summary><div id="sv-eqg"${anc("sveqg")}></div></details>
        </div>
      </div>
    </section>
  </div>`;
  // panels may be moved out of root (the page's panel layout), so look elements up once and keep them
  const ids = new Map(); root.querySelectorAll("[id^='sv-']").forEach(e => ids.set(e.id.slice(3), e));
  const $ = id => ids.get(id) || root.querySelector("#sv-" + id);
  const kIn = [...root.querySelectorAll("[data-k]")], szIn = [...root.querySelectorAll("[data-szi]")];
  const editEls = [...root.querySelectorAll(".sv-setup input,.sv-setup select,.sv-setup textarea,[data-tree],#sv-clearR")];
  const parts = [$("bar"), ...root.querySelectorAll(".panel")];
  const ac = new AbortController();
  const msg = t => { $("msg").innerHTML = t || ""; };

  /* ---------- shared state ---------- */
  function patch(o, quiet) {
    if (o.solveId !== undefined && o.solveId !== sv.solveId) { cache.clear(); node = null; nodeKey = ""; tablePath = null; tableKey = ""; }
    Object.assign(sv, o);
    if (shared && !quiet) T.send({ t: "sv", p: o });
    render();
  }
  const canEdit = () => !shared || T.canEdit();
  // Setup edits travel as small field-level changes ("ranges.1": "...") so two people editing
  // different things at the same time don't overwrite each other.
  function spotDiff(changes) {
    const d = {};
    for (const k of Object.keys(changes)) {
      const v = changes[k], o = sv.spot[k];
      if (Array.isArray(v) && Array.isArray(o) && v.length === o.length && k !== "board") v.forEach((x, i) => { if (x !== o[i]) d[k + "." + i] = x; });
      else if (JSON.stringify(v) !== JSON.stringify(o)) d[k] = v;
    }
    return d;
  }
  function editSpot(changes) {
    if (!canEdit()) return; localErr = "";
    const d = spotDiff(changes); if (!Object.keys(d).length) return;
    applySpotPatch(sv.spot, d); if (shared) T.send({ t: "sv", sp: d }); render();
  }
  let spotT = null, spotPending = {};
  function editSpotSoon(changes) { // typing: update this screen now, send after a short pause
    if (!canEdit()) return;
    const d = spotDiff(changes); Object.assign(spotPending, d); applySpotPatch(sv.spot, d);
    clearTimeout(spotT); spotT = setTimeout(() => { const c = spotPending; spotPending = {}; if (shared && Object.keys(c).length) T.send({ t: "sv", sp: c }); }, 350);
  }

  /* ---------- setup: board ---------- */
  function renderBoard() {
    const b = sv.spot.board;
    let s = ""; for (let k = 0; k < 5; k++) s += b[k] !== undefined ? cardHTML(b[k]) : `<span class="pc slot" aria-hidden="true"></span>`;
    setHTML($("boardShow"), s);
    let h = "";
    for (const su of [3, 2, 1, 0]) for (let r = 12; r >= 0; r--) {
      const id = 4 * r + su, on = b.includes(id);
      h += cardHTML(id, on ? "cur" : "", "button", `type="button" data-card="${id}" aria-pressed="${on}"${!canEdit() || (!on && b.length >= 5) ? " disabled" : ""}`);
    }
    setHTML($("deck"), h);
  }
  $("deck").onclick = e => {
    const btn = e.target.closest("[data-card]"); if (!btn || !canEdit()) return;
    const id = +btn.dataset.card, b = sv.spot.board.slice(), i = b.indexOf(id);
    if (i >= 0) b.splice(i, 1); else if (b.length < 5) b.push(id);
    editSpot({ board: b, note: "" });
  };

  /* ---------- setup: fields ---------- */
  kIn.forEach(el => { el.addEventListener("input", () => editSpotSoon({ [el.dataset.k]: +el.value })); });
  szIn.forEach(el => {
    el.addEventListener("input", () => { const s = sv.spot.sizes.slice(); s[+el.dataset.szi] = el.value; editSpotSoon({ sizes: s }); });
  });
  root.querySelectorAll("[data-tree]").forEach(b => { b.onclick = () => editSpot({ sizes: TREES[b.dataset.tree].slice() }); });
  function syncInputs() {
    const f = document.activeElement;
    kIn.forEach(el => { if (el !== f) el.value = sv.spot[el.dataset.k]; });
    szIn.forEach(el => { if (el !== f) el.value = sv.spot.sizes[+el.dataset.szi] || ""; });
    if ($("who") !== f) $("who").value = sv.spot.names[tab] || "";
    if ($("rtext") !== f) $("rtext").value = sv.spot.ranges[tab] || "";
    $("note").hidden = !sv.spot.note; $("note").textContent = sv.spot.note || "";
    editEls.forEach(el => { if (el.id !== "sv-paintW") el.disabled = !canEdit(); });
  }

  /* ---------- setup: range editor ---------- */
  let gridW = null, gridErr = "";
  function rangeModel() { const p = parseRange(sv.spot.ranges[tab]); if (!p.err) { gridW = p.w; gridErr = ""; } else { gridErr = p.err; if (!gridW) gridW = new Float32Array(169); } }
  function renderRangeGrid() {
    if (paint) return;
    rangeModel();
    let h = "";
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const v = gridW[r * 13 + c];
      h += `<button type="button" class="rc" data-cell="${r * 13 + c}" aria-label="${cellName(r, c)} ${Math.round(v * 100)}%"><div class="fill" style="height:${v * 100}%"></div><span>${cellName(r, c)}</span></button>`;
    }
    setHTML($("rgrid"), h);
    if (gridErr) { $("rinfo").textContent = gridErr; $("rinfo").className = "err"; }
    else { const n = comboCount(gridW); $("rinfo").className = "note"; $("rinfo").textContent = `${Math.round(n)} combos, ${pct(n / 1326)} of all hands.`; }
  }
  function selectTab(t) {
    tab = t; $("tab0").setAttribute("aria-selected", t === 0); $("tab1").setAttribute("aria-selected", t === 1);
    $("preset").value = ""; gridW = null; render();
  }
  $("tab0").onclick = () => selectTab(0);
  $("tab1").onclick = () => selectTab(1);
  $("who").oninput = () => { const n = sv.spot.names.slice(); n[tab] = $("who").value.slice(0, 24); editSpotSoon({ names: n }); };
  $("preset").onchange = () => {
    const k = $("preset").value; if (!k) return;
    const r = sv.spot.ranges.slice(); r[tab] = PRESETS[k]; editSpot({ ranges: r }); $("preset").value = "";
  };
  $("rtext").oninput = () => { const r = sv.spot.ranges.slice(); r[tab] = $("rtext").value; editSpotSoon({ ranges: r }); renderRangeGrid(); };
  $("paintW").oninput = () => { paintW = +$("paintW").value / 100; $("paintTxt").textContent = $("paintW").value + "%"; };
  $("clearR").onclick = () => { const r = sv.spot.ranges.slice(); r[tab] = ""; editSpot({ ranges: r }); };
  let paint = null;
  $("rgrid").addEventListener("pointerdown", e => {
    const b = e.target.closest("[data-cell]"); if (!b || !canEdit()) return;
    e.preventDefault(); rangeModel(); gridErr = "";
    const i = +b.dataset.cell;
    paint = { v: Math.abs(gridW[i] - paintW) < 1e-6 ? 0 : paintW, seen: new Set() };
    applyPaint(i);
  });
  function applyPaint(i) {
    if (!paint || paint.seen.has(i)) return; paint.seen.add(i); gridW[i] = paint.v;
    const el = $("rgrid").children[i]; if (el) el.firstElementChild.style.height = gridW[i] * 100 + "%";
  }
  const onMove = e => {
    if (!paint) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const b = el && el.closest && el.closest("[data-cell]");
    if (b && $("rgrid").contains(b)) applyPaint(+b.dataset.cell);
  };
  const onUp = () => { if (!paint) return; paint = null; const r = sv.spot.ranges.slice(); r[tab] = formatRange(gridW); editSpot({ ranges: r }); };
  const sig = { signal: ac.signal };
  window.addEventListener("pointermove", onMove, sig); window.addEventListener("pointerup", onUp, sig); window.addEventListener("pointercancel", onUp, sig);

  /* ---------- running a solve ---------- */
  function readSpot(s) {
    if (s.board.length < 3) throw "Pick at least three board cards (the flop).";
    const p = Math.round(+s.pot * 100), e = Math.round(+s.eff * 100);
    if (!(p > 0)) throw "The pot must be more than $0.";
    if (!(e > 0)) throw "The effective stack must be more than $0.";
    const rs = s.ranges.map(parseRange);
    rs.forEach((r, k) => { if (r.err) throw `${k ? "In position" : "Out of position"} range: ${r.err}`; if (!comboCount(r.w)) throw `Set the ${k ? "in-position" : "out-of-position"} range first: choose “Load a starting range” or paint the grid.`; });
    const cap = +s.rakeCap, z = s.sizes;
    return { oop: formatRange(rs[0].w), ip: formatRange(rs[1].w), board: s.board.slice(), pot: p, eff: e,
      rake: Math.max(0, Math.min(25, +s.rakePct || 0)) / 100, rakeCap: cap > 0 ? Math.round(cap * 100) : 1e12,
      fb: z[0] || "", fr: z[1] || "", tb: z[2] || "", tr: z[3] || "", rb: z[4] || "", rr: z[5] || "",
      allinT: Math.max(0, +s.allinT || 0), forceT: Math.max(0, +s.forceT || 0), names: s.names.slice(),
      acc: Math.max(0.05, +s.acc || 0.5), maxIt: Math.max(10, Math.min(5000, +s.maxIt || 1000)) };
  }
  async function connectApp(quiet) {
    appTried = true;
    const e = new AppEngine();
    try { await e.init(); }
    catch (x) { if (!quiet) { bigMsg = "noapp"; render(); } return false; }
    if (engine) engine.close();
    engine = e; engineSolveId = null; bigMsg = null; lsSet("hsp-app", "1");
    e.onclose = () => { if (engine === e) { engine = null; engineSolveId = null; if (sv.host === me() && ["solving", "ready", "setting"].includes(sv.status)) patch({ status: "lost" }); render(); } };
    render(); return true;
  }
  async function getEngine() {
    if (engine && !engine.closed) return engine;
    if (!appTried && lsGet("hsp-app") === "1" && await connectApp(true)) return engine;
    $("progTxt").textContent = "Loading the solver…";
    engine = await startBrowserEngine(); return engine;
  }
  let solving = false, lastProgSent = 0;
  async function solve() {
    if (solving || !canEdit()) return;
    let sp; try { sp = readSpot(sv.spot); } catch (e) { localErr = String(e); render(); return; }
    localErr = ""; bigMsg = null; solving = true;
    const id = rid();
    patch({ status: "setting", host: me(), hostName: shared ? T.name() : "", where: "", threads: 0, solveId: id, prog: null, info: null, err: "",
      cards: null, solved: sp, path: [{ hist: [], label: "Start" }], mem: 0 });
    explore = false; myPath = null; selCell = null;
    try {
      const eng = await getEngine();
      patch({ where: eng.kind, threads: eng.threads });
      const s = await eng.ask({ t: "setup", spot: sp }, d => d.t === "setup");
      if (s.err) throw s.err;
      const [full, small] = s.mem;
      let compress, need;
      if (eng.kind === "app") {
        const ram = eng.ram || 8e9;
        compress = full > ram * 0.6; need = compress ? small : full;
        if (need > ram * 0.85) throw `This tree needs about ${GB(need)} of memory and this computer has ${GB(ram)}. Use fewer bet sizes or narrower ranges.`;
      } else {
        compress = full > 1.5e9; need = compress ? small : full;
        if (need > BROWSER_LIMIT) { bigMsg = { need }; throw ""; }
      }
      engineSolveId = id;
      patch({ status: "solving", cards: [Array.from(s.cards[0]), Array.from(s.cards[1])], mem: need });
      const t0 = Date.now(), target = Math.max(1, sp.pot * sp.acc / 100);
      let e0 = null;
      const r = await eng.ask({ t: "solve", compress, target, maxIter: sp.maxIt }, d => d.t === "solved", d => {
        if (d.t !== "progress") return;
        if (d.e != null && e0 == null) e0 = Math.max(d.e, target * 1.01);
        const f = d.e == null ? 0 : Math.max(Math.min(Math.log(e0 / Math.max(d.e, 1e-9)) / Math.log(e0 / target), 1), d.i / sp.maxIt, 0);
        const prog = { i: d.i, e: d.e, f };
        sv.prog = prog; renderProgress();
        if (shared && Date.now() - lastProgSent > 800) { lastProgSent = Date.now(); T.send({ t: "sv", p: { prog } }); }
      });
      if (sv.solveId !== id) return; // someone started a different solve meanwhile
      patch({ status: "ready", prog: null, info: { i: r.i, e: r.e, secs: (Date.now() - t0) / 1000, stopped: !!r.stopped } });
    } catch (e) {
      const m = e && e.message ? e.message : String(e || "");
      if (sv.solveId === id) patch({ status: "idle", host: null, err: m, cards: null, solveId: null });
      if (engine && engine.kind === "browser" && /memory|unreachable|stopped/i.test(m)) { engine.close(); engine = null; }
    } finally { solving = false; render(); }
  }
  $("solve").onclick = () => solve();
  $("stop").onclick = () => { if (engine && sv.host === me()) { engine.stop(); $("stop").disabled = true; } };

  /* ---------- reading nodes (from this computer's engine, or from the computer that solved) ---------- */
  function query(hist) {
    const k = sv.solveId + "|" + hist.join(",");
    if (cache.has(k)) return cache.get(k);
    let p;
    if (sv.host === me() && engine && engineSolveId === sv.solveId) p = engine.node(hist);
    else if (shared && sv.host && sv.status === "ready") {
      p = new Promise((resolve, reject) => {
        const id = rid(); const to = setTimeout(() => { pending.delete(id); reject(new Error(`${sv.hostName || "The computer that solved this"} isn't answering. It may have left; press Solve to run it again.`)); }, 20000);
        pending.set(id, { resolve: d => { clearTimeout(to); resolve(d); }, reject: e => { clearTimeout(to); reject(e); } });
        T.send({ t: "svq", id, hist, sid: sv.solveId });
      });
    } else p = Promise.reject(new Error("Nothing is solved yet."));
    cache.set(k, p); p.catch(() => cache.delete(k));
    return p;
  }

  /* ---------- results ---------- */
  const COLORS = { Fold: "#5b8def", Check: "#4caf73", Call: "#4caf73" };
  const AGG = ["#e8a33d", "#e0703c", "#d1453b", "#b02f4a", "#8e2a63"];
  function actionList(acts, potNow) {
    let k = 0;
    return String(acts || "").split("/").filter(Boolean).map(s => {
      const [type, a] = s.split(":"), amt = +a;
      let label = type, color = COLORS[type];
      if (type === "Bet") label = `Bet ${usd(amt)} (${Math.round(amt / potNow * 100)}%)`;
      else if (type === "Raise") label = `Raise to ${usd(amt)}`;
      else if (type === "Allin") label = `All-in ${usd(amt)}`;
      if (!color) color = type === "Allin" ? "#7a1f3d" : AGG[Math.min(k++, AGG.length - 1)];
      return { type, amt, label, color };
    });
  }
  const potOf = n => sv.solved.pot + n.tb[0] + n.tb[1];
  const nameOf = k => (sv.solved && sv.solved.names[k]) || (k ? "In position" : "Out of position");
  const shortName = k => nameOf(k).split(" · ")[0];
  const actLabel = (k, a) => `${shortName(k)} ${a.label.replace(/ \(.*\)/, "").toLowerCase()}`;
  function parseRes(buf, p, na) {
    const [n0, n1] = [sv.cards[0].length, sv.cards[1].length];
    let o = 3; const take = n => buf.subarray(o, o += n);
    const flag = buf[2];
    const r = { flag, w: [take(n0), take(n1)], norm: [take(n0), take(n1)] };
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
  // the path everyone sees: explore (mine) > the table's line (when following) > the shared path
  function curPath() {
    if (explore && myPath) return myPath;
    const sp = sv.path || [{ hist: [], label: "Start" }];
    if (sv.sync && tablePath) {
      const pre = (a, b) => a.length <= b.length && a.every((s, i) => s.hist.join() === b[i].hist.join());
      if (pre(tablePath, sp)) return sp;
      return tablePath;
    }
    return sp;
  }
  function boardFor(path) { return sv.solved.board.concat(path.map(s => s.card).filter(c => c !== undefined)); }
  function go(path, keepSync) {
    if (explore) { myPath = path; render(); return; }
    patch({ path, sync: !!(sv.sync && keepSync) });
  }
  async function loadNode() {
    const path = curPath(), key = sv.solveId + "|" + path[path.length - 1].hist.join(",");
    if (key === nodeKey && node) return renderResults();
    const g = ++gen;
    try {
      const n = await query(path[path.length - 1].hist);
      if (g !== gen) return;
      const actions = n.p === "oop" || n.p === "ip" ? actionList(n.acts, potOf(n)) : [];
      node = { ...n, potNow: potOf(n), actions, r: parseRes(n.res, n.p, actions.length) };
      nodeKey = key;
      if (node.p !== "oop" && node.p !== "ip" && view === "strat") view = "eq0";
      if ((node.p === "oop" || node.p === "ip") && view !== "strat" && !viewPinned) view = "strat";
      if (node.r.flag && view !== "strat") view = node.actions.length ? "strat" : view;
      renderResults();
    } catch (e) { if (g === gen) { $("resBody").hidden = true; $("resEmpty").hidden = false; $("resEmpty").textContent = e.message || String(e); } }
  }
  function renderResults() {
    if (!node) return;
    $("resEmpty").hidden = true; $("resBody").hidden = false;
    const path = curPath(), bd = boardFor(path), street = { 3: "Flop", 4: "Turn", 5: "River" }[bd.length];
    setHTML($("path"), path.map((s, i) => i === path.length - 1 ? `<span class="chip">${esc(s.label)}</span>` : `<button class="b sm" type="button" data-back="${i}">${esc(s.label)}</button><span class="muted">›</span>`).join(""));
    const who = node.p === "oop" ? nameOf(0) : node.p === "ip" ? nameOf(1) : "";
    const what = node.p === "chance" ? "Next card" : node.p === "terminal" ? "The hand is over on this line" : `${esc(who)} to act`;
    setHTML($("nodeHead"), `<span class="boardrow">${bd.map(c => cardHTML(c)).join("")}</span><b>${street} · ${what}</b><span class="muted">Pot ${usd(node.potNow)}</span>`);
    const r = node.r;
    const avg = (vals, k) => { let s = 0, t = 0; const nw = r.norm[k]; for (let i = 0; i < nw.length; i++) { s += nw[i] * vals[i]; t += nw[i]; } return t ? s / t : 0; };
    let sum = "";
    if (!r.flag) sum = [0, 1].map(k => `<span>${esc(nameOf(k))}: equity <b>${pct(avg(r.eq[k], k))}</b>, EV <b>${usd(avg(r.ev[k], k))}</b></span>`).join("");
    let acts = "";
    if (node.actions.length) {
      const k = node.p === "oop" ? 0 : 1, nc = sv.cards[k].length, nw = r.norm[k];
      let tot = 0; for (let i = 0; i < nc; i++) tot += nw[i];
      node.actions.forEach((a, ai) => { let f = 0; for (let i = 0; i < nc; i++) f += nw[i] * r.strat[ai * nc + i]; a.freq = tot ? f / tot : 0; });
      acts = node.actions.map((a, ai) => `<button class="b" type="button" data-act="${ai}" style="border-left-color:${a.color}"><span>${esc(a.label)}</span><small>${pct(a.freq)} of hands</small></button>`).join("");
    } else if (node.p === "chance") {
      const push = canPushCard(bd.length);
      let h = `<p class="note" style="width:100%;margin:0">Pick the ${bd.length === 3 ? "turn" : "river"} card to keep going.${push ? " Your pick is also set as the table's next card." : ""}</p><div class="deck sdeck">`;
      for (const s of [3, 2, 1, 0]) for (let rr = 12; rr >= 0; rr--) {
        const id = 4 * rr + s, ok = hasCard(node.possible, id);
        h += cardHTML(id, "", "button", `type="button" data-deal="${id}"${ok ? "" : " disabled"}`);
      }
      acts = h + "</div>";
    } else if (node.p === "terminal") acts = `<p class="note">Someone folded, or the hand went to showdown. Go back with the buttons above.</p>`;
    setHTML($("acts"), `<div class="summary" style="width:100%">${sum}</div>` + acts);
    const tabs = [];
    if (node.actions.length) tabs.push(["strat", "Strategy"]);
    if (!r.flag) tabs.push(["eq0", shortName(0) + " equity"], ["eq1", shortName(1) + " equity"]);
    setHTML($("legend"), `<div class="tabs" style="width:100%;margin:0">${tabs.map(([v, l]) => `<button class="tab" type="button" data-view="${v}" aria-selected="${view === v}">${esc(l)}</button>`).join("")}</div>` +
      (view === "strat" ? node.actions.map(a => `<span><i style="background:${a.color}"></i>${esc(a.label)}</span>`).join("") : `<span><i style="background:#d1453b"></i>low equity</span><span><i style="background:#e8a33d"></i>middle</span><span><i style="background:#4caf73"></i>high equity</span><span>Fill height = how much of that hand is still in the range</span>`));
    renderGrid(); renderDetail(); renderEqGraph();
  }
  function eqColor(x) {
    const a = [209, 69, 59], b = [232, 163, 61], c = [76, 175, 115];
    const [p, q, t] = x < 0.5 ? [a, b, x * 2] : [b, c, (x - 0.5) * 2];
    return `rgb(${p.map((v, i) => Math.round(v + (q[i] - v) * t)).join(",")})`;
  }
  const gridPlayer = () => view === "strat" ? (node.p === "oop" ? 0 : 1) : view === "eq1" ? 1 : 0;
  function cellStats(k) {
    const cells = Array.from({ length: 169 }, () => ({ hs: [], w: 0, nw: 0 }));
    const cs = sv.cards[k], r = node.r;
    for (let i = 0; i < cs.length; i++) { const c = cells[cellOf(cs[i])]; c.hs.push(i); c.w += r.w[k][i]; c.nw += r.norm[k][i]; }
    return cells;
  }
  // each player's hands at this spot, best to worst: how much of the range has at least this much equity
  function renderEqGraph() {
    const box = $("eqg"), r = node && node.r;
    if (!r || !r.eq || !r.norm) { $("eqgD").hidden = true; return; }
    $("eqgD").hidden = false;
    const W = 560, H = 220, L = 40, B = 26, T = 10, Rr = 10, iw = W - L - Rr, ih = H - T - B;
    const cols = ["#4f8fd6", "#d9a441"], lines = [], avgs = [];
    for (let k = 0; k < 2; k++) {
      const pts = [], cs = sv.cards[k];
      for (let i = 0; i < cs.length; i++) { const w = r.norm[k][i]; if (w > 1e-6) pts.push([r.eq[k][i], w]); }
      const tot = pts.reduce((a, p) => a + p[1], 0);
      if (!tot) { lines.push(""); avgs.push(null); continue; }
      pts.sort((a, b) => b[0] - a[0]);
      let x = 0, d = `M${L},${T + ih * (1 - pts[0][0])}`, avg = 0;
      for (const [e, w] of pts) { avg += e * w; const x0 = x; x += w / tot; d += `L${L + iw * x0},${T + ih * (1 - e)}L${L + iw * x},${T + ih * (1 - e)}`; }
      lines.push(d); avgs.push(avg / tot);
    }
    const grid = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${L}" x2="${L + iw}" y1="${T + ih * (1 - v)}" y2="${T + ih * (1 - v)}" class="eqgl"/><text x="${L - 6}" y="${T + ih * (1 - v) + 4}" text-anchor="end">${v * 100}%</text>`).join("")
      + [0, 0.25, 0.5, 0.75, 1].map(v => `<text x="${L + iw * v}" y="${H - 8}" text-anchor="middle">${v * 100}%</text>`).join("");
    setHTML(box, `<div class="eqgk">${[0, 1].map(k => avgs[k] == null ? "" : `<span><i style="background:${cols[k]}"></i>${esc(sv.spot.names[k])} (${k ? "IP" : "OOP"}) · average ${pct(avgs[k])}</span>`).join("")}</div>
      <svg viewBox="0 0 ${W} ${H}" class="eqg" role="img" aria-label="Equity graph: each player's hands from strongest to weakest at this spot">${grid}${lines.map((d, k) => d ? `<path d="${d}" fill="none" stroke="${cols[k]}" stroke-width="2.5"/>` : "").join("")}</svg>
      <p class="note">Each line runs through one player's range at this spot, strongest hand on the left. Read across: at 25% along, a quarter of that range has at least this much equity. A line that stays high has a strong range; a steep drop means a few strong hands and many weak ones.</p>`);
  }
  function renderGrid() {
    const k = gridPlayer(), cells = cellStats(k), r = node.r, nc = sv.cards[k].length, bd = new Set(boardFor(curPath()));
    let h = "";
    for (let ro = 0; ro < 13; ro++) for (let co = 0; co < 13; co++) {
      const i = ro * 13 + co, c = cells[i];
      const r1 = 12 - ro, r2 = 12 - co; let live = 0;
      for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
        const a = 4 * (ro <= co ? r1 : r2) + s1, b = 4 * (ro <= co ? r2 : r1) + s2;
        if (ro === co ? s2 <= s1 : ro < co ? s1 !== s2 : s1 === s2) continue;
        if (!bd.has(a) && !bd.has(b)) live++;
      }
      const hgt = live ? Math.min(1, c.w / live) : 0;
      let bars = "";
      if (c.nw > 0 && hgt > 0.001) {
        if (view === "strat" && node.actions.length) bars = node.actions.map((a, ai) => { let f = 0; for (const hI of c.hs) f += r.norm[k][hI] * r.strat[ai * nc + hI]; return `<i style="width:${f / c.nw * 100}%;background:${a.color}"></i>`; }).join("");
        else if (!r.eq) bars = `<i style="width:100%;background:var(--brass)"></i>`;
        else { let e = 0; for (const hI of c.hs) e += r.norm[k][hI] * r.eq[k][hI]; bars = `<i style="width:100%;background:${eqColor(e / c.nw)}"></i>`; }
      }
      h += `<button type="button" class="rc${hgt <= 0.001 ? " empty" : ""}${selCell === i ? " sel" : ""}" data-cell="${i}"><div class="bars" style="height:${hgt * 100}%">${bars}</div><span>${cellName(ro, co)}</span></button>`;
    }
    setHTML($("sgrid"), h);
  }
  function renderDetail() {
    if (selCell == null) { setHTML($("detail"), `<p class="note">Tap a hand to see each combo.</p>`); return; }
    const k = gridPlayer(), c = cellStats(k)[selCell], r = node.r, nc = sv.cards[k].length, cs = sv.cards[k];
    const name = cellName(Math.floor(selCell / 13), selCell % 13);
    const rows = c.hs.filter(i => r.w[k][i] > 0.0005);
    if (!rows.length) { setHTML($("detail"), `<p class="note">${name}: not in ${esc(nameOf(k))}'s range here.</p>`); return; }
    if (!r.flag) rows.sort((a, b) => r.ev[k][b] - r.ev[k][a]);
    const strat = view === "strat" && node.actions.length;
    const head = `<tr><th>${name}</th><th>In range</th>${r.flag ? "" : "<th>Equity</th><th>EV</th>"}${strat ? node.actions.map(a => `<th style="color:${a.color}">${esc(a.label.replace(/ \(.*\)/, ""))}</th>`).join("") : ""}</tr>`;
    const body = rows.map(i => `<tr><td class="cards">${cardsTxt(cs[i] & 255, cs[i] >> 8)}</td><td>${pct(r.w[k][i])}</td>${r.flag ? "" : `<td>${pct(r.eq[k][i])}</td><td>${usd(r.ev[k][i])}</td>`}${strat ? node.actions.map((a, ai) => `<td>${pct(r.strat[ai * nc + i])}</td>`).join("") : ""}</tr>`).join("");
    setHTML($("detail"), `<table>${head}${body}</table>`);
  }
  // a teacher's turn/river pick also sets the table's next card, if the table hasn't dealt it yet
  function canPushCard(k) {
    if (!TB || !TB.canPush() || explore || !sv.link) return false;
    const P = TB.current(); return !!(P && P.hand === sv.link.hand && P.board.length === k && ["flop", "turn"].includes(P.phase));
  }
  $("resBody").addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t || !node) return;
    const path = curPath();
    if (t.dataset.back !== undefined) { go(path.slice(0, +t.dataset.back + 1), true); return; }
    if (t.dataset.act !== undefined) {
      const k = node.p === "oop" ? 0 : 1, a = node.actions[+t.dataset.act];
      go(path.concat({ hist: path[path.length - 1].hist.concat(+t.dataset.act), label: actLabel(k, a) }), true);
      return;
    }
    if (t.dataset.deal !== undefined) {
      const id = +t.dataset.deal, k = boardFor(path).length;
      const pushed = canPushCard(k) && TB.push(k, cardStr(id)) !== false;
      go(path.concat({ hist: path[path.length - 1].hist.concat(id), label: cardLabel(id), card: id }), pushed);
      return;
    }
    if (t.dataset.view) { view = t.dataset.view; viewPinned = view !== "strat"; renderResults(); return; }
    if (t.dataset.cell !== undefined) { selCell = selCell === +t.dataset.cell ? null : +t.dataset.cell; renderGrid(); renderDetail(); }
  });

  /* ---------- top bar: who solved, sharing, following the table ---------- */
  const onCmd = e => {
    const t = e.target.closest("[data-svcmd]"); if (!t) return;
    const c = t.dataset.svcmd;
    if (c === "explore") { explore = true; myPath = curPath().slice(); render(); }
    else if (c === "rejoin") { explore = false; myPath = null; render(); }
    else if (c === "follow") { if (canEdit()) { patch({ sync: !sv.sync }); autoKey = ""; if (lastP) tableUpdate(lastP); } }
    else if (c === "app") connectApp(false);
    else if (c === "browser") { if (engine && engine.kind === "app") { engine.close(); engine = null; lsSet("hsp-app", "0"); } render(); }
  };
  parts.forEach(p => p.addEventListener("click", onCmd));
  function renderBar() {
    const bits = [];
    if (shared) {
      bits.push(`<span class="chip">Shared with the lobby</span>`);
      if (sv.status === "ready" || sv.status === "solving") bits.push(explore
        ? `<span class="note">You're exploring on your own.</span><button class="b sm" type="button" data-svcmd="rejoin">Rejoin the group</button>`
        : `<button class="b sm" type="button" data-svcmd="explore">Explore on my own</button>`);
    }
    if (TB) {
      const P = TB.current(), live = !sv.link || (P && P.hand === sv.link.hand);
      bits.push(`<label class="toggle sm"><input type="checkbox" data-svcmd="follow"${sv.sync ? " checked" : ""}${canEdit() ? "" : " disabled"}><span>Follow the table${live ? "" : ` <span class="muted">(this solve is from hand #${sv.link.hand})</span>`}</span></label>`);
    }
    setHTML($("bar"), bits.join(""));
    $("bar").hidden = !bits.length;
  }
  function renderEngine() {
    let h;
    const mine = engine && !engine.closed ? engine : null;
    if (mine && mine.kind === "app") h = `Solves run in the <b>Hot Seat Solver app</b> on this computer (${mine.threads} threads, ${GB(mine.ram)} of memory). <button class="linkbtn" type="button" data-svcmd="browser">Use this browser instead</button>`;
    else h = `Solves run in this browser${mine ? ` (${mine.threads} thread${mine.threads > 1 ? "s" : ""})` : ""}. Trees too big for a browser need the free <a href="${APP_PAGE}" target="_blank" rel="noopener">solver app</a>. <button class="linkbtn" type="button" data-svcmd="app">Connect the solver app</button>`;
    if (sv.status === "ready" || sv.status === "solving") {
      const where = sv.where === "app" ? "the solver app on" : "the browser of";
      if (shared && sv.host && sv.host !== me()) h = `This solve ran on ${where} ${esc(sv.hostName || "another computer")}'s computer; you're seeing its results. ` + h;
    }
    setHTML($("eng"), h);
  }
  function renderBig() {
    if (bigMsg === "noapp") return msg(`Couldn't reach the solver app. Make sure it's open on this computer (download it from the <a href="${APP_PAGE}" target="_blank" rel="noopener">solver app page</a>), then try again. Your browser may ask to allow access to devices on your network: choose Allow.`);
    if (bigMsg && bigMsg.need) return msg(`This tree needs about ${GB(bigMsg.need)} of memory, more than a browser can use (about 4 GB). Big trees run in the free <a href="${APP_PAGE}" target="_blank" rel="noopener">Hot Seat Solver app</a> on your computer. Smaller trees, like the Quick sizes, work right here without it. <button class="b sm" type="button" data-svcmd="app">Connect the solver app</button>`);
    msg(localErr ? esc(localErr) : sv.err ? esc(sv.err) : "");
  }
  function renderProgress() {
    const s = sv.status, mineRunning = sv.host === me() && solving;
    $("solve").disabled = !canEdit() || mineRunning || (s === "solving" || s === "setting") && sv.host && sv.host !== me();
    $("solve").textContent = s === "ready" ? "Solve again" : "Solve";
    $("stop").hidden = !mineRunning || s !== "solving"; if ($("stop").hidden) $("stop").disabled = false;
    const prog = $("prog");
    if (s === "setting" || s === "solving") {
      prog.hidden = false;
      const who = sv.host === me() ? "" : ` on ${esc(sv.hostName || "another computer")}'s computer`;
      const p = sv.prog;
      $("progBar").style.width = Math.min(100, ((p && p.f) || 0) * 100) + "%";
      $("progTxt").innerHTML = s === "setting" ? `Building the game tree${who}…`
        : p && p.e != null ? `Solving${who} · iteration ${p.i} · within ${pct(p.e / sv.solved.pot)} of perfect play (aiming for ${sv.solved.acc}%)`
        : `Solving${who}${sv.mem ? ` with ${GB(sv.mem)} of memory` : ""}…`;
    } else if (s === "ready" && sv.info) {
      prog.hidden = false; $("progBar").style.width = "100%";
      $("progTxt").textContent = `${sv.info.stopped ? "Stopped" : "Done"} after ${sv.info.i} iterations in ${sv.info.secs.toFixed(1)} s · within ${pct(sv.info.e / sv.solved.pot)} of perfect play.`;
    } else if (s === "lost") {
      prog.hidden = false; $("progBar").style.width = "0";
      $("progTxt").textContent = `${sv.hostName || "The computer that solved this"} left, so its results are gone. Press Solve to run it again.`;
    } else prog.hidden = true;
  }

  /* ---------- following the table ---------- */
  async function deriveTablePath(P) {
    const L = sv.link, order = ["flop", "turn", "river"], s0 = order.indexOf(L.st);
    const path = [{ hist: [], label: "Start" }]; let hist = [];
    const line = P.line || [];
    for (let si = s0; si < 3; si++) {
      const st = order[si];
      if (si > s0) {
        const c = P.board[si + 2]; if (!c) break;
        const id = cardId(c), n = await query(hist);
        if (n.p !== "chance" || !hasCard(n.possible, id)) break;
        hist = hist.concat(id); path.push({ hist, label: cardLabel(id), card: id, tbl: true });
      }
      for (const ev of line.filter(x => x.st === st)) {
        const n = await query(hist);
        if (!L.seats.includes(ev.i)) { if (ev.a === "check" || ev.a === "fold") continue; return path; } // a third player put chips in
        if (n.p !== "oop" && n.p !== "ip") return path;
        const k = n.p === "oop" ? 0 : 1;
        if (L.seats[k] !== ev.i) return path;
        const acts = actionList(n.acts, potOf(n));
        let idx = -1;
        if (ev.a === "fold") idx = acts.findIndex(a => a.type === "Fold");
        else if (ev.a === "check") idx = acts.findIndex(a => a.type === "Check");
        else if (ev.a === "call") idx = acts.findIndex(a => a.type === "Call");
        else {
          const want = ev.to * 100; let best = Infinity;
          acts.forEach((a, ai) => {
            if (!["Bet", "Raise", "Allin"].includes(a.type)) return;
            const d = ev.all && a.type === "Allin" ? -1 : Math.abs(Math.log(a.amt / Math.max(1, want)));
            if (d < best) { best = d; idx = ai; }
          });
        }
        if (idx < 0) return path;
        hist = hist.concat(idx); path.push({ hist, label: actLabel(k, acts[idx]), tbl: true });
      }
    }
    return path;
  }
  let lastP = null, autoKey = "", gotFull = !shared; // in a lobby, wait for the lobby's saved solver before copying the table in
  // While following the table, a teacher's screen copies each new street (board, pot, stacks,
  // positions) into the setup, unless a solve is running or ready. Ranges stay as they are.
  function autoLoad(P) {
    if (!TB || !TB.canPush() || !sv.sync || !P || !gotFull) return;
    const spots = P.spots || [], sp = spots[spots.length - 1];
    if (!sp) return;
    const key = P.hand + "|" + spots.length;
    if (key === autoKey) return;
    autoKey = key;
    if (["ready", "solving", "setting"].includes(sv.status)) return;
    if (sv.link && sv.link.hand === P.hand && sv.link.st === sp.st) return;
    useTableSpot(sp, P, sv.link && sv.link.hand === P.hand ? sv.link.seats : null);
  }
  // copy a table spot into the setup, keeping the ranges, sizes and solve settings
  function useTableSpot(sp, P, seats) {
    const x = spotFromTable(sp, P, seats);
    patch({ spot: { ...x.spot, ranges: sv.spot.ranges.slice(), sizes: sv.spot.sizes.slice(), acc: sv.spot.acc, maxIt: sv.spot.maxIt },
      link: x.link, status: "idle", host: null, solveId: null, cards: null, solved: null, info: null, err: "", path: [{ hist: [], label: "Start" }] });
  }
  // multiway: which two players the solver studies
  function renderPair() {
    const L = sv.link, f = $("pairF");
    if (!L || !Array.isArray(L.all) || L.all.length < 3) { f.hidden = true; return; }
    f.hidden = false;
    const nm = p => esc([p.pos, p.name].filter(Boolean).join(" · "));
    let o = "";
    for (let a = 0; a < L.all.length; a++) for (let b = a + 1; b < L.all.length; b++) {
      const v = L.all[a].i + "," + L.all[b].i, on = L.seats && L.seats.includes(L.all[a].i) && L.seats.includes(L.all[b].i);
      o += `<option value="${v}"${on ? " selected" : ""}>${nm(L.all[a])} vs ${nm(L.all[b])}</option>`;
    }
    if ($("pair") !== document.activeElement) setHTML($("pair"), o);
    const P = TB && TB.current();
    $("pair").disabled = !canEdit() || !P || P.hand !== L.hand || ["solving", "setting"].includes(sv.status);
  }
  $("pair").onchange = () => {
    const P = TB && TB.current(), L = sv.link; if (!P || !L || !canEdit()) return;
    const sp = (P.spots || []).find(x => x.st === L.st); if (!sp) return;
    useTableSpot(sp, P, $("pair").value.split(",").map(Number));
  };
  function tableUpdate(P) {
    lastP = P;
    autoLoad(P);
    if (!sv.link || !sv.sync || sv.status !== "ready" || !P || P.hand !== sv.link.hand) { if (tablePath) { tablePath = null; tableKey = ""; render(); } return; }
    const key = sv.solveId + "|" + JSON.stringify([P.board, P.line]);
    if (key === tableKey) return;
    tableKey = key;
    deriveTablePath(P).then(p => { if (tableKey === key) { tablePath = p; render(); } }, () => {});
  }

  /* ---------- lobby messages ---------- */
  function onMessage(m) {
    if (m.t === "sv") {
      if ("full" in m) { const f = m.full || {}; if (f.solveId !== sv.solveId) { cache.clear(); node = null; nodeKey = ""; } sv = { ...defaultShared(), ...f, spot: normalizeSpot(f.spot) }; tablePath = null; tableKey = ""; gotFull = true; autoKey = ""; if (lastP) tableUpdate(lastP); render(); }
      else if (m.p) { if (m.p.spot) m.p.spot = normalizeSpot(m.p.spot); patch(m.p, true); if (lastP) tableUpdate(lastP); }
      else if (m.sp) { applySpotPatch(sv.spot, m.sp); render(); }
      return;
    }
    if (m.t === "svq") { // someone wants a node from the solve this computer ran
      const reply = o => T.send({ t: "sva", to: m.from, id: m.id, ...o });
      if (sv.host !== me() || !engine || engineSolveId !== m.sid) return reply({ err: "That solve isn't on this computer anymore." });
      engine.node(Array.isArray(m.hist) ? m.hist : []).then(n => reply({ d: encodeNode(n) }), e => reply({ err: e.message || "Error" }));
      return;
    }
    if (m.t === "sva") {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.d) p.resolve(decodeNode(m.d)); else p.reject(new Error(m.err || "Couldn't get that from the other computer."));
    }
  }
  // the person who ran the solve is gone: the server tells everyone with a patch; nothing to do here

  /* ---------- render ---------- */
  const lastHTML = new WeakMap();
  function setHTML(el, h) { if (lastHTML.get(el) === h) return; lastHTML.set(el, h); el.innerHTML = h; }
  let raf = 0;
  function render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; renderNow(); }); }
  function renderNow() {
    renderBar(); syncInputs(); renderPair(); renderBoard(); renderRangeGrid(); renderProgress(); renderEngine(); renderBig();
    if (sv.status === "ready" && sv.cards && sv.solved) loadNode();
    else { $("resBody").hidden = true; $("resEmpty").hidden = false; node = null; nodeKey = "";
      $("resEmpty").textContent = sv.status === "solving" || sv.status === "setting" ? "Solving… the results show here when it's done." : "Set up a spot and press Solve. The answer shows here: how often each hand should check, bet, call or fold, street by street."; }
  }

  if (lsGet("hsp-app") === "1") connectApp(true);
  render();
  return {
    onMessage, tableUpdate,
    get state() { return sv; },
    setFull(full) { onMessage({ t: "sv", full }); },
    loadTableSpot(sp, P) { if (!canEdit()) return; const x = spotFromTable(sp, P); patch({ ...defaultShared(), spot: { ...x.spot, ranges: sv.spot.ranges.slice(), sizes: sv.spot.sizes.slice() }, link: x.link, sync: true }); autoKey = P.hand + "|" + (P.spots || []).length; explore = false; myPath = null; selCell = null; },
    loadSpot(spot) { patch({ spot: { ...defaultSpot(), ...spot } }); },
    refresh: render,
    canEdit,
    ranges: () => sv.spot.ranges.slice(),
    // the two ranges at the spot of the solve on screen, weighted by how often each hand gets there
    nodeRanges() {
      if (sv.status !== "ready" || !sv.cards || !sv.solved || !node || !node.r || !node.r.w) return null;
      const path = curPath(), combos = [0, 1].map(k => {
        const out = [], cs = sv.cards[k], w = node.r.w[k];
        for (let i = 0; i < cs.length; i++) if (w[i] > 0.0005) out.push([cs[i] & 255, cs[i] >> 8, w[i]]);
        return out;
      });
      return { board: boardFor(path), combos, at: path.slice(1).map(s => s.label).join(", ") || "the start of the solve", names: sv.spot.names.slice() };
    },
    names: () => sv.spot.names.slice(),
    setRange(k, text) { if (!canEdit()) return false; const r = sv.spot.ranges.slice(); r[k] = text; editSpot({ ranges: r }); return true; },
    destroy() { ac.abort(); if (engine && !engine.closed && engine.kind === "app") { try { engine.close(); } catch (e) {} } },
  };
}
