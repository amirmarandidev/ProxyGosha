import { base64UrlDecodeStrict, base64UrlEncode, bytesToHex } from "../crypto/bytes.ts";
import { deriveGeneratedSecret, HTTPS_PORTS, unsealBuildIdentity, type UnsealedBuildIdentity } from "../crypto/derive.ts";
import { importHmacKey, toOwnedArrayBuffer } from "../crypto/webcrypto.ts";
import { issueToken } from "../crypto/token.ts";
import type { RouteRuntimeConfig } from "./proxy-routes.ts";
import type { TcpConnect } from "../stream/tcp-stream.ts";
import type { ProxyGoshaBindings } from "../types/environment.ts";
import { BRIDGE_HTML, DECOY_HTML } from "../ui/templates.ts";
import { getControlSettings, getGlobalMetrics, updateControlSettings, exportControlSettings, importControlSettings } from "../observability/client.ts";

export interface AuxiliaryStats {
  sessions?: number; sessionsActive?: number; streams?: number; dcAttempts?: number; dcFails?: number;
  bytesUp?: number; bytesDown?: number; wsRejects?: number; panelViews?: number; statusViews?: number;
}
export interface AuxiliaryDependencies {
  connect: TcpConnect;
  identity: Promise<UnsealedBuildIdentity>;
  stats: AuxiliaryStats;
  startedAt: number;
  log(event: string, detail: string): void;
  now?: () => number;
  logs?: Array<{ t: number; event: string; detail: string }>;
  dcHealth?: () => Array<{ hostname: string; port: number; failures: number; attempts?: number; successes?: number; totalFailures?: number; latencyVarianceMs2?: number | null; latencyEwmaMs: number | null; cooldownUntil: number; lastSuccessAt: number | null }>;
}

const TOKEN_KIND_BOOTSTRAP = 1;
const PORT_MODE_BASE = 10;
const encoder = new TextEncoder();
const pageCss = "body{font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1d2330;line-height:1.8}h1{font-size:21px;margin:8px 0 4px}h2{font-size:16px;margin-top:28px}.card{background:#fff;border-radius:12px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}a.btn{display:block;text-align:center;background:#2a9df4;color:#fff;text-decoration:none;padding:10px;border-radius:10px;margin:6px 0;font-weight:bold}code,textarea{direction:ltr;text-align:left;font-family:ui-monospace,Consolas,monospace;font-size:12px}textarea{width:100%;height:58px;box-sizing:border-box;border:1px solid #ccd;border-radius:8px;padding:6px}textarea.one{height:34px}.muted{color:#667;font-size:13px}.warn{background:#fff4e5;border-inline-start:4px solid #f0a020}footer.credit{margin:32px 0 8px;text-align:center;font-size:12px;color:#889;direction:ltr}footer.credit a{color:#667}ol{padding-inline-start:22px;margin:4px 0}nav.lang{text-align:end;font-size:14px}nav.lang label{cursor:pointer;padding:4px 10px;border-radius:8px;color:#2a6fd6}.fa{display:none}#l-fa:checked~main{direction:rtl;font-family:Tahoma,system-ui,sans-serif}#l-fa:checked~main .en{display:none}#l-fa:checked~main span.fa{display:inline}#l-fa:checked~main div.fa,#l-fa:checked~main p.fa,#l-fa:checked~main ol.fa,#l-fa:checked~main h1.fa,#l-fa:checked~main h2.fa{display:block}#l-en:checked~main nav label[for=l-en],#l-fa:checked~main nav label[for=l-fa]{background:#e3eefc;font-weight:bold}pre{background:#f0f2f5;padding:8px;border-radius:8px;overflow-x:auto;font-size:11px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:start;vertical-align:top}th{font-weight:600;white-space:nowrap}.ok{color:#177245}.bad{color:#b33}a.plain{color:#2a6fd6}";
const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a1a"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="14" fill="#fff" letter-spacing="2">LV</text></svg>`;

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function bi(en: string, fa: string): string { return `<span class="en">${en}</span><span class="fa">${fa}</span>`; }
function page(title: string, lang: string, body: string, identity: UnsealedBuildIdentity): string {
  const isFa = lang === "fa";
  const credit = `<footer class="credit">ProxyGosha &middot; ${esc(identity.name)} &middot; <a href="mailto:${esc(identity.mail)}">${esc(identity.mail)}</a></footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${pageCss}</style></head><body><input type="radio" name="l" id="l-en" hidden${isFa ? "" : " checked"}><input type="radio" name="l" id="l-fa" hidden${isFa ? " checked" : ""}><main><nav class="lang"><label for="l-en">English</label> <label for="l-fa">فارسی</label></nav>${body}${credit}</main></body></html>`;
}
function pageResponse(body: string): Response { return new Response(body, { status: 200, headers: PAGE_HEADERS }); }
function notFound(): Response { return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }); }
function safeEqual(a: unknown, b: unknown): boolean {
  const x = encoder.encode(String(a)); const y = encoder.encode(String(b)); let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function generatorLabel(url: URL): string | null {
  for (const key of ["--create-secret", "create-secret", "create_secret"]) if (url.searchParams.has(key)) return url.searchParams.get(key) || "";
  return null;
}
function panelRoute(url: URL, cfg: RouteRuntimeConfig): "panel" | "status" | null {
  if (!cfg.adminKey) return null;
  let path = ""; try { path = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path && safeEqual(path, cfg.adminKey)) return "panel";
  if (path && safeEqual(path, cfg.adminKey + "/status")) return "status";
  if (generatorLabel(url) === "" && safeEqual(url.searchParams.get("key") || "", cfg.adminKey)) return "panel";
  return null;
}
async function bridgeMode(cfg: RouteRuntimeConfig, host: string, capability: string, port: string): Promise<number> {
  const provided = base64UrlDecodeStrict(capability); if (!provided || provided.length !== 32) return -1;
  const incomingPort = port ? Number.parseInt(port, 10) : 443;
  if (HTTPS_PORTS.includes(incomingPort as typeof HTTPS_PORTS[number]) && cfg.portSecrets[incomingPort]) {
    const pKeys = cfg.portSecrets[incomingPort].keys;
    const contexts = incomingPort === 443 ? [encoder.encode(`tdesktop-web-proxy-bridge-v1\n${host}`)] : [encoder.encode(`tdesktop-web-proxy-bridge-v1\n${host}:${incomingPort}`), encoder.encode(`tdesktop-web-proxy-bridge-v1\n${host}`)];
    for (const context of contexts) for (const key of pKeys) if (await crypto.subtle.verify("HMAC", key, toOwnedArrayBuffer(provided), toOwnedArrayBuffer(context))) return PORT_MODE_BASE + HTTPS_PORTS.indexOf(incomingPort as typeof HTTPS_PORTS[number]);
  }
  const candidatePorts: string[] = [];
  if (port && port !== "443" && port !== "80") candidatePorts.push(port);
  for (const p of HTTPS_PORTS) if (p !== 443 && !candidatePorts.includes(String(p))) candidatePorts.push(String(p));
  const candidateHosts = [host, ...candidatePorts.map((p) => `${host}:${p}`)];
  for (const candidate of candidateHosts) {
    const context = encoder.encode(`tdesktop-web-proxy-bridge-v1\n${candidate}`);
    for (const key of cfg.bridgeKeys) if (await crypto.subtle.verify("HMAC", key, toOwnedArrayBuffer(provided), toOwnedArrayBuffer(context))) return PORT_MODE_BASE;
  }
  for (let index = 0; index < HTTPS_PORTS.length; index++) {
    const p = HTTPS_PORTS[index]; if (p === incomingPort) continue;
    const keys = cfg.portSecrets[p].keys;
    const contexts = [encoder.encode(`tdesktop-web-proxy-bridge-v1\n${host}:${p}`), encoder.encode(`tdesktop-web-proxy-bridge-v1\n${host}`)];
    for (const context of contexts) for (const key of keys) if (await crypto.subtle.verify("HMAC", key, toOwnedArrayBuffer(provided), toOwnedArrayBuffer(context))) {
      if (!port || port === "443" || port === String(p)) return PORT_MODE_BASE + index;
    }
  }
  if (cfg.acceptGenerated) for (let index = 0; index < candidateHosts.length; index++) {
    const candidate = candidateHosts[index]; const secret = cfg.generatorHmac ? await deriveGeneratedSecret(cfg.generatorHmac, candidate) : null;
    if (secret) { const key = await importHmacKey(secret, ["verify"]); if (await crypto.subtle.verify("HMAC", key, toOwnedArrayBuffer(provided), toOwnedArrayBuffer(encoder.encode(`tdesktop-web-proxy-bridge-v1\n${candidate}`)))) return index === 0 ? 1 : 2; }
  }
  return -1;
}
async function serveBridge(cfg: RouteRuntimeConfig, host: string, mode: number, port: string, now: number): Promise<Response> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18)); const nonce = base64UrlEncode(nonceBytes);
  const bootstrap = await issueToken(cfg.tokenKey, TOKEN_KIND_BOOTSTRAP, cfg.bootstrapTtl, mode, now);
  const authority = port && port !== "443" && port !== "80" ? `${host}:${port}` : host;
  const body = BRIDGE_HTML.replaceAll("__NONCE__", nonce).replaceAll("__RELAY_BASE__", JSON.stringify(`https://${authority}/`))
    .replaceAll("__BOOTSTRAP__", JSON.stringify(bootstrap)).replaceAll("__CARRIER_MODE__", JSON.stringify(cfg.carrier))
    .replaceAll("__BATCH_LIMIT__", String(cfg.batchBytes)).replaceAll("__SESSION_PATH__", JSON.stringify(cfg.sessionPath.replace(/^\//, "")))
    .replaceAll("__WS_PATH__", JSON.stringify(cfg.wsPath.replace(/^\//, "")));
  const csp = ["default-src 'none'", "base-uri 'none'", "child-src 'none'", `connect-src 'self' https://${host}:* wss://${host}:* https://${host} wss://${host}`, "font-src 'none'", "form-action 'none'", "frame-ancestors http://127.0.0.1:*", "frame-src 'none'", "img-src 'none'", "manifest-src 'none'", "media-src 'none'", "object-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'none'", "worker-src 'none'", "sandbox allow-same-origin allow-scripts"].join("; ");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-DNS-Prefetch-Control": "off", "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()" } });
}
async function serveSecret(cfg: RouteRuntimeConfig, host: string, label: string, port: string): Promise<Response> {
  const clean = String(label || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, 128);
  let hex = ""; let domainHex = ""; let existing = false;
  if (clean) { for (let i = 0; i < clean.length; i++) domainHex += clean.charCodeAt(i).toString(16).padStart(2, "0"); const derived = cfg.generatorHmac ? await deriveGeneratedSecret(cfg.generatorHmac, clean) : null; hex = derived ? bytesToHex(derived) : bytesToHex(crypto.getRandomValues(new Uint8Array(16))); }
  else if (cfg.base) { hex = bytesToHex(cfg.base); existing = true; }
  else hex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const suffix = port && port !== "443" && port !== "80" ? `&port=${port}` : "";
  const link = `tg://webproxy?server=${encodeURIComponent(host)}${suffix}&secret=${hex}`; const padded = `dd${hex}`;
  const lines = ["=== ProxyGosha Secret Generator ===", clean ? `[Mode: DOMAIN-DERIVED SECRET for \"${clean}\"]` : existing ? "[Status: ACTIVE CONFIGURATION]" : "[Status: NEW SECRET GENERATED]", "", `Server:        ${host}${suffix ? `:${port}` : ""}`];
  if (clean) lines.push(`Target Domain: ${clean}`, `Domain Hex:    ${domainHex}`);
  lines.push(`Secret:        ${hex}`, `Telegram Link: ${link}`, "", `Padded Secret: ${padded} (Random padding mode - recommended)`, `Padded Link:   tg://webproxy?server=${encodeURIComponent(host)}${suffix}&secret=${padded}`, "");
  if (existing && !clean) lines.push("Your proxy is running with this secret. Use the link above in Telegram to connect.");
  else lines.push("Next Steps to Activate:", "1. Copy the 32-character secret (or dd-padded secret) above.", "2. In Cloudflare Dashboard -> Workers & Pages -> your worker -> Settings -> Variables and Secrets.", "3. Add/Update Environment Variable: SECRET with the value above and click Deploy.", "4. Connect in Telegram using the link above!");
  return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
async function serveSetup(host: string, env: ProxyGoshaBindings, lang: string, method: string, deps: AuxiliaryDependencies): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") return notFound();
  const suggested = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18))).replace(/[-_]/g, "x");
  const current = (env.ADMIN_KEY || "").trim();
  const problem = current && current.length < 16 ? `<div class="card warn">${bi("Your current ADMIN_KEY is too short. It must be at least 16 characters.", "ADMIN_KEY فعلی کوتاه است. حداقل ۱۶ کاراکتر لازم است.")}</div>` : "";
  const body = `<h1>${bi("Proxy setup", "راه‌اندازی پروکسی")}</h1>${problem}<div class="card"><ol class="en"><li>In the Cloudflare dashboard, open <b>Workers &amp; Pages</b> → this Worker → <b>Settings</b> → <b>Variables and Secrets</b>.</li><li>Click <b>Add</b>. Name: <code>ADMIN_KEY</code>. Value: the key below (or any password of 16+ English letters and digits).</li><li>Click <b>Deploy</b>.</li><li>Open the address below to reach your panel with ready Telegram links.</li></ol><ol class="fa"><li>در داشبورد کلودفلر: <b>Workers &amp; Pages</b> ← این ورکر ← <b>Settings</b> ← <b>Variables and Secrets</b></li><li>روی <b>Add</b> بزنید. نام: <code>ADMIN_KEY</code> ، مقدار: رمز زیر (یا هر رمز ۱۶+ حرفی از حروف و اعداد انگلیسی)</li><li><b>Deploy</b> را بزنید.</li><li>آدرس زیر را باز کنید تا پنل و لینک‌های آماده تلگرام را ببینید.</li></ol>${bi("Suggested key", "رمز پیشنهادی")}:<textarea class="one" readonly>${esc(suggested)}</textarea>${bi("Panel address", "آدرس پنل")}:<textarea class="one" readonly>https://${esc(host)}/${esc(suggested)}</textarea></div><p class="muted">${bi("Keep this key private. Anyone who has it can open your panel. If you reload this page, a new key is suggested; use the one you actually saved in Cloudflare.", "این رمز را جایی امن نگه دارید. هر کس آن را داشته باشد به پنل دسترسی دارد. با رفرش صفحه رمز جدیدی پیشنهاد می‌شود؛ همان رمزی را استفاده کنید که در کلودفلر ذخیره کرده‌اید.")}</p>`;
  return pageResponse(page("Setup", lang, body, await deps.identity));
}
async function servePanel(cfg: RouteRuntimeConfig, host: string, _port: string, lang: string, deps: AuxiliaryDependencies): Promise<Response> {
  deps.stats.panelViews = (deps.stats.panelViews || 0) + 1;
  deps.log("panel_view", host);
  const statusHref = "/" + encodeURIComponent(cfg.adminKey) + "/status";
  const secret = "dd" + bytesToHex(cfg.base || new Uint8Array());
  const hosts: string[] = [];
  for (const h of [host, ...(cfg.extraHosts || [])]) if (h && !hosts.includes(h)) hosts.push(h);
  const sections = hosts.map((h) => {
    const workersDev = h.endsWith(".workers.dev");
    const items = HTTPS_PORTS.map((p) => {
      const pSecret = cfg.portSecrets?.[p]?.secretHex || secret;
      const link = "tg://webproxy?server=" + encodeURIComponent(h) + (p !== 443 ? "&port=" + p : "") + "&secret=" + pSecret;
      return `<div class="card"><b>${bi("Port", "پورت")} ${p}</b>${p === 443 ? " " + bi("(default)", "(پیش‌فرض)") : ""}<a class="btn" href="${esc(link)}">${bi("Connect in Telegram", "اتصال در تلگرام")}</a><textarea readonly>${esc(link)}</textarea></div>`;
    }).join("");
    const note = workersDev
      ? `<p class="muted">${bi("workers.dev addresses are often filtered in Iran, and some ports may not open on them. Attach a custom domain to this Worker for the best results.", "آدرس workers.dev معمولاً در ایران فیلتر است و ممکن است بعضی پورت‌ها رویشان باز نباشند. بهتر است یک دامنه شخصی (Custom Domain) به ورکر وصل کنید.")}</p>`
      : "";
    const manualItems = HTTPS_PORTS.map((p) => {
      const value = cfg.portSecrets?.[p]?.secretHex || secret;
      return `<div style="margin:6px 0"><b>${bi("Port", "پورت")} ${p}</b>${p === 443 ? " " + bi("(default)", "(پیش‌فرض)") : ""}:<textarea class="one" readonly>${esc(value)}</textarea></div>`;
    }).join("");
    const manual = `<div class="card"><b>${bi("Manual entry", "ورود دستی")}</b> — ${bi("in Telegram's proxy settings, add a new proxy of type <b>WEB</b>. Each port has its own unique secret:", "در تنظیمات پروکسی تلگرام یک پروکسی جدید از نوع <b>WEB</b> اضافه کنید. هر پورت سکرت اختصاصی خود را دارد:")}<br>
${bi("Server", "سرور")}:<textarea class="one" readonly>${esc(h)}</textarea>
<div style="margin-top:8px"><b>${bi("Ports &amp; Secrets", "پورت‌ها و سکرت‌ها")}:</b></div>
${manualItems}</div>`;
    return `<h2>${esc(h)}</h2>${note}${manual}${items}`;
  }).join("");
  const derivedNote = cfg.secretDerived
    ? `<div class="card warn">${bi("Your proxy secrets are derived from ADMIN_KEY. Changing ADMIN_KEY changes the secrets and breaks every link you have shared. To avoid this, also set a fixed SECRET variable.", "سکرت‌های پروکسی از ADMIN_KEY ساخته شده‌اند. اگر ADMIN_KEY را عوض کنید، سکرت‌ها هم عوض می‌شوند و همه لینک‌هایی که فرستاده‌اید از کار می‌افتند. برای جلوگیری، یک متغیر SECRET ثابت هم تنظیم کنید.")}</div>`
    : "";
  const body = `<h1>${bi("Proxy panel", "پنل پروکسی")}</h1>
<div class="card">${bi("Tap <b>Connect in Telegram</b> to add the proxy. Each port has its own secret. If a port does not connect, try another one. You can add several ports at once and switch between them in Telegram.", "روی «اتصال در تلگرام» بزنید تا پروکسی اضافه شود. هر پورت سکرت اختصاصی خود را دارد. اگر یک پورت وصل نشد، پورت دیگری را امتحان کنید. می‌توانید چند پورت را با هم اضافه کنید و در تلگرام بینشان جابه‌جا شوید.")}</div>
<div class="card warn">${bi("Do not share this page. Share only the links, or the server, port and matching secret.", "این صفحه را با کسی به اشتراک نگذارید. فقط لینک‌ها یا سرور، پورت و سکرت مربوطه را بفرستید.")}</div>
<div class="card"><a class="plain" href="${esc(statusHref)}">${bi("Status &amp; logs", "وضعیت و لاگ‌ها")}</a> <span class="muted">${bi("— live statistics, recent events and a Telegram DC reachability probe.", "— آمار زنده، رویدادهای اخیر و تست دسترسی به دیتاسنترهای تلگرام.")}</span></div>
${derivedNote}
${sections}`;
  return pageResponse(page("Panel", lang, body, await deps.identity));
}
function fmtBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`; if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`; return `${(value / 1073741824).toFixed(2)} GB`; }
function fmtDuration(ms: number): string { const total = Math.max(0, Math.floor(ms / 1000)); const days = Math.floor(total / 86400); const hours = Math.floor(total % 86400 / 3600); const minutes = Math.floor(total % 3600 / 60); return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${total % 60}s`; }
function renderHistoryChart(values: number[], label: string): string {
  const width = 600; const height = 120; const top = 10; const bottom = 22;
  const chartHeight = height - top - bottom; const max = Math.max(1, ...values);
  const slot = width / Math.max(1, values.length); const barWidth = Math.max(4, slot - 5);
  const bars = values.map((value, index) => {
    const barHeight = Math.max(1, value / max * chartHeight);
    const x = index * slot + (slot - barWidth) / 2; const y = top + chartHeight - barHeight;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2"><title>${esc(label)}: ${esc(value)}</title></rect>`;
  }).join("");
  return `<svg role="img" aria-label="${esc(label)} by hour" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" style="display:block;background:#f6f7f9;border-radius:8px"><line x1="0" y1="${top + chartHeight}" x2="${width}" y2="${top + chartHeight}" stroke="#9aa3af" stroke-width="1"/>${bars}<text x="4" y="${height - 5}" font-size="10" fill="#667">Oldest → newest · hourly</text></svg>`;
}
async function probeDcs(cfg: RouteRuntimeConfig, deps: AuxiliaryDependencies): Promise<Array<{ dc: number; ip: string; ok: boolean; ms: number }>> {
  const keys = Object.keys(cfg.dc).map(Number).sort((a, b) => a - b); const results: Array<{ dc: number; ip: string; ok: boolean; ms: number }> = [];
  const probeOne = async (dc: number) => {
    const ips = cfg.dc[dc] || []; const configuredIp = ips[Math.floor(Math.random() * ips.length)]; const ip = configuredIp?.startsWith("[") && configuredIp.endsWith("]") ? configuredIp.slice(1, -1) : configuredIp; const started = (deps.now || Date.now)(); let socket: ReturnType<TcpConnect> | null = null;
    try { socket = deps.connect({ hostname: ip, port: cfg.dcPort || 443 }, { secureTransport: "off" }); socket.closed.catch(() => {}); let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([socket.opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 2500); })]); if (timer) clearTimeout(timer); await socket.close(); results.push({ dc, ip, ok: true, ms: (deps.now || Date.now)() - started }); }
    catch { if (socket) { try { void socket.close().catch(() => {}); } catch { /* best effort */ } } results.push({ dc, ip, ok: false, ms: (deps.now || Date.now)() - started }); }
  };
  for (let i = 0; i < keys.length; i += 3) await Promise.all(keys.slice(i, i + 3).map(probeOne));
  deps.log("dc_probe", results.map((r) => `DC${r.dc}${r.ok ? ":ok" : ":fail"}`).join(" ")); return results;
}
async function serveStatus(cfg: RouteRuntimeConfig, host: string, lang: string, wantsProbe: boolean, deps: AuxiliaryDependencies, env: ProxyGoshaBindings): Promise<Response> {
  deps.stats.statusViews = (deps.stats.statusViews || 0) + 1; deps.log("status_view", host);
  const probe = wantsProbe ? await probeDcs(cfg, deps) : null;
  const stat = deps.stats;
  const global = await getGlobalMetrics(env);
  const settings = await getControlSettings(env);
  const info = [[bi("Version", "نسخه"), "1.2.2"], [bi("Carrier", "حامل"), esc(cfg.carrier)], [bi("Secret mode", "حالت سکرت"), cfg.secretDerived ? bi("derived from ADMIN_KEY", "مشتق‌شده از ADMIN_KEY") : cfg.base ? bi("fixed SECRET", "SECRET ثابت") : "-"], [bi("Max streams per session", "حداکثر استریم در هر نشست"), String(cfg.maxStreams)], [bi("AD_TAG", "AD_TAG"), cfg.adTag ? bi("set (ignored in Direct-DC mode)", "تنظیم شده (در حالت Direct-DC بی‌اثر)") : bi("not set", "تنظیم نشده")]].map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");
  const rows = [["Proxy sessions (isolate)", stat.sessions], ["Active sessions (isolate)", stat.sessionsActive], ["Streams opened", stat.streams], ["DC connects ok / failed", `${(stat.dcAttempts || 0) - (stat.dcFails || 0)} / ${stat.dcFails || 0}`], ["Traffic up / down", `${fmtBytes(stat.bytesUp || 0)} / ${fmtBytes(stat.bytesDown || 0)}`], ["Rejected WS tokens", stat.wsRejects], ["Isolate uptime", fmtDuration((deps.now || Date.now)() - deps.startedAt)]].map(([label, value]) => `<tr><th>${bi(String(label), String(label))}</th><td>${esc(value ?? 0)}</td></tr>`).join("");
  const probeBlock = probe ? `<div class="card"><b>${bi("DC reachability probe", "تست دسترسی به دیتاسنترها")}</b><table><tr><th>DC</th><th>IP</th><th>Result</th></tr>${probe.map((r) => `<tr><td>DC${r.dc}</td><td>${esc(r.ip)}</td><td class="${r.ok ? "ok" : "bad"}">${r.ok ? "OK" : "FAIL"} (${r.ms} ms)</td></tr>`).join("")}</table></div>` : `<div class="card"><a class="plain" href="?probe=1">${bi("Run DC reachability probe", "اجرای تست دسترسی به دیتاسنترهای تلگرام")}</a><p class="muted">${bi("Opens and immediately closes one TCP socket per DC from this Cloudflare location.", "برای هر دیتاسنتر یک اتصال TCP از همین لوکیشن کلودفلر باز و بلافاصله بسته می‌شود.")}</p></div>`;
  const logRows = (deps.logs || []).slice(-60).reverse().map((entry) => `<tr><td>${new Date(entry.t).toISOString().slice(11, 19)}</td><td>${esc(entry.event)}</td><td>${esc(entry.detail)}</td></tr>`).join("");
  const logsBlock = `<div class="card"><b>${bi("Recent events", "رویدادهای اخیر")}</b> <span class="muted">${bi("(newest first, isolate memory only)", "(جدیدترین اول، فقط حافظه همین ایزوله)")}</span><table><tr><th>UTC</th><th>event</th><th>detail</th></tr>${logRows || `<tr><td colspan="3">-</td></tr>`}</table></div>`;
  const healthRows = (deps.dcHealth?.() || []).sort((a, b) => a.hostname.localeCompare(b.hostname) || a.port - b.port).map((entry) => { const attempts = entry.attempts ?? 0; const successRate = attempts ? `${Math.round(((entry.successes ?? Math.max(0, attempts - (entry.totalFailures ?? entry.failures))) / attempts) * 100)}%` : "—"; const jitter = entry.latencyVarianceMs2 == null ? "—" : `${Math.round(Math.sqrt(entry.latencyVarianceMs2))} ms`; return `<tr><td>${esc(entry.hostname)}:${entry.port}</td><td>${entry.failures}</td><td>${successRate}</td><td>${entry.latencyEwmaMs === null ? "—" : `${Math.round(entry.latencyEwmaMs)} ms`}</td><td>${jitter}</td><td>${entry.cooldownUntil > (deps.now || Date.now)() ? `${Math.ceil((entry.cooldownUntil - (deps.now || Date.now)()) / 1000)} s` : "Ready"}</td></tr>`; }).join("");
  const healthBlock = `<div class="card"><b>Adaptive DC endpoint health (shared observations + local updates)</b><table><tr><th>Endpoint</th><th>Consecutive failures</th><th>Success rate</th><th>EWMA connect latency</th><th>Latency jitter</th><th>State</th></tr>${healthRows || `<tr><td colspan="6">No connection history yet</td></tr>`}</table></div>`;
  const globalRows = global ? [["Global sessions", global.sessions], ["Global active sessions", global.sessionsActive], ["Global streams", global.streams], ["Global traffic up / down", `${fmtBytes(global.bytesUp)} / ${fmtBytes(global.bytesDown)}`], ["Global DC attempts / failures", `${global.dcAttempts} / ${global.dcFails}`], ["Global WS rejects", global.wsRejects]] : [];
  const globalDcRows = (global?.dcHealth ?? []).map((entry) => { const rate = entry.attempts ? `${Math.round(((entry.successes ?? Math.max(0, entry.attempts - (entry.totalFailures ?? entry.failures))) / entry.attempts) * 100)}%` : "—"; const jitter = entry.latencyVarianceMs2 == null ? "—" : `${Math.round(Math.sqrt(entry.latencyVarianceMs2))} ms`; return `<tr><td>${esc(entry.endpoint)}</td><td>${entry.attempts}</td><td>${rate}</td><td>${entry.failures}</td><td>${entry.latencyEwmaMs === null ? "—" : `${Math.round(entry.latencyEwmaMs)} ms`}</td><td>${jitter}</td><td>${entry.cooldownUntil > (deps.now || Date.now)() ? `${Math.ceil((entry.cooldownUntil - (deps.now || Date.now)()) / 1000)} s cooldown` : "Ready"}</td></tr>`; }).join("");
  const globalDcBlock = global ? `<h3>Global DC endpoint health</h3><table><tr><th>Endpoint</th><th>Attempts</th><th>Success rate</th><th>Consecutive failures</th><th>EWMA latency</th><th>Latency jitter</th><th>State</th></tr>${globalDcRows || `<tr><td colspan="7">No endpoint telemetry yet</td></tr>`}</table>` : "";
  const auditRows = (global?.audit ?? []).slice(-20).reverse().map((entry) => `<tr><td>${new Date(entry.at).toISOString()}</td><td>${esc(entry.action)}</td><td>${esc(entry.changed.join(", "))}</td></tr>`).join("");
  const auditBlock = global?.audit?.length ? `<h3>Configuration audit (latest 20)</h3><table><tr><th>UTC</th><th>Action</th><th>Changed keys (values omitted)</th></tr>${auditRows}</table>` : "";
  const hourly = global?.history?.slice(-24) || [];
  const historyRows = hourly.slice(-12).reverse().map((entry) => `<tr><td>${new Date(entry.hour * 3_600_000).toISOString().slice(0, 16)} UTC</td><td>${entry.sessions}</td><td>${fmtBytes(entry.bytesUp)} / ${fmtBytes(entry.bytesDown)}</td><td>${entry.dcFails} / ${entry.dcAttempts}</td></tr>`).join("") || "";
  const sessionChart = renderHistoryChart(hourly.map((entry) => entry.sessions), "Sessions");
  const trafficChart = renderHistoryChart(hourly.map((entry) => entry.bytesUp + entry.bytesDown), "Traffic bytes");
  const globalBlock = global ? `<div class="card"><b>Global aggregate metrics (Durable Object)</b><table>${globalRows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value ?? 0)}</td></tr>`).join("")}</table><h3>Hourly sessions</h3>${sessionChart}<h3>Hourly traffic (bytes)</h3>${trafficChart}<h3>Hourly history (last 24 hours)</h3><table><tr><th>Hour</th><th>Sessions</th><th>Traffic up / down</th><th>DC failures / attempts</th></tr>${historyRows || `<tr><td colspan="4">No history yet</td></tr>`}</table>${globalDcBlock}${auditBlock}</div>` : `<div class="card warn">Global telemetry is not configured. Bind CONTROL_PLANE to enable cross-isolate metrics and distributed rate limiting.</div>`;
  const settingsBlock = `<div class="card"><b>Runtime controls</b><table><tr><th>Session creation limit / IP / minute</th><td>${settings.rateLimitPerMinute}</td></tr><tr><th>Adaptive DC selection</th><td>${settings.adaptiveDcSelection ? "Enabled" : "Disabled"}</td></tr><tr><th>DC failure cooldown</th><td>${settings.dcHealthCooldownMs} ms</td></tr><tr><th>DC connect timeout</th><td>${settings.dcConnectTimeoutMs} ms</td></tr><tr><th>Maximum DC connect attempts</th><td>${settings.maxDcConnectAttempts}</td></tr><tr><th>Stream idle timeout</th><td>${settings.streamIdleTimeoutMs} ms</td></tr><tr><th>Session traffic quota</th><td>${settings.maxSessionBytes > 0 ? fmtBytes(settings.maxSessionBytes) : "Disabled"}</td></tr><tr><th>Concurrent sessions / IP</th><td>${settings.maxConcurrentSessionsPerIp || "Unlimited"}</td></tr><tr><th>Daily traffic / IP</th><td>${settings.dailyBytesPerIp > 0 ? fmtBytes(settings.dailyBytesPerIp) : "Unlimited"}</td></tr><tr><th>Monthly traffic / IP</th><td>${settings.monthlyBytesPerIp > 0 ? fmtBytes(settings.monthlyBytesPerIp) : "Unlimited"}</td></tr><tr><th>Metrics retention</th><td>${settings.historyHours} hours</td></tr></table><p class="muted">Update through the authenticated JSON API: PUT /${esc(encodeURIComponent(cfg.adminKey))}/api/config · GET /${esc(encodeURIComponent(cfg.adminKey))}/api/config/export · POST /${esc(encodeURIComponent(cfg.adminKey))}/api/config/import</p></div>`;
  const body = `<h1>${bi("Proxy status", "وضعیت پروکسی")}</h1><div class="card muted">${bi("Isolate counters reset when an isolate is recycled. Global aggregate counters are stored by the bound Durable Object. Client IP addresses are hashed before rate-limit storage; tokens and proxy secrets are not recorded.", "شمارنده‌های ایزوله با بازیافت ایزوله صفر می‌شوند. آمار تجمیعی جهانی در Durable Object ذخیره می‌شود. IP برای محدودسازی هش می‌شود و توکن‌ها و سکرت‌های پروکسی ذخیره نمی‌شوند.")}</div><div class="card"><b>${bi("Configuration", "پیکربندی")}</b><table>${info}</table></div><div class="card"><b>${bi("Live statistics", "آمار زنده")}</b><table>${rows}</table></div>${globalBlock}${settingsBlock}${healthBlock}${probeBlock}${logsBlock}`;
  return pageResponse(page("Status", lang, body, await deps.identity));
}
async function serveConfigApi(request: Request, cfg: RouteRuntimeConfig, env: ProxyGoshaBindings): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/export")) {
    if (request.method !== "GET") return notFound();
    const response = await exportControlSettings(env, cfg.adminKey);
    if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (path.endsWith("/import")) {
    if (request.method !== "POST") return notFound();
    let input: unknown; try { input = await request.json(); } catch { return notFound(); }
    const response = await importControlSettings(env, cfg.adminKey, input);
    if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (request.method === "GET") {
    const settings = await getControlSettings(env);
    return new Response(JSON.stringify(settings), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (request.method !== "PUT") return notFound();
  let input: Record<string, unknown>;
  try { const parsed: unknown = await request.json(); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return notFound(); input = parsed as Record<string, unknown>; }
  catch { return notFound(); }
  const response = await updateControlSettings(env, cfg.adminKey, input);
  if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function decoy(decoyUrl: string, method: string): Promise<Response> {
  if (decoyUrl && /^https?:\/\//i.test(decoyUrl)) try { const upstream = await fetch(decoyUrl, { method: method === "HEAD" ? "HEAD" : "GET", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" } }); return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/html; charset=utf-8", "Cache-Control": "no-cache" } }); } catch { /* use local storefront */ }
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", Vary: "Accept-Encoding" };
  return method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(DECOY_HTML, { status: 200, headers });
}

export async function handleAuxiliaryRoute(
  request: Request, url: URL, host: string, port: string, cfg: RouteRuntimeConfig | null,
  env: ProxyGoshaBindings, deps: AuxiliaryDependencies,
): Promise<Response | null> {
  const method = request.method; const lang = url.searchParams.get("lang") === "fa" ? "fa" : "en";
  if (!cfg) return url.pathname === "/" ? serveSetup(host, env, lang, method, deps) : notFound();
  if (!cfg.adminKey && url.pathname === "/setup") return serveSetup(host, env, lang, method, deps);
  let decodedPath = ""; try { decodedPath = decodeURIComponent(url.pathname); } catch { /* invalid encoding is not an admin path */ }
  if (cfg.adminKey && (safeEqual(decodedPath, `/${cfg.adminKey}/api/config`) || safeEqual(decodedPath, `/${cfg.adminKey}/api/config/export`) || safeEqual(decodedPath, `/${cfg.adminKey}/api/config/import`))) return serveConfigApi(request, cfg, env);
  if (method === "GET") {
    const route = panelRoute(url, cfg);
    if (route === "status") return serveStatus(cfg, host, lang, url.searchParams.get("probe") === "1", deps, env);
    if (route === "panel") return servePanel(cfg, host, port, lang, deps);
  }
  const label = generatorLabel(url);
  if (label !== null) {
    if (!cfg.generatorEnabled || !cfg.adminKey || !label || !safeEqual(url.searchParams.get("key") || "", cfg.adminKey)) return decoy(cfg.decoyUrl, method);
    return serveSecret(cfg, host, label, port);
  }
  if (url.pathname === "/robots.txt") return new Response(method === "HEAD" ? null : "User-agent: *\nAllow: /\nDisallow: /api/\n", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
  if (url.pathname === "/favicon.ico") return new Response(method === "HEAD" ? null : svgIcon, { status: 200, headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  if (url.pathname === "/health" || url.pathname === "/status") return new Response(method === "HEAD" ? null : JSON.stringify({ status: "operational", store: "LUXVEIL", region: "global", uptime: "99.99%", timestamp: Math.floor((deps.now || Date.now)() / 1000) }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" } });
  if (url.pathname === "/" && method === "GET") {
    const bridges = url.searchParams.getAll("bridge"); if (bridges.length === 0) return decoy(cfg.decoyUrl, method);
    const keys: string[] = []; url.searchParams.forEach((_value, key) => keys.push(key)); if (keys.length !== 1 || keys[0] !== "bridge" || bridges.length !== 1) return notFound();
    const mode = await bridgeMode(cfg, host, bridges[0], port); if (mode < 0) return notFound();
    return serveBridge(cfg, host, mode, port, Math.floor((deps.now || Date.now)() / 1000));
  }
  return null;
}

export { decoy, notFound };
