// Runs equity jobs off the page so typing stays smooth. Messages: {id, job} -> {id, progress, res} ... {id, done:true, res}
import { equityRunner, summarize } from "./equity.js";
let cur = 0;
self.onmessage = e => {
  const { id, job } = e.data; cur = id;
  let r;
  try { r = equityRunner(job); } catch (x) { self.postMessage({ id, done: true, res: { err: String(x && x.message || x), players: [] } }); return; }
  const t0 = Date.now();
  const tick = () => {
    if (cur !== id) return; // a newer job replaced this one
    const p = r.step(120);
    const res = summarize(r.result()), done = p >= 1 || res.err || Date.now() - t0 > 6000;
    self.postMessage({ id, progress: p, done, res, size: r.size });
    if (!done) setTimeout(tick, 0);
  };
  tick();
};
