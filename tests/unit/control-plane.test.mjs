import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyGoshaControlPlane } from '../../src/observability/control-plane.ts';

class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix))); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async transaction(callback) { return callback(this); }
}

function setup() {
  const storage = new MemoryStorage();
  const plane = new ProxyGoshaControlPlane({ storage }, { ADMIN_KEY: 'a-very-long-admin-secret' });
  return { plane, storage };
}

async function json(response) { return response.json(); }

test('control plane aggregates bounded metrics and event history', async () => {
  const { plane } = setup();
  const response = await plane.fetch(new Request('https://control/v1/metrics', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions: 2, bytesUp: 1234, bytesDown: 5678, streams: 3, type: 'test', detail: 'unit' }),
  }));
  assert.equal(response.status, 200);
  const metrics = await json(await plane.fetch(new Request('https://control/v1/metrics')));
  assert.equal(metrics.sessions, 2);
  assert.equal(metrics.sessionsActive, 0);
  assert.equal(metrics.history.length, 1);
  assert.equal(metrics.bytesUp, 1234);
  assert.equal(metrics.bytesDown, 5678);
  assert.equal(metrics.streams, 3);
  assert.equal(metrics.events.at(-1).type, 'test');
});

test('control plane rate limit uses atomic fixed windows', async () => {
  const { plane } = setup();
  const call = () => plane.fetch(new Request('https://control/v1/rate-limit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '0123456789abcdef0123456789abcdef', limit: 2, windowSeconds: 60 }),
  }));
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
});

test('control plane requires admin key to update operational settings', async () => {
  const { plane } = setup();
  const body = JSON.stringify({ rateLimitPerMinute: 240, adaptiveDcSelection: false, dcHealthCooldownMs: 30_000, streamIdleTimeoutMs: 90_000, maxSessionBytes: 1_000_000, streamIdleTimeoutMs: 90_000 });
  const denied = await plane.fetch(new Request('https://control/v1/settings', { method: 'PUT', body }));
  assert.equal(denied.status, 404);
  const allowed = await plane.fetch(new Request('https://control/v1/settings', {
    method: 'PUT', headers: { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' }, body,
  }));
  assert.equal(allowed.status, 200);
  assert.deepEqual(await json(await plane.fetch(new Request('https://control/v1/settings'))), {
    rateLimitPerMinute: 240, adaptiveDcSelection: false, dcHealthCooldownMs: 30_000, dcConnectTimeoutMs: 3_000, maxDcConnectAttempts: 4, streamIdleTimeoutMs: 90_000, maxSessionBytes: 1_000_000,
    maxConcurrentSessionsPerIp: 0, dailyBytesPerIp: 0, monthlyBytesPerIp: 0, historyHours: 168, alertWebhookUrl: "", alertDcFailureThreshold: 5, requireSubscription: false,
  });
});

test('control plane clamps invalid operational settings to safe bounds', async () => {
  const { plane } = setup();
  await plane.fetch(new Request('https://control/v1/settings', {
    method: 'PUT', headers: { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ rateLimitPerMinute: 10000, dcHealthCooldownMs: 1, streamIdleTimeoutMs: 1, maxSessionBytes: 1_000_000_000_000 }),
  }));
  const settings = await json(await plane.fetch(new Request('https://control/v1/settings')));
  assert.equal(settings.rateLimitPerMinute, 600);
  assert.equal(settings.dcHealthCooldownMs, 1_000);
  assert.equal(settings.streamIdleTimeoutMs, 10_000);
  assert.equal(settings.maxSessionBytes, 100_000_000_000);
});


test('session leases enforce concurrent limits and account daily/monthly traffic by hashed IP', async () => {
  const storage = new MemoryStorage();
  const plane = new ProxyGoshaControlPlane({ storage }, { ADMIN_KEY: 'a-very-long-admin-secret' });
  await plane.fetch(new Request('https://control/v1/settings', { method: 'PUT', headers: { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ maxConcurrentSessionsPerIp: 1, dailyBytesPerIp: 1000, monthlyBytesPerIp: 2000 }) }));
  const key = '0123456789abcdef0123456789abcdef';
  const open = (id) => plane.fetch(new Request('https://control/v1/session/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id }) }));
  assert.equal((await open('session-0000000001')).status, 200);
  const blocked = await open('session-0000000002'); assert.equal(blocked.status, 429); assert.equal((await json(blocked)).reason, 'concurrent_session_limit');
  await plane.fetch(new Request('https://control/v1/session/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id: 'session-0000000001', bytesUp: 400, bytesDown: 700 }) }));
  const quotaBlocked = await open('session-0000000003'); assert.equal(quotaBlocked.status, 429); assert.equal((await json(quotaBlocked)).reason, 'daily_quota_exceeded');
});

test('DC health is aggregated globally and settings changes are audited without values', async () => {
  const { plane } = setup();
  const report = (ok) => plane.fetch(new Request('https://control/v1/dc/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: '149.154.167.50:443', ok, latencyMs: 25 }) }));
  await report(true); await report(false);
  const health = await json(await plane.fetch(new Request('https://control/v1/dc/health')));
  assert.equal(health.length, 1); assert.equal(health[0].attempts, 2); assert.equal(health[0].successes, 1); assert.equal(health[0].totalFailures, 1); assert.equal(health[0].failures, 1);
  await plane.fetch(new Request('https://control/v1/settings', { method: 'PUT', headers: { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ historyHours: 240 }) }));
  const audit = await json(await plane.fetch(new Request('https://control/v1/audit')));
  assert.equal(audit.at(-1).action, 'update'); assert.deepEqual(audit.at(-1).changed, ['historyHours']);
  const exported = await plane.fetch(new Request('https://control/v1/settings/export', { headers: { 'x-proxy-gosha-admin': 'a-very-long-admin-secret' } }));
  assert.equal(exported.status, 200); assert.equal('alertWebhookUrl' in (await json(exported)).settings, false);
});

test('closing a missing or already-closed lease does not double count quota usage', async () => {
  const { plane } = setup();
  const key = '0123456789abcdef0123456789abcdef';
  const body = JSON.stringify({ key, id: 'session-0000000001', bytesUp: 900, bytesDown: 100 });
  const close = () => plane.fetch(new Request('https://control/v1/session/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  await close(); await close();
  const open = await plane.fetch(new Request('https://control/v1/session/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id: 'session-0000000002' }) }));
  assert.equal(open.status, 200);
});

test('settings import is schema-checked and does not overwrite the secret webhook URL', async () => {
  const { plane } = setup();
  const headers = { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' };
  await plane.fetch(new Request('https://control/v1/settings', { method: 'PUT', headers, body: JSON.stringify({ alertWebhookUrl: 'https://hooks.example.test/proxy' }) }));
  const imported = await plane.fetch(new Request('https://control/v1/settings/import', { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, settings: { rateLimitPerMinute: 77, historyHours: 240 } }) }));
  assert.equal(imported.status, 200);
  const settings = await json(await plane.fetch(new Request('https://control/v1/settings')));
  assert.equal(settings.rateLimitPerMinute, 77);
  assert.equal(settings.historyHours, 240);
  assert.equal(settings.alertWebhookUrl, 'https://hooks.example.test/proxy');
  const invalid = await plane.fetch(new Request('https://control/v1/settings', { method: 'PUT', headers, body: JSON.stringify({ alertWebhookUrl: 'http://insecure.example.test/hook' }) }));
  assert.equal(invalid.status, 400);
});

test('maintenance alarm removes expired rate-limit entries and expired session leases', async () => {
  const { plane, storage } = setup();
  await storage.put('rl:expired', { window: 1 });
  await storage.put('leases:0123456789abcdef0123456789abcdef', [{ id: 'stale-session-0001', expiresAt: 1 }]);
  await plane.alarm();
  assert.equal(await storage.get('rl:expired'), undefined);
  assert.equal(await storage.get('leases:0123456789abcdef0123456789abcdef'), undefined);
  assert.equal(storage.alarmAt, undefined);
});


test('session usage is charged incrementally and idempotently, then enforces daily quota', async () => {
  const { plane, storage } = setup();
  const admin = { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' };
  const settings = await plane.fetch(new Request('https://control/v1/settings', {
    method: 'PUT', headers: admin, body: JSON.stringify({ dailyBytesPerIp: 100, monthlyBytesPerIp: 1_000 }),
  }));
  assert.equal(settings.status, 200);
  const key = '0123456789abcdef0123456789abcdef';
  const id = 'session-identifier-0001';
  const opened = await plane.fetch(new Request('https://control/v1/session/open', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id }),
  }));
  assert.equal(opened.status, 200);
  const usage = (bytesUp, bytesDown) => plane.fetch(new Request('https://control/v1/session/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id, bytesUp, bytesDown }),
  }));
  assert.equal((await usage(40, 20)).status, 200);
  assert.equal((await usage(40, 20)).status, 200, 'repeated cumulative totals must not be charged twice');
  assert.equal((await usage(80, 30)).status, 429, 'traffic above the daily quota must be rejected');
  const today = new Date().toISOString().slice(0, 10);
  const daily = await storage.get(`usage:d:${key}`);
  assert.equal(daily.period, today);
  assert.equal(daily.bytes, 110);
  await plane.fetch(new Request('https://control/v1/session/close', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id, bytesUp: 80, bytesDown: 30 }),
  }));
  assert.equal((await storage.get(`usage:d:${key}`)).bytes, 110, 'close must reconcile without double charging');
});

test('session usage rejects expired or unknown leases', async () => {
  const { plane } = setup();
  const response = await plane.fetch(new Request('https://control/v1/session/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '0123456789abcdef0123456789abcdef', id: 'missing-session-0001', bytesUp: 10, bytesDown: 0 }),
  }));
  assert.equal(response.status, 404);
});


test('subscription credentials are stored by hash, verified, listed without hashes, and revocable', async () => {
  const { plane, storage } = setup();
  const tokenHash = 'a'.repeat(64);
  const admin = { 'x-proxy-gosha-admin': 'a-very-long-admin-secret', 'content-type': 'application/json' };
  const created = await plane.fetch(new Request('https://control/v1/subscriptions', { method: 'POST', headers: admin, body: JSON.stringify({ tokenHash, expiresAt: Date.now() + 86_400_000, limits: { dailyBytesPerIp: 5000, maxConcurrentSessionsPerIp: 2 } }) }));
  assert.equal(created.status, 201);
  const record = (await created.json()).subscription;
  assert.equal(record.dailyBytesPerIp, 5000);
  assert.ok(storage.values.has(`sub:${tokenHash}`));
  const verified = await plane.fetch(new Request('https://control/v1/subscriptions/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenHash }) }));
  assert.equal((await verified.json()).valid, true);
  const listed = await plane.fetch(new Request('https://control/v1/subscriptions', { headers: admin }));
  assert.equal(JSON.stringify(await listed.json()).includes(tokenHash), false);
  const revoked = await plane.fetch(new Request(`https://control/v1/subscriptions/${record.id}`, { method: 'DELETE', headers: admin }));
  assert.equal(revoked.status, 200);
  const denied = await plane.fetch(new Request('https://control/v1/subscriptions/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenHash }) }));
  assert.equal(denied.status, 403);
});

test('expired session leases cannot be revived by a late heartbeat', async () => {
  const { plane, storage } = setup();
  const key = '0123456789abcdef0123456789abcdef';
  const id = 'session-identifier-0001';
  await storage.put(`leases:${key}`, [{ id, expiresAt: Date.now() - 1 }]);
  const response = await plane.fetch(new Request('https://control/v1/session/renew', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id }),
  }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
});


test('runtime settings validate configurable DC connection timeout and attempt count', async () => {
  const { plane } = setup();
  const response = await plane.fetch(new Request('https://control/v1/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-proxy-gosha-admin': 'a-very-long-admin-secret' },
    body: JSON.stringify({ dcConnectTimeoutMs: 750, maxDcConnectAttempts: 6 }),
  }));
  assert.equal(response.status, 200);
  const settings = await json(await plane.fetch(new Request('https://control/v1/settings')));
  assert.equal(settings.dcConnectTimeoutMs, 750);
  assert.equal(settings.maxDcConnectAttempts, 6);
});
