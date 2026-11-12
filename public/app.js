// Hot Seat Poker page: lobby list, table, teacher controls, live connection to the lobby server.
import {createEngine,freshGame,RANKS,SYM,STREETS,NAMES,money,pretty} from "./engine.js";
import {createSolver} from "./solver/core.js";
import {createDock,solverPalette,notesPalette} from "./dock.js";
import {createNotes} from "./notes.js";
import {createOdds,createStove} from "./tools.js";
import {createCombos} from "./combos.js";
import {createCharts} from "./charts.js";
import {BOT_TYPES,BOT_ORDER,botLabel,decide as botDecide,thinkMs} from "./bots.js";

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
const IN_DISCORD=new URLSearchParams(location.search).has("frame_id");
// inside Discord, links to the site have to name it (the page itself runs on Discord's address)
const SITE=/discordsays\.com$/.test(location.hostname)?"https://hotseatpoker.com":location.origin;
let DSDK=null;
const codes=()=>lsGet("hsp-codes")||{};
function saveCode(id,code){const c=codes();c[id]=code;lsSet("hsp-codes",c)}
function forgetCode(id){const c=codes();delete c[id];lsSet("hsp-codes",c)}
// passwords for locked lobbies, kept on this device so reconnecting doesn't ask again
const pws=()=>lsGet("hsp-pws")||{};
function savePw(id,pw){const c=pws();if(pw) c[id]=pw; else delete c[id];lsSet("hsp-pws",c)}
let pwFor=null, pendingHash=false;
// practice table: "teacher" view sees and sets every card; "student" view plays one seat against computer players
let SOLO=Object.assign({view:"teacher",seat:0,auto:true},lsGet("hsp-solo")||{});
const saveSolo=()=>lsSet("hsp-solo",SOLO);
const soloStu=()=>mode==="local"&&SOLO.view==="student"&&!!E.G;
const isT=()=>ROLE==="teacher"&&!!E.G&&!soloStu();

function connect(){
  clearTimeout(retryT); if(!L||!wantWs) return;
  const s=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/ws/${L.id}`); ws=s;
  s.onopen=()=>{if(ws!==s) return;retry=0;wsOpen=true;s.send(JSON.stringify({t:"hello",cid:ME.cid,tok:ME.tok,name:myName,role:ROLE,code:ROLE==="teacher"?TCODE:undefined,pw:ROLE==="teacher"?undefined:pws()[L.id]}));sendCur(true);updateConn()};
  s.onmessage=e=>{if(ws!==s) return;let m;try{m=JSON.parse(e.data)}catch(x){return}onMsg(m)};
  s.onclose=e=>{
    if(ws!==s) return; wsOpen=false; ws=null;
    if(!wantWs) return;
    if(e.code===4002&&L){ // locked lobby: ask for the password
      const id=L.id, name=L.name, had=!!pws()[id]; savePw(id,null);
      leaveLobby(); pwFor={id,name}; homeErr(had?(lastErr||"That password doesn't match this lobby."):""); render(); setTimeout(()=>{const i=$("#pwIn");if(i) i.focus()},50); return;
    }
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
  if(m.t==="welcome"){welcomed=true;myPeer=m.peer;if(m.lobby&&L){L.name=m.lobby.name;L.locked=!!m.lobby.locked;L.discord=!!m.lobby.discord}pwFor=null;if(ROLE==="teacher") saveCode(L.id,TCODE);updateConn()}
  else if(m.t==="state"){skew=(+m.now||Date.now())-Date.now();if(m.g){E.G=m.g;HIST=m.hist||0}else{PUB=m.pub;MINE=m.mine||null}render()}
  else if(m.t==="peers"){peers=Array.isArray(m.list)?m.list:[];for(const k of [...curs.keys()]) if(!peers.some(p=>p.peer===k)) curs.delete(k);updateConn();render();drawCursors()}
  else if(m.t==="cur"){if(!m.cur&&!(m.busy&&m.busy.length)) curs.delete(m.peer); else curs.set(m.peer,m);drawCursors();if(picker) render()}
  else if(m.t==="error"){lastErr=m.msg||"";if(m.msg) flash(m.msg)}
  else if(m.t==="deleted"){lastErr="This lobby was deleted."}
  else if(m.t==="sv"||m.t==="svq"||m.t==="sva"){
    if(m.t==="sv"&&m.off){svOn=false;render();return}
    if(m.t==="sv"&&m.on){svOn=true;render()}
    if(SV) SV.onMessage(m);
  }
  else if(m.t==="nb"){if(NB) NB.onMessage(m)}
  else if(m.t==="pf"){if(CH) CH.onMessage(m)}
  else if(m.t==="locked"){if(L){L.locked=!!m.on;if(isT()) flash(m.on?"Students now need the password to join":"Anyone with the link can join now")}render()}
  else if(m.t==="dc"){DCS=m;dcBusy=false;if(m.has&&!m.err) dcUrl="";if(m.ok||m.err) dcNote={ok:m.ok,err:m.err,at:Date.now()};render()}
  else if(m.t==="poll"){POLL=m.poll||null;if(POLL&&pollPick&&pollPick.id!==POLL.id) pollPick=null;if(POLL&&POLL.id!==pollSeen){pollSeen=POLL.id;pollMin=false}renderPoll()}
}

/* ---------- study tools: hidden until each person turns them on ---------- */
const TOOLS=lsGet("hsp-tools")||{};
function setTool(k,on){
  TOOLS[k]=!!on; lsSet("hsp-tools",TOOLS); render();
  if(on){const P=view(); if(k==="odds"&&ODDS){ODDS.refresh();} if(k==="notes"&&NB){NB.refresh();} if(k==="stove"&&STOVE&&P&&["preflop","flop","turn","river"].includes(P.phase)&&STOVE.rows.every(r=>!r.text)) STOVE.fromTable();
    if(k==="combos"&&CMB&&CMB.state().board===""&&!CMB.state().known) CMB.fromTable();
    const el=$(k==="odds"?"#oddsPanel":k==="notes"?"#notesPanel":k==="charts"?"#chartsPanel":k==="combos"?"#combosPanel":"#stovePanel"); setTimeout(()=>{const w=el.closest(".dk")||el; w.scrollIntoView({behavior:"smooth",block:"nearest"})},60)}
}

/* ---------- polls: the teacher asks, everyone answers privately, then the answers are shown ---------- */
let POLL=null, pollDraft=null, pollPick=null, pollMin=false, pollSeen="";
function pollDefault(){
  const P=view(); const inHand=P&&["preflop","flop","turn","river"].includes(P.phase)&&P.toAct!=null;
  if(!inHand) return {q:"",opts:"Fold, Call, Raise",amt:[false,false,true],ctx:null};
  const s=P.seats[P.toAct], toCall=Math.max(0,P.curBet-s.bet), st=STREETS[P.phase].toLowerCase();
  return toCall>0
    ?{q:`${s.name} faces ${money(toCall)} to call on the ${st}. What should they do?`,opts:"Fold, Call, Raise",amt:[false,false,true],ctx:{hand:P.hand,seat:P.toAct}}
    :{q:`It's on ${s.name} on the ${st}. What should they do?`,opts:"Check, Bet",amt:[false,true],ctx:{hand:P.hand,seat:P.toAct}};
}
const AMT_RX=/^(bet|raise|raise to|bet to|jam|all.?in|shove|3-?bet|4-?bet|open)$/i;
function pollClick(t){
  const op=t.dataset.poll;
  if(op==="new"){if(!isT()) return;pollDraft=pollDefault();pollMin=false;renderPoll(true);setTimeout(()=>{const i=$("#pollQ");if(i){i.focus();i.select()}},30);return}
  if(op==="cancel"){pollDraft=null;renderPoll(true);return}
  if(op==="ask"){
    const q=($("#pollQ")||{}).value||"", opts=(($("#pollOpts")||{}).value||"").split(",").map(x=>x.trim()).filter(Boolean).slice(0,6);
    if(opts.length<2){flash("Give at least two choices, separated by commas");return}
    if(wsSend({t:"poll",op:"ask",q,opts,amt:opts.map(o=>AMT_RX.test(o)),ctx:pollDraft&&pollDraft.ctx})){pollDraft=null;pollPick=null}
    return;
  }
  if(op==="min"){pollMin=!pollMin;renderPoll(true);return}
  if(!POLL) return;
  if(op==="pick"){const k=+t.dataset.k;pollPick={id:POLL.id,a:k,amt:pollPick&&pollPick.amt||"",why:pollPick&&pollPick.why||""};renderPoll(true);const a=$("#pollAmt");if(a&&POLL.amt[k]) a.focus();return}
  if(op==="send"){
    if(!pollPick||pollPick.a==null){flash("Pick an answer first");return}
    if(POLL.amt[pollPick.a]&&pollPick.amt!==""&&!(+pollPick.amt>0)){flash("Enter an amount, or leave it empty");return}
    wsSend({t:"poll",op:"answer",id:POLL.id,a:pollPick.a,amt:pollPick.amt===""?null:+pollPick.amt,why:pollPick.why||""});return;
  }
  if(["reveal","hide","end"].includes(op)&&isT()){wsSend({t:"poll",op});return}
}
function pollInput(t){
  const k=t.dataset.pin;
  if(k==="amt"||k==="why"){if(!POLL) return;pollPick=pollPick&&pollPick.id===POLL.id?pollPick:{id:POLL.id,a:POLL.mine?POLL.mine.a:null,amt:"",why:""};pollPick[k]=t.value}
}
let pollKey="";
function renderPoll(force){
  const el=$("#pollCard"); if(!el) return;
  if(mode!=="lobby"||(!POLL&&!pollDraft)){el.hidden=true;el.innerHTML="";pollKey="";return}
  el.hidden=false;
  const T=isT();
  // keep what's being typed: only redraw when something other than the count changed, unless forced
  const key=JSON.stringify([pollDraft&&1,POLL&&[POLL.id,POLL.revealed,POLL.mine,POLL.answers,POLL.n],pollPick&&[pollPick.a],pollMin,T]);
  if(!force&&key===pollKey) return; pollKey=key;
  const f=document.activeElement, fk=f&&el.contains(f)?(f.id||""):"", pos=f&&f.selectionStart;
  let h=`<div class="pchead"><b>${pollDraft?"Ask everyone":"Poll"}</b>${POLL&&!pollDraft?`<span class="muted">${POLL.n} answered</span>`:""}<button type="button" class="pcmin" data-poll="min" aria-expanded="${!pollMin}" aria-label="${pollMin?"Show":"Hide"} the poll">${pollMin?"▴":"▾"}</button></div>`;
  if(pollMin){el.innerHTML=h;el.classList.add("min");return}
  el.classList.remove("min");
  if(pollDraft){
    const d=pollDraft;
    h+=`<label class="pclab" for="pollQ">Question</label><input id="pollQ" type="text" maxlength="160" value="${esc(d.q)}" placeholder="What would you do here?">
      <label class="pclab" for="pollOpts">Choices <span class="muted">(separated by commas; Bet and Raise ask for an amount)</span></label><input id="pollOpts" type="text" maxlength="200" value="${esc(d.opts)}">
      <div class="row"><button class="b primary" type="button" data-poll="ask">Ask${POLL?" (replaces the current poll)":""}</button><button class="b" type="button" data-poll="cancel">Cancel</button></div>
      <p class="note">Everyone answers privately. Answers stay hidden until you reveal them.</p>`;
  } else {
    const P=POLL, mine=P.mine, pick=pollPick&&pollPick.id===P.id?pollPick:(mine?{a:mine.a,amt:mine.amt==null?"":String(mine.amt),why:mine.why||""}:null);
    h+=`<p class="pcq">${esc(P.q)}</p>`;
    if(!P.revealed){
      h+=`<div class="pcopts">${P.opts.map((o,k)=>`<button type="button" class="b${pick&&pick.a===k?" on":""}" data-poll="pick" data-k="${k}" aria-pressed="${!!(pick&&pick.a===k)}">${esc(o)}</button>`).join("")}</div>`;
      if(pick&&P.amt[pick.a]) h+=`<label class="pclab" for="pollAmt">${esc(P.opts[pick.a])} amount ($, optional)</label><input id="pollAmt" type="number" min="0" step="1" data-pin="amt" value="${esc(pick.amt)}">`;
      h+=`<label class="pclab" for="pollWhy">Why? <span class="muted">(optional)</span></label><input id="pollWhy" type="text" maxlength="140" data-pin="why" value="${esc(pick?pick.why:"")}" placeholder="One line on your thinking">
        <div class="row"><button class="b primary" type="button" data-poll="send">${mine?"Change my answer":"Send my answer"}</button>${mine?`<span class="note">You said <b>${esc(P.opts[mine.a])}${mine.amt?` ${money(mine.amt)}`:""}</b></span>`:""}</div>
        <p class="note pcwho">${P.n?`${P.n} answered: ${P.who.map(esc).join(", ")}`:"No answers yet."} Answers stay hidden until the teacher reveals them.</p>`;
      if(T) h+=`<div class="row pcteach"><button class="b gold" type="button" data-poll="reveal"${P.n?"":" disabled"}>Reveal answers</button><button class="b sm" type="button" data-poll="end">End poll</button></div>`;
    } else {
      const A=P.answers||[], n=A.length||1;
      h+=P.opts.map((o,k)=>{const who=A.filter(x=>x.a===k);return `<div class="pcres"><div class="pcrow"><span>${esc(o)}</span><b>${who.length} · ${Math.round(who.length/n*100)}%</b></div>
        <div class="pcbar"><i style="width:${(who.length/n*100).toFixed(1)}%"></i></div>
        ${who.length?`<div class="pcnames">${who.map(x=>`<span>${esc(x.name)}${x.amt?` ${money(x.amt)}`:""}</span>`).join("")}</div>`:""}</div>`}).join("");
      const why=A.filter(x=>x.why);
      if(why.length) h+=`<div class="pcwhy"><b>Reasons</b>${why.map(x=>`<p><span>${esc(x.name)}${x.a!=null?` (${esc(P.opts[x.a])})`:""}:</span> ${esc(x.why)}</p>`).join("")}</div>`;
      if(T) h+=`<div class="row pcteach"><button class="b sm" type="button" data-poll="hide">Hide answers and reopen</button><button class="b sm" type="button" data-poll="end">End poll</button><button class="b sm" type="button" data-poll="new">New question</button></div>`;
    }
  }
  el.innerHTML=h;
  if(fk){const n=document.getElementById(fk);if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch(x){}}}
}

/* ---------- the solver, in this window ---------- */
let SV=null, NB=null, ODDS=null, STOVE=null, CH=null, CMB=null, svOn=false, viewMode=lsGet("hsp-view")||"table";
const DOCK=createDock($("#duo")), SVPAL=solverPalette($("#svPal")); let NBPAL=null;
function unmountSolver(){
  DOCK.release(); SVPAL.release(); if(NBPAL) NBPAL.release(); NBPAL=null;
  if(SV) SV.destroy(); if(NB) NB.destroy(); if(STOVE) STOVE.destroy(); if(CH) CH.destroy(); SV=null; NB=null; ODDS=null; STOVE=null; CH=null;
  $("#solverRoot").innerHTML=""; $("#notesPanel").innerHTML=""; $("#oddsPanel").innerHTML=""; $("#stovePanel").innerHTML=""; $("#combosPanel").innerHTML=""; CMB=null; $("#chartsPanel").innerHTML="";
  POLL=null; pollDraft=null; pollPick=null;
}
function mountSolver(){
  unmountSolver();
  const root=$("#solverRoot"); root.className="";
  const transport=mode==="lobby"?{send:o=>{if(ws&&wsOpen) ws.send(JSON.stringify(o))},peer:()=>myPeer,name:()=>myName||"Someone",canEdit:()=>isT()||svOn}:null;
  SV=createSolver(root,{transport,anchors:mode==="lobby",table:{current:()=>view(),canPush:()=>isT(),push:(k,card)=>{if(E.G&&E.used().has(card)){flash(`${pretty(card)} is in a player's hand, so the table can't deal it`);return false}sendOp({t:"pick",kind:"board",k,card});flash(`${k===3?"Turn":"River"} set to ${pretty(card)} on the table`);return true}}});
  const tbl={current:()=>view(),mySeat:()=>mySeat,myCards:()=>isT()?null:(MINE&&PUB&&MINE.hand===PUB.hand?MINE.cards:null),isTeacher:()=>isT()};
  ODDS=createOdds($("#oddsPanel"),{table:tbl});
  STOVE=createStove($("#stovePanel"),{table:tbl,solver:()=>solverAllowed()?SV:null,odds:()=>TOOLS.odds?ODDS:null,flash});
  CMB=createCombos($("#combosPanel"),{table:tbl,solver:()=>solverAllowed()?SV:null,flash});
  NB=createNotes($("#notesPanel"),{transport:mode==="lobby"?{send:o=>{if(ws&&wsOpen) ws.send(JSON.stringify(o))},canEdit:()=>isT()||svOn}:null,table:{current:()=>view()},solver:()=>SV,flash});
  NBPAL=notesPalette(NB.body,NB.foot); NBPAL.set("main");
  CH=createCharts($("#chartsPanel"),{transport:mode==="lobby"?{send:o=>{if(ws&&wsOpen) ws.send(JSON.stringify(o))},canEdit:()=>isT()}:null,isTeacher:()=>isT()||mode==="local",flash});
  svOn=mode==="local";
}
const solverAllowed=()=>!!mode&&(isT()||svOn);
// the poker stove: teachers always; students per the table setting (never / between hands / any time)
function stoveAllowed(){
  if(!mode) return false; if(isT()||mode==="local") return true;
  const P=view(), w=(P&&P.rules&&P.rules.stoveStudents)||"always";
  return w==="always"||(w==="between"&&!!P&&(P.phase==="idle"||P.phase==="done"));
}
// odds calculator and preflop charts: on for students unless the teacher turns them off
const toolOk=k=>!!mode&&(isT()||mode==="local"||((view()&&view().rules&&view().rules[k+"Students"])||"always")!=="off");
function setView(v){viewMode=v;lsSet("hsp-view",v);render()}
function applyView(){
  const ok=solverAllowed(), v=ok?viewMode:"table";
  document.body.classList.toggle("v-table",v==="table");document.body.classList.toggle("v-solver",v==="solver");document.body.classList.toggle("v-both",v==="both");
  $("#solverPane").hidden=!mode||v==="table";
  const sw=$("#viewSwitch"); sw.hidden=!ok;
  sw.querySelectorAll("[data-view-mode]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.viewMode===v)));
  const stoveOk=stoveAllowed();
  const oddsOk=toolOk("odds"), chartsOk=toolOk("charts");
  $("#chartsPanel").hidden=!mode||!TOOLS.charts||!chartsOk;
  $("#oddsPanel").hidden=!mode||!TOOLS.odds||!oddsOk;
  [["odds",oddsOk],["charts",chartsOk]].forEach(([k,ok])=>{const c=document.querySelector(`[data-tool="${k}"]`); if(c) c.disabled=!ok; const n=$("#"+k+"Note"); if(n) n.textContent=ok?"":" · your teacher has it turned off";}); $("#stovePanel").hidden=!mode||!TOOLS.stove||!stoveOk;
  const notesOk=solverAllowed(); $("#notesPanel").hidden=!mode||TOOLS.notes===false||!notesOk;
  const nc=document.querySelector('[data-tool="notes"]'); if(nc){nc.disabled=!notesOk;} const nn=$("#notesNote"); if(nn) nn.textContent=notesOk?"":" · opens when the solver does";
  const sc=document.querySelector('[data-tool="stove"]'); if(sc) sc.disabled=!stoveOk;
  $("#combosPanel").hidden=!mode||!TOOLS.combos||!stoveOk; const cc=document.querySelector('[data-tool="combos"]'); if(cc) cc.disabled=!stoveOk;
  const cn=$("#combosNote"); if(cn){const w=(view()&&view().rules&&view().rules.stoveStudents)||"always"; cn.textContent=stoveOk?"":w==="off"?" · your teacher has it turned off":" · opens between hands";}
  const sn=$("#stoveNote"); if(sn){const w=(view()&&view().rules&&view().rules.stoveStudents)||"always"; sn.textContent=stoveOk?"":w==="off"?" · your teacher has it turned off":" · opens between hands";}
  $("#toolsWrap").hidden=!mode;
  document.querySelectorAll("[data-tool]").forEach(x=>{x.checked=x.dataset.tool==="notes"?TOOLS.notes!==false:!!TOOLS[x.dataset.tool]});
  const dv=mode&&v!=="table"?v:null;
  if(dv){SVPAL.set("main");$("#svPal").hidden=false;DOCK.set(dv)}else{DOCK.set(null);SVPAL.set(null);$("#svPal").hidden=true}
  $("#dockReset").hidden=!DOCK.view;
}

function enterLobby(id,role,code){
  homeErr("");
  myName=($("#homeName").value||myName||"").trim().slice(0,16);
  if(!myName){homeErr("Enter your name first.");$("#homeName").focus();return}
  lsSet("hsp-name",myName);
  leaveLobby(true);
  const d=(homeList||[]).find(x=>x.id===id);
  mode="lobby"; ROLE=role; TCODE=code||""; L={id,name:d?d.name:id.toUpperCase()};
  wantWs=true; retry=0; lastErr=""; welcomed=false; mountSolver(); connect();
  pingT=setInterval(()=>{if(ws&&wsOpen) ws.send('{"t":"ping"}')},25000);
  setHash("lobby-"+id); updateConn(); render();
}
function leaveLobby(quiet){
  wantWs=false; clearTimeout(retryT); clearInterval(pingT); clearTimeout(localClockT); clearTimeout(botT); botKey=""; clearTimeout(dealT); dealT=null;
  if(ws){try{ws.close()}catch(e){}} ws=null; wsOpen=false;
  mode=null; ROLE=null; L=null; TCODE=""; PUB=null; MINE=null; HIST=0; peers=[]; myPeer=null; curs.clear(); welcomed=false;
  E.G=null; E.history.length=0; picker=null; sideTab="seats"; confirmReset=false; myBusy="[]"; unmountSolver(); svOn=false;
  if(!quiet){setHash("");loadLobbies();updateConn();render()}
}
function enterLocal(){
  leaveLobby(true); mode="local"; ROLE="teacher"; L={id:"",name:"Practice table"};
  E.G=freshGame("Practice table");
  if(SOLO.view==="student"){SOLO.seat=Math.min(SOLO.seat|0,E.G.size-1);fillBots()} else E.G.seats[0].pre=["As","Kh"];
  E.startHand(); E.history.length=0;
  mountSolver(); updateConn(); render();
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
    const pw=($("#newPw").value||"").trim();
    if(pw&&pw.length<3){homeErr("The student password needs at least 3 characters, or leave it blank.");$("#newPw").focus();return}
    const r=await fetch("/api/lobbies",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,code,pw:pw||undefined,key:$("#newKey").value||undefined})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){if(j.needsKey){needsKey=true;render()}homeErr(j.error||"Couldn't create the lobby.");return}
    saveCode(j.id,code); $("#newName").value=""; $("#newPw").value=""; $("#newCode").value=suggestCode();
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
function view(){return isT()?pubLike():soloStu()?soloView():PUB}
// what a player in the practice seat would see: their own cards, everyone else's only when shown
function soloView(){const p=E.pubView(),me=SOLO.seat,s=E.G.seats[me];if(s&&s.cards&&p.seats[me]) p.seats[me].cards=s.cards;p.rakeTotal=E.G.rakeTotal||0;return p}
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
  const rc=$("#roleChip"); rc.hidden=!inL; rc.textContent=ROLE==="teacher"&&!soloStu()?"Teacher":"Student";
  if(!inL){$("#stakeChip").hidden=true;applyView();renderHome();drawPicker();drawCursors();return}
  const T=isT(), P=view();
  if(!P){
    setHTML($("#table"),`<div class="rail"></div><div class="felt"></div><div class="center"><div class="street">Connecting</div><div class="result">Opening the table…</div></div>`);
    setHTML($("#actPanel"),`<p class="note">Nothing to act on yet.</p>`);setHTML($("#log"),"");
    setSide(`<div class="panel"><p class="note">Connecting to the lobby…</p></div>`);drawCursors();return;
  }
  $("#stakeChip").hidden=false; $("#stakeChip").textContent=`${money(P.blinds.sb)}/${money(P.blinds.bb)} NLHE · ${P.size}-max`;
  mySeat=T?-1:soloStu()?SOLO.seat:P.seats.findIndex(s=>s.uid===ME.cid);
  renderTable(P,T); renderAct(P,T); renderSolve(P,T); applyView(); if(SV) SV.tableUpdate(P); if(NB) NB.tableUpdate(P); if(ODDS&&TOOLS.odds) ODDS.tableUpdate(P); renderPoll();
  setHTML($("#log"),P.log.slice().reverse().map(t=>`<li>${esc(t)}</li>`).join("")||`<li class="muted">No hands yet.</li>`);
  if(T) renderTeacherSide(); else setSide(soloStu()?soloSide(P):studentSide(P));
  if(picker&&!T) picker=null;
  drawPicker(); drawCursors(); tick(); botPump(); autoDeal();
}
/* the table is a racetrack (straight sides, round ends); seats, bets and the button sit on smaller
   racetracks inside it. t runs 0..1 around the track, starting bottom centre and going left first.
   Units are the table box (16 x 11, its aspect ratio); results are percentages. */
const TW=16, TH=11;
function track(t,cy,rx,ry){
  const R=ry, L=Math.max(0,rx-ry), cx=TW/2, P=4*L+2*Math.PI*R;
  let s=(((t%1)+1)%1)*P, x, y;
  if(s<L){x=cx-s;y=cy+R}
  else if((s-=L)<Math.PI*R){const th=Math.PI/2+s/R;x=cx-L+R*Math.cos(th);y=cy+R*Math.sin(th)}
  else if((s-=Math.PI*R)<2*L){x=cx-L+s;y=cy-R}
  else if((s-=2*L)<Math.PI*R){const th=-Math.PI/2+s/R;x=cx+L+R*Math.cos(th);y=cy+R*Math.sin(th)}
  else{s-=Math.PI*R;x=cx+L-s;y=cy+R}
  return {x:x/TW*100,y:y/TH*100};
}
function seatPos(i,P,T){
  const rot=T?0:(mySeat>=0?mySeat:0);
  const t=((i-rot+P.size)%P.size)/P.size;
  return {...track(t,5.28,6.6,3.96),t};
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
    const open=s.has&&s.open&&!P.reveal;
    const tag0=s.out?"Sitting out":s.folded?(P.reveal&&s.has?"Folded · shown":"Folded"):s.allin?"All-in":me?"You":s.uid?"Student":s.bot?botLabel(s.bot)+" · bot":"";
    const tag=open?(tag0?tag0+" · ":"")+"Shown to all":tag0;
    // teachers: show or hide just this player's cards for everyone
    const eye=T&&mode!=="local"&&s.has&&!s.out&&!P.reveal&&!E.G.seats[i].shown?`<button class="showeye${s.open?" on":""}" type="button" data-open="${i}" aria-pressed="${!!s.open}" aria-label="${s.open?"Hide":"Show"} ${esc(s.name)}'s cards ${s.open?"again":"to everyone"}" title="${s.open?"Hide these cards again":"Show these cards to everyone"}">${s.open?"Hide":"Show"}</button>`:"";
    const showTake=ROLE==="student"&&mySeat<0&&!s.uid&&!s.bot;
    h+=`<div class="seat${P.toAct===i?" act":""}${s.folded?" folded":""}${me?" me":""}" data-anc="seat${i}" style="left:${pos.x}%;top:${pos.y}%">
      <div class="hole${open?" openhole":""}">${cards}${eye}</div>
      <div class="plate"><div class="nm">${esc(s.name)}</div><div class="stk">${money(s.stack)}</div>${tag?`<div class="tag">${tag}</div>`:""}
      ${showTake?`<button class="b sm" type="button" data-take="${i}">Take seat ${i+1}</button>`:""}</div></div>`;
    if(s.bet>0){const b=track(pos.t,5.17,4.3,2.64);h+=`<div class="bet" style="left:${b.x}%;top:${b.y}%">${money(s.bet)}</div>`}
    if(i===P.button){const d=track(pos.t+0.045,5.17,5.3,3.3);h+=`<div class="btnmark" style="left:${d.x}%;top:${d.y}%" aria-label="Dealer button">D</div>`}
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
      <div class="row"><button class="b primary big" type="button" data-cmd="deal">Deal hand</button><button class="b" type="button" data-cmd="undo"${undoCount()?"":" disabled"}>Undo</button>${revealBtn()}${mode==="lobby"?`<button class="b" type="button" data-poll="new">Ask a question</button>`:""}</div>
      <div class="row">${G.rules.straddle?"":`<button class="b sm${G.straddleNext?" on":""}" type="button" data-cmd="straddleNext" aria-pressed="${!!G.straddleNext}">${G.straddleNext?"Straddle on for next hand":"Straddle next hand"}</button>`}
        <button class="b sm${G.bombNext?" on":""}" type="button" data-cmd="bombNext" aria-pressed="${!!G.bombNext}">${G.bombNext?"Bomb pot is next":"Bomb pot next hand"}</button></div>
      <p class="optsum">${esc(optSummary(G.rules,P))} <span class="muted">Change these under Table setup.</span></p></div>`
      :soloStu()?soloDealBar(P)
      :`<p class="note">${P.phase==="done"?"Hand over. Waiting for a teacher to deal.":"Waiting for a teacher to deal."}</p><p class="optsum">${esc(optSummary(P.rules,P))}</p>`);
    return;
  }
  const i=P.toAct, s=P.seats[i], mine=T||i===mySeat;
  const toCall=Math.max(0,P.curBet-s.bet), maxTo=s.bet+s.stack;
  const minTo=Math.min(P.curBet===0?P.blinds.bb:P.curBet+P.minRaise,maxTo);
  if(s.bot&&!s.uid){setHTML(el,`<div class="actbar"><div class="who">${esc(s.name)} <span>(${esc(botLabel(s.bot))} bot, seat ${i+1})</span> is thinking…</div>${T?`<div class="row"><button class="b sm" type="button" data-cmd="undo"${undoCount()?"":" disabled"}>Undo</button>${revealBtn()}</div>`:""}</div>`);return}
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
    ${T&&mode==="lobby"?`<div class="row"><button class="b sm" type="button" data-poll="new">Ask everyone what ${esc(s.name)} should do</button></div>`:""}
    ${canRaise?`<div class="row"><input type="range" id="amtRange" min="${minTo}" max="${maxTo}" step="1" value="${def}" aria-label="Bet size">
      <input type="number" id="amtNum" min="${minTo}" max="${maxTo}" step="1" value="${def}" aria-label="Bet amount in dollars"></div>
    <div class="row">${[[.33,"⅓ pot"],[.5,"½ pot"],[.66,"⅔ pot"],[1,"Pot"]].map(([f,l])=>`<button class="b sm" type="button" data-size="${Math.min(maxTo,Math.max(minTo,sizeFor(P,f)))}">${l}</button>`).join("")}
      <button class="b sm" type="button" data-size="${minTo}">Min</button><button class="b sm" type="button" data-size="${maxTo}">All-in</button></div>`:""}
  </div>`);
}
/* the Solver panel under the action bar: load a street of this hand into the solver (heads-up only, no hole cards) */
function renderSolve(P,T){
  const el=$("#solvePanel"); const spots=P.spots||[];
  const who=(P.rules&&P.rules.solverStudents)||"always", between=P.phase==="idle"||P.phase==="done";
  const allowed=mode==="local"||T||(svOn&&(who==="always"||(who==="between"&&between)));
  if(!allowed||!spots.length){el.hidden=true;setHTML(el,"");return}
  el.hidden=false;
  const NAME={flop:"flop",turn:"turn",river:"river"};
  const btns=spots.map((sp,i)=>`<button class="b sm" type="button" data-svload="${i}">Open the ${NAME[sp.st]} in the solver <span class="muted">· ${sp.pl.length===2?`${esc(sp.pl[0].pos)} vs ${esc(sp.pl[1].pos)}`:`${sp.pl.length} players, study two at a time`}</span></button>`).join("");
  setHTML(el,`<h2>Solver</h2><div class="row">${btns}</div><p class="note">Loads this hand's board, pot and stacks into the solver${mode==="lobby"?", shared with everyone here who can see it":""}. Ranges start blank, so set them in the solver. While it follows the table, cards and bets dealt here move the solver along with the hand.</p>`);
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
  let h=`<div class="panel">${local?soloSwitch():""}<div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button class="tab" role="tab" type="button" aria-selected="${sideTab===k}" data-tab="${k}">${l}</button>`).join("")}</div>`;
  if(sideTab==="seats"){
    h+=`<div class="seatlist">`;
    for(let i=0;i<G.size;i++){const s=S(i);const cs=E.hostCards(s).cs;
      h+=`<div class="srow${G.toAct===i?" act":""}" data-anc="srow${i}"><div class="num">${i+1}</div>
        <input type="text" id="nm${i}" value="${esc(s.name)}" data-name="${i}" aria-label="Seat ${i+1} name" maxlength="16">
        <input type="number" id="st${i}" value="${s.stack}" min="0" step="1" data-stack="${i}" aria-label="Seat ${i+1} stack">
        <div class="ops"><span class="minicards">${[0,1].map(k=>cardHTML(cs&&cs[k]||null,{btn:`data-pick="seat" data-i="${i}" data-k="${k}"`,plus:!(cs&&cs[k]),empty:`Set seat ${i+1} card ${k+1}`})).join("")}</span>
        ${s.uid?`<span class="chip">Student</span><button class="b sm" type="button" data-unseat="${i}">Unseat</button>`:botSel(i,local?"You play it":"Open seat")}
        <button class="b sm" type="button" data-out="${i}">${s.out?"Sit in":"Sit out"}</button>
        ${G.button===i?`<span class="chip">Button</span>`:`<button class="b sm" type="button" data-btn="${i}"${between()?"":" disabled"}>Button here</button>`}</div>${s.bot==="custom"&&!s.uid?botSliders(i):""}</div>`}
    h+=`</div><p class="note">Click any card on the table or here to choose it. Cards set between hands are dealt on the next hand; empty slots are dealt at random.</p>
      <div class="note">${local?"Pick a player type to make a seat a computer player. It acts on its own after a short pause.":"Pick a player type to fill an empty seat with a computer player. It acts on its own, and students can't take its seat until you set it back to Open seat."} ${typesHelp()}</div>`;
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
      <div class="row">${revealBtn()}<span class="note">Shows every hand to students, folded ones too. To show just one player's cards, press <b>Show</b> above their seat on the table.</span></div>
      <h3 class="subh">What students can use</h3><p class="note">Everything is open to students unless you turn it off here.</p>
      <div class="fields" style="margin-top:4px">${[["solverSel","solverStudents","Solver and shared notes",3],["stoveSel","stoveStudents","Poker stove and combo counter",3],["oddsSel","oddsStudents","Odds calculator",2],["chartsSel","chartsStudents","Preflop charts (to read)",2]].map(([id,k,l,n])=>`<div class="field" style="grid-column:1/-1"><label for="${id}">${l}</label><select id="${id}" data-rule="${k}">${(n===3?[["always","Any time, even mid-hand"],["between","Only between hands"],["off","Never (teachers only)"]]:[["always","Yes"],["off","No (teachers only)"]]).map(([v,t])=>`<option value="${v}"${(r[k]||"always")===v?" selected":""}>${t}</option>`).join("")}</select></div>`).join("")}</div>
      <label class="toggle"><input type="checkbox" id="keepSetup"${G.keepSetup?" checked":""}><span>Keep my card setup for the next hand<br><span class="note">Replays the same hole cards so students can try other lines. Board cards you set are used once.</span></span></label>
      <div class="row" style="margin-top:8px">${!between()?`<button class="b" type="button" data-cmd="voidhand">Cancel this hand</button>`:""}
      ${confirmReset?`<span class="confirm"><span>Reset table, stacks and log?</span><button class="b sm warn" type="button" data-cmd="reset">Reset</button><button class="b sm" type="button" data-cmd="noreset">Keep</button></span>`:`<button class="b warn" type="button" data-cmd="askreset">Reset table…</button>`}</div></div></div>`;
  } else {
    h+=lockGroup()+dcGroup()+`<div class="students" id="stuList"></div>
      ${local?"":L.discord?`<p class="note">This table belongs to a Discord call. People can also join from a web browser, outside Discord, with this link: <b class="sel">${esc(SITE)}/play/#lobby-${esc(L.id)}</b>${L.locked?" (they'll need the password)":""}. To run it from your own browser instead, press <b>Open in browser</b> at the top; you stay the teacher there.`:`<p class="note">Students open <b>${esc(location.host)}/play</b>, pick <b>${esc(G.lname||L.name)}</b> from the lobby list, and tap an open seat. Or send them this link: <b>${esc(location.origin)}/play/#lobby-${esc(L.id)}</b>. Co-teachers join with the teacher code; you'll see each other's pointers, and a colored outline marks whatever another teacher is editing.</p>`}`;
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
/* ---------- Discord: post "the table is open" to the group's channel (teachers) ---------- */
let DCS=null, dcNote=null, dcUrl="", dcMsg="", dcBusy=false;
// teachers: lock the lobby with a student password, or open it again
let lockDraft="";
function lockGroup(){
  if(mode!=="lobby"||!isT()||!L||L.discord) return "";
  return `<div class="group lockgrp"><h3>${L.locked?"🔒 Password":"Lobby access"}</h3>
    <p class="note">${L.locked?"Students need the password to join. Teachers use the teacher code.":"Anyone with the lobby link or code can join as a student."}</p>
    <div class="row dcrow"><input type="text" id="lockIn" maxlength="40" autocomplete="off" placeholder="${L.locked?"New password":"Set a password"}" value="${esc(lockDraft)}" aria-label="Student password"><button class="b sm" type="button" id="lockGo" data-cmd="lockgo">${L.locked?"Change":"Lock with password"}</button>${L.locked?`<button class="b sm" type="button" id="lockOff" data-cmd="lockoff">Remove password</button>`:""}</div>
    <p class="note">Changing it doesn't remove anyone already here.</p></div>`;
}
function dcGroup(){
  if(mode!=="lobby"||!isT()||!DCS) return "";
  const note=dcNote&&Date.now()-dcNote.at<20000?(dcNote.err?`<p class="err" role="status">${esc(dcNote.err)}</p>`:`<p class="note dcok" role="status">${esc(dcNote.ok)}</p>`):"";
  if(!DCS.has) return `<div class="group dcgrp"><h3>Invite on Discord</h3>
    <p class="note">Post “the table is open” with a join link to your group's Discord channel. In Discord, open the channel's settings › <b>Integrations</b> › <b>Webhooks</b> › <b>New Webhook</b> › <b>Copy Webhook URL</b>, then paste it here.</p>
    <div class="row dcrow"><input type="url" id="dcUrl" placeholder="https://discord.com/api/webhooks/…" value="${esc(dcUrl)}" autocomplete="off" aria-label="Discord webhook link"><button class="b sm" type="button" data-cmd="dcset"${dcBusy?" disabled":""}>Save</button></div>${note}</div>`;
  const ago=DCS.last?Math.round((Date.now()-DCS.last)/60000):null;
  return `<div class="group dcgrp"><h3>Invite on Discord</h3>
    <p class="note">Posting to the channel webhook ending in <code>${esc(DCS.hint)}</code>. <button type="button" class="linkbtn" data-cmd="dcclear">Remove</button></p>
    <label class="toggle"><input type="checkbox" id="dcAuto"${DCS.auto?" checked":""}><span>Post automatically when a teacher opens the table<br><span class="note">At most once every 30 minutes.</span></span></label>
    <div class="field"><label for="dcMsg">Message <span class="muted">(optional)</span></label><input type="text" id="dcMsg" maxlength="300" placeholder="Like “River bluffs tonight, all levels welcome”" value="${esc(dcMsg)}"></div>
    <div class="row dcrow"><button class="b primary sm" type="button" data-cmd="dcpost"${dcBusy?" disabled":""}>Post to Discord</button><label class="toggle sm"><input type="checkbox" id="dcHere"><span>Notify the channel (@here)</span></label></div>
    <p class="note">${ago==null?"Nothing posted yet.":`Last posted ${ago<1?"just now":ago<60?ago+" min ago":Math.round(ago/60)+" h ago"}.`}</p>${note}</div>`;
}
// a dropdown someone has open in the side panel isn't redrawn under them (bots keep the table moving)
let selOpen=false;
document.addEventListener("pointerdown",e=>{selOpen=!!(e.target.tagName==="SELECT"&&e.target.closest("#side"))},true);
document.addEventListener("change",()=>{if(selOpen){selOpen=false;setTimeout(render,0)}},true);
document.addEventListener("focusout",e=>{if(selOpen&&e.target.tagName==="SELECT"){selOpen=false;setTimeout(render,0)}},true);
document.addEventListener("keydown",e=>{if(selOpen&&(e.key==="Escape"||e.key==="Tab")){selOpen=false;setTimeout(render,0)}},true);
function setSide(h){
  if(selOpen) return;
  const side=$("#side"); const f=document.activeElement; const fid=f&&side.contains(f)&&f.id;
  const typing=fid&&(f.tagName==="INPUT"&&f.type!=="checkbox"); const caret=typing&&f.type==="text"?[f.selectionStart,f.selectionEnd]:null; const val=typing?f.value:null;
  setHTML(side,h);
  if(fid){const el=document.getElementById(fid); if(el&&el!==document.activeElement){el.focus(); if(val!=null) el.value=val; if(caret) try{el.setSelectionRange(caret[0],caret[1])}catch(e){}}}
}
/* ---------- computer players ("bots") and the practice table's student view ---------- */
const BP_KEYS=[["vpip","Plays (VPIP)","% of hands it plays"],["pfr","Raises first (PFR)","% of hands it raises preflop"],["agg","Aggression","how often it bets and raises good hands"],["bluff","Bluffing","how often it bets or raises weak hands"],["fold","Folds to pressure","how readily it gives up when bet into"]];
function botSel(i,none){
  const s=S(i), tip=s.bot?BOT_TYPES[s.bot].blurb:"";
  return `<select data-bot="${i}" aria-label="Seat ${i+1} player type" title="${esc(tip)}"><option value="">${esc(none)}</option>${BOT_ORDER.map(k=>`<option value="${k}"${s.bot===k?" selected":""}>Bot: ${esc(BOT_TYPES[k].short)}</option>`).join("")}</select>`;
}
function botSliders(i){
  const s=S(i), d=BOT_TYPES.custom, bp=s.bp||{};
  return `<div class="bpgrid" data-anc="bp${i}">${BP_KEYS.map(([k,l,h])=>{const v=Number.isFinite(bp[k])?bp[k]:d[k];return `<label class="bp" title="${esc(h)}"><span>${l} <b>${v}</b></span><input type="range" min="0" max="100" step="1" value="${v}" data-bp="${i}" data-k="${k}" aria-label="Seat ${i+1} ${l}"></label>`}).join("")}</div>`;
}
const typesHelp=()=>`<details class="types"><summary>What the player types do</summary><dl>${BOT_ORDER.map(k=>`<dt>${esc(BOT_TYPES[k].label)}</dt><dd>${esc(BOT_TYPES[k].blurb)}</dd>`).join("")}</dl></details>`;
function botOp(op){if(mode==="local"){if(E.runOp(op)){localClock();render()}}else sendOp(op)}
function soloSwitch(){
  return `<div class="soloswitch"><span class="seg" role="group" aria-label="Practice view"><button type="button" data-solo="teacher" aria-pressed="${SOLO.view!=="student"}">Teacher view</button><button type="button" data-solo="student" aria-pressed="${SOLO.view==="student"}">Student view</button></span>
    <span class="note">${SOLO.view==="student"?"You play one seat against computer players.":"See and set every card. Switch to Student view to play a seat yourself."}</span></div>`;
}
// student view: every seat except yours is a computer player (Balanced unless you pick a type)
function fillBots(){
  const G=E.G; if(!G) return; SOLO.seat=Math.max(0,Math.min(SOLO.seat|0,G.size-1));
  G.seats.forEach((s,j)=>{if(j>=G.size) return; if(j===SOLO.seat){s.bot=null;s.out=false} else if(!s.bot){s.bot="balanced";s.out=false}});
  const mine=G.seats[SOLO.seat]; if(myName&&mine.name===NAMES[SOLO.seat]) mine.name=myName;
}
function setSolo(v){
  if(SOLO.view===v) return; SOLO.view=v; saveSolo(); picker=null; clearTimeout(dealT); dealT=null;
  if(v==="student") fillBots();
  render();
}
function soloDealBar(P){
  const me=P.seats[SOLO.seat], broke=me&&me.stack<=0;
  if(broke) return `<div class="actbar"><div class="who">You're out of chips.</div><div class="row"><button class="b primary big" type="button" data-solo="rebuy">Rebuy for ${money(P.blinds.bb*100)}</button></div></div>`;
  const waiting=P.phase==="done"&&SOLO.auto;
  return `<div class="actbar"><div class="who">${P.phase==="done"?"Hand over.":"Ready."} <span>${waiting?"Next hand in a moment…":"Deal when you're ready."}</span></div>
    <div class="row"><button class="b primary big" type="button" data-solo="deal">${waiting?"Deal now":"Deal hand"}</button>${waiting?`<button class="b" type="button" data-solo="pause">Pause</button>`:""}</div></div>`;
}
function soloSide(P){
  const G=E.G, me=SOLO.seat, btw=between();
  const opp=[...Array(G.size).keys()].filter(j=>j!==me);
  return `<div class="panel">${soloSwitch()}<h2>Solo practice</h2>
    <p class="note">You play seat ${me+1}; every other seat is a computer player. Their cards stay hidden until showdown, and the solver and tools only see what you see.</p>
    <div class="fields"><div class="field"><label for="soloSeat">Your seat</label><select id="soloSeat"${btw?"":" disabled"}>${[...Array(G.size).keys()].map(j=>`<option value="${j}"${j===me?" selected":""}>Seat ${j+1}</option>`).join("")}</select></div>
      <div class="field"><label for="soloSize">Players</label><select id="soloSize"${btw?"":" disabled"}>${[2,3,4,5,6,7,8,9].map(n=>`<option${n===G.size?" selected":""}>${n}</option>`).join("")}</select></div></div>
    <label class="toggle"><input type="checkbox" id="soloAuto"${SOLO.auto?" checked":""}><span>Deal the next hand automatically</span></label>
    <h3 class="subh">Opponents</h3>
    <div class="field"><label for="botAll">Make everyone</label><select id="botAll"><option value="">Choose a type…</option>${BOT_ORDER.filter(k=>k!=="custom").map(k=>`<option value="${k}">${esc(BOT_TYPES[k].label)}</option>`).join("")}<option value="mix">A random mix</option></select></div>
    <div class="seatlist">${opp.map(j=>{const s=S(j);return `<div class="srow bot${G.toAct===j?" act":""}"><div class="num">${j+1}</div><div class="nm">${esc(s.name)} <span class="muted">· ${money(s.stack)}</span></div><div></div>
      <div class="ops">${botSel(j,"Bot: Balanced")}</div>${s.bot==="custom"?botSliders(j):""}</div>`}).join("")}</div>
    <div class="note">${typesHelp()}</div>
    <div class="row" style="margin-top:8px"><button class="b sm" type="button" data-solo="stacks">Reset every stack to ${money(G.blinds.bb*100)}</button></div></div>`;
}
let botT=null, botKey="", dealT=null;
// practice table: computer players act on this device after a short pause
function botPump(){
  const G=E.G, i=G&&G.toAct;
  const on=mode==="local"&&G&&i!=null&&["preflop","flop","turn","river"].includes(G.phase)&&!!G.seats[i].bot;
  const key=on?G.hand+":"+G.turn:"";
  if(key===botKey) return; clearTimeout(botT); botKey=key; if(!on) return;
  botT=setTimeout(()=>{
    if(mode!=="local"||!E.G||E.G.hand+":"+E.G.turn!==key||E.G.toAct!==i||!E.G.seats[i].bot) return;
    let d; try{d=botDecide(E.G,i)}catch(e){console.error(e);d={a:"fold"}}
    if(!E.runOp({t:"act",seat:i,a:d.a,amt:d.amt})&&!E.runOp({t:"act",seat:i,a:"check"})) E.runOp({t:"act",seat:i,a:"fold"});
    botKey=""; localClock(); render();
  },thinkMs(G));
}
// student view: the next hand starts by itself a few seconds after the last one ends
function autoDeal(){
  const G=E.G, want=soloStu()&&SOLO.auto&&G.phase==="done"&&G.seats[SOLO.seat].stack>0&&E.readyCount()>=2;
  if(!want){if(dealT){clearTimeout(dealT);dealT=null}return}
  if(dealT) return;
  const h=G.hand; dealT=setTimeout(()=>{dealT=null;if(soloStu()&&SOLO.auto&&E.G.phase==="done"&&E.G.hand===h){E.runOp({t:"deal"});localClock();render()}},2800);
}
function soloCmd(c){
  const G=E.G;
  if(c==="teacher"||c==="student"){setSolo(c);return}
  if(!soloStu()) return;
  if(c==="deal"){clearTimeout(dealT);dealT=null;if(E.readyCount()<2){flash("Need at least two players with chips.");return}E.runOp({t:"deal"});localClock();render();return}
  if(c==="pause"){SOLO.auto=false;saveSolo();clearTimeout(dealT);dealT=null;render();return}
  if(c==="rebuy"){E.runOp({t:"stack",i:SOLO.seat,v:G.blinds.bb*100});render();return}
  if(c==="stacks"){E.runOp({t:"allstacks",v:G.blinds.bb*100});render();return}
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
  else h=live.length?live.map(l=>{const id=esc(l.id); const mine=!!codes()[l.id];
    return `<div class="lob${l.live?" live":""}"><div><div class="ttl">${esc(String(l.name||"Lobby").slice(0,28))}</div>
      <div class="meta"><span class="dot ${l.live?"on":""}" style="display:inline-block;margin-right:5px"></span>${l.locked?"🔒 Password · ":""}${l.live?"Teacher here":"No teacher right now"} · code ${esc(String(l.id).toUpperCase())} · ${esc(String(l.stakes||"").slice(0,16))} · ${+l.seated||0}/${+l.size||0} seated${l.hand?` · hand #${+l.hand}`:""}</div></div>
      <div class="row">${mine?`<button class="b sm primary" type="button" data-rejoin="${id}">Rejoin as teacher</button><button class="b sm" type="button" data-join="${id}">Join as student</button><button class="b sm" type="button" data-teach="${id}">Manage</button>`:`<button class="b sm primary" type="button" data-join="${id}">Join as student</button><button class="b sm" type="button" data-teach="${id}">Teach</button>`}</div></div>`}).join("")
    :`<p class="note">No lobbies yet. Start one below.</p>`;
  setHTML($("#dirList"),h);
  $("#keyField").hidden=!needsKey;
  const tf=$("#teachForm"); tf.hidden=!teachFor;
  $("#pwForm").hidden=!pwFor; if(pwFor) $("#pwName").textContent=pwFor.name||String(pwFor.id).toUpperCase();
  if(teachFor){$("#teachName").textContent=teachFor.name;
    setHTML($("#delRow"),delConfirm?`<span class="confirm"><span>Delete this lobby for everyone? This can't be undone.</span><button class="b sm warn" type="button" id="delGo">Delete</button><button class="b sm" type="button" id="delNo">Keep</button></span>`:`<button class="b sm warn" type="button" id="delAsk">Delete this lobby…</button>`)}
  $("#homeMsg").textContent=homeMsg;
}
function homeErr(t){homeMsg=t||"";const m=$("#homeMsg");if(m) m.textContent=homeMsg}
let flashT=null;
function flash(t){setConn(true,t);clearTimeout(flashT);flashT=setTimeout(updateConn,3500)}
function setConn(ok,t){$("#connDot").className="dot "+(ok?"on":"off");$("#connTxt").textContent=t}
function updateConn(){
  const dco=$("#dcOpen"); if(dco) dco.hidden=!(IN_DISCORD&&mode==="lobby"&&L);
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
  if(mode!=="lobby"||!(isT()||svOn)) return;
  let el=e.target&&e.target.closest&&e.target.closest("[data-anc]"); let c=null;
  if(!isT()&&el&&!/^sv/.test(el.dataset.anc)) el=null;
  if(el){const r=el.getBoundingClientRect(); if(r.width&&r.height) c={a:el.dataset.anc,x:+((e.clientX-r.left)/r.width).toFixed(3),y:+((e.clientY-r.top)/r.height).toFixed(3)}}
  curOut=c; sendCur();
},{passive:true});
document.documentElement.addEventListener("pointerleave",()=>{curOut=null;sendCur()});
function sendCur(now){
  if(mode!=="lobby"||!(ROLE==="teacher"||svOn)||!ws||!wsOpen) return;
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
    if(!T&&!/^(seat\d|board|sv[a-z]*)$/.test(p.a)) continue;
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
  if(!e.target.closest("#toolsWrap")&&!$("#toolsMenu").hidden){$("#toolsMenu").hidden=true;$("#toolsBtn").setAttribute("aria-expanded","false")}
  const t=e.target.closest("button"); if(!t) return;
  if(t.id==="toolsBtn"){const m=$("#toolsMenu");m.hidden=!m.hidden;t.setAttribute("aria-expanded",String(!m.hidden));return}
  if(t.dataset.poll){pollClick(t);return}
  if(t.dataset.solo){soloCmd(t.dataset.solo);return}
  if(t.closest("#solverRoot")) return;
  if(t.dataset.viewMode){setView(t.dataset.viewMode);return}
  if(t.dataset.svload!=null&&SV){const P=view();const sp=P&&(P.spots||[])[+t.dataset.svload];if(sp){SV.loadTableSpot(sp,P);if(viewMode==="table") setView(window.innerWidth>=1100?"both":"solver")}return}
  if(t.closest("#modal")){
    if(!picker) return;
    if(t.dataset.slot!=null){picker.k=+t.dataset.slot;drawPicker()}
    else if(t.dataset.card){setPicked(t.dataset.card);const n=picker.kind==="board"?5:2;if(picker.k<n-1){picker.k++;drawPicker()}}
    else if(t.dataset.pk==="random"){setPicked("random")}
    else if(t.dataset.pk==="clear"){setPicked(null)}
    else if(t.dataset.pk==="done"){closePicker()}
    return;
  }
  if(t.id==="dockReset"){DOCK.reset();SVPAL.reset();if(NBPAL) NBPAL.reset();render();return}
  if(t.id==="themeBtn"){const nt=document.documentElement.dataset.theme==="light"?"dark":"light";document.documentElement.dataset.theme=nt;try{localStorage.setItem("hsp-theme",nt)}catch(x){}render();return}
  if(t.id==="leaveBtn"){leaveLobby();return}
  if(!mode){
    if(t.id==="practiceBtn"){enterLocal();return}
    if(t.id==="createBtn"){createLobby();return}
    if(t.dataset.join){const id=t.dataset.join,l=(homeList||[]).find(x=>x.id===id);
      if(l&&l.locked&&!pws()[id]){pwFor={id,name:l.name};teachFor=null;homeErr("");render();setTimeout(()=>{const i=$("#pwIn");if(i) i.focus()},50);return}
      enterLobby(id,"student");return}
    if(t.id==="pwGo"&&pwFor){const v=$("#pwIn").value.trim();if(!v){homeErr("Enter the password.");return}savePw(pwFor.id,v);const id=pwFor.id;pwFor=null;$("#pwIn").value="";enterLobby(id,"student");return}
    if(t.id==="pwNo"){pwFor=null;homeErr("");render();return}
    if(t.dataset.rejoin){const c=codes()[t.dataset.rejoin];if(c) enterLobby(t.dataset.rejoin,"teacher",c); else {teachFor={id:t.dataset.rejoin,name:t.dataset.rejoin};render()}return}
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
    if(t.dataset.open!=null){const i=+t.dataset.open;sendOp({t:"open",i,v:!S(i).open});return}
    const c=t.dataset.cmd;
    if(c==="deal"){if(E.readyCount()<2){flash("Need at least two seated players with chips.");return}sendOp({t:"deal"});return}
    if(c==="undo"){sendOp({t:"undo"});return}
    if(c==="reveal"){sendOp({t:"reveal",v:!E.G.revealAll});return}
    if(c==="straddleNext"){sendOp({t:"straddleNext",v:!E.G.straddleNext});return}
    if(c==="bombNext"){sendOp({t:"bombNext",v:!E.G.bombNext});return}
    if(c==="time"){sendOp({t:"time"});return}
    if(c==="rakereset"){sendOp({t:"rakereset"});return}
    if(c==="dcset"){const u=($("#dcUrl")||{}).value||dcUrl;dcUrl=u;wsSend({t:"dc",op:"set",url:u.trim()});return}
    if(c==="lockgo"){const v=(($("#lockIn")||{}).value||lockDraft).trim();if(v.length<3){flash("The password needs at least 3 characters.");return}wsSend({t:"lockpw",pw:v});lockDraft="";return}
    if(c==="lockoff"){wsSend({t:"lockpw",pw:""});return}
    if(c==="dcclear"){wsSend({t:"dc",op:"clear"});dcNote=null;return}
    if(c==="dcpost"){const here=!!($("#dcHere")||{}).checked;dcBusy=true;render();setTimeout(()=>{dcBusy=false;render()},4000);wsSend({t:"dc",op:"post",msg:dcMsg,here});return}
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
  else if(t.dataset.bp!=null){const b=t.closest("label").querySelector("b");if(b) b.textContent=t.value}
  else if(t.id==="homeName"){myName=t.value.slice(0,16);lsSet("hsp-name",myName)}
  else if(t.dataset.pin){pollInput(t)}
  else if(t.id==="dcUrl"){dcUrl=t.value}
  else if(t.id==="lockIn"){lockDraft=t.value}
  else if(t.id==="dcMsg"){dcMsg=t.value}
});
document.addEventListener("change",e=>{
  if(e.target.dataset.tool){setTool(e.target.dataset.tool,e.target.checked);return}
  const t=e.target;
  if(mode&&t.dataset.bot!=null&&(isT()||soloStu())){const i=+t.dataset.bot;botOp({t:"bot",i,v:t.value||(soloStu()?"balanced":null)});return}
  if(mode&&t.dataset.bp!=null&&(isT()||soloStu())){botOp({t:"bot",i:+t.dataset.bp,v:"custom",p:{[t.dataset.k]:+t.value}});return}
  if(soloStu()){
    if(t.id==="soloAuto"){SOLO.auto=t.checked;saveSolo();render();return}
    if(t.id==="soloSeat"&&between()){SOLO.seat=+t.value;saveSolo();fillBots();render();return}
    if(t.id==="soloSize"&&between()){E.runOp({t:"size",v:+t.value});fillBots();render();return}
    if(t.id==="botAll"&&t.value){const v=t.value;for(let j=0;j<E.G.size;j++) if(j!==SOLO.seat){const k=v==="mix"?BOT_ORDER.filter(x=>x!=="custom")[Math.floor(Math.random()*7)]:v;E.runOp({t:"bot",i:j,v:k})}render();return}
    return;
  }
  if(!mode||!isT()) return;
  if(t.id==="dcAuto"){wsSend({t:"dc",op:"auto",v:t.checked});return}
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
  else if(id==="homeName"&&pendingHash){e.preventDefault();myName=($("#homeName").value||"").trim().slice(0,16);if(myName){pendingHash=false;openFromHash()}}
  else if(id==="pwIn"&&pwFor){e.preventDefault();$("#pwGo").click()}
  else if(e.target.matches&&e.target.matches("#side input[type=text],#side input[type=number]")) e.target.blur();
});
function doAct(type){
  const P=view(); if(!P||P.toAct==null) return;
  const amt=type==="raise"?+($("#amtNum")||{}).value:0;
  if(isT()){sendOp({t:"act",seat:P.toAct,a:type,amt});return}
  if(P.toAct!==mySeat) return;
  if(soloStu()){E.runOp({t:"act",seat:mySeat,a:type,amt});localClock();render();return}
  if(wsSend({t:"act",a:type,amt})) setHTML($("#actPanel"),`<p class="note">Sent…</p>`);
}

/* ---------- start ---------- */
function openFromHash(){
  // #lobby-ID, or #lobby-ID/t-CODE when a teacher moves a table from Discord to their browser
  const m=/^lobby-([a-z0-9]{3,12})(?:\/t-(.{4,120}))?$/i.exec((location.hash||"").slice(1)); if(!m||mode) return;
  const id=m[1].toLowerCase();
  if(m[2]){try{saveCode(id,decodeURIComponent(m[2]))}catch(e){} history.replaceState(null,"","#lobby-"+id)}
  const code=codes()[id];
  if(!myName){homeErr("Enter your name above and press Enter to join.");pendingHash=true;$("#homeName").focus();return}
  if(code) enterLobby(id,"teacher",code); else enterLobby(id,"student");
}
window.addEventListener("hashchange",()=>{if(!mode&&!new URLSearchParams(location.search).has("frame_id")) openFromHash()});
$("#homeName").value=myName; $("#newCode").value=suggestCode();
updateConn(); render();
// inside a Discord voice channel (an Activity): sign in with Discord and go straight to this call's table
$("#dcOpen").onclick=()=>{ if(!L) return;
  const url=`${SITE}/play/#lobby-${L.id}${ROLE==="teacher"&&TCODE?"/t-"+encodeURIComponent(TCODE):""}`;
  if(DSDK) DSDK.openLink(url); else window.open(url,"_blank","noopener");
  flash(ROLE==="teacher"?"Opening your browser: you'll be the teacher there too":"Opening your browser");
};
if(IN_DISCORD){
  document.body.classList.add("in-discord");
  homeErr("Connecting to Discord…");
  import("./discord.js").then(m=>{DSDK=m;return m.startDiscord(t=>homeErr(t))}).then(j=>{
    homeErr(""); myName=j.name; $("#homeName").value=j.name; lsSet("hsp-name",myName);
    if(j.role==="teacher"&&j.code) saveCode(j.id,j.code);
    enterLobby(j.id,j.role,j.code);
  }).catch(e=>homeErr("Couldn't open the table in Discord: "+(e&&e.message||e)));
} else loadLobbies().then(()=>{updateConn();openFromHash()});
