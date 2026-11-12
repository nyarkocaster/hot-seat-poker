// Mini table: like a video app's mini player. When the table scrolls out of view (or another view hides it),
// the table and the action bar move into a small floating window you can drag anywhere, tap to go back to,
// or close. They move back into place as soon as their home is on screen again.
const KEY = "hsp-mini";
// the table is laid out at this width and scaled to fit the window, so it shrinks like a picture instead of piling up
const BASE = 640, MINW = 240;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } };
const save = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };

export function createMini({ active, label, goHome, isMyTurn }) {
  const pref = Object.assign({ on: true, big: false, x: null, y: null, w: null }, load());
  const ids = ["table", "actPanel"];
  const box = document.createElement("div");
  box.id = "miniTable"; box.className = "mini"; box.hidden = true;
  box.setAttribute("role", "region"); box.setAttribute("aria-label", "Mini table");
  box.innerHTML = `<div class="minibar" data-mini="drag" title="Drag to move">
      <span class="minigrip" aria-hidden="true">⋮⋮</span><span class="minittl"></span>
      <button type="button" class="minib" data-mini="size" aria-label="Show all the action buttons"></button>
      <button type="button" class="minib" data-mini="home" aria-label="Back to the table" title="Back to the table">⤢</button>
      <button type="button" class="minib" data-mini="close" aria-label="Close the mini table" title="Close (it comes back next time you scroll away)">×</button>
    </div><div class="minibody"></div><div class="minisz" data-mini="resize" title="Drag to resize" aria-hidden="true"></div>`;
  document.body.appendChild(box);
  const body = box.querySelector(".minibody"), ttl = box.querySelector(".minittl");
  let floating = false, dismissed = false, holders = [];

  const homeEl = () => floating ? holders[0] : document.getElementById("table");
  // is the table's spot in the page on screen?
  function homeVisible() {
    const h = homeEl(); if (!h || !h.isConnected || h.offsetParent === null) return false;
    const r = h.getBoundingClientRect(), vh = innerHeight || 800;
    const seen = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return seen > Math.min(r.height * 0.35, 160);
  }
  function float() {
    if (floating) return;
    holders = ids.map(id => {
      const el = document.getElementById(id); const ph = document.createElement("div");
      ph.className = "minihome"; ph.dataset.for = id;
      ph.style.height = el && el.offsetParent !== null ? el.offsetHeight + "px" : "0px";
      if (el) { el.before(ph); body.appendChild(el); }
      return ph;
    });
    floating = true; box.hidden = false; place(); sync();
  }
  function dock() {
    if (!floating) return;
    ids.forEach((id, k) => { const el = document.getElementById(id), ph = holders[k]; if (el && ph && ph.isConnected) ph.replaceWith(el); else if (ph) ph.remove(); });
    holders = []; floating = false; box.hidden = true;
  }
  function check() {
    if (!active() || !pref.on) { dock(); return; }
    const vis = homeVisible();
    if (vis) { dismissed = false; dock(); return; }
    if (!dismissed) float(); else dock();
    if (floating) sync();
  }
  function sync() {
    ttl.textContent = label() || "Table";
    box.classList.toggle("big", !!pref.big);
    box.classList.toggle("turn", !!(isMyTurn && isMyTurn()));
    const sb = box.querySelector('[data-mini="size"]');
    sb.textContent = pref.big ? "−" : "⋯"; const t = pref.big ? "Fewer buttons" : "All the action buttons (bet sizes, undo…)"; sb.setAttribute("aria-label", t); sb.title = t;
    fit();
  }
  const maxW = () => Math.max(MINW, Math.min(1000, innerWidth - 16));
  const defW = () => Math.min(innerWidth <= 600 ? 320 : 440, maxW());
  // scale the table to the window's width
  function fit() {
    const w = Math.max(MINW, Math.min(pref.w || defW(), maxW()));
    box.style.width = w + "px";
    box.style.setProperty("--mz", ((w - 16) / BASE).toFixed(4));
    box.classList.toggle("right", box.getBoundingClientRect().left + w / 2 > innerWidth / 2);
  }
  // keep it on screen; default to the bottom-right corner
  function place() {
    fit();
    const w = box.offsetWidth || 360, h = box.offsetHeight || 260, m = 8;
    let x = pref.x, y = pref.y;
    if (x == null || y == null) { x = innerWidth - w - 16; y = innerHeight - h - 16; }
    x = Math.max(m, Math.min(x, innerWidth - w - m)); y = Math.max(m, Math.min(y, innerHeight - Math.min(h, 120) - m));
    box.style.left = x + "px"; box.style.top = y + "px";
  }
  // drag by the title bar
  let drag = null;
  box.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    const sz = e.target.closest('[data-mini="resize"]');
    const bar = e.target.closest('[data-mini="drag"]');
    if (!sz && (!bar || e.target.closest("button"))) return;
    const r = box.getBoundingClientRect();
    drag = sz ? { resize: box.classList.contains("right") ? "l" : "r", x0: e.clientX, w0: r.width, left0: r.left, id: e.pointerId }
      : { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    (sz || bar).setPointerCapture(e.pointerId); box.classList.add("dragging"); e.preventDefault();
  });
  box.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.resize) {
      // the grip sits on the corner away from the screen edge; the opposite edge stays put
      const dx = e.clientX - drag.x0, w = Math.max(MINW, Math.min(maxW(), drag.w0 + (drag.resize === "l" ? -dx : dx)));
      pref.w = w; pref.x = drag.resize === "l" ? drag.left0 + drag.w0 - w : drag.left0;
      fit(); box.style.left = Math.max(8, pref.x) + "px"; return;
    }
    pref.x = e.clientX - drag.dx; pref.y = e.clientY - drag.dy; place();
  });
  const endDrag = e => { if (!drag || e.pointerId !== drag.id) return; drag = null; box.classList.remove("dragging"); const r = box.getBoundingClientRect(); pref.x = r.left; pref.y = r.top; save(pref); };
  box.addEventListener("pointerup", endDrag); box.addEventListener("pointercancel", endDrag);
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-mini]"); if (!b || b.dataset.mini === "drag") return;
    const c = b.dataset.mini;
    if (c === "close") { dismissed = true; dock(); }
    else if (c === "size") { pref.big = !pref.big; save(pref); sync(); place(); }
    else if (c === "home") {
      const ph = holders[0];
      if (ph && ph.offsetParent === null && goHome) goHome(); // the table is in a hidden view: show it
      requestAnimationFrame(() => { const h = homeEl(); if (h) h.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); });
    }
  });
  let raf = 0;
  const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; check(); }); };
  addEventListener("scroll", soon, { passive: true, capture: true });
  addEventListener("resize", () => { soon(); if (floating) place(); });
  // when the table redraws its size changes; keep its spot the same height so the page doesn't jump
  return {
    check: soon,
    sync: () => { if (floating) { sync(); holders.forEach(ph => { if (ph.dataset.for === "table" && ph.offsetParent !== null && ph.offsetHeight < 50) { const w = ph.parentElement.clientWidth; ph.style.height = Math.round(w * 11 / 16) + "px"; } }); } },
    setOn: v => { pref.on = !!v; save(pref); check(); },
    isOn: () => pref.on,
    floating: () => floating,
  };
}
