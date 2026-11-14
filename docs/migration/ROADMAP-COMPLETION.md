# Roadmap implementation report

## Implemented in this revision

- Global Durable Object endpoint health records, EWMA latency, failure counts and cooldown state, fed into each new session's local adaptive selector.
- Global DC endpoint dashboard, live connection reporting and five-minute scheduled TCP probes.
- Per-hashed-client-key concurrent WebSocket session admission with expiring leases.
- Per-hashed-client-key daily/monthly traffic quotas with transactional incremental accounting,
  cumulative per-session counters, idempotent reconciliation at close, and fail-closed
  behavior when configured quota enforcement loses its control-plane connection.
- Configurable hourly metric retention up to 30 days.
- HTTPS webhook alerts for repeated endpoint failures.
- Schema-versioned operational config export/import.
- Redacted config audit history (changed key names only; no values or secrets).
- Bounded inbound and quota-enabled outbound WebSocket processing queues, plus
  encoder/decoder frame-size symmetry.
- Session lease renewal on the main WebSocket heartbeat and traffic updates.
- Optional Cloudflare Access user identity attribution for per-user session limits
  and quotas when the Worker receives an authenticated `ctx.access` identity; raw
  email is hashed before Durable Object storage. IP hashing remains the fallback.
- Scheduled health probes cover every configured DC IP and configured DC port,
  with concurrency bounded to eight probes per batch.
- Idempotent session lease release to avoid double-accounting on duplicate close paths.

## Deliberately not implemented as a false promise

### Native Telegram Middle-End

A real ME integration requires the actual ME gateway protocol and an independently
operable egress component. The repository's Worker cannot safely invent that
protocol. The architecture requirements and integration boundary are documented in
`NEW-FEATURES.md`; Direct-DC remains the active transport.

### Established stream recovery

A broken TCP connection cannot be resumed by replaying arbitrary encrypted MTProto
bytes. The client/server cryptographic and protocol state must be re-established
through a protocol-aware procedure. This revision improves bounded queueing,
connection failover before stream establishment, endpoint telemetry and cleanup,
but does not replay or resume an established stream.

## Validation status for this revision

- `npm run test:all`: 99 tests passed, 0 failed, on Node.js 22.16.0.
- TypeScript compiler: `tsc --noEmit` passed (the globally available compiler).
- Wrangler uses the declarative Durable Object `exports` lifecycle field; the
  `migrations` array is intentionally not combined with it because Cloudflare
  documents those configuration paths as mutually exclusive.
- npm dependency installation did not complete in this environment because the
  npm registry request timed out. An offline lockfile generation attempt also failed
  because required package metadata was not cached. Consequently the Wrangler/workerd
  carrier harnesses, Wrangler dry-run build and dependency audit were not run.
- A `package-lock.json` is still absent. Generate and commit it in an environment
  with registry access before switching CI to `npm ci`.
- No Cloudflare deployment or live Telegram Desktop acceptance test was performed.


## Additional work completed in the follow-up revision

- Daily/monthly per-client-key quotas are no longer close-only admission counters. Each
  WebSocket session reports cumulative byte counters; the control plane applies only
  new deltas transactionally and idempotently, and checks quota before outbound frame
  delivery and before inbound frame dispatch.
- Quota enforcement fails closed if the configured control plane is unavailable.
- Active leases are refreshed by the main WebSocket heartbeat and traffic updates.
- Scheduled probes now test all configured DC IP/port combinations, in batches of
  at most eight concurrent probes.
- Added tests for quota overrun, cumulative counter idempotency, lease expiry, and
  transport rejection when quota checks fail.

## Still not implemented

- Native Telegram account identity, billing, automatic renewal, and customer
  subscription management: the optional opaque subscription credential foundation
  works only for compatible custom clients that can send the required header. The
  stock Telegram v1.2.2 handshake does not carry a verified Telegram account identity.
- Native Telegram ME gateway: requires a documented and testable upstream gateway
  protocol and separately operated egress component.
- Established TCP/MTProto stream resumption: arbitrary encrypted stream replay is
  unsafe without protocol-aware resume semantics.
- Live Cloudflare staging/production deployment, GitHub Actions run, workerd harness
  run, dependency audit, and Telegram Desktop acceptance remain external validation
  tasks. No credentials or live deployment were available in this environment.


## Follow-up implementation: subscription foundation, IPv6, adaptive routing, and core efficiency

### Subscription identity foundation

- Added admin-managed opaque subscription credentials. The plaintext credential is returned once at creation; the control plane stores only its SHA-256 digest.
- Added listing and immediate revocation, expiration checks, and optional per-subscription concurrent-session and daily/monthly traffic limits.
- Added `requireSubscription` runtime policy and the `X-Proxy-Gosha-Subscription` header on both session creation and WebSocket upgrade.
- Derived the session-token HMAC key from the validated subscription credential, so a session token issued under one subscription cannot be used with another subscription credential. The wire token shape and v1.2.2 framing remain unchanged.
- This is a custom-client identity foundation, not native Telegram account identity, billing, renewal, or a customer portal. Native Telegram clients generally cannot attach arbitrary headers; do not enable `requireSubscription` for an unmodified Telegram client deployment.

### IPv6 and network-path diagnostics

- Added `DC1`, `DC2`, `DC3`, `DC4`, `DC5`, and `DC203` endpoint overrides supporting IPv4, IPv6, and DNS hostnames.
- Added `DC_PORTS` to override the TCP port list.
- Manual status probes and scheduled endpoint probes pass IPv6 literals to Cloudflare sockets without square brackets. Health telemetry endpoint parsing remains based on the final colon-delimited port.
- These checks measure TCP connection reachability and latency only; they do not test MTProto/Telegram application health, IPv6 client-to-Worker paths, or ISP routing quality.

### Adaptive DC selection

- Ranking now combines EWMA connect latency, cooldown, consecutive failures, and observation age. Failure and stale-observation penalties decay over time.
- This remains endpoint-performance routing, not geography-aware or ISP-aware routing.

### Proxy-core efficiency

- Frame payload decoding uses zero-copy subarray views.
- TCP stream inbound queues retain those views rather than making a second payload copy.
- Frame length encoding avoids a per-frame `DataView` allocation.
- No throughput or production-memory benchmark has been run; these changes reduce allocations by construction but are not presented as a measured speedup.

### Validation after this follow-up

- Node.js 22.16.0 unit suite: 106 tests passed, 0 failed.
- TypeScript `tsc --noEmit` passed after the implementation changes.
- Protocol differential and TCP loopback integration tests passed after the core changes.
- Wrangler/workerd carrier tests, Wrangler dry-run build, npm audit, Cloudflare deployment, and Telegram Desktop acceptance remain unverified in this environment.

See `SCALING-AND-CORE-OPTIMIZATION.md` for the recommended Part 5 Durable Object partitioning sequence and the migration trade-offs.

## Latest completion pass: v4 (2026-11-14)

This section supersedes the earlier test counts and partitioning status above.

### Additional implementation completed

- Partitioned operational metrics across 16 deterministic named Durable Object shards; status/dashboard reads aggregate shard counters and hourly buckets.
- Partitioned DC health reports by endpoint across the same 16 shards; isolate-local snapshots are cached for five seconds to limit control-plane reads on WebSocket admission.
- Partitioned new subscription records across 16 token-hash shards. Admin listing aggregates the shards, deletion searches them, and verification checks both the new shard and the legacy global object for v3 subscription compatibility.
- Kept operational settings and audit history centralized; session leases and rate-limit records retain their existing 256 per-client-key shards.
- Changed session leases to a 90-second TTL, renewed by every WebSocket lane heartbeat. Expired leases cannot be revived by late heartbeats.
- Revalidate subscription expiry/revocation during heartbeat. A failed lease renewal or subscription revalidation closes the active WebSocket; expected revocation propagation is within a heartbeat interval (25 seconds), subject to scheduling and control-plane availability.
- Configured distributed rate limiting now fails closed when its Durable Object shard is unavailable; local in-memory fallback remains only when no control-plane binding is configured.
- Removed the predictable fallback bytes for outbound Obfuscated2 DC header generation; unsafe randomness now rejects the stream.
- Added subscription/metrics/DC-health shard tests, lease-revival tests, heartbeat rejection tests, outage tests, and a repeatable `npm run bench:core` microbenchmark.

### v4 local verification

- `npm run test:all`: 116 tests passed, 0 failed.
- `tsc --noEmit`: passed with the globally available TypeScript compiler.
- `npm run bench:core`: executed successfully on Node.js 22.16.0. Results are local frame encode/decode microbenchmarks, not a Cloudflare throughput claim.
- Original `worker.js` SHA-256 remains `eab160c0ad75fad9e5c275cf39cd1b6d3b5a7a2241d9b3626de08df02ef8948f`.
- `npm install` timed out while contacting the npm registry. Wrangler is therefore unavailable locally; `npm run build` and both workerd TCP carrier tests could not execute.
- `npm audit` could not run because there is no `package-lock.json`. The operator must install dependencies, generate/commit the lockfile, and run the audit.
- The compatibility-date check did not pass because the original deployed Worker's exact date was not supplied to this environment. The operator must retrieve it from Cloudflare and set `PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE`.
- No Cloudflare deployment, staging load test, or real Telegram Desktop acceptance was performed.

See `OPERATOR-VERIFICATION-CHECKLIST.md` for the remaining operator actions.

## v5 engineering pass: core bounds, endpoint intelligence, benchmarks, and ME research

### Implemented

- Added runtime-configurable DC connection timeout (`dcConnectTimeoutMs`, 500–15,000 ms; default 3,000 ms) and maximum sequential DC connection attempts (`maxDcConnectAttempts`, 1–8; default 4).
- Expanded endpoint health observations with attempt/success counts, cumulative failures, EWMA latency variance, consecutive failures, cooldown, and observation age. Legacy health records remain readable.
- Updated adaptive endpoint scoring to account for latency, jitter, long-run failure ratio, recent failures, cooldown, and decaying staleness penalties.
- Added a selective queue-buffer compaction rule: tiny frame views backed by buffers at least 256 KiB and more than four times larger than the view are copied into a compact buffer; normal payloads remain zero-copy views.
- Added an optional outbound WebSocket `bufferedAmount` guard when the runtime exposes a numeric value. Cloudflare's Worker WebSocket API reference does not document this property, so it is opportunistic and not treated as the primary queue bound.
- Expanded the local benchmark to cover 64 B, 1 KiB, 16 KiB, 64 KiB, and 256 KiB frame payloads, repeated-round p50/p95 timing, heap delta, and 32-endpoint DC ranking.
- Added `NATIVE-ME-RESEARCH.md` documenting the public MTProxy front-to-Middle-End RPC constants, structures, protocol requirements, and a safe integration plan. No ME RPC client was implemented.

### v5 local verification

- `npm run test:all`: passed.
- Main Node test suite: 124 tests, 124 passed, 0 failed.
- Protocol differential suite: 4 passed.
- TCP loopback integration: 1 passed.
- Focused control-plane suite: 14 passed.
- Focused DC-health suite: 10 passed.
- `npm run typecheck`: passed using the globally available TypeScript compiler.
- `npm run bench:core`: executed successfully on Node.js 22.16.0. Results are local microbenchmarks only and are not Cloudflare throughput measurements.
- Original `worker.js` remains byte-identical with SHA-256 `eab160c0ad75fad9e5c275cf39cd1b6d3b5a7a2241d9b3626de08df02ef8948f`.

### Not verified in this environment

- Wrangler dry-run build and both workerd TCP carrier harnesses were not run because Wrangler is not installed in this environment; npm dependencies were not installed here.
- `npm audit` was not run because the archive has no `package-lock.json`.
- No Cloudflare staging/production deployment, real Telegram Desktop acceptance, multi-region measurement, or production load test was performed.
- No Telegram Middle-End RPC endpoint was available for protocol interoperability testing. The ME document is source-based research and architecture guidance, not an implementation.
