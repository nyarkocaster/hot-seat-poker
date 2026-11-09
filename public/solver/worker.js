// Runs the solver off the main page so the page stays responsive.
// Messages in: load {mt}, setup {spot}, solve {compress, target, maxIter}, stop, node {hist}.
let mod = null, S = null, stopping = false, sizes = [0, 0];

const post = (m, transfer) => postMessage(m, transfer || []);
const tick = () => new Promise(r => setTimeout(r, 0));

async function load(mt) {
  mod = await import(mt ? "./pkg-mt/hsp_solver.js" : "./pkg-st/hsp_solver.js");
  await mod.default();
  let threads = 1;
  if (mt) {
    threads = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
    await mod.initThreadPool(threads);
  }
  post({ t: "loaded", threads });
}

function setup(sp) {
  if (S) { S.free(); S = null; }
  S = new mod.Solver();
  const err = S.init(sp.oop, sp.ip, Uint8Array.from(sp.board), sp.pot, sp.eff, sp.rake, sp.rakeCap,
    sp.fb, sp.fr, sp.tb, sp.tr, sp.rb, sp.rr, sp.allinT, sp.forceT, 0.1);
  if (err) { S.free(); S = null; return post({ t: "setup", err }); }
  const c0 = S.private_cards(0), c1 = S.private_cards(1);
  sizes = [c0.length, c1.length];
  post({ t: "setup", mem: [S.memory_usage(false), S.memory_usage(true)], cards: [c0, c1] });
}

async function solve({ compress, target, maxIter }) {
  stopping = false;
  S.allocate_memory(compress);
  post({ t: "progress", i: 0, e: null });
  let i = 0, e = Infinity, last = 0;
  for (; i < maxIter; i++) {
    S.solve_step(i);
    if (i % 10 === 9 || i === maxIter - 1) {
      e = S.exploitability();
      post({ t: "progress", i: i + 1, e });
      if (e <= target) { i++; break; }
    }
    if (Date.now() - last > 40) { await tick(); last = Date.now(); }
    if (stopping) { i++; e = S.exploitability(); break; }
  }
  S.finalize();
  post({ t: "solved", i, e, stopped: stopping });
}

function node(hist) {
  S.apply_history(Uint32Array.from(hist));
  const p = S.current_player();
  const res = S.get_results();
  post({ t: "node", hist, p, acts: S.actions(), tb: Array.from(S.total_bet_amount()),
    possible: p === "chance" ? S.possible_cards() : 0, res }, [res.buffer]);
}

onmessage = async ({ data: m }) => {
  try {
    if (m.t === "load") await load(m.mt);
    else if (m.t === "setup") setup(m.spot);
    else if (m.t === "solve") await solve(m);
    else if (m.t === "stop") stopping = true;
    else if (m.t === "node") node(m.hist);
  } catch (err) {
    post({ t: "error", during: m.t, msg: String((err && err.message) || err) });
  }
};
