import type { DurableObjectNamespaceLike, ProxyGoshaBindings } from "../types/environment.ts";
import type { ControlPlaneMetrics, ControlPlaneSettings } from "./control-plane.ts";

const localRateBuckets = new Map<string, { window: number; count: number }>();
const settingsCache = new WeakMap<object, { value: ControlPlaneSettings; expires: number }>();
const dcHealthCache = new WeakMap<object, { value: Array<{ hostname: string; port: number; failures: number; attempts?: number; successes?: number; totalFailures?: number; latencyVarianceMs2?: number | null; latencyEwmaMs: number | null; cooldownUntil: number; lastSuccessAt: number | null; lastFailureAt: number | null }>; expires: number }>();
const METRICS_SHARDS = 16;
const SUBSCRIPTION_SHARDS = 16;
function shardIndex(value: string, count: number): number { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0; return hash % count; }
function subscriptionShard(tokenHash: string): string { return `proxy-gosha-subscriptions-${shardIndex(tokenHash, SUBSCRIPTION_SHARDS).toString(16).padStart(2, "0")}`; }

export class ControlPlaneUnavailableError extends Error { constructor() { super("control_plane_unavailable"); this.name = "ControlPlaneUnavailableError"; } }

export const DEFAULT_CONTROL_SETTINGS: ControlPlaneSettings = {
  rateLimitPerMinute: 120,
  adaptiveDcSelection: true,
  dcHealthCooldownMs: 15_000,
  dcConnectTimeoutMs: 3_000,
  maxDcConnectAttempts: 4,
  streamIdleTimeoutMs: 120_000,
  maxSessionBytes: 0,
  maxConcurrentSessionsPerIp: 0,
  dailyBytesPerIp: 0,
  monthlyBytesPerIp: 0,
  historyHours: 168,
  alertDcFailureThreshold: 5,
  alertWebhookUrl: "",
  requireSubscription: false,
};

function controlStub(namespace?: DurableObjectNamespaceLike, name = "proxy-gosha-global") {
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(name));
}

export async function getControlSettings(env: ProxyGoshaBindings): Promise<ControlPlaneSettings> {
  const namespace = env.CONTROL_PLANE;
  const cached = namespace ? settingsCache.get(namespace as object) : undefined;
  if (cached && Date.now() < cached.expires) return { ...cached.value };
  if (!namespace) return {
    ...DEFAULT_CONTROL_SETTINGS,
    rateLimitPerMinute: clamp(env.RATE_LIMIT_PER_MINUTE, 1, 600, DEFAULT_CONTROL_SETTINGS.rateLimitPerMinute),
  };
  try {
    const stub = controlStub(namespace);
    if (!stub) { if (cached) return { ...cached.value }; throw new ControlPlaneUnavailableError(); }
    const response = await stub.fetch("https://control-plane/v1/settings");
    if (!response.ok) { if (cached) return { ...cached.value }; throw new ControlPlaneUnavailableError(); }
    const value = await response.json() as Partial<ControlPlaneSettings>;
    const settings: ControlPlaneSettings = {
      rateLimitPerMinute: clamp(value.rateLimitPerMinute, 1, 600, DEFAULT_CONTROL_SETTINGS.rateLimitPerMinute),
      adaptiveDcSelection: value.adaptiveDcSelection !== false,
      dcHealthCooldownMs: clamp(value.dcHealthCooldownMs, 1_000, 300_000, DEFAULT_CONTROL_SETTINGS.dcHealthCooldownMs),
      dcConnectTimeoutMs: clamp(value.dcConnectTimeoutMs, 500, 15_000, DEFAULT_CONTROL_SETTINGS.dcConnectTimeoutMs),
      maxDcConnectAttempts: clamp(value.maxDcConnectAttempts, 1, 8, DEFAULT_CONTROL_SETTINGS.maxDcConnectAttempts),
      streamIdleTimeoutMs: clamp(value.streamIdleTimeoutMs, 10_000, 3_600_000, DEFAULT_CONTROL_SETTINGS.streamIdleTimeoutMs),
      maxSessionBytes: clamp(value.maxSessionBytes, 0, 100_000_000_000, DEFAULT_CONTROL_SETTINGS.maxSessionBytes),
      maxConcurrentSessionsPerIp: clamp(value.maxConcurrentSessionsPerIp, 0, 100, 0),
      dailyBytesPerIp: clamp(value.dailyBytesPerIp, 0, 1_000_000_000_000, 0),
      monthlyBytesPerIp: clamp(value.monthlyBytesPerIp, 0, 10_000_000_000_000, 0),
      historyHours: clamp(value.historyHours, 24, 720, 168),
      alertDcFailureThreshold: clamp(value.alertDcFailureThreshold, 1, 20, 5),
      alertWebhookUrl: "",
      requireSubscription: value.requireSubscription === true,
    };
    if (namespace) settingsCache.set(namespace as object, { value: settings, expires: Date.now() + 5_000 });
    return settings;
  } catch { if (cached) return { ...cached.value }; throw new ControlPlaneUnavailableError(); }
}

export async function getGlobalMetrics(env: ProxyGoshaBindings): Promise<ControlPlaneMetrics | null> {
  if (!env.CONTROL_PLANE) return null;
  try {
    const names = ["proxy-gosha-global", ...Array.from({ length: METRICS_SHARDS }, (_, i) => `proxy-gosha-metrics-${i.toString(16).padStart(2, "0")}`)];
    const snapshots = await Promise.all(names.map(async (name) => {
      const stub = controlStub(env.CONTROL_PLANE, name); if (!stub) return null;
      const response = await stub.fetch("https://control-plane/v1/metrics");
      return response.ok ? await response.json() as ControlPlaneMetrics : null;
    }));
    const available = snapshots.filter((value): value is ControlPlaneMetrics => value !== null);
    if (!available.length) return null;
    const result: ControlPlaneMetrics = { sessions: 0, sessionsActive: 0, bytesUp: 0, bytesDown: 0, streams: 0, dcAttempts: 0, dcFails: 0, wsRejects: 0, events: [], history: [], dcHealth: [], audit: [] };
    const buckets = new Map<number, ControlPlaneMetrics["history"][number]>(); const endpoints = new Map<string, NonNullable<ControlPlaneMetrics["dcHealth"]>[number]>();
    for (const snapshot of available) {
      for (const key of ["sessions", "sessionsActive", "bytesUp", "bytesDown", "streams", "dcAttempts", "dcFails", "wsRejects"] as const) result[key] += snapshot[key] ?? 0;
      result.events.push(...(snapshot.events ?? [])); result.audit!.push(...(snapshot.audit ?? []));
      for (const bucket of snapshot.history ?? []) { const current = buckets.get(bucket.hour) ?? { hour: bucket.hour, sessions: 0, bytesUp: 0, bytesDown: 0, streams: 0, dcAttempts: 0, dcFails: 0 }; for (const key of ["sessions", "bytesUp", "bytesDown", "streams", "dcAttempts", "dcFails"] as const) current[key] += bucket[key] ?? 0; buckets.set(bucket.hour, current); }
      for (const entry of snapshot.dcHealth ?? []) endpoints.set(entry.endpoint, entry);
    }
    result.sessionsActive = Math.max(0, result.sessionsActive);
    result.events = result.events.sort((a, b) => a.at - b.at).slice(-100); result.audit = result.audit!.sort((a, b) => a.at - b.at).slice(-200);
    result.history = [...buckets.values()].sort((a, b) => a.hour - b.hour).slice(-720); result.dcHealth = [...endpoints.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)).slice(-256);
    return result;
  } catch { return null; }
}


export async function getGlobalDcHealth(env: ProxyGoshaBindings): Promise<Array<{ hostname: string; port: number; failures: number; attempts?: number; successes?: number; totalFailures?: number; latencyVarianceMs2?: number | null; latencyEwmaMs: number | null; cooldownUntil: number; lastSuccessAt: number | null; lastFailureAt: number | null }>> {
  const namespace = env.CONTROL_PLANE; if (!namespace) return [];
  const cached = dcHealthCache.get(namespace as object); if (cached && Date.now() < cached.expires) return cached.value.map((entry) => ({ ...entry }));
  try {
    const names = ["proxy-gosha-global", ...Array.from({ length: METRICS_SHARDS }, (_, i) => `proxy-gosha-metrics-${i.toString(16).padStart(2, "0")}`)];
    const snapshots = await Promise.all(names.map(async (name) => { const stub = controlStub(namespace, name); if (!stub) return []; const response = await stub.fetch("https://control-plane/v1/dc/health"); return response.ok ? await response.json() as Array<{ endpoint: string; attempts?: number; successes?: number; totalFailures?: number; failures: number; latencyVarianceMs2?: number | null; latencyEwmaMs: number | null; cooldownUntil: number; lastSuccessAt: number | null; lastFailureAt: number | null }> : []; }));
    const unique = new Map<string, (typeof snapshots)[number][number]>(); for (const snapshot of snapshots) for (const record of snapshot) unique.set(record.endpoint, record);
    const result = [...unique.values()].flatMap((record) => { const separator = record.endpoint.lastIndexOf(":"); if (separator <= 0) return []; const hostname = record.endpoint.slice(0, separator); const port = Number(record.endpoint.slice(separator + 1)); if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return []; return [{ hostname, port, failures: record.failures, attempts: record.attempts, successes: record.successes, totalFailures: record.totalFailures, latencyVarianceMs2: record.latencyVarianceMs2, latencyEwmaMs: record.latencyEwmaMs, cooldownUntil: record.cooldownUntil, lastSuccessAt: record.lastSuccessAt, lastFailureAt: record.lastFailureAt }]; });
    dcHealthCache.set(namespace as object, { value: result, expires: Date.now() + 5_000 }); return result;
  } catch { return cached?.value.map((entry) => ({ ...entry })) ?? []; }
}

export async function recordGlobalMetrics(env: ProxyGoshaBindings, values: Partial<Omit<ControlPlaneMetrics, "events">>, type: string, detail?: string): Promise<void> {
  if (!env.CONTROL_PLANE) return;
  try { const random = new Uint8Array(2); crypto.getRandomValues(random); const shard = random[0] % METRICS_SHARDS; const stub = controlStub(env.CONTROL_PLANE, `proxy-gosha-metrics-${shard.toString(16).padStart(2, "0")}`); if (!stub) return;
    await stub.fetch("https://control-plane/v1/metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, type, ...(detail ? { detail } : {}) }) });
  } catch { /* telemetry must not affect proxy traffic */ }
}

export async function updateControlSettings(
  env: ProxyGoshaBindings,
  adminKey: string,
  input: Record<string, unknown>,
): Promise<Response | null> {
  const stub = controlStub(env.CONTROL_PLANE);
  if (!stub) return null;
  try {
    const response = await stub.fetch("https://control-plane/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Proxy-Gosha-Admin": adminKey },
      body: JSON.stringify(input),
    });
    if (env.CONTROL_PLANE) settingsCache.delete(env.CONTROL_PLANE as object);
    return response;
  } catch { return null; }
}

export async function enforceDistributedRateLimit(
  env: ProxyGoshaBindings,
  request: Request,
  limit: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const rawIp = request.headers.get("cf-connecting-ip") || "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawIp)));
  const key = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const stub = controlStub(env.CONTROL_PLANE, `proxy-gosha-rate-${key.slice(0, 2)}`);
  if (!stub) return env.CONTROL_PLANE ? { allowed: false, remaining: 0, resetAt: Math.floor(Date.now() / 60_000) * 60 + 60 } : localRateLimit(key, limit);
  try {
    const response = await stub.fetch("https://control-plane/v1/rate-limit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, limit, windowSeconds: 60 }),
    });
    if (response.status === 429) return await response.json() as { allowed: boolean; remaining: number; resetAt: number };
    if (!response.ok) return { allowed: false, remaining: 0, resetAt: Math.floor(Date.now() / 60_000) * 60 + 60 };
    return await response.json() as { allowed: boolean; remaining: number; resetAt: number };
  } catch { return env.CONTROL_PLANE ? { allowed: false, remaining: 0, resetAt: Math.floor(Date.now() / 60_000) * 60 + 60 } : localRateLimit(key, limit); }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function localRateLimit(key: string, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  const window = Math.floor(Date.now() / 60_000);
  const previous = localRateBuckets.get(key) ?? { window, count: 0 };
  const count = previous.window === window ? previous.count + 1 : 1;
  localRateBuckets.set(key, { window, count });
  if (localRateBuckets.size > 4096) {
    for (const [entryKey, value] of localRateBuckets) if (value.window < window - 1) localRateBuckets.delete(entryKey);
    while (localRateBuckets.size > 4096) localRateBuckets.delete(localRateBuckets.keys().next().value!);
  }
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: (window + 1) * 60 };
}

export interface SessionReservation { allowed: boolean; id: string; reason?: string; key: string; shard: string; }
async function hashedClientKey(request: Request, authenticatedIdentity?: string): Promise<string> {
  // Cloudflare Access supplies this identity through the trusted Worker context.
  // The raw email/IP is never sent to or stored by the Durable Object.
  const identity = authenticatedIdentity?.trim().toLowerCase();
  const raw = identity ? `access:${identity}` : `ip:${request.headers.get("cf-connecting-ip") || "unknown"}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function reserveGlobalSession(env: ProxyGoshaBindings, request: Request, authenticatedIdentity?: string, subscriptionLimits?: Partial<Pick<ControlPlaneSettings, "maxConcurrentSessionsPerIp" | "dailyBytesPerIp" | "monthlyBytesPerIp">>): Promise<SessionReservation> {
  const key = await hashedClientKey(request, authenticatedIdentity); const id = crypto.randomUUID(); const shard = `proxy-gosha-session-${key.slice(0, 2)}`;
  if (!env.CONTROL_PLANE) return { allowed: true, id, key, shard };
  try {
    const stub = controlStub(env.CONTROL_PLANE, shard);
    if (!stub) return { allowed: false, id, key, shard, reason: "control_plane_unavailable" };
    const settings = await getControlSettings(env);
    const limits = { maxConcurrentSessionsPerIp: subscriptionLimits?.maxConcurrentSessionsPerIp ?? settings.maxConcurrentSessionsPerIp, dailyBytesPerIp: subscriptionLimits?.dailyBytesPerIp ?? settings.dailyBytesPerIp, monthlyBytesPerIp: subscriptionLimits?.monthlyBytesPerIp ?? settings.monthlyBytesPerIp };
    const response = await stub.fetch("https://control-plane/v1/session/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, id, limits }) });
    const value = await response.json() as { allowed?: boolean; reason?: string };
    return { allowed: response.ok && value.allowed === true, id, key, shard, ...(value.reason ? { reason: value.reason } : {}) };
  } catch { return { allowed: false, id, key, shard, reason: "control_plane_unavailable" }; }
}
export async function renewGlobalSession(env: ProxyGoshaBindings, reservation: SessionReservation): Promise<boolean> {
  if (!env.CONTROL_PLANE) return true;
  const stub = controlStub(env.CONTROL_PLANE, reservation.shard); if (!stub) return false;
  try { const response = await stub.fetch("https://control-plane/v1/session/renew", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: reservation.key, id: reservation.id }) }); return response.ok && (await response.json() as { ok?: boolean }).ok === true; }
  catch { return false; }
}

export async function reportGlobalSessionUsage(
  env: ProxyGoshaBindings,
  reservation: SessionReservation,
  bytesUp: number,
  bytesDown: number,
  failClosed = false,
): Promise<boolean> {
  const stub = controlStub(env.CONTROL_PLANE, reservation.shard);
  if (!stub) return !failClosed;
  try {
    const response = await stub.fetch("https://control-plane/v1/session/usage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: reservation.key, id: reservation.id, bytesUp, bytesDown }),
    });
    if (response.status === 404) return false;
    if (response.status === 429) return false;
    if (!response.ok) return !failClosed;
    const result = await response.json() as { allowed?: boolean };
    return result.allowed !== false;
  } catch { return !failClosed; }
}

export async function releaseGlobalSession(env: ProxyGoshaBindings, reservation: SessionReservation, bytesUp: number, bytesDown: number): Promise<void> {
  const stub = controlStub(env.CONTROL_PLANE, reservation.shard); if (!stub) return;
  try { await stub.fetch("https://control-plane/v1/session/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: reservation.key, id: reservation.id, bytesUp, bytesDown }) }); } catch { /* quota accounting is best effort if the control plane is unavailable */ }
}
export async function reportGlobalDcHealth(env: ProxyGoshaBindings, endpoint: string, ok: boolean, latencyMs: number): Promise<void> {
  const stub = controlStub(env.CONTROL_PLANE, `proxy-gosha-metrics-${shardIndex(endpoint, METRICS_SHARDS).toString(16).padStart(2, "0")}`); if (!stub) return;
  try { await stub.fetch("https://control-plane/v1/dc/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint, ok, latencyMs }) }); } catch { /* health telemetry is non-critical */ }
}
export async function exportControlSettings(env: ProxyGoshaBindings, adminKey: string): Promise<Response | null> {
  const stub = controlStub(env.CONTROL_PLANE); if (!stub) return null;
  try { return await stub.fetch("https://control-plane/v1/settings/export", { headers: { "X-Proxy-Gosha-Admin": adminKey } }); } catch { return null; }
}
export async function importControlSettings(env: ProxyGoshaBindings, adminKey: string, input: unknown): Promise<Response | null> {
  const stub = controlStub(env.CONTROL_PLANE); if (!stub) return null;
  try { return await stub.fetch("https://control-plane/v1/settings/import", { method: "POST", headers: { "Content-Type": "application/json", "X-Proxy-Gosha-Admin": adminKey }, body: JSON.stringify(input) }); } catch { return null; }
}

export interface VerifiedSubscription { id: string; expiresAt: number; limits: Partial<{ maxConcurrentSessionsPerIp: number; dailyBytesPerIp: number; monthlyBytesPerIp: number }>; }
export async function verifySubscription(env: ProxyGoshaBindings, token: string): Promise<VerifiedSubscription | null> {
  if (!env.CONTROL_PLANE || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))); const tokenHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  try { for (const name of [subscriptionShard(tokenHash), "proxy-gosha-global"]) { const stub = controlStub(env.CONTROL_PLANE, name); if (!stub) continue; const response = await stub.fetch("https://control-plane/v1/subscriptions/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenHash }) }); if (!response.ok) continue; const value = await response.json() as { valid?: boolean; id?: string; expiresAt?: number; limits?: VerifiedSubscription["limits"] }; if (value.valid && typeof value.id === "string" && Number.isFinite(value.expiresAt) && value.limits) return { id: value.id, expiresAt: value.expiresAt!, limits: value.limits }; } return null; }
  catch { return null; }
}
export async function manageSubscriptions(env: ProxyGoshaBindings, adminKey: string, method: "GET" | "POST" | "DELETE", input?: { expiresAt?: number; limits?: Record<string, number>; tokenHash?: string; id?: string }): Promise<Response | null> {
  if (!env.CONTROL_PLANE) return null;
  const headers = { "X-Proxy-Gosha-Admin": adminKey, ...(input ? { "Content-Type": "application/json" } : {}) }; const body = input ? JSON.stringify(input) : undefined;
  try {
    if (method === "POST") { if (!input?.tokenHash || !/^[a-f0-9]{64}$/.test(input.tokenHash)) return new Response(JSON.stringify({ error: "invalid_subscription" }), { status: 400 }); const stub = controlStub(env.CONTROL_PLANE, subscriptionShard(input.tokenHash)); return stub ? await stub.fetch("https://control-plane/v1/subscriptions", { method, headers, body }) : null; }
    if (method === "DELETE") { if (!input?.id) return new Response(JSON.stringify({ error: "invalid_id" }), { status: 400 }); const names = ["proxy-gosha-global", ...Array.from({ length: SUBSCRIPTION_SHARDS }, (_, i) => `proxy-gosha-subscriptions-${i.toString(16).padStart(2, "0")}`)]; for (const name of names) { const stub = controlStub(env.CONTROL_PLANE, name); if (!stub) continue; const response = await stub.fetch(`https://control-plane/v1/subscriptions/${encodeURIComponent(input.id)}`, { method, headers }); if (response.status !== 404) return response; } return new Response(JSON.stringify({ error: "not_found" }), { status: 404 }); }
    const names = ["proxy-gosha-global", ...Array.from({ length: SUBSCRIPTION_SHARDS }, (_, i) => `proxy-gosha-subscriptions-${i.toString(16).padStart(2, "0")}`)];
    const responses = await Promise.all(names.map(async (name) => { const stub = controlStub(env.CONTROL_PLANE, name); if (!stub) return []; const response = await stub.fetch("https://control-plane/v1/subscriptions", { method: "GET", headers }); if (!response.ok) throw new Error("subscription_list_unavailable"); return await response.json() as unknown[]; }));
    const byId = new Map<string, unknown>(); for (const record of responses.flat()) if (record && typeof record === "object" && typeof (record as { id?: unknown }).id === "string") byId.set((record as { id: string }).id, record);
    return new Response(JSON.stringify([...byId.values()]), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch { return null; }
}
