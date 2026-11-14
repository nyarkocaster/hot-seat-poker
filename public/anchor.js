// Keeps what you're looking at still while parts of the page redraw.
// Browsers do this themselves ("scroll anchoring"), but it breaks when a panel's contents are replaced wholesale
// (the element they were holding on to is gone), so a street change could jolt the page by hundreds of pixels,
// and the mini table could flick in and out. Here we hold on to a stable panel near the top of the screen and,
// whenever anything changes size, scroll by however much that panel moved, before the change is drawn.
export function createAnchor({ root = document, sel, skip }) {
  document.documentElement.style.overflowAnchor = "none"; // ours instead of the browser's, so they don't fight
  let anchor = null, anchorTop = 0, paused = 0, fixing = false, corrected = 0;
  // with two columns side by side, hold still the one you're using: the side your pointer was last on
  let px = null;
  addEventListener("pointermove", e => { px = e.clientX; }, { passive: true });
  addEventListener("pointerdown", e => { px = e.clientX; }, { passive: true });
  const candidates = () => [...root.querySelectorAll(sel)].filter(e => e.offsetParent !== null && !(skip && skip(e)));
  // the block starting closest above the middle of the screen (where you're most likely reading); changes above it
  // are absorbed, so what's around the middle stays still. Failing that, the block the middle of the screen is inside.
  function pick() {
    const line = innerHeight * 0.45, x = px == null ? innerWidth * 0.3 : px;
    let best = null, bestTop = -Infinity, cover = null, coverTop = -Infinity;
    const all = candidates(), inCol = all.filter(e => { const r = e.getBoundingClientRect(); return r.left <= x && r.right >= x; });
    for (const e of inCol.length ? inCol : all) {
      const r = e.getBoundingClientRect();
      if (r.height < 1 || r.bottom <= 0 || r.top >= innerHeight) continue;
      if (r.top >= 0 && r.top <= line) { if (r.top >= bestTop) { best = e; bestTop = r.top; } }
      else if (r.top < 0 && r.top >= coverTop) { cover = e; coverTop = r.top; }
    }
    if (!best && !cover) for (const e of candidates()) { const r = e.getBoundingClientRect(); if (r.top >= 0 && r.top < innerHeight && r.height >= 1) { best = e; break; } }
    anchor = best || cover; anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  }
  function fix() {
    if (fixing) return;
    // the anchor itself went somewhere else (a different view, or into the mini table): just choose again
    if (!anchor || !anchor.isConnected || anchor.offsetParent === null || (skip && skip(anchor))) { pick(); return; }
    if (Date.now() < paused) { pick(); return; }
    const d = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(d) >= 1) { const y0 = scrollY; fixing = true; scrollBy(0, d); fixing = false; corrected += scrollY - y0; }
    pick();
  }
  const ro = new ResizeObserver(() => fix());
  let watched = new Set();
  // watch every stable panel (they come and go as tools open and views change)
  function rewatch() {
    const now = new Set(candidates());
    for (const e of watched) if (!now.has(e)) ro.unobserve(e);
    for (const e of now) if (!watched.has(e)) ro.observe(e);
    watched = now;
  }
  addEventListener("scroll", () => { if (!fixing) pick(); }, { passive: true });
  addEventListener("resize", pick);
  rewatch(); pick();
  window.__anchor = () => anchor; // for tests
  return {
    // call after the page has been redrawn: picks up new panels and corrects anything the redraw moved
    after() { rewatch(); fix(); },
    pick,
    // total scrolling done by corrections (not by you), so others can tell the two apart
    corrected: () => corrected,
    // let a deliberate scroll (like "back to the table") finish without being corrected
    pause(ms) { paused = Date.now() + ms; },
  };
}
