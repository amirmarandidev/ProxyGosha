import test from 'node:test';
import assert from 'node:assert/strict';
import { DcHealthRegistry } from '../../src/dc-health.ts';

test('DC health prefers known healthy endpoints over endpoints in cooldown', () => {
  let now = 10_000;
  const health = new DcHealthRegistry({ cooldownMs: 2_000, now: () => now });
  const slow = { hostname: 'dc-a.example', port: 443 };
  const fast = { hostname: 'dc-b.example', port: 443 };
  health.reportFailure(slow);
  health.reportSuccess(fast, 35);
  assert.deepEqual(health.order([slow, fast]).map((x) => x.hostname), ['dc-b.example', 'dc-a.example']);
  now += 2_100;
  assert.deepEqual(health.order([slow, fast]).map((x) => x.hostname), ['dc-b.example', 'dc-a.example']);
});

test('DC health applies exponential cooldown and recovers after success', () => {
  let now = 1_000;
  const health = new DcHealthRegistry({ cooldownMs: 1_000, now: () => now });
  const target = { hostname: 'dc.example', port: 443 };
  health.reportFailure(target);
  assert.equal(health.snapshot()[0].cooldownUntil, 2_000);
  now = 2_100;
  health.reportFailure(target);
  assert.equal(health.snapshot()[0].cooldownUntil, 4_100);
  health.reportSuccess(target, 42);
  assert.equal(health.snapshot()[0].failures, 0);
  assert.equal(health.snapshot()[0].cooldownUntil, 0);
  assert.equal(health.snapshot()[0].latencyEwmaMs, 42);
});

test('DC health can be disabled and retains configured order', () => {
  const health = new DcHealthRegistry();
  const targets = [{ hostname: 'b', port: 443 }, { hostname: 'a', port: 443 }];
  health.reportFailure(targets[0]);
  assert.deepEqual(health.order(targets, false), targets);
});

test('DC health ranks previously healthy endpoints ahead of unknown endpoints', () => {
  const health = new DcHealthRegistry({ now: () => 10_000 });
  const unknown = { hostname: 'unknown.example', port: 443 };
  const healthy = { hostname: 'healthy.example', port: 443 };
  health.reportSuccess(healthy, 28);
  assert.deepEqual(health.order([unknown, healthy]).map((x) => x.hostname), ['healthy.example', 'unknown.example']);
});

test('shared endpoint observations seed the local adaptive selector', () => {
  const registry = new DcHealthRegistry({ now: () => 10_000 });
  registry.mergeShared([{ hostname: 'dc-a.example', port: 443, failures: 4, latencyEwmaMs: 90, cooldownUntil: 20_000, lastSuccessAt: 5_000 }]);
  assert.equal(registry.snapshot()[0].failures, 4);
  assert.deepEqual(registry.order([{ hostname: 'dc-a.example', port: 443 }, { hostname: 'dc-b.example', port: 443 }]).map((x) => x.hostname), ['dc-b.example', 'dc-a.example']);
});


test("DC ranking penalizes high latency and decays stale failure observations", () => {
  let now = 1_000_000;
  const registry = new DcHealthRegistry({ cooldownMs: 1_000, now: () => now });
  const highLatency = { hostname: "slow.example", port: 443 };
  const lowLatency = { hostname: "fast.example", port: 443 };
  registry.reportSuccess(highLatency, 900);
  registry.reportSuccess(lowLatency, 35);
  assert.deepEqual(registry.order([highLatency, lowLatency]).map((x) => x.hostname), ["fast.example", "slow.example"]);
  registry.reportFailure(highLatency);
  assert.equal(registry.order([highLatency, lowLatency])[0].hostname, "fast.example");
  now += 20 * 60_000;
  assert.equal(registry.order([highLatency, lowLatency])[0].hostname, "fast.example");
});

test("IPv6 endpoint keys round-trip through local health snapshots", () => {
  const registry = new DcHealthRegistry();
  registry.reportSuccess({ hostname: "2001:db8::1", port: 443 }, 25);
  assert.deepEqual(registry.snapshot()[0], { hostname: "2001:db8::1", port: 443, failures: 0, latencyEwmaMs: 25, cooldownUntil: 0, lastSuccessAt: registry.snapshot()[0].lastSuccessAt, lastFailureAt: null, attempts: 1, successes: 1, totalFailures: 0, latencyVarianceMs2: 0 });
});


test('DC ranking penalizes unstable latency and sustained historical failure rate', () => {
  let now = 50_000;
  const registry = new DcHealthRegistry({ cooldownMs: 1_000, now: () => now });
  const stable = { hostname: 'stable.example', port: 443 };
  const unstable = { hostname: 'unstable.example', port: 443 };
  registry.reportSuccess(stable, 70);
  registry.reportSuccess(stable, 72);
  registry.reportSuccess(unstable, 10);
  registry.reportSuccess(unstable, 900);
  assert.equal(registry.snapshot().find(x => x.hostname === 'unstable.example').latencyVarianceMs2 > 0, true);
  registry.reportFailure(stable);
  now += 2_000;
  registry.reportSuccess(stable, 71);
  const stableState = registry.snapshot().find(x => x.hostname === 'stable.example');
  assert.equal(stableState.attempts, 4);
  assert.equal(stableState.successes, 3);
  assert.equal(stableState.totalFailures, 1);
});

test('shared health snapshots without new fields remain backward compatible', () => {
  const registry = new DcHealthRegistry({ now: () => 10_000 });
  registry.mergeShared([{ hostname: 'legacy.example', port: 443, failures: 2, latencyEwmaMs: 100, cooldownUntil: 0, lastSuccessAt: 9_000, lastFailureAt: 8_000 }]);
  assert.equal(registry.snapshot()[0].attempts, 0);
  assert.equal(registry.order([{ hostname: 'legacy.example', port: 443 }]).length, 1);
});


test('DC selector prefers an endpoint with a better long-run success ratio', () => {
  const registry = new DcHealthRegistry({ now: () => 100_000 });
  const reliable = { hostname: 'reliable.example', port: 443 };
  const flaky = { hostname: 'flaky.example', port: 443 };
  for (let i = 0; i < 8; i++) registry.reportSuccess(reliable, 100);
  for (let i = 0; i < 4; i++) registry.reportFailure(flaky);
  for (let i = 0; i < 4; i++) registry.reportSuccess(flaky, 100);
  assert.deepEqual(registry.order([flaky, reliable]).map(x => x.hostname), ['reliable.example', 'flaky.example']);
});
