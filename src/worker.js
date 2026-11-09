// Hot Seat Poker server (Cloudflare Worker + Durable Objects).
// - Each lobby is one Durable Object ("Lobby") that runs the game engine and talks to everyone over WebSockets.
// - One "Directory" object keeps the list of lobbies for the home page.
// - The page itself (public/) is served as static files.
import {DurableObject} from "cloudflare:workers";
import {createEngine,freshGame} from "../public/engine.js";

const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
const rid=n=>{const al="abcdefghjkmnpqrstuvwxyz23456789";const a=new Uint32Array(n);crypto.getRandomValues(a);return [...a].map(x=>al[x%al.length]).join("")};
async function sha(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
const normCode=c=>String(c||"").trim().toUpperCase().replace(/\s+/g,"").slice(0,40);
const cleanName=n=>String(n||"").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g,"").trim().slice(0,16);
const lobbyStub=(env,id)=>env.LOBBY.get(env.LOBBY.idFromName(id));
const dirStub=env=>env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
const MAX_LOBBIES=200, MAX_SOCKETS=80;

export default {
  async fetch(req,env){
    const url=new URL(req.url), p=url.pathname;
    try{
      if(p==="/api/lobbies"&&req.method==="GET") return json({lobbies:await dirStub(env).list(),needsKey:!!env.CREATE_KEY});
      if(p==="/api/lobbies"&&req.method==="POST"){
        let b; try{b=await req.json()}catch(e){return json({error:"Bad request."},400)}
        if(env.CREATE_KEY&&String(b.key||"")!==env.CREATE_KEY) return json({error:"This site needs the organizer key to start a lobby.",needsKey:true},403);
        const name=cleanName(b.name)||"Study table", code=normCode(b.code);
        if(code.length<4) return json({error:"The teacher code needs at least 4 letters or numbers."},400);
        const dir=dirStub(env); if((await dir.count())>=MAX_LOBBIES) return json({error:"There are too many lobbies. Delete an old one first."},429);
        const id=rid(6);
        await lobbyStub(env,id).init(id,String(b.name||"").trim().slice(0,28)||name,await sha(id+"|"+code));
        return json({id});
      }
      let m=/^\/api\/lobbies\/([a-z0-9]{3,12})\/delete$/.exec(p);
      if(m&&req.method==="POST"){let b={};try{b=await req.json()}catch(e){} const r=await lobbyStub(env,m[1]).destroy(normCode(b.code));return json(r,r.ok?200:403)}
      m=/^\/ws\/([a-z0-9]{3,12})$/.exec(p);
      if(m){
        if(req.headers.get("Upgrade")!=="websocket") return new Response("Expected a WebSocket",{status:426});
        return lobbyStub(env,m[1]).fetch(req);
      }
    }catch(e){return json({error:"Server error. Try again in a moment."},500)}
    return env.ASSETS.fetch(req);
  }
};

export class Directory extends DurableObject{
  async list(){const m=await this.ctx.storage.list({prefix:"l:"});return [...m.values()].sort((a,b)=>(b.live-a.live)||(b.created-a.created))}
  async count(){return (await this.ctx.storage.list({prefix:"l:"})).size}
  async put(s){await this.ctx.storage.put("l:"+s.id,s)}
  async remove(id){await this.ctx.storage.delete("l:"+id)}
}

export class Lobby extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.E=createEngine(); this.meta=null; this.toks={}; this.fails=[]; this.curs=new Map(); this.lastDir="";
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}','{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async()=>{
      const v=await ctx.storage.get(["meta","g","hist","toks"]);
      this.meta=v.get("meta")||null; this.toks=v.get("toks")||{};
      if(v.get("g")) this.E.G=v.get("g");
      (v.get("hist")||[]).forEach(h=>this.E.history.push(h));
    });
  }
  async init(id,name,hash){
    this.meta={id,name,hash,created:Date.now()}; this.E.G=freshGame(name); this.E.history.length=0;
    await this.ctx.storage.put({meta:this.meta,g:this.E.G,hist:[],toks:{}});
    await this.dirUpdate(true);
  }
  async destroy(code){
    if(!this.meta) return {ok:true};
    if(!(await this.checkCode(code))) return {ok:false,error:"That teacher code doesn't match this lobby."};
    const id=this.meta.id;
    for(const ws of this.ctx.getWebSockets()){try{ws.send(JSON.stringify({t:"deleted"}));ws.close(4004,"Lobby deleted")}catch(e){}}
    await this.ctx.storage.deleteAll(); await dirStub(this.env).remove(id);
    this.meta=null; this.E.G=null; this.E.history.length=0; this.toks={};
    return {ok:true};
  }
  async checkCode(code){
    const now=Date.now(); this.fails=this.fails.filter(t=>now-t<60000);
    if(this.fails.length>=8) return false;
    const ok=(await sha(this.meta.id+"|"+normCode(code)))===this.meta.hash;
    if(!ok) this.fails.push(now);
    return ok;
  }
  async fetch(req){
    const pair=new WebSocketPair(); const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if(!this.meta){server.send(JSON.stringify({t:"error",code:"nolobby",msg:"That lobby doesn't exist anymore."}));server.close(4004,"No such lobby");return new Response(null,{status:101,webSocket:client})}
    if(this.ctx.getWebSockets().length>MAX_SOCKETS){server.send(JSON.stringify({t:"error",code:"full",msg:"This lobby is full."}));server.close(4008,"Full");return new Response(null,{status:101,webSocket:client})}
    server.serializeAttachment({peer:rid(8),role:null,name:"",cid:null});
    return new Response(null,{status:101,webSocket:client});
  }
  sockets(){return this.ctx.getWebSockets().map(ws=>({ws,a:ws.deserializeAttachment()||{}})).filter(x=>x.a.role&&x.ws.readyState===1)}
  send(ws,o){try{ws.send(JSON.stringify(o))}catch(e){}}
  stateFor(a,pub){
    const E=this.E;
    if(a.role==="teacher") return {t:"state",now:Date.now(),g:E.G,hist:E.history.length};
    const seat=E.G.seats.findIndex((s,i)=>i<E.G.size&&s.uid===a.cid);
    return {t:"state",now:Date.now(),pub,mine:seat>=0?{hand:E.G.hand,seat,cards:E.G.seats[seat].cards}:null};
  }
  broadcastState(){const pub=this.E.pubView();for(const {ws,a} of this.sockets()) this.send(ws,this.stateFor(a,pub))}
  broadcastPeers(){
    const list=this.sockets().map(({a})=>({peer:a.peer,name:a.name,role:a.role,seat:a.role==="student"?this.E.G.seats.findIndex((s,i)=>i<this.E.G.size&&s.uid===a.cid):-1}));
    for(const {ws} of this.sockets()) this.send(ws,{t:"peers",list});
  }
  async commit(){
    const E=this.E;
    if(E.history.length>40) E.history.splice(0,E.history.length-40);
    const dl=E.armClock(Date.now());
    await this.ctx.storage.put({g:E.G,hist:E.history});
    if(dl) await this.ctx.storage.setAlarm(dl); else await this.ctx.storage.deleteAlarm();
    this.broadcastState(); this.broadcastPeers(); await this.dirUpdate();
  }
  async dirUpdate(force){
    if(!this.meta||!this.E.G) return;
    const G=this.E.G, socks=this.sockets();
    const s={id:this.meta.id,name:G.lname||this.meta.name,created:this.meta.created,stakes:`$${G.blinds.sb}/$${G.blinds.bb}`,size:G.size,
      seated:G.seats.filter((x,i)=>i<G.size&&x.uid).length,hand:G.hand,teachers:socks.filter(x=>x.a.role==="teacher").length,
      students:socks.filter(x=>x.a.role==="student").length};
    s.live=s.teachers>0;
    const k=JSON.stringify(s); if(!force&&k===this.lastDir) return; this.lastDir=k;
    try{await dirStub(this.env).put(s)}catch(e){}
  }
  async webSocketMessage(ws,raw){
    if(typeof raw!=="string"||raw.length>8000) return;
    let m; try{m=JSON.parse(raw)}catch(e){return}
    if(!m||typeof m!=="object") return;
    if(!this.meta||!this.E.G){this.send(ws,{t:"error",code:"nolobby",msg:"That lobby doesn't exist anymore."});ws.close(4004,"No such lobby");return}
    const a=ws.deserializeAttachment()||{};
    if(m.t==="hello"){
      const cid=String(m.cid||""), tok=String(m.tok||"");
      if(!/^[a-z0-9]{8,40}$/.test(cid)||tok.length<16||tok.length>100){this.send(ws,{t:"error",code:"bad",msg:"Please reload the page."});ws.close(4000,"Bad hello");return}
      const th=await sha(tok);
      if(this.toks[cid]&&this.toks[cid]!==th){this.send(ws,{t:"error",code:"bad",msg:"Please reload the page."});ws.close(4000,"Bad id");return}
      if(!this.toks[cid]){const keys=Object.keys(this.toks);if(keys.length>2000) delete this.toks[keys[0]];this.toks[cid]=th;await this.ctx.storage.put("toks",this.toks)}
      const role=m.role==="teacher"?"teacher":"student";
      if(role==="teacher"&&!(await this.checkCode(m.code))){this.send(ws,{t:"error",code:"badcode",msg:this.fails.length>=8?"Too many wrong codes. Wait a minute and try again.":"That teacher code doesn't match this lobby."});ws.close(4001,"Bad code");return}
      Object.assign(a,{cid,role,name:cleanName(m.name)||(role==="teacher"?"Teacher":"Student")}); ws.serializeAttachment(a);
      this.send(ws,{t:"welcome",role,peer:a.peer,lobby:{id:this.meta.id,name:this.E.G.lname||this.meta.name}});
      this.send(ws,this.stateFor(a,this.E.pubView()));
      for(const [peer,c] of this.curs) if(peer!==a.peer) this.send(ws,c);
      this.broadcastPeers(); await this.dirUpdate();
      return;
    }
    if(!a.role) return;
    const E=this.E;
    switch(m.t){
      case "op": if(a.role!=="teacher") return;
        if(E.runOp(m.op)) await this.commit(); else this.send(ws,this.stateFor(a,E.pubView()));
        return;
      case "seat": if(a.role!=="student") return;
        if(E.seatReq(a.cid,a.name,Number(m.i))) await this.commit();
        return;
      case "act": if(a.role!=="student") return;
        if(E.actFor(a.cid,String(m.a),Number(m.amt)||0)) await this.commit(); else this.send(ws,this.stateFor(a,E.pubView()));
        return;
      case "name": a.name=cleanName(m.name)||a.name; ws.serializeAttachment(a); this.broadcastPeers(); return;
      case "cur":{ if(a.role!=="teacher") return;
        const c=m.cur&&typeof m.cur==="object"&&typeof m.cur.a==="string"&&/^[a-z]{2,8}\d?$/.test(m.cur.a)?{a:m.cur.a,x:Math.min(1,Math.max(0,+m.cur.x||0)),y:Math.min(1,Math.max(0,+m.cur.y||0))}:null;
        const busy=Array.isArray(m.busy)?m.busy.filter(b=>typeof b==="string"&&/^[a-z]{2,8}\d?$/.test(b)).slice(0,4):[];
        const out={t:"cur",peer:a.peer,name:a.name,cur:c,busy}; this.curs.set(a.peer,out);
        for(const {ws:o} of this.sockets()) if(o!==ws) this.send(o,out);
        return;}
    }
  }
  async webSocketClose(ws){
    const a=ws.deserializeAttachment()||{};
    try{ws.close()}catch(e){}
    if(a.peer){this.curs.delete(a.peer);for(const {ws:o} of this.sockets()) if(o!==ws) this.send(o,{t:"cur",peer:a.peer,cur:null,busy:[]})}
    this.broadcastPeers(); await this.dirUpdate();
  }
  async webSocketError(ws){await this.webSocketClose(ws)}
  async alarm(){
    const E=this.E; if(!E.G) return;
    const G=E.G;
    if(G.toAct==null||!G.deadline) return;
    if(Date.now()<G.deadline-250){await this.ctx.storage.setAlarm(G.deadline);return}
    if(E.runOp({t:"timeout",turn:G.turn})) await this.commit();
  }
}
