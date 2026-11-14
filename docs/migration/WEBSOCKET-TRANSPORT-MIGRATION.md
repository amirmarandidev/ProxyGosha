# WebSocket Transport Integration

## Scope

This milestone connects the previously isolated TypeScript `WsSession` and
`TcpStream` modules through `src/runtime/websocket-transport.ts`.

## Adapter behavior

`attachWebSocketTransport()`:

- accepts the Cloudflare server-side WebSocket and sets `binaryType` to
  `arraybuffer`;
- creates a TCP stream factory using the injected `connect()` implementation;
- creates a `WsSession` with shared session/stream statistics and logging;
- routes binary `message` events into the serialized session message queue;
- disposes the session on WebSocket `close` and `error` events;
- passes lane IDs and heartbeat/timer controls through to the session.

The adapter intentionally receives an already authenticated WebSocket, resolved
session config, and derived secret. Token validation, secret selection, HTTP
upgrade response construction, and the outer Worker router are not part of this
adapter and remain in `worker.js`.

## Validation

Tests use an EventTarget-like mock WebSocket and mocked `connect()` function.
They verify acceptance, binary mode, OPEN-to-TCP-stream creation, CLOSE teardown,
close/error disposal, lane-ID propagation, and that a TCP connection is not
attempted until the 64-byte client Obfuscated2 header has been received.

No real `cloudflare:sockets` binding, `WebSocketPair`, Cloudflare Workers runtime,
or Telegram DC was available for this test. This is an integration seam tested
with mocks, not a deployed Worker integration.
