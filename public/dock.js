// Movable panels. In the Side by side and Solver views every panel sits in one of two columns
// under a small title bar: drag the bar to move the panel (to another spot or the other column),
// use the arrow keys on its grip, or fold it. Each view's layout is saved on this device.
// Panels are moved, not copied, and go back where they came from when the layout is turned off.

const UNITS = [
  { id: "table", title: "Table", sel: ["#table", "#actPanel", "#solvePanel"], views: ["both"] },
  { id: "log", title: "Hand log", sel: ["#logPanel"], views: ["both"] },
  { id: "side", title: "Seats & setup", sel: ["#side"], views: ["both"] },
  { id: "svspot", title: "Spot", sel: ["#sv-bar", "#sv-pSpot"] },
  { id: "svrange", title: "Ranges", sel: ["#sv-pRange"] },
  { id: "svsizes", title: "Bet sizes", sel: ["#sv-pSizes"] },
  { id: "svrun", title: "Solve", sel: ["#sv-pRun"] },
  { id: "svres", title: "Results", sel: ["#sv-pRes"] },
  { id: "notes", title: "Notes", sel: ["#notesPanel"] },
  { id: "odds", title: "Odds calculator", sel: ["#oddsPanel"] },
  { id: "stove", title: "Poker stove", sel: ["#stovePanel"] },
];
const DEFAULTS = {
  both: [["table", "odds", "stove", "log", "side"], ["svspot", "svrange", "svsizes", "svrun", "svres", "notes"]],
  solver: [["svspot", "svrange", "svsizes", "svrun", "odds", "stove"], ["svres", "notes"]],
};

function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

export function createDock(host) {
  const dock = document.createElement("div");
  dock.id = "dock"; dock.hidden = true;
  dock.innerHTML = `<div class="dcol" data-col="0"></div><div class="dcol" data-col="1"></div>`;
  host.appendChild(dock);
  const cols = [...dock.children];
  const wraps = new Map(); // unit id -> wrapper element
  const homes = new Map(); // moved element -> placeholder comment at its original spot
  let view = null, onChange = null;

  const unitsFor = v => UNITS.filter(u => !u.views || u.views.includes(v));
  function layout(v) {
    const saved = lsGet("hsp-dock-" + v), d = DEFAULTS[v], ok = new Set(unitsFor(v).map(u => u.id));
    let c = saved && Array.isArray(saved.cols) && saved.cols.length === 2 ? saved.cols.map(l => (Array.isArray(l) ? l.filter(id => ok.has(id)) : [])) : d.map(l => l.slice());
    const seen = new Set();
    c = c.map(l => l.filter(id => (seen.has(id) ? false : (seen.add(id), true))));
    d.forEach((l, k) => l.forEach(id => { if (!seen.has(id)) { c[k].push(id); seen.add(id); } })); // panels added later
    return { cols: c, fold: new Set(saved && Array.isArray(saved.fold) ? saved.fold : []) };
  }
  function save() {
    if (!view) return;
    const cur = { cols: cols.map(col => [...col.children].filter(w => w.dataset.dk).map(w => w.dataset.dk)), fold: [...wraps.values()].filter(w => w.classList.contains("fold")).map(w => w.dataset.dk) };
    lsSet("hsp-dock-" + view, cur);
    if (onChange) onChange();
  }
  function wrapFor(u) {
    let w = wraps.get(u.id);
    if (w) return w;
    w = document.createElement("section");
    w.className = "dk"; w.dataset.dk = u.id;
    w.innerHTML = `<div class="dk-h"><button type="button" class="dk-grip" aria-label="Move the ${u.title} panel. Drag, or use the arrow keys." title="Drag to move">⠿</button><span class="dk-t">${u.title}</span><button type="button" class="dk-fold" aria-expanded="true" aria-label="Fold the ${u.title} panel" title="Fold">▾</button></div><div class="dkb"></div>`;
    wraps.set(u.id, w);
    return w;
  }
  function gather(u, w) {
    const body = w.lastElementChild;
    u.sel.forEach(sel => {
      const el = document.querySelector(sel);
      if (!el || body.contains(el)) return;
      if (!homes.has(el)) { const ph = document.createComment("dock:" + sel); el.before(ph); homes.set(el, ph); }
      body.appendChild(el);
    });
    // keep the parts in the order they're listed
    u.sel.forEach(sel => { const el = body.querySelector(":scope > " + sel); if (el) body.appendChild(el); });
  }

  // turn the layout on for a view ("both" or "solver"), or off (null); safe to call on every render
  function set(v) {
    if (v !== view) {
      if (view) release();
      view = v;
      if (!v) return;
      const L = layout(v);
      L.cols.forEach((ids, k) => ids.forEach(id => { const u = UNITS.find(x => x.id === id); if (u) cols[k].appendChild(wrapFor(u)); }));
      wraps.forEach((w, id) => { const f = L.fold.has(id); w.classList.toggle("fold", f); w.querySelector(".dk-fold").setAttribute("aria-expanded", String(!f)); });
      dock.hidden = false; document.body.classList.add("docked");
    }
    if (!view) return;
    unitsFor(view).forEach(u => gather(u, wrapFor(u)));
  }
  // put every panel back where it came from
  function release() {
    homes.forEach((ph, el) => { if (ph.isConnected) ph.replaceWith(el); else el.remove(); });
    homes.clear();
    wraps.forEach(w => w.remove());
    dock.hidden = true; document.body.classList.remove("docked");
    view = null;
  }
  function reset() { if (!view) return; const v = view; try { localStorage.removeItem("hsp-dock-" + v); } catch (e) {} release(); set(v); if (onChange) onChange(); }

  /* ---------- dragging ---------- */
  let drag = null;
  const ph = document.createElement("div"); ph.className = "dk-ph";
  function placeAt(x, y) {
    const r0 = cols[0].getBoundingClientRect(), r1 = cols[1].getBoundingClientRect();
    const col = r1.top >= r0.bottom - 1 ? (y >= r1.top - 10 ? cols[1] : cols[0]) // stacked on small screens
      : (x < (r0.right + r1.left) / 2 ? cols[0] : cols[1]);
    const items = [...col.children].filter(w => w !== drag.w && w !== ph);
    const before = items.find(w => { const r = w.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (before) { if (ph.nextSibling !== before || ph.parentNode !== col) col.insertBefore(ph, before); }
    else if (ph.parentNode !== col || ph.nextSibling) col.appendChild(ph);
  }
  function scrollNear(y) {
    const m = 60, h = window.innerHeight;
    if (y < m) window.scrollBy(0, -Math.ceil((m - y) / 4)); else if (y > h - m) window.scrollBy(0, Math.ceil((y - (h - m)) / 4));
  }
  dock.addEventListener("pointerdown", e => {
    const hd = e.target.closest(".dk-h"); if (!hd || e.button > 0 || e.target.closest(".dk-fold")) return;
    const w = hd.parentElement, r = w.getBoundingClientRect();
    e.preventDefault();
    drag = { w, id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, on: false, h: r.height, wd: r.width, from: [w.parentNode, w.nextSibling] };
    try { hd.setPointerCapture(e.pointerId); } catch (x) {}
  });
  dock.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.on = true;
      ph.style.height = Math.min(drag.h, 240) + "px";
      drag.w.before(ph);
      Object.assign(drag.w.style, { position: "fixed", width: drag.wd + "px", zIndex: 60, pointerEvents: "none", maxHeight: "60vh", overflow: "hidden" });
      drag.w.classList.add("lift"); document.body.classList.add("dragging");
    }
    drag.w.style.left = e.clientX - drag.dx + "px"; drag.w.style.top = e.clientY - Math.min(drag.dy, 20) + "px";
    placeAt(e.clientX, e.clientY); scrollNear(e.clientY);
  });
  function endDrag(e, cancel) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    if (!d.on) return;
    d.w.removeAttribute("style"); d.w.classList.remove("lift"); document.body.classList.remove("dragging");
    if (cancel || !ph.parentNode) { d.from[0].insertBefore(d.w, d.from[1]); ph.remove(); return; }
    ph.replaceWith(d.w); save();
    d.w.querySelector(".dk-grip").focus({ preventScroll: true });
  }
  dock.addEventListener("pointerup", e => endDrag(e, false));
  dock.addEventListener("pointercancel", e => endDrag(e, true));
  window.addEventListener("keydown", e => { if (e.key === "Escape" && drag) endDrag(null, true); });

  /* ---------- keyboard moves and folding ---------- */
  dock.addEventListener("keydown", e => {
    const g = e.target.closest(".dk-grip"); if (!g) return;
    const w = g.closest(".dk"), col = w.parentNode, k = cols.indexOf(col);
    if (e.key === "ArrowUp" && w.previousElementSibling) col.insertBefore(w, w.previousElementSibling);
    else if (e.key === "ArrowDown" && w.nextElementSibling) col.insertBefore(w.nextElementSibling, w);
    else if ((e.key === "ArrowLeft" && k === 1) || (e.key === "ArrowRight" && k === 0)) cols[1 - k].appendChild(w);
    else return;
    e.preventDefault(); g.focus(); save();
  });
  dock.addEventListener("click", e => {
    const b = e.target.closest(".dk-fold"); if (!b) return;
    const w = b.closest(".dk"), f = !w.classList.contains("fold");
    w.classList.toggle("fold", f); b.setAttribute("aria-expanded", String(!f)); b.setAttribute("aria-label", (f ? "Unfold" : "Fold") + " the " + w.querySelector(".dk-t").textContent + " panel");
    save();
  });

  return {
    set, release, reset,
    get view() { return view; },
    set onChange(fn) { onChange = fn; },
    order: () => cols.map(c => [...c.children].map(w => w.dataset.dk).filter(Boolean)),
  };
}
