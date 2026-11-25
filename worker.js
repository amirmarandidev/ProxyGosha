import { connect } from "cloudflare:sockets";

/*
 * ===================== QUICK SETUP (no code editing) =====================
 * 1. Paste this file into a Cloudflare Worker and Deploy.
 * 2. Worker -> Settings -> Variables and Secrets -> add ONE variable:
 *        ADMIN_KEY = a long random password (16+ letters/digits)
 *    (Opening the worker address before this shows a setup page with a ready key.)
 * 3. Attach a Custom Domain (Workers -> Settings -> Domains & Routes -> Custom Domain),
 *    because workers.dev is commonly filtered in Iran and only serves port 443.
 * 4. Open  https://<your-domain>/<ADMIN_KEY>  -> panel with ready Telegram links.
 *    Official Telegram WEB Proxy uses HTTPS port 443; non-443 Cloudflare HTTPS ports
 *    (2053, 2083, 2087, 2096, 8443) are kept in the panel for backward compatibility.
 *    Open  https://<your-domain>/<ADMIN_KEY>/status  -> 5-stage diagnostics, recent
 *    sanitized events, and an on-demand Cloudflare->Telegram DC probe (?probe=1).
 * Optional environment variables:
 *    SECRET           = fixed 32-hex (or dd+32-hex) secret (otherwise derived from ADMIN_KEY)
 *    EXTRA_HOSTS      = other hostnames already attached to this Worker, comma separated
 *    CARRIER          = "websocket-lanes" (default, with safe auto-fallback to "websocket"),
 *                       "websocket" (single multiplexed WS), or "https" (ONLY when optional
 *                       PROXY_DO SQLite Durable Object binding is attached; otherwise falls
 *                       back to "websocket-lanes" with an explicit warning in the panel)
 *    WS_AUTO_FALLBACK = "false" to disable websocket-lanes -> websocket fallback
 *    SESSION_PATH     = custom path for session bootstrap (default /api/v1/session)
 *    WS_PATH          = custom path for WebSocket carrier (default /api/v1/ws)
 *    UP_PATH          = custom path for optional DO HTTPS uplink (default /api/v1/up)
 *    DOWN_PATH        = custom path for optional DO HTTPS downlink (default /api/v1/down)
 *    DECOY_URL        = real HTTPS URL you own (or have permission for) to proxy as decoy
 * Optional Cloudflare bindings (100% Free tier, NOT required for normal operation):
 *    SETTINGS_KV      = Free Workers KV namespace to save Global Panel Settings live
 *                       from /<ADMIN_KEY> across all Cloudflare isolates (zero redeploy).
 *                       Even without SETTINGS_KV, the panel provides instant Per-Operator
 *                       profile links (Fast / Mobile-Mux / Mobile-Lanes) that work globally!
 *    PROXY_DO         = Free SQLite Durable Object (ProxySessionDO) to unlock true
 *                       CARRIER=https long-polling for networks that block WebSocket.
 * =========================================================================
 */

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
 *    - Free Plan Limits (per incoming request / WebSocket invocation): 10 ms CPU time,
 *      50 subrequests, 6 connections in the "connecting" phase; 128 MB memory per
 *      isolate (shared by every session running in that isolate), 100k requests/day.
 *    - Default carrier is "websocket-lanes": every MTProto stream gets its own
 *      WebSocket, i.e. its own invocation with its own CPU/subrequest budget.
 *    - Fast mode: the DC-side obfuscation keys are chosen so DC->client bytes are
 *      forwarded without any re-encryption (download direction costs ~0 CPU).
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
const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

// Release version of this worker build (shown on the admin status page).
const VERSION = "1.5.1";

const CONFIG = {
  secretHex: "",                // Overridden by env.SECRET (32 hex or dd+32 hex)
  adTagHex: "",                 // Overridden by env.AD_TAG (32 hex) — ignored in Direct-DC mode
  hostnames: ["*"],             // Overridden by env.HOSTNAME (comma-separated or '*')
  debug: false,                 // Overridden by env.DEBUG ("true" or "1")

  generatorEnabled: false,      // Secret page is OFF by default (it used to leak SECRET publicly)
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
  dcConnectTimeoutMs: 2200,     // Per-attempt TCP connect timeout (bounds client stall)
  dcTotalTimeoutMs: 7500,       // Total DC connect budget across attempts
  dcMaxAttempts: 4,             // Max DC connect attempts per stream (stays well under 50 subreq limit)
  dcMaxConcurrentDials: 4,      // Max simultaneous in-flight DC connects per session (< CF limit of 6)
  dcWriteTimeoutMs: 25000,      // Max wait for a single DC socket write before aborting stream
  carrier: "websocket-lanes",   // "websocket-lanes" (default), "websocket", or "https" (requires optional PROXY_DO)
  wsAutoFallback: true,         // Safe auto-fallback from websocket-lanes -> websocket on lane open failure
  sessionPath: "/api/v1/session",
  wsPath: "/api/v1/ws",
  upPath: "/api/v1/up",
  downPath: "/api/v1/down",
  batchBytes: 2097152,
  wsBatchBytes: 65536,          // Bounded mux WS send chunk (avoids upload bufferbloat on throttled mobile links)
  wsBufferHighWater: 262144,    // 256 KiB mux WS send high-water mark (keeps PING/chat responsive behind uploads)
  laneBatchBytes: 131072,       // Bounded per-lane WS send chunk
  laneBufferHighWater: 524288,  // 512 KiB per-lane WS send high-water mark
  httpsUpBatch: 131072,         // Starting HTTPS uplink POST batch (adapts down to 32 KiB on slow/lossy upload)
  httpsDownBatch: 524288,       // Max HTTPS downlink poll response (bounds replay cost on mobile drops)
  wsInitRetries: 3,             // Initial WebSocket open retries in CARRIER=websocket mode
  laneOpenTimeoutMs: 7500,      // First-attempt open timeout per WebSocket lane before retry/fallback
  idleTimeoutMs: 65000,         // Client-side WS heartbeat idle cutoff (ms)
  speedProfile: "balanced",     // "fast" | "balanced" | "low-upload"
  dcProfile: "normal",          // "normal" | "tolerant"
  bootstrapTtl: 3600,           // 1 hour (resilient against session renegotiation and client reconnects)
  sessionTtl: 86400,
  maxStreams: 6,                // Safe default for Cloudflare Workers Free plan socket limits
  maxQueued: 16777216,
  streamWindow: 4194304,
  dataChunk: 65536,
  httpsPollTimeoutMs: 25000,    // Long-poll hold duration in optional PROXY_DO HTTPS mode
  httpsIdleTimeoutMs: 90000,    // Idle cleanup timeout for optional PROXY_DO HTTPS sessions
  httpsDownDataCap: 4194304     // Max buffered downlink DATA per DO session (leaves control headroom)
};

const te = new TextEncoder();
const TOKEN_DOMAIN = te.encode("tgweb-token-v1\0");
const BUILD_SEAL = "Pt54F2/pkjqM1YnQmZRs3Xvqd54U1iZVSYCfYAOgf5wIRzjyeruT";
const TOKEN_KIND_BOOTSTRAP = 1;
const TOKEN_KIND_SESSION = 2;
const TOKEN_KIND_CSRF = 3;
const PORT_MODE_BASE = 10;
const PROFILE_MODE_BASE = 20;
const REQUEST_LIMIT = 16777216;
const WS_SUBREQ_SOFT_LIMIT = 46; // Safety ceiling below Free plan's 50 external subrequests/invocation
const KV_SETTINGS_KEY = "panel_settings_v1";
const KV_SETTINGS_TTL_MS = 15000;

const SPEED_PRESETS = {
  fast: {
    wsBatchBytes: 524288,
    wsBufferHighWater: 1048576,
    laneBatchBytes: 1048576,
    laneBufferHighWater: 2097152,
    httpsUpBatch: 524288,
    httpsDownBatch: 2097152,
    wsInitRetries: 2,
    laneOpenTimeoutMs: 8000,
    idleTimeoutMs: 60000
  },
  balanced: {
    wsBatchBytes: 65536,
    wsBufferHighWater: 262144,
    laneBatchBytes: 131072,
    laneBufferHighWater: 524288,
    httpsUpBatch: 131072,
    httpsDownBatch: 524288,
    wsInitRetries: 3,
    laneOpenTimeoutMs: 7500,
    idleTimeoutMs: 65000
  },
  "low-upload": {
    wsBatchBytes: 32768,
    wsBufferHighWater: 131072,
    laneBatchBytes: 65536,
    laneBufferHighWater: 262144,
    httpsUpBatch: 65536,
    httpsDownBatch: 524288,
    wsInitRetries: 4,
    laneOpenTimeoutMs: 5500,
    idleTimeoutMs: 75000
  }
};

const DC_PRESETS = {
  normal: { dcConnectTimeoutMs: 2200, dcTotalTimeoutMs: 7500, dcWriteTimeoutMs: 25000 },
  tolerant: { dcConnectTimeoutMs: 3000, dcTotalTimeoutMs: 9500, dcWriteTimeoutMs: 30000 }
};

// Deterministic per-operator profiles (modes 20..23). Each gets a stable secret
// derived from cfg.base, so multiple users on different ISPs (e.g. FTTH vs Irancell)
// can connect simultaneously with different transport settings — zero KV/DO needed!
const OPERATOR_PROFILES = [
  {
    id: "fast",
    mode: PROFILE_MODE_BASE + 0,
    carrier: "websocket-lanes",
    wsAutoFallback: true,
    speedProfile: "fast",
    dcProfile: "normal",
    requiresDo: false,
    titleEn: "High-Speed / Unrestricted ISP & Fixed Broadband",
    titleFa: "پرسرعت / اینترنت ثابت و اپراتور بدون محدودیت",
    descEn: "websocket-lanes with large 1 MiB batches for maximum throughput on clean ISPs (FTTH / ADSL / unrestricted mobile).",
    descFa: "حالت websocket-lanes با بسته‌های بزرگ ۱ مگابایتی برای حداکثر سرعت روی اینترنت ثابت یا اپراتورهای بدون محدودیت."
  },
  {
    id: "mobile-mux",
    mode: PROFILE_MODE_BASE + 1,
    carrier: "websocket",
    wsAutoFallback: false,
    speedProfile: "low-upload",
    dcProfile: "tolerant",
    requiresDo: false,
    titleEn: "Mobile / Irancell — Single WebSocket & Low-Upload",
    titleFa: "موبایل / ایرانسل — تک‌کاناله ضد اختلال WS و آپلود محدود",
    descEn: "Single multiplexed WebSocket with 32 KiB anti-bufferbloat chunks, 4 initial WS retries, and 75s watchdog — best when an ISP drops parallel WS lanes or throttles upload.",
    descFa: "تک وب‌سوکت مالتی‌پلکس با بسته‌های کوچک ۳۲ کیلوبایتی، ۴ تلاش اولیه و مهلت ۷۵ ثانیه‌ای — مناسب وقتی اپراتور (مثل ایرانسل) WS چندکاناله یا آپلود را محدود می‌کند."
  },
  {
    id: "mobile-lanes",
    mode: PROFILE_MODE_BASE + 2,
    carrier: "websocket-lanes",
    wsAutoFallback: true,
    speedProfile: "low-upload",
    dcProfile: "tolerant",
    requiresDo: false,
    titleEn: "Mobile — Multi-Lane Low-Upload + Fast Fallback",
    titleFa: "موبایل — چندکاناله با آپلود آهسته و فالبک سریع",
    descEn: "websocket-lanes with 64 KiB upload chunks and faster 5.5s open timeout that safely falls back to single WebSocket if lanes are blocked.",
    descFa: "حالت چندکاناله با بسته‌های ۶۴ کیلوبایتی و تایم‌اوت سریع ۵.۵ ثانیه‌ای که در صورت اختلال، ایمن به تک وب‌سوکت سوئیچ می‌کند."
  },
  {
    id: "https-do",
    mode: PROFILE_MODE_BASE + 3,
    carrier: "https",
    wsAutoFallback: false,
    speedProfile: "balanced",
    dcProfile: "tolerant",
    requiresDo: true,
    titleEn: "WebSocket-Blocked ISP — True HTTPS Long-Polling",
    titleFa: "ضد مسدودسازی WebSocket — حالت HTTPS واقعی",
    descEn: "Serialized HTTPS long-polling via optional PROXY_DO Durable Object (adaptive 128→32 KiB uplink). Only active when PROXY_DO is bound.",
    descFa: "حالت HTTPS long-polling واقعی از طریق بایندینگ اختیاری PROXY_DO (آپلود تطبیقی ۱۲۸ تا ۳۲ کیلوبایت). فقط در صورت اتصال PROXY_DO فعال است."
  }
];

// ---- Lightweight in-memory telemetry (per isolate, best effort) ----
// No external calls, no dependencies, bounded memory. Powers the admin status
// page with stage-by-stage diagnostics (Edge -> Bridge -> Session -> Carrier -> DC).
// Counters and logs reset whenever Cloudflare recycles this isolate and are NOT
// shared across isolates or edge regions. No client IPs, ADMIN_KEY, secrets,
// tokens, or bridge URLs are ever recorded.
const ISOLATE_START = Date.now();
const STATS = {
  pageHits: 0,              // Stage 1: root/decoy page hits reaching this isolate
  bridgeOk: 0,              // Stage 2: valid GET /?bridge= handshakes served
  bridgeRejects: 0,         // Stage 2: rejected bridge capability / host mismatch
  sessionCreateOk: 0,       // Stage 3: POST /api/v1/session succeeded
  sessionCreateRejects: 0,  // Stage 3: POST /api/v1/session rejected
  sessions: 0,              // Stage 4: WebSocket proxy sessions created in this isolate
  sessionsActive: 0,        // Stage 4: currently open WebSocket sessions in this isolate
  wsLanesOpened: 0,         // Stage 4: websocket-lanes upgrades accepted
  wsMuxOpened: 0,           // Stage 4: multiplexed websocket upgrades accepted
  wsRejects: 0,             // Stage 4: WebSocket upgrades rejected (bad/expired token/protocol)
  httpsSessions: 0,         // Stage 4 (optional DO): HTTPS sessions initialized
  httpsUpOk: 0,             // Stage 4 (optional DO): HTTPS /up requests accepted
  httpsUpRejects: 0,        // Stage 4 (optional DO): HTTPS /up requests rejected/503
  httpsDownOk: 0,           // Stage 4 (optional DO): HTTPS /down polls completed
  httpsDownRejects: 0,      // Stage 4 (optional DO): HTTPS /down polls rejected
  streams: 0,               // Stage 5: MTProto streams opened in this isolate
  streamsHeaderOk: 0,       // Stage 5: valid Obfuscated2 client headers decrypted
  streamsHeaderFail: 0,     // Stage 5: invalid/unrecognized Obfuscated2 headers (e.g. bad secret)
  dcAttempts: 0,            // Stage 5: outbound TCP connect attempts to Telegram DCs
  dcOk: 0,                  // Stage 5: successful outbound DC connects
  dcOk443: 0,               // Stage 5: successful DC connects on port 443
  dcOk80: 0,                // Stage 5: successful DC connects on port 80
  dcOk5222: 0,              // Stage 5: successful DC connects on port 5222
  dcFails: 0,               // Stage 5: failed DC connects (timeout + error)
  dcTimeouts: 0,            // Stage 5: DC connect timeouts
  dcErrors: 0,              // Stage 5: DC connect errors (refused/reset/etc)
  bytesUp: 0,               // client -> Telegram bytes (approximate)
  bytesDown: 0,             // Telegram -> client bytes (approximate)
  panelViews: 0,
  statusViews: 0
};
const LOG = [];
const LOG_LIMIT = 120;
const DC_COOLDOWN = new Map();
const DC_COOLDOWN_TTL_MS = 30000;
const DC_COOLDOWN_LIMIT = 64;
let carrierFallbackLogged = "";

function markDcCooldown(ip, port, now = Date.now()) {
  const key = ip + ":" + port;
  DC_COOLDOWN.set(key, now);
  if (DC_COOLDOWN.size > DC_COOLDOWN_LIMIT) {
    const oldest = DC_COOLDOWN.keys().next().value;
    if (oldest) DC_COOLDOWN.delete(oldest);
  }
}

function clearDcCooldown(ip, port) {
  DC_COOLDOWN.delete(ip + ":" + port);
}

function isDcCooledDown(ip, port, now = Date.now()) {
  const key = ip + ":" + port;
  const ts = DC_COOLDOWN.get(key);
  if (ts === undefined) return false;
  if (now - ts >= DC_COOLDOWN_TTL_MS) {
    DC_COOLDOWN.delete(key);
    return false;
  }
  return true;
}

// Strips secrets, tokens, query parameters, fragments, and admin paths before logging.
function sanitizeDetail(detail, secrets) {
  let text = String(detail || "").replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim();
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      if (s && s.length >= 8 && text.includes(s)) text = text.split(s).join("[redacted]");
    }
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/tproxy-(?:lane-)?v1\.[A-Za-z0-9._-]+/gi, "tproxy-[redacted]")
    .replace(/([?&](?:bridge|key|secret|token|admin)=)[^&\s#]+/gi, "$1[redacted]")
    .replace(/\?[^\s#]+/g, "?[redacted]")
    .replace(/#[^\s]+/g, "#[redacted]")
    .replace(/\b(?:dd)?[0-9a-f]{32,}\b/gi, "[hex-redacted]")
    .replace(/\b[A-Za-z0-9_-]{36,}\b/g, "[tok-redacted]");
  return text.slice(0, 120);
}

function logEvent(event, detail, secrets) {
  try {
    LOG.push({
      t: Date.now(),
      event: String(event).replace(/[\r\n\t]+/g, " ").slice(0, 24),
      detail: sanitizeDetail(detail, secrets)
    });
    if (LOG.length > LOG_LIMIT) LOG.splice(0, LOG.length - LOG_LIMIT);
  } catch (_) {}
}

const PERMISSIONS_POLICY = "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()";

// Realistic premium fashion e-commerce storefront for anti-censorship camouflage
// (resists GFW / TSPU / DPI active probing — looks like a legitimate clothing brand)
const DECOY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="LUXVEIL — Premium contemporary fashion. Curated collections of designer apparel, outerwear, and accessories for the modern wardrobe.">
<meta name="robots" content="index, follow">
<meta property="og:title" content="LUXVEIL — Contemporary Fashion House">
<meta property="og:type" content="website">
<title>LUXVEIL &mdash; Contemporary Fashion House</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#faf9f7;--surface:#fff;--text:#1a1a1a;--muted:#71717a;--accent:#92400e;--accent-light:#fef3c7;--border:#e4e4e7;--hover:#f4f4f5;--gold:#b8860b;--shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow-lg:0 10px 25px rgba(0,0,0,.07),0 4px 10px rgba(0,0,0,.04)}
@keyframes fadeUp{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
.announce{background:var(--text);color:#fff;text-align:center;padding:.55rem 1rem;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;overflow:hidden}
.announce-inner{display:inline-flex;gap:3rem;animation:marquee 25s linear infinite;white-space:nowrap}
nav{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);background:rgba(255,255,255,.92)}
.nav-inner{max-width:1280px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:.85rem 2rem}
.nav-logo{font-size:1.4rem;font-weight:800;letter-spacing:.22em;text-transform:uppercase}
.nav-links{display:flex;gap:2rem;list-style:none;font-size:.88rem;font-weight:500;letter-spacing:.03em;text-transform:uppercase}
.nav-links a{position:relative;padding:.25rem 0;transition:color .2s}
.nav-links a::after{content:'';position:absolute;bottom:0;left:0;width:0;height:1.5px;background:var(--accent);transition:width .3s ease}
.nav-links a:hover::after{width:100%}
.nav-links a:hover{color:var(--accent)}
.nav-icons{display:flex;align-items:center;gap:1.25rem}
.nav-icons svg{width:20px;height:20px;stroke:var(--text);stroke-width:1.5;fill:none;cursor:pointer;transition:stroke .2s}
.nav-icons svg:hover{stroke:var(--accent)}
.cart-badge{position:relative}
.cart-badge::after{content:'2';position:absolute;top:-6px;right:-8px;background:var(--accent);color:#fff;font-size:.6rem;width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700}
.hamburger{display:none;flex-direction:column;gap:4px;cursor:pointer;padding:4px}
.hamburger span{width:20px;height:1.5px;background:var(--text);border-radius:1px}
.hero{max-width:1280px;margin:0 auto;padding:0 2rem;display:grid;grid-template-columns:1fr 1fr;gap:3rem;align-items:center;min-height:75vh;animation:fadeIn .8s ease}
.hero-text{animation:fadeUp .9s ease .1s both}
.hero-tag{display:inline-block;font-size:.72rem;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);background:var(--accent-light);padding:.35rem .9rem;border-radius:2rem;font-weight:600;margin-bottom:1.5rem}
.hero h1{font-size:3.5rem;font-weight:800;line-height:1.08;letter-spacing:-.02em;margin-bottom:1.25rem}
.hero h1 em{font-style:normal;color:var(--accent)}
.hero p{font-size:1.1rem;color:var(--muted);max-width:460px;margin-bottom:2rem;line-height:1.7}
.hero-btns{display:flex;gap:1rem;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:.5rem;padding:.85rem 2rem;border-radius:.4rem;font-size:.88rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;transition:all .25s ease;cursor:pointer;border:none}
.btn-primary{background:var(--text);color:#fff}
.btn-primary:hover{background:var(--accent);transform:translateY(-1px);box-shadow:var(--shadow-lg)}
.btn-outline{background:transparent;color:var(--text);border:1.5px solid var(--border)}
.btn-outline:hover{border-color:var(--text);background:var(--hover)}
.hero-visual{position:relative;animation:fadeUp .9s ease .3s both}
.hero-img{width:100%;aspect-ratio:3/4;background:linear-gradient(135deg,#e8e0d6 0%,#d4c8b8 30%,#c9b99a 60%,#b8a88a 100%);border-radius:1rem;overflow:hidden;position:relative}
.hero-img::before{content:'';position:absolute;inset:0;background:linear-gradient(45deg,transparent 40%,rgba(255,255,255,.15) 50%,transparent 60%);background-size:200% 200%;animation:shimmer 4s ease-in-out infinite}
.hero-img::after{content:'LUXVEIL';position:absolute;bottom:2rem;left:2rem;font-size:1.1rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.7);font-weight:300}
.hero-float{position:absolute;right:-1rem;top:25%;background:var(--surface);border-radius:.75rem;padding:1rem 1.25rem;box-shadow:var(--shadow-lg);animation:float 4s ease-in-out infinite;z-index:2}
.hero-float .hf-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:.25rem}
.hero-float .hf-value{font-size:1.3rem;font-weight:700;color:var(--accent)}
.banner{background:var(--text);padding:1rem 0;overflow:hidden}
.banner-track{display:flex;gap:3rem;animation:marquee 20s linear infinite;white-space:nowrap}
.banner-track span{color:rgba(255,255,255,.6);font-size:.78rem;letter-spacing:.2em;text-transform:uppercase;font-weight:500}
.section{max-width:1280px;margin:0 auto;padding:5rem 2rem}
.section-head{text-align:center;margin-bottom:3.5rem}
.section-head h2{font-size:2.2rem;font-weight:800;letter-spacing:-.01em;margin-bottom:.75rem}
.section-head p{color:var(--muted);font-size:1rem;max-width:480px;margin:0 auto}
.products{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5rem}
.product{cursor:pointer}
.product-img{aspect-ratio:3/4;border-radius:.75rem;overflow:hidden;position:relative;margin-bottom:1rem}
.product-img .img-fill{width:100%;height:100%;transition:transform .6s ease}
.product:hover .img-fill{transform:scale(1.06)}
.p1 .img-fill{background:linear-gradient(160deg,#c4b5a3,#a89279)}
.p2 .img-fill{background:linear-gradient(160deg,#2c2c2c,#555)}
.p3 .img-fill{background:linear-gradient(160deg,#8b7355,#c4a97d)}
.p4 .img-fill{background:linear-gradient(160deg,#d6cfc4,#a89888)}
.product-img .quick{position:absolute;bottom:0;left:0;right:0;background:rgba(26,26,26,.88);color:#fff;text-align:center;padding:.7rem;font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;transform:translateY(100%);transition:transform .35s ease;backdrop-filter:blur(4px)}
.product:hover .quick{transform:translateY(0)}
.product-info h3{font-size:.92rem;font-weight:600;margin-bottom:.3rem}
.product-info .cat{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.4rem}
.product-info .price{font-size:.95rem;font-weight:700}
.product-info .price .old{text-decoration:line-through;color:var(--muted);font-weight:400;margin-left:.4rem;font-size:.85rem}
.product-colors{display:flex;gap:.35rem;margin-top:.5rem}
.product-colors span{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--border);transition:transform .2s}
.product-colors span:hover{transform:scale(1.3)}
.features{display:grid;grid-template-columns:repeat(4,1fr);gap:2rem;margin-top:4rem}
.feature{text-align:center;padding:2rem 1.25rem;border-radius:.75rem;transition:all .3s ease}
.feature:hover{background:var(--surface);box-shadow:var(--shadow-lg);transform:translateY(-4px)}
.feature svg{width:32px;height:32px;stroke:var(--accent);stroke-width:1.5;fill:none;margin:0 auto 1rem}
.feature h4{font-size:.92rem;font-weight:700;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.04em}
.feature p{font-size:.82rem;color:var(--muted);line-height:1.6}
.lookbook{display:grid;grid-template-columns:1fr 1fr;gap:0;min-height:65vh;margin:5rem 0}
.lookbook-img{background:linear-gradient(160deg,#d4c4b0,#baa78c);position:relative;overflow:hidden}
.lookbook-img::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 60%,rgba(0,0,0,.2) 100%)}
.lookbook-content{display:flex;flex-direction:column;justify-content:center;padding:5rem 4rem;background:var(--surface)}
.lookbook-content .lb-tag{font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin-bottom:1rem}
.lookbook-content h2{font-size:2.8rem;font-weight:800;line-height:1.1;margin-bottom:1.25rem}
.lookbook-content p{color:var(--muted);font-size:1rem;line-height:1.8;margin-bottom:2rem;max-width:400px}
.reviews{display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem}
.review{background:var(--surface);border:1px solid var(--border);border-radius:.75rem;padding:2rem;transition:box-shadow .3s,transform .3s}
.review:hover{box-shadow:var(--shadow-lg);transform:translateY(-3px)}
.review-stars{color:var(--gold);font-size:.85rem;margin-bottom:.75rem;letter-spacing:2px}
.review p{font-size:.9rem;color:var(--text);line-height:1.7;margin-bottom:1rem;font-style:italic}
.review-author{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.newsletter{text-align:center;background:var(--text);color:#fff;padding:5rem 2rem}
.newsletter h2{font-size:2rem;font-weight:800;margin-bottom:.75rem}
.newsletter p{color:rgba(255,255,255,.55);margin-bottom:2rem;font-size:.95rem}
.newsletter-form{display:flex;max-width:460px;margin:0 auto;border-radius:.4rem;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.2)}
.newsletter-form input{flex:1;padding:.9rem 1.25rem;border:none;font-size:.88rem;outline:none;background:#fff;color:var(--text)}
.newsletter-form button{padding:.9rem 1.8rem;background:var(--accent);color:#fff;border:none;font-size:.82rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background .2s;white-space:nowrap}
.newsletter-form button:hover{background:#7c3309}
footer{background:var(--surface);border-top:1px solid var(--border);padding:4rem 2rem 2rem}
.footer-inner{max-width:1280px;margin:0 auto}
.footer-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:3rem;margin-bottom:3rem}
.footer-brand .f-logo{font-size:1.2rem;font-weight:800;letter-spacing:.2em;text-transform:uppercase;margin-bottom:.75rem}
.footer-brand p{color:var(--muted);font-size:.85rem;line-height:1.7;max-width:280px}
.footer-col h5{font-size:.75rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:1rem}
.footer-col ul{list-style:none}
.footer-col li{margin-bottom:.5rem}
.footer-col a{font-size:.88rem;color:var(--text);transition:color .2s}
.footer-col a:hover{color:var(--accent)}
.footer-bottom{display:flex;justify-content:space-between;align-items:center;padding-top:2rem;border-top:1px solid var(--border);font-size:.78rem;color:var(--muted)}
.footer-social{display:flex;gap:1rem}
.footer-social svg{width:18px;height:18px;stroke:var(--muted);stroke-width:1.5;fill:none;transition:stroke .2s;cursor:pointer}
.footer-social svg:hover{stroke:var(--accent)}
@media(max-width:1024px){
.hero{grid-template-columns:1fr;text-align:center;min-height:auto;padding-top:3rem}
.hero h1{font-size:2.6rem}
.hero p{margin:0 auto 2rem}
.hero-btns{justify-content:center}
.hero-visual{max-width:400px;margin:0 auto}
.hero-float{display:none}
.products{grid-template-columns:repeat(2,1fr)}
.features{grid-template-columns:repeat(2,1fr)}
.lookbook{grid-template-columns:1fr}
.lookbook-content{padding:3rem 2rem}
.footer-grid{grid-template-columns:1fr 1fr}
.reviews{grid-template-columns:1fr}
}
@media(max-width:640px){
.nav-links{display:none}
.hamburger{display:flex}
.hero h1{font-size:2rem}
.products,.features,.footer-grid{grid-template-columns:1fr}
.newsletter-form{flex-direction:column}
.newsletter-form input,.newsletter-form button{width:100%}
.lookbook-content h2{font-size:2rem}
}
</style>
</head>
<body>
<div class="announce"><div class="announce-inner"><span>Free express shipping on orders over $150</span><span>&bull;</span><span>New Season &mdash; Autumn/Winter 2026 Collection now live</span><span>&bull;</span><span>Complimentary gift wrapping on all orders</span><span>&bull;</span><span>Free express shipping on orders over $150</span><span>&bull;</span><span>New Season &mdash; Autumn/Winter 2026 Collection now live</span><span>&bull;</span><span>Complimentary gift wrapping on all orders</span></div></div>
<nav><div class="nav-inner"><a href="/" class="nav-logo">LUXVEIL</a><ul class="nav-links"><li><a href="/">New Arrivals</a></li><li><a href="/">Women</a></li><li><a href="/">Men</a></li><li><a href="/">Outerwear</a></li><li><a href="/">Accessories</a></li><li><a href="/">Sale</a></li></ul><div class="nav-icons"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><div class="cart-badge"><svg viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div><div class="hamburger"><span></span><span></span><span></span></div></div></div></nav>
<section class="hero"><div class="hero-text"><div class="hero-tag">Autumn/Winter 2026</div><h1>Redefine Your<br><em>Everyday</em> Elegance</h1><p>Discover our latest collection of meticulously crafted garments, designed with premium fabrics and contemporary silhouettes for the modern wardrobe.</p><div class="hero-btns"><a href="/" class="btn btn-primary">Shop Collection <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a><a href="/" class="btn btn-outline">Lookbook</a></div></div><div class="hero-visual"><div class="hero-img"></div><div class="hero-float"><div class="hf-label">Best Seller</div><div class="hf-value">Cashmere Overcoat</div></div></div></section>
<div class="banner"><div class="banner-track"><span>Premium Quality</span><span>&#10022;</span><span>Sustainable Materials</span><span>&#10022;</span><span>Handcrafted Details</span><span>&#10022;</span><span>Worldwide Delivery</span><span>&#10022;</span><span>30-Day Returns</span><span>&#10022;</span><span>Premium Quality</span><span>&#10022;</span><span>Sustainable Materials</span><span>&#10022;</span><span>Handcrafted Details</span><span>&#10022;</span><span>Worldwide Delivery</span><span>&#10022;</span><span>30-Day Returns</span></div></div>
<section class="section"><div class="section-head"><h2>Curated Essentials</h2><p>Timeless pieces designed to transition seamlessly from season to season.</p></div><div class="products"><div class="product"><div class="product-img p1"><div class="img-fill"></div><div class="quick">Quick View</div></div><div class="product-info"><div class="cat">Outerwear</div><h3>Wool Blend Overcoat</h3><div class="price">$385.00</div><div class="product-colors"><span style="background:#c4b5a3"></span><span style="background:#2c2c2c"></span><span style="background:#8b7355"></span></div></div></div><div class="product"><div class="product-img p2"><div class="img-fill"></div><div class="quick">Quick View</div></div><div class="product-info"><div class="cat">Tailoring</div><h3>Relaxed Fit Blazer</h3><div class="price">$265.00</div><div class="product-colors"><span style="background:#2c2c2c"></span><span style="background:#3d4f5f"></span></div></div></div><div class="product"><div class="product-img p3"><div class="img-fill"></div><div class="quick">Quick View</div></div><div class="product-info"><div class="cat">Knitwear</div><h3>Merino Turtleneck</h3><div class="price">$145.00 <span class="old">$195.00</span></div><div class="product-colors"><span style="background:#8b7355"></span><span style="background:#f5f0eb"></span><span style="background:#4a3728"></span></div></div></div><div class="product"><div class="product-img p4"><div class="img-fill"></div><div class="quick">Quick View</div></div><div class="product-info"><div class="cat">Accessories</div><h3>Leather Crossbody Bag</h3><div class="price">$220.00</div><div class="product-colors"><span style="background:#d6cfc4"></span><span style="background:#2c2c2c"></span></div></div></div></div></section>
<section class="section" style="padding-top:0"><div class="features"><div class="feature"><svg viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8l4 2v4l-4 2"/></svg><h4>Free Shipping</h4><p>Complimentary express delivery on all orders over $150. Worldwide tracked shipping.</p></div><div class="feature"><svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><h4>Secure Checkout</h4><p>256-bit SSL encryption with trusted payment partners. Your data is always protected.</p></div><div class="feature"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.8 1 6.5 2.6"/><path d="M22 4L12 14.01l-3-3"/></svg><h4>Quality Guarantee</h4><p>Every garment is inspected for quality. 30-day hassle-free returns and exchanges.</p></div><div class="feature"><svg viewBox="0 0 24 24"><path d="M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/></svg><h4>Sustainable Fashion</h4><p>Ethically sourced materials with carbon-neutral shipping. Fashion with a conscience.</p></div></div></section>
<section class="lookbook"><div class="lookbook-img"></div><div class="lookbook-content"><div class="lb-tag">The Lookbook</div><h2>Autumn<br>Silhouettes</h2><p>Explore our editorial collection featuring rich tonal palettes, luxurious textures, and the defining shapes of the season. Each piece tells a story of understated refinement.</p><a href="/" class="btn btn-primary">View Lookbook</a></div></section>
<section class="section"><div class="section-head"><h2>What Our Clients Say</h2><p>Trusted by thousands of discerning customers worldwide.</p></div><div class="reviews"><div class="review"><div class="review-stars">&starf;&starf;&starf;&starf;&starf;</div><p>&ldquo;The quality of the cashmere overcoat exceeded my expectations. Impeccable tailoring and the fabric feels absolutely luxurious.&rdquo;</p><div class="review-author">&mdash; Sarah M., London</div></div><div class="review"><div class="review-stars">&starf;&starf;&starf;&starf;&starf;</div><p>&ldquo;Fast shipping to Dubai and the packaging was beautiful. The merino turtleneck is now my go-to piece for every occasion.&rdquo;</p><div class="review-author">&mdash; Ahmed K., Dubai</div></div><div class="review"><div class="review-stars">&starf;&starf;&starf;&starf;&starf;</div><p>&ldquo;Finally found a brand that combines minimalist design with real craftsmanship. The blazer fits perfectly &mdash; no alterations needed.&rdquo;</p><div class="review-author">&mdash; Elena V., Paris</div></div></div></section>
<section class="newsletter"><h2>Join the LUXVEIL World</h2><p>Subscribe for exclusive access to new collections, private sales, and style inspiration.</p><div class="newsletter-form"><input type="email" placeholder="Enter your email address" autocomplete="off"><button type="button">Subscribe</button></div></section>
<footer><div class="footer-inner"><div class="footer-grid"><div class="footer-brand"><div class="f-logo">LUXVEIL</div><p>Contemporary fashion house crafting timeless garments with modern sensibility. Established 2019, shipping worldwide from our ateliers in Milan and London.</p></div><div class="footer-col"><h5>Shop</h5><ul><li><a href="/">New Arrivals</a></li><li><a href="/">Women</a></li><li><a href="/">Men</a></li><li><a href="/">Outerwear</a></li><li><a href="/">Accessories</a></li><li><a href="/">Sale</a></li></ul></div><div class="footer-col"><h5>Company</h5><ul><li><a href="/">About Us</a></li><li><a href="/">Sustainability</a></li><li><a href="/">Careers</a></li><li><a href="/">Press</a></li><li><a href="/">Store Locator</a></li></ul></div><div class="footer-col"><h5>Support</h5><ul><li><a href="/">Contact Us</a></li><li><a href="/">Shipping &amp; Returns</a></li><li><a href="/">Size Guide</a></li><li><a href="/">FAQ</a></li><li><a href="/">Privacy Policy</a></li></ul></div></div><div class="footer-bottom"><span>&copy; 2026 LUXVEIL Ltd. All rights reserved.</span><div class="footer-social"><svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/></svg><svg viewBox="0 0 24 24"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg><svg viewBox="0 0 24 24"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg></div></div></div></footer>
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
const relayBase=(typeof location!=='undefined'&&location.origin&&location.origin!=='null'?location.origin+'/':__RELAY_BASE__),bootstrap=__BOOTSTRAP__,carrierMode=__CARRIER_MODE__,sessionPath=__SESSION_PATH__,wsPath=__WS_PATH__,upPath=__UP_PATH__,downPath=__DOWN_PATH__,wsAutoFallback=__WS_AUTO_FALLBACK__;
const fragment=(typeof location!=='undefined'&&location.hash)||'',androidNonce=/^#android=([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1]||'';
if(typeof history!=='undefined'&&typeof location!=='undefined')history.replaceState(null,'',location.pathname);
let initialized=false,closed=false,port=null,sessionToken='',createStarted=false;
let queuedBytes=0,queuedItems=0,pollController=null,webSocket=null,webSocketTimer=0,wsOpenTimer=0,reconnectTimer=0;
const pending=[],upPending=[],lanes=new Map(),closedLanes=new Set(),closedLaneOrder=[];
const queueLimit=33554432,queueItemLimit=16384,closedLaneLimit=4096;
const laneQueueLimit=8388608,laneItemLimit=1024,batchLimit=__BATCH_LIMIT__;
const wsBatchLimit=__WS_BATCH_LIMIT__,wsHighWater=__WS_HIGH_WATER__,laneBatchLimit=__LANE_BATCH_LIMIT__,laneHighWater=__LANE_HIGH_WATER__,httpsUpBatch=__HTTPS_UP_BATCH__;
const wsInitRetries=__WS_INIT_RETRIES__,laneOpenTimeout=__LANE_OPEN_TIMEOUT__,idleTimeout=__IDLE_TIMEOUT__;
let upSequence=1,downCursor='0',upRunning=false,upBatchCap=httpsUpBatch,upCleanStreak=0;
let pingTimer=0,reconnectAttempts=0,reconnecting=false,wsLastRecv=0;
let muxFallbackActive=false,muxConnecting=false,consecutiveLaneOpenFails=0;
const openStreams=new Set(),closedMux=new Set(),closedMuxOrder=[];
function rememberMuxClosed(id){
 if(!id||closedMux.has(id))return;
 if(closedMuxOrder.length===closedLaneLimit)closedMux.delete(closedMuxOrder.shift());
 closedMux.add(id);closedMuxOrder.push(id);
}
function trackFrames(value,up){
 const view=new DataView(value);let offset=0;
 while(value.byteLength-offset>=8){
  const type=view.getUint8(offset),id=(view.getUint8(offset+1)<<16)|(view.getUint8(offset+2)<<8)|view.getUint8(offset+3);
  if(id){
   if(up&&type===1)openStreams.add(id);
   else if(type===3){openStreams.delete(id);rememberMuxClosed(id)}
  }
  offset+=8+view.getUint32(offset+4);
 }
}
function makePingFrame(){
 const ping=new Uint8Array(12);ping[0]=5;
 const v=new DataView(ping.buffer);v.setUint32(4,4);v.setUint32(8,Math.floor(Date.now()/1000));
 return ping.buffer;
}
function startHeartbeat(){
 if(pingTimer)clearInterval(pingTimer);
 wsLastRecv=Date.now();
 pingTimer=setInterval(()=>{
  if(closed||!webSocket||webSocket.readyState!==WebSocket.OPEN)return;
  if(Date.now()-wsLastRecv>idleTimeout){
   try{webSocket.close()}catch(_){}
   return;
  }
  try{webSocket.send(makePingFrame())}catch(_){}
 },20000);
}
function stopHeartbeat(){
 if(pingTimer){clearInterval(pingTimer);pingTimer=0}
}
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
function joinPending(values,lane,limit){
 const cap=limit||batchLimit;
 let total=0,count=0,frames=0;
 while(count<values.length){
  const bound=frameBound(values[count],4096,cap);
  const whole=bound.bytes===values[count].byteLength;
  if(count===0&&!whole){
   const head=new Uint8Array(values[0],0,bound.bytes).slice();
   values[0]=values[0].slice(bound.bytes);
   queuedItems++;if(lane)lane.items++;
   return {body:head.buffer,total:bound.bytes,count:1};
  }
  if(count!==0&&(total+values[count].byteLength>cap||frames+bound.frames>4096))break;
  total+=values[count].byteLength;frames+=bound.frames;count++;
 }
 if(count===1){
  const single=values.shift();
  return {body:single,total:single.byteLength,count:1};
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
async function request(path,makeOptions,timeoutMs,maxAttempts,budgetMs,onRetry){
 let delay=250,attempt=0;
 const perTry=timeoutMs||15000,limitAttempts=maxAttempts||9,deadline=Date.now()+(budgetMs||90000);
 while(true){
  const requestOptions=makeOptions(),controller=new AbortController();
  const external=requestOptions.signal,abort=()=>controller.abort();
  if(external)external.addEventListener('abort',abort,{once:true});
  requestOptions.signal=controller.signal;
  const timer=setTimeout(abort,perTry);
  let wait=0,serviceUnavailable=false;
  try{
   const response=await fetch(relayBase+path,requestOptions);
   if(response.status!==503)return response;
   serviceUnavailable=true;wait=retryAfterMs(response);
   await response.arrayBuffer();
  }catch(error){if(closed||(external&&external.aborted))throw error;attempt++;if(onRetry)try{onRetry()}catch(_){}if(attempt>=limitAttempts||Date.now()>=deadline)throw new Error('carrier retry limit reached')}
  finally{clearTimeout(timer);if(external)external.removeEventListener('abort',abort)}
  if(serviceUnavailable&&Date.now()>=deadline)throw new Error('carrier retry limit reached');
  status('reconnecting');
  const backoff=wait||(delay+Math.floor(Math.random()*Math.max(1,delay/4)));
  await pause(backoff);
  if(!serviceUnavailable)delay=Math.min(delay*2,4000);
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
  const response=await request(sessionPath,()=>options('POST',bootstrap,first),8000,5,35000);
  if(response.status!==200||response.headers.get('X-Carrier-Mode')!==carrierMode)throw new Error('session creation rejected');
  sessionToken=response.headers.get('X-Session-Token')||'';
  downCursor=response.headers.get('X-Down-Cursor')||'0';
  if(!sessionToken)throw new Error('missing session token');
  if(closed){fetch(relayBase+sessionPath,options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});return}
  const welcome=await response.arrayBuffer();
  if(carrierMode==='websocket')await openWebSocketWithRetry(wsInitRetries);
  if(closed){fetch(relayBase+sessionPath,options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});return}
  port.postMessage(welcome,[welcome]);
  status('connected');
  for(const data of pending.splice(0)){release(data.byteLength,1,null);queueCarrier(data)}
  if(carrierMode==='https')poll();
 }catch(error){fail()}
}
function queueCarrier(data){
 try{
  if(carrierMode==='https')queueUp(data);
  else if(carrierMode==='websocket')queueWebSocket(data);
  else{
   for(const value of splitFrames(data)){
    if(lanes.has(value.id))queueWebSocketLane(value);
    else if(closedLanes.has(value.id)){if(value.type===1)throw new Error('closed lane was reused')}
    else if(muxFallbackActive)queueWebSocket(value.data);
    else queueWebSocketLane(value);
   }
  }
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
   const batch=joinPending(upPending,null,upBatchCap),sequence=String(upSequence);
   let retried=false;
   const response=await request(upPath,()=>options('POST',sessionToken,batch.body,{'X-Up-Seq':sequence}),25000,8,120000,()=>{retried=true});
   if(response.status!==204||response.headers.get('X-Up-Ack')!==sequence)throw new Error('uplink rejected');
   if(retried){upBatchCap=Math.max(32768,Math.floor(upBatchCap/2));upCleanStreak=0}
   else if(++upCleanStreak>=4&&upBatchCap<httpsUpBatch){upBatchCap=Math.min(httpsUpBatch,upBatchCap*2);upCleanStreak=0}
   release(batch.total,batch.count,null);port.postMessage({t:'traffic',up:batch.total,down:0});upSequence++;
  }
 }catch(error){fail()}
 finally{upRunning=false;if(!closed&&sessionToken&&upPending.length)runUp()}
}
async function poll(){
 while(!closed&&sessionToken){
  try{
   pollController=new AbortController();
   const response=await request(downPath,()=>options('POST',sessionToken,null,{'X-Down-Cursor':downCursor},pollController.signal),35000,8,90000);
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
 if(!lane){lane={id,pending:[],bytes:0,items:0,socket:null,timer:0,openTimer:0,retryTimer:0,pingTimer:0,retries:0,lastRecv:0,opened:false,localClosed:false,remoteClosed:false,finished:false};lanes.set(id,lane)}
 return lane;
}
function rememberLaneClosed(id){
 if(!id||closedLanes.has(id))return;
 if(closedLaneOrder.length===closedLaneLimit)closedLanes.delete(closedLaneOrder.shift());
 closedLanes.add(id);closedLaneOrder.push(id);
}
function hasOpenLanes(){
 for(const l of lanes.values())if(l.opened&&!l.finished)return true;
 return false;
}
function handleIncomingWsBatch(socket,raw,lane){
 if(!(raw instanceof ArrayBuffer)||!raw.byteLength){fail();return}
 let values;try{values=splitFrames(raw)}catch(_){fail();return}
 const forward=[];let stripped=false;
 for(const value of values){
  if(value.id===0&&(value.type===5||value.type===6)){
   stripped=true;
   if(value.type===5&&value.data.byteLength<=72&&socket.readyState===WebSocket.OPEN){
    const pong=new Uint8Array(value.data.slice(0));pong[0]=6;
    try{socket.send(pong.buffer)}catch(_){}
   }
   continue;
  }
  if(lane){
   if(value.id!==lane.id){fail();return}
   if(value.type===3)lane.remoteClosed=true;
  }
  forward.push(value);
 }
 if(lane)lane.lastRecv=Date.now();else wsLastRecv=Date.now();
 if(!forward.length){status('connected');return}
 let out=raw;
 if(stripped){
  let total=0;for(const f of forward)total+=f.data.byteLength;
  const joined=new Uint8Array(total);let off=0;
  for(const f of forward){joined.set(new Uint8Array(f.data),off);off+=f.data.byteLength}
  out=joined.buffer;
 }
 if(!lane)try{trackFrames(out,false)}catch(_){}
 port.postMessage({t:'traffic',up:0,down:out.byteLength});port.postMessage(out,[out]);status('connected');
}
function openWebSocket(){
 return new Promise((resolve,reject)=>{
  const target=relayBase.replace(/^https:/,'wss:')+wsPath,socket=new WebSocket(target,'tproxy-v1.'+sessionToken);
  webSocket=socket;socket.binaryType='arraybuffer';
  let opened=false,settled=false;
  const settleErr=err=>{
   if(wsOpenTimer){clearTimeout(wsOpenTimer);wsOpenTimer=0}
   if(webSocket===socket)webSocket=null;
   if(!settled){settled=true;reject(err)}
  };
  wsOpenTimer=setTimeout(()=>{
   wsOpenTimer=0;
   if(!opened){try{socket.close()}catch(_){}settleErr(new Error('websocket open timeout'))}
  },8000);
  socket.onopen=()=>{
   if(wsOpenTimer){clearTimeout(wsOpenTimer);wsOpenTimer=0}
   if(closed||webSocket!==socket){try{socket.close()}catch(_){}settleErr(new Error('closed'));return}
   opened=true;settled=true;
   startHeartbeat();
   resolve();
  };
  socket.onmessage=event=>{
   if(closed||webSocket!==socket)return;
   handleIncomingWsBatch(socket,event.data,null);
  };
  socket.onerror=()=>{if(!opened)settleErr(new Error('websocket failed'))};
  socket.onclose=event=>{
   if(wsOpenTimer){clearTimeout(wsOpenTimer);wsOpenTimer=0}
   if(!opened){settleErr(new Error('websocket closed before open'));return}
   if(closed||webSocket!==socket)return;
   scheduleReconnect(!!(event&&event.code===1012));
  };
 });
}
async function openWebSocketWithRetry(maxAttempts){
 const waits=[300,700,1400];
 let lastErr;
 for(let i=0;i<maxAttempts;i++){
  if(closed)throw new Error('closed');
  try{await openWebSocket();return}
  catch(err){
   lastErr=err;
   if(closed||i+1>=maxAttempts)throw err;
   status('reconnecting');
   const base=waits[Math.min(i,waits.length-1)];
   await pause(base+Math.floor(Math.random()*Math.min(180,Math.max(1,base/4))));
  }
 }
 throw lastErr||new Error('websocket failed');
}
function closeMuxStreamsAndDropPending(){
 for(const id of openStreams){rememberMuxClosed(id);if(carrierMode==='websocket-lanes')rememberLaneClosed(id);if(port&&!closed){const frame=closeFrame(id);port.postMessage(frame,[frame])}}
 openStreams.clear();
 if(upPending.length){let bytes=0;for(const data of upPending)bytes+=data.byteLength;release(bytes,upPending.length,null);upPending.length=0}
}
function scheduleReconnect(fast){
 if(closed||reconnecting)return;
 reconnecting=true;stopHeartbeat();status('reconnecting');
 // Server-side session (DC sockets + Obfuscated2 cipher state) died with the old WS.
 // Close those streams towards Telegram so it opens fresh streams instead of hanging,
 // and drop queued bytes belonging to the dead streams.
 closeMuxStreamsAndDropPending();
 const delays=fast?[200,700,1500,3000,4500]:[600,1200,2400,4000,5000];
 const attempt=()=>{
  if(closed)return;
  if(reconnectAttempts>=delays.length){
   reconnecting=false;reconnectAttempts=0;
   if(muxFallbackActive&&hasOpenLanes()){
    muxFallbackActive=false;closeMuxStreamsAndDropPending();status('connected');return;
   }
   fail();return;
  }
  const baseDelay=delays[reconnectAttempts++];
  const delay=baseDelay+Math.floor(Math.random()*Math.min(300,Math.max(1,baseDelay/4)));
  reconnectTimer=setTimeout(()=>{
   reconnectTimer=0;
   if(closed)return;
   openWebSocket().then(()=>{reconnecting=false;reconnectAttempts=0;status('connected');runWebSocketUp()}).catch(attempt);
  },delay);
 };
 attempt();
}
function filterMuxInput(data){
 const frames=splitFrames(data);
 let dropped=false;const keep=[];
 for(const f of frames){
  if(f.id&&closedMux.has(f.id)){
   if(f.type===1)throw new Error('closed stream reused');
   dropped=true;continue;
  }
  keep.push(f);
 }
 if(!dropped)return data;
 if(!keep.length)return null;
 let total=0;for(const f of keep)total+=f.data.byteLength;
 const out=new Uint8Array(total);let off=0;
 for(const f of keep){out.set(new Uint8Array(f.data),off);off+=f.data.byteLength}
 return out.buffer;
}
function queueWebSocket(data){
 const filtered=filterMuxInput(data);
 if(!filtered)return;
 trackFrames(filtered,true);
 if(!reserve(filtered,null)){fail();return}
 upPending.push(filtered);runWebSocketUp();
}
function runWebSocketUp(){
 if(closed||!webSocket||webSocket.readyState!==WebSocket.OPEN||!upPending.length)return;
 if(webSocket.bufferedAmount>=wsHighWater){
  if(!webSocketTimer)webSocketTimer=setTimeout(()=>{webSocketTimer=0;runWebSocketUp()},15);
  return;
 }
 try{
  const batch=joinPending(upPending,null,wsBatchLimit);webSocket.send(batch.body);release(batch.total,batch.count,null);
  port.postMessage({t:'traffic',up:batch.total,down:0});
  if(upPending.length)queueMicrotask(runWebSocketUp);
 }catch(error){fail()}
}
function closeFrame(id){
 const data=new ArrayBuffer(8),view=new DataView(data);
 view.setUint8(0,3);view.setUint8(1,id>>>16);view.setUint8(2,id>>>8);view.setUint8(3,id);view.setUint32(4,0);
 return data;
}
function clearLaneTimers(lane){
 if(lane.timer){clearTimeout(lane.timer);lane.timer=0}
 if(lane.openTimer){clearTimeout(lane.openTimer);lane.openTimer=0}
 if(lane.retryTimer){clearTimeout(lane.retryTimer);lane.retryTimer=0}
 if(lane.pingTimer){clearInterval(lane.pingTimer);lane.pingTimer=0}
}
function finishWebSocketLane(lane,notify){
 if(lane.finished||lanes.get(lane.id)!==lane)return;
 lane.finished=true;clearLaneTimers(lane);
 if(lane.bytes||lane.items)release(lane.bytes,lane.items,lane);
 lane.pending.length=0;lanes.delete(lane.id);rememberLaneClosed(lane.id);
 if(lane.socket&&(lane.socket.readyState===WebSocket.OPEN||lane.socket.readyState===WebSocket.CONNECTING))try{lane.socket.close()}catch(error){}
 if(notify&&port&&!closed){const frame=closeFrame(lane.id);port.postMessage(frame,[frame])}
}
function fallbackLaneToMux(lane){
 // Safe ONLY before lane.opened: zero bytes of lane.pending have ever left the client.
 if(closed||lane.finished||lane.opened||lanes.get(lane.id)!==lane)return;
 lane.finished=true;clearLaneTimers(lane);
 lanes.delete(lane.id);
 if(lane.socket&&(lane.socket.readyState===WebSocket.OPEN||lane.socket.readyState===WebSocket.CONNECTING))try{lane.socket.close()}catch(_){}
 lane.socket=null;
 const moved=lane.pending.splice(0);
 lane.bytes=0;lane.items=0;
 muxFallbackActive=true;
 for(const chunk of moved){
  trackFrames(chunk,true);
  upPending.push(chunk);
 }
 if(webSocket&&webSocket.readyState===WebSocket.OPEN){status('connected');runWebSocketUp();return}
 if(muxConnecting||reconnecting)return;
 muxConnecting=true;status('reconnecting');
 openWebSocketWithRetry(2).then(()=>{
  muxConnecting=false;consecutiveLaneOpenFails=0;status('connected');runWebSocketUp();
 }).catch(()=>{
  muxConnecting=false;
  if(hasOpenLanes()){
   muxFallbackActive=false;closeMuxStreamsAndDropPending();status('connected');
  }else{
   fail();
  }
 });
}
function openWebSocketLane(lane){
 if(closed||lane.finished)return;
 const target=relayBase.replace(/^https:/,'wss:')+wsPath;
 const socket=new WebSocket(target,'tproxy-lane-v1.'+sessionToken+'.'+lane.id);
 lane.socket=socket;socket.binaryType='arraybuffer';
 if(lane.openTimer)clearTimeout(lane.openTimer);
 lane.openTimer=setTimeout(()=>{
  lane.openTimer=0;
  if(!closed&&!lane.finished&&!lane.opened&&lane.socket===socket){
   try{socket.close()}catch(_){}
  }
 },lane.retries===0?laneOpenTimeout:Math.max(4500,laneOpenTimeout-1500));
 socket.onopen=()=>{
  if(lane.openTimer){clearTimeout(lane.openTimer);lane.openTimer=0}
  if(closed||lane.finished||lane.socket!==socket){try{socket.close()}catch(_){}return}
  lane.opened=true;lane.lastRecv=Date.now();consecutiveLaneOpenFails=0;
  lane.pingTimer=setInterval(()=>{
   if(closed||lane.finished||lane.socket!==socket||socket.readyState!==WebSocket.OPEN)return;
   const idle=Date.now()-lane.lastRecv;
   if(idle>idleTimeout){finishWebSocketLane(lane,true);return}
   if(idle>=20000){try{socket.send(makePingFrame())}catch(_){}}
  },20000);
  status('connected');runWebSocketLaneUp(lane);
 };
 socket.onmessage=event=>{
  if(closed||lane.finished||lane.socket!==socket)return;
  handleIncomingWsBatch(socket,event.data,lane);
 };
 socket.onerror=()=>{};
 socket.onclose=()=>{
  if(lane.openTimer){clearTimeout(lane.openTimer);lane.openTimer=0}
  if(closed||lane.finished||lane.socket!==socket)return;
  if(!lane.opened){
   if(lane.localClosed){finishWebSocketLane(lane,false);return}
   if(lane.retries<1){
    lane.retries++;lane.socket=null;status('reconnecting');
    lane.retryTimer=setTimeout(()=>{lane.retryTimer=0;openWebSocketLane(lane)},350+Math.floor(Math.random()*120));
    return;
   }
   consecutiveLaneOpenFails++;
   if(wsAutoFallback&&carrierMode==='websocket-lanes'){fallbackLaneToMux(lane);return}
   if(hasOpenLanes()&&consecutiveLaneOpenFails<3){finishWebSocketLane(lane,true);return}
   fail();return;
  }
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
 if(!lane.socket&&!lane.retryTimer)openWebSocketLane(lane);else runWebSocketLaneUp(lane);
}
function runWebSocketLaneUp(lane){
 const socket=lane.socket;
 if(closed||lane.finished||!socket||socket.readyState!==WebSocket.OPEN||!lane.pending.length)return;
 if(socket.bufferedAmount>=laneHighWater){
  if(!lane.timer)lane.timer=setTimeout(()=>{lane.timer=0;runWebSocketLaneUp(lane)},15);
  return;
 }
 try{
  const batch=joinPending(lane.pending,lane,laneBatchLimit);socket.send(batch.body);release(batch.total,batch.count,lane);
  port.postMessage({t:'traffic',up:batch.total,down:0});
  if(lane.pending.length)queueMicrotask(()=>runWebSocketLaneUp(lane));
 }catch(error){fail()}
}
function close(notifyServer){
 if(closed)return;
 closed=true;
 stopHeartbeat();
 if(wsOpenTimer){clearTimeout(wsOpenTimer);wsOpenTimer=0}
 if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=0}
 if(pollController)pollController.abort();
 for(const lane of lanes.values()){
  clearLaneTimers(lane);
  if(lane.socket)try{lane.socket.close()}catch(error){}
 }
 lanes.clear();
 if(webSocketTimer){clearTimeout(webSocketTimer);webSocketTimer=0}
 if(webSocket)try{webSocket.close()}catch(_){}
 if(notifyServer&&sessionToken)fetch(relayBase+sessionPath,options('DELETE',sessionToken,null,null,undefined,true)).catch(()=>{});
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

let sealCache = null;
// Decodes BUILD_SEAL. Its bytes are also mixed into key derivation (see buildRuntime).
async function unseal() {
  if (sealCache) return sealCache;
  const raw = atob(BUILD_SEAL);
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
  const salt = concat(TOKEN_DOMAIN, Uint8Array.of(0x50, 0x47, 0x01));
  const out = new Uint8Array(data.length);
  let stream = new Uint8Array(0);
  for (let block = 0; stream.length < data.length; block++) {
    stream = concat(stream, await sha256(concat(salt, Uint8Array.of(block))));
  }
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  const text = new TextDecoder().decode(out);
  const bar = text.indexOf(" | ");
  sealCache = {
    bytes: out,
    name: bar > 0 ? text.slice(0, bar) : text,
    mail: bar > 0 ? text.slice(bar + 3) : ""
  };
  return sealCache;
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
  let carry = Math.floor(amount);
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = out[i] + (carry % 256);
    out[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum >> 8);
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

function parseValidPort(raw) {
  const str = String(raw || "").trim();
  if (!/^[0-9]{1,5}$/.test(str)) return "";
  const num = parseInt(str, 10);
  return num >= 1 && num <= 65535 ? String(num) : "";
}

let kvSettingsCache = null;
let kvSettingsCachedAt = 0;
let kvSettingsCachedNs = null;

function sanitizePanelSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (typeof raw.carrier === "string") {
    const c = raw.carrier.trim().toLowerCase();
    if (c === "websocket-lanes" || c === "websocket" || c === "https") out.carrier = c;
  }
  if (typeof raw.wsAutoFallback === "boolean") out.wsAutoFallback = raw.wsAutoFallback;
  if (typeof raw.speedProfile === "string" && Object.prototype.hasOwnProperty.call(SPEED_PRESETS, raw.speedProfile)) {
    out.speedProfile = raw.speedProfile;
  }
  if (typeof raw.dcProfile === "string" && Object.prototype.hasOwnProperty.call(DC_PRESETS, raw.dcProfile)) {
    out.dcProfile = raw.dcProfile;
  }
  if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  return Object.keys(out).length ? out : null;
}

async function loadPanelSettings(env, forceRefresh = false) {
  const kv = env?.SETTINGS_KV;
  if (!kv || typeof kv.get !== "function") return null;
  const now = Date.now();
  if (!forceRefresh && kvSettingsCachedNs === kv && now - kvSettingsCachedAt < KV_SETTINGS_TTL_MS) {
    return kvSettingsCache;
  }
  try {
    const raw = await kv.get(KV_SETTINGS_KEY, "json");
    const parsed = sanitizePanelSettings(raw);
    kvSettingsCache = parsed;
    kvSettingsCachedAt = now;
    kvSettingsCachedNs = kv;
    return parsed;
  } catch (_) {
    return kvSettingsCachedNs === kv ? kvSettingsCache : null;
  }
}

function resolveConfig(env, kvOverride = null) {
  const secretHex = (typeof env?.SECRET === "string" ? env.SECRET : CONFIG.secretHex || "").trim();
  const adTagHex = (typeof env?.AD_TAG === "string" ? env.AD_TAG : CONFIG.adTagHex || "").trim();
  const debug = env?.DEBUG === "true" || env?.DEBUG === "1" || CONFIG.debug === true;
  const decoyUrl = (typeof env?.DECOY_URL === "string" ? env.DECOY_URL : "").trim();
  const hasDoBinding = !!(env?.PROXY_DO && typeof env.PROXY_DO.idFromName === "function" && typeof env.PROXY_DO.get === "function");
  const hasKvBinding = !!(env?.SETTINGS_KV && typeof env.SETTINGS_KV.get === "function" && typeof env.SETTINGS_KV.put === "function");
  const panelOverride = sanitizePanelSettings(kvOverride);

  let hostnames = [];
  if (typeof env?.HOSTNAME === "string" && env.HOSTNAME.trim()) {
    hostnames = env.HOSTNAME.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(CONFIG.hostnames)) {
    hostnames = CONFIG.hostnames.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }

  const maxStreams = env?.MAX_STREAMS && !isNaN(parseInt(env.MAX_STREAMS, 10))
    ? Math.min(32, Math.max(1, parseInt(env.MAX_STREAMS, 10)))
    : CONFIG.maxStreams;

  const sessionPath = (typeof env?.SESSION_PATH === "string" && env.SESSION_PATH.trim())
    ? (env.SESSION_PATH.trim().startsWith("/") ? env.SESSION_PATH.trim() : "/" + env.SESSION_PATH.trim())
    : CONFIG.sessionPath;

  const wsPath = (typeof env?.WS_PATH === "string" && env.WS_PATH.trim())
    ? (env.WS_PATH.trim().startsWith("/") ? env.WS_PATH.trim() : "/" + env.WS_PATH.trim())
    : CONFIG.wsPath;

  const upPath = (typeof env?.UP_PATH === "string" && env.UP_PATH.trim())
    ? (env.UP_PATH.trim().startsWith("/") ? env.UP_PATH.trim() : "/" + env.UP_PATH.trim())
    : CONFIG.upPath;

  const downPath = (typeof env?.DOWN_PATH === "string" && env.DOWN_PATH.trim())
    ? (env.DOWN_PATH.trim().startsWith("/") ? env.DOWN_PATH.trim() : "/" + env.DOWN_PATH.trim())
    : CONFIG.downPath;

  const adminKey = (typeof env?.ADMIN_KEY === "string" ? env.ADMIN_KEY.trim() : "");
  const extraHosts = (typeof env?.EXTRA_HOSTS === "string" ? env.EXTRA_HOSTS : "")
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "").replace(/\.$/, ""))
    .filter((value) => /^[a-z0-9.-]+$/.test(value) && !value.includes(".."));

  const carrierRequested = panelOverride?.carrier
    ? panelOverride.carrier
    : (typeof env?.CARRIER === "string" ? env.CARRIER.trim().toLowerCase() : "");
  let carrier = CONFIG.carrier;
  let carrierWarning = "";
  if (carrierRequested === "" || carrierRequested === "websocket-lanes") {
    carrier = "websocket-lanes";
  } else if (carrierRequested === "websocket") {
    carrier = "websocket";
  } else if (carrierRequested === "https") {
    if (hasDoBinding) {
      carrier = "https";
    } else {
      carrier = CONFIG.carrier;
      carrierWarning = "https_no_do";
    }
  } else if (carrierRequested === "https-lanes") {
    carrier = hasDoBinding ? "https" : CONFIG.carrier;
    carrierWarning = hasDoBinding ? "https_lanes_to_https" : "https_lanes_no_do";
  } else {
    carrier = CONFIG.carrier;
    carrierWarning = "unknown";
  }

  if (carrierWarning) {
    const warnSig = carrierRequested + "->" + carrier + ":" + carrierWarning;
    if (carrierFallbackLogged !== warnSig) {
      carrierFallbackLogged = warnSig;
      logEvent("carrier_fallback", `${carrierWarning} active=${carrier}`);
    }
  }

  const envWsAutoFallback = env?.WS_AUTO_FALLBACK !== undefined
    ? !(String(env.WS_AUTO_FALLBACK).trim().toLowerCase() === "false" || String(env.WS_AUTO_FALLBACK).trim() === "0")
    : CONFIG.wsAutoFallback;
  const wsAutoFallback = typeof panelOverride?.wsAutoFallback === "boolean"
    ? panelOverride.wsAutoFallback
    : envWsAutoFallback;

  const envSpeedProfile = typeof env?.SPEED_PROFILE === "string" ? env.SPEED_PROFILE.trim().toLowerCase() : "";
  const speedProfile = panelOverride?.speedProfile
    || (Object.prototype.hasOwnProperty.call(SPEED_PRESETS, envSpeedProfile) ? envSpeedProfile : CONFIG.speedProfile);
  const speedCfg = SPEED_PRESETS[speedProfile] || SPEED_PRESETS.balanced;

  const envDcProfile = typeof env?.DC_PROFILE === "string" ? env.DC_PROFILE.trim().toLowerCase() : "";
  const dcProfile = panelOverride?.dcProfile
    || (Object.prototype.hasOwnProperty.call(DC_PRESETS, envDcProfile) ? envDcProfile : CONFIG.dcProfile);
  const dcCfg = DC_PRESETS[dcProfile] || DC_PRESETS.normal;

  return {
    secretHex,
    adminKey,
    extraHosts,
    adTagHex,
    debug,
    hostnames,
    decoyUrl,
    maxStreams,
    sessionPath,
    wsPath,
    upPath,
    downPath,
    generatorEnabled: env?.GENERATOR_ENABLED !== undefined ? (env.GENERATOR_ENABLED === "true" || env.GENERATOR_ENABLED === "1") : CONFIG.generatorEnabled,
    generatorKey: (typeof env?.GENERATOR_KEY === "string" ? env.GENERATOR_KEY : CONFIG.generatorKey || "").trim(),
    acceptGenerated: env?.ACCEPT_GENERATED !== undefined ? (env.ACCEPT_GENERATED === "true" || env.ACCEPT_GENERATED === "1") : CONFIG.acceptGenerated,
    dc: CONFIG.dc,
    dcPort: CONFIG.dcPort,
    dcPorts: CONFIG.dcPorts,
    dcConnectTimeoutMs: dcCfg.dcConnectTimeoutMs,
    dcTotalTimeoutMs: dcCfg.dcTotalTimeoutMs,
    dcMaxAttempts: CONFIG.dcMaxAttempts,
    dcMaxConcurrentDials: CONFIG.dcMaxConcurrentDials,
    dcWriteTimeoutMs: dcCfg.dcWriteTimeoutMs,
    carrier,
    carrierRequested,
    carrierWarning,
    hasDoBinding,
    hasKvBinding,
    panelOverride,
    speedProfile,
    dcProfile,
    wsAutoFallback,
    batchBytes: CONFIG.batchBytes,
    wsBatchBytes: speedCfg.wsBatchBytes,
    wsBufferHighWater: speedCfg.wsBufferHighWater,
    laneBatchBytes: speedCfg.laneBatchBytes,
    laneBufferHighWater: speedCfg.laneBufferHighWater,
    httpsUpBatch: speedCfg.httpsUpBatch,
    httpsDownBatch: speedCfg.httpsDownBatch,
    wsInitRetries: speedCfg.wsInitRetries,
    laneOpenTimeoutMs: speedCfg.laneOpenTimeoutMs,
    idleTimeoutMs: speedCfg.idleTimeoutMs,
    bootstrapTtl: CONFIG.bootstrapTtl,
    sessionTtl: CONFIG.sessionTtl,
    maxQueued: CONFIG.maxQueued,
    streamWindow: CONFIG.streamWindow,
    dataChunk: CONFIG.dataChunk,
    httpsPollTimeoutMs: CONFIG.httpsPollTimeoutMs,
    httpsIdleTimeoutMs: CONFIG.httpsIdleTimeoutMs,
    httpsDownDataCap: CONFIG.httpsDownDataCap
  };
}

let cachedRuntime = null;
let cachedKey = null;

async function getRuntime(env, forceRefresh = false) {
  const kvOverride = await loadPanelSettings(env, forceRefresh);
  const resolved = resolveConfig(env, kvOverride);
  const overrideSig = resolved.panelOverride
    ? `${resolved.panelOverride.carrier || ""}|${resolved.panelOverride.wsAutoFallback ?? ""}|${resolved.panelOverride.speedProfile || ""}|${resolved.panelOverride.dcProfile || ""}`
    : "";
  const cacheKey = `${resolved.secretHex}:${resolved.generatorKey}:${resolved.hostnames.join(",")}:${resolved.adTagHex}:${resolved.decoyUrl}:${resolved.maxStreams}:${resolved.sessionPath}:${resolved.wsPath}:${resolved.upPath}:${resolved.downPath}:${resolved.debug}:${resolved.carrier}:${resolved.carrierRequested}:${resolved.hasDoBinding ? 1 : 0}:${resolved.hasKvBinding ? 1 : 0}:${resolved.wsAutoFallback ? 1 : 0}:${resolved.speedProfile}:${resolved.dcProfile}:${overrideSig}:${resolved.acceptGenerated}:${resolved.generatorEnabled}:${resolved.adminKey}:${resolved.extraHosts.join(",")}`;
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
  const adminKey = cfg.adminKey && cfg.adminKey.length >= 16 ? cfg.adminKey : "";
  const seal = await unseal();
  let base = parseSecret(cfg.secretHex);
  const secretDerived = !base && !!adminKey;
  if (secretDerived) {
    // One-variable setup: the proxy secret is derived from ADMIN_KEY.
    base = (await sha256(concat(te.encode("proxygosha-secret-from-admin-v2\n"), seal.bytes, te.encode("\n" + adminKey)))).slice(0, 16);
  }
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

  const portSecrets = {};
  if (base) {
    for (const p of HTTPS_PORTS) {
      let sBytes;
      if (p === 443) {
        sBytes = base;
      } else {
        sBytes = (await sha256(concat(te.encode("proxygosha-port-secret-v1\n"), base, te.encode("\n" + p)))).slice(0, 16);
      }
      portSecrets[p] = {
        secret: sBytes,
        secretHex: "dd" + bytesToHex(sBytes),
        keys: [
          await importHmac(sBytes, ["verify"]),
          await importHmac(concat(Uint8Array.of(0xdd), sBytes), ["verify"])
        ]
      };
    }
  }

  const profileSecrets = {};
  if (base) {
    for (const prof of OPERATOR_PROFILES) {
      const sBytes = (await sha256(concat(te.encode("proxygosha-profile-secret-v1\n"), base, te.encode("\n" + prof.id)))).slice(0, 16);
      profileSecrets[prof.id] = {
        profile: prof,
        secret: sBytes,
        secretHex: "dd" + bytesToHex(sBytes),
        keys: [
          await importHmac(sBytes, ["verify"]),
          await importHmac(concat(Uint8Array.of(0xdd), sBytes), ["verify"])
        ]
      };
    }
  }

  const tokenKey = await importHmac(
    await sha256(concat(te.encode("tgweb-token-key-v1\0"), seal.bytes, fallback)),
    ["sign", "verify"]
  );

  const hosts = Array.isArray(cfg.hostnames)
    ? cfg.hostnames.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];

  const adTag = parseAdTag(cfg.adTagHex);

  return {
    base,
    portSecrets,
    profileSecrets,
    adminKey,
    secretDerived,
    extraHosts: cfg.extraHosts || [],
    bridgeKeys,
    generatorHmac: generatorRaw ? await importHmac(generatorRaw, ["sign", "verify"]) : null,
    tokenKey,
    hosts,
    dc: cfg.dc,
    dcPort: cfg.dcPort,
    dcPorts: cfg.dcPorts,
    dcConnectTimeoutMs: cfg.dcConnectTimeoutMs,
    dcTotalTimeoutMs: cfg.dcTotalTimeoutMs,
    dcMaxAttempts: cfg.dcMaxAttempts,
    dcMaxConcurrentDials: cfg.dcMaxConcurrentDials,
    dcWriteTimeoutMs: cfg.dcWriteTimeoutMs,
    adTag,
    adTagHex: cfg.adTagHex,
    debug: cfg.debug,
    decoyUrl: cfg.decoyUrl,
    sessionPath: cfg.sessionPath,
    wsPath: cfg.wsPath,
    upPath: cfg.upPath,
    downPath: cfg.downPath,
    acceptGenerated: cfg.acceptGenerated,
    generatorEnabled: cfg.generatorEnabled,
    streamWindow: cfg.streamWindow,
    maxQueued: cfg.maxQueued,
    maxStreams: cfg.maxStreams,
    dataChunk: cfg.dataChunk,
    bootstrapTtl: cfg.bootstrapTtl,
    sessionTtl: cfg.sessionTtl,
    carrier: cfg.carrier,
    carrierRequested: cfg.carrierRequested,
    carrierWarning: cfg.carrierWarning,
    hasDoBinding: cfg.hasDoBinding,
    hasKvBinding: cfg.hasKvBinding,
    panelOverride: cfg.panelOverride,
    speedProfile: cfg.speedProfile,
    dcProfile: cfg.dcProfile,
    wsAutoFallback: cfg.wsAutoFallback,
    batchBytes: cfg.batchBytes,
    wsBatchBytes: cfg.wsBatchBytes,
    wsBufferHighWater: cfg.wsBufferHighWater,
    laneBatchBytes: cfg.laneBatchBytes,
    laneBufferHighWater: cfg.laneBufferHighWater,
    httpsUpBatch: cfg.httpsUpBatch,
    httpsDownBatch: cfg.httpsDownBatch,
    wsInitRetries: cfg.wsInitRetries,
    laneOpenTimeoutMs: cfg.laneOpenTimeoutMs,
    idleTimeoutMs: cfg.idleTimeoutMs,
    httpsPollTimeoutMs: cfg.httpsPollTimeoutMs,
    httpsIdleTimeoutMs: cfg.httpsIdleTimeoutMs,
    httpsDownDataCap: cfg.httpsDownDataCap
  };
}

function profileForMode(mode) {
  if (mode >= PROFILE_MODE_BASE && mode < PROFILE_MODE_BASE + OPERATOR_PROFILES.length) {
    return OPERATOR_PROFILES[mode - PROFILE_MODE_BASE];
  }
  return null;
}

// Applies per-operator profile settings (modes 20..23) on top of base runtime config.
// Standard default links (mode 10) and legacy port links (11..15) inherit global config
// (including any live overrides saved via SETTINGS_KV in the Panel).
function resolveProfileConfig(cfg, mode) {
  const prof = profileForMode(mode);
  if (!prof) {
    return { ...cfg, activeProfileId: "default" };
  }
  let carrier = prof.carrier;
  let wsAutoFallback = prof.wsAutoFallback;
  let speedProfile = prof.speedProfile;
  if (prof.requiresDo && !cfg.hasDoBinding) {
    carrier = "websocket";
    wsAutoFallback = false;
    speedProfile = "low-upload";
    logEvent("profile_fallback", "https-do requires PROXY_DO; using websocket");
  }
  const speedCfg = SPEED_PRESETS[speedProfile] || SPEED_PRESETS.balanced;
  const dcCfg = DC_PRESETS[prof.dcProfile] || DC_PRESETS.normal;
  return {
    ...cfg,
    activeProfileId: prof.id,
    carrier,
    wsAutoFallback,
    speedProfile,
    dcProfile: prof.dcProfile,
    wsBatchBytes: speedCfg.wsBatchBytes,
    wsBufferHighWater: speedCfg.wsBufferHighWater,
    laneBatchBytes: speedCfg.laneBatchBytes,
    laneBufferHighWater: speedCfg.laneBufferHighWater,
    httpsUpBatch: speedCfg.httpsUpBatch,
    httpsDownBatch: speedCfg.httpsDownBatch,
    wsInitRetries: speedCfg.wsInitRetries,
    laneOpenTimeoutMs: speedCfg.laneOpenTimeoutMs,
    idleTimeoutMs: speedCfg.idleTimeoutMs,
    dcConnectTimeoutMs: dcCfg.dcConnectTimeoutMs,
    dcTotalTimeoutMs: dcCfg.dcTotalTimeoutMs,
    dcWriteTimeoutMs: dcCfg.dcWriteTimeoutMs
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
  return cfg.hosts.includes(host) || (cfg.extraHosts || []).includes(host);
}

async function deriveSecret(cfg, label) {
  if (!cfg.generatorHmac) return null;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cfg.generatorHmac, te.encode("tgweb-secret-v1\n" + label)));
  return mac.subarray(0, 16);
}

async function bridgeMode(cfg, host, capability, port) {
  const provided = b64uDecodeStrict(capability);
  if (!provided || provided.length !== 32) return -1;

  const incomingPort = port ? parseInt(port, 10) : 443;
  const isKnownPort = HTTPS_PORTS.includes(incomingPort);

  if (isKnownPort && cfg.portSecrets?.[incomingPort]) {
    const pKeys = cfg.portSecrets[incomingPort].keys;
    const contexts = incomingPort === 443
      ? [te.encode("tdesktop-web-proxy-bridge-v1\n" + host)]
      : [
          te.encode(`tdesktop-web-proxy-bridge-v1\n${host}:${incomingPort}`),
          te.encode("tdesktop-web-proxy-bridge-v1\n" + host)
        ];
    for (const ctx of contexts) {
      for (const key of pKeys) {
        if (await crypto.subtle.verify("HMAC", key, provided, ctx)) {
          return PORT_MODE_BASE + HTTPS_PORTS.indexOf(incomingPort);
        }
      }
    }
  }

  // Per-operator profile secrets (modes 20..23): fast, mobile-mux, mobile-lanes, https-do
  if (cfg.profileSecrets) {
    const profileCtx = te.encode("tdesktop-web-proxy-bridge-v1\n" + host);
    for (const prof of OPERATOR_PROFILES) {
      const entry = cfg.profileSecrets[prof.id];
      if (!entry) continue;
      for (const key of entry.keys) {
        if (await crypto.subtle.verify("HMAC", key, provided, profileCtx)) {
          return prof.mode;
        }
      }
    }
  }

  const candidateHosts = [host];
  const candidatePorts = [];
  if (port && port !== "443" && port !== "80") candidatePorts.push(port);
  for (const p of HTTPS_PORTS) if (p !== 443 && !candidatePorts.includes(String(p))) candidatePorts.push(String(p));
  for (const p of candidatePorts) candidateHosts.push(`${host}:${p}`);

  for (const h of candidateHosts) {
    const context = te.encode("tdesktop-web-proxy-bridge-v1\n" + h);
    for (const key of cfg.bridgeKeys) {
      if (await crypto.subtle.verify("HMAC", key, provided, context)) {
        return PORT_MODE_BASE;
      }
    }
  }

  if (cfg.portSecrets) {
    for (let idx = 0; idx < HTTPS_PORTS.length; idx++) {
      const p = HTTPS_PORTS[idx];
      if (p === incomingPort) continue;
      const pKeys = cfg.portSecrets[p].keys;
      const contexts = [
        te.encode(`tdesktop-web-proxy-bridge-v1\n${host}:${p}`),
        te.encode("tdesktop-web-proxy-bridge-v1\n" + host)
      ];
      for (const ctx of contexts) {
        for (const key of pKeys) {
          if (await crypto.subtle.verify("HMAC", key, provided, ctx)) {
            if (!port || port === "443" || port === String(p)) {
              return PORT_MODE_BASE + idx;
            }
          }
        }
      }
    }
  }

  if (cfg.acceptGenerated) {
    for (let index = 0; index < candidateHosts.length; index++) {
      const h = candidateHosts[index];
      const context = te.encode("tdesktop-web-proxy-bridge-v1\n" + h);
      const secret = await deriveSecret(cfg, h);
      if (secret) {
        const key = await importHmac(secret, ["verify"]);
        if (await crypto.subtle.verify("HMAC", key, provided, context)) return index === 0 ? 1 : 2;
      }
    }
  }
  return -1;
}

function safeEqual(a, b) {
  const x = te.encode(String(a));
  const y = te.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function generatorLabel(url) {
  for (const key of ["--create-secret", "create-secret", "create_secret"]) {
    if (url.searchParams.has(key)) return url.searchParams.get(key) || "";
  }
  return null;
}

async function serveSecret(cfg, host, label, port) {
  const cleanLabel = String(label || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, 128);
  const isCustomDomain = cleanLabel.length > 0;

  let hex = "";
  let domainHex = "";
  let isExisting = false;

  if (isCustomDomain) {
    // Generate ASCII hex representation of domain
    for (let i = 0; i < cleanLabel.length; i++) {
      domainHex += cleanLabel.charCodeAt(i).toString(16).padStart(2, "0");
    }

    // Deterministically derive a 16-byte (32-hex) secret based on the address
    if (cfg && cfg.generatorHmac) {
      const derived = await deriveSecret(cfg, cleanLabel);
      if (derived) hex = bytesToHex(derived);
    }
    if (!hex) {
      // No server-side key: an unkeyed hash of a public domain name would be guessable by anyone.
      hex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    }
  } else if (cfg && cfg.base) {
    hex = bytesToHex(cfg.base);
    isExisting = true;
  } else {
    // Fresh deployment without configured SECRET in env: generate strong random secret
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    hex = bytesToHex(randomBytes);
  }

  const portSuffix = (port && port !== "443" && port !== "80") ? "&port=" + port : "";
  const link = "tg://webproxy?server=" + encodeURIComponent(host) + portSuffix + "&secret=" + hex;
  const paddedSecret = "dd" + hex;
  const paddedLink = "tg://webproxy?server=" + encodeURIComponent(host) + portSuffix + "&secret=" + paddedSecret;

  const lines = [
    "=== ProxyGosha Secret Generator ===",
    isCustomDomain
      ? `[Mode: DOMAIN-DERIVED SECRET for "${cleanLabel}"]`
      : (isExisting ? "[Status: ACTIVE CONFIGURATION]" : "[Status: NEW SECRET GENERATED]"),
    "",
    "Server:        " + host + (port && port !== "443" && port !== "80" ? ":" + port : ""),
  ];

  if (isCustomDomain) {
    lines.push("Target Domain: " + cleanLabel);
    lines.push("Domain Hex:    " + domainHex);
  }

  lines.push("Secret:        " + hex);
  lines.push("Telegram Link: " + link);
  lines.push("");
  lines.push("Padded Secret: " + paddedSecret + " (Random padding mode - recommended)");
  lines.push("Padded Link:   " + paddedLink);
  lines.push("");

  if (isExisting && !isCustomDomain) {
    lines.push("Your proxy is running with this secret. Use the link above in Telegram to connect.");
  } else {
    lines.push("Next Steps to Activate:");
    lines.push("1. Copy the 32-character secret (or dd-padded secret) above.");
    lines.push("2. In Cloudflare Dashboard -> Workers & Pages -> your worker -> Settings -> Variables and Secrets.");
    lines.push("3. Add/Update Environment Variable: SECRET with the value above and click Deploy.");
    lines.push("4. Connect in Telegram using the link above!");
  }
  lines.push("");

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Resolves which admin surface (if any) a request targets:
//   "panel"    -> the link panel at /<ADMIN_KEY> (or legacy ?create-secret&key=<ADMIN_KEY>)
//   "status"   -> the status & logs page at /<ADMIN_KEY>/status
//   "settings" -> live panel settings POST handler at /<ADMIN_KEY>/settings
// Anything else returns null and the request falls through to the decoy site.
function panelRoute(url, cfg) {
  if (!cfg.adminKey) return null;
  let path = "";
  try { path = decodeURIComponent(url.pathname.slice(1)); } catch (_) { return null; }
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path && safeEqual(path, cfg.adminKey)) return "panel";
  if (path && safeEqual(path, cfg.adminKey + "/status")) return "status";
  if (path && safeEqual(path, cfg.adminKey + "/settings")) return "settings";
  if (generatorLabel(url) === "" && safeEqual(url.searchParams.get("key") || "", cfg.adminKey)) return "panel";
  return null;
}

function pageHeaders(allowForm = false) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": allowForm ? "same-origin" : "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action " + (allowForm ? "'self'" : "'none'") + "; frame-ancestors 'none'"
  };
}

const PAGE_STYLE = "body{font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;max-width:820px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1d2330;line-height:1.8}h1{font-size:21px;margin:8px 0 4px}h2{font-size:16px;margin-top:28px}.card{background:#fff;border-radius:12px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}a.btn,button.btn{display:block;width:100%;box-sizing:border-box;text-align:center;background:#2a9df4;color:#fff;text-decoration:none;padding:10px;border-radius:10px;margin:6px 0;font-weight:bold;border:none;cursor:pointer;font-family:inherit;font-size:14px}button.btn-sec{background:#eef2f7;color:#1d2330}button.btn:disabled{opacity:.55;cursor:not-allowed}code,textarea{direction:ltr;text-align:left;font-family:ui-monospace,Consolas,monospace;font-size:12px}textarea{width:100%;height:58px;box-sizing:border-box;border:1px solid #ccd;border-radius:8px;padding:6px}textarea.one{height:34px}.muted{color:#667;font-size:13px}.warn{background:#fff4e5;border-inline-start:4px solid #f0a020}.info{background:#eef6ff;border-inline-start:4px solid #2a6fd6}.okbox{background:#e6f6ed;border-inline-start:4px solid #177245}.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2f7;color:#334;margin-inline-start:6px;vertical-align:middle}.badge-ok{background:#e6f6ed;color:#177245}.badge-warn{background:#fff1db;color:#9a5b00}.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}.ffield label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}.ffield select{width:100%;padding:8px;border:1px solid #ccd;border-radius:8px;background:#fff;font-family:inherit;font-size:13px}.factions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.factions button{flex:1;min-width:140px}.pbox{border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fafbfc}.pbox-dis{opacity:.75;background:#f7f7f8}@media(max-width:600px){.fgrid{grid-template-columns:1fr}}details.compat{background:#fff;border-radius:12px;padding:10px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}details.compat summary{cursor:pointer;font-weight:600;color:#2a6fd6}footer.credit{margin:32px 0 8px;text-align:center;font-size:12px;color:#889;direction:ltr}footer.credit a{color:#667}ol,ul{padding-inline-start:22px;margin:4px 0}nav.lang{text-align:end;font-size:14px}nav.lang label{cursor:pointer;padding:4px 10px;border-radius:8px;color:#2a6fd6}"
  + ".fa{display:none}#l-fa:checked~main{direction:rtl;font-family:Tahoma,system-ui,sans-serif}#l-fa:checked~main .en{display:none}#l-fa:checked~main span.fa,#l-fa:checked~main a.plain.fa{display:inline}#l-fa:checked~main div.fa,#l-fa:checked~main p.fa,#l-fa:checked~main ol.fa,#l-fa:checked~main ul.fa,#l-fa:checked~main h1.fa,#l-fa:checked~main h2.fa,#l-fa:checked~main form.fa,#l-fa:checked~main a.btn.fa{display:block}#l-en:checked~main nav label[for=l-en],#l-fa:checked~main nav label[for=l-fa]{background:#e3eefc;font-weight:bold}"
  + "pre{background:#f0f2f5;padding:8px;border-radius:8px;overflow-x:auto;font-size:11px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:start;vertical-align:top}th{font-weight:600;white-space:nowrap}.ok{color:#177245;font-weight:600}.bad{color:#b33;font-weight:600}a.plain{color:#2a6fd6}";

const CARRIER_FA = {
  "websocket-lanes": "چندکاناله (WS Lanes)",
  websocket: "تک‌کاناله (WS Mux)",
  https: "HTTPS واقعی (DO)"
};
const SPEED_FA = {
  fast: "پرسرعت",
  balanced: "متعادل",
  "low-upload": "آپلود محدود"
};
const DC_FA = {
  normal: "عادی",
  tolerant: "صبورتر"
};
const PROFILE_SHORT_FA = {
  fast: "پرسرعت",
  "mobile-mux": "موبایل تک‌کاناله",
  "mobile-lanes": "موبایل چندکاناله",
  "https-do": "HTTPS واقعی"
};
const PROFILE_SHORT_EN = {
  fast: "Fast",
  "mobile-mux": "Mobile Mux",
  "mobile-lanes": "Mobile Lanes",
  "https-do": "HTTPS"
};

// Inline text in both languages; CSS shows one of them (no JavaScript needed).
function bi(en, fa) {
  return `<span class="en">${en}</span><span class="fa">${fa}</span>`;
}

// English is the default; ?lang=fa pre-selects Persian. Switching needs no reload.
function bilingualPage(title, lang, body, seal) {
  const fa = lang === "fa";
  const credit = `<footer class="credit">ProxyGosha &middot; ${escapeHtml(seal.name)} &middot; <a href="mailto:${escapeHtml(seal.mail)}">${escapeHtml(seal.mail)}</a></footer>`;
  return `<!doctype html><html lang="${fa ? "fa" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${PAGE_STYLE}</style></head><body>
<input type="radio" name="l" id="l-en" hidden${fa ? "" : " checked"}><input type="radio" name="l" id="l-fa" hidden${fa ? " checked" : ""}>
<main><nav class="lang"><label for="l-en">English</label> <label for="l-fa">فارسی</label></nav>
${body}
${credit}
</main></body></html>`;
}

function carrierWarningCard(cfg) {
  if (!cfg.carrierWarning) return "";
  if (cfg.carrierWarning === "https_no_do") {
    return `<div class="card warn"><b>${bi("CARRIER=https is NOT active", "حالت CARRIER=https فعال نیست")}</b> — ${bi(
      "Stateless Cloudflare Workers cannot hold outbound TCP sockets across separate HTTP long-poll requests. Because the optional SQLite Durable Object binding (<code>PROXY_DO</code>) is not attached, this Worker fell back to <code>" + escapeHtml(cfg.carrier) + "</code>. It is NOT serving HTTPS long-polling.",
      "ورکر بدون حالت (Stateless) کلودفلر نمی‌تواند سوکت TCP خروجی را بین درخواست‌های جداگانه HTTPS long-polling نگه دارد. چون بایندینگ اختیاری Durable Object با نام <code>PROXY_DO</code> متصل نشده، ورکر روی <code>" + escapeHtml(cfg.carrier) + "</code> اجرا می‌شود و حالت HTTPS واقعی فعال نیست."
    )}</div>`;
  }
  if (cfg.carrierWarning === "https_lanes_to_https" || cfg.carrierWarning === "https_lanes_no_do") {
    return `<div class="card warn"><b>${bi("CARRIER=https-lanes is not supported", "حالت CARRIER=https-lanes پشتیبانی نمی‌شود")}</b> — ${bi(
      "Parallel HTTPS long-poll lanes multiply Cloudflare Free daily request consumption. Active carrier is <code>" + escapeHtml(cfg.carrier) + "</code>.",
      "اجرای هم‌زمان چند کانال HTTPS long-polling سهمیه روزانه درخواست‌های پلن رایگان کلودفلر را به سرعت مصرف می‌کند. حامل فعال فعلی: <code>" + escapeHtml(cfg.carrier) + "</code>."
    )}</div>`;
  }
  return `<div class="card warn"><b>${bi("Unrecognized CARRIER value", "مقدار CARRIER نامعتبر است")}</b> — ${bi(
    "Requested <code>" + escapeHtml(cfg.carrierRequested) + "</code> is unsupported; active carrier fell back to <code>" + escapeHtml(cfg.carrier) + "</code>.",
    "مقدار درخواستی <code>" + escapeHtml(cfg.carrierRequested) + "</code> پشتیبانی نمی‌شود؛ حامل فعال به <code>" + escapeHtml(cfg.carrier) + "</code> برگشت."
  )}</div>`;
}

function collectPanelHosts(cfg, currentHost) {
  const list = [];
  const add = (h, source) => {
    const clean = String(h || "").trim().toLowerCase();
    if (!clean || clean === "*" || clean === "proxy.example.com") return;
    if (!/^[a-z0-9.-]+$/.test(clean) || clean.includes("..")) return;
    if (list.some((item) => item.host === clean)) return;
    list.push({ host: clean, source });
  };
  add(currentHost, "current");
  for (const h of cfg.extraHosts || []) add(h, "extra");
  for (const h of cfg.hosts || []) add(h, "hostname");
  return list;
}

async function handleSaveSettings(request, env, cfg, host, url) {
  const redirectBack = (code, lang) => {
    const q = new URLSearchParams({ saved: code });
    if (lang === "fa") q.set("lang", "fa");
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/" + encodeURIComponent(cfg.adminKey) + "?" + q.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      }
    });
  };
  const secFetchSite = (request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return notFound();
  }
  const rawOrigin = (request.headers.get("origin") || "").trim().toLowerCase();
  // Note: some browsers / privacy extensions send "Origin: null" on same-origin form POSTs
  // (especially under strict referrer policies). Rely on HMAC _csrf + Sec-Fetch-Site in that case.
  if (rawOrigin && rawOrigin !== "null" && rawOrigin !== url.origin.toLowerCase() && rawOrigin !== "https://" + host) {
    return notFound();
  }
  let form;
  try {
    const text = await request.text();
    if (text.length > 4096) return notFound();
    form = new URLSearchParams(text);
  } catch (_) {
    return notFound();
  }
  const lang = form.get("lang") === "fa" ? "fa" : "en";
  const csrf = (form.get("_csrf") || "").trim();
  const validCsrf = csrf ? await verifyToken(cfg, csrf, TOKEN_KIND_CSRF) : null;
  if (!validCsrf) return redirectBack("csrf", lang);

  if (!cfg.hasKvBinding || !env?.SETTINGS_KV) {
    return redirectBack("no_kv", lang);
  }

  const action = (form.get("action") || "save").trim();
  if (action === "reset") {
    try {
      if (typeof env.SETTINGS_KV.delete === "function") await env.SETTINGS_KV.delete(KV_SETTINGS_KEY);
      else await env.SETTINGS_KV.put(KV_SETTINGS_KEY, "");
    } catch (_) {
      return redirectBack("err", lang);
    }
    kvSettingsCache = null;
    kvSettingsCachedAt = Date.now();
    kvSettingsCachedNs = env.SETTINGS_KV;
    cachedRuntime = null;
    cachedKey = null;
    logEvent("settings_reset", "kv override cleared");
    return redirectBack("reset", lang);
  }

  const preset = (form.get("preset") || "").trim().toLowerCase();
  let carrier = (form.get("carrier") || "").trim().toLowerCase();
  let wsAutoFallback = form.get("ws_auto_fallback") !== "false";
  let speedProfile = (form.get("speed_profile") || "").trim().toLowerCase();
  let dcProfile = (form.get("dc_profile") || "").trim().toLowerCase();

  // Quick preset buttons override individual selects cleanly
  if (preset === "fast") {
    carrier = "websocket-lanes"; wsAutoFallback = true; speedProfile = "fast"; dcProfile = "normal";
  } else if (preset === "balanced") {
    carrier = "websocket-lanes"; wsAutoFallback = true; speedProfile = "balanced"; dcProfile = "normal";
  } else if (preset === "mobile-mux") {
    carrier = "websocket"; wsAutoFallback = false; speedProfile = "low-upload"; dcProfile = "tolerant";
  } else if (preset === "mobile-lanes") {
    carrier = "websocket-lanes"; wsAutoFallback = true; speedProfile = "low-upload"; dcProfile = "tolerant";
  } else if (preset === "https-do") {
    carrier = "https"; wsAutoFallback = false; speedProfile = "balanced"; dcProfile = "tolerant";
  }

  if (carrier !== "websocket-lanes" && carrier !== "websocket" && carrier !== "https") {
    return redirectBack("invalid", lang);
  }
  if (carrier === "https" && !cfg.hasDoBinding) {
    return redirectBack("no_do", lang);
  }
  if (!Object.prototype.hasOwnProperty.call(SPEED_PRESETS, speedProfile)) speedProfile = "balanced";
  if (!Object.prototype.hasOwnProperty.call(DC_PRESETS, dcProfile)) dcProfile = "normal";

  const nextSettings = {
    carrier,
    wsAutoFallback,
    speedProfile,
    dcProfile,
    updatedAt: Date.now()
  };
  try {
    await env.SETTINGS_KV.put(KV_SETTINGS_KEY, JSON.stringify(nextSettings));
  } catch (_) {
    return redirectBack("err", lang);
  }
  kvSettingsCache = nextSettings;
  kvSettingsCachedAt = Date.now();
  kvSettingsCachedNs = env.SETTINGS_KV;
  cachedRuntime = null;
  cachedKey = null;
  logEvent("settings_saved", `carrier=${carrier} speed=${speedProfile} dc=${dcProfile} fb=${wsAutoFallback ? 1 : 0}`);
  return redirectBack("1", lang);
}

async function servePanel(cfg, host, port, lang, savedState = "") {
  STATS.panelViews++;
  logEvent("panel_view", host, [cfg.adminKey, cfg.secretHex]);
  const statusHref = "/" + encodeURIComponent(cfg.adminKey) + "/status";
  const settingsAction = "/" + encodeURIComponent(cfg.adminKey) + "/settings";
  const csrfToken = await issueToken(cfg, TOKEN_KIND_CSRF, 7200, 0);
  const secret = "dd" + bytesToHex(cfg.base);
  const hostEntries = collectPanelHosts(cfg, host);
  const nonStandardPorts = HTTPS_PORTS.filter((p) => p !== 443);

  let savedBanner = "";
  if (savedState === "1") {
    savedBanner = `<div class="card okbox"><b>${bi("Global settings saved &amp; active", "تنظیمات سراسری ذخیره و فعال شد")}</b> — ${bi(
      "Saved in <code>SETTINGS_KV</code> and active globally across Cloudflare isolates for the Primary (Default) link. Toggle the proxy off and on once in Telegram to start a fresh session with the new mode.",
      "در <code>SETTINGS_KV</code> ذخیره شد و به‌صورت سراسری روی کل کلودفلر برای لینک اصلی (پیش‌فرض) اعمال می‌شود. در تلگرام یک‌بار پروکسی را قطع و وصل کنید تا نشست جدید با تنظیمات تازه ساخته شود."
    )}</div>`;
  } else if (savedState === "reset") {
    savedBanner = `<div class="card okbox"><b>${bi("Settings reset to defaults", "تنظیمات به حالت پیش‌فرض برگشت")}</b> — ${bi(
      "Global panel override cleared from <code>SETTINGS_KV</code>; environment variables / defaults are now active.",
      "تنظیمات ذخیره شده از <code>SETTINGS_KV</code> پاک شد و مقادیر پیش‌فرض / متغیرهای محیطی فعال شدند."
    )}</div>`;
  } else if (savedState === "no_do") {
    savedBanner = `<div class="card warn"><b>${bi("Cannot enable HTTPS carrier without PROXY_DO", "بدون PROXY_DO امکان فعال‌سازی HTTPS نیست")}</b> — ${bi(
      "Attach the optional SQLite Durable Object binding <code>PROXY_DO</code> first to enable true HTTPS long-polling.",
      "برای فعال‌سازی HTTPS long-polling واقعی، ابتدا باید بایندینگ اختیاری <code>PROXY_DO</code> را متصل کنید."
    )}</div>`;
  } else if (savedState === "no_kv") {
    savedBanner = `<div class="card warn"><b>${bi("SETTINGS_KV is not bound", "بایندینگ SETTINGS_KV متصل نیست")}</b> — ${bi(
      "To change the Default link globally from the panel, bind a free KV namespace as <code>SETTINGS_KV</code>. Meanwhile, the Per-Operator profile links below already work globally with zero bindings!",
      "برای ذخیرهٔ سراسری تنظیمات لینک پیش‌فرض از داخل پنل، یک فضای KV رایگان با نام <code>SETTINGS_KV</code> متصل کنید. لینک‌های اختصاصی هر اپراتور در پایین همین الان بدون نیاز به KV به‌صورت سراسری کار می‌کنند!"
    )}</div>`;
  } else if (savedState === "csrf" || savedState === "invalid" || savedState === "err") {
    savedBanner = `<div class="card warn">${bi(
      "Could not save settings (expired form token or storage error). Reload this page and try again.",
      "ذخیره تنظیمات انجام نشد (توکن فرم منقضی شده یا خطای ذخیره‌سازی رخ داده). صفحه را رفرش کنید و دوباره امتحان کنید."
    )}</div>`;
  }

  const kvBadge = cfg.hasKvBinding
    ? `<span class="badge badge-ok">${bi("SETTINGS_KV active — live global save", "SETTINGS_KV متصل — ذخیره سراسری فعال")}</span>`
    : `<span class="badge badge-warn">${bi("No KV binding — use Per-Operator links below or attach free SETTINGS_KV", "بدون KV — از لینک‌های هر اپراتور در پایین استفاده کنید یا SETTINGS_KV رایگان وصل کنید")}</span>`;

  const sel = (cur, val) => cur === val ? " selected" : "";
  const dis = cfg.hasKvBinding ? "" : " disabled";
  const settingsFormEn = `<form class="en" method="POST" action="${escapeHtml(settingsAction)}">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<input type="hidden" name="lang" value="en">
<div class="fgrid">
  <div class="ffield">
    <label for="f-carrier-en">Transport carrier</label>
    <select id="f-carrier-en" name="carrier"${dis}>
      <option value="websocket-lanes"${sel(cfg.carrier, "websocket-lanes")}>websocket-lanes (multi-lane WS, default)</option>
      <option value="websocket"${sel(cfg.carrier, "websocket")}>websocket (single mux WS — best if ISP drops parallel WS)</option>
      <option value="https"${sel(cfg.carrier, "https")}${cfg.hasDoBinding ? "" : " disabled"}>https (${cfg.hasDoBinding ? "true HTTPS long-poll via PROXY_DO" : "disabled — bind PROXY_DO first"})</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-speed-en">Upload &amp; throughput pacing</label>
    <select id="f-speed-en" name="speed_profile"${dis}>
      <option value="fast"${sel(cfg.speedProfile, "fast")}>fast (unrestricted ISP / FTTH — 512 KiB / 1 MiB batches)</option>
      <option value="balanced"${sel(cfg.speedProfile, "balanced")}>balanced (general purpose — 64 KiB / 128 KiB batches)</option>
      <option value="low-upload"${sel(cfg.speedProfile, "low-upload")}>low-upload (throttled mobile / Irancell — 32 KiB / 64 KiB, 4 retries, 75s)</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-fb-en">WS lanes → single WS auto-fallback</label>
    <select id="f-fb-en" name="ws_auto_fallback"${dis}>
      <option value="true"${cfg.wsAutoFallback ? " selected" : ""}>Enabled (recommended)</option>
      <option value="false"${!cfg.wsAutoFallback ? " selected" : ""}>Disabled</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-dc-en">Telegram DC connect timeouts</label>
    <select id="f-dc-en" name="dc_profile"${dis}>
      <option value="normal"${sel(cfg.dcProfile, "normal")}>normal (2.2s / 7.5s)</option>
      <option value="tolerant"${sel(cfg.dcProfile, "tolerant")}>tolerant (3.0s / 9.5s)</option>
    </select>
  </div>
</div>
<div class="factions">
  <button class="btn" type="submit" name="action" value="save"${dis}>Save &amp; Apply Globally</button>
  <button class="btn btn-sec" type="submit" name="preset" value="fast"${dis}>Quick: Unrestricted / Fast</button>
  <button class="btn btn-sec" type="submit" name="preset" value="mobile-mux"${dis}>Quick: Irancell / Mobile Mux</button>
  <button class="btn btn-sec" type="submit" name="action" value="reset"${dis}>Reset to Defaults</button>
</div>
</form>`;

  const settingsFormFa = `<form class="fa" method="POST" action="${escapeHtml(settingsAction)}">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<input type="hidden" name="lang" value="fa">
<div class="fgrid">
  <div class="ffield">
    <label for="f-carrier-fa">حالت انتقال (Carrier)</label>
    <select id="f-carrier-fa" name="carrier"${dis}>
      <option value="websocket-lanes"${sel(cfg.carrier, "websocket-lanes")}>چندکاناله (websocket-lanes — پیش‌فرض)</option>
      <option value="websocket"${sel(cfg.carrier, "websocket")}>تک‌کاناله مالتی‌پلکس (websocket — مناسب محدودیت WS ایرانسل)</option>
      <option value="https"${sel(cfg.carrier, "https")}${cfg.hasDoBinding ? "" : " disabled"}>${cfg.hasDoBinding ? "HTTPS واقعی (با PROXY_DO)" : "HTTPS واقعی (غیرفعال — نیازمند اتصال PROXY_DO)"}</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-speed-fa">حالت سرعت و بسته‌بندی آپلود</label>
    <select id="f-speed-fa" name="speed_profile"${dis}>
      <option value="fast"${sel(cfg.speedProfile, "fast")}>پرسرعت (اپراتور آزاد و اینترنت ثابت — بسته‌های ۵۱۲K / ۱M)</option>
      <option value="balanced"${sel(cfg.speedProfile, "balanced")}>متعادل (پیش‌فرض — بسته‌های ۶۴K / ۱۲۸K)</option>
      <option value="low-upload"${sel(cfg.speedProfile, "low-upload")}>آپلود محدود (ایرانسل / موبایل ضعیف — بسته‌های ۳۲K / ۶۴K، ۴ تلاش، ۷۵ ثانیه)</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-fb-fa">تبدیل خودکار چندکاناله به تک‌کاناله</label>
    <select id="f-fb-fa" name="ws_auto_fallback"${dis}>
      <option value="true"${cfg.wsAutoFallback ? " selected" : ""}>فعال (پیشنهادی)</option>
      <option value="false"${!cfg.wsAutoFallback ? " selected" : ""}>غیرفعال</option>
    </select>
  </div>
  <div class="ffield">
    <label for="f-dc-fa">تایم‌اوت اتصال به دیتاسنتر تلگرام</label>
    <select id="f-dc-fa" name="dc_profile"${dis}>
      <option value="normal"${sel(cfg.dcProfile, "normal")}>عادی (۲.۲ ثانیه / حداکثر ۷.۵ ثانیه)</option>
      <option value="tolerant"${sel(cfg.dcProfile, "tolerant")}>صبورتر (۳ ثانیه / حداکثر ۹.۵ ثانیه)</option>
    </select>
  </div>
</div>
<div class="factions">
  <button class="btn" type="submit" name="action" value="save"${dis}>ذخیره و اعمال سراسری</button>
  <button class="btn btn-sec" type="submit" name="preset" value="fast"${dis}>حالت سریع: اپراتور آزاد / پرسرعت</button>
  <button class="btn btn-sec" type="submit" name="preset" value="mobile-mux"${dis}>حالت سریع: ایرانسل / موبایل تک‌کاناله</button>
  <button class="btn btn-sec" type="submit" name="action" value="reset"${dis}>بازگشت به پیش‌فرض</button>
</div>
</form>`;

  const settingsCard = `<div class="card"><b>${bi("Network &amp; Operator Settings (controls the Primary Default link)", "تنظیمات شبکه و اپراتور (تغییر رفتار لینک اصلی پیش‌فرض)")}</b>${kvBadge}
<p class="muted">${bi(
    "Different ISPs have different restrictions (e.g., fixed broadband handles large multi-lane bursts cleanly, while mobile carriers like Irancell may throttle upload or disrupt parallel WebSockets). Use either: (1) this global setting (requires free <code>SETTINGS_KV</code>) to update your existing Primary link, OR (2) the ready-to-use <b>Per-Operator Profile links</b> under your domain below which work globally RIGHT NOW with zero bindings!",
    "اپراتورهای مختلف رفتار متفاوتی دارند (مثلاً اینترنت ثابت یا اپراتورهای آزادتر با بسته‌های بزرگ و چندکاناله سریع‌ترند، اما اپراتورهایی مثل ایرانسل ممکن است آپلود یا WebSocket چندکاناله را محدود کنند). دو راه دارید: ۱) ذخیرهٔ تنظیم سراسری در اینجا (نیازمند <code>SETTINGS_KV</code> رایگان) برای تغییر رفتار لینک اصلیِ قبلی، یا ۲) استفاده از <b>لینک‌های اختصاصی هر اپراتور</b> در بخش زیر که همین الان بدون هیچ بایندینگی روی کل کلودفلر واقعاً کار می‌کنند!"
  )}</p>
${settingsFormEn}
${settingsFormFa}
${cfg.hasKvBinding ? "" : `<p class="muted" style="margin-top:8px"><b>${bi("How to enable live global saving (100% Free, 30 seconds):", "نحوه فعال‌سازی ذخیره سراسری داخل پنل (کاملاً رایگان، ۳۰ ثانیه):")}</b> ${bi(
  "Cloudflare Dashboard → Storage &amp; Databases → Workers KV → Create namespace (any name) → open this Worker → Settings → Bindings → Add → KV Namespace → Variable name: <code>SETTINGS_KV</code> → Deploy.",
  "داشبورد کلودفلر ← Storage &amp; Databases ← Workers KV ← ساخت یک فضای جدید ← باز کردن همین ورکر ← Settings ← Bindings ← Add ← KV Namespace ← نام متغیر: <code>SETTINGS_KV</code> ← Deploy."
)}</p>`}
</div>`;

  const sections = hostEntries.map(({ host: h, source }) => {
    const workersDev = h.endsWith(".workers.dev");
    const p443Secret = cfg.portSecrets?.[443]?.secretHex || secret;
    const p443Link = "tg://webproxy?server=" + encodeURIComponent(h) + "&secret=" + p443Secret;
    const badge = source === "current"
      ? `<span class="badge badge-ok">${bi("current request host", "دامنه همین درخواست")}</span>`
      : `<span class="badge badge-warn">${bi("listed in " + (source === "extra" ? "EXTRA_HOSTS" : "HOSTNAME") + " — attach in Cloudflare first", "فهرست‌شده در " + (source === "extra" ? "EXTRA_HOSTS" : "HOSTNAME") + " — اتصال در کلودفلر الزامی است")}</span>`;

    const hostNote = workersDev
      ? `<p class="muted">${bi(
          "workers.dev addresses are widely filtered in Iran and only use standard port 443. Attach one or more Custom Domains to this Worker (Settings → Domains & Routes → Custom Domain) for better reachability.",
          "آدرس‌های workers.dev معمولاً در ایران فیلتر هستند و فقط روی پورت ۴۴۳ کار می‌کنند. برای پایداری بیشتر، یک یا چند Custom Domain به ورکر متصل کنید (Settings ← Domains & Routes ← Custom Domain)."
        )}</p>`
      : (source !== "current"
        ? `<p class="muted">${bi(
            "Listing a domain in EXTRA_HOSTS or HOSTNAME does NOT attach DNS/TLS to this Worker. Confirm this hostname is attached under Cloudflare Dashboard → Worker → Settings → Domains & Routes → Custom Domain (or Route) and opens this panel directly.",
            "وارد کردن دامنه در EXTRA_HOSTS یا HOSTNAME به تنهایی آن را به ورکر وصل نمی‌کند. ابتدا دامنه را در داشبورد کلودفلر (Worker ← Settings ← Domains & Routes ← Custom Domain) متصل کنید و باز شدن پنل روی آن را بررسی کنید."
          )}</p>`
        : "");

    const defaultModeTagEn = `${escapeHtml(cfg.carrier)} &middot; ${escapeHtml(cfg.speedProfile)} &middot; dc:${escapeHtml(cfg.dcProfile)}`;
    const defaultModeTagFa = `${escapeHtml(CARRIER_FA[cfg.carrier] || cfg.carrier)} &middot; ${escapeHtml(SPEED_FA[cfg.speedProfile] || cfg.speedProfile)} &middot; تایم‌اوت: ${escapeHtml(DC_FA[cfg.dcProfile] || cfg.dcProfile)}`;
    const primaryCard = `<div class="card"><b>${bi("Port 443 — Primary Default Link (controlled by Global Settings above)", "پورت ۴۴۳ — لینک اصلی پیش‌فرض (تحت کنترل تنظیمات سراسری بالا)")}</b>
<span class="badge badge-ok">${bi(defaultModeTagEn, defaultModeTagFa)}</span>
<a class="btn" href="${escapeHtml(p443Link)}">${bi("Connect in Telegram (Default / Port 443)", "اتصال در تلگرام (پیش‌فرض / پورت ۴۴۳)")}</a>
<textarea readonly>${escapeHtml(p443Link)}</textarea>
<div style="margin-top:8px"><b>${bi("Manual entry (WEB proxy)", "ورود دستی (پروکسی WEB)")}</b> <span class="muted">${bi("— official Telegram WEB proxy uses HTTPS port 443 implicitly (no port field):", "— پروکسی WEB رسمی تلگرام همیشه از HTTPS پورت ۴۴۳ استفاده می‌کند و فیلد پورت ندارد:")}</span></div>
${bi("Server", "سرور")}:<textarea class="one" readonly>${escapeHtml(h)}</textarea>
${bi("Secret (Primary / Port 443)", "سکرت (اصلی / پورت ۴۴۳)")}:<textarea class="one" readonly>${escapeHtml(p443Secret)}</textarea>
</div>`;

    const profileCards = OPERATOR_PROFILES.map((prof) => {
      const entry = cfg.profileSecrets?.[prof.id];
      const available = !prof.requiresDo || cfg.hasDoBinding;
      if (!entry || !available) {
        return `<div class="pbox pbox-dis"><b>${bi(prof.titleEn, prof.titleFa)}</b> <span class="badge badge-warn">${bi("requires optional PROXY_DO", "نیازمند بایندینگ اختیاری PROXY_DO")}</span>
<p class="muted">${bi(prof.descEn, prof.descFa)}</p></div>`;
      }
      const pLink = "tg://webproxy?server=" + encodeURIComponent(h) + "&secret=" + entry.secretHex;
      const pTagEn = `${escapeHtml(prof.carrier)} &middot; ${escapeHtml(prof.speedProfile)}`;
      const pTagFa = `${escapeHtml(CARRIER_FA[prof.carrier] || prof.carrier)} &middot; ${escapeHtml(SPEED_FA[prof.speedProfile] || prof.speedProfile)}`;
      const pNameEn = PROFILE_SHORT_EN[prof.id] || prof.id;
      const pNameFa = PROFILE_SHORT_FA[prof.id] || prof.id;
      return `<div class="pbox"><b>${bi(prof.titleEn, prof.titleFa)}</b> <span class="badge badge-ok">${bi(pTagEn, pTagFa)}</span>
<p class="muted">${bi(prof.descEn, prof.descFa)}</p>
<a class="btn" href="${escapeHtml(pLink)}">${bi("Connect (" + pNameEn + ")", "اتصال (" + pNameFa + ")")}</a>
<textarea readonly>${escapeHtml(pLink)}</textarea>
<div class="muted">${bi("Profile secret (" + pNameEn + "):", "سکرت اختصاصی (" + pNameFa + "):")}</div>
<textarea class="one" readonly>${escapeHtml(entry.secretHex)}</textarea></div>`;
    }).join("");

    const profilesCard = `<div class="card"><b>${bi("Instant Per-Operator Profile Links (work globally with ZERO bindings)", "لینک‌های آمادهٔ تفکیک‌شده برای هر اپراتور (فعالِ فوری و سراسری، بدون نیاز به KV)")}</b>
<p class="muted">${bi(
      "Each link below cryptographically selects its own transport mode and batch sizing inside the Worker — so one user on fixed broadband (Fast) and another on Irancell (Mobile Mux) can connect to the exact same Worker simultaneously without changing global settings!",
      "هر لینک زیر به‌صورت رمزنگاری‌شده حالت انتقال و اندازهٔ بسته‌های خودش را در Worker فعال می‌کند؛ بنابراین می‌توانید هم‌زمان روی اینترنت ثابت از لینک پرسرعت و روی ایرانسل از لینک موبایل تک‌کاناله روی همین یک ورکر استفاده کنید و داخل تلگرام با یک لمس بین آن‌ها جابه‌جا شوید!"
    )}</p>
${profileCards}</div>`;

    const compatItems = nonStandardPorts.map((p) => {
      const pSecret = cfg.portSecrets?.[p]?.secretHex || secret;
      const link = "tg://webproxy?server=" + encodeURIComponent(h) + "&port=" + p + "&secret=" + pSecret;
      return `<div style="margin:10px 0;padding-top:8px;border-top:1px solid #eceef2"><b>${bi("Port", "پورت")} ${p}</b>
<a class="btn" href="${escapeHtml(link)}">${bi("Connect (Port " + p + ")", "اتصال (پورت " + p + ")")}</a>
<textarea readonly>${escapeHtml(link)}</textarea>
<div class="muted">${bi("Port " + p + " secret:", "سکرت پورت " + p + ":")}</div>
<textarea class="one" readonly>${escapeHtml(pSecret)}</textarea></div>`;
    }).join("");

    const compatBlock = `<details class="compat"><summary>${bi("Non-standard Cloudflare HTTPS ports (2053, 2083, 2087, 2096, 8443) — compatibility only", "پورت‌های غیراستاندارد HTTPS کلودفلر (2053، 2083، 2087، 2096، 8443) — فقط برای سازگاری")}</summary>
<p class="muted">${bi(
      "Cloudflare Custom Domains accept HTTPS on 443, 2053, 2083, 2087, 2096, and 8443. However, official Telegram Desktop and reference WEB Proxy clients currently fix HTTPS to port 443 and ignore &amp;port=. These links and deterministic per-port secrets are preserved for backward compatibility and custom/third-party clients; on official Telegram, attaching multiple Custom Domains is the reliable failover instead of switching ports.",
      "دامنه‌های شخصی کلودفلر روی پورت‌های 443، 2053، 2083، 2087، 2096 و 8443 ترافیک HTTPS می‌پذیرند؛ اما کلاینت رسمی Telegram Desktop و مشخصات مرجع WEB Proxy در حال حاضر فقط از پورت 443 استفاده می‌کنند و پارامتر &amp;port= را نادیده می‌گیرند. این لینک‌ها و سکرت‌های اختصاصی صرفاً برای سازگاری با لینک‌های قبلی یا کلاینت‌های سفارشی حفظ شده‌اند؛ در تلگرام رسمی، استفاده از چند Custom Domain جایگزین مؤثرتر از تغییر پورت است."
    )}</p>${compatItems}</details>`;

    return `<h2>${escapeHtml(h)}${badge}</h2>${hostNote}${primaryCard}${profilesCard}${compatBlock}`;
  }).join("");

  const derivedNote = cfg.secretDerived
    ? `<div class="card warn">${bi(
        "Your proxy secrets are derived from ADMIN_KEY. Changing ADMIN_KEY changes the secrets and breaks every link you have shared. To rotate ADMIN_KEY safely, set a fixed SECRET variable first.",
        "سکرت‌های پروکسی از ADMIN_KEY ساخته شده‌اند. اگر ADMIN_KEY را عوض کنید، سکرت‌ها هم عوض می‌شوند و همه لینک‌هایی که فرستاده‌اید از کار می‌افتند. برای جلوگیری، ابتدا یک متغیر SECRET ثابت تنظیم کنید."
      )}</div>`
    : "";

  const httpsDoNote = cfg.carrier === "https"
    ? `<div class="card info">${bi(
        "Active carrier: <code>https</code> (serialized HTTPS long-polling via optional <code>PROXY_DO</code> Durable Object). Watch Cloudflare Free daily Durable Object quotas (100,000 requests/day and 13,000 GB-s/day).",
        "حامل فعال: <code>https</code> (HTTPS long-polling واقعی از طریق بایندینگ اختیاری <code>PROXY_DO</code>). به سهمیه روزانه رایگان Durable Objects کلودفلر (۱۰۰٬۰۰۰ درخواست و ۱۳٬۰۰۰ GB-s در روز) توجه کنید."
      )}</div>`
    : "";

  const compatNotice = `<div class="card info"><b>${bi("Client, domain &amp; network honesty notice", "نکات مهم سازگاری کلاینت، دامنه و شبکه")}</b>
<ul class="en">
<li><b>Port 443 vs Cloudflare ports:</b> Official Telegram WEB Proxy clients connect strictly on HTTPS port <code>443</code> and ignore <code>&amp;port=</code>. Legacy non-443 secrets below are preserved for compatibility only — they do not switch ports in official Telegram.</li>
<li><b>Backup domains &amp; failover:</b> The bridge runs strictly same-origin, so cross-domain failover is done manually by adding multiple <code>tg://webproxy</code> links (each on a domain you own and attached in Cloudflare) in Telegram Proxy Settings. Listing a host in <code>EXTRA_HOSTS</code> does NOT create DNS, attach the domain, or issue TLS certificates.</li>
<li><b>Real-store / .ir subdomains:</b> Before moving DNS for a live store domain to Cloudflare, check its website, Iranian payment gateways, and email (MX/SPF/DKIM). Keep the main store DNS-only if needed and attach only a dedicated subdomain with the owner's permission. A storefront decoy does not by itself defeat traffic-pattern, SNI, or WebSocket filtering.</li>
<li><b>Operator profiles vs global settings:</b> Per-Operator links work immediately across all isolates without storage; binding free <code>SETTINGS_KV</code> lets you change the default link globally from this panel without redistributing links.</li>
<li><b>Client support &amp; shutdowns:</b> Telegram Desktop supports WEB proxy natively; mobile support depends on the installed build. If your ISP completely blocks Cloudflare or international internet access, Worker changes alone cannot establish the first connection.</li>
</ul>
<ul class="fa">
<li><b>پورت ۴۴۳ در برابر پورت‌های کلودفلر:</b> کلاینت‌های رسمی WEB Proxy تلگرام فقط روی HTTPS پورت <code>443</code> وصل می‌شوند و پارامتر <code>&amp;port=</code> را نادیده می‌گیرند. لینک‌ها و سکرت‌های غیر ۴۴۳ فقط برای سازگاری حفظ شده‌اند و در تلگرام رسمی پورت را تغییر نمی‌دهند.</li>
<li><b>دامنه‌های پشتیبان و failover:</b> صفحه bridge صرفاً same-origin است؛ بنابراین جایگزینی بین چند دامنه به‌صورت دستی با افزودن چند لینک <code>tg://webproxy</code> در تنظیمات پروکسی تلگرام انجام می‌شود. نوشتن دامنه در <code>EXTRA_HOSTS</code> به هیچ وجه DNS، اتصال دامنه یا گواهی TLS ایجاد نمی‌کند.</li>
<li><b>ساب‌دامین دامنه فروشگاهی / .ir:</b> پیش از تغییر DNS دامنه یک فروشگاه واقعی، حتماً سایت اصلی، درگاه پرداخت و ایمیل (MX/SPF/DKIM) آن را بررسی کنید و فقط با اجازه مالک اقدام کنید. ظاهر فروشگاهی به‌تنهایی مانع شناسایی الگوی ترافیک، SNI یا اختلال WebSocket نمی‌شود.</li>
<li><b>لینک‌های هر اپراتور در برابر تنظیم سراسری:</b> لینک‌های اختصاصی هر اپراتور بدون نیاز به KV همین لحظه روی کل کلودفلر کار می‌کنند؛ با اتصال <code>SETTINGS_KV</code> رایگان می‌توانید رفتار لینک اصلی قبلی را هم از همین پنل سراسری تغییر دهید.</li>
<li><b>سازگاری و قطعی کامل:</b> Telegram Desktop پشتیبانی بومی دارد اما پشتیبانی موبایل وابسته به نسخه نصب‌شده است. در صورت مسدودسازی کامل کلودفلر یا قطع کامل اینترنت بین‌الملل، تغییر کد ورکر به تنهایی اتصال اولیه را برقرار نمی‌کند.</li>
</ul></div>`;

  const body = `<h1>${bi("Proxy panel", "پنل پروکسی")}</h1>
<div class="card warn">${bi(
    "Do not share this panel URL (it contains your ADMIN_KEY). Share only the tg://webproxy links or server + secret.",
    "آدرس این پنل را با کسی به اشتراک نگذارید (حاوی ADMIN_KEY است). فقط لینک‌های tg://webproxy یا سرور و سکرت را بفرستید."
  )}</div>
<div class="card"><a class="plain en" href="${escapeHtml(statusHref)}">Status &amp; 5-stage diagnostics</a><a class="plain fa" href="${escapeHtml(statusHref + "?lang=fa")}">وضعیت و تشخیص خطای ۵ مرحله‌ای</a> <span class="muted">${bi("— stage-by-stage counters, sanitized events, and Cloudflare→Telegram DC probe.", "— شمارنده‌های مرحله‌به‌مرحله، رویدادهای پاک‌سازی‌شده و تست دسترسی کلودفلر به دیتاسنترهای تلگرام.")}</span></div>
${savedBanner}
${carrierWarningCard(cfg)}
${httpsDoNote}
${derivedNote}
${settingsCard}
${sections}
${compatNotice}`;
  return new Response(bilingualPage(lang === "fa" ? "پنل پروکسی" : "Proxy Panel", lang, body, await unseal()), { status: 200, headers: pageHeaders(true) });
}

async function serveSetup(host, env, lang, method) {
  // The setup page is documentation for the operator's browser only; every
  // other method gets a plain 404 so the worker does not answer API-style
  // probes with a page that identifies the software.
  if (method !== "GET" && method !== "HEAD") return notFound();
  const suggested = b64uEncode(crypto.getRandomValues(new Uint8Array(18))).replace(/[-_]/g, "x");
  const current = typeof env?.ADMIN_KEY === "string" ? env.ADMIN_KEY.trim() : "";
  const problem = current && current.length < 16
    ? `<div class="card warn">${bi(
        "Your current ADMIN_KEY is too short. It must be at least 16 characters.",
        "ADMIN_KEY فعلی کوتاه است. حداقل ۱۶ کاراکتر لازم است."
      )}</div>`
    : "";
  const body = `<h1>${bi("Proxy setup", "راه‌اندازی پروکسی")}</h1>${problem}
<div class="card">
<ol class="en"><li>In the Cloudflare dashboard, open <b>Workers &amp; Pages</b> → this Worker → <b>Settings</b> → <b>Variables and Secrets</b>.</li>
<li>Click <b>Add</b>. Name: <code>ADMIN_KEY</code>. Value: the key below (or any password of 16+ English letters and digits).</li>
<li>Click <b>Deploy</b>.</li>
<li>Attach a Custom Domain under <b>Settings → Domains &amp; Routes → Custom Domain</b> (recommended in Iran since <code>workers.dev</code> is commonly filtered).</li>
<li>Open the address below to reach your panel with ready Telegram links.</li></ol>
<ol class="fa"><li>در داشبورد کلودفلر: <b>Workers &amp; Pages</b> ← این ورکر ← <b>Settings</b> ← <b>Variables and Secrets</b></li>
<li>روی <b>Add</b> بزنید. نام: <code>ADMIN_KEY</code> ، مقدار: رمز زیر (یا هر رمز ۱۶+ حرفی از حروف و اعداد انگلیسی)</li>
<li><b>Deploy</b> را بزنید.</li>
<li>یک دامنه شخصی در بخش <b>Settings ← Domains &amp; Routes ← Custom Domain</b> متصل کنید (در ایران به دلیل فیلتر بودن <code>workers.dev</code> قویاً توصیه می‌شود).</li>
<li>آدرس زیر را باز کنید تا پنل و لینک‌های آماده تلگرام را ببینید.</li></ol>
${bi("Suggested key", "رمز پیشنهادی")}:<textarea class="one" readonly>${escapeHtml(suggested)}</textarea>
${bi("Panel address", "آدرس پنل")}:<textarea class="one" readonly>https://${escapeHtml(host)}/${escapeHtml(suggested)}</textarea></div>
<p class="muted">${bi(
    "Keep this key private. Anyone who has it can open your panel. If you reload this page, a new key is suggested; use the one you actually saved in Cloudflare.",
    "این رمز را جایی امن نگه دارید. هر کس آن را داشته باشد به پنل دسترسی دارد. با رفرش صفحه رمز جدیدی پیشنهاد می‌شود؛ همان رمزی را استفاده کنید که در کلودفلر ذخیره کرده‌اید."
  )}</p>`;
  return new Response(bilingualPage(lang === "fa" ? "راه‌اندازی پروکسی" : "Proxy Setup", lang, body, await unseal()), { status: 200, headers: pageHeaders() });
}

function fmtBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function fmtDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return days + "d " + hours + "h";
  if (hours) return hours + "h " + minutes + "m";
  return minutes + "m " + (total % 60) + "s";
}

// On-demand reachability probe of the Telegram DC front-ends from THIS Cloudflare
// edge location (Stage 5 ONLY — does NOT test user ISP -> Cloudflare connectivity).
// Keeps at most 3 TCP sockets in the "connecting" phase and closes them immediately.
async function probeDcs(cfg) {
  const keys = Object.keys(cfg.dc).map(Number).sort((a, b) => a - b);
  const results = [];
  const tryConnectOnce = async (ip, port, timeoutMs) => {
    const started = Date.now();
    let socket = null;
    let timer = null;
    try {
      socket = connect({ hostname: ip, port }, { secureTransport: "off" });
      socket.closed.catch(() => {});
      socket.opened.catch(() => {});
      await Promise.race([
        socket.opened,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })
      ]);
      try { await socket.close(); } catch (_) {}
      return { ok: true, port, ms: Date.now() - started };
    } catch (_) {
      if (socket) { try { socket.close().catch(() => {}); } catch (_) {} }
      return { ok: false, port, ms: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const probeOne = async (key) => {
    const ips = Array.isArray(cfg.dc[key]) ? cfg.dc[key] : [cfg.dc[key]];
    const ip = ips[Math.floor(Math.random() * ips.length)];
    const ports = Array.isArray(cfg.dcPorts) && cfg.dcPorts.length ? cfg.dcPorts : [cfg.dcPort || 443];
    let outcome = await tryConnectOnce(ip, ports[0], 2200);
    if (!outcome.ok && ports.length > 1) {
      outcome = await tryConnectOnce(ip, ports[1], 2200);
    }
    results.push({ dc: key, ip, port: outcome.port, ok: outcome.ok, ms: outcome.ms });
  };
  for (let i = 0; i < keys.length; i += 3) {
    await Promise.all(keys.slice(i, i + 3).map(probeOne));
  }
  results.sort((a, b) => a.dc - b.dc);
  logEvent("dc_probe", results.map((r) => `DC${r.dc}:${r.port}:${r.ok ? "ok" : "fail"}`).join(" "));
  return results;
}

// Admin status & diagnostics page: /<ADMIN_KEY>/status  (add ?probe=1 for a DC check)
// Never prints ADMIN_KEY, SECRET, bearer tokens, bridge URLs, or client IPs.
async function serveStatus(cfg, host, lang, wantsProbe, cfMeta) {
  STATS.statusViews++;
  logEvent("status_view", host, [cfg.adminKey, cfg.secretHex]);
  const probe = wantsProbe ? await probeDcs(cfg) : null;
  const secretMode = cfg.secretDerived
    ? bi("derived from ADMIN_KEY", "مشتق‌شده از ADMIN_KEY")
    : (cfg.base ? bi("fixed SECRET", "SECRET ثابت") : "-");
  const carrierLabel = cfg.carrierWarning
    ? `${bi(escapeHtml(cfg.carrier) + " (requested: " + escapeHtml(cfg.carrierRequested || "-") + ")", escapeHtml(CARRIER_FA[cfg.carrier] || cfg.carrier) + " (درخواستی: " + escapeHtml(cfg.carrierRequested || "-") + ")")}`
    : bi(escapeHtml(cfg.carrier), escapeHtml(CARRIER_FA[cfg.carrier] || cfg.carrier));
  const edgeColo = cfMeta && typeof cfMeta.colo === "string" ? cfMeta.colo : "-";
  const edgeProto = cfMeta && typeof cfMeta.httpProtocol === "string" ? cfMeta.httpProtocol : "-";
  const edgeTls = cfMeta && typeof cfMeta.tlsVersion === "string" ? cfMeta.tlsVersion : "-";
  const infoRows = [
    [bi("Version", "نسخه"), escapeHtml(VERSION)],
    [bi("Request host &amp; edge (no client IP)", "دامنه و سرور لبه همین درخواست (بدون IP کاربر)"), bi(
      `${escapeHtml(host)} &middot; PoP: <code>${escapeHtml(edgeColo)}</code> &middot; ${escapeHtml(edgeProto)} &middot; ${escapeHtml(edgeTls)}`,
      `${escapeHtml(host)} &middot; دیتاسنتر لبه: <code>${escapeHtml(edgeColo)}</code> &middot; ${escapeHtml(edgeProto)} &middot; ${escapeHtml(edgeTls)}`
    )],
    [bi("Active carrier", "حامل فعال"), carrierLabel],
    [bi("WS lanes → mux auto-fallback", "تبدیل خودکار چندکاناله به تک‌کاناله"), cfg.wsAutoFallback ? bi("enabled", "فعال") : bi("disabled", "غیرفعال")],
    [bi("Speed / DC timeout profile (default link)", "پروفایل سرعت / تایم‌اوت DC (لینک اصلی)"), bi(
      `<code>${escapeHtml(cfg.speedProfile)}</code> / <code>${escapeHtml(cfg.dcProfile)}</code>`,
      `${escapeHtml(SPEED_FA[cfg.speedProfile] || cfg.speedProfile)} / ${escapeHtml(DC_FA[cfg.dcProfile] || cfg.dcProfile)}`
    ) + (cfg.panelOverride ? ` <span class="badge badge-ok">${bi("from SETTINGS_KV", "ذخیره‌شده در SETTINGS_KV")}</span>` : "")],
    [bi("Optional SETTINGS_KV binding (Panel Save)", "بایندینگ اختیاری SETTINGS_KV (ذخیره پنل)"), cfg.hasKvBinding ? bi("attached (global panel save active)", "متصل (ذخیره سراسری پنل فعال)") : bi("not bound (Per-Operator links work without KV)", "متصل نیست (لینک‌های هر اپراتور بدون KV فعال‌اند)")],
    [bi("Optional PROXY_DO binding (HTTPS)", "بایندینگ اختیاری PROXY_DO (HTTPS)"), cfg.hasDoBinding ? bi("attached", "متصل") : bi("not bound (stateless Free mode)", "متصل نیست (حالت تک‌فایل رایگان)")],
    [bi("Uplink pacing (mux / lane / https)", "بسته‌بندی آپلود (تک‌کاناله / چندکاناله / HTTPS)"), bi(
      `${fmtBytes(cfg.wsBatchBytes)} (hw ${fmtBytes(cfg.wsBufferHighWater)}) / ${fmtBytes(cfg.laneBatchBytes)} / ${fmtBytes(cfg.httpsUpBatch)} adaptive`,
      `تک‌کاناله: ${fmtBytes(cfg.wsBatchBytes)} (سقف بافر ${fmtBytes(cfg.wsBufferHighWater)}) &middot; چندکاناله: ${fmtBytes(cfg.laneBatchBytes)} &middot; HTTPS تطبیقی: ${fmtBytes(cfg.httpsUpBatch)}`
    )],
    [bi("Secret mode", "حالت سکرت"), secretMode],
    [bi("Max streams / concurrent DC dials", "حداکثر استریم / اتصال هم‌زمان DC"), `${cfg.maxStreams} / ${cfg.dcMaxConcurrentDials}`],
    [bi("DC failover ports / timeouts", "پورت‌ها و تایم‌اوت DC"), bi(
      `${escapeHtml(cfg.dcPorts.join(", "))} (${cfg.dcConnectTimeoutMs}ms / ${cfg.dcTotalTimeoutMs}ms max)`,
      `${escapeHtml(cfg.dcPorts.join("، "))} (${cfg.dcConnectTimeoutMs} / حداکثر ${cfg.dcTotalTimeoutMs} میلی‌ثانیه)`
    )],
    [bi("AD_TAG", "AD_TAG"), cfg.adTag ? bi("set (NOT active — ignored in Direct-DC mode)", "تنظیم شده (غیرفعال — در حالت Direct-DC بی‌اثر)") : bi("not set", "تنظیم نشده")]
  ].map((row) => `<tr><th>${row[0]}</th><td>${row[1]}</td></tr>`).join("");

  const stageRows = [
    [
      bi("1. DNS / TLS / Edge access", "۱. DNS / TLS و دسترسی به ورکر"),
      bi(
        `decoy/root: ${STATS.pageHits} &middot; panel: ${STATS.panelViews} &middot; status: ${STATS.statusViews}<br><span class="muted">edge: ${escapeHtml(edgeColo)} / ${escapeHtml(edgeProto)} / ${escapeHtml(edgeTls)}</span>`,
        `صفحه اصلی: ${STATS.pageHits} &middot; پنل: ${STATS.panelViews} &middot; وضعیت: ${STATS.statusViews}<br><span class="muted">لبه: ${escapeHtml(edgeColo)} / ${escapeHtml(edgeProto)} / ${escapeHtml(edgeTls)}</span>`
      ),
      bi("If 0 when you visit the domain, DNS/SNI/TLS/Cloudflare IP is blocked before reaching the Worker.", "اگر با باز کردن دامنه ۰ بماند، DNS، SNI، TLS یا IP کلودفلر پیش از رسیدن به ورکر مسدود است.")
    ],
    [
      bi("2. Bridge handshake (/?bridge=)", "۲. هندشیک Bridge (/?bridge=)"),
      bi(
        `<span class="ok">ok: ${STATS.bridgeOk}</span> &middot; <span class="${STATS.bridgeRejects ? "bad" : "muted"}">reject: ${STATS.bridgeRejects}</span>`,
        `<span class="ok">موفق: ${STATS.bridgeOk}</span> &middot; <span class="${STATS.bridgeRejects ? "bad" : "muted"}">ردشده: ${STATS.bridgeRejects}</span>`
      ),
      bi("ok=0 while Stage 1 works: Telegram WebView cannot reach this host. reject>0: secret or domain mismatch.", "اگر مرحله ۱ کار کند ولی موفق=۰ باشد، WebView تلگرام به دامنه نرسیده؛ ردشده>۰ یعنی سکرت یا دامنه ناهماهنگ است.")
    ],
    [
      bi("3. Session bootstrap (/api/v1/session)", "۳. ساخت نشست (/api/v1/session)"),
      bi(
        `<span class="ok">ok: ${STATS.sessionCreateOk}</span> &middot; <span class="${STATS.sessionCreateRejects ? "bad" : "muted"}">reject: ${STATS.sessionCreateRejects}</span>`,
        `<span class="ok">موفق: ${STATS.sessionCreateOk}</span> &middot; <span class="${STATS.sessionCreateRejects ? "bad" : "muted"}">ردشده: ${STATS.sessionCreateRejects}</span>`
      ),
      bi("Stage 2 ok but Stage 3=0: WebView loaded bridge HTML but HTTPS POST failed or timed out.", "اگر مرحله ۲ موفق و مرحله ۳ صفر باشد، صفحه bridge باز شده ولی درخواست POST ناموفق یا تایم‌اوت شده است.")
    ],
    [
      bi("4. Carrier transport (WSS / HTTPS)", "۴. انتقال داده (WebSocket / HTTPS)"),
      bi(
        `ws-lanes: ${STATS.wsLanesOpened} &middot; ws-mux: ${STATS.wsMuxOpened} &middot; active: ${STATS.sessionsActive} &middot; <span class="${STATS.wsRejects ? "bad" : "muted"}">ws-reject: ${STATS.wsRejects}</span>`,
        `چندکاناله: ${STATS.wsLanesOpened} &middot; تک‌کاناله: ${STATS.wsMuxOpened} &middot; فعال: ${STATS.sessionsActive} &middot; <span class="${STATS.wsRejects ? "bad" : "muted"}">ردشده: ${STATS.wsRejects}</span>`
      )
        + (cfg.carrier === "websocket-lanes" && STATS.wsMuxOpened > 0
          ? `<br><span class="badge badge-warn">${bi("lanes→mux fallback observed", "تبدیل خودکار چندکاناله به تک‌کاناله رخ داده")}</span>`
          : "")
        + (cfg.hasDoBinding || STATS.httpsSessions || STATS.httpsUpOk || STATS.httpsDownOk
          ? `<br>` + bi(
              `https-do: init=${STATS.httpsSessions}, up=${STATS.httpsUpOk}/${STATS.httpsUpRejects}, down=${STATS.httpsDownOk}/${STATS.httpsDownRejects}`,
              `HTTPS (DO): نشست=${STATS.httpsSessions} &middot; ارسال=${STATS.httpsUpOk}/${STATS.httpsUpRejects} &middot; دریافت=${STATS.httpsDownOk}/${STATS.httpsDownRejects}`
            )
          : ""),
      bi("Stage 3 ok but WS=0: ISP/mobile carrier (e.g. Irancell) is likely blocking/throttling WebSocket Upgrade. Try CARRIER=websocket or optional PROXY_DO + CARRIER=https.", "اگر مرحله ۳ موفق ولی WebSocket صفر باشد، احتمالاً اپراتور (مثل ایرانسل) WebSocket را مسدود یا مختل می‌کند. پروفایل موبایل تک‌کاناله یا گزینه PROXY_DO + HTTPS را بررسی کنید.")
    ],
    [
      bi("5. MTProto header &amp; Outbound DC", "۵. هدر MTProto و اتصال خروجی DC"),
      bi(
        `header ok/bad: ${STATS.streamsHeaderOk}/${STATS.streamsHeaderFail}<br><span class="ok">dc ok: ${STATS.dcOk}</span> (443:${STATS.dcOk443}, 80:${STATS.dcOk80}, 5222:${STATS.dcOk5222}) &middot; <span class="${STATS.dcFails ? "bad" : "muted"}">fail: ${STATS.dcFails}</span> (timeout:${STATS.dcTimeouts}, err:${STATS.dcErrors})`,
        `هدر موفق/نامعتبر: ${STATS.streamsHeaderOk}/${STATS.streamsHeaderFail}<br><span class="ok">اتصال DC موفق: ${STATS.dcOk}</span> (443:${STATS.dcOk443}، 80:${STATS.dcOk80}، 5222:${STATS.dcOk5222}) &middot; <span class="${STATS.dcFails ? "bad" : "muted"}">ناموفق: ${STATS.dcFails}</span> (تایم‌اوت:${STATS.dcTimeouts}، خطا:${STATS.dcErrors})`
      ),
      bi("header bad>0: secret mismatch. dc fail>0: Cloudflare→Telegram egress failure (separate from user ISP).", "اگر هدر نامعتبر>۰ باشد سکرت ناهماهنگ است. خطای DC مربوط به مسیر کلودفلر به تلگرام است نه اپراتور کاربر.")
    ]
  ].map((row) => `<tr><th>${row[0]}</th><td>${row[1]}</td><td class="muted">${row[2]}</td></tr>`).join("");

  const statsRows = [
    [bi("WS sessions (isolate total / active)", "نشست‌های WS (کل / فعال در این ایزوله)"), `${STATS.sessions} / ${STATS.sessionsActive}`],
    [bi("MTProto streams opened", "استریم‌های MTProto بازشده"), String(STATS.streams)],
    [bi("Traffic up / down", "ترافیک ارسال / دریافت"), fmtBytes(STATS.bytesUp) + " / " + fmtBytes(STATS.bytesDown)],
    [bi("Isolate uptime", "مدت فعالیت این ایزوله"), fmtDuration(Date.now() - ISOLATE_START)]
  ].map((row) => `<tr><th>${row[0]}</th><td>${escapeHtml(row[1])}</td></tr>`).join("");

  const probeDisclaimer = `<p class="muted" style="margin-top:6px"><b>${bi("Important:", "مهم:")}</b> ${bi(
    "This probe ONLY checks outbound TCP reachability from this Cloudflare edge server to Telegram DCs (Stage 5). Passing this probe does NOT mean end-to-end user connectivity works on Irancell or your ISP.",
    "این تست فقط دسترسی خروجی TCP از همین سرور کلودفلر به دیتاسنترهای تلگرام (مرحله ۵) را بررسی می‌کند. نتیجه موفق به هیچ وجه به معنای موفقیت اتصال کامل کاربر روی ایرانسل یا اینترنت شما نیست."
  )}</p>`;

  const probeBlock = probe
    ? `<div class="card"><b>${bi("Cloudflare → Telegram DC probe (Stage 5 only)", "تست دسترسی کلودفلر به دیتاسنترهای تلگرام (فقط مرحله ۵)")}</b>${probeDisclaimer}<table><tr><th>${bi("DC", "دیتاسنتر")}</th><th>${bi("IP", "آی‌پی")}</th><th>${bi("Port", "پورت")}</th><th>${bi("Result", "نتیجه")}</th></tr>${probe.map((r) => `<tr><td>DC${r.dc}</td><td><code>${escapeHtml(r.ip)}</code></td><td>${r.port}</td><td class="${r.ok ? "ok" : "bad"}">${r.ok ? bi("OK", "موفق") : bi("FAIL", "ناموفق")} (${r.ms} ${bi("ms", "میلی‌ثانیه")})</td></tr>`).join("")}</table></div>`
    : `<div class="card"><a class="plain en" href="?probe=1">Run Cloudflare → Telegram DC probe (Stage 5 only)</a><a class="plain fa" href="?probe=1&amp;lang=fa">اجرای تست دسترسی کلودفلر به دیتاسنترهای تلگرام (فقط مرحله ۵)</a>${probeDisclaimer}</div>`;

  const logRows = LOG.slice(-60).reverse().map((e) => `<tr><td>${new Date(e.t).toISOString().slice(11, 19)}</td><td><code>${escapeHtml(e.event)}</code></td><td>${escapeHtml(e.detail)}</td></tr>`).join("");
  const logsBlock = `<div class="card"><b>${bi("Recent sanitized events", "رویدادهای اخیر (پاک‌سازی‌شده)")}</b> <span class="muted">${bi("(newest first, isolate RAM only — no keys, secrets, tokens, bridge URLs, or IPs)", "(جدیدترین اول، فقط حافظه همین ایزوله — بدون کلید، سکرت، توکن، URL کامل bridge یا IP کاربر)")}</span><table><tr><th>${bi("UTC", "زمان (UTC)")}</th><th>${bi("Event", "رویداد")}</th><th>${bi("Detail", "جزئیات")}</th></tr>${logRows || `<tr><td colspan="3">-</td></tr>`}</table></div>`;

  const body = `<h1>${bi("Proxy status &amp; diagnostics", "وضعیت و عیب‌یابی پروکسی")}</h1>
<div class="card warn"><b>${bi("Isolate-local memory limit:", "محدودیت حافظه محلی ایزوله:")}</b> ${bi(
    "All counters and logs below exist ONLY in this single Cloudflare Worker isolate's RAM. Cloudflare runs multiple isolates across edge locations and recycles them at any time. Seeing 0 here can happen if Telegram routed to a different isolate than your browser. No client IP addresses, ADMIN_KEY, secrets, tokens, or full bridge URLs are ever stored.",
    "تمامی شمارنده‌ها و لاگ‌های زیر فقط در حافظه RAM همین ایزوله کلودفلر نگهداری می‌شوند، با بازیافت ایزوله صفر می‌شوند و بین سرورها یا ایزوله‌های دیگر مشترک نیستند. صفر بودن شمارنده‌ها می‌تواند به دلیل اتصال تلگرام به یک ایزوله دیگر کلودفلر نیز باشد. هیچ IP کاربر، ADMIN_KEY، سکرت، توکن یا URL کامل bridge ذخیره نمی‌شود."
  )}</div>
${carrierWarningCard(cfg)}
<div class="card"><b>${bi("Configuration", "پیکربندی")}</b><table>${infoRows}</table></div>
<div class="card"><b>${bi("5-Stage Connection Diagnostics", "تشخیص مرحله‌به‌مرحله خطای اتصال")}</b><table><tr><th>${bi("Stage", "مرحله")}</th><th>${bi("Counters (this isolate)", "شمارنده‌ها (همین ایزوله)")}</th><th>${bi("Interpretation", "تفسیر")}</th></tr>${stageRows}</table></div>
<div class="card"><b>${bi("Traffic &amp; isolate summary", "خلاصه ترافیک و ایزوله")}</b><table>${statsRows}</table></div>
${probeBlock}
${logsBlock}`;
  return new Response(bilingualPage(lang === "fa" ? "وضعیت و عیب‌یابی پروکسی" : "Proxy Status", lang, body, await unseal()), { status: 200, headers: pageHeaders() });
}

async function issueToken(cfg, kind, ttl, mode) {
  const nonce = new Uint8Array(16);
  new DataView(nonce.buffer).setUint32(0, Math.floor(Date.now() / 1000) + ttl, false);
  nonce[4] = typeof mode === "number" && mode >= 0 && mode <= 255 ? mode : 0;
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
  return { nonce, mode: nonce[4] };
}

function isUnsafeDecoyHost(h, selfHost) {
  const host = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || (selfHost && host === String(selfHost).toLowerCase())) return true;
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
  if (/^(fc|fd|fe80:)/i.test(host)) return true;
  return false;
}

async function decoy(decoyUrl, requestMethod = "GET", reqPath = "/", selfHost = "") {
  if (decoyUrl && typeof decoyUrl === "string" && (decoyUrl.startsWith("http://") || decoyUrl.startsWith("https://"))) {
    let controller = null;
    let timer = null;
    try {
      const parsed = new URL(decoyUrl);
      const h = parsed.hostname.toLowerCase();
      if (!isUnsafeDecoyHost(h, selfHost)) {
        const cleanPath = typeof reqPath === "string" && reqPath.startsWith("/") ? reqPath : "/";
        const targetUrl = (cleanPath === "/" && parsed.pathname && parsed.pathname !== "/")
          ? parsed.href
          : parsed.origin + cleanPath;
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 5000);
        const upstream = await fetch(targetUrl, {
          method: requestMethod === "HEAD" ? "HEAD" : "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
          }
        });
        const status = upstream.status >= 200 && upstream.status <= 599 ? upstream.status : 200;
        const nullBody = requestMethod === "HEAD" || status === 204 || status === 205 || status === 304;
        return new Response(nullBody ? null : upstream.body, {
          status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "text/html; charset=utf-8",
            "Cache-Control": "no-cache"
          }
        });
      }
    } catch (_) {
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Accept-Encoding"
  };
  if (requestMethod === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(DECOY_HTML, { status: 200, headers });
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

async function serveBridge(cfg, host, mode, port) {
  const effective = resolveProfileConfig(cfg, mode);
  const nonce = b64uEncode(crypto.getRandomValues(new Uint8Array(18)));
  const bootstrap = await issueToken(cfg, TOKEN_KIND_BOOTSTRAP, effective.bootstrapTtl, mode);
  const authority = (port && port !== "443" && port !== "80") ? `${host}:${port}` : host;
  const relayBase = JSON.stringify("https://" + authority + "/");
  const body = BRIDGE_HTML
    .replaceAll("__NONCE__", nonce)
    .replaceAll("__RELAY_BASE__", relayBase)
    .replaceAll("__BOOTSTRAP__", JSON.stringify(bootstrap))
    .replaceAll("__CARRIER_MODE__", JSON.stringify(effective.carrier))
    .replaceAll("__BATCH_LIMIT__", String(effective.batchBytes))
    .replaceAll("__WS_BATCH_LIMIT__", String(effective.wsBatchBytes || 65536))
    .replaceAll("__WS_HIGH_WATER__", String(effective.wsBufferHighWater || 262144))
    .replaceAll("__LANE_BATCH_LIMIT__", String(effective.laneBatchBytes || 131072))
    .replaceAll("__LANE_HIGH_WATER__", String(effective.laneBufferHighWater || 524288))
    .replaceAll("__HTTPS_UP_BATCH__", String(effective.httpsUpBatch || 131072))
    .replaceAll("__WS_INIT_RETRIES__", String(effective.wsInitRetries || 3))
    .replaceAll("__LANE_OPEN_TIMEOUT__", String(effective.laneOpenTimeoutMs || 7500))
    .replaceAll("__IDLE_TIMEOUT__", String(effective.idleTimeoutMs || 65000))
    .replaceAll("__SESSION_PATH__", JSON.stringify(effective.sessionPath.replace(/^\//, "")))
    .replaceAll("__WS_PATH__", JSON.stringify(effective.wsPath.replace(/^\//, "")))
    .replaceAll("__UP_PATH__", JSON.stringify(effective.upPath.replace(/^\//, "")))
    .replaceAll("__DOWN_PATH__", JSON.stringify(effective.downPath.replace(/^\//, "")))
    .replaceAll("__WS_AUTO_FALLBACK__", effective.wsAutoFallback ? "true" : "false");
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    "connect-src 'self' https://" + host + ":* wss://" + host + ":* https://" + host + " wss://" + host,
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
  STATS.bridgeOk++;
  logEvent("bridge_ok", `host=${host} profile=${effective.activeProfileId} carrier=${effective.carrier}`);
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

// Builds a bounded, port-diverse DC connection plan so multi-IP DCs (like DC2
// with 4 IPs) do not spend all 4 attempts exclusively on port 443.
// Soft-deprioritizes endpoints that failed within DC_COOLDOWN_TTL_MS while
// keeping them available if all healthy candidates fail.
function buildDcAttemptPlan(candidateIps, candidatePorts, maxAttempts = 4, now = Date.now()) {
  const ips = (Array.isArray(candidateIps) ? candidateIps : [candidateIps]).filter(Boolean).slice();
  const ports = (Array.isArray(candidatePorts) && candidatePorts.length ? candidatePorts : [443]).slice();
  if (!ips.length || !ports.length) return [];

  for (let i = ips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ips[i], ips[j]] = [ips[j], ips[i]];
  }

  const limit = Math.max(1, Math.min(maxAttempts, ips.length * ports.length));
  const picked = [];
  const seen = new Set();
  const addPair = (ip, port) => {
    const k = ip + ":" + port;
    if (seen.has(k)) return false;
    seen.add(k);
    picked.push([ip, port]);
    return true;
  };

  // Pick up to 2 distinct IPs on primary port (preferring healthy endpoints first)
  const primaryPort = ports[0];
  const primaryLimit = Math.min(ports.length > 1 ? 2 : limit, ips.length, limit);
  const primaryOrder = ips.slice().sort((a, b) => Number(isDcCooledDown(a, primaryPort, now)) - Number(isDcCooledDown(b, primaryPort, now)));
  let ipCursor = 0;
  for (let i = 0; i < primaryOrder.length && picked.length < primaryLimit; i++) {
    addPair(primaryOrder[i], primaryPort);
    ipCursor++;
  }

  // Ensure every fallback port (e.g. 80, 5222) gets a distinct IP within the attempt budget
  for (let pIdx = 1; pIdx < ports.length && picked.length < limit; pIdx++) {
    const port = ports[pIdx];
    let chosen = null;
    for (let step = 0; step < ips.length; step++) {
      const candidate = ips[(ipCursor + step) % ips.length];
      if (!seen.has(candidate + ":" + port) && !isDcCooledDown(candidate, port, now)) {
        chosen = candidate;
        ipCursor = (ipCursor + step + 1) % ips.length;
        break;
      }
    }
    if (!chosen) {
      chosen = ips[ipCursor % ips.length];
      ipCursor = (ipCursor + 1) % ips.length;
    }
    addPair(chosen, port);
  }

  // Fill any remaining slots without duplicates
  for (const port of ports) {
    for (const ip of ips) {
      if (picked.length >= limit) break;
      addPair(ip, port);
    }
    if (picked.length >= limit) break;
  }

  // Stable partition: healthy pairs first, recently failed pairs second
  const healthy = [];
  const cooled = [];
  for (const pair of picked) {
    if (isDcCooledDown(pair[0], pair[1], now)) cooled.push(pair);
    else healthy.push(pair);
  }
  return healthy.concat(cooled).slice(0, limit);
}

async function resolveSecretForMode(cfg, mode, host, port) {
  let secret = cfg.base;
  if (mode >= PROFILE_MODE_BASE && mode < PROFILE_MODE_BASE + OPERATOR_PROFILES.length) {
    const prof = OPERATOR_PROFILES[mode - PROFILE_MODE_BASE];
    secret = cfg.profileSecrets?.[prof.id]?.secret || cfg.base;
  } else if (mode >= PORT_MODE_BASE && mode < PORT_MODE_BASE + HTTPS_PORTS.length) {
    const portNum = HTTPS_PORTS[mode - PORT_MODE_BASE];
    secret = cfg.portSecrets?.[portNum]?.secret || cfg.base;
  } else if (mode === 1 || mode === 2) {
    const label = mode === 2 && port && port !== "443" && port !== "80" ? `${host}:${port}` : host;
    secret = await deriveSecret(cfg, label);
  }
  return secret || null;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

class Stream {
  constructor(session, id) {
    this.session = session;
    this.id = id;
    STATS.streams++;
    session.streamCount++;
    this.phase = "header";
    this.header = new Uint8Array(64);
    this.headerLength = 0;
    this.dead = false;
    this.socket = null;
    this.pendingSocket = null;
    this.abortConnect = null;
    this.dialWaitCancel = null;
    this.downlinkWaitCancel = null;
    this.writeTimer = null;
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

  dequeueReadyBatch() {
    const first = this.inQueue.shift();
    if (!first) return null;
    const maxBatch = this.session.cfg.dataChunk || 65536;
    if (!this.inQueue.length || first.length >= maxBatch) {
      this.queuedLocal -= first.length;
      this.session.queued -= first.length;
      return first;
    }
    const parts = [first];
    let total = first.length;
    while (this.inQueue.length && total + this.inQueue[0].length <= maxBatch) {
      const next = this.inQueue.shift();
      parts.push(next);
      total += next.length;
    }
    this.queuedLocal -= total;
    this.session.queued -= total;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  async runIn() {
    if (this.inRunning || this.dead) return;
    this.inRunning = true;
    try {
      while (!this.dead && this.inQueue.length) {
        if (this.phase === "header") {
          let payload = this.inQueue[0];
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
        const batch = this.dequeueReadyBatch();
        if (batch) await this.writeToDc(batch);
      }
    } catch (_) {
      this.kill(true);
    } finally {
      this.inRunning = false;
      if (!this.dead && this.inQueue.length) this.runIn();
    }
  }

  async writeWithTimeout(bytes) {
    if (this.dead || !this.writer) throw new Error("stream dead");
    const timeoutMs = this.session.cfg.dcWriteTimeoutMs || 25000;
    let timer = null;
    try {
      const writePromise = this.writer.write(bytes);
      writePromise.catch(() => {});
      await Promise.race([
        writePromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("dc write timeout")), timeoutMs);
          this.writeTimer = timer;
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.writeTimer === timer) this.writeTimer = null;
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
    if (!tagKind(tag)) {
      STATS.streamsHeaderFail++;
      logEvent("header_fail", "bad protocol tag");
      throw new Error("bad tag");
    }
    const dcId = new DataView(tail.buffer, tail.byteOffset + 4, 2).getInt16(0, true);
    const dcKey = Math.abs(dcId);
    const address = this.session.cfg.dc[dcKey];
    if (!address) {
      STATS.streamsHeaderFail++;
      logEvent("header_fail", `unknown dc=${dcKey}`);
      throw new Error("bad dc");
    }
    STATS.streamsHeaderOk++;

    const candidateIps = Array.isArray(address) ? address : [address];
    const candidatePorts = Array.isArray(this.session.cfg.dcPorts) ? this.session.cfg.dcPorts : [this.session.cfg.dcPort || 443];

    // Middle-End / Ad Tag Routing Check:
    // Native ME handshake requires preserving outbound TCP source port which
    // Cloudflare Workers' NAPT does not support; Direct-DC mode is always used.
    if (this.session.cfg.adTag && this.session.cfg.debug && !this.session.loggedMeNotice) {
      this.session.loggedMeNotice = true;
      console.log("[tgweb] AD_TAG is set but inactive in Direct-DC mode (Cloudflare egress NAPT translates source ports).");
    }

    const reversed = reverse(header.subarray(8, 56));
    const writeKey = await sha256(concat(reversed.subarray(0, 32), this.session.secret));
    const clientWriteIv = reversed.slice(32, 48);

    // FAST MODE: choose dcHeader[8..56] = reverse(clientWriteKey || clientWriteIv)
    // so DC->client bytes are encrypted with the exact keystream client expects.
    const dcKeyMaterial = reverse(concat(writeKey, clientWriteIv)); // 48 bytes
    this.dcWriteKey = await importAes(dcKeyMaterial.slice(0, 32));
    this.dcWriteIv = dcKeyMaterial.slice(32, 48);
    if (this.dead) return;
    this.clientReadPos = 64;
    this.clientWritePos = 0;
    this.dcWritePos = 64;
    this.dcReadPos = 0;

    // Bounded, port-diverse DC failover respecting Cloudflare Free limits:
    // - at most 4 attempts covering multiple IPs AND fallback ports (443, 80, 5222)
    // - bounded per-attempt (2.2s) and total (7.5s) deadlines
    // - per-session dial semaphore (<= 4 concurrent connects, below CF limit of 6)
    // - immediate close of timed-out / aborted sockets to prevent slot leaks
    let socket = null;
    let lastError = null;
    const attempts = buildDcAttemptPlan(candidateIps, candidatePorts, this.session.cfg.dcMaxAttempts || 4);
    const totalDeadline = Date.now() + (this.session.cfg.dcTotalTimeoutMs || 7500);

    for (let a = 0; a < attempts.length && !socket; a++) {
      if (this.dead) return;
      const remaining = totalDeadline - Date.now();
      if (remaining < 400) {
        lastError = lastError || new Error("dc connect budget exceeded");
        break;
      }
      if (this.session.tryReserveSubrequest && !this.session.tryReserveSubrequest()) {
        lastError = new Error("subrequest budget reached");
        break;
      }
      const attemptTimeout = Math.min(this.session.cfg.dcConnectTimeoutMs || 2200, remaining);
      const [hostIp, port] = attempts[a];

      let acquired = false;
      if (this.session.acquireDialSlot) {
        acquired = await this.session.acquireDialSlot(this);
        if (!acquired || this.dead) {
          if (acquired) this.session.releaseDialSlot();
          return;
        }
      }

      STATS.dcAttempts++;
      let candidateSocket = null;
      let timer = null;
      let abortReject = null;
      try {
        candidateSocket = connect({ hostname: hostIp, port }, { secureTransport: "off" });
        this.pendingSocket = candidateSocket;
        candidateSocket.closed.catch(() => {});
        candidateSocket.opened.catch(() => {});
        const guardPromise = new Promise((_, reject) => {
          abortReject = reject;
          timer = setTimeout(() => reject(new Error("connect timeout")), attemptTimeout);
        });
        this.abortConnect = () => {
          if (abortReject) abortReject(new Error("stream aborted"));
        };
        await Promise.race([candidateSocket.opened, guardPromise]);
        if (this.dead) {
          try { candidateSocket.close().catch(() => {}); } catch (_) {}
          return;
        }
        socket = candidateSocket;
        clearDcCooldown(hostIp, port);
        STATS.dcOk++;
        if (port === 443) STATS.dcOk443++;
        else if (port === 80) STATS.dcOk80++;
        else if (port === 5222) STATS.dcOk5222++;
      } catch (connErr) {
        lastError = connErr;
        if (!this.dead) {
          STATS.dcFails++;
          const msg = String(connErr && connErr.message ? connErr.message : connErr);
          if (/timeout/i.test(msg)) STATS.dcTimeouts++;
          else STATS.dcErrors++;
          markDcCooldown(hostIp, port);
        }
        if (candidateSocket) { try { candidateSocket.close().catch(() => {}); } catch (_) {} }
      } finally {
        if (timer) clearTimeout(timer);
        this.abortConnect = null;
        this.pendingSocket = null;
        if (acquired && this.session.releaseDialSlot) this.session.releaseDialSlot();
      }
    }

    if (!socket) {
      logEvent("dc_fail", `dc=${dcKey} attempts=${attempts.length}`);
      throw lastError || new Error("failed to connect to DC");
    }

    this.socket = socket;
    if (this.dead) {
      try { await socket.close(); } catch (_) {}
      return;
    }
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();

    // Construct and send initial Obfuscated2 header to the Telegram DC.
    // Once bytes are written to this socket, this stream is bound strictly to
    // this DC TCP connection — never replayed on a second socket if it fails.
    const dcHeader = new Uint8Array(64);
    let safe = false;
    for (let i = 0; i < 16 && !safe; i++) {
      crypto.getRandomValues(dcHeader.subarray(0, 8));
      safe = safeDcHeaderPrefix(dcHeader);
    }
    if (!safe) dcHeader.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], 0);
    dcHeader.set(dcKeyMaterial, 8);
    dcHeader.set(tag, 56);
    const dcView = new DataView(dcHeader.buffer);
    dcView.setInt16(60, dcId, true);
    dcView.setUint16(62, 0, true);
    const encryptedTail = await ctrAt(this.dcWriteKey, this.dcWriteIv, 56, dcHeader.subarray(56, 64));
    dcHeader.set(encryptedTail, 56);
    await this.writeWithTimeout(dcHeader);
    if (this.dead) return;
    this.phase = "ready";
    const pumpPromise = this.pump().catch(() => this.kill(true));
    if (this.session.trackBackground) this.session.trackBackground(pumpPromise);
  }

  async writeToDc(payload) {
    if (this.dead) return;
    const plain = await ctrAt(this.clientReadKey, this.clientReadIv, this.clientReadPos, payload);
    this.clientReadPos += payload.length;
    if (this.dead) return;
    const encrypted = await ctrAt(this.dcWriteKey, this.dcWriteIv, this.dcWritePos, plain);
    this.dcWritePos += payload.length;
    await this.writeWithTimeout(encrypted);
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
        if (this.session.waitDownlinkReady) {
          await this.session.waitDownlinkReady(this);
          if (this.dead) break;
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
          if (this.session.waitDownlinkReady) {
            await this.session.waitDownlinkReady(this);
            if (this.dead) break;
          }
          const size = Math.min(value.length - offset, this.sendCredit, this.session.cfg.dataChunk);
          if (size <= 0) continue;
          // Fast mode: bytes from the DC are already encrypted for the client.
          const chunk = value.subarray(offset, offset + size);
          this.sendCredit -= size;
          this.session.sendFrame(frame(0x02, this.id, chunk), false);
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
    this.session.sendFrame(windowFrame(this.id, amount), true);
  }

  kill(notify) {
    if (this.dead) return;
    this.dead = true;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.abortConnect) {
      const fn = this.abortConnect;
      this.abortConnect = null;
      try { fn(); } catch (_) {}
    }
    if (this.dialWaitCancel) {
      const fn = this.dialWaitCancel;
      this.dialWaitCancel = null;
      try { fn(); } catch (_) {}
    }
    if (this.downlinkWaitCancel) {
      const fn = this.downlinkWaitCancel;
      this.downlinkWaitCancel = null;
      try { fn(); } catch (_) {}
    }
    if (this.pendingSocket) {
      try { this.pendingSocket.close().catch(() => {}); } catch (_) {}
      this.pendingSocket = null;
    }
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
    // Free stream locks immediately to prevent socket exhaustion and resource leaks in Cloudflare Workers
    if (this.writer) {
      try { this.writer.releaseLock(); } catch (_) {}
      this.writer = null;
    }
    if (this.reader) {
      try { this.reader.cancel().catch(() => {}); this.reader.releaseLock(); } catch (_) {}
      this.reader = null;
    }
    if (this.socket) {
      try { this.socket.close().catch(() => {}); } catch (_) {}
      this.socket = null;
    }
    if (notify && !this.session.closed) this.session.sendFrame(frame(0x03, this.id, EMPTY), true);
    this.session.onStreamClosed(this.id);
  }
}

class WsSession {
  constructor(ws, cfg, secret, laneId = 0) {
    this.laneId = laneId; // > 0: this WebSocket carries exactly one stream (websocket-lanes)
    this.laneUsed = false;
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
    this.lastActivity = Date.now();
    this.openedAt = Date.now();
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.streamCount = 0;
    this.activeDials = 0;
    this.dialWaiters = [];
    this.subrequestsUsed = 0;
    this.budgetExhausted = false;
    STATS.sessions++;
    STATS.sessionsActive++;
    if (laneId) STATS.wsLanesOpened++;
    else STATS.wsMuxOpened++;
    logEvent("session_open", `lane=${laneId} carrier=${cfg.carrier}`);

    // Multiplexed WS: 25s server keepalive PING + 90s watchdog.
    // Lane WS: server never emits unsolicited id=0 frames (preserving strict
    // tproxy-lane-v1 compatibility); instead replies to bridge PINGs and runs
    // a 120s idle watchdog so abandoned half-open lanes release resources.
    this.keepAliveTimer = laneId
      ? setInterval(() => {
          if (this.closed || !this.ws || this.ws.readyState !== 1) {
            if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
            return;
          }
          if (Date.now() - this.lastActivity > 120000) {
            this.shutdown("lane idle watchdog");
          }
        }, 30000)
      : setInterval(() => {
          if (this.closed || !this.ws || this.ws.readyState !== 1) {
            if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
            return;
          }
          if (Date.now() - Math.max(this.lastPong, this.lastActivity) > 90000) {
            this.shutdown("pong watchdog");
            return;
          }
          try {
            const pingPayload = new Uint8Array(4);
            new DataView(pingPayload.buffer).setUint32(0, Math.floor(Date.now() / 1000), false);
            this.sendFrame(frame(0x05, 0, pingPayload), true);
          } catch (_) {}
        }, 25000);
  }

  tryReserveSubrequest() {
    if (this.laneId) {
      // Each lane runs in its own Worker invocation (fresh 50-subrequest budget).
      if (this.subrequestsUsed >= WS_SUBREQ_SOFT_LIMIT) return false;
      this.subrequestsUsed++;
      return true;
    }
    if (this.subrequestsUsed >= WS_SUBREQ_SOFT_LIMIT) {
      this.budgetExhausted = true;
      logEvent("subreq_budget", "mux rotating ws");
      return false;
    }
    this.subrequestsUsed++;
    return true;
  }

  acquireDialSlot(stream) {
    if (this.closed || stream.dead) return Promise.resolve(false);
    const maxDials = this.cfg.dcMaxConcurrentDials || 4;
    if (this.activeDials < maxDials) {
      this.activeDials++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        done: false,
        wake: (ok) => {
          if (waiter.done) return;
          waiter.done = true;
          stream.dialWaitCancel = null;
          resolve(ok);
        }
      };
      stream.dialWaitCancel = () => {
        const idx = this.dialWaiters.indexOf(waiter);
        if (idx >= 0) this.dialWaiters.splice(idx, 1);
        waiter.wake(false);
      };
      this.dialWaiters.push(waiter);
    });
  }

  releaseDialSlot() {
    this.activeDials = Math.max(0, this.activeDials - 1);
    const maxDials = this.cfg.dcMaxConcurrentDials || 4;
    while (!this.closed && this.activeDials < maxDials && this.dialWaiters.length) {
      const next = this.dialWaiters.shift();
      if (next && !next.done) {
        this.activeDials++;
        next.wake(true);
      }
    }
  }

  sendFrame(bytes) {
    if (this.closed) return;
    try {
      this.ws.send(bytes);
      this.lastActivity = Date.now();
      this.bytesDown += bytes.length;
      STATS.bytesDown += bytes.length;
    } catch (_) {
      this.dispose();
    }
  }

  onStreamClosed(id) {
    if (this.closed) return;
    if (this.laneId && id === this.laneId) {
      // Lane finished: close this WebSocket so the invocation (and its budget) ends.
      this.dispose();
      try { if (this.ws.readyState === 1) this.ws.close(1000, "done"); } catch (_) {}
      return;
    }
    if (!this.laneId && this.budgetExhausted && this.streams.size === 0) {
      // Gracefully ask the bridge to reconnect into a fresh Worker invocation.
      this.dispose();
      try { if (this.ws.readyState === 1) this.ws.close(1012, "rotate"); } catch (_) {}
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
    this.lastActivity = Date.now();
    this.bytesUp += bytes.length;
    STATS.bytesUp += bytes.length;
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
      if (this.laneId && id !== this.laneId && !(id === 0 && (type === 0x05 || type === 0x06))) {
        this.shutdown();
        return;
      }
      if (type === 0x01) {
        // OPEN frame
        if (id === 0 || size !== 0) {
          this.shutdown();
          return;
        }
        if (this.laneId) {
          if (this.laneUsed) { this.shutdown(); return; }
          this.laneUsed = true;
          this.streams.set(id, new Stream(this, id));
          continue;
        }
        if (this.budgetExhausted) {
          this.sendFrame(frame(0x03, id, EMPTY), true);
          if (this.streams.size === 0) {
            this.dispose();
            try { if (this.ws.readyState === 1) this.ws.close(1012, "rotate"); } catch (_) {}
            return;
          }
          continue;
        }
        if (this.streams.has(id) || this.tombstones.has(id) || this.streams.size >= this.cfg.maxStreams) {
          this.sendFrame(frame(0x03, id, EMPTY), true);
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
        else if (!this.tombstones.has(id)) this.sendFrame(frame(0x03, id, EMPTY), true);
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
        // PING frame from client (0x05) -> respond with PONG (0x06) echoing payload.
        if (id === 0) {
          if (size > 64) {
            this.shutdown();
            return;
          }
          this.sendFrame(frame(0x06, 0, payload), true);
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
    STATS.sessionsActive = Math.max(0, STATS.sessionsActive - 1);
    logEvent("session_close", `${fmtDuration(Date.now() - this.openedAt)} streams=${this.streamCount} up=${fmtBytes(this.bytesUp)} down=${fmtBytes(this.bytesDown)}`);
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    for (const waiter of this.dialWaiters.splice(0)) waiter.wake(false);
    for (const stream of Array.from(this.streams.values())) stream.kill(false);
    this.streams.clear();
    this.tombstones.clear();
    this.tombstoneOrder.length = 0;
    this.queued = 0;
  }

  shutdown(reason) {
    logEvent("session_kill", reason || "protocol");
    this.dispose();
    try {
      if (this.ws.readyState === 1) this.ws.close(1011, "closed");
    } catch (_) {}
  }
}

// ---- Optional Durable Object HTTPS Long-Polling Session (CARRIER=https) ----
// Only used when an operator explicitly binds a SQLite Durable Object as PROXY_DO
// AND sets CARRIER=https. Stateless Free-plan deployments never instantiate this
// class and require zero bindings.
function parseFrameBatchStrict(bytes) {
  if (!bytes || !bytes.length || bytes.length > REQUEST_LIMIT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let offset = 0;
  let dataBytes = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8 || out.length >= 4096) return null;
    const type = bytes[offset];
    const id = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const size = view.getUint32(offset + 4, false);
    const end = offset + 8 + size;
    if (size > 1048576 || end > bytes.length) return null;
    const payload = bytes.subarray(offset + 8, end);
    offset = end;
    if (type === 0x01 || type === 0x03) {
      if (id === 0 || size !== 0) return null;
    } else if (type === 0x02) {
      if (id === 0 || size === 0) return null;
      dataBytes += size;
    } else if (type === 0x04) {
      if (id === 0 || size !== 4) return null;
    } else if (type === 0x05) {
      if (id !== 0 || size > 64) return null;
    } else if (type === 0x06) {
      if (id !== 0 || size > 64) return null;
    } else {
      return null;
    }
    out.push({ type, id, payload });
  }
  if (!out.length) return null;
  return { frames: out, dataBytes };
}

class HttpSession {
  constructor(state, cfg, secret, tokenHash) {
    this.state = state;
    this.cfg = cfg;
    this.secret = secret;
    this.tokenHash = tokenHash;
    this.streams = new Map();
    this.closed = false;
    this.queued = 0;
    this.tombstones = new Set();
    this.tombstoneOrder = [];
    this.loggedMeNotice = false;
    this.streamCount = 0;
    this.activeDials = 0;
    this.dialWaiters = [];
    this.lastActivity = Date.now();

    // Uplink serialization & byte-identical retry state (PROTOCOL.md)
    this.nextUpSeq = 1;
    this.lastUpSeq = 0;
    this.lastUpLen = 0;
    this.lastUpHash = null;
    this.upInFlight = 0;

    // Downlink cursor, replay cache, control headroom & newest-poll-wins state
    this.downCursor = 0;
    this.unackedPrevCursor = -1;
    this.unackedBatch = null;
    this.unackedDataBytes = 0;
    this.downFrames = []; // { bytes, isControl, isWindow, streamId, winAmount }
    this.downDataBytes = 0;
    this.downlinkWaiters = [];
    this.parkedPoll = null;
  }

  trackBackground(promise) {
    try {
      if (this.state && typeof this.state.waitUntil === "function") {
        this.state.waitUntil(promise);
      }
    } catch (_) {}
  }

  touch() {
    this.lastActivity = Date.now();
    try {
      if (this.state?.storage && typeof this.state.storage.setAlarm === "function") {
        this.state.storage.setAlarm(this.lastActivity + (this.cfg.httpsIdleTimeoutMs || 90000)).catch(() => {});
      }
    } catch (_) {}
  }

  acquireDialSlot(stream) {
    if (this.closed || stream.dead) return Promise.resolve(false);
    const maxDials = this.cfg.dcMaxConcurrentDials || 4;
    if (this.activeDials < maxDials) {
      this.activeDials++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        done: false,
        wake: (ok) => {
          if (waiter.done) return;
          waiter.done = true;
          stream.dialWaitCancel = null;
          resolve(ok);
        }
      };
      stream.dialWaitCancel = () => {
        const idx = this.dialWaiters.indexOf(waiter);
        if (idx >= 0) this.dialWaiters.splice(idx, 1);
        waiter.wake(false);
      };
      this.dialWaiters.push(waiter);
    });
  }

  releaseDialSlot() {
    this.activeDials = Math.max(0, this.activeDials - 1);
    const maxDials = this.cfg.dcMaxConcurrentDials || 4;
    while (!this.closed && this.activeDials < maxDials && this.dialWaiters.length) {
      const next = this.dialWaiters.shift();
      if (next && !next.done) {
        this.activeDials++;
        next.wake(true);
      }
    }
  }

  waitDownlinkReady(stream) {
    const cap = this.cfg.httpsDownDataCap || 4194304;
    if (this.closed || stream.dead || this.downDataBytes + this.unackedDataBytes < cap) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        done: false,
        wake: () => {
          if (waiter.done) return;
          waiter.done = true;
          stream.downlinkWaitCancel = null;
          resolve();
        }
      };
      stream.downlinkWaitCancel = () => {
        const idx = this.downlinkWaiters.indexOf(waiter);
        if (idx >= 0) this.downlinkWaiters.splice(idx, 1);
        waiter.wake();
      };
      this.downlinkWaiters.push(waiter);
    });
  }

  notifyDownlinkDrain() {
    const cap = this.cfg.httpsDownDataCap || 4194304;
    if (this.downDataBytes + this.unackedDataBytes >= cap) return;
    for (const waiter of this.downlinkWaiters.splice(0)) waiter.wake();
  }

  sendFrame(bytes, isControl) {
    if (this.closed) return;
    // Coalesce queued WINDOW frames for the same stream while pending (PROTOCOL.md)
    if (isControl && bytes.length === 12 && bytes[0] === 0x04) {
      const id = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
      const delta = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, false);
      for (let i = this.downFrames.length - 1; i >= 0; i--) {
        const entry = this.downFrames[i];
        if (entry.isWindow && entry.streamId === id) {
          const nextAmt = Math.min(0xffffffff, entry.winAmount + delta);
          entry.winAmount = nextAmt;
          entry.bytes = windowFrame(id, nextAmt);
          this.wakeParkedPoll();
          return;
        }
      }
      this.downFrames.push({ bytes, isControl: true, isWindow: true, streamId: id, winAmount: delta });
      this.wakeParkedPoll();
      return;
    }
    this.downFrames.push({ bytes, isControl: !!isControl, isWindow: false, streamId: 0, winAmount: 0 });
    if (!isControl) this.downDataBytes += bytes.length;
    this.wakeParkedPoll();
  }

  onStreamClosed() {}

  remember(id) {
    if (this.tombstones.has(id)) return;
    if (this.tombstoneOrder.length === 4096) this.tombstones.delete(this.tombstoneOrder.shift());
    this.tombstones.add(id);
    this.tombstoneOrder.push(id);
  }

  wakeParkedPoll() {
    if (!this.parkedPoll) return;
    const poll = this.parkedPoll;
    this.parkedPoll = null;
    if (poll.timer) clearTimeout(poll.timer);
    poll.resolve(this.buildDownBatchResponse(poll.cursor));
  }

  buildDownBatchResponse(ackCursor) {
    if (this.closed) return notFound();
    const maxBytes = this.cfg.httpsDownBatch || this.cfg.batchBytes || 524288;
    const picked = [];
    let totalBytes = 0;
    let dataBytes = 0;
    while (this.downFrames.length && picked.length < 4096) {
      const next = this.downFrames[0];
      if (picked.length > 0 && totalBytes + next.bytes.length > maxBytes) break;
      this.downFrames.shift();
      picked.push(next);
      totalBytes += next.bytes.length;
      if (!next.isControl) {
        this.downDataBytes = Math.max(0, this.downDataBytes - next.bytes.length);
        dataBytes += next.bytes.length;
      }
    }
    if (!picked.length) {
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Down-Cursor": String(ackCursor) }
      });
    }
    const body = new Uint8Array(totalBytes);
    let off = 0;
    for (const item of picked) {
      body.set(item.bytes, off);
      off += item.bytes.length;
    }
    this.downCursor++;
    this.unackedPrevCursor = ackCursor;
    this.unackedBatch = body;
    this.unackedDataBytes = dataBytes;
    STATS.bytesDown += totalBytes;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Down-Cursor": String(this.downCursor)
      }
    });
  }

  async handleUp(seq, rawBody) {
    if (this.closed) return notFound();
    this.touch();
    if (this.upInFlight === seq) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    }
    const bytes = new Uint8Array(rawBody);
    if (seq === this.lastUpSeq && this.lastUpHash) {
      if (bytes.length !== this.lastUpLen) return notFound();
      const digest = await sha256(bytes);
      if (!bytesEqual(digest, this.lastUpHash)) return notFound();
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Up-Ack": String(seq) }
      });
    }
    if (seq !== this.nextUpSeq) return notFound();
    const parsed = parseFrameBatchStrict(bytes);
    if (!parsed) {
      this.dispose();
      return notFound();
    }
    if (this.queued + parsed.dataBytes > this.cfg.maxQueued) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    }
    this.upInFlight = seq;
    try {
      const digest = await sha256(bytes);
      if (this.closed) return notFound();
      STATS.bytesUp += bytes.length;
      for (const f of parsed.frames) {
        if (f.type === 0x01) {
          if (this.streams.has(f.id) || this.tombstones.has(f.id) || this.streams.size >= this.cfg.maxStreams) {
            this.sendFrame(frame(0x03, f.id, EMPTY), true);
            continue;
          }
          this.streams.set(f.id, new Stream(this, f.id));
        } else if (f.type === 0x02) {
          const stream = this.streams.get(f.id);
          if (stream) stream.feed(f.payload);
          else if (!this.tombstones.has(f.id)) this.sendFrame(frame(0x03, f.id, EMPTY), true);
        } else if (f.type === 0x03) {
          const stream = this.streams.get(f.id);
          if (stream) stream.kill(false);
        } else if (f.type === 0x04) {
          const stream = this.streams.get(f.id);
          if (stream) stream.addCredit(new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0, false));
        } else if (f.type === 0x05) {
          this.sendFrame(frame(0x06, 0, f.payload), true);
        }
      }
      this.lastUpSeq = seq;
      this.lastUpLen = bytes.length;
      this.lastUpHash = digest;
      this.nextUpSeq = seq + 1;
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Up-Ack": String(seq) }
      });
    } finally {
      if (this.upInFlight === seq) this.upInFlight = 0;
    }
  }

  handleDown(reqCursor) {
    if (this.closed) return Promise.resolve(notFound());
    this.touch();
    // Case 1: client repeats previous cursor -> replay unacknowledged batch byte-for-byte
    if (this.unackedBatch && reqCursor === this.unackedPrevCursor) {
      if (this.parkedPoll) {
        const old = this.parkedPoll;
        this.parkedPoll = null;
        if (old.timer) clearTimeout(old.timer);
        old.resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Down-Cursor": String(old.cursor) } }));
      }
      return Promise.resolve(new Response(this.unackedBatch, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Down-Cursor": String(this.downCursor)
        }
      }));
    }
    // Case 2: client acknowledges current cursor
    if (reqCursor !== this.downCursor) return Promise.resolve(notFound());
    if (this.unackedBatch) {
      this.unackedBatch = null;
      this.unackedPrevCursor = -1;
      this.unackedDataBytes = 0;
      this.notifyDownlinkDrain();
    }
    // Newest-poll-wins: release older parked poll harmlessly with 204
    if (this.parkedPoll) {
      const old = this.parkedPoll;
      this.parkedPoll = null;
      if (old.timer) clearTimeout(old.timer);
      old.resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Down-Cursor": String(old.cursor) } }));
    }
    if (this.downFrames.length > 0) {
      return Promise.resolve(this.buildDownBatchResponse(reqCursor));
    }
    return new Promise((resolve) => {
      const poll = {
        cursor: reqCursor,
        resolve,
        timer: setTimeout(() => {
          if (this.parkedPoll === poll) {
            this.parkedPoll = null;
            resolve(new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Down-Cursor": String(reqCursor) } }));
          }
        }, this.cfg.httpsPollTimeoutMs || 25000)
      };
      this.parkedPoll = poll;
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.parkedPoll) {
      const old = this.parkedPoll;
      this.parkedPoll = null;
      if (old.timer) clearTimeout(old.timer);
      old.resolve(notFound());
    }
    for (const waiter of this.dialWaiters.splice(0)) waiter.wake(false);
    for (const waiter of this.downlinkWaiters.splice(0)) waiter.wake();
    for (const stream of Array.from(this.streams.values())) stream.kill(false);
    this.streams.clear();
    this.tombstones.clear();
    this.tombstoneOrder.length = 0;
    this.downFrames.length = 0;
    this.downDataBytes = 0;
    this.unackedBatch = null;
    this.unackedDataBytes = 0;
    this.queued = 0;
    try {
      if (this.state?.storage && typeof this.state.storage.deleteAlarm === "function") {
        this.state.storage.deleteAlarm().catch(() => {});
      }
    } catch (_) {}
  }
}

export class ProxySessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = null;
  }

  async alarm() {
    if (!this.session || this.session.closed) {
      this.session = null;
      return;
    }
    const idleLimit = this.session.cfg.httpsIdleTimeoutMs || 90000;
    const elapsed = Date.now() - this.session.lastActivity;
    if (elapsed >= idleLimit - 5000) {
      this.session.dispose();
      this.session = null;
    } else if (this.state?.storage && typeof this.state.storage.setAlarm === "function") {
      try { await this.state.storage.setAlarm(this.session.lastActivity + idleLimit); } catch (_) {}
    }
  }

  async fetch(request, init) {
    try {
      const req = request instanceof Request ? request : new Request(request, init);
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") || "";
      if (!auth.startsWith("Bearer ") || auth.length <= 7) return notFound();
      const token = auth.substring(7);
      const cfg = await getRuntime(this.env);
      if (!cfg) return notFound();
      const verified = await verifyToken(cfg, token, TOKEN_KIND_SESSION);
      if (!verified) return notFound();
      if ((verified.mode === 1 || verified.mode === 2) && !cfg.acceptGenerated) return notFound();
      const tokenHash = await sha256(te.encode(token));

      if (url.pathname === "/init" && req.method === "POST") {
        if (this.session && !this.session.closed) {
          if (bytesEqual(this.session.tokenHash, tokenHash)) {
            this.session.touch();
            return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
          }
          return notFound();
        }
        const host = String(req.headers.get("x-proxy-host") || "").toLowerCase();
        const port = parseValidPort(req.headers.get("x-proxy-port") || "");
        const secret = await resolveSecretForMode(cfg, verified.mode, host, port);
        if (!secret) return notFound();
        const effective = resolveProfileConfig(cfg, verified.mode);
        this.session = new HttpSession(this.state, effective, secret, tokenHash);
        this.session.touch();
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/session" && req.method === "DELETE") {
        if (this.session && bytesEqual(this.session.tokenHash, tokenHash)) {
          this.session.dispose();
          this.session = null;
        }
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }

      if (!this.session || this.session.closed || !bytesEqual(this.session.tokenHash, tokenHash)) {
        return notFound();
      }

      if (url.pathname === "/up" && req.method === "POST") {
        const seqStr = (req.headers.get("x-up-seq") || "").trim();
        if (!/^[1-9][0-9]{0,12}$/.test(seqStr)) return notFound();
        const body = await req.arrayBuffer();
        return await this.session.handleUp(parseInt(seqStr, 10), body);
      }

      if (url.pathname === "/down" && req.method === "POST") {
        const curStr = (req.headers.get("x-down-cursor") || "").trim();
        if (!/^(0|[1-9][0-9]{0,12})$/.test(curStr)) return notFound();
        return await this.session.handleDown(parseInt(curStr, 10));
      }

      return notFound();
    } catch (error) {
      reportError("do_fetch", error);
      return notFound();
    }
  }
}

async function serveSession(request, env, cfg, host, port) {
  const auth = request.headers.get("authorization") || "";
  if ((request.method === "GET" || request.method === "HEAD") && !auth) {
    return await decoy(cfg.decoyUrl, request.method, "/", host);
  }
  if (!auth.startsWith("Bearer ") || auth.length <= 7) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  const token = auth.substring(7);
  if (request.method === "DELETE") {
    const verified = await verifyToken(cfg, token, TOKEN_KIND_SESSION);
    if (!verified) return notFound();
    if (cfg.hasDoBinding && env?.PROXY_DO) {
      try {
        const stub = env.PROXY_DO.get(env.PROXY_DO.idFromName("s:" + bytesToHex(verified.nonce)));
        await stub.fetch(new Request("https://do.internal/session", {
          method: "DELETE",
          headers: { Authorization: "Bearer " + token }
        }));
      } catch (_) {}
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  if (request.headers.get("cookie")) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  if ((request.headers.get("content-type") || "").toLowerCase() !== "application/octet-stream") {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  // The handshake body is a fixed 9 bytes. Reject an oversized declared body
  // before buffering it to protect isolate memory (128 MB shared).
  const declaredLength = parseInt(request.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > 4096) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  const verified = await verifyToken(cfg, token, TOKEN_KIND_BOOTSTRAP);
  if (!verified) {
    STATS.sessionCreateRejects++;
    logEvent("session_reject", "bad or expired bootstrap token");
    return notFound();
  }
  if ((verified.mode === 1 || verified.mode === 2) && !cfg.acceptGenerated) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length !== 9) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  if (body[0] !== 0x10 || body[1] !== 0 || body[2] !== 0 || body[3] !== 0) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  if (body[4] !== 0 || body[5] !== 0 || body[6] !== 0 || body[7] !== 1 || body[8] !== 1) {
    STATS.sessionCreateRejects++;
    return notFound();
  }
  const effective = resolveProfileConfig(cfg, verified.mode);
  const sessionToken = await issueToken(cfg, TOKEN_KIND_SESSION, effective.sessionTtl, verified.mode);

  if (effective.carrier === "https" && cfg.hasDoBinding && env?.PROXY_DO) {
    const parsedSession = await verifyToken(cfg, sessionToken, TOKEN_KIND_SESSION);
    if (!parsedSession) return notFound();
    const stub = env.PROXY_DO.get(env.PROXY_DO.idFromName("s:" + bytesToHex(parsedSession.nonce)));
    const initRes = await stub.fetch(new Request("https://do.internal/init", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sessionToken,
        "X-Proxy-Host": host,
        "X-Proxy-Port": port || "443"
      }
    }));
    if (initRes.status !== 204) {
      STATS.sessionCreateRejects++;
      return initRes.status === 503
        ? new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } })
        : notFound();
    }
    STATS.httpsSessions++;
  }

  STATS.sessionCreateOk++;
  return new Response(WELCOME, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Session-Token": sessionToken,
      "X-Down-Cursor": "0",
      "X-Carrier-Mode": effective.carrier
    }
  });
}

async function serveHttpsCarrier(request, env, cfg, direction, host) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length <= 7) {
    return await decoy(cfg.decoyUrl, request.method, "/", host);
  }
  const token = auth.substring(7);
  const verified = await verifyToken(cfg, token, TOKEN_KIND_SESSION);
  if (!verified) {
    return await decoy(cfg.decoyUrl, request.method, "/", host);
  }
  if (!cfg.hasDoBinding || !env?.PROXY_DO) {
    if (direction === "up") STATS.httpsUpRejects++;
    else STATS.httpsDownRejects++;
    return notFound();
  }
  if (request.method !== "POST" || request.headers.get("cookie")) {
    if (direction === "up") STATS.httpsUpRejects++;
    else STATS.httpsDownRejects++;
    return notFound();
  }
  const stub = env.PROXY_DO.get(env.PROXY_DO.idFromName("s:" + bytesToHex(verified.nonce)));
  if (direction === "up") {
    if ((request.headers.get("content-type") || "").toLowerCase() !== "application/octet-stream") {
      STATS.httpsUpRejects++;
      return notFound();
    }
    const seqStr = (request.headers.get("x-up-seq") || "").trim();
    if (!/^[1-9][0-9]{0,12}$/.test(seqStr)) {
      STATS.httpsUpRejects++;
      return notFound();
    }
    const declaredLength = parseInt(request.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > REQUEST_LIMIT) {
      STATS.httpsUpRejects++;
      return notFound();
    }
    const rawBody = await request.arrayBuffer();
    if (rawBody.byteLength === 0 || rawBody.byteLength > REQUEST_LIMIT) {
      STATS.httpsUpRejects++;
      return notFound();
    }
    const res = await stub.fetch(new Request("https://do.internal/up", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/octet-stream",
        "X-Up-Seq": seqStr
      },
      body: rawBody
    }));
    if (res.status === 204) STATS.httpsUpOk++;
    else STATS.httpsUpRejects++;
    return res;
  }
  const curStr = (request.headers.get("x-down-cursor") || "").trim();
  if (!/^(0|[1-9][0-9]{0,12})$/.test(curStr)) {
    STATS.httpsDownRejects++;
    return notFound();
  }
  const res = await stub.fetch(new Request("https://do.internal/down", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "X-Down-Cursor": curStr
    }
  }));
  if (res.status === 200 || res.status === 204) STATS.httpsDownOk++;
  else STATS.httpsDownRejects++;
  return res;
}

async function serveWebSocket(request, cfg, host, port) {
  const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
  if ((request.method === "GET" || request.method === "HEAD") && upgrade !== "websocket" && !request.headers.get("sec-websocket-protocol") && !request.headers.get("authorization")) {
    return await decoy(cfg.decoyUrl, request.method, "/", host);
  }
  if (request.method !== "GET") return notFound();
  if (upgrade !== "websocket") return notFound();
  if (request.headers.get("authorization")) return notFound();
  const offered = (request.headers.get("sec-websocket-protocol") || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (offered.length !== 1) return notFound();
  const protocol = offered[0];
  let token = "";
  let laneId = 0;
  if (protocol.startsWith("tproxy-v1.")) {
    token = protocol.substring(10);
  } else if (protocol.startsWith("tproxy-lane-v1.")) {
    const rest = protocol.substring(15);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0 || !/^[1-9][0-9]{0,7}$/.test(rest.substring(dot + 1))) return notFound();
    token = rest.substring(0, dot);
    laneId = parseInt(rest.substring(dot + 1), 10);
    if (laneId > 0xffffff) return notFound();
  } else {
    return notFound();
  }
  const verified = await verifyToken(cfg, token, TOKEN_KIND_SESSION);
  if (!verified) {
    STATS.wsRejects++;
    logEvent("ws_reject", "invalid or expired session token");
    return notFound();
  }
  if ((verified.mode === 1 || verified.mode === 2) && !cfg.acceptGenerated) {
    STATS.wsRejects++;
    return notFound();
  }
  const secret = await resolveSecretForMode(cfg, verified.mode, host, port);
  if (!secret) {
    STATS.wsRejects++;
    return notFound();
  }
  const effective = resolveProfileConfig(cfg, verified.mode);
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept();
  let session;
  try {
    session = new WsSession(server, effective, secret, laneId);
  } catch (error) {
    reportError("ws session", error, [cfg.adminKey, cfg.secretHex]);
    try { server.close(1011, "error"); } catch (_) {}
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": protocol } });
  }
  server.addEventListener("message", (event) => {
    try { session.enqueue(event.data); } catch (error) { reportError("ws message", error, [cfg.adminKey, cfg.secretHex]); try { session.shutdown("handler error"); } catch (_) {} }
  });
  server.addEventListener("close", () => { try { session.dispose(); } catch (error) { reportError("ws close", error, [cfg.adminKey, cfg.secretHex]); } });
  server.addEventListener("error", () => { try { session.dispose(); } catch (error) { reportError("ws error", error, [cfg.adminKey, cfg.secretHex]); } });
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "Sec-WebSocket-Protocol": protocol
    }
  });
}

// Coarse route classifier used in error logging so raw paths (which may contain
// ADMIN_KEY) and query strings (which may contain ?bridge= or ?key=) are never logged.
function classifyRoute(request, env) {
  try {
    const url = new URL(request.url);
    const p = url.pathname;
    const norm = (v) => (typeof v === "string" && v.trim() ? (v.trim().startsWith("/") ? v.trim() : "/" + v.trim()) : "");
    if (p === "/") return url.searchParams.has("bridge") ? "bridge" : "root";
    if (p === "/api/v1/session" || p === norm(env?.SESSION_PATH)) return "session";
    if (p === "/api/v1/ws" || p === norm(env?.WS_PATH)) return "ws";
    if (p === "/api/v1/up" || p === norm(env?.UP_PATH)) return "up";
    if (p === "/api/v1/down" || p === norm(env?.DOWN_PATH)) return "down";
    if (p === "/setup") return "setup";
    const adminKey = typeof env?.ADMIN_KEY === "string" ? env.ADMIN_KEY.trim() : "";
    if (adminKey.length >= 16) {
      let decoded = "";
      try { decoded = decodeURIComponent(p.slice(1)).replace(/\/$/, ""); } catch (_) {}
      if (decoded && safeEqual(decoded, adminKey)) return "panel";
      if (decoded && safeEqual(decoded, adminKey + "/status")) return "status";
      if (decoded && safeEqual(decoded, adminKey + "/settings")) return "settings";
    }
    return "other";
  } catch (_) {
    return "unknown";
  }
}

// Records an unexpected error without ever throwing itself or exposing secrets.
function reportError(where, error, secrets) {
  try {
    const rawMsg = error && error.message ? String(error.message) : String(error || "error");
    const safeWhere = sanitizeDetail(where, secrets);
    const safeMsg = sanitizeDetail(rawMsg, secrets);
    console.error("[proxygosha] " + safeWhere + ": " + safeMsg);
    logEvent("error", safeWhere + ": " + safeMsg, secrets);
  } catch (_) {}
}

// Last-resort response. It must never throw, otherwise Cloudflare shows Error 1101.
async function safeFallback(env, request) {
  try {
    const method = request && typeof request.method === "string" ? request.method : "GET";
    return await decoy(typeof env?.DECOY_URL === "string" ? env.DECOY_URL.trim() : "", method);
  } catch (error) {
    reportError("fallback", error, [env?.ADMIN_KEY, env?.SECRET]);
  }
  try {
    return new Response(DECOY_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch (_) {
    return new Response("", { status: 200 });
  }
}

// Every route handler is awaited here, so a rejected promise from any of them
// lands in the fetch() catch below instead of escaping as an uncaught exception.
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const host = requestHost(request, url);
  const rawHost = String(request.headers.get("host") || url.host || "");
  const portMatch = /:([0-9]+)$/.exec(rawHost);
  const port = parseValidPort(portMatch ? portMatch[1] : (url.port || ""));

  const cfg = await getRuntime(env);
  const lang = url.searchParams.get("lang") === "fa" ? "fa" : "en";
  // Not configured yet: the step-by-step setup page is served on "/" only.
  // Every other path or method answers 404 so an unconfigured worker does
  // not advertise what it is to scanners probing random paths.
  if (!cfg) {
    if (url.pathname === "/") return await serveSetup(host, env, lang, request.method);
    return notFound();
  }
  // Configured with SECRET only (older setup, no ADMIN_KEY yet): the site stays
  // camouflaged, but /setup explains how to add ADMIN_KEY. It reveals no secret.
  if (!cfg.adminKey && url.pathname === "/setup") return await serveSetup(host, env, lang, request.method);

  // Admin panel: https://host/<ADMIN_KEY>  (or legacy ?create-secret&key=<ADMIN_KEY>)
  // Admin status & logs: https://host/<ADMIN_KEY>/status  (?probe=1 runs a DC check)
  // Live global settings: POST https://host/<ADMIN_KEY>/settings (persisted in optional SETTINGS_KV)
  const route = panelRoute(url, cfg);
  if (route === "settings" && request.method === "POST") {
    const freshCfg = (await getRuntime(env, true)) || cfg;
    return await handleSaveSettings(request, env, freshCfg, host, url);
  }
  if (request.method === "GET") {
    if (route === "settings") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/" + encodeURIComponent(cfg.adminKey) + (lang === "fa" ? "?lang=fa" : ""),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer"
        }
      });
    }
    if (route === "status") {
      const freshCfg = (await getRuntime(env, true)) || cfg;
      return await serveStatus(freshCfg, host, lang, url.searchParams.get("probe") === "1", request.cf);
    }
    if (route === "panel") {
      const freshCfg = (await getRuntime(env, true)) || cfg;
      return await servePanel(freshCfg, host, port, lang, url.searchParams.get("saved") || "");
    }
  }

  // Legacy per-domain secret generator (ACCEPT_GENERATED); also gated by ADMIN_KEY.
  const label = generatorLabel(url);
  if (label !== null) {
    if (!cfg.generatorEnabled || !cfg.adminKey || !label || !safeEqual(url.searchParams.get("key") || "", cfg.adminKey)) {
      return await decoy(cfg.decoyUrl, request.method, "/", host);
    }
    return await serveSecret(cfg, host, label, port);
  }

  // Public web assets: when DECOY_URL is configured, proxy the matching path from
  // the real decoy site instead of serving hardcoded LUXVEIL assets.
  if (url.pathname === "/robots.txt") {
    if (cfg.decoyUrl) return await decoy(cfg.decoyUrl, request.method, "/robots.txt", host);
    return new Response(request.method === "HEAD" ? null : "User-agent: *\nAllow: /\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" }
    });
  }
  if (url.pathname === "/favicon.ico") {
    if (cfg.decoyUrl) return await decoy(cfg.decoyUrl, request.method, "/favicon.ico", host);
    const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a1a"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="14" fill="#fff" letter-spacing="2">LV</text></svg>`;
    return new Response(request.method === "HEAD" ? null : svgIcon, {
      status: 200,
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }
    });
  }

  if (!hostAllowed(cfg, host)) {
    if (url.pathname === "/" && url.searchParams.has("bridge")) {
      STATS.bridgeRejects++;
      logEvent("bridge_reject", `host not allowed: ${host}`);
    }
    return await decoy(cfg.decoyUrl, request.method, url.pathname, host);
  }
  if (url.pathname === "/" && request.method === "GET") {
    const bridges = url.searchParams.getAll("bridge");
    if (bridges.length === 0) {
      STATS.pageHits++;
      return await decoy(cfg.decoyUrl, request.method, "/", host);
    }
    const keys = Array.from(url.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== "bridge" || bridges.length !== 1) {
      STATS.bridgeRejects++;
      logEvent("bridge_reject", "non-canonical bridge query");
      // Fail locally with 404 only if an authentic capability is present so it is
      // never forwarded to DECOY_URL; unauthenticated probes see the public site.
      for (const b of bridges) {
        if (await bridgeMode(cfg, host, b, port) >= 0) return notFound();
      }
      return await decoy(cfg.decoyUrl, request.method, "/", host);
    }
    const mode = await bridgeMode(cfg, host, bridges[0], port);
    if (mode < 0) {
      STATS.bridgeRejects++;
      logEvent("bridge_reject", `capability mismatch host=${host}`);
      return await decoy(cfg.decoyUrl, request.method, "/", host);
    }
    return await serveBridge(cfg, host, mode, port);
  }
  if (url.pathname === cfg.sessionPath || url.pathname === "/api/v1/session") {
    return await serveSession(request, env, cfg, host, port);
  }
  if (url.pathname === cfg.wsPath || url.pathname === "/api/v1/ws") {
    return await serveWebSocket(request, cfg, host, port);
  }
  if (url.pathname === cfg.upPath || url.pathname === "/api/v1/up") {
    return await serveHttpsCarrier(request, env, cfg, "up", host);
  }
  if (url.pathname === cfg.downPath || url.pathname === "/api/v1/down") {
    return await serveHttpsCarrier(request, env, cfg, "down", host);
  }
  STATS.pageHits++;
  return await decoy(cfg.decoyUrl, request.method, url.pathname, host);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      reportError("fetch " + (request && request.method) + " " + classifyRoute(request, env), error, [env?.ADMIN_KEY, env?.SECRET]);
      return safeFallback(env, request);
    }
  }
};
