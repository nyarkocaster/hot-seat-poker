// Mini table: like a video app's mini player. When the table scrolls out of view (or another view hides it),
// the table and the action bar move into a small floating window you can drag anywhere, tap to go back to,
// or close. They move back into place as soon as their home is on screen again.
const KEY = "hsp-mini";
// the table is laid out at this width and scaled to fit the window, so it shrinks like a picture instead of piling up
const BASE = 640, MINW = 240;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } };
const save = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };

export function createMini({ active, label, goHome, isMyTurn, onToggle }) {
  const pref = Object.assign({ on: true, big: false, min: false, x: null, y: null, w: null }, load());
  const ids = ["table", "actPanel"];
  const box = document.createElement("div");
  box.id = "miniTable"; box.className = "mini"; box.hidden = true;
  box.setAttribute("role", "region"); box.setAttribute("aria-label", "Mini table");
  box.innerHTML = `<div class="minibar" data-mini="drag" title="Drag to move">
      <span class="minigrip" aria-hidden="true">⋮⋮</span><span class="minittl"></span>
      <button type="button" class="minib" data-mini="size" aria-label="Show all the action buttons"></button>
      <button type="button" class="minib" data-mini="min"></button>
      <button type="button" class="minib" data-mini="home" aria-label="Back to the table" title="Back to the table">⤢</button>
      <button type="button" class="minib" data-mini="close" aria-label="Close the mini table" title="Close (it comes back next time you scroll away)">×</button>
    </div><div class="minibody"></div><div class="minisz" data-mini="resize" title="Drag to resize" aria-hidden="true"></div>`;
  document.body.appendChild(box);
  const body = box.querySelector(".minibody"), ttl = box.querySelector(".minittl");
  let floating = false, dismissed = false, holders = [];

  const homeEl = () => floating ? holders[0] : document.getElementById("table");
  // how much of the table's spot is on screen. It pops out below one amount and back in only above a larger
  // one, so a page that shifts a little (a solve in progress redraws it many times a second) can't flip it back and forth
  function homeVisible() {
    const h = homeEl(); if (!h || !h.isConnected || h.offsetParent === null) return false;
    const r = h.getBoundingClientRect(), vh = innerHeight || 800;
    const seen = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    const out = Math.min(r.height * 0.3, 140), back = Math.min(r.height * 0.55, 260);
    return seen > (floating ? back : out);
  }
  function float() {
    if (floating) return;
    holders = ids.map(id => {
      const el = document.getElementById(id); const ph = document.createElement("div");
      ph.className = "minihome"; ph.dataset.for = id;
      // the placeholder takes exactly the table's space, margins included, so nothing on the page moves
      if (el && el.offsetParent !== null) { const cs = getComputedStyle(el); ph.style.height = el.offsetHeight + "px"; ph.style.marginTop = cs.marginTop; ph.style.marginBottom = cs.marginBottom; }
      else ph.style.height = "0px";
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
    box.classList.toggle("min", !!pref.min);
    const mb = box.querySelector('[data-mini="min"]');
    mb.textContent = pref.min ? "▴" : "▁"; const mt = pref.min ? "Open the mini table" : "Minimize to a bar"; mb.setAttribute("aria-label", mt); mb.title = mt;
    mb.setAttribute("aria-expanded", String(!pref.min));
    if (pref.min && isMyTurn && isMyTurn()) ttl.textContent = "Your turn · " + ttl.textContent;
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
      : { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId, sx: e.clientX, sy: e.clientY };
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
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = !drag.resize && e.type === "pointerup" && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5;
    if (tap && pref.min) { drag = null; box.classList.remove("dragging"); setMin(false); return; }
    drag = null; box.classList.remove("dragging"); const r = box.getBoundingClientRect(); pref.x = r.left; pref.y = r.top; save(pref); };
  box.addEventListener("pointerup", endDrag); box.addEventListener("pointercancel", endDrag);
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-mini]"); if (!b || b.dataset.mini === "drag") return;
    const c = b.dataset.mini;
    if (c === "close") { dismissed = true; dock(); offerOff(); }
    else if (c === "min") setMin(!pref.min);
    else if (c === "size") { pref.big = !pref.big; save(pref); sync(); place(); }
    else if (c === "home") {
      const ph = holders[0];
      if (ph && ph.offsetParent === null && goHome) goHome(); // the table is in a hidden view: show it
      requestAnimationFrame(() => { const h = homeEl(); if (h) h.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); });
    }
  });
  function setMin(v) {
    // keep the bar where it is: shrink up from the bottom edge, grow back the same way
    const r = box.getBoundingClientRect(); pref.min = !!v; sync();
    const r2 = box.getBoundingClientRect(); pref.x = r.left; pref.y = r.bottom - r2.height; place(); save(pref);
  }
  // after ×: offer to stop the pop-out for good (also in Tools → Mini table)
  let toast = null, toastT = 0;
  function offerOff() {
    if (!toast) {
      toast = document.createElement("div"); toast.className = "minitoast"; toast.setAttribute("role", "status");
      toast.addEventListener("click", e => {
        const b = e.target.closest("[data-x]"); if (!b) return;
        if (b.dataset.x === "off") {
          pref.on = false; save(pref); if (onToggle) onToggle(false);
          toast.innerHTML = `<span>Mini table off. Turn it back on in Tools → Mini table.</span>`;
          clearTimeout(toastT); toastT = setTimeout(() => { toast.hidden = true; }, 4000);
        } else toast.hidden = true;
      });
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>Mini table closed. It comes back when you scroll away again.</span><button type="button" class="b sm" data-x="off">Turn it off</button><button type="button" class="minib" data-x="hide" aria-label="Dismiss">×</button>`;
    toast.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { toast.hidden = true; }, 7000);
  }
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
