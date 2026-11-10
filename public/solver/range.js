// Hand ranges for the solver page: a 13x13 grid model, a parser and a formatter for the
// usual range text ("22+,A2s+,KTo+,A5s:0.5"), and starting-point presets by position.
// Grid cell (r, c), with 0 = ace .. 12 = deuce: r == c is a pair, r < c suited, r > c offsuit.

export const RK = "AKQJT98765432";
export const cellName = (r, c) => r === c ? RK[r] + RK[c] : r < c ? RK[r] + RK[c] + "s" : RK[c] + RK[r] + "o";
export const cellCombos = (r, c) => r === c ? 6 : r < c ? 4 : 12;
const idx = ch => RK.indexOf(ch.toUpperCase());

// Hands of one token, as a list of [r, c] cells. Throws a message on bad input.
function expand(tok) {
  const one = s => {
    const m = /^([AKQJT2-9])([AKQJT2-9])([so]?)$/i.exec(s);
    if (!m) {
      if (/^([AKQJT2-9][cdhs]){2}$/i.test(s)) throw `“${s}”: single card combos can't be shown in the grid; use hand classes like AKs`;
      throw `“${s}” isn't a hand (examples: QQ, AKs, KTo)`;
    }
    let a = idx(m[1]), b = idx(m[2]); const su = m[3].toLowerCase();
    if (a === b) { if (su) throw `“${s}”: a pair can't be suited or offsuit`; return { hi: a, lo: a, su: "p" }; }
    if (a > b) [a, b] = [b, a];
    return { hi: a, lo: b, su: su || "b" };
  };
  const cells = (h) => h.su === "p" ? [[h.hi, h.hi]] : h.su === "s" ? [[h.hi, h.lo]] : h.su === "o" ? [[h.lo, h.hi]] : [[h.hi, h.lo], [h.lo, h.hi]];
  const out = [];
  if (tok.endsWith("+")) {
    const h = one(tok.slice(0, -1));
    if (h.su === "p") for (let r = h.hi; r >= 0; r--) out.push([r, r]);
    else if (h.lo - h.hi === 1) for (let k = 0; h.hi - k >= 0; k++) out.push(...cells({ hi: h.hi - k, lo: h.lo - k, su: h.su }));
    else for (let lo = h.lo; lo > h.hi; lo--) out.push(...cells({ hi: h.hi, lo, su: h.su }));
    return out;
  }
  if (tok.includes("-")) {
    const [x, y] = tok.split("-").map(one);
    if (x.su !== y.su) throw `“${tok}”: both ends need the same type`;
    if (x.su === "p") { for (let r = Math.min(x.hi, y.hi); r <= Math.max(x.hi, y.hi); r++) out.push([r, r]); return out; }
    if (x.hi === y.hi) { for (let lo = Math.min(x.lo, y.lo); lo <= Math.max(x.lo, y.lo); lo++) out.push(...cells({ hi: x.hi, lo, su: x.su })); return out; }
    if (x.lo - x.hi !== y.lo - y.hi) throw `“${tok}”: use the same top card (A9s-A6s) or the same gap (98s-65s)`;
    const g = x.lo - x.hi;
    for (let hi = Math.min(x.hi, y.hi); hi <= Math.max(x.hi, y.hi); hi++) out.push(...cells({ hi, lo: hi + g, su: x.su }));
    return out;
  }
  return cells(one(tok));
}

// Returns {w: Float32Array(169) of weights 0..1, err: message or ""}.
export function parseRange(text) {
  const w = new Float32Array(169);
  const toks = String(text || "").replace(/\s*([-:,])\s*/g, "$1").split(/[,\s]+/).filter(Boolean);
  try {
    for (const t of toks) {
      const [hand, wt, extra] = t.split(":");
      if (extra !== undefined) throw `“${t}” has two weights`;
      let v = 1;
      if (wt !== undefined) { v = Number(wt); if (!(v >= 0 && v <= 1) || !/^([01](\.\d*)?|\.\d+)$/.test(wt)) throw `“${t}”: weights go from 0 to 1, like :0.5`; }
      for (const [r, c] of expand(hand)) w[r * 13 + c] = v;
    }
  } catch (e) { return { w, err: String(e) }; }
  return { w, err: "" };
}

const fmtW = v => { const s = (Math.round(v * 1000) / 1000).toString(); return s.startsWith("0") ? s : s; };
const tag = v => v >= 0.9995 ? "" : ":" + fmtW(v);

// Compact text for a grid: pairs as TT+ / 99-77, others per top card as ATs+ / A9s-A6s / A5s.
export function formatRange(w) {
  const out = [];
  const runs = (list, name, isTop) => {
    let i = 0;
    while (i < list.length) {
      const v = list[i].v; if (v <= 0) { i++; continue; }
      let j = i; while (j + 1 < list.length && Math.abs(list[j + 1].v - v) < 1e-6) j++;
      const a = list[i], b = list[j];
      if (i === j) out.push(name(a) + tag(v));
      else if (isTop(a)) out.push(name(b) + "+" + tag(v));
      else out.push(name(a) + "-" + name(b) + tag(v));
      i = j + 1;
    }
  };
  runs([...Array(13).keys()].map(r => ({ r, v: w[r * 13 + r] })), x => RK[x.r] + RK[x.r], x => x.r === 0);
  for (const su of ["s", "o"]) for (let hi = 0; hi < 12; hi++) {
    const list = [];
    for (let lo = hi + 1; lo < 13; lo++) list.push({ lo, v: su === "s" ? w[hi * 13 + lo] : w[lo * 13 + hi] });
    runs(list, x => RK[hi] + RK[x.lo] + su, x => x.lo === hi + 1);
  }
  return out.join(",");
}

export function comboCount(w) {
  let n = 0; for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) n += w[r * 13 + c] * cellCombos(r, c);
  return n;
}

// Starting points only: simplified 100bb cash-game ranges. Teachers should edit them to fit.
export const PRESETS = {
  "Open UTG": "22+,A2s+,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,65s,ATo+,KJo+,QJo",
  "Open HJ": "22+,A2s+,K7s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,54s,A9o+,KTo+,QTo+,JTo",
  "Open CO": "22+,A2s+,K4s+,Q6s+,J7s+,T7s+,97s+,86s+,75s+,65s,54s,A7o+,A5o,K9o+,Q9o+,J9o+,T9o",
  "Open BTN": "22+,A2s+,K2s+,Q3s+,J5s+,T6s+,96s+,85s+,74s+,64s+,53s+,43s,A2o+,K8o+,Q8o+,J8o+,T8o+,98o,87o",
  "Open SB": "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o",
  "BB defend vs late open": "22-99,A2s-AJs,K2s-KJs,Q2s-QJs,J4s-JTs,T6s-T9s,96s+,85s+,74s+,63s+,53s+,43s,A2o-AJo,K7o-KJo,Q8o-QJo,J8o-JTo,T8o+,97o+,87o,76o",
  "BB defend vs early open": "22-TT,A2s-AJs,K6s-KQs,Q8s-QJs,J8s-JTs,T8s+,97s+,86s+,75s+,65s,54s,ATo-AJo,KTo-KQo,QTo+,JTo",
  "Flat call in position": "22-TT,A9s-AJs,A5s:0.5,KTs-KQs,QTs+,J9s+,T9s,98s,87s,76s,AJo-AQo,KQo",
  "3-bet range": "QQ+,AKs,AKo,AQs,A5s-A4s,KQs:0.5,JJ:0.5,76s:0.5,65s:0.5",
  "Call a 3-bet": "22-JJ,AJs-AQs,A5s:0.5,KJs+,QJs,JTs,T9s,98s,87s,AQo,AKo:0.5",
  "4-bet range": "QQ+,AKs,AKo,A5s:0.5",
  "Call a 4-bet": "QQ+,AKs,AKo,JJ:0.5",
  "Any two cards": "22+,A2s+,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o+,K2o+,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o",
};

// A guess at each player's range from what happened preflop at the table.
// spot.raises = number of preflop raises; each player has pos (BTN, SB, BB, UTG, ...) and agg.
export function guessRanges(spot) {
  const [oop, ip] = spot.pl;
  const open = pos => ({ UTG: "Open UTG", "UTG+1": "Open UTG", "UTG+2": "Open UTG", LJ: "Open UTG", HJ: "Open HJ", CO: "Open CO", BTN: "Open BTN", SB: "Open SB" })[pos] || "Open CO";
  if (spot.bomb || !spot.raises) return ["Any two cards", "Any two cards"];
  const agg = spot.pl.find(p => p.agg);
  const pick = p => {
    if (spot.raises === 1) {
      if (!agg) return "Flat call in position";
      if (p.agg) return spot.heads && p.pos === "BTN" ? "Open BTN" : open(p.pos);
      if (p.pos === "BB") return ["CO", "BTN", "SB"].includes(agg.pos) || spot.heads ? "BB defend vs late open" : "BB defend vs early open";
      return "Flat call in position";
    }
    if (spot.raises === 2) return p.agg ? "3-bet range" : "Call a 3-bet";
    return p.agg ? "4-bet range" : "Call a 4-bet";
  };
  return [pick(oop), pick(ip)];
}

// Store presets in the solver's own spelling (descending dash ranges, e.g. JTo-J8o).
for (const k in PRESETS) PRESETS[k] = formatRange(parseRange(PRESETS[k]).w);

/* ---------- preflop charts: the presets above, as edited by a teacher, plus charts of their own ----------
   PRESETS always holds the charts in use right now: the built-in ones (edited or not) and then any
   custom ones. A lobby sends its charts to everyone in it; outside a lobby this device's charts apply. */
export const DEFAULT_PRESETS = Object.freeze({ ...PRESETS });
export const BUILTIN = Object.keys(DEFAULT_PRESETS);
const escH = t => String(t == null ? "" : t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let overlay = {};
export const chartName = n => String(n || "").replace(/\s+/g, " ").trim().slice(0, 40);
export function cleanCharts(map) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map).slice(0, 80)) {
    const name = chartName(k); if (!name || typeof v !== "string") continue;
    const r = parseRange(v); if (r.err) continue;
    const t = formatRange(r.w);
    if (DEFAULT_PRESETS[name] !== undefined && t === DEFAULT_PRESETS[name]) continue; // same as the default
    out[name] = t;
  }
  return out;
}
export function applyCharts(map) {
  overlay = cleanCharts(map);
  for (const k of Object.keys(PRESETS)) delete PRESETS[k];
  Object.assign(PRESETS, DEFAULT_PRESETS, overlay);
  if (typeof dispatchEvent === "function" && typeof CustomEvent === "function") dispatchEvent(new CustomEvent("hsp-charts"));
}
export const chartOverlay = () => ({ ...overlay });
export const presetOptions = () => Object.keys(PRESETS).map(k => `<option>${escH(k)}</option>`).join("");
// this device's own charts (what a teacher last saved), used outside a lobby
export function deviceCharts() { try { return cleanCharts(JSON.parse(localStorage.getItem("hsp-charts") || "{}")); } catch (e) { return {}; } }
export function saveDeviceCharts(map) { try { localStorage.setItem("hsp-charts", JSON.stringify(cleanCharts(map))); } catch (e) {} }
if (typeof localStorage !== "undefined") { try { applyCharts(deviceCharts()); } catch (e) {} }
