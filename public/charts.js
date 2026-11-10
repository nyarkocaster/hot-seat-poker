// Preflop charts: the starting ranges everyone loads from "Load a starting range", and that the solver
// uses when it guesses ranges from the table. Teachers edit them (or add their own); students can read
// them. In a lobby the charts belong to the lobby and reach everyone in it; a teacher's edits are also
// kept on their device and brought into new lobbies they teach.
import { cellName, parseRange, formatRange, comboCount, PRESETS, DEFAULT_PRESETS, BUILTIN, applyCharts, chartOverlay, chartName, cleanCharts, deviceCharts, saveDeviceCharts } from "./solver/range.js";

const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GROUPS = [
  ["Opening", n => /^Open /.test(n)],
  ["Defending and calling", n => /^BB defend|^Flat|^Call /.test(n)],
  ["3-bets and 4-bets", n => /-bet range$/.test(n)],
  ["Other", () => true],
];

// opt.transport: {send(o), canEdit()} in a lobby (null when practising alone); opt.isTeacher(); opt.flash(msg)
export function createCharts(el, opt = {}) {
  const T = opt.transport || null;
  const canEdit = () => (T ? T.canEdit() : true);
  let sel = BUILTIN[0], draft = null, paintW = 1, paint = null, seeded = false, confirmDel = false;
  const ac = new AbortController(), sig = { signal: ac.signal };

  el.innerHTML = `
    <h2>Preflop charts</h2>
    <div class="pf">
      <nav class="pflist" aria-label="Charts"></nav>
      <div class="pfed">
        <div class="pfhead"></div>
        <div class="rlay">
          <div class="rlay-c">
            <div class="row paint pfpaint"><label for="pf-paintW">Tap paints</label><input type="range" id="pf-paintW" min="0" max="100" step="5" value="100"><span class="pfpw">100%</span></div>
            <label class="pflab" for="pf-text">Range text</label>
            <textarea id="pf-text" rows="3" spellcheck="false" maxlength="3000"></textarea>
            <p class="note pfcount"></p>
            <p class="err pferr" role="status"></p>
            <div class="row pfbtns"></div>
          </div>
          <div class="rgrid nbgrid pfgrid" data-anc="pfgrid" aria-label="Chart grid"></div>
        </div>
      </div>
    </div>
    <details class="pfio"><summary>Copy or paste charts</summary>
      <p class="note">One chart per line, like <code>Open BTN: 22+,A2s+,K9s+</code>. Copy them to keep a backup or to move them to another lobby.</p>
      <textarea class="pfiotext" rows="5" spellcheck="false"></textarea>
      <div class="row"><button class="b sm" type="button" data-pf="export">Show my charts here</button><button class="b sm" type="button" data-pf="import">Add these charts</button></div>
    </details>`;
  const q = s => el.querySelector(s);
  const gridEl = q(".pfgrid"), textEl = q("#pf-text");

  const isBuiltin = n => DEFAULT_PRESETS[n] !== undefined;
  const edited = n => isBuiltin(n) && chartOverlay()[n] !== undefined;
  function current() {
    if (draft) return draft;
    const t = PRESETS[sel] !== undefined ? PRESETS[sel] : "";
    return { name: sel, text: t, w: parseRange(t).w, err: "", isNew: false };
  }
  const dirty = () => !!draft && (draft.isNew || draft.text !== (PRESETS[draft.orig] || "") || draft.name !== draft.orig);

  // save: in a lobby, to the lobby (which tells everyone); always to this device too, for a teacher
  function commit(set) {
    const next = { ...chartOverlay() };
    for (const [k, v] of Object.entries(set)) { if (v === null) delete next[k]; else next[k] = v; }
    const clean = cleanCharts(next);
    if (T) T.send({ t: "pf", set });
    applyCharts(clean);
    if (!T || (opt.isTeacher && opt.isTeacher())) saveDeviceCharts(clean);
  }

  function renderList() {
    const names = Object.keys(PRESETS), custom = names.filter(n => !isBuiltin(n));
    const item = n => `<button type="button" class="pfitem${n === (draft ? draft.orig : sel) && !(draft && draft.isNew) ? " on" : ""}" data-pfsel="${esc(n)}">${esc(n)}${edited(n) ? ` <span class="pfmark" title="Edited by your teacher">edited</span>` : ""}</button>`;
    let h = "";
    const used = new Set();
    for (const [g, test] of GROUPS) {
      const list = BUILTIN.filter(n => !used.has(n) && test(n)); list.forEach(n => used.add(n));
      if (list.length) h += `<div class="pfgrp"><span class="pfgt">${g}</span>${list.map(item).join("")}</div>`;
    }
    h += `<div class="pfgrp"><span class="pfgt">Your charts</span>${custom.map(item).join("") || `<span class="note">None yet.</span>`}${canEdit() ? `<button type="button" class="b sm pfnew" data-pf="new">+ New chart</button>` : ""}</div>`;
    q(".pflist").innerHTML = h;
  }
  function renderEd(force) {
    const c = current(), ed = canEdit();
    const builtin = !c.isNew && isBuiltin(c.orig || c.name);
    q(".pfhead").innerHTML = ed && !builtin
      ? `<label class="pflab" for="pf-name">Name</label><input type="text" id="pf-name" maxlength="40" value="${esc(c.name)}" placeholder="Like “Open BTN, deep stacks”">`
      : `<h3 class="pfname">${esc(c.name)}</h3>${builtin ? `<p class="note">${edited(c.name) ? "Edited from the built-in chart. " : ""}The solver uses this chart when it guesses ranges from the table.</p>` : ""}`;
    if (!paint) {
      let h = "";
      for (let a = 0; a < 13; a++) for (let b = 0; b < 13; b++) {
        const i = a * 13 + b, v = c.w[i];
        h += `<button type="button" class="rc" data-cell="${i}" aria-label="${cellName(a, b)} ${Math.round(v * 100)}%"><div class="fill" style="height:${v * 100}%"></div><span>${cellName(a, b)}</span></button>`;
      }
      gridEl.innerHTML = h;
    }
    gridEl.classList.toggle("ro", !ed);
    if (force || document.activeElement !== textEl) textEl.value = c.text;
    textEl.readOnly = !ed;
    q(".pfpaint").hidden = !ed;
    const n = comboCount(c.w);
    q(".pfcount").textContent = n ? `${Math.round(n)} combos, ${Math.round((n / 1326) * 1000) / 10}% of all hands` : "Empty. Paint the grid or type a range.";
    q(".pferr").textContent = c.err || "";
    let b = "";
    if (ed) {
      if (dirty()) b += `<button class="b primary sm" type="button" data-pf="save">Save chart</button><button class="b sm" type="button" data-pf="cancel">Cancel</button>`;
      if (!draft && builtin && edited(c.name)) b += `<button class="b sm" type="button" data-pf="reset">Back to the built-in chart</button>`;
      if (!draft && !builtin && PRESETS[c.name] !== undefined) b += confirmDel ? `<span class="note">Delete “${esc(c.name)}”?</span><button class="b sm danger" type="button" data-pf="delyes">Delete</button><button class="b sm" type="button" data-pf="delno">Keep it</button>`
        : `<button class="b sm" type="button" data-pf="del">Delete chart</button>`;
      if (dirty()) b += `<span class="note">Not saved yet.</span>`;
    } else b = `<span class="note">Only your teacher can change charts. Load them into the solver, notes or stove from “Load a starting range”.</span>`;
    q(".pfbtns").innerHTML = b;
    q(".pfio").hidden = !ed;
  }
  function render(force) { renderList(); renderEd(force); }

  function startDraft() {
    if (draft) return draft;
    const c = current();
    draft = { name: c.name, orig: c.name, text: c.text, w: Float32Array.from(c.w), err: "", isNew: false };
    return draft;
  }
  function save() {
    const d = draft; if (!d) return;
    const name = chartName(d.name);
    if (!name) { d.err = "Give the chart a name."; renderEd(); return; }
    if (d.err) return;
    if (name !== d.orig && PRESETS[name] !== undefined) { d.err = `There's already a chart called “${name}”.`; renderEd(); return; }
    const set = {};
    if (!d.isNew && name !== d.orig && !isBuiltin(d.orig)) set[d.orig] = null; // renamed
    set[name] = isBuiltin(name) && d.text === DEFAULT_PRESETS[name] ? null : d.text;
    commit(set);
    sel = name; draft = null; render();
    if (opt.flash) opt.flash(T ? `Saved “${name}” for everyone in the lobby` : `Saved “${name}”`);
  }

  el.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.pfsel !== undefined) {
      if (dirty() && !confirm("Leave this chart without saving?")) return;
      sel = b.dataset.pfsel; draft = null; confirmDel = false; render(true); return;
    }
    const c = b.dataset.pf; if (!c || (!canEdit() && c !== "export")) return;
    if (c === "new") { if (dirty() && !confirm("Leave this chart without saving?")) return; draft = { name: "", orig: "", text: "", w: new Float32Array(169), err: "", isNew: true }; render(true); const n = q("#pf-name"); if (n) n.focus(); }
    else if (c === "save") save();
    else if (c === "cancel") { draft = null; render(true); }
    else if (c === "reset") { commit({ [sel]: null }); render(true); }
    else if (c === "del") { confirmDel = true; renderEd(); }
    else if (c === "delno") { confirmDel = false; renderEd(); }
    else if (c === "delyes") { const n = sel; commit({ [n]: null }); sel = BUILTIN[0]; confirmDel = false; render(true); if (opt.flash) opt.flash(`Deleted “${n}”`); }
    else if (c === "export") { const o = chartOverlay(); q(".pfiotext").value = Object.keys(o).map(k => `${k}: ${o[k]}`).join("\n") || "(No edited or custom charts yet.)"; }
    else if (c === "import") {
      const set = {}, bad = [];
      q(".pfiotext").value.split(/\n+/).forEach(line => {
        const m = line.match(/^\s*([^:]{1,40}?)\s*:\s*(.+)$/); if (!m) { if (line.trim() && !/^\(/.test(line.trim())) bad.push(line.trim()); return; }
        const r = parseRange(m[2]); if (r.err) { bad.push(m[1]); return; }
        set[chartName(m[1])] = formatRange(r.w);
      });
      if (!Object.keys(set).length) { if (opt.flash) opt.flash(bad.length ? "Couldn't read those lines. Use “Name: range”, one per line." : "Paste some charts first."); return; }
      commit(set); render(true);
      if (opt.flash) opt.flash(`Added ${Object.keys(set).length} chart${Object.keys(set).length === 1 ? "" : "s"}${bad.length ? `; skipped ${bad.length} line${bad.length === 1 ? "" : "s"} it couldn't read` : ""}`);
    }
  });
  el.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "pf-name") { startDraft().name = t.value; draft.err = ""; renderList(); renderBtns(); }
    else if (t === textEl) { const d = startDraft(); d.text = t.value; const r = parseRange(t.value); d.err = r.err; if (!r.err) d.w = r.w; renderEd(); }
    else if (t.id === "pf-paintW") { paintW = +t.value / 100; q(".pfpw").textContent = t.value + "%"; }
  });
  textEl.addEventListener("change", () => { if (draft && !draft.err) { draft.text = formatRange(draft.w); renderEd(); } });
  function renderBtns() { const keep = q("#pf-name"); const s = keep && keep.selectionStart; renderEd(); const n = q("#pf-name"); if (n && keep) { n.focus(); try { n.setSelectionRange(s, s); } catch (x) {} } }

  // painting, same as everywhere else: tap a cell to paint or erase it, drag to keep going
  gridEl.addEventListener("pointerdown", e => {
    const b = e.target.closest("[data-cell]"); if (!b || !canEdit()) return;
    e.preventDefault();
    const d = startDraft(), i = +b.dataset.cell;
    paint = { v: Math.abs(d.w[i] - paintW) < 1e-6 ? 0 : paintW, seen: new Set() };
    paintCell(i);
  });
  function paintCell(i) {
    if (!paint || paint.seen.has(i)) return; paint.seen.add(i); draft.w[i] = paint.v;
    const c = gridEl.children[i]; if (c) c.querySelector(".fill").style.height = draft.w[i] * 100 + "%";
  }
  window.addEventListener("pointermove", e => {
    if (!paint) return;
    const x = document.elementFromPoint(e.clientX, e.clientY), b = x && x.closest && x.closest("[data-cell]");
    if (b && gridEl.contains(b)) paintCell(+b.dataset.cell);
  }, sig);
  const endPaint = () => { if (!paint) return; paint = null; draft.text = formatRange(draft.w); draft.err = ""; renderEd(); renderList(); };
  window.addEventListener("pointerup", endPaint, sig); window.addEventListener("pointercancel", endPaint, sig);
  addEventListener("hsp-charts", () => { if (!draft && PRESETS[sel] === undefined) sel = BUILTIN[0]; if (!paint) render(); }, sig);

  // the lobby's charts arrived (on joining, and whenever a teacher saves)
  function onMessage(m) {
    if (!m || m.t !== "pf") return;
    const lobby = cleanCharts(m.charts);
    applyCharts(lobby);
    // a teacher's first visit to a lobby with no charts of its own: bring in the charts from this device
    if (!seeded && opt.isTeacher && opt.isTeacher()) {
      seeded = true;
      const mine = deviceCharts();
      if (!Object.keys(lobby).length && Object.keys(mine).length) { T.send({ t: "pf", set: mine }); applyCharts(mine); }
    }
  }
  render();
  return {
    onMessage, refresh: render,
    destroy() { ac.abort(); applyCharts(deviceCharts()); }, // back to this device's charts outside the lobby
  };
}
