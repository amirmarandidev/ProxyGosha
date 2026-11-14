export interface ControlPlaneSettings {
  rateLimitPerMinute: number;
  adaptiveDcSelection: boolean;
  dcHealthCooldownMs: number;
  dcConnectTimeoutMs: number;
  maxDcConnectAttempts: number;
  streamIdleTimeoutMs: number;
  maxSessionBytes: number;
  maxConcurrentSessionsPerIp: number;
  dailyBytesPerIp: number;
  monthlyBytesPerIp: number;
  historyHours: number;
  alertWebhookUrl: string;
  alertDcFailureThreshold: number;
  requireSubscription: boolean;
}
export interface DcHealthRecord { endpoint: string; attempts: number; successes?: number; totalFailures?: number; failures: number; latencyVarianceMs2?: number | null; latencyEwmaMs: number | null; lastSuccessAt: number | null; lastFailureAt: number | null; cooldownUntil: number; }
export interface ControlPlaneMetrics {
  sessions: number; sessionsActive: number; bytesUp: number; bytesDown: number; streams: number; dcAttempts: number; dcFails: number; wsRejects: number;
  events: Array<{ at: number; type: string; detail?: string }>;
  history: Array<{ hour: number; sessions: number; bytesUp: number; bytesDown: number; streams: number; dcAttempts: number; dcFails: number }>;
  dcHealth?: DcHealthRecord[];
  audit?: Array<{ at: number; action: string; changed: string[] }>;
}
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  transaction<T>(closure: (txn: DurableStorageLike) => Promise<T>): Promise<T>;
}
export interface DurableObjectStateLike { storage: DurableStorageLike; }
const DEFAULT_SETTINGS: ControlPlaneSettings = {
  rateLimitPerMinute: 120, adaptiveDcSelection: true, dcHealthCooldownMs: 15_000, dcConnectTimeoutMs: 3_000, maxDcConnectAttempts: 4,
  streamIdleTimeoutMs: 120_000, maxSessionBytes: 0, maxConcurrentSessionsPerIp: 0,
  dailyBytesPerIp: 0, monthlyBytesPerIp: 0, historyHours: 168, alertWebhookUrl: "", alertDcFailureThreshold: 5, requireSubscription: false,
};
const EMPTY_METRICS: ControlPlaneMetrics = { sessions: 0, sessionsActive: 0, bytesUp: 0, bytesDown: 0, streams: 0, dcAttempts: 0, dcFails: 0, wsRejects: 0, events: [], history: [], dcHealth: [], audit: [] };
const METRIC_KEYS = ["sessions", "sessionsActive", "bytesUp", "bytesDown", "streams", "dcAttempts", "dcFails", "wsRejects"] as const;
const SESSION_LEASE_TTL_MS = 90_000;
type MetricKey = typeof METRIC_KEYS[number];
export interface ControlPlaneEnvironment { ADMIN_KEY?: string; RATE_LIMIT_PER_MINUTE?: string; }
interface SubscriptionRecord { id: string; expiresAt: number; enabled: boolean; maxConcurrentSessionsPerIp?: number; dailyBytesPerIp?: number; monthlyBytesPerIp?: number; createdAt: number; }
interface Lease { id: string; expiresAt: number; bytesUp?: number; bytesDown?: number; dailyBytesLimit?: number; monthlyBytesLimit?: number; }

/** Single global operational Durable Object. It stores hashed client keys, never raw IPs or proxy secrets. */
export class ProxyGoshaControlPlane {
  private readonly state: DurableObjectStateLike; private readonly env: ControlPlaneEnvironment;
  constructor(state: DurableObjectStateLike, env: ControlPlaneEnvironment = {}) { this.state = state; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/metrics") return this.recordMetrics(request);
    if (request.method === "POST" && url.pathname === "/v1/rate-limit") return this.rateLimit(request);
    if (request.method === "POST" && url.pathname === "/v1/session/open") return this.openSession(request);
    if (request.method === "POST" && url.pathname === "/v1/session/close") return this.closeSession(request);
    if (request.method === "POST" && url.pathname === "/v1/session/usage") return this.updateSessionUsage(request);
    if (request.method === "POST" && url.pathname === "/v1/session/renew") return this.renewSession(request);
    if (request.method === "POST" && url.pathname === "/v1/dc/report") return this.reportDc(request);
    if (url.pathname === "/v1/subscriptions" && request.method === "GET") return this.listSubscriptions(request);
    if (url.pathname.startsWith("/v1/subscriptions/") && request.method === "DELETE") return this.deleteSubscription(request, decodeURIComponent(url.pathname.slice("/v1/subscriptions/".length)));
    if (url.pathname === "/v1/subscriptions" && request.method === "POST") return this.createSubscription(request);
    if (url.pathname === "/v1/subscriptions/verify" && request.method === "POST") return this.verifySubscription(request);
    if (request.method === "GET" && url.pathname === "/v1/dc/health") return json((await this.getMetrics()).dcHealth ?? []);
    if (url.pathname === "/v1/settings" && request.method === "GET") return json(await this.getSettings());
    if (url.pathname === "/v1/settings" && request.method === "PUT") {
      if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
      return this.updateSettings(request);
    }
    if (url.pathname === "/v1/settings/export" && request.method === "GET") {
      if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
      const settings = await this.getSettings(); const { alertWebhookUrl: _secret, ...safe } = settings;
      return json({ schemaVersion: 1, exportedAt: new Date().toISOString(), settings: safe });
    }
    if (url.pathname === "/v1/settings/import" && request.method === "POST") {
      if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
      return this.importSettings(request);
    }
    if (url.pathname === "/v1/metrics" && request.method === "GET") return json(await this.getMetrics());
    if (url.pathname === "/v1/audit" && request.method === "GET") return json((await this.getMetrics()).audit ?? []);
    return new Response("Not Found", { status: 404 });
  }
  async alarm(): Promise<void> {
    const now = Date.now();
    const [rateLimits, leases, daily, monthly, alerts, subscriptions] = await Promise.all([
      this.state.storage.list<{ window: number }>({ prefix: "rl:" }),
      this.state.storage.list<Lease[]>({ prefix: "leases:" }),
      this.state.storage.list<{ period: string; bytes: number }>({ prefix: "usage:d:" }),
      this.state.storage.list<{ period: string; bytes: number }>({ prefix: "usage:m:" }),
      this.state.storage.list<number>({ prefix: "alert:" }),
      this.state.storage.list<SubscriptionRecord>({ prefix: "sub:" }),
    ]);
    const currentWindow = Math.floor(now / 60_000);
    for (const [key, value] of rateLimits) if (!value || value.window < currentWindow - 3) await this.state.storage.delete(key);
    for (const [key, value] of leases) {
      const active = (value ?? []).filter((lease) => lease.expiresAt > now);
      if (active.length) await this.state.storage.put(key, active); else await this.state.storage.delete(key);
    }
    const today = new Date(now).toISOString().slice(0, 10); const thisMonth = today.slice(0, 7);
    for (const [key, value] of daily) if (!value || value.period !== today) await this.state.storage.delete(key);
    for (const [key, value] of monthly) if (!value || value.period !== thisMonth) await this.state.storage.delete(key);
    for (const [key, value] of alerts) if (!value || now - value > 1_800_000) await this.state.storage.delete(key);
    for (const [key, value] of subscriptions) if (!value || value.expiresAt <= now) await this.state.storage.delete(key);
    const hasRemaining = [...leases.values()].some((items) => (items ?? []).some((lease) => lease.expiresAt > now))
      || [...daily.values()].some((value) => value?.period === today)
      || [...monthly.values()].some((value) => value?.period === thisMonth)
      || [...alerts.values()].some((value) => value && now - value <= 1_800_000)
      || [...subscriptions.values()].some((value) => value?.expiresAt > now)
      || [...rateLimits.values()].some((value) => value && value.window >= currentWindow - 3);
    if (hasRemaining) await this.state.storage.setAlarm(now + 86_400_000);
  }

  private authorized(request: Request): boolean { return Boolean(this.env.ADMIN_KEY && constantTimeEqual(request.headers.get("x-proxy-gosha-admin") || "", this.env.ADMIN_KEY)); }
  async getSettings(): Promise<ControlPlaneSettings> {
    const configured = Number.parseInt(this.env.RATE_LIMIT_PER_MINUTE ?? "", 10);
    const defaults = { ...DEFAULT_SETTINGS, rateLimitPerMinute: Number.isFinite(configured) ? clampInteger(configured, 1, 600) : DEFAULT_SETTINGS.rateLimitPerMinute };
    return { ...defaults, ...(await this.state.storage.get<Partial<ControlPlaneSettings>>("settings")) };
  }
  async getMetrics(): Promise<ControlPlaneMetrics> { return { ...EMPTY_METRICS, ...(await this.state.storage.get<Partial<ControlPlaneMetrics>>("metrics")) }; }
  private async recordMetrics(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input) return json({ error: "invalid_json" }, 400);
    const type = typeof input.type === "string" ? input.type.slice(0, 32) : "metric";
    const detail = typeof input.detail === "string" ? input.detail.slice(0, 100) : undefined;
    const metrics = await this.state.storage.transaction(async (txn) => {
      const current = { ...EMPTY_METRICS, ...(await txn.get<Partial<ControlPlaneMetrics>>("metrics")) };
      for (const key of METRIC_KEYS) { const amount = input[key]; if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
        if (key === "sessionsActive") current.sessionsActive += clampNumber(amount, -1_000_000, 1_000_000);
        else if (amount >= 0) current[key] += Math.min(amount, 1_000_000_000_000);
      }
      const hour = Math.floor(Date.now() / 3_600_000); let bucket = current.history.find((x) => x.hour === hour);
      if (!bucket) { bucket = { hour, sessions: 0, bytesUp: 0, bytesDown: 0, streams: 0, dcAttempts: 0, dcFails: 0 }; current.history.push(bucket); }
      for (const key of ["sessions", "bytesUp", "bytesDown", "streams", "dcAttempts", "dcFails"] as const) { const amount = input[key]; if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) bucket[key] += Math.min(amount, 1_000_000_000_000); }
      const settings = { ...DEFAULT_SETTINGS, ...(await txn.get<Partial<ControlPlaneSettings>>("settings")) };
      current.history = current.history.filter((x) => x.hour >= hour - settings.historyHours + 1).slice(-720);
      current.events.push({ at: Date.now(), type, ...(detail ? { detail } : {}) }); current.events = current.events.slice(-100);
      await txn.put("metrics", current); return current;
    });
    return json({ ok: true, sessions: metrics.sessions });
  }
  private async rateLimit(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input || typeof input.key !== "string" || !/^[a-f0-9]{32,64}$/.test(input.key)) return json({ error: "invalid_key" }, 400);
    const settings = await this.getSettings(); const limit = clampInteger(Number(input.limit ?? settings.rateLimitPerMinute), 1, 600);
    const windowSeconds = clampInteger(Number(input.windowSeconds ?? 60), 10, 3600); const now = Math.floor(Date.now() / 1000); const window = Math.floor(now / windowSeconds);
    const result = await this.state.storage.transaction(async (txn) => { const key = `rl:${input.key}`; const prev = await txn.get<{ window: number; count: number }>(key); const count = prev?.window === window ? prev.count + 1 : 1; await txn.put(key, { window, count }); return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: (window + 1) * windowSeconds, scheduleCleanup: prev?.window !== window }; });
    if (result.scheduleCleanup) await this.state.storage.setAlarm(Date.now() + 180_000);
    const { scheduleCleanup: _scheduleCleanup, ...publicResult } = result;
    return json(publicResult, result.allowed ? 200 : 429);
  }
  private async openSession(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input || !validKey(input.key) || typeof input.id !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(input.id)) return json({ error: "invalid_request" }, 400);
    const storedSettings = await this.getSettings();
    const limits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits) ? input.limits as Record<string, unknown> : {};
    const settings = { ...storedSettings,
      maxConcurrentSessionsPerIp: pickInt(limits, "maxConcurrentSessionsPerIp", storedSettings.maxConcurrentSessionsPerIp, 0, 100),
      dailyBytesPerIp: pickInt(limits, "dailyBytesPerIp", storedSettings.dailyBytesPerIp, 0, 1_000_000_000_000),
      monthlyBytesPerIp: pickInt(limits, "monthlyBytesPerIp", storedSettings.monthlyBytesPerIp, 0, 10_000_000_000_000),
    };
    const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10); const month = day.slice(0, 7);
    const result = await this.state.storage.transaction(async (txn) => {
      const leaseKey = `leases:${input.key}`; const leases = (await txn.get<Lease[]>(leaseKey) ?? []).filter((x) => x.expiresAt > now);
      if (settings.maxConcurrentSessionsPerIp > 0 && leases.length >= settings.maxConcurrentSessionsPerIp) return { allowed: false, reason: "concurrent_session_limit" };
      const daily = await txn.get<{ period: string; bytes: number }>(`usage:d:${input.key}`); const monthly = await txn.get<{ period: string; bytes: number }>(`usage:m:${input.key}`);
      if (settings.dailyBytesPerIp > 0 && (daily?.period === day ? daily.bytes : 0) >= settings.dailyBytesPerIp) return { allowed: false, reason: "daily_quota_exceeded" };
      if (settings.monthlyBytesPerIp > 0 && (monthly?.period === month ? monthly.bytes : 0) >= settings.monthlyBytesPerIp) return { allowed: false, reason: "monthly_quota_exceeded" };
      leases.push({ id: input.id as string, expiresAt: now + SESSION_LEASE_TTL_MS, bytesUp: 0, bytesDown: 0, dailyBytesLimit: settings.dailyBytesPerIp, monthlyBytesLimit: settings.monthlyBytesPerIp }); await txn.put(leaseKey, leases); return { allowed: true, active: leases.length };
    });
    if (result.allowed) await this.state.storage.setAlarm(Date.now() + 180_000);
    return json(result, result.allowed ? 200 : 429);
  }
  private async updateSessionUsage(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (!input || !validKey(input.key) || typeof input.id !== "string") return json({ error: "invalid_request" }, 400);
    const bytesUp = clampNumber(Number(input.bytesUp ?? 0), 0, 1e15);
    const bytesDown = clampNumber(Number(input.bytesDown ?? 0), 0, 1e15);
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const result = await this.state.storage.transaction(async (txn) => {
      const leaseKey = `leases:${input.key}`;
      const leases = await txn.get<Lease[]>(leaseKey) ?? [];
      const lease = leases.find((entry) => entry.id === input.id && entry.expiresAt > Date.now());
      if (!lease) return { allowed: false, reason: "session_lease_expired" };
      const deltaUp = Math.max(0, bytesUp - (lease.bytesUp ?? 0));
      const deltaDown = Math.max(0, bytesDown - (lease.bytesDown ?? 0));
      lease.bytesUp = Math.max(lease.bytesUp ?? 0, bytesUp);
      lease.bytesDown = Math.max(lease.bytesDown ?? 0, bytesDown);
      lease.expiresAt = Date.now() + SESSION_LEASE_TTL_MS;
      await txn.put(leaseKey, leases);
      const totalDelta = deltaUp + deltaDown;
      const dailyKey = `usage:d:${input.key}`;
      const monthlyKey = `usage:m:${input.key}`;
      const daily = await txn.get<{ period: string; bytes: number }>(dailyKey);
      const monthly = await txn.get<{ period: string; bytes: number }>(monthlyKey);
      const dailyBytes = (daily?.period === day ? daily.bytes : 0) + totalDelta;
      const monthlyBytes = (monthly?.period === month ? monthly.bytes : 0) + totalDelta;
      if (totalDelta > 0) {
        await txn.put(dailyKey, { period: day, bytes: dailyBytes });
        await txn.put(monthlyKey, { period: month, bytes: monthlyBytes });
      }
      return {
        allowed: !((lease.dailyBytesLimit ?? 0) > 0 && dailyBytes > lease.dailyBytesLimit!)
          && !((lease.monthlyBytesLimit ?? 0) > 0 && monthlyBytes > lease.monthlyBytesLimit!),
        reason: (lease.dailyBytesLimit ?? 0) > 0 && dailyBytes > lease.dailyBytesLimit! ? "daily_quota_exceeded"
          : (lease.monthlyBytesLimit ?? 0) > 0 && monthlyBytes > lease.monthlyBytesLimit! ? "monthly_quota_exceeded" : undefined,
        dailyBytes,
        monthlyBytes,
      };
    });
    return json(result, result.allowed ? 200 : result.reason === "session_lease_expired" ? 404 : 429);
  }
  private async renewSession(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (!input || !validKey(input.key) || typeof input.id !== "string") return json({ error: "invalid_request" }, 400);
    const now = Date.now();
    const renewed = await this.state.storage.transaction(async (txn) => {
      const key = `leases:${input.key}`;
      const leases = await txn.get<Lease[]>(key) ?? [];
      const lease = leases.find((entry) => entry.id === input.id && entry.expiresAt > now);
      if (!lease) return false;
      lease.expiresAt = now + SESSION_LEASE_TTL_MS;
      await txn.put(key, leases.filter((entry) => entry.expiresAt > now));
      return true;
    });
    return json({ ok: renewed }, renewed ? 200 : 404);
  }
  private async closeSession(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (!input || !validKey(input.key) || typeof input.id !== "string") return json({ error: "invalid_request" }, 400);
    const bytesUp = clampNumber(Number(input.bytesUp ?? 0), 0, 1e15);
    const bytesDown = clampNumber(Number(input.bytesDown ?? 0), 0, 1e15);
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    await this.state.storage.transaction(async (txn) => {
      const leaseKey = `leases:${input.key}`;
      const current = await txn.get<Lease[]>(leaseKey) ?? [];
      const lease = current.find((entry) => entry.id === input.id);
      const leases = current.filter((entry) => entry.id !== input.id && entry.expiresAt > Date.now());
      if (leases.length) await txn.put(leaseKey, leases); else await txn.delete(leaseKey);
      // Cumulative counters make close idempotent and reconcile any usage update that was still in flight.
      if (lease) {
        const delta = Math.max(0, bytesUp - (lease.bytesUp ?? 0)) + Math.max(0, bytesDown - (lease.bytesDown ?? 0));
        if (delta > 0) {
          const dailyKey = `usage:d:${input.key}`;
          const monthlyKey = `usage:m:${input.key}`;
          const daily = await txn.get<{ period: string; bytes: number }>(dailyKey);
          const monthly = await txn.get<{ period: string; bytes: number }>(monthlyKey);
          await txn.put(dailyKey, { period: day, bytes: (daily?.period === day ? daily.bytes : 0) + delta });
          await txn.put(monthlyKey, { period: month, bytes: (monthly?.period === month ? monthly.bytes : 0) + delta });
        }
      }
    });
    return json({ ok: true });
  }
  private async reportDc(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input || typeof input.endpoint !== "string" || input.endpoint.length > 255 || typeof input.ok !== "boolean") return json({ error: "invalid_request" }, 400);
    const endpoint = input.endpoint.replace(/[^a-zA-Z0-9.:\-[\]]/g, ""); if (!endpoint) return json({ error: "invalid_endpoint" }, 400);
    const latency = clampNumber(Number(input.latencyMs ?? 0), 0, 120_000); const now = Date.now(); const settings = await this.getSettings();
    let failureCount = 0;
    await this.state.storage.transaction(async (txn) => {
      const metrics = { ...EMPTY_METRICS, ...(await txn.get<Partial<ControlPlaneMetrics>>("metrics")) };
      const all = metrics.dcHealth ?? []; let record = all.find((x) => x.endpoint === endpoint);
      if (!record) { record = { endpoint, attempts: 0, successes: 0, totalFailures: 0, failures: 0, latencyVarianceMs2: 0, latencyEwmaMs: null, lastSuccessAt: null, lastFailureAt: null, cooldownUntil: 0 }; all.push(record); }
      record.attempts++;
      if (input.ok) {
        const previousLatency = record.latencyEwmaMs;
        record.successes = (record.successes ?? 0) + 1;
        record.failures = 0;
        record.latencyEwmaMs = previousLatency == null ? latency : previousLatency * .75 + latency * .25;
        record.latencyVarianceMs2 = previousLatency == null ? 0 : (record.latencyVarianceMs2 ?? 0) * .75 + ((latency - previousLatency) ** 2) * .25;
        record.lastSuccessAt = now; record.cooldownUntil = 0;
      } else {
        record.failures = Math.min(20, record.failures + 1);
        record.totalFailures = (record.totalFailures ?? 0) + 1;
        record.lastFailureAt = now; record.cooldownUntil = now + Math.min(300_000, settings.dcHealthCooldownMs * 2 ** Math.min(8, record.failures - 1));
      }
      failureCount = record.failures; metrics.dcHealth = all.sort((a, b) => a.endpoint.localeCompare(b.endpoint)).slice(-256); metrics.events.push({ at: now, type: input.ok ? "dc_probe_ok" : "dc_probe_fail", detail: endpoint }); metrics.events = metrics.events.slice(-100); await txn.put("metrics", metrics);
    });
    if (!input.ok && settings.alertWebhookUrl && failureCount >= settings.alertDcFailureThreshold) {
      const shouldSend = await this.state.storage.transaction(async (txn) => {
        const key = `alert:${endpoint}`; const previous = await txn.get<number>(key);
        if (previous && now - previous < 900_000) return false;
        await txn.put(key, now); return true;
      });
      if (shouldSend) await sendAlert(settings.alertWebhookUrl, { text: `ProxyGosha: DC endpoint ${endpoint} failed ${failureCount} consecutive probes.` });
    }
    return json({ ok: true, endpoint, failureCount });
  }
  private async createSubscription(request: Request): Promise<Response> {
    if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
    const input = await readJson(request);
    if (!input || typeof input.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(input.tokenHash)) return json({ error: "invalid_subscription" }, 400);
    const expiresAt = Number(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10 * 365 * 86_400_000) return json({ error: "invalid_expiry" }, 400);
    const limits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits) ? input.limits as Record<string, unknown> : {};
    const record: SubscriptionRecord = {
      id: crypto.randomUUID(), expiresAt, enabled: true, createdAt: Date.now(),
      ...(limits.maxConcurrentSessionsPerIp !== undefined ? { maxConcurrentSessionsPerIp: pickInt(limits, "maxConcurrentSessionsPerIp", 0, 0, 100) } : {}),
      ...(limits.dailyBytesPerIp !== undefined ? { dailyBytesPerIp: pickInt(limits, "dailyBytesPerIp", 0, 0, 1_000_000_000_000) } : {}),
      ...(limits.monthlyBytesPerIp !== undefined ? { monthlyBytesPerIp: pickInt(limits, "monthlyBytesPerIp", 0, 0, 10_000_000_000_000) } : {}),
    };
    await this.state.storage.put(`sub:${input.tokenHash}`, record);
    await this.state.storage.setAlarm(Date.now() + 86_400_000);
    return json({ subscription: record }, 201);
  }
  private async listSubscriptions(request: Request): Promise<Response> {
    if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
    const records = await this.state.storage.list<SubscriptionRecord>({ prefix: "sub:" });
    return json([...records.values()].map(({ id, expiresAt, enabled, createdAt, maxConcurrentSessionsPerIp, dailyBytesPerIp, monthlyBytesPerIp }) => ({ id, expiresAt, enabled, createdAt, maxConcurrentSessionsPerIp, dailyBytesPerIp, monthlyBytesPerIp })));
  }
  private async deleteSubscription(request: Request, id: string): Promise<Response> {
    if (!this.authorized(request)) return new Response("Not Found", { status: 404 });
    if (!/^[a-f0-9-]{36}$/i.test(id)) return json({ error: "invalid_id" }, 400);
    const records = await this.state.storage.list<SubscriptionRecord>({ prefix: "sub:" });
    for (const [key, record] of records) if (record.id === id) {
      record.enabled = false;
      await this.state.storage.put(key, record);
      return json({ ok: true, id });
    }
    return json({ error: "not_found" }, 404);
  }
  private async verifySubscription(request: Request): Promise<Response> {
    const input = await readJson(request);
    if (!input || typeof input.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(input.tokenHash)) return json({ error: "invalid_subscription" }, 400);
    const record = await this.state.storage.get<SubscriptionRecord>(`sub:${input.tokenHash}`);
    if (!record || !record.enabled || record.expiresAt <= Date.now()) return json({ valid: false }, 403);
    return json({ valid: true, id: record.id, expiresAt: record.expiresAt, limits: {
      ...(record.maxConcurrentSessionsPerIp !== undefined ? { maxConcurrentSessionsPerIp: record.maxConcurrentSessionsPerIp } : {}),
      ...(record.dailyBytesPerIp !== undefined ? { dailyBytesPerIp: record.dailyBytesPerIp } : {}),
      ...(record.monthlyBytesPerIp !== undefined ? { monthlyBytesPerIp: record.monthlyBytesPerIp } : {}),
    } });
  }
  private async updateSettings(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input) return json({ error: "invalid_json" }, 400);
    if (input.alertWebhookUrl !== undefined && !validWebhook(input.alertWebhookUrl)) return json({ error: "invalid_alert_webhook_url" }, 400);
    return this.persistSettings(input, "update");
  }
  private async importSettings(request: Request): Promise<Response> {
    const input = await readJson(request); if (!input || input.schemaVersion !== 1 || !input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) return json({ error: "invalid_export" }, 400);
    return this.persistSettings(input.settings as Record<string, unknown>, "import");
  }
  private async persistSettings(input: Record<string, unknown>, action: string): Promise<Response> {
    if (input.alertWebhookUrl !== undefined && !validWebhook(input.alertWebhookUrl)) return json({ error: "invalid_alert_webhook_url" }, 400);
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS)); const changed = Object.keys(input).filter((k) => allowed.has(k));
    const next = await this.state.storage.transaction(async (txn) => {
      const current = { ...DEFAULT_SETTINGS, ...(await txn.get<Partial<ControlPlaneSettings>>("settings")) };
      const n: ControlPlaneSettings = {
        rateLimitPerMinute: pickInt(input, "rateLimitPerMinute", current.rateLimitPerMinute, 1, 600),
        adaptiveDcSelection: input.adaptiveDcSelection === undefined ? current.adaptiveDcSelection : input.adaptiveDcSelection === true,
        dcHealthCooldownMs: pickInt(input, "dcHealthCooldownMs", current.dcHealthCooldownMs, 1_000, 300_000),
        dcConnectTimeoutMs: pickInt(input, "dcConnectTimeoutMs", current.dcConnectTimeoutMs, 500, 15_000),
        maxDcConnectAttempts: pickInt(input, "maxDcConnectAttempts", current.maxDcConnectAttempts, 1, 8),
        streamIdleTimeoutMs: pickInt(input, "streamIdleTimeoutMs", current.streamIdleTimeoutMs, 10_000, 3_600_000),
        maxSessionBytes: pickInt(input, "maxSessionBytes", current.maxSessionBytes, 0, 100_000_000_000),
        maxConcurrentSessionsPerIp: pickInt(input, "maxConcurrentSessionsPerIp", current.maxConcurrentSessionsPerIp, 0, 100),
        dailyBytesPerIp: pickInt(input, "dailyBytesPerIp", current.dailyBytesPerIp, 0, 1_000_000_000_000),
        monthlyBytesPerIp: pickInt(input, "monthlyBytesPerIp", current.monthlyBytesPerIp, 0, 10_000_000_000_000),
        historyHours: pickInt(input, "historyHours", current.historyHours, 24, 720),
        alertWebhookUrl: input.alertWebhookUrl === undefined ? current.alertWebhookUrl : validWebhook(input.alertWebhookUrl) ? input.alertWebhookUrl : "",
        alertDcFailureThreshold: pickInt(input, "alertDcFailureThreshold", current.alertDcFailureThreshold, 1, 20),
        requireSubscription: input.requireSubscription === undefined ? current.requireSubscription : input.requireSubscription === true,
      };
      await txn.put("settings", n);
      const metrics = { ...EMPTY_METRICS, ...(await txn.get<Partial<ControlPlaneMetrics>>("metrics")) }; metrics.audit = [...(metrics.audit ?? []), { at: Date.now(), action, changed }].slice(-200); await txn.put("metrics", metrics);
      return n;
    });
    const { alertWebhookUrl: _secret, ...safe } = next; return json(safe);
  }
}
async function sendAlert(url: string, payload: unknown): Promise<void> { try { const parsed = new URL(url); if (parsed.protocol !== "https:") return; await fetch(parsed, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(4_000) }); } catch { /* notifications must not affect proxy traffic */ } }
function validWebhook(value: unknown): value is string { if (typeof value !== "string" || value.length > 2_048) return false; if (!value) return true; try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === ""; } catch { return false; } }
function validKey(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{32,64}$/.test(value); }
async function readJson(request: Request): Promise<Record<string, unknown> | null> { try { const v: unknown = await request.json(); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; } }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function clampInteger(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min; }
function clampNumber(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }
function pickInt(input: Record<string, unknown>, key: string, current: number, min: number, max: number): number { return input[key] === undefined ? current : clampInteger(Number(input[key]), min, max); }
function constantTimeEqual(a: string, b: string): boolean { const x = new TextEncoder().encode(a); const y = new TextEncoder().encode(b); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; }
