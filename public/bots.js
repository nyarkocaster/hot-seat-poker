// Hot Seat Poker bots: computer players with a playing style ("player type").
// Pure JavaScript, shared by the server (bots in lobbies) and the browser (practice table).
// A bot only uses what a real player at its seat would know: its own two cards, the board,
// the pot and stacks, and the actions so far. It never looks at anyone else's cards.
import {evaluate,cmp,FULL,BOT_KEYS} from "./engine.js";

/* Preflop hand order, best first: equity against a random hand, nudged for suited,
   connected and small-pair hands that play well in multiway pots. */
const ORDER="AA KK QQ JJ TT 99 88 AKs AQs 77 AJs AKo 66 ATs KQs AQo KJs A9s AJo KQo 55 QJs A8s ATo KTs A7s K9s KJo QTs A6s A5s A9o JTs A4s A8o 44 QJo K8s KTo A3s K7s A7o A2s Q9s QTo K9o A5o Q8s K6s A6o J9s A4o K5s K8o JTo 33 T9s K4s A3o A2o Q7s K7o Q9o J8s K3s Q6s K2s Q5s T8s K6o J9o 98s K5o J7s T9o Q4s Q8o 22 K4o Q2s T7s J8o J6s Q3s Q7o K3o K2o Q6o 97s J5s T6s 87s J7o Q5o J4s T8o J3s 98o Q4o 96s T5s J2s 76s Q3o T4s 86s T3s T7o J6o J5o 95s Q2o 97o T6o T2s 87o 94s 75s 85s J4o 93s J3o 65s J2o T5o 92s 96o T4o 86o 64s 84s 54s 76o 74s T3o 95o 83s T2o 73s 53s 65o 85o 82s 75o 43s 63s 94o 84o 93o 72s 52s 42s 54o 92o 32s 64o 74o 62s 83o 82o 73o 53o 43o 63o 72o 52o 42o 62o 32o".split(" ");
const R="AKQJT98765432";
const combos=h=>h.length===2?6:h[2]==="s"?4:12;
export const PCT={}; // hand -> share of all starting hands at least this good (0..1)
{let n=0;for(const h of ORDER){n+=combos(h);PCT[h]=(n-combos(h)/2)/1326}}
export function handKey(a,b){
  let x=a[0],y=b[0]; if(R.indexOf(x)>R.indexOf(y)){[x,y]=[y,x]}
  return x===y?x+y:x+y+(a[1]===b[1]?"s":"o");
}

/* player types. vpip / pfr are the share of hands played / raised preflop (in %, at a 6-max table);
   agg is how often it bets or raises its good hands, bluff how often it bets or raises with weak ones,
   fold how readily it gives up when someone bets (0 = never folds, 100 = folds a lot), size its usual bet as a share of the pot. */
export const BOT_TYPES={
  balanced:{label:"Balanced",short:"Balanced",vpip:24,pfr:19,agg:58,bluff:33,fold:40,size:.66,
    blurb:"GTO-style play: opens by position, defends about as often as the price says, and bluffs in proportion to its bets. An approximation, not a solved strategy."},
  nit:{label:"Nit",short:"Nit",vpip:12,pfr:9,agg:45,bluff:6,fold:78,size:.55,
    blurb:"Plays very few hands and gives up when it meets resistance. Steal its blinds and bluff it more."},
  tag:{label:"TAG (tight-aggressive)",short:"TAG",vpip:21,pfr:17,agg:62,bluff:24,fold:52,size:.66,
    blurb:"A solid regular: good hands, played fast. Hard to exploit, so look for spots where it folds a bit too much."},
  lag:{label:"LAG (loose-aggressive)",short:"LAG",vpip:33,pfr:27,agg:72,bluff:45,fold:38,size:.75,
    blurb:"Opens wide, 3-bets often and keeps betting. Defend wider and call down a bit lighter."},
  station:{label:"Calling station",short:"Station",vpip:46,pfr:6,agg:18,bluff:4,fold:8,size:.5,
    blurb:"Calls far too much and rarely raises. Value bet thin and big, and don't bluff it."},
  maniac:{label:"Maniac",short:"Maniac",vpip:62,pfr:46,agg:90,bluff:72,fold:18,size:1,
    blurb:"Raises and bluffs constantly. Tighten up, let it bet into you, and call down with good hands."},
  fish:{label:"Weak-passive fish",short:"Fish",vpip:40,pfr:7,agg:20,bluff:8,fold:60,size:.4,
    blurb:"Limps and calls preflop, then folds when it misses. Raise its limps and bet when it checks."},
  custom:{label:"Custom",short:"Custom",vpip:28,pfr:20,agg:55,bluff:30,fold:45,size:.66,
    blurb:"Your own mix. Set how loose, aggressive and stubborn it is with the sliders."}
};
export const BOT_ORDER=BOT_KEYS;
export const botLabel=k=>(BOT_TYPES[k]||{}).short||"";
export function botParams(seat){
  const t=BOT_TYPES[seat&&seat.bot]||BOT_TYPES.balanced;
  const p={vpip:t.vpip,pfr:t.pfr,agg:t.agg,bluff:t.bluff,fold:t.fold,size:t.size};
  if(seat&&seat.bot==="custom"&&seat.bp) for(const k of ["vpip","pfr","agg","bluff","fold"]) if(Number.isFinite(seat.bp[k])) p[k]=seat.bp[k];
  if(p.pfr>p.vpip) p.pfr=p.vpip;
  if(seat&&seat.bot==="custom") p.size=.4+p.agg/100*.6;
  return p;
}

/* how much wider than average a seat plays, by position */
const POS={UTG:.6,"UTG+1":.66,"UTG+2":.72,LJ:.8,HJ:.9,CO:1.15,BTN:1.6,SB:1.1,BB:1};
function posMult(pos,n){
  if(n<=2) return pos==="BTN"?3.4:2;
  if(n===3) return pos==="BTN"?1.9:pos==="SB"?1.5:1.2;
  return POS[pos]||1;
}

/* deal a random opponent hand from the top share W of starting hands, avoiding dead cards.
   aggr = how many times they bet or raised after the flop: each one makes a hand that missed the board less likely. */
function sampleHand(deck,dead,W,aggr,board,boardRank,rnd){
  let a,b;
  for(let t=0;t<80;t++){
    a=deck[Math.floor(rnd()*deck.length)]; b=deck[Math.floor(rnd()*deck.length)];
    if(a===b||dead.has(a)||dead.has(b)) continue;
    if(PCT[handKey(a,b)]>W&&t<70) continue;
    if(aggr>0&&board.length&&t<70){
      const hit=evaluate([a,b,...board])[0]>boardRank||(board.length<5&&flushDraw([a,b],board));
      if(!hit&&rnd()>Math.pow(.3,aggr)) continue;
    }
    return [a,b];
  }
  return [a,b];
}
function flushDraw(h,board){const c={};for(const x of [...h,...board]) c[x[1]]=(c[x[1]]||0)+1;return Object.values(c).some(v=>v>=4)}

/* Monte Carlo share of the pot this hand wins against the opponents' likely hands */
export function equity(mine,board,opps,iters=400,rnd=Math.random){
  const dead0=new Set([...mine,...board]);
  const deck=FULL.filter(c=>!dead0.has(c));
  const boardRank=board.length>=3?evaluate(board)[0]:0;
  let win=0;
  for(let t=0;t<iters;t++){
    const dead=new Set(dead0), hands=[];
    for(const o of opps){const h=sampleHand(deck,dead,o.w,o.aggr,board,boardRank,rnd);dead.add(h[0]);dead.add(h[1]);hands.push(h)}
    const b=board.slice(); const rest=deck.filter(c=>!dead.has(c));
    while(b.length<5){const k=Math.floor(rnd()*rest.length);b.push(rest[k]);rest.splice(k,1)}
    const me=evaluate(mine.concat(b)); let best=1, ties=1;
    for(const h of hands){const c=cmp(evaluate(h.concat(b)),me); if(c>0){best=0;break} if(c===0) ties++}
    if(best) win+=1/ties;
  }
  return win/iters;
}

/* what each opponent probably holds, from how they played this hand */
function oppRanges(G,i){
  const pf=G.pf||[], out=[];
  for(let j=0;j<G.size;j++){
    const s=G.seats[j]; if(j===i||!s.cards||s.folded) continue;
    let w=.45;
    const nr=pf.filter(x=>x===j).length;
    if(nr>=2) w=.04; else if(nr===1) w=pf.indexOf(j)>=1?.07:.17;
    else if(pf.length===0) w=.75; // limped or checked the big blind
    else if(pf.length>=2) w=.12;
    const aggr=(G.line||[]).filter(x=>x.i===j&&(x.a==="bet"||x.a==="raise")).length;
    out.push({w,aggr});
  }
  return out;
}

const potOf=G=>G.seats.reduce((a,s)=>a+s.total,0);

/* the bot's move: {a:"fold"|"check"|"call"|"raise"|"allin", amt (raise to)} */
export function decide(G,i,rnd=Math.random){
  const s=G.seats[i], p=botParams(s), bb=G.blinds.bb;
  const toCall=Math.max(0,G.curBet-s.bet), maxTo=s.bet+s.stack, pot=potOf(G);
  const checkOr=a=>toCall>0?{a}:{a:"check"};
  const raiseTo=to=>{
    to=Math.round(to); const minTo=G.curBet===0?Math.min(bb,maxTo):Math.min(G.curBet+G.minRaise,maxTo);
    if(to<minTo) to=minTo;
    if(to>=maxTo*.7||to>=maxTo) return {a:"allin"};
    if(to<=G.curBet) return toCall>0?{a:"call"}:{a:"check"};
    return {a:"raise",amt:to};
  };
  if(maxTo<=G.curBet) return toCall>0?{a:"call"}:{a:"check"};
  if(!s.cards) return checkOr("fold");
  const n=Object.keys(G.pos||{}).length||G.size, pos=(G.pos||{})[i]||"";
  if(G.phase==="preflop"){
    const pct=PCT[handKey(s.cards[0],s.cards[1])], m=posMult(pos,n), raises=(G.pf||[]).length;
    const eff=Math.min(maxTo,Math.max(...G.seats.map((o,j)=>j!==i&&o.cards&&!o.folded?o.bet+o.stack:0)))/bb;
    const limpers=G.seats.filter((o,j)=>j!==i&&o.cards&&!o.folded&&o.bet===G.curBet&&o.acted).length;
    // short stacks: push or fold
    if(eff<=12){
      const pushW=Math.min(.7,(p.pfr/100)*m*1.5+(12-eff)*.025);
      if(raises===0&&pct<pushW) return {a:"allin"};
      if(raises>0){const callW=Math.min(.5,.08+(p.vpip/100)*.25*(1.4-p.fold/100));return pct<callW?{a:"allin"}:checkOr("fold")}
    }
    if(raises===0){
      const openW=(p.pfr/100)*m, limpW=(p.vpip/100)*m;
      if(pct<openW||(pct<openW*1.8&&rnd()<p.bluff/400)) return raiseTo((pos==="SB"?3:p.vpip>50?3.5:2.5)*bb+limpers*bb);
      if(toCall===0) return {a:"check"};
      if(pct<limpW&&p.vpip-p.pfr>8) return {a:"call"};
      if(pos==="SB"&&pct<limpW*1.2&&p.vpip-p.pfr>15) return {a:"call"};
      return {a:"fold"};
    }
    // facing a raise
    const size=G.curBet/bb, odds=toCall/(pot+toCall);
    const defend=pos==="BB"?1.55:pos==="BTN"?1.25:pos==="SB"?.85:pos==="CO"?1.1:1;
    const stub=1.3-p.fold/100*.6;
    let reW,callW;
    if(raises===1){reW=(p.pfr/100)*.3*Math.sqrt(m);callW=(p.vpip/100)*.6*defend*stub*Math.min(1,3.2/size)}
    else if(raises===2){reW=(p.pfr/100)*.09;callW=(p.vpip/100)*.22*stub*Math.min(1,10/size)}
    else {reW=.022;callW=(p.vpip/100)*.06*stub}
    if(odds<.2) callW*=1.25;
    if(n<=2) {callW*=2;reW*=1.6} else if(n===3) {callW*=1.4;reW*=1.2}
    if(pct<reW) return raiseTo(raises>=3?maxTo:G.curBet*(raises===1?(pos==="BB"||pos==="SB"?3.6:3):2.3));
    if(pct<reW+callW) return {a:"call"};
    if(raises===1&&pct<reW+callW+.12&&rnd()<p.bluff/500) return raiseTo(G.curBet*3);
    return {a:"fold"};
  }
  // after the flop
  const opps=oppRanges(G,i), nOpp=Math.max(1,opps.length);
  const eq=equity(s.cards,G.board,opps,Math.max(160,Math.round(520/nOpp)),rnd);
  const river=G.phase==="river", vt=.52+.06*(nOpp-1);
  const agg=p.agg/100, bluff=p.bluff/100, fold=p.fold/100;
  const betSize=f=>raiseTo(Math.max(bb,pot*f));
  const frac=(river?1.1:1)*p.size;
  if(toCall===0){
    if(eq>=vt+.15&&rnd()<Math.min(1,agg+.3)) return betSize(frac);
    if(eq>=vt&&rnd()<agg) return betSize(frac*(eq<vt+.08?.8:1));
    if(eq<.36&&rnd()<bluff*(river?.75:1)*(nOpp===1?1:.35)) return betSize(frac);
    if(eq>=.42&&!river&&rnd()<agg*.2) return betSize(frac*.6); // a protection bet now and then
    return {a:"check"};
  }
  const odds=toCall/(pot+toCall);
  const need=odds*(.72+.7*fold)*(river?1:.88);
  const allInCall=toCall>=s.stack;
  if(eq>=Math.max(.7,vt+.18)&&!allInCall&&rnd()<agg*.8) return raiseTo(G.curBet+(pot+toCall)*(.7+agg*.3));
  if(eq>=need) return {a:"call"};
  if(!river&&!allInCall&&nOpp===1&&eq<.3&&rnd()<bluff*.15) return raiseTo(G.curBet+(pot+toCall)*.8);
  return {a:"fold"};
}

/* a short, human pause before a bot acts */
export function thinkMs(G,rnd=Math.random){
  const humans=G.seats.some((s,j)=>j<G.size&&s.cards&&!s.folded&&!s.bot);
  return humans?650+Math.round(rnd()*850):320;
}
