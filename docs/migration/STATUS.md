# TypeScript Migration Status

## Current milestone: TypeScript entry point selected; expanded operational roadmap implemented; staging and external-client validation pending

The user reported that all previously requested tests passed, including the
workerd TCP integration and compatibility-date comparison. The TypeScript Worker
is now selected in `wrangler.jsonc` as `main: "src/index.ts"`. The original
`worker.js` remains unchanged and is retained as the rollback/baseline implementation.

### Completed

- [x] Preserve the original single-file Worker as the behavioral baseline and rollback copy.
- [x] Add Wrangler configuration, npm scripts, and strict TypeScript configuration.
- [x] Port configuration, environment resolution, crypto helpers, token handling, and AES-CTR random access.
- [x] Port frame encoding/decoding and pure Obfuscated2 parsing helpers.
- [x] Port WebSocket session state, lane restrictions, heartbeat, tombstones, and teardown.
- [x] Port TCP stream handshake, key derivation, DC selection/failover, forwarding, flow control, and cleanup.
- [x] Port the WebSocket transport adapter and authenticated session/WebSocket routes.
- [x] Add the Cloudflare Worker entry point with `cloudflare:sockets`, `WebSocketPair`, and HTTP 101 upgrade handling.
- [x] Port setup/admin pages, browser bridge, secret generator, diagnostics, health routes, and decoy templates.
- [x] Add unit tests, baseline contract checks, authenticated E2E harness, Node TCP loopback test, protocol differential test, and workerd TCP test harness.
- [x] User-reported `npm install`, `npm run check`, `npm run smoke:worker`, `npm run test:e2e`, `npm run test:tcp-integration`, `npm run test:protocol-diff`, `npm run test:workerd-tcp`, and compatibility-date check passed.
- [x] Select `src/index.ts` as the Wrangler entry point.
- [x] Add a separate Wrangler config for deploying the original JavaScript baseline.
- [x] Document side-by-side staging and independent Telegram Desktop acceptance testing.
- [x] Preserve and explicitly inventory all original user-facing routes and bridge functionality.
- [x] Add a SQLite Durable Object control plane for aggregate counters and configurable hourly history (24–720 hours).
- [x] Add sharded, fixed-window distributed rate limiting with hashed client identifiers and isolate-local fallback.
- [x] Add sharded per-IP concurrent-session leases and daily/monthly traffic admission accounting.
- [x] Add global per-endpoint DC health records, live connect feedback, scheduled five-minute TCP probes, and status-page analytics.
- [x] Add HTTPS webhook alerts for repeated DC endpoint failures.
- [x] Add schema-versioned operational settings export/import and redacted configuration audit history.
- [x] Bound inbound WebSocket message backlog and align frame encoder payload limits with decoder limits.
- [x] Add adaptive DC endpoint ranking using EWMA connect latency and exponential failure cooldown.
- [x] Add configurable TCP stream inactivity timeout.
- [x] Add authenticated runtime settings API for rate limits, adaptive DC selection, DC cooldown, and stream idle timeout.
- [x] Add GitHub Actions CI and manual staging/production deployment workflows.
- [x] Add unit tests for the control plane, settings validation, rate limiting, DC health scoring, and stream idle cleanup.
- [x] Add a second workerd TCP round-trip harness for the default `websocket-lanes` carrier.
- [x] Add optional subscription credentials with hashed storage, expiry, revocation, per-subscription limits, and session-token binding for custom clients.
- [x] Add IPv4/IPv6/DNS DC endpoint overrides and custom TCP port configuration.
- [x] Improve adaptive DC scoring with decaying failure/staleness penalties.
- [x] Reduce inbound frame allocations with zero-copy frame views and queue retention.

### Remaining before production can be considered migrated

- [ ] Deploy the JavaScript baseline and TypeScript candidate to separate staging Workers.
- [ ] Complete the independent Telegram Desktop WEB-proxy test against both candidates.
- [ ] Deploy the TypeScript Worker to the existing production Worker. This requires the operator's Cloudflare authentication and production settings.
- [ ] Run production HTTP, WebSocket, and Telegram-client smoke tests after deployment.
- [ ] Generate/retain a dependency lockfile and commit it when ready. The npm registry request timed out here, and the packages are not cached offline.
- [ ] Run the new workerd TCP harnesses for both carriers after installing the updated dependencies; Wrangler could not be installed in this environment because the npm registry request timed out.

## Validation boundaries

The user-reported automated checks validate local unit behavior, baseline helper
differential behavior, Wrangler/workerd request and TCP handling, and the configured
compatibility date. They do not establish a live Telegram Desktop connection or a
Cloudflare production deployment. Independent Telegram-client acceptance and
production smoke tests remain outstanding.

## Compatibility and rollback

`wrangler.jsonc` and `wrangler.baseline.jsonc` currently use compatibility date
`2026-11-13`. The user reported that the date comparison passed against the original
deployment. Re-run `npm run check:compatibility-date` if that source date changes.

The production entry point in the main config is `src/index.ts`. The main config
uses Wrangler's declarative `exports` field to provision the SQLite Durable Object.
For a rollback of that same Worker, change `main` in `wrangler.jsonc` to
`src/baseline-entry.js`, retain the `CONTROL_PLANE` binding and `exports` entry, and
deploy with the same Worker name. The wrapper serves the original `worker.js` and
re-exports the Durable Object class. `wrangler.baseline.jsonc` is for a separate
side-by-side baseline Worker and therefore has its own namespace. The original
source file remains byte-identical.

## Known deployment limitation

No Cloudflare account credentials or connected Cloudflare deployment tool are
available in this environment. Therefore no Worker has been deployed and no
production routes, secrets, or custom domains have been changed here. Follow
[`DEPLOYMENT-AND-CLIENT-VALIDATION.md`](DEPLOYMENT-AND-CLIENT-VALIDATION.md).


## Latest local validation

The latest local Node suite passed 106 tests with Node.js 22.16.0 using
`node --experimental-strip-types --test`. Global TypeScript 5.8.3 `tsc --noEmit`
also passed. The npm dependency install timed out, so the updated Wrangler build,
workerd TCP harnesses, and npm audit remain unverified for this revision. See
[`ROADMAP-COMPLETION.md`](ROADMAP-COMPLETION.md) for exact scope and limitations.


### Subscription and endpoint limitations

Subscription credentials are for compatible custom clients that can send `X-Proxy-Gosha-Subscription` on both `/api/v1/session` and `/api/v1/ws`. Do not enable `requireSubscription` for stock Telegram clients unless a client-side mechanism for supplying that header is available. This does not add Telegram account identity or billing.

DC IPv6 support applies to configured Worker-to-DC TCP endpoints. It does not prove client-to-Worker IPv6 connectivity or application-level Telegram health.

## v4 latest implementation and validation (2026-11-14)

The latest source adds 16-shard metrics and DC-health storage, 16-shard subscription storage with legacy global-object reads, five-second DC-health snapshot caching, 90-second session leases, per-lane heartbeat renewal, heartbeat subscription revocation checks, fail-closed distributed rate limiting when a configured control-plane shard is unavailable, and secure failure instead of a predictable outbound DC-header fallback.

Latest local results: `npm run test:all` passed 116 tests; `tsc --noEmit` passed; `npm run bench:core` executed. Wrangler dry-run and workerd tests remain unrun because npm dependency installation timed out. Dependency audit remains unrun because no lockfile exists. Compatibility-date comparison requires the exact date from the currently deployed original Worker. Cloudflare staging/production deployment and Telegram Desktop acceptance still require operator access.

See [`OPERATOR-VERIFICATION-CHECKLIST.md`](OPERATOR-VERIFICATION-CHECKLIST.md).

## v5 engineering pass (2026-11-14)

### Completed in source

- Configurable DC connect timeout and bounded maximum sequential attempts, exposed through authenticated runtime settings.
- Endpoint health now tracks attempts, successes, cumulative failure ratio, latency variance/jitter, consecutive failures, cooldown and observation age. Older persisted records remain readable.
- Adaptive endpoint ranking incorporates those measurements with decaying penalties.
- Selective queue buffer compaction avoids pinning large backing WebSocket buffers for tiny queued payloads while preserving zero-copy views for ordinary frames.
- Optional `bufferedAmount` safety guard when that property is exposed by the runtime; Cloudflare's current Worker WebSocket reference does not document the property, so it is not relied on for primary queue safety.
- Multi-size encode/decode and DC ranking microbenchmarks.
- Native ME research document based on public Telegram MTProxy source.

### v5 local verification

- `npm run test:all` passed. Main Node suite: 124 passed, 0 failed; protocol differential: 4 passed; TCP loopback: 1 passed; control-plane: 14 passed; DC-health: 10 passed.
- `npm run typecheck` passed.
- `npm run bench:core` executed on Node.js 22.16.0.
- `worker.js` SHA-256 remains unchanged: `eab160c0ad75fad9e5c275cf39cd1b6d3b5a7a2241d9b3626de08df02ef8948f`.

### Still pending

- Wrangler build and workerd TCP tests for both carriers in an environment with installed dependencies.
- Dependency lockfile generation and `npm audit`.
- Cloudflare staging deployment, live endpoint measurements, multi-region load testing and Telegram Desktop acceptance.
- Native ME RPC implementation and test endpoint. The public MTProxy source exposes internal front/ME RPC structures and handshake code, but no compatible ME service was available for integration testing. See `NATIVE-ME-RESEARCH.md`.
- Protocol-aware established-stream recovery, payment integration and Telegram-native user identity remain unimplemented.
