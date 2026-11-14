# Source Function Inventory

This inventory groups the supplied `worker.js` implementation by responsibility.
Line numbers refer to the original archive and will change as the file is edited.

## Worker telemetry and configuration

- `logEvent` — bounded per-isolate event log.
- `resolveConfig` — reads environment bindings and applies defaults.
- `getRuntime` — caches resolved cryptographic runtime configuration.
- `buildRuntime` — derives secrets and imports Web Crypto keys.
- `requestHost`, `hostAllowed` — request hostname handling.
- `deriveSecret`, `bridgeMode`, `safeEqual` — bridge capability and comparison logic.

## Embedded bridge client

The functions below are inside the `BRIDGE_HTML` template and execute in the
user's browser, not in the Worker isolate:

- `trackFrames`, `startHeartbeat`, `stopHeartbeat`
- `reserve`, `release`, `splitFrames`, `frameBound`, `joinPending`
- `retryAfterMs`, `request`, `fail`, `createSession`
- `queueCarrier`, `queueUp`, `runUp`, `poll`
- `ensureLane`, `rememberLaneClosed`, `queueLane`, `runLaneUp`, `pollLane`
- `openWebSocket`, `scheduleReconnect`, `queueWebSocket`, `runWebSocketUp`
- `closeFrame`, `finishWebSocketLane`, `openWebSocketLane`
- `queueWebSocketLane`, `runWebSocketLaneUp`, `close`, `activatePort`

Keep browser-side and Worker-side TypeScript compilation concerns separate.

## Cryptography and encoding

- `concat`, `reverse`
- `hexToBytes`, `bytesToHex`
- `b64uEncode`, `b64uDecodeStrict`
- `unseal`, `sha256`, `importHmac`, `importAes`
- `add128`, `ctrAt`
- `parseSecret`, `parseAdTag`
- `issueToken`, `verifyToken`

## Admin, setup, diagnostics, and decoy

Migrated to `src/routes/auxiliary-routes.ts`: `generatorLabel`, `serveSecret`,
`panelRoute`, page rendering helpers, `servePanel`, `serveSetup`, `fmtBytes`,
`fmtDuration`, `probeDcs`, `serveStatus`, `decoy`, and `notFound`.

The original embedded LUXVEIL storefront and browser bridge client are retained
in `src/ui/templates.ts`. `handleAuxiliaryRoute` dispatches the setup, admin,
secret-generator, static camouflage, browser bridge, and decoy routes.

## Bridge and protocol

- `serveBridge`
- `frame`, `windowFrame`, `tagKind`, `safeDcHeaderPrefix`

## Networking and request handlers

- `Stream` — one logical MTProto stream and its TCP socket.
- `WsSession` — one WebSocket session, its stream map, framing, and lifecycle.
- `serveSession` — bootstrap/session endpoint.
- `serveWebSocket` — authenticated WebSocket endpoint.
- Default export `fetch` — top-level HTTP routing and error fallback.

## Constants

- `ME_CONSTANTS`
- `HTTPS_PORTS`
- `VERSION`
- `CONFIG`
- `TOKEN_DOMAIN`, `BUILD_SEAL`
- `TOKEN_KIND_BOOTSTRAP`, `TOKEN_KIND_SESSION`
- `PORT_MODE_BASE`, `REQUEST_LIMIT`
- `WELCOME`, `EMPTY`, telemetry constants, and UI/template constants

## Added TypeScript operational modules

- `src/dc-health.ts` — isolate-local EWMA endpoint latency, exponential failure
  cooldown, and adaptive endpoint ordering.
- `src/observability/control-plane.ts` — Durable Object global counters, 24-hour
  hourly history, bounded event ring, sharded fixed-window rate-limit storage,
  and authenticated operational settings updates.
- `src/observability/client.ts` — Worker-side Durable Object client, hashed-IP
  rate-limit keys, short-lived settings cache, and isolate-local fallback.
- `src/stream/tcp-stream.ts` — configurable inactivity timeout for abandoned
  TCP streams.
- `.github/workflows/ci.yml` and `deploy.yml` — CI and manually dispatched
  staging/production deployments.
