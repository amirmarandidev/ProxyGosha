# WebSocket Session Migration

## Scope

This milestone ports the WebSocket session protocol state machine into
`src/session/ws-session.ts`. It is intentionally independent of Cloudflare's
`WebSocketPair`, TCP socket implementation, and the not-yet-migrated `Stream`
class. The caller supplies a `SessionStream` factory, allowing the state machine
to be tested with deterministic stream doubles before the TCP implementation is
ported.

## Preserved baseline behavior

- Binary `ArrayBuffer` WebSocket messages only.
- Concatenated frame parsing through the shared 8-byte frame decoder.
- OPEN/DATA/CLOSE/WINDOW dispatch and the existing validation rules.
- Rejection of malformed messages, unknown frame types, and cross-lane IDs.
- Stream-count admission control, duplicate-ID rejection, and CLOSE responses
  for unknown non-tombstoned streams.
- PING/PONG behavior, including the 64-byte inbound PING limit and 90-second
  pong watchdog.
- Single-stream lane behavior and close-on-lane-completion semantics.
- Bounded 4096-entry tombstone history.
- Idempotent disposal, active-session accounting, stream teardown, and
  WebSocket shutdown behavior.

The class accepts injectable clock, interval, logging, statistics, and stream
factory dependencies. Production Cloudflare bindings are not imported by this
module.

## Integration boundary

`serveWebSocket()` in `worker.js` still constructs the original JavaScript
`WsSession`. This TypeScript class is not active in production yet. The next
networking milestone must port the TCP `Stream` lifecycle and then connect its
factory to this class. The old Worker remains unchanged as the behavioral
reference.

## Validation

The unit tests exercise frame dispatch, stream admission, malformed input,
heartbeat payloads and timestamps, lane isolation, tombstones, and teardown.
They use fake streams and a fake WebSocket; they do not establish Cloudflare
Workers runtime compatibility or live Telegram DC connectivity.
