// 300 random hands with every game option in play; checks chips always balance
// (stacks + chips in the pot + rake collected = what we started with), no duplicate cards,
// no hidden cards leaking into the public view.
import {createEngine,freshGame,evaluate,cmp,FULL} from "../public/engine.js";
const HANDS=+(process.argv[2]||300);
const E=createEngine();
const R=n=>Math.floor(Math.random()*n), pick=a=>a[R(a.length)];
let fails=0; const st={hands:0,showdowns:0,folds:0,sidepots:0,undos:0,raked:0,rakeTotal:0,straddles:0,bombs:0,rit:0,antes:0,timeouts:0};
const fail=m=>{fails++; if(fails<10) console.log("FAIL:",m)};
const sum=f=>E.G.seats.reduce((a,s)=>a+f(s),0);
function check(T,tag){
  const G=E.G, inHand=!E.between();
  const total=sum(s=>s.stack)+(inHand?sum(s=>s.total):0)+(G.rakeTotal||0);
  if(total!==T) fail(`${tag}: chips ${total} != ${T} (phase ${G.phase}, hand ${G.hand})`);
  if(G.seats.some(s=>s.stack<0||!Number.isInteger(s.stack))) fail(tag+": bad stack");
  if(inHand||G.phase==="done"){
    const dealt=[...G.board,...(G.board2||[]).slice(G.ritFrom)]; G.seats.forEach((s,i)=>{if(i<G.size&&s.cards) dealt.push(...s.cards)});
    if(dealt.some(c=>!FULL.includes(c))) fail(tag+": invalid card "+dealt);
    if(new Set(dealt).size!==dealt.length) fail(tag+": duplicate cards "+dealt.join(","));
  }
  E.pubView().seats.forEach((s,i)=>{if(s.cards&&!G.revealAll&&!G.seats[i].shown) fail(tag+": leaked cards seat "+i)});
  (G.spots||[]).forEach(sp=>{
    const n={flop:3,turn:4,river:5}[sp.st];
    if(!n||sp.board.length!==n) fail(tag+": spot board "+sp.st+" "+sp.board);
    if(sp.pl.length<2||!(sp.pot>0)) fail(tag+": spot players/pot");
    if(sp.pl.some(p=>!p.pos)||new Set(sp.pl.map(p=>p.pos)).size!==sp.pl.length) fail(tag+": spot positions "+sp.pl.map(p=>p.pos));
    if(sp.pl.filter(p=>p.agg).length>1) fail(tag+": two aggressors");
    if(sp.pl.some(p=>p.stack<0)) fail(tag+": spot stack");
  });
  (G.line||[]).forEach(x=>{if(!["flop","turn","river"].includes(x.st)||!["check","call","fold","bet","raise"].includes(x.a)||!(x.i>=0&&x.i<9)||!(x.to>=0)) fail(tag+": bad line entry "+JSON.stringify(x))});
  if(G.phase==="done"&&tag==="hand end") st.spots=(st.spots||0)+(G.spots||[]).length;
}
const ev=c=>evaluate(c.split(" "));
[["As Ks Qs Js Ts 2d 3c",8],["Ah 2h 3h 4h 5h Kd Kc",8],["9c 9d 9h 9s 2c 3d 4h",7],["Kc Kd Kh 2s 2c 7d 8h",6],["2h 7h 9h Jh Kh As Ad",5],["Ah 2c 3d 4s 5h Kd Qc",4],["7c 7d 7h Ks 2c 3d 9h",3],["7c 7d Kh Ks 2c 3d 9h",2],["7c 7d Kh Qs 2c 3d 9h",1],["Ac Jd 9h 7s 4c 3d 2h",0]]
  .forEach(([c,k])=>{if(ev(c)[0]!==k) fail("evaluator "+c)});
if(cmp(ev("Ah Ad Kc 7s 4c 3d 2h"),ev("Ah Ad Qc 7s 4c 3d 2h"))<=0) fail("kicker compare");

// targeted: straddle sets action and min raise
E.G=freshGame("t"); E.G.size=6; E.runOp({t:"rule",k:"straddle",v:true}); E.runOp({t:"deal"});
{const G=E.G; const strad=G.seats.findIndex(s=>s.bet===4); if(G.curBet!==4||G.minRaise!==4||strad<0) fail("straddle setup "+G.curBet+" "+G.minRaise); if(G.toAct!==(strad+1)%6) fail("straddle first to act");}
// targeted: rake 10% cap 5, no flop no drop
E.G=freshGame("t"); E.G.size=2; ["rakePct:10","rakeCap:5"].forEach(x=>{const[k,v]=x.split(":");E.runOp({t:"rule",k,v:+v})});
E.runOp({t:"deal"}); E.runOp({t:"act",seat:E.G.toAct,a:"fold"}); if(E.G.rakeTotal!==0) fail("no flop no drop");
E.runOp({t:"deal"}); while(!E.between()) E.runOp({t:"act",seat:E.G.toAct,a:"allin"}); if(E.G.rakeTotal!==5) fail("rake cap 5, got "+E.G.rakeTotal);
// targeted: timeout folds facing a bet, checks otherwise
E.G=freshGame("t"); E.G.size=3; E.runOp({t:"deal"}); {const i=E.G.toAct; E.runOp({t:"timeout",turn:E.G.turn}); if(!E.G.seats[i].folded) fail("timeout should fold facing BB");}
E.runOp({t:"timeout",turn:E.G.turn-1}); // stale turn must be ignored

E.G=freshGame("Test"); E.G.size=6;
let T=sum(s=>s.stack);
const studs=["u1","u2","u3"];
while(st.hands<HANDS){
  if(Math.random()<.15) E.runOp({t:"size",v:2+R(8)});
  if(Math.random()<.1) E.runOp({t:"out",i:R(9),v:Math.random()<.3});
  if(Math.random()<.3) for(let k=0;k<R(4);k++) E.runOp({t:"pick",kind:Math.random()<.5?"board":"seat",i:R(9),k:R(5),card:Math.random()<.5?"random":pick(FULL)});
  if(Math.random()<.2) E.seatReq(pick(studs),"S",R(10)-1);
  if(Math.random()<.1) E.runOp({t:"reveal",v:Math.random()<.5});
  if(Math.random()<.2) E.runOp({t:"rule",k:"anteType",v:pick(["none","each","bb"])});
  if(Math.random()<.1) E.runOp({t:"rule",k:"ante",v:R(4)});
  if(Math.random()<.15) E.runOp({t:"rule",k:"straddle",v:Math.random()<.4});
  if(Math.random()<.1) E.runOp({t:"rule",k:"straddleAmt",v:pick([3,4,5,6,10])});
  if(Math.random()<.15) E.runOp({t:"rule",k:"rakePct",v:pick([0,5,7.5,10])});
  if(Math.random()<.1) E.runOp({t:"rule",k:"rakeCap",v:pick([0,3,5,8])});
  if(Math.random()<.1) E.runOp({t:"rule",k:"nfnd",v:Math.random()<.7});
  if(Math.random()<.2) E.runOp({t:"rule",k:"rit",v:Math.random()<.6});
  if(Math.random()<.1) E.runOp({t:"straddleNext",v:true});
  if(Math.random()<.08) E.runOp({t:"bombNext",v:true});
  if(Math.random()<.04){E.runOp({t:"rakereset"});T=sum(s=>s.stack)+(E.G.rakeTotal||0);E.history.length=0}
  if(E.readyCount()<2){E.G.seats.forEach(s=>s.out=false); E.runOp({t:"allstacks",v:20+R(400)}); T=sum(s=>s.stack)+(E.G.rakeTotal||0); E.history.length=0}
  if(Math.random()<.1){E.runOp({t:"stack",i:R(E.G.size),v:R(500)}); T=sum(s=>s.stack)+(E.G.rakeTotal||0); E.history.length=0}
  check(T,"pre-deal");
  const wasBomb=E.G.bombNext;
  if(!E.runOp({t:"deal"})) continue;
  st.hands++; if(wasBomb) st.bombs++; if(E.G.log.some(l=>/straddles/.test(l))&&E.G.log.slice(-6).some(l=>/straddles/.test(l))) st.straddles++;
  if(E.G.log.slice(-8).some(l=>/antes|ante /.test(l))) st.antes++;
  check(T,"after deal");
  let guard=0;
  while(!E.between()&&guard++<300){
    const G=E.G, i=G.toAct; if(i==null){fail("stuck: no one to act in "+G.phase);break}
    const r=Math.random();
    if(r<.04&&E.history.length){E.runOp({t:"undo"});st.undos++;check(T,"undo");continue}
    if(r<.06){E.runOp({t:"pick",kind:"seat",i:R(G.size),k:R(2),card:"random"});check(T,"mid pick");continue}
    if(r<.07){E.runOp({t:"pick",kind:"board",k:R(5),card:pick(FULL)});check(T,"board pick");continue}
    if(r<.075){E.runOp({t:"voidhand"});check(T,"void");break}
    if(r<.09){E.runOp({t:"timeout",turn:G.turn});st.timeouts++;check(T,"timeout");continue}
    const s=G.seats[i]; const a=pick(["fold","check","call","call","call","raise","raise","allin"]);
    const amt=G.curBet+R(3*(G.curBet+G.blinds.bb)+1);
    let ok=s.uid&&Math.random()<.5?E.actFor(s.uid,a,amt):E.runOp({t:"act",seat:i,a,amt});
    check(T,"after "+a);
    if(!ok&&a==="check") E.runOp({t:"act",seat:i,a:"call"});
  }
  if(guard>=300) fail("hand did not finish");
  const G=E.G;
  if(G.phase==="done"){ if(G.seats.some(s=>s.shown)) st.showdowns++; else st.folds++; if(/side pot/.test(G.result)) st.sidepots++; if(G.handRake) st.raked++; if(G.board2) st.rit++ }
  check(T,"hand end");
}
st.rakeTotal=E.G.rakeTotal;
console.log(JSON.stringify({...st,fails}));
process.exit(fails?1:0);
