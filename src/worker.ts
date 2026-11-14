import { resolveConfig } from "./config/resolve.ts";
import { DcHealthRegistry } from "./dc-health.ts";
import { ControlPlaneUnavailableError, enforceDistributedRateLimit, getControlSettings, recordGlobalMetrics, reserveGlobalSession, releaseGlobalSession, renewGlobalSession, reportGlobalSessionUsage, reportGlobalDcHealth, getGlobalDcHealth, verifySubscription, manageSubscriptions, type SessionReservation } from "./observability/client.ts";
import { buildRuntimeCrypto, deriveSubscriptionTokenKey, unsealBuildIdentity, type RuntimeCrypto } from "./crypto/derive.ts";
import { serveSessionRoute, serveWebSocketRoute, type ProxyRouteDependencies, type RouteRuntimeConfig, type WebSocketPairLike } from "./routes/proxy-routes.ts";
import { handleAuxiliaryRoute, decoy, notFound } from "./routes/auxiliary-routes.ts";
import type { TransportStats } from "./runtime/websocket-transport.ts";
import type { TcpConnect } from "./stream/tcp-stream.ts";
import type { ProxyGoshaBindings } from "./types/environment.ts";

// This is the build seal from the 1.2.2 JavaScript baseline. Its decoded bytes
// are part of the token-key derivation and must remain unchanged for clients.
export const BUILD_SEAL = "Pt54F2/pkjqM1YnQmZRs3Xvqd54U1iZVSYCfYAOgf5wIRzjyeruT";

export interface ProxyGoshaEnvironment extends ProxyGoshaBindings {}

export interface WorkerPlatform {
  connect: TcpConnect;
  createWebSocketPair(): WebSocketPairLike;
  createUpgradeResponse(client: unknown, protocol: string): Response;
  nowSeconds?: () => number;
  log?: (event: string, detail: string) => void;
}

export interface WorkerExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
  /** Cloudflare Access identity, present only for invocations authenticated by Access. */
  access?: { getIdentity(): Promise<{ email?: string; [key: string]: unknown } | null | undefined> };
}

interface RuntimeState {
  key: string;
  config: RouteRuntimeConfig | null;
}

let runtimeState: RuntimeState | null = null;
const dcHealth = new DcHealthRegistry();
let identityPromise: ReturnType<typeof unsealBuildIdentity> | null = null;
const isolateStartedAt = Date.now();
const transportStats: TransportStats & { panelViews?: number; statusViews?: number } = {};
const eventLog: Array<{ t: number; event: string; detail: string }> = [];
function logEvent(event: string, detail: string): void {
  eventLog.push({ t: Date.now(), event: String(event).slice(0, 24), detail: String(detail || "").slice(0, 120) });
  if (eventLog.length > 120) eventLog.splice(0, eventLog.length - 120);
  // Avoid emitting secrets, tokens, or client addresses from this log.
}
function getBuildIdentity(): ReturnType<typeof unsealBuildIdentity> {
  if (!identityPromise) identityPromise = unsealBuildIdentity(BUILD_SEAL);
  return identityPromise;
}

async function getRuntime(env: ProxyGoshaEnvironment): Promise<RouteRuntimeConfig | null> {
  const resolved = resolveConfig(env);
  const key = JSON.stringify(resolved);
  if (runtimeState?.key === key) return runtimeState.config;

  const cryptoConfig: RuntimeCrypto | null = await buildRuntimeCrypto(resolved, (await getBuildIdentity()).bytes);
  const config = cryptoConfig ? ({ ...resolved, ...cryptoConfig } as RouteRuntimeConfig) : null;
  runtimeState = { key, config };
  return config;
}

function requestHost(request: Request, url: URL): string {
  let host = String(request.headers.get("host") || url.host || "").toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[")) return host;
  const colon = host.lastIndexOf(":");
  if (colon > 0 && host.indexOf(":") === colon) host = host.slice(0, colon);
  return host;
}

function requestPort(request: Request, url: URL): string {
  const rawHost = String(request.headers.get("host") || url.host || "");
  const match = /:([0-9]+)$/.exec(rawHost);
  return match ? match[1] : url.port;
}

function hostAllowed(config: RouteRuntimeConfig, host: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return false;
  if (config.hostnames.length === 0 || config.hostnames.includes("*") ||
      (config.hostnames.length === 1 && config.hostnames[0] === "proxy.example.com")) return true;
  return config.hostnames.includes(host) || config.extraHosts.includes(host);
}


async function subscriptionAdminRoute(request: Request, env: ProxyGoshaEnvironment, adminKey: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== `/${encodeURIComponent(adminKey)}/api/subscriptions`) return null;
  if (request.method === "GET") {
    const response = await manageSubscriptions(env, adminKey, "GET");
    if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    const response = await manageSubscriptions(env, adminKey, "DELETE", { id });
    if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let input: { expiresAt?: number; limits?: Record<string, number> };
  try { input = await request.json() as typeof input; } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }); }
  if (!Number.isFinite(input.expiresAt) || !input.expiresAt || input.expiresAt <= Date.now()) return new Response(JSON.stringify({ error: "invalid_expiry" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const tokenHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await manageSubscriptions(env, adminKey, "POST", { expiresAt: input.expiresAt, limits: input.limits, tokenHash });
  if (!response) return new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const payload = await response.json() as Record<string, unknown>;
  return new Response(JSON.stringify({ ...payload, token }), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function requestSubscription(request: Request, env: ProxyGoshaEnvironment, required: boolean) {
  const token = request.headers.get("x-proxy-gosha-subscription") || "";
  if (!token) return required ? { valid: false as const } : { valid: true as const, subscription: null };
  const subscription = await verifySubscription(env, token);
  return subscription ? { valid: true as const, subscription } : { valid: false as const };
}

export function createWorker(platform: WorkerPlatform) {
  return {
    async fetch(
      request: Request,
      env: ProxyGoshaEnvironment = {},
      _ctx?: WorkerExecutionContextLike,
    ): Promise<Response> {
      try {
        const url = new URL(request.url);
        const host = requestHost(request, url);
        const port = requestPort(request, url);
        const config = await getRuntime(env);
        const controlSettings = await getControlSettings(env);
        dcHealth.configure(controlSettings.dcHealthCooldownMs, controlSettings.adaptiveDcSelection);
        if (config && url.pathname === "/" && url.searchParams.has("bridge") && !hostAllowed(config, host)) return decoy(config.decoyUrl, request.method);
        if (config?.adminKey) {
          const adminPrefix = `/${encodeURIComponent(config.adminKey)}`;
          const adminRequest = url.pathname === adminPrefix || url.pathname.startsWith(`${adminPrefix}/`) || url.searchParams.has("create-secret") || url.searchParams.has("--create-secret") || url.searchParams.has("create_secret");
          if (adminRequest) {
            const limit = await enforceDistributedRateLimit(env, request, controlSettings.rateLimitPerMinute);
            if (!limit.allowed) return new Response("Too Many Requests", { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))) } });
          }
        }
        if (config?.adminKey) {
          const subscriptionRoute = await subscriptionAdminRoute(request, env, config.adminKey);
          if (subscriptionRoute) return subscriptionRoute;
        }
        const auxiliary = await handleAuxiliaryRoute(request, url, host, port, config, env, {
          connect: platform.connect,
          identity: getBuildIdentity(),
          stats: transportStats,
          startedAt: isolateStartedAt,
          logs: eventLog,
          dcHealth: () => dcHealth.snapshot(),
          log: logEvent,
          now: platform.nowSeconds ? () => platform.nowSeconds!() * 1000 : Date.now,
        });
        if (auxiliary) return auxiliary;
        if (!config) return notFound();
        if (!hostAllowed(config, host)) return decoy(config.decoyUrl, request.method);

        if (url.pathname === config.sessionPath || url.pathname === "/api/v1/session") {
          const subscriptionAuth = await requestSubscription(request, env, controlSettings.requireSubscription);
          if (!subscriptionAuth.valid) return new Response("Subscription required or invalid", { status: 403, headers: { "Cache-Control": "no-store" } });
          const limit = await enforceDistributedRateLimit(env, request, controlSettings.rateLimitPerMinute);
          if (!limit.allowed) return new Response("Too Many Requests", { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))) } });
          return await serveSessionRoute(request, config, platform.nowSeconds?.(), subscriptionAuth.subscription ? await deriveSubscriptionTokenKey(request.headers.get("x-proxy-gosha-subscription") || "") : config.tokenKey);
        }
        if (url.pathname === config.wsPath || url.pathname === "/api/v1/ws") {
          const subscriptionAuth = await requestSubscription(request, env, controlSettings.requireSubscription);
          if (!subscriptionAuth.valid) return new Response("Subscription required or invalid", { status: 403, headers: { "Cache-Control": "no-store" } });
          const limit = await enforceDistributedRateLimit(env, request, controlSettings.rateLimitPerMinute);
          if (!limit.allowed) return new Response("Too Many Requests", { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))) } });
          const report = (values: Parameters<typeof recordGlobalMetrics>[1], type: string, detail?: string) => {
            const task = recordGlobalMetrics(env, values, type, detail);
            if (_ctx?.waitUntil) _ctx.waitUntil(task); else void task;
          };
          const accessIdentity = await _ctx?.access?.getIdentity().catch(() => null);
          const reservation = await reserveGlobalSession(env, request, subscriptionAuth.subscription ? `subscription:${subscriptionAuth.subscription.id}` : accessIdentity?.email, subscriptionAuth.subscription?.limits);
          if (!reservation.allowed) return new Response("Session limit exceeded", { status: 429, headers: { "Cache-Control": "no-store" } });
          // Shared endpoint observations seed this isolate's synchronous selector.
          dcHealth.mergeShared(await getGlobalDcHealth(env));
          const sessionMetrics = { streams: 0, dcAttempts: 0, dcFails: 0 };
          const rejectedBefore = transportStats.wsRejects ?? 0;
          const dependencies: ProxyRouteDependencies = {
            createWebSocketPair: platform.createWebSocketPair,
            createUpgradeResponse: platform.createUpgradeResponse,
            transport: {
              connect: platform.connect,
              log: logEvent,
              stats: transportStats,
              dcHealth,
              adaptiveDcSelection: controlSettings.adaptiveDcSelection,
              dcHealthCooldownMs: controlSettings.dcHealthCooldownMs,
              connectTimeoutMs: controlSettings.dcConnectTimeoutMs,
              maxConnectAttempts: controlSettings.maxDcConnectAttempts,
              idleTimeoutMs: controlSettings.streamIdleTimeoutMs,
              maxSessionBytes: controlSettings.maxSessionBytes,
              onDcAttempt: (success, latencyMs, target) => { sessionMetrics.dcAttempts++; if (!success) sessionMetrics.dcFails++; const task = reportGlobalDcHealth(env, `${target.hostname}:${target.port}`, success, latencyMs); if (_ctx?.waitUntil) _ctx.waitUntil(task); else void task; },
              onStreamOpen: () => { sessionMetrics.streams++; },
              onSessionOpen: () => report({ sessions: 1, sessionsActive: 1 }, "session_open"),
              onHeartbeat: async () => {
                const leaseValid = await renewGlobalSession(env, reservation);
                if (!leaseValid) return false;
                if (subscriptionAuth.subscription) {
                  const current = await verifySubscription(env, request.headers.get("x-proxy-gosha-subscription") || "");
                  return Boolean(current && current.id === subscriptionAuth.subscription.id && current.expiresAt > Date.now());
                }
                return true;
              },
              onTraffic: controlSettings.dailyBytesPerIp > 0 || controlSettings.monthlyBytesPerIp > 0 || (subscriptionAuth.subscription?.limits.dailyBytesPerIp ?? 0) > 0 || (subscriptionAuth.subscription?.limits.monthlyBytesPerIp ?? 0) > 0
                ? (bytesUp, bytesDown) => reportGlobalSessionUsage(env, reservation, bytesUp, bytesDown, true)
                : undefined,
              onSessionClose: (summary) => { const closeTask = releaseGlobalSession(env, reservation, summary.bytesUp, summary.bytesDown); if (_ctx?.waitUntil) _ctx.waitUntil(closeTask); else void closeTask; report({ sessionsActive: -1, bytesUp: summary.bytesUp, bytesDown: summary.bytesDown, streams: sessionMetrics.streams, dcAttempts: sessionMetrics.dcAttempts, dcFails: sessionMetrics.dcFails }, "session_close", `streams=${summary.streams};duration=${Math.round(summary.durationMs)}ms`); },
            },
            nowSeconds: platform.nowSeconds,
          };
          let response: Response;
          try { response = await serveWebSocketRoute(request, config, host, port, dependencies, subscriptionAuth.subscription ? await deriveSubscriptionTokenKey(request.headers.get("x-proxy-gosha-subscription") || "") : config.tokenKey); }
          catch (error) { const releaseTask = releaseGlobalSession(env, reservation, 0, 0); if (_ctx?.waitUntil) _ctx.waitUntil(releaseTask); else void releaseTask; throw error; }
          if (response.status !== 101) { const releaseTask = releaseGlobalSession(env, reservation, 0, 0); if (_ctx?.waitUntil) _ctx.waitUntil(releaseTask); else void releaseTask; }
          const rejected = (transportStats.wsRejects ?? 0) - rejectedBefore;
          if (rejected > 0) report({ wsRejects: rejected }, "ws_reject");
          return response;
        }
        return decoy(config.decoyUrl, request.method);
      } catch (error) {
        platform.log?.("worker_error", error instanceof Error ? error.message : String(error));
        if (error instanceof ControlPlaneUnavailableError) return new Response("Control plane unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
        return decoy(env.DECOY_URL?.trim() ?? "", request.method);
      }
    },
    async scheduled(_controller: { scheduledTime: number; cron: string }, env: ProxyGoshaEnvironment, ctx?: WorkerExecutionContextLike): Promise<void> {
      const config = await getRuntime(env);
      if (!config) return;
      const targets: Array<{ hostname: string; port: number }> = [];
      const ports = [...new Set((config.dcPorts?.length ? config.dcPorts : [config.dcPort || 443]).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
      for (const dc of Object.keys(config.dc).map(Number).sort((a, b) => a - b)) {
        for (const hostname of config.dc[dc] ?? []) {
          for (const port of ports) targets.push({ hostname, port });
        }
      }
      const uniqueTargets = [...new Map(targets.map((target) => [`${target.hostname}:${target.port}`, target])).values()];
      const run = async (target: { hostname: string; port: number }) => {
        const started = Date.now(); let socket: ReturnType<TcpConnect> | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          socket = platform.connect(target, { secureTransport: "off" });
          void socket.closed.catch(() => undefined);
          await Promise.race([socket.opened, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("probe timeout")), 3_000); })]);
          await socket.close();
          return reportGlobalDcHealth(env, `${target.hostname}:${target.port}`, true, Date.now() - started);
        } catch {
          if (socket) { try { void socket.close().catch(() => undefined); } catch { /* best effort */ } }
          return reportGlobalDcHealth(env, `${target.hostname}:${target.port}`, false, Date.now() - started);
        } finally { if (timer) clearTimeout(timer); }
      };
      const task = (async () => { for (let i = 0; i < uniqueTargets.length; i += 8) await Promise.all(uniqueTargets.slice(i, i + 8).map(run)); })();
      if (ctx?.waitUntil) ctx.waitUntil(task); else await task;
    },
  };
}
