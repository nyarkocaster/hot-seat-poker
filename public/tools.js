// Study tools on the table page, each hidden until someone turns it on for themselves:
// - Odds calculator: pot odds, outs, EV and bluffing math, each shown as the equation and then the
//   same equation with this hand's numbers in it.
// - Poker stove: equity of hands or ranges on any board, worked out in a background worker.
import { parseCards, parseHolding, cardId, cardStr, countOuts, CATS } from "./equity.js";
import { PRESETS, presetOptions } from "./solver/range.js";

const SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const n = parseFloat(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const MAXP = 9; // the stove takes as many players as the biggest table
const r2 = n => Math.round(n * 100) / 100;
const $$ = n => (n < 0 ? "−$" : "$") + Math.abs(r2(n)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const nn = n => r2(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pc = (x, d = 1) => (Math.round(x * 100 * 10 ** d) / 10 ** d).toFixed(d) + "%";
const dec = (x, d = 3) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const chip = c => { const s = cardStr(c); return `<span class="tcard ${s[1]}">${s[0] === "T" ? "10" : s[0]}${SYM[s[1]]}</span>`; };
const chipStr = s => { const id = cardId(s); return id < 0 ? esc(s) : chip(id); };
const ids = strs => (strs || []).map(cardId).filter(x => x >= 0);
const EQ = (name, words, nums, result, cls = "") =>
  `<div class="eqn ${cls}"><div class="eqname">${name}</div><div class="eqwords">${words}</div><div class="eqnums">${nums}${result !== undefined ? ` = <b>${result}</b>` : ""}</div></div>`;

/* ======================= odds calculator ======================= */
// opt.table: {current(), mySeat(), myCards(), isTeacher()}
export function createOdds(el, opt = {}) {
  const st = { follow: true, seat: null, pot: 30, call: 10, street: "flop", outs: 9, src: "outs", horizon: "auto", own: 30, stove: null, p0: 30, bet: 20, auto: null, outsAuto: false };
  el.innerHTML = `
    <h2>Odds calculator</h2>
    <div class="ocalc">
      <div class="ofollow row">
        <label class="toggle sm"><input type="checkbox" data-o="follow" checked><span>Use this hand's numbers</span></label>
        <label class="oseat" hidden>Player <select data-o="seat"></select></label>
      </div>
      <div class="ofields">
        <label>Pot <span class="muted">(everything in the middle, including bets)</span><input type="text" inputmode="decimal" data-o="pot"></label>
        <label>To call<input type="text" inputmode="decimal" data-o="call"></label>
        <label>Street<select data-o="street"><option value="preflop">Preflop</option><option value="flop">Flop</option><option value="turn">Turn</option><option value="river">River</option></select></label>
      </div>
      <section class="osec" data-sec="1"></section>
      <section class="osec" data-sec="2"></section>
      <section class="osec" data-sec="3"></section>
      <section class="osec" data-sec="4"></section>
    </div>`;
  const q = s => el.querySelector(s);
  const inp = k => q(`[data-o="${k}"]`);
  // each numbered section folds away by its heading; remembered on this device
  const folded = (() => { try { return JSON.parse(localStorage.getItem("hsp-odds-fold") || "{}") || {}; } catch (e) { return {}; } })();
  function put(n, html) {
    const sec = q(`[data-sec="${n}"]`), m = html.match(/^\s*<h3>([\s\S]*?)<\/h3>/), shut = !!folded[n];
    sec.classList.toggle("shut", shut);
    if (!m) { sec.innerHTML = html; return; }
    sec.innerHTML = `<h3><button type="button" class="ofold" data-fold="${n}" aria-expanded="${!shut}"><span>${m[1]}</span><span class="ochev" aria-hidden="true">▾</span></button></h3><div class="obody">${html.slice(m[0].length)}</div>`;
  }

  function fromTable() {
    const P = opt.table && opt.table.current();
    st.auto = null;
    if (!P || !P.seats) return;
    const T = opt.table.isTeacher(), inHand = ["preflop", "flop", "turn", "river"].includes(P.phase);
    let seat = T ? (st.seat != null && P.seats[st.seat] ? st.seat : P.toAct) : opt.table.mySeat();
    if (seat == null || seat < 0 || !P.seats[seat]) { if (T && inHand) seat = P.seats.findIndex(s => s.has && !s.folded); }
    if (seat == null || seat < 0) return;
    const s = P.seats[seat];
    const pot = P.seats.reduce((a, x) => a + (x.total || 0), 0), streetBets = P.seats.reduce((a, x) => a + (x.bet || 0), 0);
    st.pot = r2(pot); st.call = r2(Math.max(0, Math.min((P.curBet || 0) - (s.bet || 0), s.stack || 0)));
    st.street = { 0: "preflop", 3: "flop", 4: "turn", 5: "river" }[(P.board || []).length] || "flop";
    st.p0 = r2(pot - streetBets); if (!document.activeElement || document.activeElement !== inp("bet")) st.bet = r2(Math.max(1, Math.round((st.p0 * 2) / 3)));
    const hero = T ? s.cards : opt.table.myCards();
    const others = T ? P.seats.filter((x, i) => i !== seat && x.has && !x.folded && x.cards).map(x => x.cards) : [];
    const oppLive = P.seats.filter((x, i) => i !== seat && x.has && !x.folded).length;
    const allin = s.allin || (st.call > 0 && st.call >= s.stack) || P.seats.some((x, i) => i !== seat && x.has && !x.folded && x.allin);
    st.auto = { seat, name: s.name, hero: hero || null, board: P.board || [], allin, known: !!hero && others.length === oppLive && oppLive > 0 };
    if (st.auto.known && (st.street === "flop" || st.street === "turn")) {
      const o = countOuts(ids(hero), others.map(ids), ids(P.board));
      st.auto.outs = o;
      // the counted outs fill the box once per spot; after you type or pick your own number, it stays until the table moves on
      const spot = JSON.stringify([P.hand, seat, P.board]);
      if (spot !== st.outsSpot) { st.outsSpot = spot; st.outsUser = false; }
      st.auto.counted = o.now < 0 ? o.win.length : o.lose.length;
      if (!st.outsUser) st.outs = st.auto.counted;
    } else st.auto.outs = null;
    // seat list for teachers
    if (T) {
      const opts = P.seats.map((x, i) => (x.has && !x.folded) || i === seat ? `<option value="${i}"${i === seat ? " selected" : ""}>${esc(x.name)}${i === P.toAct ? " (to act)" : ""}</option>` : "").join("");
      const sel = inp("seat"); if (sel !== document.activeElement) sel.innerHTML = opts;
    }
  }

  function render() {
    if (st.follow) fromTable();
    const f = document.activeElement;
    for (const k of ["pot", "call"]) if (inp(k) !== f) inp(k).value = nn(st[k]);
    inp("street").value = st.street; inp("follow").checked = st.follow;
    q(".oseat").hidden = !(opt.table && opt.table.isTeacher() && st.follow && st.auto);
    const P = st.pot, C = st.call;
    const A = st.auto;
    const who = A && st.follow ? `<p class="note">Numbers for <b>${esc(A.name)}</b>${A.hero ? ` holding ${A.hero.map(chipStr).join("")}` : ""}${A.board.length ? ` on ${A.board.map(chipStr).join("")}` : ""}.</p>` : st.follow ? `<p class="note">Take a seat or start a hand to fill these in, or type your own numbers.</p>` : "";

    // 1. price of the call
    let h1 = `<h3>1. The price of calling</h3>${who}`;
    if (C <= 0) h1 += `<p class="oinfo">Nothing to call, so you can check for free: you need <b>0%</b> equity to continue.</p>`;
    else {
      h1 += EQ("Pot odds", "Pot : To call", `${$$(P)} : ${$$(C)}`, `${nn(P / C)} : 1`);
      h1 += EQ("Equity you need", "To call ÷ (Pot + To call)", `${$$(C)} ÷ (${$$(P)} + ${$$(C)}) = ${nn(C)} ÷ ${nn(P + C)}`, pc(C / (P + C)));
      h1 += `<p class="why">You put in ${$$(C)} to win a pot that will be ${$$(P + C)}. If you win more than ${pc(C / (P + C))} of the time, calling pays off in the long run.</p>`;
    }
    put(1, h1);

    // 2. equity
    const unseen = 52 - 2 - ({ preflop: 0, flop: 3, turn: 4, river: 5 }[st.street]);
    let h2 = `<h3>2. How often you win</h3>
      <div class="seg osrc" role="group" aria-label="Where your equity comes from">${[["outs", "Count outs"], ["stove", "From the stove"], ["own", "Type it"]].map(([k, l]) => `<button type="button" data-src="${k}" aria-pressed="${st.src === k}">${l}</button>`).join("")}</div>`;
    let E = null, Elabel = "";
    if (st.src === "outs") {
      if (st.street === "preflop" || st.street === "river") {
        h2 += `<p class="oinfo">${st.street === "river" ? "On the river there are no cards to come, so outs don't apply. Use the stove or type your equity." : "Outs are for draws after the flop. Use the stove or type your equity before the flop."}</p>`;
      } else {
        const N = Math.max(0, Math.min(unseen, Math.round(st.outs)));
        const ao = A && st.follow && A.outs;
        h2 += `<div class="row ooutsrow"><label>Outs <input type="number" min="0" max="${unseen}" step="1" data-o="outs" value="${N}"></label>
          <span class="ochips">${[["Flush draw", 9], ["Open-ended straight draw", 8], ["Gutshot", 4], ["Two overcards", 6], ["Flush + straight draw", 15], ["Pair to trips", 2]].map(([l, n]) => `<button type="button" class="b sm" data-outs="${n}">${l} · ${n}</button>`).join("")}</span></div>`;
        if (ao && st.outsUser && Math.round(st.outs) !== A.counted) h2 += `<p class="note">You set ${N} outs. <button type="button" class="linkbtn" data-o="recount">Use the ${A.counted} counted from the real cards</button></p>`;
        if (ao) {
          if (ao.now < 0) h2 += `<p class="note">Counted against everyone's real cards: ${A.name} is behind now, and ${ao.win.length} card${ao.win.length === 1 ? "" : "s"} put${ao.win.length === 1 ? "s" : ""} them ahead: ${ao.win.map(chip).join("")}${ao.tie.length ? `. ${ao.tie.length} more give a tie: ${ao.tie.map(chip).join("")}` : ""}.</p>`;
          else h2 += `<p class="note">Counted against everyone's real cards: ${A.name} is ${ao.now > 0 ? "ahead" : "tied"} now. ${ao.lose.length} card${ao.lose.length === 1 ? "" : "s"} would put them behind: ${ao.lose.map(chip).join("")}. Outs below are the other player's.</p>`;
        }
        const one = N / unseen;
        h2 += EQ("Hit on the next card", "Outs ÷ Unseen cards", `${N} ÷ ${unseen}`, pc(one));
        h2 += EQ("Shortcut: rule of 2", "Outs × 2", `${N} × 2`, `${N * 2}%`, "short");
        let two = null;
        if (st.street === "flop") {
          const m = unseen - N; two = 1 - (m / unseen) * ((m - 1) / (unseen - 1));
          h2 += EQ("Hit by the river (turn or river)", "1 − (Misses ÷ Unseen) × ((Misses − 1) ÷ (Unseen − 1))", `1 − (${m} ÷ ${unseen}) × (${m - 1} ÷ ${unseen - 1}) = 1 − ${dec((m / unseen) * ((m - 1) / (unseen - 1)))}`, pc(two));
          h2 += EQ("Shortcut: rule of 4", "Outs × 4", `${N} × 4`, `${N * 4}%`, "short");
          const rv = ao && ao.river;
          if (rv && ao.now < 0) {
            const cats = rv.rrCat.map((x, i) => [CATS[i], x]).filter(x => x[1] > 0.0005).sort((a, b) => b[1] - a[1]);
            h2 += `<div class="orr"><p><b>Counting every turn and river</b> (all ${rv.pairs.toLocaleString("en-US")} pairs of cards), ${esc(A.name)} wins <b>${pc(rv.eq)}</b> by the river.</p>
              ${rv.rr > 0.0005 ? `<p>Outs only count single cards that win. <b>${pc(rv.rr)}</b> more comes from runner-runner hands, where the turn and river both have to help and neither card wins alone: ${cats.map(([c, x]) => `${c.toLowerCase()} ${pc(x)}`).join(", ")}. A common shortcut is to count a runner-runner draw as about one extra out.</p>` : `<p>None of it comes from runner-runner hands: every win needs one of the outs.</p>`}
              <button type="button" class="b sm" data-own="${(rv.eq * 100).toFixed(1)}">Use ${pc(rv.eq)} as my equity</button></div>`;
          }
        }
        const horizon = st.street === "flop" ? (st.horizon === "auto" ? (A && st.follow && A.allin ? "river" : "next") : st.horizon) : "next";
        if (st.street === "flop") h2 += `<div class="row ohz"><span class="muted">Use:</span><div class="seg">${[["next", "Next card"], ["river", "By the river"]].map(([k, l]) => `<button type="button" data-hz="${k}" aria-pressed="${horizon === k}">${l}</button>`).join("")}</div></div>
          <p class="why">Use “by the river” only when no more betting can happen, like when someone is all in. Otherwise you'll usually face another bet on the turn, so price the call on the next card.</p>`;
        E = horizon === "river" ? two : one; Elabel = horizon === "river" ? "hit by the river" : "hit on the next card";
      }
    } else if (st.src === "stove") {
      if (st.stove) { E = st.stove.eq; Elabel = `stove: ${st.stove.label}`; h2 += `<p class="oinfo">From the stove: <b>${pc(E)}</b> for ${esc(st.stove.label)}.</p>`; }
      else h2 += `<p class="oinfo">Open the Poker stove (Tools at the top), work out the equity, then press <b>Use in the odds calculator</b> next to a player.</p>`;
    } else {
      h2 += `<label class="oown">Your equity (%) <input type="number" min="0" max="100" step="0.1" data-o="own" value="${r2(st.own)}"></label>`;
      E = Math.max(0, Math.min(100, st.own)) / 100; Elabel = "your estimate";
    }
    put(2, h2);

    // 3. decision
    let h3 = `<h3>3. Is calling profitable?</h3>`;
    if (E == null) h3 += `<p class="oinfo">Add your equity in step 2 to see the answer.</p>`;
    else if (C <= 0) h3 += `<p class="oinfo">Checking is free, so there's nothing to compare. With ${pc(E)} equity, think about betting for value or as a bluff (step 4).</p>`;
    else {
      const Er = Math.round(E * 1000) / 1000; // the equations use the same rounded equity they show
      const need = C / (P + C), ev = Er * (P + C) - C, good = E >= need;
      h3 += `<div class="overdict ${good ? "ok" : "bad"}">${pc(E)} ${good ? "≥" : "<"} ${pc(need)} needed → ${good ? "calling makes money" : "calling loses money on this price alone"}</div>`;
      h3 += EQ("Expected value of calling", "Equity × (Pot + To call) − To call", `${dec(Er)} × (${$$(P)} + ${$$(C)}) − ${$$(C)} = ${$$(Er * (P + C))} − ${$$(C)}`, (ev >= 0 ? "+" : "") + $$(ev), ev >= 0 ? "good" : "bad");
      h3 += `<p class="why">Equity here is ${esc(Elabel)}. Over many tries you win ${$$(P + C)} about ${pc(E)} of the time and always pay ${$$(C)}.</p>`;
      if (!good && Er > 0) {
        const X = C / Er - (P + C);
        h3 += EQ("Implied odds needed", "To call ÷ Equity − (Pot + To call)", `${$$(C)} ÷ ${dec(Er)} − ${$$(P + C)} = ${$$(C / Er)} − ${$$(P + C)}`, $$(X));
        h3 += `<p class="why">You'd need to win about ${$$(X)} more on later streets when you hit${A && A.allin && st.follow ? ", but someone is all in, so there's no more to win" : ""}.</p>`;
      }
    }
    put(3, h3);

    // 4. betting
    const P0 = Math.max(0, st.p0), B = Math.max(0, st.bet);
    let h4 = `<h3>4. When you're the one betting</h3>
      <div class="ofields"><label>Pot before your bet<input type="text" inputmode="decimal" data-o="p0" value="${nn(P0)}"></label><label>Your bet<input type="text" inputmode="decimal" data-o="bet" value="${nn(B)}"></label>
      <span class="ochips">${[[0.33, "⅓ pot"], [0.5, "½ pot"], [0.75, "¾ pot"], [1, "Pot"]].map(([m, l]) => `<button type="button" class="b sm" data-bet="${m}">${l}</button>`).join("")}</span></div>`;
    if (B > 0 && P0 > 0) {
      h4 += EQ("A pure bluff needs folds", "Bet ÷ (Pot + Bet)", `${$$(B)} ÷ (${$$(P0)} + ${$$(B)}) = ${nn(B)} ÷ ${nn(P0 + B)}`, pc(B / (P0 + B)));
      h4 += EQ("They should keep playing at least (MDF)", "Pot ÷ (Pot + Bet)", `${$$(P0)} ÷ (${$$(P0)} + ${$$(B)}) = ${nn(P0)} ÷ ${nn(P0 + B)}`, pc(P0 / (P0 + B)));
      h4 += EQ("Equity they need to call you", "Bet ÷ (Pot + 2 × Bet)", `${$$(B)} ÷ (${$$(P0)} + 2 × ${$$(B)}) = ${nn(B)} ÷ ${nn(P0 + 2 * B)}`, pc(B / (P0 + 2 * B)));
      h4 += `<p class="why">If they fold more than ${pc(B / (P0 + B))} of the time, a bluff with no chance to win still shows a profit. Bigger bets need more folds but give the caller a worse price.</p>`;
    }
    put(4, h4);
  }

  const stopFollow = () => { if (st.follow) { st.follow = false; inp("follow").checked = false; } };
  el.addEventListener("input", e => {
    const k = e.target.dataset.o; if (!k) return;
    if (k === "pot" || k === "call") { stopFollow(); st[k] = Math.max(0, num(e.target.value)); renderSoon(); }
    else if (k === "outs") { st.outs = Math.max(0, num(e.target.value)); st.outsUser = true; renderSoon(); }
    else if (k === "own") { st.own = num(e.target.value); renderSoon(); }
    else if (k === "p0" || k === "bet") { if (k === "p0") stopFollow(); st[k] = Math.max(0, num(e.target.value)); renderSoon(); }
  });
  el.addEventListener("change", e => {
    const k = e.target.dataset.o;
    if (k === "follow") { st.follow = e.target.checked; render(); }
    else if (k === "street") { stopFollow(); st.street = e.target.value; render(); }
    else if (k === "seat") { st.seat = +e.target.value; render(); }
  });
  el.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.src) { st.src = b.dataset.src; render(); }
    else if (b.dataset.fold) { const n = b.dataset.fold; folded[n] = !folded[n]; try { localStorage.setItem("hsp-odds-fold", JSON.stringify(folded)); } catch (e) {} render(); }
    else if (b.dataset.outs) { st.outs = +b.dataset.outs; st.outsUser = true; render(); }
    else if (b.dataset.o === "recount") { st.outsUser = false; render(); }
    else if (b.dataset.own) { st.own = +b.dataset.own; st.src = "own"; st.horizon = "river"; render(); }
    else if (b.dataset.hz) { st.horizon = b.dataset.hz; render(); }
    else if (b.dataset.bet) { st.bet = r2(Math.max(0.01, st.p0 * +b.dataset.bet)); render(); }
  });
  let soonT = null;
  // re-draw the sections but keep the box being typed in
  function renderSoon() { clearTimeout(soonT); soonT = setTimeout(() => { const f = document.activeElement, k = f && f.dataset && f.dataset.o, pos = f && f.selectionStart; render(); if (k) { const n = inp(k); if (n && n !== f) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) {} } } }, 150); }
  let lastKey = "";
  return {
    tableUpdate(P) {
      if (!st.follow || !P) return;
      const key = JSON.stringify([P.hand, P.phase, P.toAct, P.board, P.curBet, P.seats.map(s => [s.bet, s.total, s.folded, s.cards])]);
      if (key === lastKey) return; lastKey = key; render();
    },
    setStove(eq, label) { st.stove = { eq, label }; st.src = "stove"; render(); },
    refresh: render,
    get state() { return st; },
  };
}

/* ======================= poker stove ======================= */
// opt.table: {current(), mySeat(), myCards(), isTeacher()}; opt.solver(): solver; opt.odds(): odds calculator
export function createStove(el, opt = {}) {
  let rows = [{ text: "", label: "" }, { text: "", label: "" }], board = "", dead = "", sel = 0, res = null, busy = false, jobId = 0;
  let worker = null;
  el.innerHTML = `
    <h2>Poker stove</h2>
    <div class="stove">
      <div class="row stools"><button class="b sm" type="button" data-s="table">Use the table</button><button class="b sm" type="button" data-s="solver">Use the solver's ranges</button><button class="b sm" type="button" data-s="clear">Clear</button></div>
      <div class="sfields">
        <label>Board <span class="muted">(0, 3, 4 or 5 cards)</span><input type="text" data-s="board" placeholder="Like Ah Kd 7c" spellcheck="false" autocomplete="off"></label>
        <label>Dead cards <span class="muted">(folded or seen)</span><input type="text" data-s="dead" placeholder="Optional" spellcheck="false" autocomplete="off"></label>
      </div>
      <div class="sboard"></div>
      <div class="srows"></div>
      <div class="row"><button class="b sm" type="button" data-s="add">+ Add a player</button><span class="sstat note" role="status"></span></div>
      <div class="scats"></div>
    </div>`;
  const q = s => el.querySelector(s);
  function startWorker() {
    if (worker) return worker;
    try { worker = new Worker("/equity-worker.js", { type: "module" }); worker.onmessage = onResult; } catch (e) { worker = null; }
    return worker;
  }
  function onResult(e) {
    const m = e.data; if (m.id !== jobId) return;
    res = m.res; busy = !m.done; draw();
  }
  function parsed() {
    const b = parseCards(board), d = parseCards(dead);
    const ps = rows.map(r => r.combos ? { kind: "range", combos: r.combos, err: r.combos.length ? "" : "No hands reach this spot" } : parseHolding(r.text));
    let err = b.err || d.err;
    if (!err && ![0, 3, 4, 5].includes(b.cards.length)) err = "The board needs 0, 3, 4 or 5 cards.";
    if (!err) { const seen = new Set(); for (const c of [...b.cards, ...d.cards]) { if (seen.has(c)) { err = `${cardStr(c)} is used twice`; break; } seen.add(c); }
      ps.forEach((p, i) => { if (!err && p.kind === "hand") for (const [a, c2] of p.combos) for (const c of [a, c2]) { if (seen.has(c)) err = `${cardStr(c)} is used twice (player ${i + 1})`; seen.add(c); } }); }
    return { b, d, ps, err };
  }
  let runT = null;
  function runSoon() { clearTimeout(runT); runT = setTimeout(run, 250); }
  function run() {
    const { b, d, ps, err } = parsed();
    res = null;
    if (err || ps.some(p => p.err)) { busy = false; draw(); return; }
    if (rows.every(r => !r.text.trim() && !r.combos)) { busy = false; draw(); return; }
    const w = startWorker(); if (!w) { q(".sstat").textContent = "This browser can't run the stove."; return; }
    jobId++; busy = true;
    w.postMessage({ id: jobId, job: { players: ps.map(p => p.combos), board: b.cards, dead: d.cards } });
    draw();
  }
  function drawRows() {
    const f = document.activeElement;
    const box = q(".srows");
    if (box.children.length !== rows.length || !box.contains(f)) {
      box.innerHTML = rows.map((r, i) => `<div class="stvrow${i === sel ? " on" : ""}" data-i="${i}">
        <div class="sname"><span class="sdot c${i}"></span>${r.label ? esc(r.label) : `Player ${i + 1}`}${r.note ? `<span class="muted snote">${esc(r.note)}</span>` : ""}</div>
        <input type="text" data-hand="${i}" value="${esc(r.text)}" placeholder="${r.combos ? "Solver range at this spot (type to replace it)" : i ? "Blank = any two cards" : "Hand like AhKh, or a range like QQ+,AKs"}" spellcheck="false" autocomplete="off" aria-label="Player ${i + 1} hand or range">
        <select data-preset="${i}" aria-label="Load a range for player ${i + 1}"><option value="">Range…</option>${presetOptions()}</select>
        ${rows.length > 2 ? `<button type="button" class="b sm sx" data-rm="${i}" aria-label="Remove player ${i + 1}">×</button>` : ""}
        <div class="sres" data-res="${i}"></div>
      </div>`).join("");
    }
  }
  function draw() {
    drawRows();
    const addB = q('[data-s="add"]'); if (addB) addB.disabled = rows.length >= MAXP;
    const { b, ps, err } = parsed();
    q(".sboard").innerHTML = b.cards.length ? b.cards.map(chip).join("") : "";
    rows.forEach((r, i) => {
      const cell = q(`[data-res="${i}"]`); if (!cell) return;
      const p = ps[i];
      if (p.err) { cell.innerHTML = `<span class="err">${esc(p.err)}</span>`; return; }
      const x = res && res.players && res.players[i];
      const kind = rows[i].combos ? `<span class="muted">${p.combos.length} combos, weighted</span>` : p.kind === "hand" ? p.combos[0].slice(0, 2).map(chip).join("") : p.kind === "any" ? `<span class="muted">Any two cards</span>` : `<span class="muted">${p.combos.length} combos</span>`;
      cell.innerHTML = x ? `<div class="sbar"><i class="c${i}" style="width:${(x.eq * 100).toFixed(1)}%"></i></div>
        <div class="snums"><b>${pc(x.eq)}</b><span>win ${pc(x.win)} · tie ${pc(x.tie)}</span>${kind}${opt.odds && opt.odds() ? `<button type="button" class="linkbtn" data-use="${i}">Use in the odds calculator</button>` : ""}</div>` : `<div class="snums">${kind}</div>`;
    });
    const st = q(".sstat");
    if (err) st.innerHTML = `<span class="err">${esc(err)}</span>`;
    else if (res && res.err) st.innerHTML = `<span class="err">${esc(res.err)}</span>`;
    else if (!res) st.textContent = busy ? "Working…" : rows.every(r => !r.text.trim() && !r.combos) ? "Enter a hand or range for at least one player." : "";
    else st.textContent = res.exact ? (busy ? "Checking every possible board…" : `Exact: every possible board checked.`) : `${busy ? "Estimating" : "Estimate"} from ${Math.round(res.trials).toLocaleString("en-US")} deals (about ±${pc(Math.max(...res.players.map(p => p.margin)), 1)}).`;
    const x = res && res.players && res.players[sel];
    q(".scats").innerHTML = x ? `<h3>${esc(rows[sel].label || `Player ${sel + 1}`)} ends up with</h3>${x.cats.map((v, k) => [v, k]).filter(([v]) => v > 0.0005).reverse().map(([v, k]) => `<div class="scat"><span>${CATS[k]}</span><div class="sbar"><i class="c${sel}" style="width:${Math.min(100, v * 100).toFixed(1)}%"></i></div><b>${pc(v)}</b></div>`).join("")}<p class="why">Click a player to see their hands. Chances are for the final five cards.</p>` : "";
  }
  el.addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.hand != null) { const r = rows[+t.dataset.hand]; r.text = t.value; if (r.combos) { r.combos = null; r.note = ""; } runSoon(); }
    else if (t.dataset.s === "board") { board = t.value; runSoon(); }
    else if (t.dataset.s === "dead") { dead = t.value; runSoon(); }
  });
  el.addEventListener("change", e => {
    const t = e.target; if (t.dataset.preset == null || !t.value) return;
    const i = +t.dataset.preset; rows[i].combos = null; rows[i].note = ""; rows[i].text = PRESETS[t.value] || ""; t.value = ""; q(`[data-hand="${i}"]`).value = rows[i].text; run();
  });
  el.addEventListener("click", e => {
    const b = e.target.closest("button"), row = e.target.closest(".stvrow");
    if (row && (!b || !b.dataset.rm)) { const i = +row.dataset.i; if (i !== sel) { sel = i; el.querySelectorAll(".stvrow").forEach(x => x.classList.toggle("on", +x.dataset.i === sel)); draw(); } }
    if (!b) return;
    if (b.dataset.rm != null) { rows.splice(+b.dataset.rm, 1); sel = Math.min(sel, rows.length - 1); q(".srows").innerHTML = ""; run(); return; }
    if (b.dataset.use != null) { const i = +b.dataset.use, x = res && res.players[i]; if (x && opt.odds && opt.odds()) { opt.odds().setStove(x.eq, rows[i].label || rows[i].text || `Player ${i + 1}`); if (opt.flash) opt.flash(`Odds calculator now uses ${pc(x.eq)} equity`); } return; }
    const c = b.dataset.s;
    if (c === "add" && rows.length < MAXP) { rows.push({ text: "", label: "" }); q(".srows").innerHTML = ""; draw(); }
    else if (c === "clear") { rows = [{ text: "", label: "" }, { text: "", label: "" }]; board = dead = ""; sel = 0; q('[data-s="board"]').value = ""; q('[data-s="dead"]').value = ""; q(".srows").innerHTML = ""; run(); }
    else if (c === "table") fromTable();
    else if (c === "solver") fromSolver();
  });
  function setAll(newRows, newBoard, newDead) {
    rows = newRows; board = newBoard; dead = newDead || ""; sel = 0;
    q('[data-s="board"]').value = board; q('[data-s="dead"]').value = dead; q(".srows").innerHTML = ""; run();
  }
  function fromTable() {
    const P = opt.table && opt.table.current(); if (!P) return;
    const T = opt.table.isTeacher(), me = opt.table.mySeat(), mine = opt.table.myCards();
    const live = P.seats.map((s, i) => ({ s, i })).filter(({ s }) => s.has && !s.folded);
    if (!live.length) { if (opt.flash) opt.flash("Deal a hand first"); return; }
    const out = [], deadC = [];
    for (const { s, i } of live) {
      const cards = T ? s.cards : i === me ? mine : s.cards;
      out.push({ text: cards ? cards.join(" ") : "", label: s.name + (i === me ? " (you)" : "") });
    }
    if (T) P.seats.forEach(s => { if (s.has && s.folded && s.cards) deadC.push(...s.cards); });
    const rowsNew = out.slice(0, MAXP);
    if (rowsNew.length < 2) rowsNew.push({ text: "", label: "" });
    setAll(rowsNew, (P.board || []).join(" "), deadC.join(" "));
  }
  // After a solve: both ranges as they stand at the spot on screen in the solver, each hand weighted by
  // how often it gets there. Before a solve: the starting ranges typed into the solver, on its board.
  function fromSolver() {
    const S = opt.solver && opt.solver();
    if (!S) { if (opt.flash) opt.flash("The solver isn't open to you right now"); return; }
    const nr = S.nodeRanges && S.nodeRanges();
    if (nr) {
      setAll([0, 1].map(k => ({ text: "", combos: nr.combos[k], label: `${nr.names[k]} (${k ? "IP" : "OOP"})`, note: ` · after ${nr.at}` })), nr.board.map(cardStr).join(" "));
      return;
    }
    const r = S.ranges(), nm = S.names(), sp = S.state && S.state.spot;
    if (!r[0].trim() && !r[1].trim()) { if (opt.flash) opt.flash("The solver's ranges are blank"); return; }
    setAll([{ text: r[0], label: `${nm[0]} (OOP)`, note: " · starting range" }, { text: r[1], label: `${nm[1]} (IP)`, note: " · starting range" }], sp && sp.board ? sp.board.map(cardStr).join(" ") : "");
  }
  draw();
  const onCharts = () => el.querySelectorAll("select[data-preset]").forEach(s => { s.innerHTML = `<option value="">Range…</option>${presetOptions()}`; });
  addEventListener("hsp-charts", onCharts);
  return { refresh: draw, run, fromTable, get rows() { return rows; }, get result() { return res; }, destroy() { removeEventListener("hsp-charts", onCharts); if (worker) worker.terminate(); worker = null; } };
}
