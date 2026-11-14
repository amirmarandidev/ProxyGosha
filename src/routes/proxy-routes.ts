import { deriveGeneratedSecret, HTTPS_PORTS, type RuntimeCrypto } from "../crypto/derive.ts";
import { issueToken, verifyToken } from "../crypto/token.ts";
import { attachWebSocketTransport, type TransportStats, type WorkerWebSocket, type WebSocketTransportOptions } from "../runtime/websocket-transport.ts";
import type { RuntimeConfig } from "../types/config.ts";
import type { SessionConfig } from "../session/ws-session.ts";

export const TOKEN_KIND_BOOTSTRAP = 1;
export const TOKEN_KIND_SESSION = 2;
export const PORT_MODE_BASE = 10;
export const SESSION_WELCOME = new Uint8Array([0x11, 0, 0, 0, 0, 0, 0, 0]);

export interface RouteRuntimeConfig extends RuntimeConfig, RuntimeCrypto {
  /** Optional logging hook; never receives credentials or token values. */
}

export type WebSocketPairLike = [client: unknown, server: WorkerWebSocket];

export interface ProxyRouteDependencies {
  createWebSocketPair(): WebSocketPairLike;
  createUpgradeResponse(client: unknown, protocol: string): Response;
  transport: Omit<WebSocketTransportOptions, "stats"> & { stats?: TransportStats };
  nowSeconds?: () => number;
  attachTransport?: typeof attachWebSocketTransport;
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sessionConfig(config: RouteRuntimeConfig, maxSessionBytes = 0): SessionConfig {
  return {
    carrier: config.carrier,
    maxStreams: config.maxStreams,
    streamWindow: config.streamWindow,
    maxQueued: config.maxQueued,
    dataChunk: config.dataChunk,
    dc: config.dc,
    dcPort: config.dcPort,
    dcPorts: config.dcPorts,
    adTag: config.adTag,
    debug: config.debug,
    maxSessionBytes,
  };
}

/** Port of the token-authenticated POST/DELETE `/api/v1/session` route. */
export async function serveSessionRoute(
  request: Request,
  config: RouteRuntimeConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
  tokenKey: CryptoKey = config.tokenKey,
): Promise<Response> {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= 7) return notFound();
  const token = authorization.substring(7);

  if (request.method === "DELETE") {
    if (!(await verifyToken(tokenKey, token, TOKEN_KIND_SESSION, nowSeconds))) return notFound();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  if (request.method !== "POST") return notFound();
  if (request.headers.get("cookie")) return notFound();
  if ((request.headers.get("content-type") || "").toLowerCase() !== "application/octet-stream") return notFound();
  const declaredLength = Number.parseInt(request.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > 4096) return notFound();

  const verified = await verifyToken(config.tokenKey, token, TOKEN_KIND_BOOTSTRAP, nowSeconds);
  if (!verified) return notFound();
  if ((verified.mode === 1 || verified.mode === 2) && !config.acceptGenerated) return notFound();

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length !== 9) return notFound();
  if (body[0] !== 0x10 || body[1] !== 0 || body[2] !== 0 || body[3] !== 0) return notFound();
  if (body[4] !== 0 || body[5] !== 0 || body[6] !== 0 || body[7] !== 1 || body[8] !== 1) return notFound();

  const sessionToken = await issueToken(tokenKey, TOKEN_KIND_SESSION, config.sessionTtl, verified.mode, nowSeconds);
  return new Response(SESSION_WELCOME, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Session-Token": sessionToken,
      "X-Down-Cursor": "0",
      "X-Carrier-Mode": config.carrier,
    },
  });
}

/**
 * Port of `/api/v1/ws`. Cloudflare-specific WebSocketPair construction and the
 * status-101 Response are supplied by the Worker entry point.
 */
export async function serveWebSocketRoute(
  request: Request,
  config: RouteRuntimeConfig,
  host: string,
  port: string,
  dependencies: ProxyRouteDependencies,
  tokenKey: CryptoKey = config.tokenKey,
): Promise<Response> {
  if (request.method !== "GET") return notFound();
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return notFound();
  if (request.headers.get("authorization")) return notFound();

  const offered = (request.headers.get("sec-websocket-protocol") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (offered.length !== 1) return notFound();

  const protocol = offered[0];
  let token = "";
  let laneId = 0;
  if (protocol.startsWith("tproxy-v1.")) {
    token = protocol.substring(10);
  } else if (protocol.startsWith("tproxy-lane-v1.")) {
    const rest = protocol.substring(15);
    const separator = rest.lastIndexOf(".");
    if (separator <= 0 || !/^[1-9][0-9]{0,7}$/.test(rest.substring(separator + 1))) return notFound();
    token = rest.substring(0, separator);
    laneId = Number.parseInt(rest.substring(separator + 1), 10);
    if (laneId > 0xffffff) return notFound();
  } else {
    return notFound();
  }

  const verified = await verifyToken(
    tokenKey,
    token,
    TOKEN_KIND_SESSION,
    dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
  );
  if (!verified) {
    const stats = dependencies.transport.stats ?? (dependencies.transport.stats = {});
    stats.wsRejects = (stats.wsRejects ?? 0) + 1;
    dependencies.transport.log?.("ws_reject", "invalid or expired session token");
    return notFound();
  }
  if ((verified.mode === 1 || verified.mode === 2) && !config.acceptGenerated) return notFound();

  let secret = config.base;
  if (verified.mode >= PORT_MODE_BASE && verified.mode < PORT_MODE_BASE + HTTPS_PORTS.length) {
    const selectedPort = HTTPS_PORTS[verified.mode - PORT_MODE_BASE];
    secret = config.portSecrets[selectedPort]?.secret ?? config.base;
  } else if (verified.mode === 1 || verified.mode === 2) {
    const label = verified.mode === 2 && port && port !== "443" && port !== "80"
      ? `${host}:${port}`
      : host;
    secret = config.generatorHmac ? await deriveGeneratedSecret(config.generatorHmac, label) : null;
  }
  if (!secret) return notFound();

  const pair = dependencies.createWebSocketPair();
  (dependencies.attachTransport ?? attachWebSocketTransport)(pair[1], sessionConfig(config), secret, {
    ...dependencies.transport,
    stats: dependencies.transport.stats,
  }, laneId);
  return dependencies.createUpgradeResponse(pair[0], protocol);
}
