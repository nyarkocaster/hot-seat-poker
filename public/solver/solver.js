// Standalone solver page (/solver/): the solver component on this device only.
import { createSolver, spotFromTable } from "./core.js";

const btn = document.getElementById("themeBtn");
const sync = () => { btn.textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode"; };
btn.onclick = () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = t; try { localStorage.setItem("hsp-theme", t); } catch (e) {}
  sync();
};
sync();

const S = createSolver(document.getElementById("solver"));
window.__solver = S;
// an older "open in a new tab" link from the table: #s=<base64 JSON>
const m = /[#&]s=([^&]+)/.exec(location.hash);
if (m) {
  try {
    const sp = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
    if (sp && Array.isArray(sp.b) && Array.isArray(sp.pl) && sp.pl.length === 2) {
      const x = spotFromTable({ board: sp.b, pot: sp.pot, pl: sp.pl, raises: sp.raises, bomb: sp.bomb, st: { 3: "flop", 4: "turn", 5: "river" }[sp.b.length] },
        { hand: sp.hand, rules: { rakePct: sp.rake && sp.rake.pct, rakeCap: sp.rake && sp.rake.cap } });
      S.loadSpot(x.spot);
    }
  } catch (e) {}
}
