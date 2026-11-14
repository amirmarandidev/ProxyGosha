# Retained functionality and operational enhancements

## Original JavaScript functionality retained in the TypeScript implementation

The migration keeps the original 1.2.2 user-facing features and route behavior:

- Telegram WEB proxy bridge page and browser-side bridge client.
- Both `websocket` and `websocket-lanes` carriers.
- Authenticated bootstrap/session handshake and WebSocket authentication.
- Obfuscated2 header parsing, AES-CTR transformations, HMAC token handling,
  Direct-DC TCP connections, DC failover, multiplexed streams and flow control.
- Setup page with bilingual English/Persian content.
- Admin panel with Telegram `tg://webproxy` links and per-port secrets.
- Manual proxy configuration details.
- Optional secret generator, gated by `GENERATOR_ENABLED` and `ADMIN_KEY`.
- Status page, recent isolate event log, and on-demand Telegram DC reachability probe.
- Health/status endpoints, robots.txt, favicon, and the LUXVEIL decoy storefront.
- Host allow-listing, extra hostnames, custom session/WebSocket paths, generated
  secret acceptance, optional AD_TAG configuration and decoy URL forwarding.

The original `worker.js` remains in the repository as the unchanged JavaScript
baseline/rollback implementation. The TypeScript implementation is the selected
entry point in `wrangler.jsonc`.

## Added operational features

### Global control plane

`ProxyGoshaControlPlane` is a SQLite-backed Durable Object used for:

- Aggregate session, stream, traffic, DC attempt/failure and rejected-WebSocket
  counters across isolates.
- A bounded recent event list and 24-hour hourly metric buckets.
- Distributed fixed-window rate limiting keyed by a SHA-256 hash of
  `CF-Connecting-IP`; raw client IPs are not stored. It covers session creation,
  WebSocket authentication and the admin path.
- Persisted, bounded operational settings.

If the Durable Object binding is not present, the Worker falls back to isolate-local
rate limiting and counters. Those local values are not globally consistent.

### Adaptive DC selection

The Worker keeps an isolate-local endpoint registry seeded from shared Durable Object observations. Selection combines EWMA connect latency, latency variance, recent consecutive failures, long-run failure ratio, cooldown and observation age. Historical failure and jitter penalties decay as observations become stale. Failed endpoints enter an exponentially increasing cooldown; successful connections clear the consecutive-failure count and update latency. The registry reorders future connection attempts while retaining the configured DC address/port set. It does not discover new Telegram endpoints.

### Stream idle timeout

A configurable inactivity timeout closes abandoned TCP streams. Activity in either
direction refreshes the timer. The default is 120 seconds and can be changed through
the authenticated runtime settings API. An optional per-session WebSocket traffic
budget can also be configured; it is disabled by default.

### Runtime settings API

The API is available under the admin-key path:

- `GET /<ADMIN_KEY>/api/config`
- `PUT /<ADMIN_KEY>/api/config`

Supported fields:

```json
{
  "rateLimitPerMinute": 120,
  "adaptiveDcSelection": true,
  "dcHealthCooldownMs": 15000,
  "dcConnectTimeoutMs": 3000,
  "maxDcConnectAttempts": 4,
  "streamIdleTimeoutMs": 120000,
  "maxSessionBytes": 0
}
```

Bounds are enforced server-side. The API changes only operational settings; secrets, DC address lists, hostnames and
protocol parameters remain deployment configuration. The traffic budget counts
WebSocket frame bytes (including framing overhead) per session; `0` disables it.
The Durable Object verifies the configured `ADMIN_KEY` before accepting writes.

Example PowerShell update:

```powershell
$adminKey = "YOUR_ADMIN_KEY"
$uri = "https://YOUR_HOST/$adminKey/api/config"
$body = @{
  rateLimitPerMinute = 180
  adaptiveDcSelection = $true
  dcHealthCooldownMs = 20000
  streamIdleTimeoutMs = 180000
  maxSessionBytes = 0
} | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri $uri -ContentType "application/json" -Body $body
```

### CI and deployment workflow

- `.github/workflows/ci.yml` runs tests, protocol differential checks, both
  workerd TCP carrier tests and Wrangler dry-run builds.
- `.github/workflows/deploy.yml` is manually dispatched and supports staging or
  production. Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as
  GitHub Environment secrets. Configure required reviewers on the `production`
  environment if production deployment approval is desired.

## Validation commands

```powershell
npm run test:all
npm run test:workerd-tcp:all
npm run build
```

`test:workerd-tcp:all` requires Node.js 22.6+, installed dependencies, Wrangler,
and permission to bind local loopback TCP ports.

## Deliberate non-feature: automatic reconnect of an established TCP stream

The proxy does not replay or resume an already-established MTProto TCP stream after
an established socket fails. The stream is encrypted and stateful; replaying buffered
application bytes or restarting at an arbitrary CTR offset would risk corrupting the
protocol. The implementation retains bounded connection-time failover and improves
future endpoint selection using health feedback. Established-stream recovery needs
an explicit protocol-level resume/reconnect design and independent Telegram-client
validation before it is safe to enable.

### Global DC health, admission controls, quotas and alerts

The control-plane Durable Object now also stores per-endpoint health observations
from live TCP connection attempts and scheduled probes. The status page displays
endpoint attempts, consecutive failures, EWMA connection latency and cooldown state.
A five-minute Cron Trigger probes every configured DC IP against each configured
DC port from the Worker's Cloudflare location (bounded to eight concurrent probes); webhook alerts are throttled to one per endpoint per
15 minutes; normal connection attempts report the actual endpoint
selected by the proxy. The configured DC list remains authoritative.

Additional runtime settings:

| Setting | Meaning | Default |
|---|---|---:|
| `maxConcurrentSessionsPerIp` | Concurrent WebSocket sessions per hashed client IP; `0` disables the cap | `0` |
| `dailyBytesPerIp` | Daily traffic admission threshold per hashed IP; `0` disables it | `0` |
| `monthlyBytesPerIp` | Monthly traffic admission threshold per hashed IP; `0` disables it | `0` |
| `historyHours` | Retention window for hourly aggregates (24–720 hours) | `168` |
| `alertWebhookUrl` | HTTPS JSON webhook for repeated DC failures; omitted from reads/exports | empty |
| `alertDcFailureThreshold` | Consecutive failures before a webhook notification | `5` |

Client IPs are SHA-256 hashed before the control plane stores per-IP leases or
usage. When Cloudflare Access authenticates the Worker invocation and provides an
identity email through `ctx.access.getIdentity()`, the Worker instead hashes that
verified email for per-user session limits and traffic quotas. The raw email is not
sent to or stored by the Durable Object. If Access does not provide an email, the
Worker falls back to the hashed client IP. This is an authenticated user identity,
not a subscription plan or billing account identifier.

For WebSocket proxy traffic, use a hostname-based Cloudflare Access application:
Cloudflare's current documentation states that Worker-level Access policies do not
support WebSocket upgrade requests. Access identity is available only when Access
authenticated the direct Worker invocation; it is not propagated through Service
Bindings or RPC. Native Telegram clients still need to support the Access login/token
flow to benefit from per-user identity; otherwise they continue using per-IP limits.

Session leases expire after 24 hours if a Worker is terminated before its
close callback; the main WebSocket heartbeat and traffic updates renew active leases.
Daily/monthly usage is charged incrementally using cumulative per-session counters.
The Durable Object applies deltas transactionally and idempotently, rejects traffic
that would exceed the configured limit, and reconciles final counters at session
close. Outbound frames are checked before they are sent; inbound messages are
accounted before their frames are dispatched to TCP streams. When quotas are enabled,
a control-plane failure closes the affected session rather than silently bypassing
the quota. Accounting is based on WebSocket frame bytes, including framing overhead.
`maxSessionBytes` remains the per-session hard byte budget. Optional custom-client
subscription credentials add a separate identity and quota path, but stock Telegram
clients still do not provide a verified account identity in the v1.2.2 handshake.

### Runtime configuration backup and audit

- `GET /<ADMIN_KEY>/api/config/export` exports schema-versioned operational settings.
- `POST /<ADMIN_KEY>/api/config/import` imports a previously exported JSON document.
- `GET /<ADMIN_KEY>/api/config` and `PUT /<ADMIN_KEY>/api/config` remain available.
- The Durable Object retains the latest 200 config-change audit entries. Entries
  record action and changed key names only; values and secrets are not recorded.
- `alertWebhookUrl` is intentionally omitted from GET and export responses. Import
  does not overwrite the configured webhook URL.

Export/import covers operational Durable Object settings only. It does not include
`SECRET`, `ADMIN_KEY`, DC IPs, hostnames, or other deployment bindings.

### Core transport hardening

The WebSocket session now bounds the amount of inbound message data queued behind
its serialized frame processor, using the existing `maxQueued` memory budget. A
client that overwhelms processing is closed rather than allowing an unbounded
promise chain to accumulate. Frame encoding now enforces the same 1 MiB maximum
payload size that the decoder already enforced. Neither change alters the 8-byte
frame header or any valid frame encoding.

### External Telegram Middle-End gateway boundary

Native Telegram Middle-End (ME) support is **not implemented** by this Worker.
The ME transport and its authentication/handshake are a separate protocol-facing
egress component; inventing a gateway handshake or treating it as ordinary TCP
would be unsafe. The current Worker continues to use its existing Direct-DC TCP
path. A future ME gateway must provide a documented, authenticated, encrypted
upstream contract, per-DC routing semantics, timeout/failover behavior, health
reporting, and a staging endpoint that can be tested with Telegram Desktop before
it can be enabled here. No `ME_GATEWAY_URL` setting is exposed until that contract
exists.

### Operational limitations

- The optional custom-client subscription foundation adds opaque credential identity
  and per-subscription quotas, but it is not Telegram account identity or billing.
  Stock Telegram clients generally cannot attach the required custom header.
- Per-IP session/rate-limit state is sharded across 256 Durable Object names. Global
  metrics, DC health, settings, audit history and alert throttling still share the
  global control-plane object; high-volume deployments should load-test it and may
  need separately partitioned telemetry.
- Scheduled health probes test TCP reachability from Cloudflare, not Telegram
  application-layer correctness or end-to-end client connectivity.
- Each isolate seeds its synchronous adaptive selector from the shared endpoint
  registry when a new WebSocket session is admitted. In-flight sessions do not
  continuously refresh their selector, and new health observations are eventually
  visible to later sessions rather than synchronously coordinated per TCP attempt.
- Established TCP/MTProto stream replay or resumption is not implemented.


## Subscription identity foundation (optional)

An operator can create and list opaque subscription credentials through `POST /<ADMIN_KEY>/api/subscriptions` and `GET /<ADMIN_KEY>/api/subscriptions`; revoke with `DELETE /<ADMIN_KEY>/api/subscriptions?id=<subscription-id>`. Creation accepts JSON `{ "expiresAt": <unix-ms>, "limits": { "maxConcurrentSessionsPerIp": 2, "dailyBytesPerIp": 1073741824, "monthlyBytesPerIp": 10737418240 } }`. The response includes the bearer-like subscription token exactly once; only its SHA-256 digest is stored. Apply the `requireSubscription: true` runtime setting to require the `X-Proxy-Gosha-Subscription` header on both `/api/v1/session` and `/api/v1/ws`. The header must be supplied on both requests. Session-token HMAC keys are derived from the validated subscription credential, binding a session token to that subscription without changing the v1.2.2 wire framing. Per-subscription concurrency and traffic limits override global limits.

This is a custom-client subscription foundation, not native Telegram subscription billing or stock Telegram WEB-proxy client support. Telegram clients generally do not expose arbitrary headers for these requests, so enabling `requireSubscription` can make existing Telegram clients unable to connect. The v1.2.2 token/wire protocol is unchanged. Billing, automatic renewal, subscription-plan management, and a customer portal are not included. Revocation immediately blocks subsequent session creation and WebSocket upgrades; an already established WebSocket is not forcibly terminated.


## IPv6 endpoint configuration and diagnostics

The Worker now accepts per-DC endpoint overrides through `DC1`, `DC2`, `DC3`, `DC4`, `DC5`, and `DC203`. Each value is a comma-, semicolon-, or whitespace-separated list of IPv4, IPv6, or DNS endpoints. IPv6 may be supplied with or without square brackets. `DC_PORTS` accepts a separated list of TCP ports and replaces the default `[443, 80, 5222]`. The existing status-page `?probe=1` check attempts configured endpoints using the configured primary DC port. These are TCP connect checks only; they do not establish Telegram/MTProto application health.

## Adaptive endpoint scoring

Endpoint ordering now combines EWMA connect latency, current cooldown, consecutive failures, and observation age. Failure penalties and stale-observation penalties decay over time, allowing endpoints to recover rather than remaining permanently disadvantaged. Endpoints in cooldown remain strongly deprioritized. Unknown endpoints retain a conservative exploration score. This is a local adaptive selector seeded from shared Durable Object observations; it is not geography-aware and does not infer client ISP routing.
