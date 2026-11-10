// Notes: a small browser-style window with one tab per street (Preflop, Flop, Turn, River, plus any
// you add). Each tab has free text and its own blank 13×13 range to paint, so a range can be narrowed
// street by street: the previous tab's range shows faintly under the current one, and the thread line
// counts the combos left at each step. In a lobby the notebook is shared like the solver.
import { cellName, parseRange, formatRange, comboCount, PRESETS } from "./solver/range.js";

const SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const MAX_TABS = 16, MAX_TEXT = 6000, MAX_RANGE = 3000, MAX_NAME = 24;
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => Math.random().toString(36).slice(2, 8);
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

export function defaultNotebook() {
  const names = { pre: "Preflop", flop: "Flop", turn: "Turn", river: "River" };
  const tabs = {}; for (const [id, name] of Object.entries(names)) tabs[id] = { name, text: "", range: "" };
  return { order: Object.keys(names), tabs };
}
// make any stored or received notebook safe to use
export function normalizeNotebook(nb) {
  const d = defaultNotebook();
  if (!nb || typeof nb !== "object" || !nb.tabs || typeof nb.tabs !== "object") return d;
  const tabs = {};
  for (const [id, t] of Object.entries(nb.tabs).slice(0, MAX_TABS)) {
    if (!/^[a-z0-9]{1,10}$/.test(id) || !t || typeof t !== "object") continue;
    tabs[id] = { name: String(t.name || "Tab").slice(0, MAX_NAME), text: String(t.text || "").slice(0, MAX_TEXT), range: String(t.range || "").slice(0, MAX_RANGE) };
  }
  const order = (Array.isArray(nb.order) ? nb.order : []).filter((id, i, a) => tabs[id] && a.indexOf(id) === i);
  for (const id of Object.keys(tabs)) if (!order.includes(id)) order.push(id);
  return { order, tabs };
}
// field patches: {"order":[…]}, {"t.<id>": {…} or null}, {"t.<id>.text": "…"} (same rules on the server)
export function applyNotesPatch(nb, np) {
  const o = { order: nb.order.slice(), tabs: { ...nb.tabs } };
  for (const [k, v] of Object.entries(np || {})) {
    let m;
    if (k === "order" && Array.isArray(v)) o.order = v.map(String);
    else if ((m = /^t\.([a-z0-9]{1,10})$/.exec(k))) { if (v === null) delete o.tabs[m[1]]; else if (typeof v === "object") o.tabs[m[1]] = v; }
    else if ((m = /^t\.([a-z0-9]{1,10})\.(name|text|range)$/.exec(k)) && o.tabs[m[1]]) o.tabs[m[1]] = { ...o.tabs[m[1]], [m[2]]: String(v) };
  }
  return normalizeNotebook(o);
}

// opt.transport: {send(o), canEdit()} for a lobby; none for a table on this device only
// opt.table: {current()} the table's public view, for the board and the street
// opt.solver(): the solver, to send a range to it or copy one from it
// opt.flash(text): a short message
export function createNotes(el, opt = {}) {
  const T = opt.transport || null;
  const canEdit = () => !T || T.canEdit();
  let nb = T ? defaultNotebook() : normalizeNotebook(lsGet("hsp-notes"));
  let tdrag = null, active = nb.order[0], paintW = 1, paint = null, renaming = null, confirmClear = false, lastStreet = "";
  const timers = new Map();
  const ac = new AbortController(), sig = { signal: ac.signal };

  el.innerHTML = `
    <h2>Notes</h2>
    <div class="nbwin">
      <div class="nbstrip"><div class="nbtabs" role="tablist" aria-label="Note tabs"></div><button type="button" class="nbadd" aria-label="Add a tab" title="Add a tab">+</button></div>
      <div class="nbbody" role="tabpanel">
        <div class="nbthread" aria-label="Range thread"></div>
        <div class="nbboard"></div>
        <div class="nbsub nb-pText"><label class="nblab" for="nb-text">Notes</label>
        <textarea id="nb-text" rows="5" maxlength="${MAX_TEXT}" placeholder="What happened on this street, what they might have, the plan…"></textarea></div>
        <div class="nbsub nb-pRange"><div class="nbrhead"><span class="nblab">Range</span><span class="nbcount note"></span></div>
        <div class="rlay"><div class="rlay-c">
        <div class="row nbtools">
          <button class="b sm" type="button" data-nb="carry"></button>
          <select class="nbsel" data-nb="preset" aria-label="Load a starting range"><option value="">Load a starting range…</option>${Object.keys(PRESETS).map(k => `<option>${esc(k)}</option>`).join("")}</select>
          <select class="nbsel" data-nb="solver" aria-label="Use with the solver"></select>
          <button class="b sm" type="button" data-nb="clear">Clear range</button>
        </div>
        <div class="row paint"><label for="nb-paintW">Tap paints</label><input type="range" id="nb-paintW" min="0" max="100" step="5" value="100"><span class="nbpw">100%</span></div>
        <textarea id="nb-rtext" class="nbrtext" rows="2" spellcheck="false" maxlength="${MAX_RANGE}" placeholder="Paint the grid or type a range, like QQ+,AK,A5s"></textarea>
        <p class="err nberr" role="status"></p></div>
        <div class="rgrid nbgrid" data-anc="svnbgrid" aria-label="Notes range grid"></div></div></div>
        <div class="row nbfoot"><button class="b sm" type="button" data-nb="wipe">Clear all notes</button></div>
      </div>
    </div>`;
  const q = s => el.querySelector(s);
  const tabsEl = q(".nbtabs"), gridEl = q(".nbgrid"), textEl = q("#nb-text"), rtextEl = q("#nb-rtext");

  /* ---------- changes ---------- */
  function send(np) {
    nb = applyNotesPatch(nb, np);
    if (T) T.send({ t: "nb", np }); else lsSet("hsp-notes", nb);
  }
  function sendSoon(key, val) { // typing: send the latest after a short pause
    nb = applyNotesPatch(nb, { [key]: val });
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); send({ [key]: val }); }, 350));
  }
  function onMessage(m) {
    if (m.full !== undefined) nb = normalizeNotebook(m.full);
    else if (m.np) {
      const mine = {}; for (const k of timers.keys()) mine[k] = keyVal(k); // keep what this person is still typing
      nb = applyNotesPatch(applyNotesPatch(nb, m.np), mine);
    }
    if (!nb.tabs[active]) active = nb.order[0];
    render();
  }
  const keyVal = k => { const m = /^t\.(\w+)\.(\w+)$/.exec(k); return m && nb.tabs[m[1]] ? nb.tabs[m[1]][m[2]] : ""; };
  const tab = () => nb.tabs[active];
  const prevId = () => { const i = nb.order.indexOf(active); return i > 0 ? nb.order[i - 1] : null; };
  const weights = t => (t ? parseRange(t.range) : { w: new Float32Array(169), err: "" });

  /* ---------- drawing ---------- */
  function cardsHTML(list) { return list.map(c => `<span class="${c[1]}">${c[0] === "T" ? "10" : c[0]}${SYM[c[1]] || ""}</span>`).join(" "); }
  function streetOf(name) { const n = String(name).toLowerCase(); return n === "flop" ? 3 : n === "turn" ? 4 : n === "river" ? 5 : 0; }
  function renderTabs() {
    tabsEl.innerHTML = nb.order.map(id => {
      const t = nb.tabs[id], on = id === active;
      const name = renaming === id ? `<input class="nbren" value="${esc(t.name)}" maxlength="${MAX_NAME}" aria-label="Tab name">` : `<span class="nbname">${esc(t.name)}</span>`;
      return `<div class="nbtab" role="tab" tabindex="${on ? 0 : -1}" aria-selected="${on}" data-id="${id}" title="${esc(t.name)}${canEdit() ? " · double-click to rename, drag to move" : ""}">${name}${canEdit() && nb.order.length > 1 ? `<button type="button" class="nbx" data-x="${id}" aria-label="Close the ${esc(t.name)} tab" tabindex="-1">×</button>` : ""}</div>`;
    }).join("");
    q(".nbadd").hidden = !canEdit() || nb.order.length >= MAX_TABS;
    const inp = tabsEl.querySelector(".nbren"); if (inp) { inp.focus(); inp.select(); }
  }
  function renderThread() {
    let prev = null;
    q(".nbthread").innerHTML = nb.order.map((id, i) => {
      const r = weights(nb.tabs[id]), n = r.err ? null : comboCount(r.w);
      const share = n && prev ? ` <small>${Math.round((n / prev) * 100)}%</small>` : "";
      if (n) prev = n;
      return `${i ? `<span class="nbarrow" aria-hidden="true">→</span>` : ""}<button type="button" class="nbstep${id === active ? " on" : ""}" data-go="${id}">${esc(nb.tabs[id].name)} <b>${n === null ? "?" : n ? Math.round(n) : "–"}</b>${share}</button>`;
    }).join("");
  }
  function renderGrid() {
    if (paint) return;
    const t = tab(), r = weights(t), p = prevId(), g = p ? weights(nb.tabs[p]).w : null;
    let h = "";
    for (let a = 0; a < 13; a++) for (let b = 0; b < 13; b++) {
      const i = a * 13 + b, v = r.w[i], gv = g ? g[i] : 0;
      h += `<button type="button" class="rc" data-cell="${i}" aria-label="${cellName(a, b)} ${Math.round(v * 100)}%">${gv ? `<div class="ghost" style="height:${gv * 100}%"></div>` : ""}<div class="fill" style="height:${v * 100}%"></div><span>${cellName(a, b)}</span></button>`;
    }
    gridEl.innerHTML = h;
    const n = r.err ? 0 : comboCount(r.w);
    q(".nbcount").textContent = r.err ? "" : n ? `${Math.round(n)} combos, ${Math.round((n / 1326) * 1000) / 10}% of all hands${p ? ` · faint cells are the ${nb.tabs[p].name} range` : ""}` : p ? `Blank. Faint cells are the ${nb.tabs[p].name} range.` : "Blank. Paint the grid, type a range, or load one.";
    q(".nberr").textContent = r.err ? r.err : "";
  }
  function renderBoard() {
    const P = opt.table && opt.table.current(), k = streetOf(tab().name);
    const b = P && P.board ? P.board : [];
    q(".nbboard").innerHTML = k && b.length >= 3 ? `<span class="muted">Board${P.hand ? ` (hand #${P.hand})` : ""}:</span> <span class="cards">${cardsHTML(b.slice(0, Math.min(k, b.length)))}</span>${b.length < k ? ` <span class="muted">· ${tab().name.toLowerCase()} not dealt yet</span>` : ""}` : "";
  }
  function renderTools() {
    const p = prevId(), ed = canEdit(), S = opt.solver && opt.solver();
    const c = q('[data-nb="carry"]'); c.hidden = !p; if (p) c.textContent = `Start from ${nb.tabs[p].name}`;
    let o = `<option value="">Solver…</option>`;
    if (S) {
      const nm = S.names ? S.names() : ["Out of position", "In position"];
      if (S.canEdit && S.canEdit()) o += `<optgroup label="Send this range to the solver"><option value="to0">As ${esc(nm[0])} (out of position)</option><option value="to1">As ${esc(nm[1])} (in position)</option></optgroup>`;
      o += `<optgroup label="Copy a solver range here"><option value="from0">${esc(nm[0])} (out of position)</option><option value="from1">${esc(nm[1])} (in position)</option></optgroup>`;
    }
    const sel = q('[data-nb="solver"]'); sel.innerHTML = o; sel.hidden = !S;
    el.querySelectorAll(".nbbody textarea, .nbbody select, [data-nb], #nb-paintW").forEach(x => { x.disabled = !ed; });
    const s2 = q('[data-nb="solver"]'); if (S && !ed) s2.disabled = true;
    q('[data-nb="wipe"]').textContent = confirmClear ? "Click again to clear every tab" : "Clear all notes";
    q('[data-nb="wipe"]').classList.toggle("warn", confirmClear);
    gridEl.classList.toggle("ro", !ed);
  }
  function render() {
    if (!tab()) active = nb.order[0];
    const f = document.activeElement;
    if (!tdrag || !tdrag.on) { if (!renaming || !tabsEl.querySelector(".nbren")) renderTabs(); }
    renderThread(); renderBoard(); renderTools(); renderGrid();
    if (f !== textEl) textEl.value = tab().text;
    if (f !== rtextEl) rtextEl.value = tab().range;
  }
  function select(id) { if (!nb.tabs[id]) return; active = id; confirmClear = false; render(); }

  /* ---------- tab strip: select, close, add, rename, drag to reorder ---------- */
  tabsEl.addEventListener("pointerdown", e => {
    const t = e.target.closest(".nbtab"); if (!t || e.target.closest(".nbx,.nbren") || e.button > 0) return;
    if (t.dataset.id !== active) select(t.dataset.id);
    if (!canEdit()) return;
    const n = tabsEl.querySelector(`[data-id="${t.dataset.id}"]`);
    tdrag = { id: t.dataset.id, el: n, x: e.clientX, on: false, pid: e.pointerId };
    try { n.setPointerCapture(e.pointerId); } catch (x) {}
  });
  tabsEl.addEventListener("pointermove", e => {
    if (!tdrag || e.pointerId !== tdrag.pid) return;
    if (!tdrag.on) { if (Math.abs(e.clientX - tdrag.x) < 6) return; tdrag.on = true; tdrag.el.classList.add("drag"); }
    const others = [...tabsEl.children].filter(x => x !== tdrag.el);
    const before = others.find(x => { const r = x.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    if (before) { if (tdrag.el.nextSibling !== before) tabsEl.insertBefore(tdrag.el, before); } else if (tdrag.el.nextSibling) tabsEl.appendChild(tdrag.el);
  });
  const endTab = e => {
    if (!tdrag || e.pointerId !== tdrag.pid) return;
    const d = tdrag; tdrag = null; d.el.classList.remove("drag");
    if (!d.on) return;
    const order = [...tabsEl.children].map(x => x.dataset.id);
    if (order.join() !== nb.order.join()) send({ order });
    render();
  };
  tabsEl.addEventListener("pointerup", endTab); tabsEl.addEventListener("pointercancel", endTab);
  tabsEl.addEventListener("click", e => {
    const x = e.target.closest(".nbx"); if (!x || !canEdit()) return;
    const id = x.dataset.x, i = nb.order.indexOf(id); if (nb.order.length < 2) return;
    const order = nb.order.filter(z => z !== id);
    if (active === id) active = order[Math.max(0, i - 1)];
    send({ ["t." + id]: null, order }); render();
  });
  tabsEl.addEventListener("dblclick", e => { const t = e.target.closest(".nbtab"); if (!t || !canEdit()) return; renaming = t.dataset.id; renderTabs(); });
  function finishRename(save) {
    const inp = tabsEl.querySelector(".nbren"); if (!inp || !renaming) return;
    const id = renaming, v = inp.value.trim().slice(0, MAX_NAME); renaming = null;
    if (save && v && v !== nb.tabs[id].name) send({ ["t." + id + ".name"]: v });
    render();
  }
  tabsEl.addEventListener("keydown", e => {
    if (e.target.classList.contains("nbren")) { if (e.key === "Enter") finishRename(true); else if (e.key === "Escape") finishRename(false); return; }
    const t = e.target.closest(".nbtab"); if (!t) return;
    const i = nb.order.indexOf(t.dataset.id);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const j = i + (e.key === "ArrowRight" ? 1 : -1); if (j < 0 || j >= nb.order.length) return;
      if (e.shiftKey && canEdit()) { const o = nb.order.slice(); o.splice(j, 0, o.splice(i, 1)[0]); send({ order: o }); render(); }
      else select(nb.order[j]);
      const n = tabsEl.querySelector(`[data-id="${active}"]`); if (n) n.focus();
    } else if (e.key === "F2" && canEdit()) { renaming = t.dataset.id; renderTabs(); }
  });
  tabsEl.addEventListener("focusout", e => { if (e.target.classList.contains("nbren")) finishRename(true); });
  q(".nbadd").onclick = () => {
    if (!canEdit() || nb.order.length >= MAX_TABS) return;
    const id = rid(), names = new Set(Object.values(nb.tabs).map(t => t.name));
    let k = 1; while (names.has("Note " + k)) k++;
    send({ ["t." + id]: { name: "Note " + k, text: "", range: "" }, order: nb.order.concat(id) });
    active = id; renaming = id; render();
  };
  q(".nbthread").addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) select(b.dataset.go); });

  /* ---------- text and range ---------- */
  textEl.addEventListener("input", () => { if (canEdit()) { sendSoon("t." + active + ".text", textEl.value); } });
  rtextEl.addEventListener("input", () => { if (!canEdit()) return; sendSoon("t." + active + ".range", rtextEl.value); renderGrid(); renderThread(); });
  q("#nb-paintW").addEventListener("input", e => { paintW = +e.target.value / 100; q(".nbpw").textContent = e.target.value + "%"; });
  const setRange = text => { send({ ["t." + active + ".range"]: text }); render(); };
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-nb]"); if (!b || !canEdit()) return;
    const c = b.dataset.nb;
    if (c === "carry") { const p = prevId(); if (p) setRange(nb.tabs[p].range); }
    else if (c === "clear") setRange("");
    else if (c === "wipe") {
      if (!confirmClear) { confirmClear = true; renderTools(); return; }
      confirmClear = false;
      const d = defaultNotebook(), np = { order: d.order };
      for (const id of nb.order) if (!d.tabs[id]) np["t." + id] = null;
      for (const id of d.order) np["t." + id] = d.tabs[id];
      send(np); active = d.order[0]; render();
    }
  });
  el.addEventListener("change", e => {
    const s = e.target.closest("select[data-nb]"); if (!s || !s.value || !canEdit()) return;
    const v = s.value; s.value = "";
    if (s.dataset.nb === "preset") { setRange(PRESETS[v] || ""); return; }
    const S = opt.solver && opt.solver(); if (!S) return;
    const k = +v.slice(-1);
    if (v.startsWith("to")) {
      if (!tab().range.trim()) { if (opt.flash) opt.flash("This tab's range is blank"); return; }
      if (S.setRange(k, tab().range) && opt.flash) opt.flash(`The solver's ${k ? "in-position" : "out-of-position"} range is now the ${tab().name} range`);
    } else { setRange(S.ranges()[k] || ""); }
  });

  // painting: tap a cell to paint or erase it, drag to keep going
  let gw = null;
  gridEl.addEventListener("pointerdown", e => {
    const b = e.target.closest("[data-cell]"); if (!b || !canEdit()) return;
    e.preventDefault();
    const r = weights(tab()); gw = r.err ? new Float32Array(169) : r.w;
    const i = +b.dataset.cell;
    paint = { v: Math.abs(gw[i] - paintW) < 1e-6 ? 0 : paintW, seen: new Set() };
    paintCell(i);
  });
  function paintCell(i) {
    if (!paint || paint.seen.has(i)) return; paint.seen.add(i); gw[i] = paint.v;
    const c = gridEl.children[i]; if (c) c.querySelector(".fill").style.height = gw[i] * 100 + "%";
  }
  window.addEventListener("pointermove", e => {
    if (!paint) return;
    const x = document.elementFromPoint(e.clientX, e.clientY), b = x && x.closest && x.closest("[data-cell]");
    if (b && gridEl.contains(b)) paintCell(+b.dataset.cell);
  }, sig);
  const endPaint = () => { if (!paint) return; paint = null; setRange(formatRange(gw)); };
  window.addEventListener("pointerup", endPaint, sig); window.addEventListener("pointercancel", endPaint, sig);

  // the table moved to a new street: show that street's tab (unless someone is writing in the notes)
  let seenKey = "";
  function tableUpdate(P) {
    if (!P) return;
    const k2 = [P.hand, P.phase, (P.board || []).join(""), canEdit(), !!(opt.solver && opt.solver() && opt.solver().canEdit())].join("|");
    if (k2 === seenKey) return;
    seenKey = k2;
    const key = P.hand + "|" + P.phase;
    if (key !== lastStreet) {
      lastStreet = key;
      const want = { preflop: "preflop", flop: "flop", turn: "turn", river: "river" }[P.phase];
      const id = want && nb.order.find(i => nb.tabs[i].name.toLowerCase() === want);
      if (id && id !== active && !el.contains(document.activeElement) && !paint) active = id;
    }
    render();
  }

  render();
  return {
    onMessage, tableUpdate, refresh: render,
    get notebook() { return nb; },
    body: el.querySelector(".nbbody"), foot: el.querySelector(".nbfoot"),
    get active() { return active; },
    destroy() { ac.abort(); timers.forEach(t => clearTimeout(t)); },
  };
}
