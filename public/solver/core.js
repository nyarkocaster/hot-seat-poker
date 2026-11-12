// Hot Seat Poker solver, as a component. Used by the standalone /solver/ page and inside the table page.
// - Setup (board, ranges, sizes) and the place in the game tree can be shared with a lobby: every
//   change is sent as a patch, and one computer (whoever pressed Solve) runs the solve and answers
//   everyone else's "show me this node" requests through the lobby server.
// - Solves run in this browser (small trees) or in the Hot Seat Solver app on this computer (any size).
// - Linked to a table hand, it follows the table's cards and bets, and a teacher picking the next card
//   in the solver sets that card on the table.
// Card ids follow the engine: id = 4 * rank + suit (rank 0 = deuce .. 12 = ace; suits c, d, h, s).
import { cellName, cellCombos, parseRange, formatRange, comboCount, PRESETS, presetOptions } from "./range.js";
import { classify, MADE, DRAWS } from "./classify.js";

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
// flops for reports: the first 12 cover the main kinds of flop; all 25 fill in more
const REPORT_FLOPS = ["As7d2c", "Kh8s3d", "Qh9d4c", "Jd7s2h", "9s6d3c", "7h5c2d", "KsKd6c", "8h8c3s", "KdQs9c", "8d7d5s", "Qd6d2d", "Ad5d3c",
  "AhKd4s", "Ad9s8s", "Kc7c4c", "QsJh8d", "JcTc6h", "Th9h7d", "6s5s4d", "5h3c2d", "Ac9h9d", "7s6s2s", "Th4h4s", "JsTd9c", "Kh9s5h"];
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
        if (d.t === "loaded" && !this.ready) { this.ready = true; clearTimeout(to); this.threads = d.threads; this.ram = d.ram; this.version = d.version || "1.0.0"; resolve(); return; }
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
  return { board: [], pot: 5.5, eff: 97.5, rakePct: 0, rakeCap: 0,
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
    prog: null, info: null, cards: null, solved: null, path: [{ hist: [], label: "Start" }], solveId: null, err: "", mem: 0, locks: [], base: null, report: null };
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
  let tab = 0, paintW = 1, deckOpen = false, drill = null, brkFilter = null, brkCache = { key: "", cls: null }, explore = false, myPath = null, selCell = null, view = "strat";
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
          <div class="boardline"><div class="boardrow" id="sv-boardShow"></div><button class="b sm" type="button" id="sv-deckT" aria-expanded="false" aria-controls="sv-deck" hidden>Change board</button></div><p class="note" id="sv-boardHint" hidden>No board yet. Pick a flop below, or load a spot from the table once its flop is dealt.</p>
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
        <div class="rlay">
        <div class="rlay-c">
        <div class="fields">
          <div class="field"><label for="sv-who">Player</label><input type="text" id="sv-who" maxlength="24"></div>
          <div class="field"><label for="sv-preset">Load a starting range</label><select id="sv-preset"><option value="">Choose…</option>${presetOptions()}</select></div>
        </div>
        <div class="row paint"><label for="sv-paintW">Tap paints</label><input type="range" id="sv-paintW" min="0" max="100" step="5" value="100"><span id="sv-paintTxt">100%</span>
          <button class="b sm" type="button" id="sv-clearR">Clear</button></div>
        <div class="field"><label for="sv-rtext">Range text</label><textarea id="sv-rtext" rows="3" spellcheck="false"></textarea></div>
        <p class="note" id="sv-rinfo"></p>
        </div>
        <div class="rgrid" id="sv-rgrid"${anc("svrgrid")} aria-label="Range grid"></div>
        </div>
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
        <div class="locklist" id="sv-lockList"></div>
      </div>
      <div class="panel" id="sv-pRep"${anc("svrep")}>
        <h2>Flop report</h2>
        <p class="note">Solves this spot on a set of flops, one after another, and shows how each player plays each kind of flop. It uses the ranges, pot, stack and bet sizes set up above; only the board changes.</p>
        <div class="fields">
          <div class="field"><label for="sv-repSet">Flops</label><select id="sv-repSet"><option value="12">12 flops</option><option value="25">25 flops</option></select></div>
          <div class="field"><label for="sv-repAcc">Accuracy</label><select id="sv-repAcc"><option value="2">Rough (2% of pot)</option><option value="1" selected>Normal (1%)</option></select></div>
        </div>
        <div class="row"><button class="b" type="button" id="sv-repGo">Run the report</button><button class="b" type="button" id="sv-repStop" hidden>Stop</button></div>
        <div id="sv-repOut"></div>
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
          <div class="drill" id="sv-drill"${anc("svdrill")}></div>
          <div class="lockbar" id="sv-lockBar"></div>
          <div class="locked" id="sv-lockEd"${anc("svlock")} hidden></div>
          <div class="lockcmp" id="sv-lockCmp"></div>
          <div class="rlay reslay">
          <div class="rlay-g"><div class="rgrid res" id="sv-sgrid"${anc("svgrid")}></div>
          <div class="legend" id="sv-legend"></div></div>
          <div class="rlay-c"><details class="brkd" id="sv-brkD" open><summary>Range breakdown</summary><div id="sv-brk"${anc("svbrk")}></div></details>
          <div class="detail" id="sv-detail"></div>
          <details class="eqgd" id="sv-eqgD" open><summary>Equity graph</summary><div id="sv-eqg"${anc("sveqg")}></div></details></div>
          </div>
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
  // the teacher's preflop charts changed: refresh the list
  addEventListener("hsp-charts", () => { const s = $("preset"); s.innerHTML = `<option value="">Choose…</option>${presetOptions()}`; }, { signal: ac.signal });

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
    // once the board is set, the deck folds away to save room; "Change board" opens it again
    const full = b.length >= 3, open = !full || deckOpen;
    $("deck").hidden = !open || !canEdit();
    $("deckT").hidden = !full || !canEdit();
    $("boardHint").hidden = full;
    $("deckT").textContent = deckOpen ? "Done" : "Change board";
    $("deckT").setAttribute("aria-expanded", String(open));
  }
  $("deckT").onclick = () => { deckOpen = !deckOpen; renderBoard(); };
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
      const cards = [Array.from(s.cards[0]), Array.from(s.cards[1])];
      const locks = (sv.locks || []).map(l => ({ hist: l.hist, acts: l.acts, s: lockStrategy(l, cards[l.p]) }));
      if (locks.length && eng.kind === "app" && verLess(eng.version, "1.1.0")) throw `Node locks need the newest solver app (version 1.1). Download it again from the solver app page, or switch to solving in this browser.`;
      let lockRes = [];
      patch({ status: "solving", cards, mem: need });
      const t0 = Date.now(), target = Math.max(1, sp.pot * sp.acc / 100);
      let e0 = null;
      const r = await eng.ask({ t: "solve", compress, target, maxIter: sp.maxIt, locks }, d => d.t === "solved", d => {
        if (d.t === "locks") { lockRes = d.res || []; return; }
        if (d.t !== "progress") return;
        if (d.e != null && e0 == null) e0 = Math.max(d.e, target * 1.01);
        const f = d.e == null ? 0 : Math.max(Math.min(Math.log(e0 / Math.max(d.e, 1e-9)) / Math.log(e0 / target), 1), d.i / sp.maxIt, 0);
        const prog = { i: d.i, e: d.e, f };
        sv.prog = prog; renderProgress();
        if (shared && Date.now() - lastProgSent > 800) { lastProgSent = Date.now(); T.send({ t: "sv", p: { prog } }); }
      });
      if (sv.solveId !== id) return; // someone started a different solve meanwhile
      const applied = [], failed = [];
      (sv.locks || []).forEach((l, i) => { const why = lockRes[i]; if (why === "") applied.push({ hist: l.hist, p: l.p, sum: l.sum, where: l.where }); else failed.push({ hist: l.hist, sum: l.sum, where: l.where, why: why || "the solver didn't confirm it" }); });
      patch({ status: "ready", prog: null, solved: { ...sv.solved, locked: applied }, info: { i: r.i, e: r.e, secs: (Date.now() - t0) / 1000, stopped: !!r.stopped, lockFail: failed } });
    } catch (e) {
      const m = e && e.message ? e.message : String(e || "");
      if (sv.solveId === id) patch({ status: "idle", host: null, err: m, cards: null, solveId: null });
      if (engine && engine.kind === "browser" && /memory|unreachable|stopped/i.test(m)) { engine.close(); engine = null; }
    } finally { solving = false; render(); }
  }
  $("solve").onclick = () => solve();
  $("stop").onclick = () => { if (engine && sv.host === me()) { engine.stop(); $("stop").disabled = true; } };

  /* ---------- flop report: the same spot solved on many flops ---------- */
  let repStop = false, repSort = { k: "board", d: 1 };
  async function runReport() {
    if (solving || !canEdit()) return;
    let base; try { base = readSpot({ ...sv.spot, board: [48, 44, 40] }); } catch (e) { localErr = String(e); render(); return; }
    const flops = REPORT_FLOPS.slice(0, +$("repSet").value || 12).map(f => f.match(/../g).map(cardId));
    const acc = +$("repAcc").value || 1, maxIt = 400;
    localErr = ""; solving = true; repStop = false;
    const rp = { id: rid(), status: "running", n: flops.length, done: 0, rows: [], acc, t0: Date.now(), names: base.names.slice(), pot: base.pot, eff: base.eff, sizes: [base.fb, base.tb, base.rb].join(" / "), by: shared ? T.name() : "" };
    // the solver keeps one game at a time: a solve on this computer is replaced by the report
    if (sv.host === me() && (sv.status === "ready" || sv.status === "solving")) patch({ status: "idle", host: null, solveId: null, cards: null, err: "", report: rp });
    else patch({ report: rp });
    engineSolveId = null;
    try {
      const eng = await getEngine();
      for (const board of flops) {
        if (repStop || !sv.report || sv.report.id !== rp.id) break;
        const s = await eng.ask({ t: "setup", spot: { ...base, board } }, d => d.t === "setup");
        if (s.err) throw s.err;
        const [full, small] = s.mem, compress = eng.kind === "app" ? full > (eng.ram || 8e9) * 0.6 : full > 1.5e9, need = compress ? small : full;
        if (eng.kind !== "app" && need > BROWSER_LIMIT) throw `These ranges and bet sizes need about ${GB(need)} of memory per flop, more than a browser can use. Use fewer bet sizes, or the free solver app.`;
        await eng.ask({ t: "solve", compress, target: Math.max(1, base.pot * acc / 100), maxIter: maxIt, locks: [] }, d => d.t === "solved", d => {
          if (d.t === "progress") { const st = $("repStatus"); if (st) st.dataset.it = d.i; }
        });
        if (repStop) break;
        const n0 = s.cards[0].length, n1 = s.cards[1].length;
        const read = (n, k) => {
          const na = String(n.acts || "").split("/").filter(Boolean).length, buf = n.res instanceof Float64Array ? n.res : Float64Array.from(n.res);
          let o = 3; const take = m => buf.subarray(o, o += m);
          const w = [take(n0), take(n1)], norm = [take(n0), take(n1)], flag = buf[2];
          let eq = null, ev = null; if (!flag) { eq = [take(n0), take(n1)]; ev = [take(n0), take(n1)]; take(n0); take(n1); }
          const nc = k ? n1 : n0, strat = na ? take(na * nc) : null;
          const avg = (v, j) => { let a = 0, t = 0; for (let i = 0; i < v.length; i++) { a += norm[j][i] * v[i]; t += norm[j][i]; } return t ? a / t : 0; };
          let tot = 0; for (let i = 0; i < nc; i++) tot += norm[k][i];
          const f = Array.from({ length: na }, (_, a) => { let x = 0; for (let i = 0; i < nc; i++) x += norm[k][i] * strat[a * nc + i]; return tot ? x / tot : 0; });
          return { acts: n.acts, f, eq: eq ? [avg(eq[0], 0), avg(eq[1], 1)] : null, ev: ev ? [avg(ev[0], 0), avg(ev[1], 1)] : null };
        };
        const root = read(await eng.node([]), 0);
        let ipc = null;
        if (/^Check/.test(String(root.acts))) { const n = await eng.node([0]); if (n.p === "ip") ipc = read(n, 1); }
        rp.rows.push({ b: board, oop: { acts: root.acts, f: root.f.map(x => Math.round(x * 1000) / 1000) }, ip: ipc ? { acts: ipc.acts, f: ipc.f.map(x => Math.round(x * 1000) / 1000) } : null,
          eq: root.eq ? root.eq.map(x => Math.round(x * 1000) / 1000) : null, ev: root.ev ? root.ev.map(x => Math.round(x)) : null });
        rp.done = rp.rows.length;
        patch({ report: { ...rp } });
      }
      patch({ report: { ...rp, status: repStop ? "stopped" : "done", secs: Math.round((Date.now() - rp.t0) / 1000) } });
    } catch (e) {
      const m = e && e.message ? e.message : String(e || "");
      patch({ report: { ...rp, status: "error", err: m } });
      if (engine && engine.kind === "browser" && /memory|unreachable|stopped/i.test(m)) { engine.close(); engine = null; }
    } finally { solving = false; render(); }
  }
  $("repGo").onclick = () => runReport();
  $("repStop").onclick = () => { if (engine && solving) { repStop = true; engine.stop(); } };
  function texture(b) {
    const r = b.map(c => c >> 2).sort((x, y) => y - x), su = new Set(b.map(c => c & 3)).size;
    const paired = r[0] === r[1] || r[1] === r[2], hi = r[0];
    const d = [...new Set(r)], conn = d.length === 3 && (d[0] - d[2] <= 4 || (d[0] === 12 && d[1] <= 3));
    return { hi: hi === 12 ? "Ace-high" : hi === 11 ? "King-high" : hi === 10 ? "Queen-high" : hi >= 8 ? "Jack- or ten-high" : "Nine-high or lower",
      suits: su === 1 ? "Monotone" : su === 2 ? "Two-tone" : "Rainbow", paired, conn };
  }
  const betShare = x => x ? String(x.acts).split("/").filter(Boolean).reduce((a, s2, i) => a + (/^(Bet|Allin)/.test(s2) ? x.f[i] || 0 : 0), 0) : null;
  function mixBar(x) {
    if (!x) return `<span class="muted">–</span>`;
    const L = actionList(x.acts, sv.report.pot);
    return `<span class="mixbar" title="${esc(L.map((a, i) => `${a.label}: ${pct(x.f[i] || 0)}`).join(" · "))}">${L.map((a, i) => (x.f[i] || 0) > 0.001 ? `<i style="width:${x.f[i] * 100}%;background:${a.color}"></i>` : "").join("")}</span>`;
  }
  function renderReport() {
    const R = sv.report, out = $("repOut"), busy = R && R.status === "running";
    $("repGo").hidden = busy; $("repStop").hidden = !busy || !(solving && engine);
    $("repGo").disabled = !canEdit() || solving;
    if (busy && solving) $("solve").disabled = true;
    $("repGo").textContent = R && R.rows && R.rows.length ? "Run it again" : "Run the report";
    if (!R) { setHTML(out, `<p class="note">${sv.host === me() && sv.status === "ready" ? "Running a report replaces the solve on this computer; you can solve it again afterwards. " : ""}A report takes a while: about ${engine && engine.kind === "app" ? "5 to 20 seconds" : "20 to 60 seconds"} per flop with quick bet sizes.</p>`); return; }
    const n0 = shortName2(R.names, 0), n1 = shortName2(R.names, 1), rows = R.rows || [];
    let h = "";
    if (busy) { const per = rows.length ? (Date.now() - R.t0) / rows.length : 0, left = per ? Math.round(per * (R.n - rows.length) / 60000) : null;
      h += `<p class="note" id="sv-repStatus">Working: flop ${Math.min(rows.length + 1, R.n)} of ${R.n}${left != null ? ` · about ${left < 1 ? "a minute" : left + " min"} left` : ""}${R.by ? ` · on ${esc(R.by)}'s computer` : ""}.</p>`; }
    else if (R.status === "error") h += `<p class="err">The report stopped: ${esc(R.err)}</p>`;
    else h += `<p class="note">${R.status === "stopped" ? "Stopped after" : "Done:"} ${rows.length} flop${rows.length === 1 ? "" : "s"}${R.secs ? ` in ${Math.round(R.secs / 60) || "under 1"} min` : ""} · ${esc(R.names.join(" vs "))} · pot ${usd(R.pot)}, stacks ${usd(R.eff)} · bets ${esc(R.sizes)} · within ${R.acc}% of the pot.</p>`;
    if (!rows.length) { setHTML(out, h); return; }
    // by kind of flop
    const groups = new Map(), add = (g, r) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); };
    rows.forEach(r => { const t = texture(r.b); add(t.hi, r); add(t.suits, r); if (t.paired) add("Paired", r); if (t.conn) add("Connected", r); add("All flops", r); });
    const mean = (l, fn) => { const v = l.map(fn).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const order = ["All flops", "Ace-high", "King-high", "Queen-high", "Jack- or ten-high", "Nine-high or lower", "Paired", "Connected", "Monotone", "Two-tone", "Rainbow"];
    h += `<h3 class="repsub">By kind of flop</h3><div class="repwrap"><table class="brk rep"><tr><th></th><th>Flops</th><th>${esc(n0)} equity</th><th>${esc(n0)} bets</th><th>${esc(n1)} bets after a check</th></tr>` +
      order.filter(g => groups.has(g)).map(g => { const l = groups.get(g), e = mean(l, r => r.eq && r.eq[0]), b0 = mean(l, r => betShare(r.oop)), b1 = mean(l, r => betShare(r.ip));
        return `<tr${g === "All flops" ? ' class="tot"' : ""}><td>${g}</td><td>${l.length}</td><td>${e == null ? "–" : pct(e)}</td><td>${b0 == null ? "–" : pct(b0)}</td><td>${b1 == null ? "–" : pct(b1)}</td></tr>`; }).join("") + `</table></div>`;
    // each flop
    const key = { board: r => -Math.max(...r.b.map(c => c >> 2)) * 100 - Math.min(...r.b.map(c => c >> 2)), eq: r => r.eq ? r.eq[0] : 0, b0: r => betShare(r.oop) || 0, b1: r => betShare(r.ip) || 0 }[repSort.k];
    const sorted = rows.slice().sort((a, b) => (key(a) - key(b)) * repSort.d);
    const th = (k, l, cls = "") => `<th${cls ? ` class="${cls}"` : ""}><button type="button" class="linkbtn" data-rsort="${k}" aria-label="Sort by ${l}">${l}${repSort.k === k ? (repSort.d > 0 ? " ↑" : " ↓") : ""}</button></th>`;
    h += `<h3 class="repsub">Each flop</h3><div class="repwrap"><table class="brk rep repf">${`<tr>${th("board", "Flop")}${th("eq", esc(n0) + " eq.", "repeq")}${th("b0", esc(n0) + " plays")}${th("b1", esc(n1) + " after a check")}<th></th></tr>`}` +
      sorted.map(r => `<tr><td class="repb">${r.b.map(c => cardsTxt1(c)).join("")}</td><td class="repeq">${r.eq ? pct(r.eq[0]) : "–"}</td><td>${mixBar(r.oop)}</td><td>${mixBar(r.ip)}</td><td>${canEdit() ? `<button type="button" class="b sm" data-rstudy="${r.b.join(",")}" title="Put this flop in the setup">Study</button>` : ""}</td></tr>`).join("") + `</table></div>`;
    h += `<div class="row"><button class="b sm" type="button" data-rcopy="1">Copy as a table</button><span class="note">Pastes into a spreadsheet. Hover a bar to see each action's share.</span></div>`;
    setHTML(out, h);
  }
  const shortName2 = (names, k) => String((names && names[k]) || (k ? "In position" : "Out of position")).split(" · ")[0];
  const cardsTxt1 = id => { const s2 = cardStr(id); return `<span class="${s2[1]}">${s2[0] === "T" ? "10" : s2[0]}${SYM[s2[1]]}</span>`; };
  $("repOut").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || !sv.report) return;
    if (b.dataset.rsort) { const k = b.dataset.rsort; repSort = { k, d: repSort.k === k ? -repSort.d : 1 }; renderReport(); }
    else if (b.dataset.rstudy && canEdit()) { editSpot({ board: b.dataset.rstudy.split(",").map(Number), note: "" }); const w = $("pSpot"); if (w && w.scrollIntoView) w.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    else if (b.dataset.rcopy) {
      const R = sv.report, n0 = shortName2(R.names, 0), n1 = shortName2(R.names, 1);
      const lines = [["Flop", `${n0} equity`, `${n0} bets`, `${n1} bets after a check`, `${n0} actions`, `${n1} actions`].join("\t")].concat(R.rows.map(r => [r.b.map(cardStr).join(""), r.eq ? (r.eq[0] * 100).toFixed(1) : "", ((betShare(r.oop) || 0) * 100).toFixed(1), r.ip ? (betShare(r.ip) * 100).toFixed(1) : "",
        actionList(r.oop.acts, R.pot).map((a, i) => `${a.label} ${(r.oop.f[i] * 100).toFixed(1)}%`).join("; "), r.ip ? actionList(r.ip.acts, R.pot).map((a, i) => `${a.label} ${(r.ip.f[i] * 100).toFixed(1)}%`).join("; ") : ""].join("\t")));
      const txt = lines.join("\n");
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy as a table"; }, 1500); }, () => { b.textContent = "Couldn't copy"; });
    }
  });

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
    renderGrid(); renderBreak(); renderDetail(); renderEqGraph(); renderLockBar(); renderLockCmp(); renderDrill();
  }
  function eqColor(x) {
    const a = [209, 69, 59], b = [232, 163, 61], c = [76, 175, 115];
    const [p, q, t] = x < 0.5 ? [a, b, x * 2] : [b, c, (x - 0.5) * 2];
    return `rgb(${p.map((v, i) => Math.round(v + (q[i] - v) * t)).join(",")})`;
  }
  const gridPlayer = () => view === "strat" ? (node.p === "oop" ? 0 : 1) : view === "eq1" ? 1 : 0;
  function cellStats(k, filt) {
    const cells = Array.from({ length: 169 }, () => ({ hs: [], w: 0, nw: 0 }));
    const cs = sv.cards[k], r = node.r, cl = filt ? classesAt(k) : null;
    for (let i = 0; i < cs.length; i++) {
      if (cl && !inGroup(cl[i], filt)) continue;
      const c = cells[cellOf(cs[i])]; c.hs.push(i); c.w += r.w[k][i]; c.nw += r.norm[k][i];
    }
    return cells;
  }
  /* ---------- drill: a hand from the range, you pick the action, the solver grades it ---------- */
  function drillDeal() {
    const k = node.p === "oop" ? 0 : 1, nw = node.r.norm[k];
    let tot = 0; for (const w of nw) tot += w;
    let x = Math.random() * tot, i = 0;
    for (; i < nw.length - 1; i++) { x -= nw[i]; if (x <= 0 && nw[i] > 0) break; }
    while (i > 0 && !(nw[i] > 0)) i--;
    drill.k = k; drill.i = i; drill.ans = null;
  }
  function renderDrill() {
    const box = $("drill"), r = node && node.r, ok = node && node.actions.length && r && r.aev;
    const body = $("resBody");
    if (!ok) { setHTML(box, ""); body.classList.remove("drilling"); if (drill) drill = null; return; }
    if (!drill || drill.key !== nodeKey) {
      if (drill) drill = null;
      body.classList.remove("drilling");
      setHTML(box, `<button class="b sm" type="button" data-drill="start" title="Get a random hand from this range and choose what to do; the solver grades it">🎯 Quiz me on this spot</button>`);
      return;
    }
    body.classList.add("drilling");
    const D = drill, k = D.k, nc = sv.cards[k].length, code = sv.cards[k][D.i], pot = node.potNow;
    const evs = node.actions.map((_, a) => r.aev[a * nc + D.i]), best = Math.max(...evs);
    const bd = boardFor(curPath());
    let h = `<div class="drhead"><b>You're ${esc(nameOf(k))}</b><span class="drhand">${cardHTML(code & 255)}${cardHTML(code >> 8)}</span><span class="muted">on</span><span class="drboard">${bd.map(c => cardHTML(c)).join("")}</span><span class="muted">Pot ${usd(pot)}</span></div>`;
    if (D.ans == null) {
      h += `<p class="drq">What do you do?</p><div class="row drbtns">${node.actions.map((a, ai) => `<button class="b" type="button" data-drill="pick" data-a="${ai}" style="border-left:4px solid ${a.color}">${esc(a.label)}</button>`).join("")}</div>`;
    } else {
      const a = D.ans, loss = Math.max(0, best - evs[a]), f = r.strat[a * nc + D.i], lp = pot ? loss / pot : 0;
      const verdict = f >= 0.15 || lp < 0.01 ? ["good", "Solver-approved"] : lp < 0.05 ? ["close", "Close"] : ["miss", "Mistake"];
      h += `<p class="drv ${verdict[0]}"><b>${verdict[1]}.</b> You chose <b>${esc(node.actions[a].label)}</b>${loss > 0.5 ? `, giving up ${usd(loss)} (${pct(lp)} of the pot) compared with the best play` : ", as good as any play here"}.</p>
        <table class="brk drt"><tr><th>Action</th><th>Solver plays it</th><th>EV of this hand</th></tr>${node.actions.map((x, ai) => `<tr class="${ai === a ? "on" : ""}"><td><i class="drdot" style="background:${x.color}"></i>${esc(x.label)}</td><td>${pct(r.strat[ai * nc + D.i])}</td><td>${usd(evs[ai])}${Math.abs(evs[ai] - best) < 0.5 ? " ★" : ""}</td></tr>`).join("")}</table>
        <p class="note">★ = the best EV. When the solver mixes, the plays it uses are close to equal in EV.</p>`;
    }
    const sc = D.n ? `${D.n} hand${D.n === 1 ? "" : "s"} · ${D.good} solver-approved · average given up ${usd(D.loss / D.n)} (${pct(D.lossPot / D.n)} of the pot)` : "Your score shows here.";
    h += `<div class="row drfoot">${D.ans != null ? `<button class="b primary sm" type="button" data-drill="next">Next hand</button>` : ""}<button class="b sm" type="button" data-drill="stop">Stop the quiz</button><span class="note">${sc}</span></div>`;
    setHTML(box, h);
  }
  $("drill").addEventListener("click", e => {
    const b = e.target.closest("[data-drill]"); if (!b || !node) return;
    const c = b.dataset.drill;
    if (c === "start") { drill = { key: nodeKey, n: 0, good: 0, loss: 0, lossPot: 0 }; drillDeal(); }
    else if (c === "stop") { drill = null; }
    else if (c === "next") drillDeal();
    else if (c === "pick" && drill && drill.ans == null) {
      const a = +b.dataset.a, r = node.r, nc = sv.cards[drill.k].length;
      const evs = node.actions.map((_, x) => r.aev[x * nc + drill.i]), best = Math.max(...evs), loss = Math.max(0, best - evs[a]), lp = node.potNow ? loss / node.potNow : 0;
      drill.ans = a; drill.n++; drill.loss += loss; drill.lossPot += lp;
      if (r.strat[a * nc + drill.i] >= 0.15 || lp < 0.01) drill.good++;
    }
    renderDrill();
  });

  /* ---------- range breakdown: what each range is made of here, and how the player to act plays each part ---------- */
  function classesAt(k) {
    const bd = boardFor(curPath()), key = sv.solveId + "|" + bd.join(",");
    if (brkCache.key !== key) brkCache = { key, cls: [null, null], bd };
    if (!brkCache.cls[k]) brkCache.cls[k] = sv.cards[k].map(code => classify(code & 255, code >> 8, bd));
    return brkCache.cls[k];
  }
  const inGroup = (c, f) => (f.t === "m" ? c.made === f.i : c.draw === f.i);
  function renderBreak() {
    const box = $("brk"), r = node && node.r;
    if (!r || !r.norm) { $("brkD").hidden = true; return; }
    $("brkD").hidden = false;
    const actor = node.actions.length ? (node.p === "oop" ? 0 : 1) : -1;
    const cls = [classesAt(0), classesAt(1)];
    const tot = [0, 1].map(k => { let t = 0; for (const w of r.norm[k]) t += w; return t; });
    const group = (t, n) => Array.from({ length: n }, (_, i) => {
      const f = { t, i }, share = [0, 1].map(k => { let w = 0; cls[k].forEach((c, j) => { if (inGroup(c, f)) w += r.norm[k][j]; }); return tot[k] ? w / tot[k] : 0; });
      let mix = null, eq = null;
      if (actor >= 0) {
        const nc = sv.cards[actor].length; let w = 0; mix = node.actions.map(() => 0);
        cls[actor].forEach((c, j) => { if (!inGroup(c, f)) return; const x = r.norm[actor][j]; w += x; node.actions.forEach((a, ai) => { mix[ai] += x * r.strat[ai * nc + j]; }); });
        mix = w ? mix.map(v => v / w) : null;
      }
      const k2 = actor >= 0 ? actor : 0;
      if (r.eq) { let w = 0, e = 0; cls[k2].forEach((c, j) => { if (!inGroup(c, f)) return; w += r.norm[k2][j]; e += r.norm[k2][j] * r.eq[k2][j]; }); eq = w ? e / w : null; }
      return { f, share, mix, eq };
    }).filter(g => g.share[0] > 0.0005 || g.share[1] > 0.0005);
    const made = group("m", MADE.length), draws = group("d", DRAWS.length);
    const who = actor >= 0 ? actor : 0;
    const head = `<tr><th></th><th>${esc(shortName(0))}</th><th>${esc(shortName(1))}</th>${r.eq ? `<th title="Average equity of these hands for ${esc(nameOf(who))}">${esc(shortName(who))} eq.</th>` : ""}${actor >= 0 ? `<th>How ${esc(shortName(actor))} plays them</th>` : ""}</tr>`;
    const row = (g, name) => {
      const on = brkFilter && brkFilter.t === g.f.t && brkFilter.i === g.f.i;
      const bar = g.mix ? `<span class="mixbar" title="${esc(node.actions.map((a, ai) => `${a.label}: ${pct(g.mix[ai])}`).join(" · "))}">${node.actions.map((a, ai) => g.mix[ai] > 0.001 ? `<i style="width:${g.mix[ai] * 100}%;background:${a.color}"></i>` : "").join("")}</span>` : (actor >= 0 ? `<span class="muted">none in range</span>` : "");
      return `<tr class="${on ? "on" : ""}"><td><button type="button" class="linkbtn" data-brk="${g.f.t}${g.f.i}" aria-pressed="${on}" title="Show only these hands in the chart">${esc(name)}</button></td><td>${g.share[0] > 0.0005 ? pct(g.share[0]) : "–"}</td><td>${g.share[1] > 0.0005 ? pct(g.share[1]) : "–"}</td>${r.eq ? `<td>${g.eq == null ? "–" : pct(g.eq)}</td>` : ""}${actor >= 0 ? `<td>${bar}</td>` : ""}</tr>`;
    };
    let h = `<table class="brk">${head}${made.map(g => row(g, MADE[g.f.i])).join("")}`;
    if (draws.length) h += `<tr class="brksub"><th colspan="${3 + (r.eq ? 1 : 0) + (actor >= 0 ? 1 : 0)}">Draws <span class="muted">(hands weaker than a straight)</span></th></tr>` + draws.map(g => row(g, DRAWS[g.f.i])).join("");
    h += `</table><p class="note">Share of each player's range here. ${brkFilter ? `The chart shows only <b>${esc(brkFilter.t === "m" ? MADE[brkFilter.i] : DRAWS[brkFilter.i])}</b>. <button type="button" class="linkbtn" data-brk="off">Show all hands</button>` : "Tap a group to show only those hands in the chart."}</p>`;
    setHTML(box, h);
  }
  $("brk").addEventListener("click", e => {
    const b = e.target.closest("[data-brk]"); if (!b || !node) return;
    const v = b.dataset.brk, f = v === "off" ? null : { t: v[0], i: +v.slice(1) };
    brkFilter = f && brkFilter && brkFilter.t === f.t && brkFilter.i === f.i ? null : f;
    renderGrid(); renderBreak(); renderDetail();
  });
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
    const k = gridPlayer(), cells = cellStats(k, brkFilter), r = node.r, nc = sv.cards[k].length, bd = new Set(boardFor(curPath()));
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
  /* ---------- node locking: fix one player's strategy at a spot, then solve again ---------- */
  let lockEd = null, lockPaint = null;
  const verLess = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
  const histKey = h => (h || []).join(",");
  const whereOf = path => path.slice(1).map(st => st.label).join(" › ") || "the first decision";
  const lockAt = h => (sv.locks || []).find(l => histKey(l.hist) === histKey(h));
  // per-hand strategy for the engine: action-major, all zeros = the solver chooses
  function lockStrategy(l, cards) {
    const na = l.labels.length, nc = cards.length, out = new Array(na * nc).fill(0);
    for (let i = 0; i < nc; i++) {
      if (l.mode === "mix") { for (let a = 0; a < na; a++) out[a * nc + i] = Math.max(0, +l.mix[a] || 0); }
      else { const a = l.cells[cellOf(cards[i])]; if (a != null && a >= 0 && a < na) out[a * nc + i] = 1; }
    }
    return out;
  }
  function lockSummary(l) {
    const nm = shortName(l.p);
    if (l.mode === "mix") return `${nm}: ` + l.labels.map((lb, a) => `${lb.toLowerCase()} ${Math.round((+l.mix[a] || 0) * 100)}%`).filter((x, a) => +l.mix[a] > 0).join(", ");
    const cnt = l.labels.map((_, a) => Object.values(l.cells).filter(v => v === a).length);
    const free = 169 - cnt.reduce((x, y) => x + y, 0);
    return `${nm}: ` + l.labels.map((lb, a) => cnt[a] ? `${lb.toLowerCase()} with ${cnt[a]} hand type${cnt[a] === 1 ? "" : "s"}` : "").filter(Boolean).join(", ") + (free ? `; the solver picks for the other ${free}` : "");
  }
  // do the saved locks differ from the ones this solve used?
  function locksStale() {
    if (!sv.solved) return false;
    const sig = ls => ls.map(l => histKey(l.hist) + "|" + l.sum).sort().join(";");
    const tried = (sv.solved.locked || []).concat(((sv.info && sv.info.lockFail) || []).map(f => ({ hist: f.hist, sum: f.sum })));
    return sig(tried) !== sig(sv.locks || []);
  }
  function renderLockBar() {
    const bar = $("lockBar"), ed = $("lockEd");
    const isPlayer = node && (node.p === "oop" || node.p === "ip") && node.actions.length;
    if (!isPlayer || explore) { setHTML(bar, ""); ed.hidden = true; lockEd = null; return; }
    const path = curPath(), h = path[path.length - 1].hist, l = lockAt(h);
    const used = ((sv.solved && sv.solved.locked) || []).find(x => histKey(x.hist) === histKey(h));
    let html = "";
    if (used && l && used.sum === l.sum) html += `<span class="lockchip on">🔒 Locked in this solve · ${esc(l.sum)}</span>`;
    else if (used && l) html += `<span class="lockchip">🔒 Lock changed · these results use the old version, so solve again to use the new one · ${esc(l.sum)}</span>`;
    else if (used) html += `<span class="lockchip">Lock removed · these results still include it, so solve again to see play without it</span>`;
    else if (l) html += `<span class="lockchip">🔒 Lock saved · solve again to use it · ${esc(l.sum)}</span>`;
    if (canEdit()) html += l ? `<button class="b sm" type="button" data-lk="edit">Edit lock</button><button class="b sm" type="button" data-lk="remove">Remove lock</button>`
      : `<button class="b sm" type="button" data-lk="edit">🔒 Lock this spot</button>`;
    setHTML(bar, html);
    if (lockEd && lockEd.key !== histKey(h)) lockEd = null;
    renderLockEd();
  }
  function startEdit() {
    const path = curPath(), h = path[path.length - 1].hist, l = lockAt(h), k = node.p === "oop" ? 0 : 1;
    const labels = node.actions.map(a => a.label.replace(/ \(.*\)/, ""));
    lockEd = l && l.labels.length === labels.length ? { key: histKey(h), mode: l.mode, mix: l.mix.slice(), cells: { ...l.cells }, brush: 0 }
      : { key: histKey(h), mode: "hands", mix: node.actions.map(a => Math.round((a.freq || 0) * 1000) / 1000), cells: {}, brush: 0 };
    lockEd.k = k; lockEd.labels = labels;
    renderLockEd();
  }
  function cellsInRange(k) { const st = cellStats(k); return st.map(c => c.nw > 0); }
  function renderLockEd() {
    const ed = $("lockEd");
    if (!lockEd || !node || !node.actions.length) { ed.hidden = true; return; }
    ed.hidden = false;
    const L = lockEd, cols = node.actions.map(a => a.color), inR = cellsInRange(L.k);
    let h = `<div class="lkhead"><b>Lock ${esc(nameOf(L.k))}'s strategy here</b><span class="muted">${esc(whereOf(curPath()))}</span></div>
      <div class="tabs lktabs" role="tablist"><button class="tab" type="button" data-lk="mode" data-m="hands" aria-selected="${L.mode === "hands"}">Hand by hand</button><button class="tab" type="button" data-lk="mode" data-m="mix" aria-selected="${L.mode === "mix"}">Whole range</button></div>`;
    if (L.mode === "mix") {
      const tot = L.mix.reduce((a, b) => a + (+b || 0), 0);
      h += `<p class="note">Every hand plays this mix. The numbers start at what the solver does now.</p><div class="lkmix">` + L.labels.map((lb, a) => `<label><span><i style="background:${cols[a]}"></i>${esc(lb)}</span><input type="range" min="0" max="100" step="1" data-lkmix="${a}" value="${Math.round((+L.mix[a] || 0) * 100)}"><input type="number" min="0" max="100" step="1" data-lkmixn="${a}" value="${Math.round((+L.mix[a] || 0) * 100)}"><span>%</span></label>`).join("") +
        `</div><p class="note">Total ${Math.round(tot * 100)}%${Math.abs(tot - 1) > 0.005 ? " (it will be scaled to 100%)" : ""}.</p>`;
    } else {
      // how much of the range each action gets
      const st = cellStats(L.k), share = L.labels.map(() => 0); let free = 0, all = 0;
      st.forEach((c, i) => { all += c.nw; const a = L.cells[i]; if (a != null) share[a] += c.nw; else free += c.nw; });
      h += `<p class="note">Pick an action, then paint the hands that always take it. Hands you leave grey are still up to the solver. Dim hands aren't in ${esc(shortName(L.k))}'s range here.</p>
        <div class="row lkbrush">${L.labels.map((lb, a) => `<button class="b sm${L.brush === a ? " on" : ""}" type="button" data-lk="brush" data-a="${a}"><i style="background:${cols[a]}"></i>${esc(lb)}<small>${all ? pct(share[a] / all) : ""}</small></button>`).join("")}<button class="b sm${L.brush === -1 ? " on" : ""}" type="button" data-lk="brush" data-a="-1"><i class="free"></i>Solver picks<small>${all ? pct(free / all) : ""}</small></button></div>
        <div class="rgrid lkgrid" id="sv-lkgrid">`;
      for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
        const i = r * 13 + c, a = L.cells[i];
        h += `<button type="button" class="rc${inR[i] ? "" : " out"}" data-lkc="${i}" style="${a != null ? `background:${cols[a]};color:#fff` : ""}">${cellName(r, c)}</button>`;
      }
      h += `</div><div class="row lkfill"><button class="b sm" type="button" data-lk="copy">Start from the solver's choices</button><button class="b sm" type="button" data-lk="fill">Paint the grey hands too</button><button class="b sm" type="button" data-lk="clear">Clear</button></div>`;
    }
    h += `<div class="row"><button class="b primary" type="button" data-lk="save">Save lock</button><button class="b" type="button" data-lk="cancel">Cancel</button></div>
      <p class="note">Locks take effect when you solve again. Then compare: the other player's strategy and both players' EV move to answer this exact play.</p>`;
    setHTML(ed, h);
  }
  function saveLock() {
    const L = lockEd, path = curPath(), h = path[path.length - 1].hist;
    if (L.mode === "mix" && !L.mix.some(x => +x > 0)) { localErr = "Give at least one action some of the range."; render(); return; }
    if (L.mode === "hands" && !Object.keys(L.cells).length) { localErr = "Paint at least one hand, or use “Whole range”."; render(); return; }
    const l = { id: rid(), hist: h.slice(), path: path.map(st => ({ ...st })), where: whereOf(path), p: L.k, acts: node.acts, labels: L.labels.slice(), mode: L.mode, mix: L.mix.map(x => Math.max(0, +x || 0)), cells: { ...L.cells } };
    l.sum = lockSummary(l);
    patch({ locks: (sv.locks || []).filter(x => histKey(x.hist) !== histKey(h)).concat(l).slice(0, 12) });
    lockEd = null; localErr = ""; render();
  }
  $("lockBar").onclick = e => {
    const b = e.target.closest("[data-lk]"); if (!b || !canEdit()) return;
    if (b.dataset.lk === "edit") startEdit();
    else if (b.dataset.lk === "remove") { const h = curPath().slice(-1)[0].hist; patch({ locks: (sv.locks || []).filter(x => histKey(x.hist) !== histKey(h)) }); lockEd = null; render(); }
  };
  $("lockEd").onclick = e => {
    const b = e.target.closest("[data-lk]"); if (!b || !lockEd) return;
    const L = lockEd, c = b.dataset.lk;
    if (c === "mode") L.mode = b.dataset.m;
    else if (c === "brush") L.brush = +b.dataset.a;
    else if (c === "clear") L.cells = {};
    else if (c === "fill") { if (L.brush >= 0) for (let i = 0; i < 169; i++) if (L.cells[i] == null) L.cells[i] = L.brush; }
    else if (c === "copy") { // each hand type takes its most-used action right now
      const st = cellStats(L.k), nc = sv.cards[L.k].length, r = node.r; L.cells = {};
      st.forEach((cell, i) => { if (!cell.nw) return; const f = L.labels.map((_, a) => cell.hs.reduce((s2, hh) => s2 + r.norm[L.k][hh] * r.strat[a * nc + hh], 0)); L.cells[i] = f.indexOf(Math.max(...f)); });
    }
    else if (c === "save") return saveLock();
    else if (c === "cancel") { lockEd = null; }
    renderLockEd();
  };
  $("lockEd").addEventListener("input", e => {
    const t = e.target, L = lockEd; if (!L) return;
    const a = t.dataset.lkmix ?? t.dataset.lkmixn; if (a == null) return;
    L.mix[+a] = Math.max(0, Math.min(100, +t.value || 0)) / 100;
    const other = t.dataset.lkmix != null ? `[data-lkmixn="${a}"]` : `[data-lkmix="${a}"]`; const o = $("lockEd").querySelector(other); if (o) o.value = Math.round(L.mix[+a] * 100);
    const tot = L.mix.reduce((x, y) => x + (+y || 0), 0), n = $("lockEd").querySelector(".lkmix + .note");
    if (n) n.textContent = `Total ${Math.round(tot * 100)}%${Math.abs(tot - 1) > 0.005 ? " (it will be scaled to 100%)" : ""}.`;
  });
  // paint the lock grid: press and drag
  $("lockEd").addEventListener("pointerdown", e => {
    const b = e.target.closest("[data-lkc]"); if (!b || !lockEd) return;
    e.preventDefault(); lockPaint = new Set(); paintLock(+b.dataset.lkc);
  });
  function paintLock(i) {
    if (!lockPaint || lockPaint.has(i)) return; lockPaint.add(i);
    const L = lockEd; if (L.brush < 0) delete L.cells[i]; else L.cells[i] = L.brush;
    const el = $("lockEd").querySelector(`[data-lkc="${i}"]`); if (el) { const col = L.brush >= 0 ? node.actions[L.brush].color : ""; el.style.background = col; el.style.color = col ? "#fff" : ""; }
  }
  window.addEventListener("pointermove", e => { if (!lockPaint) return; const el = document.elementFromPoint(e.clientX, e.clientY), b = el && el.closest && el.closest("[data-lkc]"); if (b && $("lockEd").contains(b)) paintLock(+b.dataset.lkc); }, { signal: ac.signal });
  window.addEventListener("pointerup", () => { if (lockPaint) { lockPaint = null; renderLockEd(); } }, { signal: ac.signal });
  // locks list in the Solve part
  function renderLockList() {
    const ls = sv.locks || [], box = $("lockList");
    if (!ls.length) { setHTML(box, ""); return; }
    setHTML(box, `<h3>Node locks (${ls.length})</h3><p class="note">They take effect the next time you solve.</p>` + ls.map(l => `<div class="lockrow"><button type="button" class="linkbtn" data-lgo="${esc(l.id)}">${esc(l.where)}</button><span class="muted">${esc(l.sum)}</span>${canEdit() ? `<button class="b sm" type="button" data-lrm="${esc(l.id)}" aria-label="Remove this lock">Remove</button>` : ""}</div>`).join("") +
      (canEdit() && ls.length > 1 ? `<button class="b sm" type="button" data-lrm="*">Remove all locks</button>` : ""));
  }
  $("lockList").onclick = e => {
    const g = e.target.closest("[data-lgo]"), r = e.target.closest("[data-lrm]");
    if (g) { const l = (sv.locks || []).find(x => x.id === g.dataset.lgo); if (l && sv.status === "ready") go(l.path, false); }
    else if (r && canEdit()) { patch({ locks: r.dataset.lrm === "*" ? [] : (sv.locks || []).filter(x => x.id !== r.dataset.lrm) }); lockEd = null; render(); }
  };
  // before/after: the same spot solved without locks, at the first decision
  const spotSig = sp => JSON.stringify({ ...sp, names: 0, acc: 0, maxIt: 0, locked: 0 });
  function renderLockCmp() {
    const box = $("lockCmp"), path = curPath();
    if (!node || path.length !== 1 || !node.r || node.r.flag) { setHTML(box, ""); return; }
    const r = node.r, avg = (vals, k) => { let s2 = 0, t = 0; for (let i = 0; i < r.norm[k].length; i++) { s2 += r.norm[k][i] * vals[i]; t += r.norm[k][i]; } return t ? s2 / t : 0; };
    const ev = [avg(r.ev[0], 0), avg(r.ev[1], 1)], sig = spotSig(sv.solved), locked = (sv.solved.locked || []).length;
    if (!locked) { if (canEdit() && (!sv.base || sv.base.sig !== sig || Math.abs(sv.base.ev[0] - ev[0]) > 1e-6)) patch({ base: { sig, ev } }); setHTML(box, ""); return; }
    if (!sv.base || sv.base.sig !== sig) { setHTML(box, `<p class="note">Solve once with no locks to see how much the locks change each player's EV.</p>`); return; }
    const d = [0, 1].map(k => ev[k] - sv.base.ev[k]);
    setHTML(box, `<div class="cmp"><b>What the locks change, from the start of the hand</b>${[0, 1].map(k => `<span>${esc(nameOf(k))}: EV ${usd(sv.base.ev[k])} → <b>${usd(ev[k])}</b> <span class="${d[k] >= 0 ? "up" : "down"}">(${d[k] >= 0 ? "+" : "−"}${usd(Math.abs(d[k]))})</span></span>`).join("")}</div>`);
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
      const nl = (sv.solved.locked || []).length, lf = sv.info.lockFail || [];
      $("progTxt").innerHTML = esc(`${sv.info.stopped ? "Stopped" : "Done"} after ${sv.info.i} iterations in ${sv.info.secs.toFixed(1)} s · within ${pct(sv.info.e / sv.solved.pot)} of perfect play.`) +
        (nl ? ` <b>${nl} node lock${nl === 1 ? "" : "s"} in this solve.</b>` : "") + (locksStale() ? `<br><b>Your locks have changed since this solve.</b> Solve again to update the results.` : "") + (lf.length ? `<br><span class="err">Skipped ${lf.length === 1 ? "a lock" : lf.length + " locks"}: ${lf.map(f => `${esc(f.where)} (${esc(f.why)})`).join("; ")}.</span>` : "");
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
    renderBar(); syncInputs(); renderPair(); renderLockList(); renderBoard(); renderRangeGrid(); renderProgress(); renderEngine(); renderBig(); renderReport();
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
