import { connect } from "cloudflare:sockets";

/*
 * ============================================================================
 * Telegram WEB Proxy for Cloudflare Workers (Single-File ES Module)
 * Architecture, Middle-End (ME) Protocol Analysis & Direct-DC Implementation
 * ============================================================================
 *
 * RESEARCH SUMMARY & PROTOCOL FINDINGS:
 *
 * 1. Reference Architecture & Telego (v0.6.8) WEB Mode:
 *    - Telegram Desktop (TDesktop) native "WEB" proxy mode uses an embedded
 *      WebView carrier that establishes an HTTPS/WSS link on port 443.
 *    - The carrier (primary: 'websocket') multiplexes MTProto streams inside
 *      binary frames: OPEN (0x01), DATA (0x02), CLOSE (0x03), WINDOW (0x04).
 *    - Each logical stream carries a 64-byte Obfuscated2 client header. The
 *      proxy decrypts the tail with the shared secret to obtain the protocol
 *      tag (0xefefefef abridged, 0xeeeeeeee intermediate, 0xdddddddd padded)
 *      and destination DC ID.
 *    - In Direct-DC mode (Telego fallback and this Worker): The proxy establishes
 *      a raw TCP socket directly to Telegram's DC frontends (e.g., DC2: 149.154.167.51:443)
 *      using cloudflare:sockets, generates a fresh DC Obfuscated2 header, and pipes
 *      encrypted MTProto payloads bi-directionally with flow control.
 *
 * 2. Middle-End (ME) Routing & Ad Tag (Sponsored Channel) Protocol:
 *    - Official MTProxy (TelegramMessenger/MTProxy) and Telego route traffic to
 *      Telegram's Middle-End (ME) servers (from https://core.telegram.org/getProxyConfig)
 *      to support sponsored channels (Ad Tags issued by @MTProxybot, 32 hex chars / 16 bytes).
 *    - In the ME protocol, client data is encapsulated inside RPC frames:
 *      RPC_PROXY_REQ (0x36cef1ee) with flags (bit 3: FLAG_HAS_AD_TAG = 0x8).
 *      When FLAG_HAS_AD_TAG is set, the 16-byte ad tag is appended to the RPC header.
 *    - Direct-DC servers (port 443) DO NOT accept RPC_PROXY_REQ or proxy tags;
 *      sponsored channels can ONLY be attached over an authenticated Middle-End session.
 *
 * 3. The Fatal Blocker: NAT & IP/Port Binding in Middle-End Handshake (Problem 5A):
 *    - When connecting to Telegram's ME servers (port 8888), both sides execute an
 *      RPC crypto handshake:
 *        Step 1: Exchange 32-byte RPC_NONCE packets (RPC_NONCE 0x7acb87aa, CRYPTO_AES 0x1,
 *                key_selector from proxy-secret, crypto_ts, and 16-byte client/server nonces).
 *        Step 2: Derive AES-256-CBC session keys using:
 *                s = nonce_srv + nonce_clt + clt_ts + srv_ip + clt_port + purpose +
 *                    clt_ip + srv_port + middleproxy_secret + nonce_srv + nonce_clt
 *                key = md5(s[1:])[:12] + sha1(s);  iv = md5(s[2:])
 *        Step 3: Client sends encrypted RPC_HANDSHAKE (0x7682eef5).
 *    - CRITICAL OBSERVATION:
 *      Telegram's ME server extracts clt_ip (4 bytes) and clt_port (2 bytes) from the
 *      INCOMING TCP SOCKET (as observed on Telegram's network interface).
 *    - Telego documentation (docs/middle-end.md) explicitly warns:
 *      "Private direct sockets require UDP access to STUN or a properly configured nat-ip,
 *       and any intermediate NAT for direct connections must preserve outgoing TCP ports."
 *    - In Cloudflare Workers:
 *      (a) Outbound TCP connections via cloudflare:sockets exit through Cloudflare's
 *          Anycast edge egress infrastructure under Carrier-Grade NAT / NAPT.
 *      (b) The egress IP is dynamically selected from Cloudflare's shared pool and
 *          the outbound TCP source port is dynamically translated by Cloudflare's NAT.
 *      (c) cloudflare:sockets exposes ONLY SocketInfo { remoteAddress, localAddress }.
 *          It DOES NOT expose localPort, nor does it allow port binding.
 *      (d) Workers cannot execute raw UDP sockets for STUN detection.
 *      Consequently, the Worker cannot know what outbound TCP port Telegram's server
 *      will observe. The derived keys mathematically mismatch, and Telegram's ME server
 *      immediately drops the connection on the first frame.
 *    - HONESTY CONCLUSION (Stop Condition):
 *      Native Middle-End handshake directly from a Cloudflare Worker is physically
 *      impossible without an external egress helper that preserves source IP and port.
 *      Attempting to fake this would break proxy connectivity. Direct-DC mode remains
 *      the only reliable, zero-cost transport on Cloudflare Workers.
 *
 * 4. Crypto Primitives & Workers Capabilities (Problem 5B):
 *    - Web Crypto in Workers (workerd) natively supports MD5 via crypto.subtle.digest("MD5", ...).
 *    - Web Crypto supports SHA-1, SHA-256, and AES-CTR (used for Obfuscated2).
 *    - Web Crypto AES-CBC strictly enforces PKCS#7 padding. While encryption can drop
 *      the trailing padding block for 16-byte aligned inputs, decryption of arbitrary
 *      unpadded network streams from Telegram throws OperationError.
 *
 * 5. Connection Model & Workers Limits (Problem 5C & 5E):
 *    - Connection Model: Session-scoped connections (Option 1). Each client WebSocket
 *      owns its DC TCP sockets. Avoids Durable Objects complexity, requires zero dashboard
 *      bindings, and runs 100% on the Free plan.
 *    - Free Plan Limits: 10ms CPU time per subrequest, 50 subrequests per invocation,
 *      128 MB RAM. WebSockets remain open while active but may be terminated when idle
 *      or during edge isolate recycling (TDesktop re-establishes session automatically).
 *
 * 6. UNVERIFIED Aspects:
 *    - [UNVERIFIED] Whether Cloudflare will in the future expose localPort on SocketInfo
 *      or provide dedicated egress IP/port reservation in Workers.
 *    - [UNVERIFIED] Whether Telegram will ever deploy a modified ME transport protocol
 *      (e.g., over WebSockets or TLS) that omits TCP source port binding from key derivation.
 * ============================================================================
 */

// Middle-End Protocol Constants (Documented for specification completeness)
const ME_CONSTANTS = {
  RPC_NONCE: 0x7acb87aa,        // Little-endian: 0xaa, 0x87, 0xcb, 0x7a
  RPC_HANDSHAKE: 0x7682eef5,    // Little-endian: 0xf5, 0xee, 0x82, 0x76
  RPC_FLAGS: 0x00000000,
  CRYPTO_AES: 0x00000001,
  RPC_PROXY_REQ: 0x36cef1ee,    // Little-endian: 0xee, 0xf1, 0xce, 0x36
  RPC_PROXY_ANS: 0x0dfb190e,    // Little-endian: 0x0e, 0x19, 0xfb, 0x0d
  FLAG_HAS_AD_TAG: 0x00000008,
  FLAG_EXTMODE2: 0x00020000,
  FLAG_PAD: 0x08000000,
  FLAG_INTERMEDIATE: 0x20000000,
  FLAG_ABRIDGED: 0x40000000,
  FLAG_QUICKACK: 0x80000000
};

// Default Configuration fallback (overridden by dashboard environment variables)
const CONFIG = {
  secretHex: "",                // Overridden by env.SECRET (32 hex or dd+32 hex)
  adTagHex: "",                 // Overridden by env.AD_TAG (32 hex)
  hostnames: ["*"],             // Overridden by env.HOSTNAME (comma-separated or '*')
  debug: false,                 // Overridden by env.DEBUG ("true" or "1")

  generatorEnabled: true,
  generatorKey: "",             // Optional custom seed for secret derivation
  acceptGenerated: false,

  dc: {
    1: ["149.154.175.50", "149.154.175.53", "149.154.175.54"],
    2: ["149.154.167.51", "149.154.167.50", "149.154.167.40", "149.154.167.41"],
    3: ["149.154.175.100", "149.154.175.101"],
    4: ["149.154.167.91", "149.154.167.92", "149.154.167.90"],
    5: ["91.108.56.156", "91.108.56.165", "91.108.56.170"],
    203: ["91.105.192.110"]
  },
  dcPort: 443,
  dcPorts: [443, 80, 5222],
  carrier: "websocket",
  batchBytes: 2097152,
  bootstrapTtl: 120,
  sessionTtl: 86400,
  maxStreams: 6,                // Safe default for Cloudflare Workers Free plan socket limits
  maxQueued: 16777216,
  streamWindow: 4194304,
  dataChunk: 65536
};

const te = new TextEncoder();
const TOKEN_DOMAIN = te.encode("tgweb-token-v1\0");
const TOKEN_KIND_BOOTSTRAP = 1;
const TOKEN_KIND_SESSION = 2;
const REQUEST_LIMIT = 16777216;

const PERMISSIONS_POLICY = "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()";

// Realistic, modern edge telemetry landing page for anti-censorship camouflage (resists GFW / DPI active probing)
const DECOY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EdgeNode Network &mdash; Realtime Observability</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #111827;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --primary: #3b82f6;
      --success: #10b981;
      --border: #1f2937;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding: 0 1.5rem;
    }
    header {
      max-width: 1040px;
      margin: 0 auto;
      padding: 2rem 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
    }
    .logo { font-size: 1.25rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      padding: 0.35rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success); }
    main { max-width: 1040px; margin: 3rem auto; }
    h1 { font-size: 2.25rem; font-weight: 800; margin-bottom: 1rem; line-height: 1.2; }
    p.lead { font-size: 1.15rem; color: var(--muted); margin-bottom: 2.5rem; max-width: 680px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-bottom: 3rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
    }
    .card h3 { font-size: 1.1rem; margin-bottom: 0.5rem; color: #fff; }
    .card p { font-size: 0.95rem; color: var(--muted); }
    .card .metric { font-size: 1.8rem; font-weight: 700; color: var(--primary); margin-top: 0.75rem; }
    footer {
      max-width: 1040px;
      margin: 4rem auto 2rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.85rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      EdgeNode Telemetry
    </div>
    <div class="status-badge"><span class="dot"></span> All Systems Operational</div>
  </header>
  <main>
    <h1>Global Edge Acceleration &amp; Telemetry</h1>
    <p class="lead">Real-time edge distribution gateway operating high-throughput Anycast proxy routing, automated health checking, and transport latency monitoring.</p>
    <div class="grid">
      <div class="card">
        <h3>Anycast Edge POPs</h3>
        <p>Active routing instances across global tier-1 network exchanges.</p>
        <div class="metric">310+ Nodes</div>
      </div>
      <div class="card">
        <h3>Average Edge Latency</h3>
        <p>Median connection turnaround for incoming transport streams.</p>
        <div class="metric">&lt; 24 ms</div>
      </div>
      <div class="card">
        <h3>Service Availability</h3>
        <p>Rolling 30-day verified operational uptime across distributed clusters.</p>
        <div class="metric">99.99%</div>
      </div>
    </div>
  </main>
  <footer>
    &copy; 2026 EdgeNode Systems &bull; Enterprise Edge Telemetry &bull; Automated Monitoring
  </footer>
</body>
</html>`;

const WELCOME = new Uint8Array([0x11, 0, 0, 0, 0, 0, 0, 0]);
const EMPTY = new Uint8Array(0);

const BRIDGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connection</title>
</head>
<body>
<script nonce="__NONCE__">
(()=>{
'use strict';
const relayBase=__RELAY_BASE__,bootstrap=__BOOTSTRAP__,carrierMode=__CARRIER_MODE__;
const fragment=location.hash,androidNonce=/^#android=([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1]||'';
history.replaceState(null,'',location.pathname);
let initialized=false,closed=false,port=null,sessionToken='',createStarted=false;
let queuedBytes=0,queuedItems=0,pollController=null,webSocket=null,webSocketTimer=0;
const pending=[],upPending=[],lanes=new Map(),closedLanes=new Set(),closedLaneOrder=[];
const queueLimit=33554432,queueItemLimit=16384,closedLaneLimit=4096;
const laneQueueLimit=8388608,laneItemLimit=1024,batchLimit=__BATCH_LIMIT__;
let upSequence=1,downCursor='0',upRunning=false;
const status=state=>{if(port&&!closed)port.postMessage({t:'status',state})};
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const options=(method,token,body,headers,signal,keepalive)=>({
 method,body,signal,keepalive:!!keepalive,mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
 headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/octet-stream'}:{},headers||{})
});
const bufferedBytes=()=>{
 let total=webSocket&&webSocket.readyState===WebSocket.OPEN?webSocket.bufferedAmount:0;
 if(carrierMode==='websocket-lanes')for(const lane of lanes.values())if(lane.socket&&lane.socket.readyState===WebSocket.OPEN)total+=lane.socket.bufferedAmount;
 return total;
};
function reserve(data,lane){
 if(!data.byteLength||queuedBytes+bufferedBytes()>queueLimit-data.byteLength||queuedItems>=queueItemLimit)return false;
 if(lane&&(lane.bytes>laneQueueLimit-data.byteLength||lane.items>=laneItemLimit))return false;
 queuedBytes+=data.byteLength;queuedItems++;
 if(lane){lane.bytes+=data.byteLength;lane.items++}
 return true;
}
function release(bytes,items,lane){
 queuedBytes-=bytes;queuedItems-=items;
 if(lane){lane.bytes-=bytes;lane.items-=items}
}
function splitFrames(value){
 const view=new DataView(value),result=[];let offset=0;
 while(offset<value.byteLength){
  if(value.byteLength-offset<8||result.length>=4096)throw new Error('invalid frame batch');
  const type=view.getUint8(offset),id=(view.getUint8(offset+1)<<16)|(view.getUint8(offset+2)<<8)|view.getUint8(offset+3);
  const size=view.getUint32(offset+4),end=offset+8+size;
  if((type===2&&!size)||size>1048576||end>value.byteLength)throw new Error('invalid frame');
  result.push({type,id,data:offset===0&&end===value.byteLength?value:value.slice(offset,end)});offset=end;
 }
 if(!result.length)throw new Error('empty frame batch');
 return result;
}
function frameBound(value,maxFrames,maxBytes){
 const view=new DataView(value);let offset=0,frames=0;
 while(offset<value.byteLength){
  if(value.byteLength-offset<8)throw new Error('invalid frame batch');
  const size=view.getUint32(offset+4),end=offset+8+size;
  if(end>value.byteLength)throw new Error('invalid frame');
  if(frames>0&&(frames>=maxFrames||end>maxBytes))break;
  frames++;offset=end;
 }
 return {frames,bytes:offset};
}
function joinPending(values,lane){
 let total=0,count=0,frames=0;
 while(count<values.length){
  const bound=frameBound(values[count],4096,batchLimit);
  const whole=bound.bytes===values[count].byteLength;
  if(count===0&&!whole){
   const head=new Uint8Array(values[0],0,bound.bytes).slice();
   values[0]=values[0].slice(bound.bytes);
   queuedItems++;if(lane)lane.items++;
   return {body:head.buffer,total:bound.bytes,count:1};
  }
  if(count!==0&&(total+values[count].byteLength>batchLimit||frames+bound.frames>4096))break;
  total+=values[count].byteLength;frames+=bound.frames;count++;
 }
 const joined=new Uint8Array(total);let offset=0;
 for(const data of values.splice(0,count)){joined.set(new Uint8Array(data),offset);offset+=data.byteLength}
 return {body:joined.buffer,total,count};
}
function retryAfterMs(response){
 const header=response.headers.get('Retry-After');
 if(!header)return 0;
 const seconds=Number(header);
 if(Number.isFinite(seconds)&&seconds>=0)return Math.min(seconds*1000,30000);
 const when=Date.parse(header);
 if(Number.isFinite(when)){const delta=when-Date.now();return delta>0?Math.min(delta,30000):0}
 return 0;
}
async function request(path,makeOptions){
 let delay=250,attempt=0;const deadline=Date.now()+90000;
 while(true){
  const requestOptions=makeOptions(),controller=new AbortController();
  const external=requestOptions.signal,abort=()=>controller.abort();
  if(external)external.addEventListener('abort',abort,{once:true});
  requestOptions.signal=controller.signal;
  const timer=setTimeout(abort,90000);
  let wait=0,serviceUnavailable=false;
  try{
   const response=await fetch(relayBase+path,requestOptions);
   if(response.status!==503)return response;
   serviceUnavailable=true;wait=retryAfterMs(response);
   await response.arrayBuffer();
  }catch(error){if(closed||(external&&external.aborted))throw error;attempt++;if(attempt===9)throw new Error('carrier retry limit reached')}
  finally{clearTimeout(timer);if(external)external.removeEventListener('abort',abort)}
  if(serviceUnavailable&&Date.now()>=deadline)throw new Error('carrier retry limit reached');
  status('reconnecting');
  const backoff=wait||(delay+Math.floor(Math.random()*Math.max(1,delay/4)));
  await pause(backoff);
  if(!serviceUnavailable)delay=Math.min(delay*2,5000);
 }
}
function fail(){
 if(closed)return;
 status('failed');
 if(port)port.postMessage({t:'close'});
 close(true);
}
async function createSession(first){
 try{
  status('connecting');
  const response=await request('api/v1/session',()=>options('POST',bootstrap,first));
  if(response.status!==200||response.headers.get('X-Carrier-Mode')!==carrierMode)throw new Error('session creation rejected');
  sessionToken=response.headers.get('X-Session-Token')||'';
  downCursor=response.headers.get('X-Down-Cursor')||'0';
  if(!sessionToken)throw new Error('missing session token');
  if(closed){fetch(relayBase+'api/v1/session',options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});return}
  const welcome=await response.arrayBuffer();
  if(carrierMode==='websocket')await openWebSocket();
  if(closed){fetch(relayBase+'api/v1/session',options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});return}
  port.postMessage(welcome,[welcome]);
  status('connected');
  for(const data of pending.splice(0)){release(data.byteLength,1,null);queueCarrier(data)}
  if(carrierMode==='https')poll();
  else if(carrierMode==='https-lanes')pollLane(ensureLane(0));
 }catch(error){fail()}
}
function queueCarrier(data){
 try{
  if(carrierMode==='https')queueUp(data);
  else if(carrierMode==='https-lanes')for(const value of splitFrames(data))queueLane(value);
  else if(carrierMode==='websocket')queueWebSocket(data);
  else for(const value of splitFrames(data))queueWebSocketLane(value);
 }catch(error){fail()}
}
function queueUp(data){
 if(!reserve(data,null)){fail();return}
 upPending.push(data);runUp();
}
async function runUp(){
 if(upRunning)return;
 upRunning=true;
 try{
  while(!closed&&sessionToken&&upPending.length){
   const batch=joinPending(upPending,null),sequence=String(upSequence);
   const response=await request('api/v1/up',()=>options('POST',sessionToken,batch.body,{'X-Up-Seq':sequence}));
   if(response.status!==204||response.headers.get('X-Up-Ack')!==sequence)throw new Error('uplink rejected');
   release(batch.total,batch.count,null);port.postMessage({t:'traffic',up:batch.total,down:0});upSequence++;
  }
 }catch(error){fail()}
 finally{upRunning=false;if(!closed&&sessionToken&&upPending.length)runUp()}
}
async function poll(){
 while(!closed&&sessionToken){
  try{
   pollController=new AbortController();
   const response=await request('api/v1/down',()=>options('POST',sessionToken,null,{'X-Down-Cursor':downCursor},pollController.signal));
   if(response.status===204){status('connected');continue}
   if(response.status!==200)throw new Error('downlink rejected');
   const next=response.headers.get('X-Down-Cursor')||'',data=await response.arrayBuffer();
   if(!next||!data.byteLength)throw new Error('invalid downlink response');
   if(closed)return;
   port.postMessage({t:'traffic',up:0,down:data.byteLength});port.postMessage(data,[data]);downCursor=next;status('connected');
  }catch(error){if(!closed)fail();return}
 }
}
function ensureLane(id){
 let lane=lanes.get(id);
 if(!lane){lane={id,sequence:1,cursor:'0',pending:[],bytes:0,items:0,running:false,polling:false,socket:null,timer:0,opened:false,localClosed:false,remoteClosed:false,finished:false};lanes.set(id,lane)}
 return lane;
}
function rememberLaneClosed(id){
 if(!id||closedLanes.has(id))return;
 if(closedLaneOrder.length===closedLaneLimit)closedLanes.delete(closedLaneOrder.shift());
 closedLanes.add(id);closedLaneOrder.push(id);
}
function queueLane(value){
 let lane=lanes.get(value.id);
 if(!lane&&(value.type===2||value.type===3||value.type===4))return;
 if(!lane&&closedLanes.has(value.id))throw new Error('closed lane was reused');
 if(!lane&&value.type!==1)throw new Error('lane did not begin with OPEN');
 lane=lane||ensureLane(value.id);
 if(!reserve(value.data,lane)){fail();return}
 lane.pending.push(value.data);runLaneUp(lane);
}
async function runLaneUp(lane){
 if(lane.running)return;
 lane.running=true;
 try{
  while(!closed&&sessionToken&&lane.pending.length){
   const batch=joinPending(lane.pending,lane),sequence=String(lane.sequence),laneID=String(lane.id);
   const response=await request('api/v1/up',()=>options('POST',sessionToken,batch.body,{'X-Up-Seq':sequence,'X-Lane-ID':laneID}));
   if(response.status!==204||response.headers.get('X-Up-Ack')!==sequence)throw new Error('lane uplink rejected');
   release(batch.total,batch.count,lane);port.postMessage({t:'traffic',up:batch.total,down:0});lane.sequence++;
   if(!lane.polling)pollLane(lane);
  }
 }catch(error){fail()}
 finally{lane.running=false;if(!closed&&sessionToken&&lane.pending.length)runLaneUp(lane)}
}
async function pollLane(lane){
 if(lane.polling)return;
 lane.polling=true;
 try{
  while(!closed&&sessionToken&&lanes.get(lane.id)===lane){
   const controller=new AbortController(),laneID=String(lane.id);
   lane.controller=controller;
   const response=await request('api/v1/down',()=>options('POST',sessionToken,null,{'X-Down-Cursor':lane.cursor,'X-Lane-ID':laneID},controller.signal));
   if(response.status===204){
    if(response.headers.get('X-Lane-Closed')==='1'){lanes.delete(lane.id);rememberLaneClosed(lane.id);return}
    status('connected');continue;
   }
   if(response.status!==200)throw new Error('lane downlink rejected');
   const next=response.headers.get('X-Down-Cursor')||'',data=await response.arrayBuffer();
   if(!next||!data.byteLength)throw new Error('invalid lane downlink response');
   for(const value of splitFrames(data))if(value.id!==lane.id)throw new Error('cross-lane frame');
   if(closed)return;
   port.postMessage({t:'traffic',up:0,down:data.byteLength});port.postMessage(data,[data]);lane.cursor=next;status('connected');
  }
 }catch(error){if(!closed)fail()}
 finally{lane.polling=false;lane.controller=null}
}
function openWebSocket(){
 return new Promise((resolve,reject)=>{
  const target=relayBase.replace(/^https:/,'wss:')+'api/v1/ws',socket=new WebSocket(target,'tproxy-v1.'+sessionToken);
  webSocket=socket;socket.binaryType='arraybuffer';
  socket.onopen=()=>resolve();
  socket.onmessage=event=>{
   if(!(event.data instanceof ArrayBuffer)||!event.data.byteLength){fail();return}
   port.postMessage({t:'traffic',up:0,down:event.data.byteLength});port.postMessage(event.data,[event.data]);status('connected');
  };
  socket.onerror=()=>reject(new Error('websocket failed'));
  socket.onclose=()=>{
   if(closed)return;
   status('reconnecting');
   setTimeout(()=>{
    if(!closed)openWebSocket().then(()=>{status('connected');runWebSocketUp();}).catch(()=>fail());
   },1500);
  };
 });
}
function queueWebSocket(data){
 if(!reserve(data,null)){fail();return}
 upPending.push(data);runWebSocketUp();
}
function runWebSocketUp(){
 if(closed||!webSocket||webSocket.readyState!==WebSocket.OPEN||!upPending.length)return;
 if(webSocket.bufferedAmount+queuedBytes>queueLimit||webSocket.bufferedAmount>=batchLimit){
  if(!webSocketTimer)webSocketTimer=setTimeout(()=>{webSocketTimer=0;runWebSocketUp()},10);
  return;
 }
 try{
  const batch=joinPending(upPending,null);webSocket.send(batch.body);release(batch.total,batch.count,null);
  port.postMessage({t:'traffic',up:batch.total,down:0});
  if(upPending.length)queueMicrotask(runWebSocketUp);
 }catch(error){fail()}
}
function closeFrame(id){
 const data=new ArrayBuffer(8),view=new DataView(data);
 view.setUint8(0,3);view.setUint8(1,id>>>16);view.setUint8(2,id>>>8);view.setUint8(3,id);view.setUint32(4,0);
 return data;
}
function finishWebSocketLane(lane,notify){
 if(lane.finished||lanes.get(lane.id)!==lane)return;
 lane.finished=true;if(lane.timer)clearTimeout(lane.timer);
 if(lane.bytes||lane.items)release(lane.bytes,lane.items,lane);
 lane.pending.length=0;lanes.delete(lane.id);rememberLaneClosed(lane.id);
 if(lane.socket&&(lane.socket.readyState===WebSocket.OPEN||lane.socket.readyState===WebSocket.CONNECTING))try{lane.socket.close()}catch(error){}
 if(notify&&port&&!closed){const frame=closeFrame(lane.id);port.postMessage(frame,[frame])}
}
function openWebSocketLane(lane){
 const target=relayBase.replace(/^https:/,'wss:')+'api/v1/ws';
 const socket=new WebSocket(target,'tproxy-lane-v1.'+sessionToken+'.'+lane.id);
 lane.socket=socket;socket.binaryType='arraybuffer';
 socket.onopen=()=>{if(closed||lane.finished){socket.close();return}lane.opened=true;status('connected');runWebSocketLaneUp(lane)};
 socket.onmessage=event=>{
  if(!(event.data instanceof ArrayBuffer)||!event.data.byteLength){fail();return}
  let values;try{values=splitFrames(event.data)}catch(error){fail();return}
  if(values.some(value=>value.id!==lane.id)){fail();return}
  if(values.some(value=>value.type===3))lane.remoteClosed=true;
  port.postMessage({t:'traffic',up:0,down:event.data.byteLength});port.postMessage(event.data,[event.data]);status('connected');
 };
 socket.onerror=()=>{};
 socket.onclose=()=>{
  if(closed||lane.finished)return;
  if(!lane.opened){fail();return}
  finishWebSocketLane(lane,!lane.localClosed&&!lane.remoteClosed);
 };
}
function queueWebSocketLane(value){
 let lane=lanes.get(value.id);
 if(!lane&&(value.type===2||value.type===3||value.type===4))return;
 if(!value.id||(!lane&&closedLanes.has(value.id)))throw new Error('closed lane was reused');
 if(!lane&&value.type!==1)throw new Error('lane did not begin with OPEN');
 lane=lane||ensureLane(value.id);
 if(value.type===3&&!lane.opened){finishWebSocketLane(lane,false);return}
 if(!reserve(value.data,lane)){fail();return}
 lane.pending.push(value.data);if(value.type===3)lane.localClosed=true;
 if(!lane.socket)openWebSocketLane(lane);else runWebSocketLaneUp(lane);
}
function runWebSocketLaneUp(lane){
 const socket=lane.socket;
 if(closed||lane.finished||!socket||socket.readyState!==WebSocket.OPEN||!lane.pending.length)return;
 if(socket.bufferedAmount>=batchLimit){
  if(!lane.timer)lane.timer=setTimeout(()=>{lane.timer=0;runWebSocketLaneUp(lane)},10);
  return;
 }
 try{
  const batch=joinPending(lane.pending,lane);socket.send(batch.body);release(batch.total,batch.count,lane);
  port.postMessage({t:'traffic',up:batch.total,down:0});
  if(lane.pending.length)queueMicrotask(()=>runWebSocketLaneUp(lane));
 }catch(error){fail()}
}
function close(notifyServer){
 if(closed)return;
 closed=true;
 if(pollController)pollController.abort();
 for(const lane of lanes.values()){
  if(lane.controller)lane.controller.abort();
  if(lane.timer)clearTimeout(lane.timer);
  if(lane.socket)try{lane.socket.close()}catch(error){}
 }
 if(webSocketTimer)clearTimeout(webSocketTimer);
 if(webSocket)webSocket.close();
 if(notifyServer&&sessionToken)fetch(relayBase+'api/v1/session',options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});
 if(port)port.close();
}
function activatePort(nextPort){
 initialized=true;port=nextPort;
 port.onmessage=message=>{
  if(message.data instanceof ArrayBuffer){
   if(!createStarted){createStarted=true;createSession(message.data)}
   else if(!sessionToken){if(!reserve(message.data,null)){fail();return}pending.push(message.data)}
   else queueCarrier(message.data);
  }else if(message.data&&message.data.t==='close')close(true);
 };
 port.start();status('connecting');
}
addEventListener('message',event=>{
 if(initialized||event.source!==parent||event.data===null||typeof event.data!=='object')return;
 const keys=Object.keys(event.data).sort();
 if(keys.length!==2||keys[0]!=='t'||keys[1]!=='v'||event.data.t!=='tproxy-init'||event.data.v!==1||event.ports.length!==1)return;
 let source;try{source=new URL(event.origin)}catch(error){return}
 if(source.protocol!=='http:'||source.hostname!=='127.0.0.1'||!source.port||source.origin!==event.origin)return;
 activatePort(event.ports[0]);
},{once:false});
const androidBridge=globalThis.TelegramWebProxy;
if(!initialized&&androidNonce&&androidBridge&&typeof androidBridge.postMessage==='function'){
 const androidPort={onmessage:null,start(){},close(){androidBridge.onmessage=null},postMessage(value){
  if(value instanceof ArrayBuffer){
   let frames;try{frames=splitFrames(value)}catch(error){fail();return}
   for(const frame of frames)androidBridge.postMessage(frame.data);
  }else androidBridge.postMessage(JSON.stringify(value));
 }};
 androidBridge.onmessage=event=>{
  let data=event.data;if(typeof data==='string'){try{data=JSON.parse(data)}catch(error){return}}
  if(androidPort.onmessage)androidPort.onmessage({data});
 };
 activatePort(androidPort);androidBridge.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce:androidNonce}));
}
addEventListener('pagehide',()=>close(true),{once:true});
})();
</script>
</body>
</html>
`;

function concat(...parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function reverse(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += bytes[i].toString(16).padStart(2, "0");
  return text;
}

function b64uEncode(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecodeStrict(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - remainder) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return b64uEncode(out) === value ? out : null;
  } catch (_) {
    return null;
  }
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function importHmac(raw, usages) {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function importAes(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt"]);
}

function add128(iv, amount) {
  const out = new Uint8Array(iv);
  let carry = amount >>> 0;
  for (let i = 15; i >= 0 && carry !== 0; i--) {
    const sum = out[i] + (carry & 0xff);
    out[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
  return out;
}

async function ctrAt(key, iv, position, data) {
  const block = Math.floor(position / 16);
  const skip = position % 16;
  const counter = add128(iv, block);
  if (skip === 0) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, data));
  }
  const input = new Uint8Array(skip + data.length);
  input.set(data, skip);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, input));
  return out.subarray(skip);
}

function parseSecret(hexValue) {
  if (!hexValue) return null;
  let hex = String(hexValue).trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.substring(2);
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 32) return hexToBytes(hex);
  if (hex.length === 34 && hex.startsWith("dd")) return hexToBytes(hex.substring(2));
  return null;
}

function parseAdTag(hexValue) {
  const hex = String(hexValue || "").trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) return hexToBytes(hex);
  return null;
}

function resolveConfig(env) {
  const secretHex = (typeof env?.SECRET === "string" ? env.SECRET : CONFIG.secretHex || "").trim();
  const adTagHex = (typeof env?.AD_TAG === "string" ? env.AD_TAG : CONFIG.adTagHex || "").trim();
  const debug = env?.DEBUG === "true" || env?.DEBUG === "1" || CONFIG.debug === true;
  const decoyUrl = (typeof env?.DECOY_URL === "string" ? env.DECOY_URL : "").trim();

  let hostnames = [];
  if (typeof env?.HOSTNAME === "string" && env.HOSTNAME.trim()) {
    hostnames = env.HOSTNAME.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(CONFIG.hostnames)) {
    hostnames = CONFIG.hostnames.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }

  const maxStreams = env?.MAX_STREAMS && !isNaN(parseInt(env.MAX_STREAMS, 10))
    ? Math.min(32, Math.max(1, parseInt(env.MAX_STREAMS, 10)))
    : CONFIG.maxStreams;

  return {
    secretHex,
    adTagHex,
    debug,
    hostnames,
    decoyUrl,
    maxStreams,
    generatorEnabled: env?.GENERATOR_ENABLED !== undefined ? (env.GENERATOR_ENABLED === "true" || env.GENERATOR_ENABLED === "1") : CONFIG.generatorEnabled,
    generatorKey: (typeof env?.GENERATOR_KEY === "string" ? env.GENERATOR_KEY : CONFIG.generatorKey || "").trim(),
    acceptGenerated: env?.ACCEPT_GENERATED !== undefined ? (env.ACCEPT_GENERATED === "true" || env.ACCEPT_GENERATED === "1") : CONFIG.acceptGenerated,
    dc: CONFIG.dc,
    dcPort: CONFIG.dcPort,
    dcPorts: CONFIG.dcPorts,
    carrier: CONFIG.carrier,
    batchBytes: CONFIG.batchBytes,
    bootstrapTtl: CONFIG.bootstrapTtl,
    sessionTtl: CONFIG.sessionTtl,
    maxQueued: CONFIG.maxQueued,
    streamWindow: CONFIG.streamWindow,
    dataChunk: CONFIG.dataChunk
  };
}

let cachedRuntime = null;
let cachedKey = null;

async function getRuntime(env) {
  const resolved = resolveConfig(env);
  const cacheKey = `${resolved.secretHex}:${resolved.generatorKey}:${resolved.hostnames.join(",")}:${resolved.adTagHex}:${resolved.decoyUrl}:${resolved.maxStreams}:${resolved.debug}`;
  if (cachedRuntime && cachedKey === cacheKey) {
    return cachedRuntime;
  }
  const runtime = await buildRuntime(resolved);
  if (runtime) {
    cachedRuntime = runtime;
    cachedKey = cacheKey;
  }
  return runtime;
}

async function buildRuntime(cfg) {
  const base = parseSecret(cfg.secretHex);
  const generatorText = String(cfg.generatorKey || "").trim();
  if (!base && !generatorText) return null;

  const fallback = base || new Uint8Array(await sha256(concat(te.encode("tgweb-fallback-v1\0"), te.encode(generatorText))));
  const generatorRaw = generatorText
    ? new Uint8Array(await sha256(concat(te.encode("tgweb-generator-v1\0"), te.encode(generatorText))))
    : base;

  const bridgeKeys = [];
  if (base) {
    bridgeKeys.push(await importHmac(base, ["verify"]));
    bridgeKeys.push(await importHmac(concat(Uint8Array.of(0xdd), base), ["verify"]));
  }

  const tokenKey = await importHmac(
    await sha256(concat(te.encode("tgweb-token-key-v1\0"), fallback)),
    ["sign", "verify"]
  );

  const hosts = Array.isArray(cfg.hostnames)
    ? cfg.hostnames.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];

  const adTag = parseAdTag(cfg.adTagHex);

  return {
    base,
    bridgeKeys,
    generatorHmac: generatorRaw ? await importHmac(generatorRaw, ["sign", "verify"]) : null,
    tokenKey,
    hosts,
    dc: cfg.dc,
    dcPort: cfg.dcPort,
    dcPorts: cfg.dcPorts,
    adTag,
    adTagHex: cfg.adTagHex,
    debug: cfg.debug,
    decoyUrl: cfg.decoyUrl,
    acceptGenerated: cfg.acceptGenerated,
    generatorEnabled: cfg.generatorEnabled,
    streamWindow: cfg.streamWindow,
    maxQueued: cfg.maxQueued,
    maxStreams: cfg.maxStreams,
    dataChunk: cfg.dataChunk,
    bootstrapTtl: cfg.bootstrapTtl,
    sessionTtl: cfg.sessionTtl,
    carrier: cfg.carrier,
    batchBytes: cfg.batchBytes
  };
}

function requestHost(request, url) {
  let host = String(request.headers.get("host") || url.host || "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[")) return host;
  const colon = host.lastIndexOf(":");
  if (colon > 0 && host.indexOf(":") === colon) host = host.slice(0, colon);
  return host;
}

function hostAllowed(cfg, host) {
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return false;
  if (cfg.hosts.length === 0 || cfg.hosts.includes("*") || (cfg.hosts.length === 1 && cfg.hosts[0] === "proxy.example.com")) {
    return true;
  }
  return cfg.hosts.includes(host);
}

async function deriveSecret(cfg, label) {
  if (!cfg.generatorHmac) return null;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cfg.generatorHmac, te.encode("tgweb-secret-v1\n" + label)));
  return mac.subarray(0, 16);
}

async function bridgeMode(cfg, host, capability) {
  const provided = b64uDecodeStrict(capability);
  if (!provided || provided.length !== 32) return -1;
  const context = te.encode("tdesktop-web-proxy-bridge-v1\n" + host);
  for (const key of cfg.bridgeKeys) {
    if (await crypto.subtle.verify("HMAC", key, provided, context)) return 0;
  }
  if (cfg.acceptGenerated) {
    const secret = await deriveSecret(cfg, host);
    if (secret) {
      const key = await importHmac(secret, ["verify"]);
      if (await crypto.subtle.verify("HMAC", key, provided, context)) return 1;
    }
  }
  return -1;
}

function generatorLabel(url) {
  for (const key of ["--create-secret", "create-secret", "create_secret"]) {
    if (url.searchParams.has(key)) return url.searchParams.get(key) || "";
  }
  return null;
}

async function serveSecret(cfg, host, label) {
  const clean = String(label || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128) || host;

  let hex = "";
  let isExisting = false;

  if (cfg && cfg.base) {
    if (cfg.acceptGenerated && cfg.generatorHmac) {
      const derived = await deriveSecret(cfg, clean);
      if (derived) hex = bytesToHex(derived);
    }
    if (!hex) {
      hex = bytesToHex(cfg.base);
      isExisting = true;
    }
  } else {
    // Fresh deployment without configured SECRET in env: generate strong random secret
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    hex = bytesToHex(randomBytes);
  }

  const link = "tg://webproxy?server=" + encodeURIComponent(host) + "&secret=" + hex;
  const body = [
    "=== ProxyGosha Secret Generator ===",
    isExisting ? "[Status: ACTIVE CONFIGURATION]" : "[Status: NEW SECRET GENERATED]",
    "",
    "Server:  " + host,
    "Secret:  " + hex,
    "Link:    " + link,
    "",
    isExisting
      ? "Your proxy is running with this secret. Use the link above in Telegram to connect."
      : "Next Steps to Activate:\n1. Copy the 32-character secret above.\n2. In Cloudflare Dashboard -> Workers & Pages -> your worker -> Settings -> Variables and Secrets.\n3. Add Environment Variable: SECRET with the value above and click Deploy.\n4. Connect in Telegram using the link above!"
  ].join("\n") + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex"
    }
  });
}

async function issueToken(cfg, kind, ttl, mode) {
  const nonce = new Uint8Array(16);
  new DataView(nonce.buffer).setUint32(0, Math.floor(Date.now() / 1000) + ttl, false);
  nonce[4] = mode === 1 ? 1 : 0;
  crypto.getRandomValues(nonce.subarray(5));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cfg.tokenKey, concat(TOKEN_DOMAIN, Uint8Array.of(kind), nonce)));
  return b64uEncode(concat(nonce, mac));
}

async function verifyToken(cfg, token, kind) {
  const raw = b64uDecodeStrict(token);
  if (!raw || raw.length !== 48) return null;
  const nonce = raw.subarray(0, 16);
  const mac = raw.subarray(16);
  const ok = await crypto.subtle.verify("HMAC", cfg.tokenKey, mac, concat(TOKEN_DOMAIN, Uint8Array.of(kind), nonce));
  if (!ok) return null;
  const expires = new DataView(nonce.buffer, nonce.byteOffset, 4).getUint32(0, false);
  if (expires < Math.floor(Date.now() / 1000)) return null;
  return { nonce, mode: nonce[4] === 1 ? 1 : 0 };
}

async function decoy(decoyUrl) {
  if (decoyUrl && typeof decoyUrl === "string" && (decoyUrl.startsWith("http://") || decoyUrl.startsWith("https://"))) {
    try {
      const upstream = await fetch(decoyUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") || "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600"
        }
      });
    } catch (_) {}
  }
  return new Response(DECOY_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function notFound() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function serveBridge(cfg, host, mode) {
  const nonce = b64uEncode(crypto.getRandomValues(new Uint8Array(18)));
  const bootstrap = await issueToken(cfg, TOKEN_KIND_BOOTSTRAP, cfg.bootstrapTtl, mode);
  const relayBase = JSON.stringify("https://" + host + "/");
  const body = BRIDGE_HTML
    .replaceAll("__NONCE__", nonce)
    .replaceAll("__RELAY_BASE__", relayBase)
    .replaceAll("__BOOTSTRAP__", JSON.stringify(bootstrap))
    .replaceAll("__CARRIER_MODE__", JSON.stringify(cfg.carrier))
    .replaceAll("__BATCH_LIMIT__", String(cfg.batchBytes));
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    "connect-src 'self' wss://" + host,
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors http://127.0.0.1:*",
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'none'",
    "worker-src 'none'",
    "sandbox allow-same-origin allow-scripts"
  ].join("; ");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "Permissions-Policy": PERMISSIONS_POLICY
    }
  });
}

function frame(type, id, payload) {
  const out = new Uint8Array(8 + payload.length);
  out[0] = type;
  out[1] = (id >>> 16) & 0xff;
  out[2] = (id >>> 8) & 0xff;
  out[3] = id & 0xff;
  new DataView(out.buffer).setUint32(4, payload.length, false);
  out.set(payload, 8);
  return out;
}

function windowFrame(id, amount) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, amount, false);
  return frame(0x04, id, payload);
}

function tagKind(tag) {
  if (tag[0] === 0xef && tag[1] === 0xef && tag[2] === 0xef && tag[3] === 0xef) return 1; // abridged
  if (tag[0] === 0xee && tag[1] === 0xee && tag[2] === 0xee && tag[3] === 0xee) return 2; // intermediate
  if (tag[0] === 0xdd && tag[1] === 0xdd && tag[2] === 0xdd && tag[3] === 0xdd) return 3; // padded intermediate
  return 0;
}

function safeDcHeaderPrefix(bytes) {
  if (bytes[0] === 0xef) return false;
  if (bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0) return false;
  if (bytes[0] === 0x47 && bytes[1] === 0x45 && bytes[2] === 0x54 && bytes[3] === 0x20) return false;
  if (bytes[0] === 0x50 && bytes[1] === 0x4f && bytes[2] === 0x53 && bytes[3] === 0x54) return false;
  if (bytes[0] === 0x48 && bytes[1] === 0x45 && bytes[2] === 0x41 && bytes[3] === 0x44) return false;
  if (bytes[0] === 0x4f && bytes[1] === 0x50 && bytes[2] === 0x54 && bytes[3] === 0x49) return false;
  if (bytes[0] === 0xee && bytes[1] === 0xee && bytes[2] === 0xee && bytes[3] === 0xee) return false;
  if (bytes[0] === 0xdd && bytes[1] === 0xdd && bytes[2] === 0xdd && bytes[3] === 0xdd) return false;
  if (bytes[0] === 0x16 && bytes[1] === 0x03 && bytes[2] === 0x01 && bytes[3] === 0x02) return false;
  return true;
}

class Stream {
  constructor(session, id) {
    this.session = session;
    this.id = id;
    this.phase = "header";
    this.header = new Uint8Array(64);
    this.headerLength = 0;
    this.dead = false;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.inQueue = [];
    this.inRunning = false;
    this.queuedLocal = 0;
    this.recvOutstanding = 0;
    this.sendCredit = session.cfg.streamWindow;
    this.creditResolve = null;
    this.clientReadKey = null;
    this.clientReadIv = null;
    this.clientWriteKey = null;
    this.clientWriteIv = null;
    this.dcWriteKey = null;
    this.dcWriteIv = null;
    this.dcReadKey = null;
    this.dcReadIv = null;
    this.clientReadPos = 64;
    this.clientWritePos = 0;
    this.dcWritePos = 64;
    this.dcReadPos = 0;
  }

  feed(payload) {
    if (this.dead || !payload.length) return;
    this.recvOutstanding += payload.length;
    if (this.recvOutstanding > this.session.cfg.streamWindow + 65536) {
      this.kill(true);
      return;
    }
    const copy = payload.slice();
    this.inQueue.push(copy);
    this.queuedLocal += copy.length;
    this.session.queued += copy.length;
    if (this.session.queued > this.session.cfg.maxQueued) {
      this.kill(true);
      return;
    }
    this.runIn();
  }

  async runIn() {
    if (this.inRunning || this.dead) return;
    this.inRunning = true;
    try {
      while (!this.dead && this.inQueue.length) {
        let payload = this.inQueue[0];
        if (this.phase === "header") {
          const need = 64 - this.headerLength;
          const take = Math.min(need, payload.length);
          this.header.set(payload.subarray(0, take), this.headerLength);
          this.headerLength += take;
          payload = payload.subarray(take);
          this.queuedLocal -= take;
          this.session.queued -= take;
          if (payload.length) this.inQueue[0] = payload;
          else this.inQueue.shift();
          if (this.headerLength === 64) {
            await this.init();
            this.grant(64);
          }
          continue;
        }
        this.inQueue.shift();
        this.queuedLocal -= payload.length;
        this.session.queued -= payload.length;
        await this.writeToDc(payload);
      }
    } catch (_) {
      this.kill(true);
    } finally {
      this.inRunning = false;
      if (!this.dead && this.inQueue.length) this.runIn();
    }
  }

  async init() {
    const header = this.header;
    const readKey = await sha256(concat(header.subarray(8, 40), this.session.secret));
    const readIv = header.slice(40, 56);
    this.clientReadKey = await importAes(readKey);
    this.clientReadIv = readIv;
    const tail = await ctrAt(this.clientReadKey, readIv, 56, header.subarray(56, 64));
    const tag = tail.subarray(0, 4);
    if (!tagKind(tag)) throw new Error("bad tag");
    const dcId = new DataView(tail.buffer, tail.byteOffset + 4, 2).getInt16(0, true);
    const dcKey = Math.abs(dcId);
    const address = this.session.cfg.dc[dcKey];
    if (!address) throw new Error("bad dc");

    const candidateIps = Array.isArray(address) ? address : [address];
    const candidatePorts = Array.isArray(this.session.cfg.dcPorts) ? this.session.cfg.dcPorts : [this.session.cfg.dcPort || 443];

    // Middle-End / Ad Tag Routing Check:
    // If AD_TAG is configured, note protocol constraint: native ME handshake requires
    // preserving outbound TCP source port which Cloudflare Workers' NAPT does not support.
    if (this.session.cfg.adTag && this.session.cfg.debug && !this.session.loggedMeNotice) {
      this.session.loggedMeNotice = true;
      console.log("[tgweb] AD_TAG configured. Native Middle-End handshake from Cloudflare Workers is blocked by Cloudflare egress NAPT (source port translation prevents ME key agreement). Falling back cleanly to Direct-DC mode.");
    }

    const reversed = reverse(header.subarray(8, 56));
    const writeKey = await sha256(concat(reversed.subarray(0, 32), this.session.secret));
    this.clientWriteKey = await importAes(writeKey);
    this.clientWriteIv = reversed.slice(32, 48);
    this.dcWriteKey = await importAes(header.slice(8, 40));
    this.dcWriteIv = header.slice(40, 56);
    this.dcReadKey = await importAes(reversed.slice(0, 32));
    this.dcReadIv = reversed.slice(32, 48);
    if (this.dead) return;
    this.clientReadPos = 64;
    this.clientWritePos = 0;
    this.dcWritePos = 64;
    this.dcReadPos = 0;

    // Connect directly to the target Telegram Data Center with multi-IP and port failover
    let socket = null;
    let lastError = null;

    for (const hostIp of candidateIps) {
      for (const port of candidatePorts) {
        if (this.dead) return;
        try {
          const candidateSocket = connect({ hostname: hostIp, port }, { secureTransport: "off" });
          candidateSocket.closed.catch(() => {});
          let timer = null;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("connect timeout")), 3500);
          });
          await Promise.race([candidateSocket.opened, timeoutPromise]);
          clearTimeout(timer);
          socket = candidateSocket;
          break;
        } catch (connErr) {
          lastError = connErr;
        }
      }
      if (socket) break;
    }

    if (!socket) {
      throw lastError || new Error("failed to connect to DC");
    }

    this.socket = socket;
    if (this.dead) {
      try { await socket.close(); } catch (_) {}
      return;
    }
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();

    // Construct and send initial Obfuscated2 header to the Telegram DC
    const dcHeader = new Uint8Array(64);
    let safe = false;
    for (let i = 0; i < 16 && !safe; i++) {
      crypto.getRandomValues(dcHeader.subarray(0, 8));
      safe = safeDcHeaderPrefix(dcHeader);
    }
    if (!safe) dcHeader.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], 0);
    dcHeader.set(header.subarray(8, 56), 8);
    dcHeader.set(tag, 56);
    const dcView = new DataView(dcHeader.buffer);
    dcView.setInt16(60, dcId, true);
    dcView.setUint16(62, 0, true);
    const encryptedTail = await ctrAt(this.dcWriteKey, this.dcWriteIv, 56, dcHeader.subarray(56, 64));
    dcHeader.set(encryptedTail, 56);
    await this.writer.write(dcHeader);
    if (this.dead) return;
    this.phase = "ready";
    this.pump().catch(() => this.kill(true));
  }

  async writeToDc(payload) {
    if (this.dead) return;
    const plain = await ctrAt(this.clientReadKey, this.clientReadIv, this.clientReadPos, payload);
    this.clientReadPos += payload.length;
    if (this.dead) return;
    const encrypted = await ctrAt(this.dcWriteKey, this.dcWriteIv, this.dcWritePos, plain);
    this.dcWritePos += payload.length;
    await this.writer.write(encrypted);
    this.grant(payload.length);
  }

  async pump() {
    const reader = this.reader;
    try {
      while (!this.dead) {
        if (this.sendCredit <= 0) {
          await this.waitCredit();
          continue;
        }
        const result = await reader.read();
        if (result.done) break;
        const value = result.value;
        let offset = 0;
        while (offset < value.length && !this.dead) {
          if (this.sendCredit <= 0) {
            await this.waitCredit();
            continue;
          }
          const size = Math.min(value.length - offset, this.sendCredit, this.session.cfg.dataChunk);
          if (size <= 0) continue;
          const chunk = value.subarray(offset, offset + size);
          const plain = await ctrAt(this.dcReadKey, this.dcReadIv, this.dcReadPos, chunk);
          this.dcReadPos += size;
          const encrypted = await ctrAt(this.clientWriteKey, this.clientWriteIv, this.clientWritePos, plain);
          this.clientWritePos += size;
          this.sendCredit -= size;
          this.session.sendFrame(frame(0x02, this.id, encrypted));
          offset += size;
        }
      }
    } catch (_) {}
    this.kill(true);
  }

  waitCredit() {
    if (this.dead || this.sendCredit > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.creditResolve = resolve;
    });
  }

  addCredit(amount) {
    if (this.dead) return;
    this.sendCredit = Math.min(0xffffffff, this.sendCredit + amount);
    if (this.creditResolve) {
      const resolve = this.creditResolve;
      this.creditResolve = null;
      resolve();
    }
  }

  grant(amount) {
    if (this.dead || amount <= 0) return;
    this.recvOutstanding = Math.max(0, this.recvOutstanding - amount);
    this.session.sendFrame(windowFrame(this.id, amount));
  }

  kill(notify) {
    if (this.dead) return;
    this.dead = true;
    this.session.streams.delete(this.id);
    this.session.remember(this.id);
    this.session.queued -= this.queuedLocal;
    if (this.session.queued < 0) this.session.queued = 0;
    this.queuedLocal = 0;
    this.inQueue.length = 0;
    if (this.creditResolve) {
      const resolve = this.creditResolve;
      this.creditResolve = null;
      resolve();
    }
    if (this.socket) {
      try { this.socket.close().catch(() => {}); } catch (_) {}
    }
    if (notify && !this.session.closed) this.session.sendFrame(frame(0x03, this.id, EMPTY));
  }
}

class WsSession {
  constructor(ws, cfg, secret) {
    this.ws = ws;
    this.cfg = cfg;
    this.secret = secret;
    this.streams = new Map();
    this.closed = false;
    this.queued = 0;
    this.tombstones = new Set();
    this.tombstoneOrder = [];
    this.chain = Promise.resolve();
    this.loggedMeNotice = false;
    this.lastPong = Date.now();

    // Periodic KeepAlive Heartbeat (every 25s)
    // Prevents Cloudflare 100s idle disconnect and ISP/TSPU DPI idle RST injection
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== 1) {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        return;
      }
      try {
        const pingPayload = new Uint8Array(4);
        new DataView(pingPayload.buffer).setUint32(0, Math.floor(Date.now() / 1000), false);
        this.sendFrame(frame(0x05, 0, pingPayload));
      } catch (_) {}
    }, 25000);
  }

  sendFrame(bytes) {
    if (this.closed) return;
    try {
      this.ws.send(bytes);
    } catch (_) {
      this.dispose();
    }
  }

  remember(id) {
    if (this.tombstones.has(id)) return;
    if (this.tombstoneOrder.length === 4096) this.tombstones.delete(this.tombstoneOrder.shift());
    this.tombstones.add(id);
    this.tombstoneOrder.push(id);
  }

  enqueue(data) {
    this.chain = this.chain.then(() => this.handle(data)).catch(() => this.shutdown());
  }

  async handle(data) {
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer)) {
      this.shutdown();
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes.length === 0 || bytes.length > REQUEST_LIMIT) {
      this.shutdown();
      return;
    }
    const view = new DataView(data);
    let offset = 0;
    let frames = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 8 || ++frames > 4096) {
        this.shutdown();
        return;
      }
      const type = bytes[offset];
      const id = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      const size = view.getUint32(offset + 4, false);
      const end = offset + 8 + size;
      if (size > 1048576 || end > bytes.length) {
        this.shutdown();
        return;
      }
      const payload = bytes.subarray(offset + 8, end);
      offset = end;
      if (type === 0x01) {
        // OPEN frame
        if (id === 0 || size !== 0) {
          this.shutdown();
          return;
        }
        if (this.streams.has(id) || this.tombstones.has(id) || this.streams.size >= this.cfg.maxStreams) {
          this.sendFrame(frame(0x03, id, EMPTY));
          continue;
        }
        this.streams.set(id, new Stream(this, id));
      } else if (type === 0x02) {
        // DATA frame
        if (id === 0 || size === 0) {
          this.shutdown();
          return;
        }
        const stream = this.streams.get(id);
        if (stream) stream.feed(payload);
        else if (!this.tombstones.has(id)) this.sendFrame(frame(0x03, id, EMPTY));
      } else if (type === 0x03) {
        // CLOSE frame
        if (id === 0 || size !== 0) {
          this.shutdown();
          return;
        }
        const stream = this.streams.get(id);
        if (stream) stream.kill(false);
      } else if (type === 0x04) {
        // WINDOW frame (credit grant)
        if (id === 0 || size !== 4) {
          this.shutdown();
          return;
        }
        const stream = this.streams.get(id);
        if (stream) stream.addCredit(new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false));
      } else if (type === 0x05) {
        // PING frame from client (0x05) -> respond with PONG (0x06) echoing payload
        if (id === 0) {
          this.sendFrame(frame(0x06, 0, payload));
        }
      } else if (type === 0x06) {
        // PONG frame from client (0x06) -> acknowledgment of keepalive
        if (id !== 0) {
          this.shutdown();
          return;
        }
        this.lastPong = Date.now();
      } else {
        this.shutdown();
        return;
      }
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    for (const stream of Array.from(this.streams.values())) stream.kill(false);
    this.streams.clear();
    this.queued = 0;
  }

  shutdown() {
    this.dispose();
    try {
      if (this.ws.readyState === 1) this.ws.close(1011, "closed");
    } catch (_) {}
  }
}

async function serveSession(request, cfg) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length <= 7) return notFound();
  const token = auth.substring(7);
  if (request.method === "DELETE") {
    if (!(await verifyToken(cfg, token, TOKEN_KIND_SESSION))) return notFound();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") return notFound();
  if (request.headers.get("cookie")) return notFound();
  if ((request.headers.get("content-type") || "").toLowerCase() !== "application/octet-stream") return notFound();
  const verified = await verifyToken(cfg, token, TOKEN_KIND_BOOTSTRAP);
  if (!verified) return notFound();
  if (verified.mode === 1 && !cfg.acceptGenerated) return notFound();
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length !== 9) return notFound();
  if (body[0] !== 0x10 || body[1] !== 0 || body[2] !== 0 || body[3] !== 0) return notFound();
  if (body[4] !== 0 || body[5] !== 0 || body[6] !== 0 || body[7] !== 1 || body[8] !== 1) return notFound();
  const sessionToken = await issueToken(cfg, TOKEN_KIND_SESSION, cfg.sessionTtl, verified.mode);
  return new Response(WELCOME, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Session-Token": sessionToken,
      "X-Down-Cursor": "0",
      "X-Carrier-Mode": cfg.carrier
    }
  });
}

async function serveWebSocket(request, cfg, host) {
  if (request.method !== "GET") return notFound();
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return notFound();
  if (request.headers.get("authorization")) return notFound();
  const offered = (request.headers.get("sec-websocket-protocol") || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (offered.length !== 1 || !offered[0].startsWith("tproxy-v1.")) return notFound();
  const protocol = offered[0];
  const token = protocol.substring(10);
  const verified = await verifyToken(cfg, token, TOKEN_KIND_SESSION);
  if (!verified) return notFound();
  if (verified.mode === 1 && !cfg.acceptGenerated) return notFound();
  const secret = verified.mode === 1 ? await deriveSecret(cfg, host) : cfg.base;
  if (!secret) return notFound();
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept();
  const session = new WsSession(server, cfg, secret);
  server.addEventListener("message", (event) => session.enqueue(event.data));
  server.addEventListener("close", () => session.dispose());
  server.addEventListener("error", () => session.dispose());
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "Sec-WebSocket-Protocol": protocol
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const host = requestHost(request, url);

      // Check secret generator BEFORE checking cfg, so fresh deployments without env.SECRET can generate one!
      const label = generatorLabel(url);
      if (label !== null) {
        const generatorEnabled = env?.GENERATOR_ENABLED !== undefined
          ? (env.GENERATOR_ENABLED === "true" || env.GENERATOR_ENABLED === "1")
          : CONFIG.generatorEnabled;
        if (!generatorEnabled) return notFound();
        const cfg = await getRuntime(env);
        return serveSecret(cfg, host, label || url.searchParams.get("host") || host);
      }

      const cfg = await getRuntime(env);
      if (!cfg) return decoy(env?.DECOY_URL);

      if (!hostAllowed(cfg, host)) return decoy(cfg.decoyUrl);
      if (url.pathname === "/" && request.method === "GET") {
        const bridges = url.searchParams.getAll("bridge");
        if (bridges.length === 0) return decoy(cfg.decoyUrl);
        const keys = Array.from(url.searchParams.keys());
        if (keys.length !== 1 || keys[0] !== "bridge" || bridges.length !== 1) return notFound();
        const mode = await bridgeMode(cfg, host, bridges[0]);
        if (mode < 0) return notFound();
        return serveBridge(cfg, host, mode);
      }
      if (url.pathname === "/api/v1/session") return serveSession(request, cfg);
      if (url.pathname === "/api/v1/ws") return serveWebSocket(request, cfg, host);
      return decoy(cfg.decoyUrl);
    } catch (_) {
      return decoy(env?.DECOY_URL);
    }
  }
};
