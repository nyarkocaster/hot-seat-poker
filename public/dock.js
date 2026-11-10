// Movable panels ("palettes"). A palette has two columns of windows, each under a small title bar:
// drag the bar to move the window (within its column or to the other one), use the arrow keys on its
// grip, fold it, or make it bigger or smaller. A window can hold a palette of its own (the solver and
// the notes do), so its parts move around inside it. Layouts are saved on this device.
// Windows are moved, not copied, and go back where they came from when a palette is turned off.

const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4];

function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// units: [{id, title, sel:[css selectors], views?:[...]}]; defaults: {view: [[ids],[ids]]}
// key: storage prefix; opt.sub: a palette inside a window; opt.before: put the palette before this element
export function createPalette(host, units, defaults, key, opt = {}) {
  const dock = document.createElement("div");
  dock.className = "pal" + (opt.sub ? " sub" : ""); dock.hidden = true;
  if (opt.id) dock.id = opt.id;
  dock.innerHTML = `<div class="dcol" data-col="0"></div><div class="dcol" data-col="1"></div>`;
  if (opt.before && opt.before.parentNode === host) host.insertBefore(dock, opt.before); else host.appendChild(dock);
  const cols = [...dock.children];
  const wraps = new Map(); // unit id -> window element
  const homes = new Map(); // moved element -> placeholder comment at its original spot
  let view = null, onChange = null, zoom = {};

  const unitsFor = v => units.filter(u => !u.views || u.views.includes(v));
  const own = w => w && w.parentElement && w.parentElement.parentElement === dock;
  function layout(v) {
    const saved = lsGet(key + v), d = defaults[v], ok = new Set(unitsFor(v).map(u => u.id));
    let c = saved && Array.isArray(saved.cols) && saved.cols.length === 2 ? saved.cols.map(l => (Array.isArray(l) ? l.filter(id => ok.has(id)) : [])) : d.map(l => l.slice());
    const seen = new Set();
    c = c.map(l => l.filter(id => (seen.has(id) ? false : (seen.add(id), true))));
    d.forEach((l, k) => l.forEach(id => { if (!seen.has(id)) { c[k].push(id); seen.add(id); } })); // windows added later
    const z = saved && saved.zoom && typeof saved.zoom === "object" ? saved.zoom : {};
    return { cols: c, fold: new Set(saved && Array.isArray(saved.fold) ? saved.fold : []), zoom: z };
  }
  function save() {
    if (!view) return;
    const cur = { cols: cols.map(col => [...col.children].filter(w => w.dataset.dk).map(w => w.dataset.dk)), fold: [...wraps.values()].filter(w => w.classList.contains("fold")).map(w => w.dataset.dk), zoom };
    lsSet(key + view, cur);
    if (onChange) onChange();
  }
  function applyZoom(w) {
    const z = zoom[w.dataset.dk] || 1, b = w.querySelector(":scope > .dkb");
    b.style.zoom = z === 1 ? "" : String(z);
    const lab = w.querySelector(":scope > .dk-h .dk-z");
    if (lab) { lab.textContent = Math.round(z * 100) + "%"; lab.classList.toggle("on", z !== 1); }
    w.querySelector(":scope > .dk-h [data-z='-1']").disabled = z <= ZOOMS[0];
    w.querySelector(":scope > .dk-h [data-z='1']").disabled = z >= ZOOMS[ZOOMS.length - 1];
  }
  function wrapFor(u) {
    let w = wraps.get(u.id);
    if (w) return w;
    w = document.createElement("section");
    w.className = "dk" + (opt.sub ? " sub" : ""); w.dataset.dk = u.id;
    w.innerHTML = `<div class="dk-h"><button type="button" class="dk-grip" aria-label="Move the ${u.title} window. Drag, or use the arrow keys." title="Drag to move">⠿</button><span class="dk-t">${u.title}</span>
      <span class="dk-zoom" role="group" aria-label="Size of the ${u.title} window"><button type="button" class="dk-zb" data-z="-1" aria-label="Make ${u.title} smaller" title="Smaller">−</button><button type="button" class="dk-z" data-z="0" title="Back to 100%" aria-label="Reset the size of ${u.title}">100%</button><button type="button" class="dk-zb" data-z="1" aria-label="Make ${u.title} bigger" title="Bigger">+</button></span>
      <button type="button" class="dk-fold" aria-expanded="true" aria-label="Fold the ${u.title} window" title="Fold">▾</button></div><div class="dkb"></div>`;
    wraps.set(u.id, w);
    return w;
  }
  function gather(u, w) {
    const body = w.lastElementChild;
    u.sel.forEach(sel => {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel();
      if (!el || body.contains(el)) return;
      if (!homes.has(el)) { const ph = document.createComment("dock:" + sel); el.before(ph); homes.set(el, ph); }
      body.appendChild(el);
    });
    u.sel.forEach(sel => { const el = typeof sel === "string" ? body.querySelector(":scope > " + sel) : null; if (el) body.appendChild(el); });
  }

  // turn the palette on for a view, or off (null); safe to call on every render
  function set(v) {
    if (v !== view) {
      if (view) release();
      view = v;
      if (!v) return;
      const L = layout(v); zoom = { ...L.zoom };
      L.cols.forEach((ids, k) => ids.forEach(id => { const u = units.find(x => x.id === id); if (u) cols[k].appendChild(wrapFor(u)); }));
      wraps.forEach((w, id) => { const f = L.fold.has(id); w.classList.toggle("fold", f); w.querySelector(":scope > .dk-h .dk-fold").setAttribute("aria-expanded", String(!f)); applyZoom(w); });
      dock.hidden = false; if (opt.bodyClass) document.body.classList.add(opt.bodyClass);
    }
    if (!view) return;
    unitsFor(view).forEach(u => gather(u, wrapFor(u)));
  }
  function release() {
    homes.forEach((ph, el) => { if (ph.isConnected) ph.replaceWith(el); else el.remove(); });
    homes.clear();
    wraps.forEach(w => w.remove());
    dock.hidden = true; if (opt.bodyClass) document.body.classList.remove(opt.bodyClass);
    view = null;
  }
  function reset() { if (!view) return; const v = view; try { localStorage.removeItem(key + v); } catch (e) {} release(); set(v); if (onChange) onChange(); }

  /* ---------- dragging ---------- */
  let drag = null;
  const ph = document.createElement("div"); ph.className = "dk-ph";
  function placeAt(x, y) {
    const r0 = cols[0].getBoundingClientRect(), r1 = cols[1].getBoundingClientRect();
    const col = r1.top >= r0.bottom - 1 ? (y >= r1.top - 10 ? cols[1] : cols[0]) // stacked when there's no room for two
      : (x < (r0.right + r1.left) / 2 ? cols[0] : cols[1]);
    const items = [...col.children].filter(w => w !== drag.w && w !== ph && w.offsetParent !== null);
    const before = items.find(w => { const r = w.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (before) { if (ph.nextSibling !== before || ph.parentNode !== col) col.insertBefore(ph, before); }
    else if (ph.parentNode !== col || ph.nextSibling) col.appendChild(ph);
  }
  function scrollNear(y) {
    const m = 60, h = window.innerHeight;
    if (y < m) window.scrollBy(0, -Math.ceil((m - y) / 4)); else if (y > h - m) window.scrollBy(0, Math.ceil((y - (h - m)) / 4));
  }
  dock.addEventListener("pointerdown", e => {
    const hd = e.target.closest(".dk-h"); if (!hd || !own(hd.parentElement) || e.button > 0 || e.target.closest(".dk-fold,.dk-zoom")) return;
    e.stopPropagation();
    const w = hd.parentElement, r = w.getBoundingClientRect();
    e.preventDefault();
    drag = { w, id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, on: false, h: r.height, wd: r.width, from: [w.parentNode, w.nextSibling] };
    try { hd.setPointerCapture(e.pointerId); } catch (x) {}
  });
  dock.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
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
    if (e) e.stopPropagation();
    const d = drag; drag = null;
    if (!d.on) return;
    d.w.removeAttribute("style"); d.w.classList.remove("lift"); document.body.classList.remove("dragging");
    if (cancel || !ph.parentNode) { d.from[0].insertBefore(d.w, d.from[1]); ph.remove(); return; }
    ph.replaceWith(d.w); save();
    d.w.querySelector(":scope > .dk-h .dk-grip").focus({ preventScroll: true });
  }
  dock.addEventListener("pointerup", e => endDrag(e, false));
  dock.addEventListener("pointercancel", e => endDrag(e, true));
  window.addEventListener("keydown", e => { if (e.key === "Escape" && drag) endDrag(null, true); });

  /* ---------- keyboard moves, folding and size ---------- */
  dock.addEventListener("keydown", e => {
    const g = e.target.closest(".dk-grip"); if (!g) return;
    const w = g.closest(".dk"); if (!own(w)) return;
    const col = w.parentNode, k = cols.indexOf(col);
    if (e.key === "ArrowUp" && w.previousElementSibling) col.insertBefore(w, w.previousElementSibling);
    else if (e.key === "ArrowDown" && w.nextElementSibling) col.insertBefore(w.nextElementSibling, w);
    else if ((e.key === "ArrowLeft" && k === 1) || (e.key === "ArrowRight" && k === 0)) cols[1 - k].appendChild(w);
    else return;
    e.preventDefault(); e.stopPropagation(); g.focus(); save();
  });
  dock.addEventListener("click", e => {
    const b = e.target.closest(".dk-fold,.dk-zoom button"); if (!b) return;
    const w = b.closest(".dk"); if (!own(w)) return;
    e.stopPropagation();
    if (b.classList.contains("dk-fold")) {
      const f = !w.classList.contains("fold");
      w.classList.toggle("fold", f); b.setAttribute("aria-expanded", String(!f)); b.setAttribute("aria-label", (f ? "Unfold" : "Fold") + " the " + w.querySelector(".dk-t").textContent + " window");
    } else {
      const id = w.dataset.dk, cur = zoom[id] || 1, d = +b.dataset.z;
      let i = ZOOMS.findIndex(z => Math.abs(z - cur) < 0.001); if (i < 0) i = ZOOMS.indexOf(1);
      const nz = d === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))];
      if (nz === 1) delete zoom[id]; else zoom[id] = nz;
      applyZoom(w);
    }
    save();
  });

  return {
    set, release, reset,
    get view() { return view; },
    set onChange(fn) { onChange = fn; },
    order: () => cols.map(c => [...c.children].map(w => w.dataset.dk).filter(Boolean)),
    el: dock,
  };
}

/* the page's main layout (Side by side and Solver views) */
const UNITS = [
  { id: "table", title: "Table", sel: ["#table", "#actPanel", "#solvePanel"], views: ["both"] },
  { id: "log", title: "Hand log", sel: ["#logPanel"], views: ["both"] },
  { id: "side", title: "Seats & setup", sel: ["#side"], views: ["both"] },
  { id: "solver", title: "Solver", sel: ["#svPal"] },
  { id: "notes", title: "Notes", sel: ["#notesPanel"] },
  { id: "odds", title: "Odds calculator", sel: ["#oddsPanel"] },
  { id: "stove", title: "Poker stove", sel: ["#stovePanel"] },
];
const DEFAULTS = {
  both: [["table", "odds", "stove", "log", "side"], ["solver", "notes"]],
  solver: [["solver"], ["notes", "odds", "stove"]],
};
export function createDock(host) {
  const p = createPalette(host, UNITS, DEFAULTS, "hsp-dock2-", { id: "dock", bodyClass: "docked" });
  return p;
}

/* inside the Solver window: its parts */
export const SOLVER_PARTS = [
  { id: "spot", title: "Spot", sel: ["#sv-bar", "#sv-pSpot"] },
  { id: "range", title: "Ranges", sel: ["#sv-pRange"] },
  { id: "sizes", title: "Bet sizes", sel: ["#sv-pSizes"] },
  { id: "run", title: "Solve", sel: ["#sv-pRun"] },
  { id: "res", title: "Results", sel: ["#sv-pRes"] },
];
export const solverPalette = host => createPalette(host, SOLVER_PARTS, { main: [["spot", "range", "sizes", "run"], ["res"]] }, "hsp-pal-sv-", { sub: true });
/* inside the Notes window */
export const notesPalette = (host, before) => createPalette(host, [
  { id: "nbtext", title: "Writing", sel: [() => host.querySelector(".nb-pText")] },
  { id: "nbrange", title: "Range", sel: [() => host.querySelector(".nb-pRange")] },
], { main: [["nbtext"], ["nbrange"]] }, "hsp-pal-nb-", { sub: true, before });
