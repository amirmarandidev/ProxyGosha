# Scaling plan and proxy-core optimization notes

## Current Durable Object topology

The current design already shards per-client session leases and rate limits by a
hashed client key. The remaining shared hot spots are the global control-plane
object used for settings, aggregate metrics, endpoint health, audit history, and
alert throttling. Session setup reads cached settings and shared DC health; each
connection attempt reports endpoint health asynchronously; session open/close
updates aggregate counters.

## Recommended Part 5: partition the control plane

Do not split everything in one migration. Keep the existing `ProxyGoshaControlPlane`
class and namespace as the compatibility/control-plane v1 while introducing new
classes in stages:

1. **Metrics shards (first).** Add 32 or 64 deterministic shards selected from a
   hash of the metric key. Increment session, byte, stream, and DC-attempt counters
   locally within each shard. Keep only bounded hourly buckets per shard. The
   status page should aggregate snapshots from shards; treat the result as
   eventually consistent. Avoid a cross-shard transaction.
2. **DC-health shards (second).** Route each normalized `hostname:port` endpoint to
   one of 16 or 32 shards using a stable hash. Store EWMA, consecutive failures,
   cooldown, and timestamps in that shard. A request for all health records fans
   out to the shard set, with a strict timeout and partial-result indicator. Do not
   query every shard on each WebSocket request; refresh a short-lived isolate cache
   and use the cached snapshot for selection.
3. **Subscription shards (third).** Partition subscription records by the first
   bytes of the SHA-256 token digest. Verify a token against exactly one shard.
   Keep only the digest and policy metadata; never store the plaintext token.
4. **Keep settings centralized initially.** Settings writes are low-frequency and
   benefit from one authoritative version. Cache them per isolate. If settings
   traffic becomes material, split read-heavy immutable snapshots from the small
   authoritative admin-write object, with an explicit version number.
5. **Keep per-client session leases and rate limits sharded.** They already use
   deterministic hashed-key namespaces. Avoid moving those records during the
   first partitioning rollout.

### Migration sequence

- Measure Durable Object request rate, p50/p95/p99 latency, CPU, storage reads and
  writes, alarm duration, and 429/5xx rates before changing topology.
- Add new class exports and a new SQLite-class migration in a separate release;
  do not rename or replace the existing class in place.
- Dual-write one data family at a time, compare old and new aggregates, and expose
  a consistency/drift metric. Keep reads on the old object until parity is proven.
- Switch reads behind a runtime flag, then stop old writes only after a rollback
  window. Retain the old data for a defined period before cleanup.
- Load-test shard counts (16/32/64) rather than assuming more shards are always
  better. Every fan-out query adds latency and DO request volume.

The main trade-off is consistency versus throughput: a globally exact counter or
atomic quota spanning multiple shards requires a coordination point. Keep quota
accounting keyed to one client/subscription shard so that the existing transactional
per-identity enforcement remains atomic. Global dashboards can be approximate.

## Implemented proxy-core optimizations in this revision

- Frame decoding now returns `Uint8Array.subarray()` views into the WebSocket
  message instead of allocating a fresh payload buffer for every frame.
- `TcpStream.feed()` retains the immutable frame view rather than copying it again
  into the per-stream queue. This removes a second payload copy on the inbound
  WebSocket-to-TCP path.
- Frame encoding writes the four payload-length bytes directly, avoiding a new
  `DataView` allocation for every frame.
- Adaptive DC ordering now weighs connect EWMA, latency variance, active cooldown,
  consecutive failures, long-run failure ratio, and observation age. Failure,
  variance, and staleness penalties decay so endpoints can recover without a deploy.
- DC connect timeout and maximum sequential attempt count are configurable through
  the authenticated runtime settings API (`dcConnectTimeoutMs`, 500–15,000 ms;
  `maxDcConnectAttempts`, 1–8). Defaults remain 3,000 ms and four attempts.
- Tiny payload views backed by disproportionately large WebSocket messages are
  copied into compact buffers before queueing. Normal payloads retain zero-copy
  views. This avoids pinning a multi-megabyte message buffer for a tiny queued tail.
- If the WebSocket runtime exposes a numeric `bufferedAmount`, outbound frames are
  rejected when the reported buffered bytes plus the new frame would exceed
  `maxQueued`. Cloudflare's Worker WebSocket reference does not currently document
  `bufferedAmount`; this guard is therefore opportunistic, not the primary memory
  bound or a claim of runtime-level drain backpressure.
- Existing bounded queue limits, bounded connect attempts, and flow-control credit
  remain in place. Connection attempts are intentionally sequential: parallel
  racing would increase outbound TCP sockets and load without evidence that it
  improves the target network path.

These are allocation/decision-path optimizations, not a measured throughput claim.
No throughput benchmark has been run against Cloudflare production or a live
Telegram client. Normal zero-copy frame views retain their backing WebSocket message buffer until
queued stream work releases them. The stream queue now compacts only small views
whose backing buffer is at least 256 KiB and more than four times larger than the
view. The aggregate queue limit remains authoritative.

## Compatibility constraints

- The v1.2.2 frame format, Obfuscated2 parsing, token wire representation, and
  `worker.js` rollback baseline remain unchanged.
- Subscription-scoped session tokens use a derived HMAC key but retain the same
  token representation and WebSocket protocol framing. Custom clients must attach
  the same subscription header to both the session request and WebSocket upgrade.
- IPv6 DC targets are passed to Cloudflare TCP sockets as unbracketed literals.
  TCP reachability checks are not Telegram application-health checks.

## Roadmap completion pass (v4)

The control plane now uses the existing `ProxyGoshaControlPlane` Durable Object class with deterministic named-instance sharding:

- Session leases and quota accounting remain distributed across 256 client-key shards.
- Rate-limit counters remain distributed across 256 client-key shards.
- Operational metrics are written across 16 metric shards and aggregated for the admin/status view.
- DC health reports are partitioned by endpoint across those 16 metric shards. Worker isolates cache the aggregate for five seconds to avoid 16 Durable Object reads on every new WebSocket session.
- New subscriptions are stored across 16 token-hash shards. Listing aggregates all shards; deletion searches all shards. Verification checks the new shard and the legacy global object so existing v3 subscriptions remain valid.
- Settings and redacted configuration audit remain in the single global object because writes are infrequent and need one authoritative value.

This is a compatible logical-shard migration: no new Durable Object class or Wrangler migration tag is required. Existing records in `proxy-gosha-global` remain readable. The new layout still needs a Cloudflare staging load test before production rollout.

### Session lease lifecycle

Session leases now expire after 90 seconds and are renewed by the WebSocket heartbeat. Expired leases cannot be revived by a late renewal. Every carrier lane renews its own lease. Subscription expiry/revocation is rechecked on each heartbeat; a failed renewal or failed subscription revalidation closes that WebSocket. The effective revocation window is normally up to one heartbeat interval (25 seconds), subject to runtime scheduling and control-plane availability.

### Core hardening

- Removed the deterministic fallback for generating the outbound Obfuscated2 DC header prefix. If secure random generation repeatedly produces an unsafe prefix, the stream is rejected rather than using predictable bytes.
- Added `npm run bench:core` for repeatable Node microbenchmarks of frame encode/decode. These are CPU microbenchmarks, not Cloudflare throughput measurements.

### Verification commands

```sh
npm run test:all
npm run typecheck
npm run build
npm run test:workerd-tcp:all
npm run bench:core
npm audit --audit-level=high
```

The Cloudflare build, workerd tests, audit and staging load test must be run with dependencies installed and the target account/environment available.


## Runtime DC connection controls and health scoring (v5)

The authenticated settings API adds `dcConnectTimeoutMs` (500–15,000 ms; default
3,000) and `maxDcConnectAttempts` (1–8; default 4). They bound the TCP `opened`
wait and sequential endpoint attempts. The worker continues to report each actual
connection outcome to its endpoint's health shard.

Endpoint observations now retain attempts, successes, cumulative failures, EWMA
latency, EWMA latency variance, consecutive failures, cooldown and timestamps.
Legacy records without the new counters remain readable. Ranking uses latency,
jitter, consecutive failures and historical failure ratio, with time-decaying
penalties. This is a heuristic ranking function, not a prediction of end-to-end
Telegram success.

`npm run bench:core` now measures frame encode, decode and combined operations for
64 B, 1 KiB, 16 KiB, 64 KiB and 256 KiB payloads, plus 32-endpoint DC ranking. It
prints repeated-round throughput, p50/p95 per-operation latency and a process heap
delta. Node microbenchmarks are comparative local measurements only; they do not
represent Workers isolate throughput or network performance.
