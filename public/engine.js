// Hot Seat Poker game engine. Pure JavaScript, shared by the server (one engine per lobby)
// and the browser (practice table). No network or DOM code in here.

export const RANKS="23456789TJQKA", SUITS="shdc", SYM={s:"♠",h:"♥",d:"♦",c:"♣"};
export const FULL=[]; for(const r of RANKS) for(const s of SUITS) FULL.push(r+s);
export const NAMES=["Dana","Luis","Priya","Marcus","Jen","Theo","Ana","Ray","Kim"];
export const STREETS={idle:"Between hands",preflop:"Preflop",flop:"Flop",turn:"Turn",river:"River",done:"Hand over"};
export const money=n=>"$"+(Math.round(n*100)/100).toLocaleString("en-US");
export const clone=o=>JSON.parse(JSON.stringify(o));
export function pretty(c){return c[0].replace("T","10")+SYM[c[1]]}
const rv=c=>RANKS.indexOf(c[0])+2;

/* ---------- hand evaluator (best 5 of 5-7) ---------- */
export const CAT=["High card","Pair","Two pair","Three of a kind","Straight","Flush","Full house","Four of a kind","Straight flush"];
function straightHigh(ranks){
  const set=new Set(ranks); if(set.has(14)) set.add(1);
  for(let h=14;h>=5;h--){let ok=true;for(let k=0;k<5;k++) if(!set.has(h-k)){ok=false;break} if(ok) return h}
  return 0;
}
export function evaluate(cards){
  const bySuit={}, cnt={};
  for(const c of cards){(bySuit[c[1]]=bySuit[c[1]]||[]).push(rv(c)); cnt[rv(c)]=(cnt[rv(c)]||0)+1}
  const uniq=Object.keys(cnt).map(Number).sort((a,b)=>b-a);
  let fl=null; for(const s in bySuit) if(bySuit[s].length>=5) fl=bySuit[s].sort((a,b)=>b-a);
  if(fl){const sh=straightHigh([...new Set(fl)]); if(sh) return [8,sh]}
  const groups=uniq.map(r=>[cnt[r],r]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
  if(groups[0][0]===4){const k=uniq.filter(r=>r!==groups[0][1]);return [7,groups[0][1],k[0]]}
  if(groups[0][0]===3){const p=groups.slice(1).find(g=>g[0]>=2); if(p) return [6,groups[0][1],p[1]]}
  if(fl) return [5,...fl.slice(0,5)];
  const sh=straightHigh(uniq); if(sh) return [4,sh];
  if(groups[0][0]===3){const k=uniq.filter(r=>r!==groups[0][1]);return [3,groups[0][1],k[0],k[1]]}
  if(groups[0][0]===2&&groups[1]&&groups[1][0]===2){const k=uniq.filter(r=>r!==groups[0][1]&&r!==groups[1][1]);return [2,groups[0][1],groups[1][1],k[0]]}
  if(groups[0][0]===2){const k=uniq.filter(r=>r!==groups[0][1]);return [1,groups[0][1],k[0],k[1],k[2]]}
  return [0,...uniq.slice(0,5)];
}
export function cmp(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0); if(d) return d} return 0}

/* ---------- game options ---------- */
export function defaultRules(){
  return {anteType:"none",ante:1,straddle:false,straddleAmt:4,rakePct:0,rakeCap:5,nfnd:true,rit:false,clock:0,bombAmt:5,solverStudents:"between",stoveStudents:"between"};
}
const CLOCKS=[0,15,20,30,45,60,90,120];
function setRule(r,k,v){
  const n=Math.round(+v||0);
  switch(k){
    case "anteType": if(!["none","each","bb"].includes(v)) return false; r.anteType=v; return true;
    case "ante": r.ante=Math.max(0,Math.min(100000,n)); return true;
    case "straddle": r.straddle=!!v; return true;
    case "straddleAmt": r.straddleAmt=Math.max(1,Math.min(100000,n)); return true;
    case "rakePct": {const p=Math.round((+v||0)*10)/10; r.rakePct=Math.max(0,Math.min(25,p)); return true}
    case "rakeCap": r.rakeCap=Math.max(0,Math.min(100000,n)); return true;
    case "nfnd": r.nfnd=!!v; return true;
    case "rit": r.rit=!!v; return true;
    case "clock": if(!CLOCKS.includes(n)) return false; r.clock=n; return true;
    case "bombAmt": r.bombAmt=Math.max(1,Math.min(100000,n)); return true;
    case "solverStudents": if(!["off","between","always"].includes(v)) return false; r.solverStudents=v; return true;
    case "stoveStudents": if(!["off","between","always"].includes(v)) return false; r.stoveStudents=v; return true;
  }
  return false;
}

export function freshGame(lname){
  return {v:3,lname:lname||"",size:6,blinds:{sb:1,bb:2},hand:0,button:0,phase:"idle",toAct:null,turn:0,curBet:0,minRaise:2,
    board:[],board2:null,ritOn:false,ritFrom:0,plan:[null,null,null,null,null],revealAll:false,keepSetup:false,log:[],result:"",
    rules:defaultRules(),straddleNext:false,bombNext:false,bomb:false,rakeTotal:0,handRake:0,deadline:null,clockTurn:null,
    seats:Array.from({length:9},(_,i)=>({name:NAMES[i],stack:200,uid:null,out:false,pre:[null,null],cards:null,bet:0,total:0,folded:false,allin:false,acted:false,shown:false}))};
}

/* position names, in order from the button, for n dealt players */
export function posNames(n){
  if(n<=2) return ["BTN","BB"];
  const m=n-3;
  return ["BTN","SB","BB",...(m<=3?["UTG","HJ","CO"].slice(3-m):["UTG",...["UTG+1","UTG+2"].slice(0,m-4),"LJ","HJ","CO"])];
}

/* ---------- the engine: one per table ---------- */
export function createEngine(opts={}){
  let G=null; const history=[];
  const msg=opts.onMessage||(()=>{});
  const S=i=>G.seats[i];
  const live=i=>i<G.size&&S(i).cards&&!S(i).folded;
  const canAct=i=>live(i)&&!S(i).allin;
  const range=()=>[...Array(G.size).keys()];
  function nextSeat(from,pred){for(let k=1;k<=G.size;k++){const i=(from+k)%G.size; if(pred(i)) return i} return null}
  const between=()=>G.phase==="idle"||G.phase==="done";
  function used(){const u=new Set();const b=between();for(const s of G.seats){if(!b)(s.cards||[]).forEach(c=>c&&u.add(c));(s.pre||[]).forEach(c=>c&&u.add(c))}
    if(!b){G.board.forEach(c=>u.add(c));(G.board2||[]).forEach(c=>u.add(c))}G.plan.forEach(c=>c&&u.add(c));return u}
  function hostCards(s){if(!between()) return {cs:s.cards,pre:false};if(s.pre.some(Boolean)||!s.cards) return {cs:s.pre,pre:true};return {cs:s.cards,pre:false}}
  function draw(){const u=used();const av=FULL.filter(c=>!u.has(c));return av[Math.floor(Math.random()*av.length)]}
  function log(t){G.log.push(t); if(G.log.length>80) G.log.shift()}
  const label=i=>`Seat ${i+1} ${S(i).name}`;
  function put(i,amt){const s=S(i);const a=Math.max(0,Math.min(amt,s.stack));s.stack-=a;s.bet+=a;s.total+=a;if(s.stack===0)s.allin=true;return a}
  function dead(i,amt){const s=S(i);const a=Math.max(0,Math.min(amt,s.stack));s.stack-=a;s.total+=a;if(s.stack===0)s.allin=true;return a}
  const readySeat=i=>i<G.size&&!S(i).out&&S(i).stack>0;
  const readyCount=()=>range().filter(readySeat).length;
  function setToAct(i){G.toAct=i;G.turn=(G.turn||0)+1}

  function startHand(){
    const ready=readySeat, n=readyCount(), r=G.rules;
    if(n<2){msg("Need at least two seated players with chips.");return false}
    if(G.hand>0||!ready(G.button)) G.button=nextSeat(G.button,ready);
    G.hand++; G.board=[]; G.board2=null; G.ritOn=false; G.ritFrom=0; G.result=""; G.handRake=0; G.bomb=false; G.spots=[]; G.pf=[]; G.line=[];
    G.phase="preflop"; G.curBet=G.blinds.bb; G.minRaise=G.blinds.bb;
    const pre=G.seats.map(s=>s.pre.slice());
    for(let i=0;i<9;i++){const s=S(i);Object.assign(s,{cards:null,bet:0,total:0,folded:false,allin:false,acted:false,shown:false})}
    for(let i=0;i<G.size;i++) if(ready(i)) S(i).cards=[pre[i][0],pre[i][1]];
    for(let i=0;i<G.size;i++) if(ready(i)) S(i).pre=[null,null];
    for(let i=0;i<G.size;i++) if(ready(i)){const c=S(i).cards;for(let k=0;k<2;k++) if(!c[k]) c[k]=draw()}
    if(G.keepSetup) G.seats.forEach((s,i)=>{if(pre[i]) s.keep=pre[i]});
    log(`— Hand #${G.hand} · button ${label(G.button)}`);
    {const dealt=[];let j=G.button;for(let k=0;k<G.size;k++){if(S(j).cards) dealt.push(j);j=(j+1)%G.size}
     const names=posNames(dealt.length);G.pos={};dealt.forEach((j,k)=>{G.pos[j]=names[k]})}
    if(G.bombNext){
      G.bombNext=false; G.straddleNext=false; G.bomb=true; G.curBet=0;
      const amt=Math.max(1,r.bombAmt|0);
      range().filter(i=>S(i).cards).forEach(i=>dead(i,amt));
      log(`Bomb pot: everyone puts in ${money(amt)}, straight to the flop`);
      advanceStreet(); return true;
    }
    if(r.anteType==="each"&&r.ante>0){range().filter(i=>S(i).cards).forEach(i=>dead(i,r.ante));log(`Everyone antes ${money(r.ante)}`)}
    const heads=n===2;
    const sb=heads?G.button:nextSeat(G.button,ready), bb=nextSeat(sb,ready);
    put(sb,G.blinds.sb); log(`${label(sb)} posts SB ${money(S(sb).bet)}`);
    put(bb,G.blinds.bb); log(`${label(bb)} posts BB ${money(S(bb).bet)}`);
    if(r.anteType==="bb"&&r.ante>0){const a=dead(bb,r.ante);if(a) log(`${label(bb)} posts the big blind ante ${money(a)}`)}
    let last=bb;
    const doStraddle=(r.straddle||G.straddleNext)&&n>=3&&r.straddleAmt>G.blinds.bb;
    G.straddleNext=false;
    if(doStraddle){
      const st=nextSeat(bb,ready);
      if(st!==null&&st!==sb&&st!==bb&&S(st).stack>0){
        put(st,r.straddleAmt); log(`${label(st)} straddles ${money(S(st).bet)}${S(st).allin?" (all-in)":""}`);
        if(S(st).bet>G.curBet){G.curBet=S(st).bet; G.minRaise=S(st).bet>=r.straddleAmt?r.straddleAmt:G.blinds.bb}
        last=st;
      }
    }
    setToAct(nextSeat(last,canAct));
    if(G.toAct===null||roundDone()) advanceStreet();
    return true;
  }
  function roundDone(){
    const acts=range().filter(canAct);
    if(acts.length===0) return true;
    return acts.every(i=>S(i).acted&&S(i).bet===G.curBet);
  }
  function liveCount(){return range().filter(live).length}
  function act(i,type,amt){
    if(G.toAct!==i||!["preflop","flop","turn","river"].includes(G.phase)) return false;
    const s=S(i), toCall=Math.max(0,G.curBet-s.bet);
    if(type==="fold"){s.folded=true;log(`${label(i)} folds`)}
    else if(type==="check"){if(toCall>0) return false; log(`${label(i)} checks`)}
    else if(type==="call"){if(toCall===0) return act(i,"check"); const a=put(i,toCall); log(`${label(i)} calls ${money(a)}${s.allin?" (all-in)":""}`)}
    else if(type==="raise"||type==="allin"){
      const maxTo=s.bet+s.stack; let to=type==="allin"?maxTo:Math.min(Math.round(Number.isFinite(amt)?amt:0),maxTo);
      const minTo=G.curBet===0?Math.min(G.blinds.bb,maxTo):Math.min(G.curBet+G.minRaise,maxTo);
      if(to<minTo) to=minTo;
      if(to<=G.curBet){return act(i,"call")}
      const wasBet=G.curBet===0, inc=to-G.curBet;
      put(i,to-s.bet);
      if(inc>=G.minRaise){G.minRaise=inc; G.seats.forEach((o,j)=>{if(j!==i) o.acted=false})}
      G.curBet=to;
      log(`${label(i)} ${wasBet?"bets":"raises to"} ${money(to)}${s.allin?" (all-in)":""}`);
      if(G.phase==="preflop"){(G.pf=G.pf||[]).push(i)}
      else (G.line=G.line||[]).push({st:G.phase,i,a:wasBet?"bet":"raise",to:s.bet,all:!!s.allin});
    } else return false;
    if(type!=="raise"&&type!=="allin"&&G.phase!=="preflop") (G.line=G.line||[]).push({st:G.phase,i,a:type,to:s.bet,all:!!s.allin});
    s.acted=true;
    if(liveCount()===1){winByFold();return true}
    if(roundDone()) advanceStreet(); else setToAct(nextSeat(i,canAct));
    return true;
  }
  function dealTo(n){while(G.board.length<n){const k=G.board.length;let c=G.plan[k];G.plan[k]=null;if(!c||G.board.includes(c)) c=draw();G.board.push(c)}}
  function advanceStreet(){
    for(;;){
      G.seats.forEach(s=>{s.bet=0;s.acted=false}); G.curBet=0; G.minRaise=G.blinds.bb;
      const order=["preflop","flop","turn","river"]; const idx=order.indexOf(G.phase);
      if(G.phase==="river"){showdown();return}
      if(range().filter(canAct).length<2&&G.rules.rit&&!G.ritOn&&liveCount()>=2&&G.board.length<5){
        G.ritOn=true; G.ritFrom=G.board.length; log("All-in: running it twice");
      }
      G.phase=order[idx+1]; dealTo({flop:3,turn:4,river:5}[G.phase]);
      log(`${STREETS[G.phase]}: ${G.board.map(pretty).join(" ")}`);
      if(range().filter(canAct).length>=2){noteSpot();setToAct(nextSeat(G.button,canAct));return}
      setToAct(null);
    }
  }
  /* what the solver needs about the start of each street with a decision */
  function noteSpot(){
    const lv=range().filter(live).sort((a,b)=>(a-G.button-1+G.size)%G.size-(b-G.button-1+G.size)%G.size);
    const pf=G.pf||[], agg=pf.length?pf[pf.length-1]:null;
    (G.spots=G.spots||[]).push({st:G.phase,board:G.board.slice(),pot:G.seats.reduce((a,s)=>a+s.total,0),bomb:!!G.bomb,raises:pf.length,
      pl:lv.map(i=>({i,name:S(i).name,stack:S(i).stack,pos:(G.pos||{})[i]||"",agg:i===agg}))});
  }
  function pots(){
    const contrib=G.seats.map((s,i)=>i<G.size?s.total:0);
    const levels=[...new Set(range().filter(live).map(i=>contrib[i]))].sort((a,b)=>a-b);
    const out=[]; let prev=0;
    levels.forEach((L,li)=>{let amt=0;contrib.forEach(c=>{amt+=Math.max(0,Math.min(c,L)-prev)});
      if(li===levels.length-1) contrib.forEach(c=>{if(c>L) amt+=c-L});
      out.push({amt,elig:range().filter(i=>live(i)&&contrib[i]>=L)}); prev=L});
    return out;
  }
  function rakeFor(rakeable){
    const r=G.rules; if(!(r.rakePct>0)||rakeable<=0) return 0;
    if(r.nfnd&&G.board.length===0) return 0;
    let x=Math.floor(rakeable*r.rakePct/100); if(r.rakeCap>0) x=Math.min(x,r.rakeCap);
    return Math.max(0,Math.min(x,rakeable));
  }
  function noteRake(x){if(!x) return; G.handRake=x; G.rakeTotal=(G.rakeTotal||0)+x; log(`House takes ${money(x)} rake`)}
  function award(i,amt){S(i).stack+=amt}
  function winByFold(){
    const w=range().find(live); const total=G.seats.reduce((a,s)=>a+s.total,0);
    const maxOther=Math.max(0,...G.seats.map((s,i)=>i===w?0:s.total));
    const uncalled=Math.max(0,S(w).total-maxOther);
    const x=rakeFor(total-uncalled); noteRake(x);
    award(w,total-x); G.result=`${S(w).name} wins ${money(total-x)}`; log(G.result); finish();
  }
  function showdown(){
    const runs=[G.board];
    if(G.ritOn){
      G.board2=G.board.slice(0,G.ritFrom);
      while(G.board2.length<5) G.board2.push(draw());
      log(`Second board: ${G.board2.map(pretty).join(" ")}`); runs.push(G.board2);
    }
    const lv=range().filter(live); lv.forEach(i=>{S(i).shown=true});
    const ranks=runs.map(b=>{const o={};lv.forEach(i=>{o[i]=evaluate(S(i).cards.concat(b))});return o});
    const order=range().map(k=>(G.button+1+k)%G.size);
    const P=pots();
    let x=rakeFor(P.filter(p=>p.elig.length>1).reduce((a,p)=>a+p.amt,0)); noteRake(x);
    for(const p of P){if(!x) break; if(p.elig.length<2) continue; const t=Math.min(p.amt,x); p.amt-=t; x-=t}
    const lines=[];
    P.forEach((p,pi)=>{
      if(!p.amt) return;
      if(p.elig.length===1){award(p.elig[0],p.amt);lines.push(`${S(p.elig[0]).name} gets ${money(p.amt)} back`);return}
      const half=Math.floor(p.amt/2); const parts=runs.length===2?[half,p.amt-half]:[p.amt];
      parts.forEach((amt,ri)=>{
        if(!amt) return;
        const rk=ranks[ri]; let best=null,win=[];
        p.elig.forEach(i=>{const c=best?cmp(rk[i],best):1;if(c>0){best=rk[i];win=[i]}else if(c===0)win.push(i)});
        const share=Math.floor(amt/win.length); let rem=amt-share*win.length;
        win.sort((a,b)=>order.indexOf(a)-order.indexOf(b)).forEach(i=>{award(i,share+(rem>0?1:0));rem--});
        lines.push(`${win.map(i=>S(i).name).join(" & ")} ${win.length>1?"split":"wins"} ${pi?"side pot":"pot"}${runs.length===2?` (run ${ri+1})`:""} ${money(amt)} with ${CAT[best[0]].toLowerCase()}`);
      });
    });
    G.result=lines.join(" · "); lines.forEach(log); finish();
  }
  function finish(){
    G.phase="done"; setToAct(null); G.seats.forEach(s=>{s.bet=0});
    if(G.keepSetup) G.seats.forEach(s=>{if(s.keep){s.pre=s.keep;delete s.keep}});
    else G.seats.forEach(s=>delete s.keep);
  }

  /* teacher commands */
  function slotCard(kind,i,k){if(kind==="board") return between()?G.plan[k]:(G.board[k]||G.plan[k]||null);const s=G.seats[i];return between()?s.pre[k]:((s.cards||s.pre)[k]||null)}
  function pickOp(o){
    const kind=o.kind==="board"?"board":"seat", i=o.i|0, k=o.k|0;
    if(kind==="board"?(k<0||k>4):(!G.seats[i]||k<0||k>1)) return false;
    let card=o.card==="random"?draw():(o.card||null);
    if(card&&!FULL.includes(card)) return false;
    if(card&&card!==slotCard(kind,i,k)&&used().has(card)) return false;
    if(kind==="board"){ if(!between()&&k<G.board.length){ if(!card) card=draw(); G.board[k]=card } else G.plan[k]=card }
    else { const s=G.seats[i]; if(!between()&&s.cards){ if(!card) card=draw(); s.cards[k]=card; log(`Teacher changed a card for ${label(i)}`) } else s.pre[k]=card }
    return true;
  }
  function applyOp(o){
    if(!o||typeof o.t!=="string") return false;
    const n=v=>Math.round(+v||0);
    const seat=()=>Number.isInteger(o.i)&&G.seats[o.i]?G.seats[o.i]:null;
    switch(o.t){
      case "pick": return pickOp(o);
      case "unseat":{const s=seat();if(!s||!s.uid) return false;log(`${s.name} unseated`);s.uid=null;return true}
      case "out":{const s=seat();if(!s) return false;s.out=!!o.v;return true}
      case "btn":{const i=n(o.i);if(!between()||i<0||i>=G.size) return false;G.button=i;return true}
      case "deal": if(!between()) return false; return startHand();
      case "reset":{const keep=G.seats.map(s=>s.uid);const ln=G.lname,rules=G.rules;G=freshGame(ln);G.rules=rules;G.seats.forEach((s,i)=>{s.uid=keep[i]});return true}
      case "voidhand": if(between()) return false;
        G.seats.forEach(s=>{s.stack+=s.total;Object.assign(s,{cards:null,bet:0,total:0,folded:false,allin:false,acted:false,shown:false})});
        G.board=[];G.board2=null;G.ritOn=false;G.phase="idle";setToAct(null);G.result="";log("Hand cancelled; chips returned");return true;
      case "allstacks":{const v=Math.max(0,n(o.v));G.seats.forEach(s=>{s.stack=v});return true}
      case "name":{const s=seat();if(!s) return false;s.name=String(o.v||"").trim().slice(0,16)||NAMES[o.i];return true}
      case "stack":{const s=seat();if(!s) return false;s.stack=Math.max(0,n(o.v));if(s.stack>0&&s.allin&&G.phase!=="done")s.allin=false;return true}
      case "size":{const v=n(o.v);if(v<2||v>9||!between()) return false;G.size=v;if(G.button>=v)G.button=0;G.seats.forEach((s,i)=>{if(i>=v)s.uid=null});return true}
      case "sb": G.blinds.sb=Math.max(0,n(o.v)); return true;
      case "bb": G.blinds.bb=Math.max(1,n(o.v)); return true;
      case "reveal": if(G.revealAll===!!o.v) return false; G.revealAll=!!o.v; log(G.revealAll?"Teacher revealed every hand to students":"Teacher hid the hands again"); return true;
      case "keep": G.keepSetup=!!o.v; return true;
      case "lname": G.lname=String(o.v||"").trim().slice(0,28)||G.lname; return true;
      case "rule": return setRule(G.rules,String(o.k),o.v);
      case "straddleNext": G.straddleNext=!!o.v; if(G.straddleNext) G.bombNext=false; return true;
      case "bombNext": G.bombNext=!!o.v; if(G.bombNext) G.straddleNext=false; return true;
      case "rakereset": G.rakeTotal=0; log("Rake counter reset"); return true;
      case "time": if(G.toAct==null||!G.deadline) return false; G.deadline+=30000; log(`${label(G.toAct)} gets 30 more seconds`); return true;
      case "timeout":{
        if(G.toAct==null||o.turn!==G.turn) return false;
        const i=G.toAct, s=S(i), toCall=Math.max(0,G.curBet-s.bet);
        log(`${label(i)} ran out of time`); return act(i,toCall>0?"fold":"check",0);
      }
      case "act": return act(n(o.seat),String(o.a),Number(o.amt)||0);
    }
    return false;
  }
  function undo(){if(!history.length) return false;const prev=history.pop();prev.seats.forEach((s,i)=>{s.uid=G.seats[i].uid});G=prev;return true}
  function runOp(o){
    if(o&&o.t==="undo") return undo();
    const snap=clone(G); const ok=applyOp(o);
    if(ok===false){G=snap;return false}
    history.push(snap); if(history.length>40) history.shift(); return true;
  }
  /* students: seat requests and their own actions */
  function seatReq(uid,name,want){
    const cur=G.seats.findIndex(s=>s.uid===uid);
    if(want===-1){if(cur<0) return false;G.seats[cur].uid=null;log(`${G.seats[cur].name} left seat ${cur+1}`);return true}
    if(!Number.isInteger(want)||want<0||want>=G.size||want===cur||G.seats[want].uid) return false;
    if(cur>=0) G.seats[cur].uid=null;
    const s=G.seats[want]; s.uid=uid; if(name) s.name=String(name).slice(0,16); s.out=false;
    log(`${s.name} took seat ${want+1}`); return true;
  }
  function actFor(uid,a,amt){const seat=G.seats.findIndex(s=>s.uid===uid);if(seat<0||G.toAct!==seat) return false;return runOp({t:"act",seat,a,amt})}
  /* shot clock: (re)start the timer whenever the action moves to a new turn */
  function armClock(now){
    const c=G.rules.clock|0;
    if(G.toAct!=null&&c>0){ if(G.clockTurn!==G.turn){G.clockTurn=G.turn;G.deadline=now+c*1000} }
    else {G.deadline=null;G.clockTurn=null}
    return G.deadline;
  }
  function pubView(){
    const r=G.rules;
    return {v:3,lname:G.lname,size:G.size,blinds:G.blinds,hand:G.hand,button:G.button,phase:G.phase,toAct:G.toAct,turn:G.turn,curBet:G.curBet,minRaise:G.minRaise,
      board:G.board,board2:G.board2,result:G.result,log:G.log.slice(-50),reveal:!!G.revealAll,deadline:G.deadline,
      rules:{anteType:r.anteType,ante:r.ante,straddle:r.straddle,straddleAmt:r.straddleAmt,rakePct:r.rakePct,rakeCap:r.rakeCap,nfnd:r.nfnd,rit:r.rit,clock:r.clock,bombAmt:r.bombAmt,solverStudents:r.solverStudents||"between",stoveStudents:r.stoveStudents||"between"},spots:G.spots||[],line:G.line||[],
      straddleNext:G.straddleNext,bombNext:G.bombNext,bomb:G.bomb,handRake:G.handRake,
      seats:G.seats.map(s=>({name:s.name,stack:s.stack,uid:s.uid,out:s.out,bet:s.bet,total:s.total,folded:s.folded,allin:s.allin,has:!!s.cards,
        cards:(s.cards&&(G.revealAll||s.shown))?s.cards:null}))};
  }
  return {get G(){return G}, set G(v){G=v}, history, S, between, used, hostCards, draw, readyCount, slotCard,
    startHand, runOp, applyOp, seatReq, actFor, armClock, pubView, pots};
}
