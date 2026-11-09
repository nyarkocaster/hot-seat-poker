// Hot Seat Poker page: lobby list, table, teacher controls, live connection to the lobby server.
import {createEngine,freshGame,RANKS,SYM,STREETS,money,pretty} from "./engine.js";

const $=s=>document.querySelector(s);
const esc=t=>String(t==null?"":t).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rid=(n,al="abcdefghjkmnpqrstuvwxyz23456789")=>{const a=new Uint32Array(n);crypto.getRandomValues(a);return [...a].map(x=>al[x%al.length]).join("")};
function lsGet(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}

const E=createEngine({onMessage:t=>flash(t)});
const S=i=>E.G.seats[i];
const between=()=>E.between();
const ME={cid:lsGet("hsp-cid"),tok:lsGet("hsp-tok")};
if(!ME.cid||!/^[a-z0-9]{8,40}$/.test(ME.cid)){ME.cid=rid(16);lsSet("hsp-cid",ME.cid)}
if(!ME.tok||String(ME.tok).length<16){ME.tok=rid(32);lsSet("hsp-tok",ME.tok)}
let myName=lsGet("hsp-name")||"";

/* ---------- connection ---------- */
let mode=null, ROLE=null, L=null, TCODE="";
let ws=null, wsOpen=false, wantWs=false, retry=0, retryT=null, pingT=null, lastErr="";
let PUB=null, MINE=null, HIST=0, peers=[], myPeer=null, skew=0, welcomed=false;
const curs=new Map();
let homeList=null, homeListErr=false, needsKey=false, homeMsg="", teachFor=null, delConfirm=false;
const codes=()=>lsGet("hsp-codes")||{};
function saveCode(id,code){const c=codes();c[id]=code;lsSet("hsp-codes",c)}
function forgetCode(id){const c=codes();delete c[id];lsSet("hsp-codes",c)}
const isT=()=>ROLE==="teacher"&&!!E.G;

function connect(){
  clearTimeout(retryT); if(!L||!wantWs) return;
  const s=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/ws/${L.id}`); ws=s;
  s.onopen=()=>{if(ws!==s) return;retry=0;wsOpen=true;s.send(JSON.stringify({t:"hello",cid:ME.cid,tok:ME.tok,name:myName,role:ROLE,code:ROLE==="teacher"?TCODE:undefined}));sendCur(true);updateConn()};
  s.onmessage=e=>{if(ws!==s) return;let m;try{m=JSON.parse(e.data)}catch(x){return}onMsg(m)};
  s.onclose=e=>{
    if(ws!==s) return; wsOpen=false; ws=null;
    if(!wantWs) return;
    if([4000,4001,4004,4008].includes(e.code)){
      const id=L&&L.id, msg=lastErr||e.reason||"Couldn't open that lobby.";
      if(e.code===4001&&id) forgetCode(id);
      leaveLobby(); homeErr(msg); return;
    }
    retry=Math.min(retry+1,5); retryT=setTimeout(connect,400*2**retry); updateConn();
  };
}
function wsSend(o){if(ws&&wsOpen){ws.send(JSON.stringify(o));return true}flash("Reconnecting… try again in a moment.");return false}
function onMsg(m){
  if(m.t==="welcome"){welcomed=true;myPeer=m.peer;if(m.lobby&&L) L.name=m.lobby.name;if(ROLE==="teacher") saveCode(L.id,TCODE);updateConn()}
  else if(m.t==="state"){skew=(+m.now||Date.now())-Date.now();if(m.g){E.G=m.g;HIST=m.hist||0}else{PUB=m.pub;MINE=m.mine||null}render()}
  else if(m.t==="peers"){peers=Array.isArray(m.list)?m.list:[];for(const k of [...curs.keys()]) if(!peers.some(p=>p.peer===k)) curs.delete(k);updateConn();render();drawCursors()}
  else if(m.t==="cur"){if(!m.cur&&!(m.busy&&m.busy.length)) curs.delete(m.peer); else curs.set(m.peer,m);drawCursors();if(picker) render()}
  else if(m.t==="error"){lastErr=m.msg||"";if(m.msg) flash(m.msg)}
  else if(m.t==="deleted"){lastErr="This lobby was deleted."}
}

function enterLobby(id,role,code){
  homeErr("");
  myName=($("#homeName").value||myName||"").trim().slice(0,16);
  if(!myName){homeErr("Enter your name first.");$("#homeName").focus();return}
  lsSet("hsp-name",myName);
  leaveLobby(true);
  const d=(homeList||[]).find(x=>x.id===id);
  mode="lobby"; ROLE=role; TCODE=code||""; L={id,name:d?d.name:id.toUpperCase()};
  wantWs=true; retry=0; lastErr=""; welcomed=false; connect();
  pingT=setInterval(()=>{if(ws&&wsOpen) ws.send('{"t":"ping"}')},25000);
  setHash("lobby-"+id); updateConn(); render();
}
function leaveLobby(quiet){
  wantWs=false; clearTimeout(retryT); clearInterval(pingT); clearTimeout(localClockT);
  if(ws){try{ws.close()}catch(e){}} ws=null; wsOpen=false;
  mode=null; ROLE=null; L=null; TCODE=""; PUB=null; MINE=null; HIST=0; peers=[]; myPeer=null; curs.clear(); welcomed=false;
  E.G=null; E.history.length=0; picker=null; sideTab="seats"; confirmReset=false; myBusy="[]";
  if(!quiet){setHash("");loadLobbies();updateConn();render()}
}
function enterLocal(){
  leaveLobby(true); mode="local"; ROLE="teacher"; L={id:"",name:"Practice table"};
  E.G=freshGame("Practice table"); E.G.seats[0].pre=["As","Kh"]; E.startHand(); E.history.length=0;
  updateConn(); render();
}
function sendOp(op){
  if(!isT()) return;
  if(mode==="local"){E.runOp(op);localClock();render();return}
  wsSend({t:"op",op});
}
let localClockT=null;
function localClock(){
  clearTimeout(localClockT);
  const dl=E.armClock(Date.now()); if(!dl) return;
  localClockT=setTimeout(()=>{if(mode==="local"&&E.G&&E.runOp({t:"timeout",turn:E.G.turn})){localClock();render()}},Math.max(0,dl-Date.now()));
}

/* ---------- home: lobby list ---------- */
async function loadLobbies(){
  try{const r=await fetch("/api/lobbies",{cache:"no-store"});const j=await r.json();homeList=Array.isArray(j.lobbies)?j.lobbies:[];needsKey=!!j.needsKey;homeListErr=false}
  catch(e){homeListErr=true}
  if(!mode) render();
}
setInterval(()=>{if(!mode&&!document.hidden) loadLobbies()},5000);
document.addEventListener("visibilitychange",()=>{if(!mode&&!document.hidden) loadLobbies()});
async function createLobby(){
  myName=($("#homeName").value||myName||"").trim().slice(0,16);
  if(!myName){homeErr("Enter your name first.");$("#homeName").focus();return}
  lsSet("hsp-name",myName);
  const name=($("#newName").value||"").trim().slice(0,28)||`${myName}'s table`;
  const code=($("#newCode").value||"").trim();
  if(code.replace(/\s/g,"").length<4){homeErr("The teacher code needs at least 4 letters or numbers.");$("#newCode").focus();return}
  const btn=$("#createBtn"); btn.disabled=true;
  try{
    const r=await fetch("/api/lobbies",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,code,key:$("#newKey").value||undefined})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){if(j.needsKey){needsKey=true;render()}homeErr(j.error||"Couldn't create the lobby.");return}
    saveCode(j.id,code); $("#newName").value=""; $("#newCode").value=suggestCode();
    enterLobby(j.id,"teacher",code);
  }catch(e){homeErr("Couldn't reach the server. Check your connection and try again.")}
  finally{btn.disabled=false}
}
async function deleteLobby(id,code){
  try{
    const r=await fetch(`/api/lobbies/${id}/delete`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){homeErr(j.error||"Couldn't delete that lobby.");return}
    forgetCode(id); teachFor=null; delConfirm=false; homeErr("Lobby deleted."); loadLobbies();
  }catch(e){homeErr("Couldn't reach the server.")}
}
const suggestCode=()=>rid(4,"ABCDEFGHJKMNPQRSTUVWXYZ23456789")+"-"+rid(4,"ABCDEFGHJKMNPQRSTUVWXYZ23456789");
function setHash(h){try{if(location.hash.slice(1)!==h) history.replaceState(null,"",h?"#"+h:location.pathname+location.search)}catch(e){}}

/* ---------- rendering ---------- */
function cardHTML(c,opts={}){
  const tag=opts.btn?"button":"span"; const attrs=opts.btn?` type="button" ${opts.btn}`:"";
  if(c==="back") return `<${tag} class="pc back"${attrs} aria-label="Face-down card"></${tag}>`;
  if(!c) return `<${tag} class="pc slot${opts.cls?" "+opts.cls:""}"${attrs} aria-label="${opts.empty||"Empty card slot"}">${opts.plus?'<span class="s">+</span>':""}</${tag}>`;
  return `<${tag} class="pc ${c[1]}${opts.cls?" "+opts.cls:""}"${attrs} aria-label="${pretty(c)}"><span class="r">${c[0]==="T"?"10":c[0]}</span><span class="s">${SYM[c[1]]}</span></${tag}>`;
}
function view(){return isT()?pubLike():PUB}
function pubLike(){const p=E.pubView();p.seats=E.G.seats.map((s,i)=>({...p.seats[i],cards:s.cards,pre:s.pre}));p.plan=E.G.plan;p.rakeTotal=E.G.rakeTotal||0;return p}
let mySeat=-1, pointerDown=false, renderPending=false;
const lastHTML=new Map();
function setHTML(el,h){if(!el) return;if(lastHTML.get(el)===h) return;lastHTML.set(el,h);el.innerHTML=h}
function render(){if(pointerDown){renderPending=true;return}renderPending=false;renderNow()}
document.addEventListener("pointerdown",()=>{pointerDown=true},true);
const release=()=>{pointerDown=false;if(renderPending) setTimeout(render,0)};
document.addEventListener("pointerup",release,true);document.addEventListener("pointercancel",release,true);
window.addEventListener("blur",release);

function renderNow(){
  const inL=!!mode;
  $("#home").hidden=inL; $("#game").hidden=!inL; $("#leaveBtn").hidden=!inL;
  $("#themeBtn").textContent=document.documentElement.dataset.theme==="light"?"Dark mode":"Light mode";
  const lc=$("#lobbyChip"); lc.hidden=!inL; if(inL) lc.textContent=mode==="local"?"Practice table":`${(E.G&&E.G.lname)||(PUB&&PUB.lname)||L.name} · ${L.id.toUpperCase()}`;
  const rc=$("#roleChip"); rc.hidden=!inL; rc.textContent=ROLE==="teacher"?"Teacher":"Student";
  if(!inL){$("#stakeChip").hidden=true;renderHome();drawPicker();drawCursors();return}
  const T=isT(), P=view();
  if(!P){
    setHTML($("#table"),`<div class="rail"></div><div class="felt"></div><div class="center"><div class="street">Connecting</div><div class="result">Opening the table…</div></div>`);
    setHTML($("#actPanel"),`<p class="note">Nothing to act on yet.</p>`);setHTML($("#log"),"");
    setSide(`<div class="panel"><p class="note">Connecting to the lobby…</p></div>`);drawCursors();return;
  }
  $("#stakeChip").hidden=false; $("#stakeChip").textContent=`${money(P.blinds.sb)}/${money(P.blinds.bb)} NLHE · ${P.size}-max`;
  mySeat=T?-1:P.seats.findIndex(s=>s.uid===ME.cid);
  renderTable(P,T); renderAct(P,T);
  setHTML($("#log"),P.log.slice().reverse().map(t=>`<li>${esc(t)}</li>`).join("")||`<li class="muted">No hands yet.</li>`);
  if(T) renderTeacherSide(); else setSide(studentSide(P));
  if(picker&&!T) picker=null;
  drawPicker(); drawCursors(); tick();
}
function seatPos(i,P,T){
  const rot=T?0:(mySeat>=0?mySeat:0);
  const k=(i-rot+P.size)%P.size; const a=Math.PI/2+k*2*Math.PI/P.size;
  return {x:50+43*Math.cos(a),y:48+36*Math.sin(a),a};
}
function renderTable(P,T){
  const potCollected=P.seats.reduce((a,s)=>a+s.total-s.bet,0);
  const potAll=P.seats.reduce((a,s)=>a+s.total,0);
  let h=`<div class="rail"></div><div class="felt"></div>`;
  const boardSlots=[0,1,2,3,4].map(k=>{
    const c=P.board[k];
    if(T){const pl=P.plan[k]&&(between()||!c)?P.plan[k]:null;const show=pl||c||null;return cardHTML(show,{btn:`data-pick="board" data-k="${k}"`,cls:pl?"plan":"",plus:!show,empty:"Set board card "+(k+1)})}
    return cardHTML(c||null);
  }).join("");
  const b2=P.board2&&P.board2.length?`<div class="board b2"><span class="runlbl">Run 2</span>${P.board2.map(c=>cardHTML(c)).join("")}</div>`:"";
  const badges=[P.bomb&&!between2(P)?"Bomb pot":"",P.reveal?(T?"Students see every hand":"All cards revealed"):""].filter(Boolean);
  h+=`<div class="center"><div class="street">${esc(STREETS[P.phase]||"")}${P.hand?` · Hand #${P.hand}`:""} <span class="clockchip" data-clock></span></div>
    <div class="board" data-anc="board">${b2?'<span class="runlbl">Run 1</span>':""}${boardSlots}</div>${b2}
    <div class="pot">Pot ${money(potCollected)}${potAll!==potCollected?`<small>(${money(potAll)} with bets)</small>`:""}${P.phase==="done"&&P.handRake?`<small>rake ${money(P.handRake)}</small>`:""}</div>
    ${badges.length?`<div class="badges">${badges.map(b=>`<span class="revbadge">${b}</span>`).join("")}</div>`:""}
    ${P.result?`<div class="result">${esc(P.result)}</div>`:""}</div>`;
  for(let i=0;i<P.size;i++){
    const s=P.seats[i], pos=seatPos(i,P,T), me=i===mySeat;
    let cards="";
    if(T){
      const hc=E.hostCards(E.G.seats[i]);const cs=hc.cs;
      if(cs&&(s.has||between())&&!s.out) cards=[0,1].map(k=>cardHTML(cs[k]||null,{btn:`data-pick="seat" data-i="${i}" data-k="${k}"`,plus:!cs[k],cls:hc.pre&&cs[k]?"plan":"",empty:`Set seat ${i+1} card ${k+1}`})).join("");
    } else if(s.has){
      const mine=me&&MINE&&MINE.hand===P.hand&&MINE.cards;
      const cs=s.cards||(mine?MINE.cards:null);
      cards=cs?cs.map(c=>cardHTML(c)).join(""):cardHTML("back")+cardHTML("back");
    }
    const tag=s.out?"Sitting out":s.folded?(P.reveal&&s.has?"Folded · shown":"Folded"):s.allin?"All-in":s.uid?(T?"Student":(me?"You":"Student")):"";
    const showTake=ROLE==="student"&&mySeat<0&&!s.uid;
    h+=`<div class="seat${P.toAct===i?" act":""}${s.folded?" folded":""}${me?" me":""}" data-anc="seat${i}" style="left:${pos.x}%;top:${pos.y}%">
      <div class="hole">${cards}</div>
      <div class="plate"><div class="nm">${esc(s.name)}</div><div class="stk">${money(s.stack)}</div>${tag?`<div class="tag">${tag}</div>`:""}
      ${showTake?`<button class="b sm" type="button" data-take="${i}">Take seat ${i+1}</button>`:""}</div></div>`;
    if(s.bet>0){const bx=50+26*Math.cos(pos.a),by=47+24*Math.sin(pos.a);h+=`<div class="bet" style="left:${bx}%;top:${by}%">${money(s.bet)}</div>`}
    if(i===P.button){const dx=50+33*Math.cos(pos.a+0.32),dy=47+30*Math.sin(pos.a+0.32);h+=`<div class="btnmark" style="left:${dx}%;top:${dy}%" aria-label="Dealer button">D</div>`}
  }
  setHTML($("#table"),h);
}
const between2=P=>P.phase==="idle"||P.phase==="done";
function sizeFor(P,frac){
  const s=P.seats[P.toAct]; const toCall=Math.max(0,P.curBet-s.bet);
  const pot=P.seats.reduce((a,x)=>a+x.total,0);
  return Math.round(P.curBet===0?pot*frac:P.curBet+frac*(pot+toCall));
}
const undoCount=()=>mode==="local"?E.history.length:HIST;
function optSummary(r,P){
  const a=[];
  if(r.anteType==="each"&&r.ante>0) a.push(`${money(r.ante)} ante`);
  if(r.anteType==="bb"&&r.ante>0) a.push(`${money(r.ante)} big blind ante`);
  if(r.straddle) a.push(`${money(r.straddleAmt)} straddle every hand`);
  if(r.rakePct>0) a.push(`rake ${r.rakePct}%${r.rakeCap>0?` up to ${money(r.rakeCap)}`:""}${r.nfnd?", no flop no drop":""}`);
  if(r.rit) a.push("run it twice on all-ins");
  if(r.clock) a.push(`${r.clock}s shot clock`);
  if(P.straddleNext) a.push("straddle next hand");
  if(P.bombNext) a.push(`bomb pot next hand (${money(r.bombAmt)} each)`);
  return a.length?a.join(" · "):"No antes, straddle, rake or clock.";
}
function revealBtn(){return `<button class="b${E.G.revealAll?" on":""}" type="button" data-cmd="reveal" aria-pressed="${!!E.G.revealAll}">${E.G.revealAll?"Hide cards again":"Reveal all cards"}</button>`}
function renderAct(P,T){
  const el=$("#actPanel"); const inHand=["preflop","flop","turn","river"].includes(P.phase);
  if(!inHand||P.toAct==null){
    const G=E.G;
    setHTML(el,T?`<div class="actbar"><div class="who">${P.phase==="done"?"Hand over.":"Ready to deal."} <span>${P.phase==="done"?"Deal the next hand or set up cards first.":"Set cards and stacks, then deal."}</span></div>
      <div class="row"><button class="b primary big" type="button" data-cmd="deal">Deal hand</button><button class="b" type="button" data-cmd="undo"${undoCount()?"":" disabled"}>Undo</button>${revealBtn()}</div>
      <div class="row">${G.rules.straddle?"":`<button class="b sm${G.straddleNext?" on":""}" type="button" data-cmd="straddleNext" aria-pressed="${!!G.straddleNext}">${G.straddleNext?"Straddle on for next hand":"Straddle next hand"}</button>`}
        <button class="b sm${G.bombNext?" on":""}" type="button" data-cmd="bombNext" aria-pressed="${!!G.bombNext}">${G.bombNext?"Bomb pot is next":"Bomb pot next hand"}</button></div>
      <p class="optsum">${esc(optSummary(G.rules,P))} <span class="muted">Change these under Table setup.</span></p></div>`
      :`<p class="note">${P.phase==="done"?"Hand over. Waiting for a teacher to deal.":"Waiting for a teacher to deal."}</p><p class="optsum">${esc(optSummary(P.rules,P))}</p>`);
    return;
  }
  const i=P.toAct, s=P.seats[i], mine=T||i===mySeat;
  const toCall=Math.max(0,P.curBet-s.bet), maxTo=s.bet+s.stack;
  const minTo=Math.min(P.curBet===0?P.blinds.bb:P.curBet+P.minRaise,maxTo);
  if(!mine){setHTML(el,`<div class="actbar"><div class="who">Action on ${esc(s.name)} <span>(seat ${i+1})</span> <span class="clockchip" data-clock></span></div><p class="note">${mySeat>=0?"Your turn comes after them.":"Take an open seat to play along."}</p></div>`);return}
  const verb=P.curBet===0?"Bet":"Raise to";
  const def=Math.min(maxTo,Math.max(minTo,sizeFor(P,P.curBet===0?0.66:1)));
  const canRaise=maxTo>P.curBet;
  setHTML(el,`<div class="actbar">
    <div class="who">${T?`Acting for ${esc(s.name)}`:"Your action"} <span>· seat ${i+1} · stack ${money(s.stack)}${toCall?` · ${money(toCall)} to call`:""}</span> <span class="clockchip" data-clock></span></div>
    <div class="row">
      <button class="b warn big" type="button" data-a="fold">Fold</button>
      ${toCall===0?`<button class="b big" type="button" data-a="check">Check</button>`:`<button class="b big" type="button" data-a="call">Call ${money(Math.min(toCall,s.stack))}</button>`}
      ${canRaise?`<button class="b gold big" type="button" data-a="raise" id="raiseBtn">${verb} ${money(def)}</button>`:""}
      ${T?`<button class="b" type="button" data-cmd="undo"${undoCount()?"":" disabled"}>Undo</button>${revealBtn()}${P.deadline?`<button class="b sm" type="button" data-cmd="time">+30s</button>`:""}`:""}
    </div>
    ${canRaise?`<div class="row"><input type="range" id="amtRange" min="${minTo}" max="${maxTo}" step="1" value="${def}" aria-label="Bet size">
      <input type="number" id="amtNum" min="${minTo}" max="${maxTo}" step="1" value="${def}" aria-label="Bet amount in dollars"></div>
    <div class="row">${[[.33,"⅓ pot"],[.5,"½ pot"],[.66,"⅔ pot"],[1,"Pot"]].map(([f,l])=>`<button class="b sm" type="button" data-size="${Math.min(maxTo,Math.max(minTo,sizeFor(P,f)))}">${l}</button>`).join("")}
      <button class="b sm" type="button" data-size="${minTo}">Min</button><button class="b sm" type="button" data-size="${maxTo}">All-in</button></div>`:""}
  </div>`);
}
/* shot clock countdown, updated in place without redrawing the page */
function tick(){
  const P=mode?view():null; const dl=P&&P.deadline&&P.toAct!=null?P.deadline:null;
  const left=dl?Math.max(0,Math.ceil((dl-(Date.now()+skew))/1000)):null;
  document.querySelectorAll("[data-clock]").forEach(el=>{const t=left==null?"":`${left}s`;if(el.textContent!==t) el.textContent=t;el.classList.toggle("urgent",left!=null&&left<=10)});
}
setInterval(tick,250);

let sideTab="seats", confirmReset=false;
function renderTeacherSide(){
  const G=E.G, r=G.rules, local=mode==="local";
  const tabs=[["seats","Seats"],["setup","Table setup"],["people","People"]];
  let h=`<div class="panel"><div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button class="tab" role="tab" type="button" aria-selected="${sideTab===k}" data-tab="${k}">${l}</button>`).join("")}</div>`;
  if(sideTab==="seats"){
    h+=`<div class="seatlist">`;
    for(let i=0;i<G.size;i++){const s=S(i);const cs=E.hostCards(s).cs;
      h+=`<div class="srow${G.toAct===i?" act":""}" data-anc="srow${i}"><div class="num">${i+1}</div>
        <input type="text" id="nm${i}" value="${esc(s.name)}" data-name="${i}" aria-label="Seat ${i+1} name" maxlength="16">
        <input type="number" id="st${i}" value="${s.stack}" min="0" step="1" data-stack="${i}" aria-label="Seat ${i+1} stack">
        <div class="ops"><span class="minicards">${[0,1].map(k=>cardHTML(cs&&cs[k]||null,{btn:`data-pick="seat" data-i="${i}" data-k="${k}"`,plus:!(cs&&cs[k]),empty:`Set seat ${i+1} card ${k+1}`})).join("")}</span>
        ${s.uid?`<span class="chip">Student</span><button class="b sm" type="button" data-unseat="${i}">Unseat</button>`:`<span class="chip">Open</span>`}
        <button class="b sm" type="button" data-out="${i}">${s.out?"Sit in":"Sit out"}</button>
        ${G.button===i?`<span class="chip">Button</span>`:`<button class="b sm" type="button" data-btn="${i}"${between()?"":" disabled"}>Button here</button>`}</div></div>`}
    h+=`</div><p class="note">Click any card on the table or here to choose it. Cards set between hands are dealt on the next hand; empty slots are dealt at random.</p>`;
  } else if(sideTab==="setup"){
    const num=(id,v,min,step,label,k)=>`<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" min="${min}" step="${step}" value="${v}" data-rule="${k}"></div>`;
    h+=`<div data-anc="setup"><div class="fields">
      ${local?"":`<div class="field" style="grid-column:1/-1"><label for="lnameIn">Lobby name</label><input type="text" id="lnameIn" maxlength="28" value="${esc(G.lname||L.name)}"></div>`}
      <div class="field"><label for="sizeSel">Seats</label><select id="sizeSel">${[2,3,4,5,6,7,8,9].map(n=>`<option${n===G.size?" selected":""}>${n}</option>`).join("")}</select></div>
      <div class="field"><label for="sbIn">Small blind</label><input type="number" id="sbIn" min="0" step="1" value="${G.blinds.sb}"></div>
      <div class="field"><label for="bbIn">Big blind</label><input type="number" id="bbIn" min="1" step="1" value="${G.blinds.bb}"></div>
      <div class="field"><label for="allIn">Set every stack to</label><div class="row"><input type="number" id="allIn" min="0" step="1" value="200"><button class="b sm" type="button" data-cmd="allstacks">Apply</button></div></div>
    </div>
    <div class="group"><h3>Antes</h3><div class="fields">
      <div class="field"><label for="anteType">Ante</label><select id="anteType" data-rule="anteType">${[["none","No ante"],["each","Everyone antes"],["bb","Big blind ante"]].map(([v,l])=>`<option value="${v}"${r.anteType===v?" selected":""}>${l}</option>`).join("")}</select></div>
      ${num("anteAmt",r.ante,0,1,"Ante amount","ante")}</div></div>
    <div class="group"><h3>Straddle and bomb pots</h3>
      <label class="toggle"><input type="checkbox" data-rule="straddle"${r.straddle?" checked":""}><span>Straddle every hand<br><span class="note">The player left of the big blind posts a live straddle and acts last preflop. Needs 3+ players. You can also turn it on for one hand from the action bar.</span></span></label>
      <div class="fields">${num("strAmt",r.straddleAmt,1,1,"Straddle amount","straddleAmt")}${num("bombAmt",r.bombAmt,1,1,"Bomb pot: each player puts in","bombAmt")}</div></div>
    <div class="group"><h3>Rake</h3><div class="fields">
      ${num("rakePct",r.rakePct,0,0.5,"Rake %","rakePct")}${num("rakeCap",r.rakeCap,0,1,"Cap per hand ($, 0 = none)","rakeCap")}</div>
      <label class="toggle"><input type="checkbox" data-rule="nfnd"${r.nfnd?" checked":""}><span>No flop, no drop<br><span class="note">Hands that end before the flop aren't raked. Uncalled bets are never raked.</span></span></label>
      <div class="inline"><span class="note">House has collected ${money(G.rakeTotal||0)}.</span><button class="b sm" type="button" data-cmd="rakereset">Reset counter</button></div></div>
    <div class="group"><h3>All-ins and timing</h3>
      <label class="toggle"><input type="checkbox" data-rule="rit"${r.rit?" checked":""}><span>Run it twice when players are all-in<br><span class="note">Deals a second board and splits each pot between the two runs.</span></span></label>
      <div class="fields"><div class="field"><label for="clockSel">Shot clock</label><select id="clockSel" data-rule="clock">${[0,15,20,30,45,60,90,120].map(v=>`<option value="${v}"${(r.clock|0)===v?" selected":""}>${v?v+" seconds":"Off"}</option>`).join("")}</select></div></div>
      <p class="note">When time runs out the player checks if they can, otherwise folds.</p></div>
    <div class="group"><h3>Teaching</h3>
      <div class="row">${revealBtn()}<span class="note">Shows every hand to students, folded ones too.</span></div>
      <label class="toggle"><input type="checkbox" id="keepSetup"${G.keepSetup?" checked":""}><span>Keep my card setup for the next hand<br><span class="note">Replays the same hole cards so students can try other lines. Board cards you set are used once.</span></span></label>
      <div class="row" style="margin-top:8px">${!between()?`<button class="b" type="button" data-cmd="voidhand">Cancel this hand</button>`:""}
      ${confirmReset?`<span class="confirm"><span>Reset table, stacks and log?</span><button class="b sm warn" type="button" data-cmd="reset">Reset</button><button class="b sm" type="button" data-cmd="noreset">Keep</button></span>`:`<button class="b warn" type="button" data-cmd="askreset">Reset table…</button>`}</div></div></div>`;
  } else {
    h+=`<div class="students" id="stuList"></div>
      ${local?"":`<p class="note">Students open this site, pick <b>${esc(G.lname||L.name)}</b> from the lobby list, and tap an open seat. Or send them this link: <b>${esc(location.origin)}/#lobby-${esc(L.id)}</b>. Co-teachers join with the teacher code; you'll see each other's pointers, and a colored outline marks whatever another teacher is editing.</p>`}`;
  }
  h+=`</div>`;
  setSide(h); renderPeople();
}
const COLS=["#e8590c","#1971c2","#9c36b5","#2f9e44","#c2255c","#0c8599","#5c940d","#d6336c"];
const colOf=k=>{let h=0;for(const ch of String(k))h=(h*31+ch.charCodeAt(0))>>>0;return COLS[h%COLS.length]};
function renderPeople(){
  const el=$("#stuList"); if(!el) return;
  if(mode==="local"){setHTML(el,`<p class="note">Practice table: it runs on this device only, so nobody else can join.</p>`);return}
  const nm=p=>esc(p.name||"Someone");
  const T=peers.filter(p=>p.role==="teacher"), Ss=peers.filter(p=>p.role==="student");
  let h=`<div class="sub">Teachers</div>`+T.map(p=>`<div class="stu"><span><span class="sw" style="background:${colOf(p.peer)}"></span>${nm(p)}${p.peer===myPeer?' <span class="muted">(you)</span>':""}</span><span class="muted">Teacher</span></div>`).join("");
  h+=`<div class="sub">Students</div>`+(Ss.length?Ss.map(p=>`<div class="stu"><span>${nm(p)}</span><span class="muted">${p.seat>=0?"Seat "+(p.seat+1):"Watching"}</span></div>`).join(""):`<p class="note">No students here yet.</p>`);
  setHTML(el,h);
}
function setSide(h){
  const side=$("#side"); const f=document.activeElement; const fid=f&&side.contains(f)&&f.id;
  const typing=fid&&(f.tagName==="INPUT"&&f.type!=="checkbox"); const caret=typing&&f.type==="text"?[f.selectionStart,f.selectionEnd]:null; const val=typing?f.value:null;
  setHTML(side,h);
  if(fid){const el=document.getElementById(fid); if(el&&el!==document.activeElement){el.focus(); if(val!=null) el.value=val; if(caret) try{el.setSelectionRange(caret[0],caret[1])}catch(e){}}}
}
function studentSide(P){
  const teacherHere=peers.some(p=>p.role==="teacher");
  return `<div class="panel"><h2>You</h2><p style="margin:0 0 6px">Playing as <b>${esc(myName||"Student")}</b></p>
    <p class="note">${mySeat>=0?`You're in seat ${mySeat+1}. Only you and the teachers see your cards${P&&P.reveal?" (right now the teacher is showing everyone's)":""}.`:"Tap an open seat on the table to sit down."}</p>
    <p class="note">${teacherHere?"A teacher is at the table.":"No teacher is here right now. The table is saved, and play continues when one joins."}</p>
    ${mySeat>=0?`<button class="b sm" type="button" data-leave="1">Leave seat</button>`:""}</div>`;
}
function renderHome(){
  const live=homeList||[];
  let h;
  if(homeList==null) h=`<p class="note">${homeListErr?"Can't reach the server right now. Retrying…":"Loading lobbies…"}</p>`;
  else h=live.length?live.map(l=>{const id=esc(l.id);
    return `<div class="lob${l.live?" live":""}"><div><div class="ttl">${esc(String(l.name||"Lobby").slice(0,28))}</div>
      <div class="meta"><span class="dot ${l.live?"on":""}" style="display:inline-block;margin-right:5px"></span>${l.live?"Teacher here":"No teacher right now"} · code ${esc(String(l.id).toUpperCase())} · ${esc(String(l.stakes||"").slice(0,16))} · ${+l.seated||0}/${+l.size||0} seated${l.hand?` · hand #${+l.hand}`:""}</div></div>
      <div class="row"><button class="b sm primary" type="button" data-join="${id}">Join as student</button><button class="b sm" type="button" data-teach="${id}">Teach</button></div></div>`}).join("")
    :`<p class="note">No lobbies yet. Start one below.</p>`;
  setHTML($("#dirList"),h);
  $("#keyField").hidden=!needsKey;
  const tf=$("#teachForm"); tf.hidden=!teachFor;
  if(teachFor){$("#teachName").textContent=teachFor.name;
    setHTML($("#delRow"),delConfirm?`<span class="confirm"><span>Delete this lobby for everyone? This can't be undone.</span><button class="b sm warn" type="button" id="delGo">Delete</button><button class="b sm" type="button" id="delNo">Keep</button></span>`:`<button class="b sm warn" type="button" id="delAsk">Delete this lobby…</button>`)}
  $("#homeMsg").textContent=homeMsg;
}
function homeErr(t){homeMsg=t||"";const m=$("#homeMsg");if(m) m.textContent=homeMsg}
let flashT=null;
function flash(t){setConn(true,t);clearTimeout(flashT);flashT=setTimeout(updateConn,3500)}
function setConn(ok,t){$("#connDot").className="dot "+(ok?"on":"off");$("#connTxt").textContent=t}
function updateConn(){
  if(!mode){setConn(!homeListErr,homeListErr?"Can't reach the server":"Online");return}
  if(mode==="local"){setConn(true,"Practice · this device only");return}
  if(!wsOpen){setConn(false,retry?"Reconnecting…":"Connecting…");return}
  if(!welcomed){setConn(false,"Joining…");return}
  setConn(true,ROLE==="teacher"?"Live · teaching":"Live");
}

/* ---------- co-teacher pointers and edit outlines ---------- */
let curOut=null, curT=0, curTimer=null, myBusy="[]", curRaf=0;
const ancEl=a=>typeof a==="string"&&/^[a-z]{2,8}\d?$/.test(a)?document.querySelector(`[data-anc="${a}"]`):null;
document.addEventListener("pointermove",e=>{
  if(mode!=="lobby"||!isT()) return;
  const el=e.target&&e.target.closest&&e.target.closest("[data-anc]"); let c=null;
  if(el){const r=el.getBoundingClientRect(); if(r.width&&r.height) c={a:el.dataset.anc,x:+((e.clientX-r.left)/r.width).toFixed(3),y:+((e.clientY-r.top)/r.height).toFixed(3)}}
  curOut=c; sendCur();
},{passive:true});
document.documentElement.addEventListener("pointerleave",()=>{curOut=null;sendCur()});
function sendCur(now){
  if(mode!=="lobby"||ROLE!=="teacher"||!ws||!wsOpen) return;
  if(curTimer&&!now) return;
  const go=()=>{curTimer=null;curT=Date.now();if(ws&&wsOpen) ws.send(JSON.stringify({t:"cur",cur:curOut,busy:JSON.parse(myBusy)}))};
  if(now){clearTimeout(curTimer);go();return}
  curTimer=setTimeout(go,Math.max(0,70-(Date.now()-curT)));
}
function refreshBusy(){
  if(!isT()) return;
  const l=[]; if(picker){ if(picker.kind==="board") l.push("board"); else l.push("seat"+picker.i,"srow"+picker.i) }
  const f=document.activeElement; const a=f&&f.closest&&f.closest("[data-anc]");
  if(a&&a.dataset.anc&&/^(srow\d|setup)$/.test(a.dataset.anc)) l.push(a.dataset.anc);
  const s=JSON.stringify([...new Set(l)]); if(s===myBusy) return; myBusy=s; sendCur(true);
}
document.addEventListener("focusin",()=>setTimeout(refreshBusy,0));
document.addEventListener("focusout",()=>setTimeout(refreshBusy,0));
function drawCursors(){if(curRaf) return;curRaf=requestAnimationFrame(()=>{curRaf=0;drawCursorsNow()})}
window.addEventListener("scroll",drawCursors,{passive:true,capture:true});
window.addEventListener("resize",drawCursors);
function othersBusyOn(anchors){const out=[];for(const [peer,c] of curs){if(peer===myPeer||!Array.isArray(c.busy)) continue;if(c.busy.some(a=>anchors.includes(a))) out.push(c.name||"Another teacher")}return out}
function drawCursorsNow(){
  const layer=$("#curLayer"); if(mode!=="lobby"||(picker&&!$("#modal").hidden)){layer.innerHTML="";return}
  const T=isT(); let h="";
  for(const [peer,c] of curs){
    if(peer===myPeer) continue;
    const col=colOf(peer), nm=esc(c.name||"Teacher");
    if(T&&Array.isArray(c.busy)) for(const a of c.busy){const el=ancEl(a);if(!el) continue;const r=el.getBoundingClientRect();if(!r.width) continue;
      h+=`<div class="busy" style="left:${r.left-3}px;top:${r.top-3}px;width:${r.width+6}px;height:${r.height+6}px;border-color:${col}"><span style="background:${col}">${nm} is editing</span></div>`}
    const p=c.cur; if(!p||typeof p.a!=="string") continue;
    if(!T&&!/^(seat\d|board)$/.test(p.a)) continue;
    const el=ancEl(p.a); if(!el) continue; const r=el.getBoundingClientRect(); if(!r.width) continue;
    const x=r.left+p.x*r.width, y=r.top+p.y*r.height;
    h+=`<div class="tcur" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"><svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><path d="M1.5 1.5v14.5l4-3.6 2.8 6.1 2.8-1.2-2.7-6h5.6z" fill="${col}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="cn" style="background:${col}">${nm}</span></div>`;
  }
  layer.innerHTML=h;
}

/* ---------- card picker ---------- */
let picker=null;
function openPicker(kind,i,k){picker={kind,i,k};render();refreshBusy()}
function closePicker(){picker=null;render();refreshBusy()}
function pickerCards(){
  if(picker.kind==="board") return [0,1,2,3,4].map(k=>between()?E.G.plan[k]:(E.G.board[k]||E.G.plan[k]||null));
  const s=S(picker.i); return between()?s.pre.slice():(s.cards||s.pre).slice();
}
function drawPicker(){
  const m=$("#modal"); if(!picker||!isT()){if(!m.hidden){m.hidden=true;setHTML(m,"")}return}
  if(picker.kind==="seat"&&picker.i>=E.G.size){picker=null;m.hidden=true;setHTML(m,"");return}
  const cur=pickerCards(); const u=E.used(); const sel=cur[picker.k];
  const title=picker.kind==="board"?"Board cards":`Seat ${picker.i+1} · ${esc(S(picker.i).name)}`;
  const labels=picker.kind==="board"?["Flop","Flop","Flop","Turn","River"]:["Card 1","Card 2"];
  const others=othersBusyOn(picker.kind==="board"?["board"]:["seat"+picker.i,"srow"+picker.i]);
  let h=`<div class="sheet" role="dialog" aria-modal="true" aria-label="${title}" data-anc="picker"><h3>${title}</h3>
    <p class="warnline" aria-live="polite">${others.length?`${esc(others.join(" and "))} ${others.length>1?"are":"is"} also editing this.`:""}</p>
    <div class="slots">${cur.map((c,k)=>`<button class="slotbtn" type="button" data-slot="${k}" aria-pressed="${k===picker.k}"><span class="lbl">${labels[k]}</span>${cardHTML(c||null)}</button>`).join("")}</div>`;
  h+=`<div class="deck">${"shdc".split("").map(su=>RANKS.split("").reverse().map(r=>{const c=r+su;const dis=u.has(c)&&c!==sel;return cardHTML(c,{btn:`data-card="${c}"${dis?" disabled":""}`,cls:c===sel?"cur":""})}).join("")).join("")}</div>
    <div class="row" style="margin-top:12px;justify-content:space-between"><div class="row"><button class="b sm" type="button" data-pk="random">Random card</button><button class="b sm" type="button" data-pk="clear">Clear slot</button></div><button class="b primary" type="button" data-pk="done">Done</button></div>
    <p class="note">${picker.kind==="board"?"Dealt board cards change in place. Cards you set for later streets show faded and are dealt when that street comes.":"During a hand this swaps the card in the player's hand. Between hands it presets the card for the next deal."}</p></div>`;
  setHTML(m,h); m.hidden=false;
}
function setPicked(card){const {kind,i,k}=picker;sendOp({t:"pick",kind,i,k,card})}

/* ---------- events ---------- */
document.addEventListener("click",e=>{
  const t=e.target.closest("button"); if(!t) return;
  if(t.closest("#modal")){
    if(!picker) return;
    if(t.dataset.slot!=null){picker.k=+t.dataset.slot;drawPicker()}
    else if(t.dataset.card){setPicked(t.dataset.card);const n=picker.kind==="board"?5:2;if(picker.k<n-1){picker.k++;drawPicker()}}
    else if(t.dataset.pk==="random"){setPicked("random")}
    else if(t.dataset.pk==="clear"){setPicked(null)}
    else if(t.dataset.pk==="done"){closePicker()}
    return;
  }
  if(t.id==="themeBtn"){const nt=document.documentElement.dataset.theme==="light"?"dark":"light";document.documentElement.dataset.theme=nt;try{localStorage.setItem("hsp-theme",nt)}catch(x){}render();return}
  if(t.id==="leaveBtn"){leaveLobby();return}
  if(!mode){
    if(t.id==="practiceBtn"){enterLocal();return}
    if(t.id==="createBtn"){createLobby();return}
    if(t.dataset.join){enterLobby(t.dataset.join,"student");return}
    if(t.dataset.teach){const l=(homeList||[]).find(x=>x.id===t.dataset.teach);teachFor={id:t.dataset.teach,name:l?l.name:t.dataset.teach};delConfirm=false;$("#teachCode").value=codes()[teachFor.id]||"";render();$("#teachCode").focus();return}
    if(t.id==="teachCancel"){teachFor=null;render();return}
    if(t.id==="teachGo"){const c=$("#teachCode").value.trim();if(!c){homeErr("Enter the teacher code.");return}enterLobby(teachFor.id,"teacher",c);teachFor=null;return}
    if(t.id==="delAsk"){if(!$("#teachCode").value.trim()){homeErr("Enter the teacher code first.");$("#teachCode").focus();return}delConfirm=true;render();return}
    if(t.id==="delNo"){delConfirm=false;render();return}
    if(t.id==="delGo"){deleteLobby(teachFor.id,$("#teachCode").value.trim());return}
    return;
  }
  if(isT()){
    if(t.dataset.pick){openPicker(t.dataset.pick,+(t.dataset.i||0),+t.dataset.k);return}
    if(t.dataset.tab){sideTab=t.dataset.tab;confirmReset=false;render();return}
    if(t.dataset.unseat!=null){sendOp({t:"unseat",i:+t.dataset.unseat});return}
    if(t.dataset.out!=null){const i=+t.dataset.out;sendOp({t:"out",i,v:!S(i).out});return}
    if(t.dataset.btn!=null){sendOp({t:"btn",i:+t.dataset.btn});return}
    const c=t.dataset.cmd;
    if(c==="deal"){if(E.readyCount()<2){flash("Need at least two seated players with chips.");return}sendOp({t:"deal"});return}
    if(c==="undo"){sendOp({t:"undo"});return}
    if(c==="reveal"){sendOp({t:"reveal",v:!E.G.revealAll});return}
    if(c==="straddleNext"){sendOp({t:"straddleNext",v:!E.G.straddleNext});return}
    if(c==="bombNext"){sendOp({t:"bombNext",v:!E.G.bombNext});return}
    if(c==="time"){sendOp({t:"time"});return}
    if(c==="rakereset"){sendOp({t:"rakereset"});return}
    if(c==="askreset"){confirmReset=true;render();return}
    if(c==="noreset"){confirmReset=false;render();return}
    if(c==="reset"){confirmReset=false;sendOp({t:"reset"});return}
    if(c==="voidhand"){sendOp({t:"voidhand"});return}
    if(c==="allstacks"){sendOp({t:"allstacks",v:Math.max(0,Math.round(+$("#allIn").value||0))});return}
  }
  if(t.dataset.size){const v=+t.dataset.size;const r=$("#amtRange"),n=$("#amtNum");if(r)r.value=v;if(n)n.value=v;updRaiseLabel();return}
  if(t.dataset.a){doAct(t.dataset.a);return}
  if(t.dataset.take!=null){wsSend({t:"seat",i:+t.dataset.take});flash("Taking seat "+(+t.dataset.take+1)+"…");return}
  if(t.dataset.leave){wsSend({t:"seat",i:-1});return}
});
function updRaiseLabel(){const b=$("#raiseBtn"),n=$("#amtNum");const P=view();if(b&&n&&P) b.textContent=`${P.curBet===0?"Bet":"Raise to"} ${money(+n.value||0)}`}
document.addEventListener("input",e=>{
  const t=e.target;
  if(t.id==="amtRange"){$("#amtNum").value=t.value;updRaiseLabel()}
  else if(t.id==="amtNum"){const r=$("#amtRange");if(r) r.value=t.value;updRaiseLabel()}
  else if(t.id==="homeName"){myName=t.value.slice(0,16);lsSet("hsp-name",myName)}
});
document.addEventListener("change",e=>{
  const t=e.target; if(!mode||!isT()) return;
  if(t.dataset.rule){const k=t.dataset.rule;sendOp({t:"rule",k,v:t.type==="checkbox"?t.checked:t.tagName==="SELECT"&&k!=="clock"?t.value:+t.value});return}
  if(t.dataset.name!=null){sendOp({t:"name",i:+t.dataset.name,v:t.value})}
  else if(t.dataset.stack!=null){sendOp({t:"stack",i:+t.dataset.stack,v:+t.value})}
  else if(t.id==="sizeSel"){if(!between()){flash("Finish or cancel the hand before changing seats.");lastHTML.delete($("#side"));render();return}sendOp({t:"size",v:+t.value})}
  else if(t.id==="sbIn"){sendOp({t:"sb",v:+t.value})}
  else if(t.id==="bbIn"){sendOp({t:"bb",v:+t.value})}
  else if(t.id==="keepSetup"){sendOp({t:"keep",v:t.checked})}
  else if(t.id==="lnameIn"){sendOp({t:"lname",v:t.value})}
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&picker){closePicker();return}
  if(e.key!=="Enter") return;
  const id=e.target.id;
  if(id==="amtNum"){e.preventDefault();doAct("raise")}
  else if(id==="newName"||id==="newCode"||id==="newKey"){e.preventDefault();createLobby()}
  else if(id==="teachCode"&&teachFor){e.preventDefault();$("#teachGo").click()}
  else if(e.target.matches&&e.target.matches("#side input[type=text],#side input[type=number]")) e.target.blur();
});
function doAct(type){
  const P=view(); if(!P||P.toAct==null) return;
  const amt=type==="raise"?+($("#amtNum")||{}).value:0;
  if(isT()){sendOp({t:"act",seat:P.toAct,a:type,amt});return}
  if(P.toAct!==mySeat) return;
  if(wsSend({t:"act",a:type,amt})) setHTML($("#actPanel"),`<p class="note">Sent…</p>`);
}

/* ---------- start ---------- */
function openFromHash(){
  const m=/^lobby-([a-z0-9]{3,12})$/i.exec((location.hash||"").slice(1)); if(!m||mode) return;
  const id=m[1].toLowerCase(), code=codes()[id];
  if(!myName){homeErr("Enter your name, then join the lobby from the list.");$("#homeName").focus();return}
  if(code) enterLobby(id,"teacher",code); else enterLobby(id,"student");
}
window.addEventListener("hashchange",()=>{if(!mode) openFromHash()});
$("#homeName").value=myName; $("#newCode").value=suggestCode();
updateConn(); render();
loadLobbies().then(()=>{updateConn();openFromHash()});
