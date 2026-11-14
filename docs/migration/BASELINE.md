# ProxyGosha Baseline Specification

Source reviewed: `worker.js` from the supplied `ProxyGosha-main` archive.

- Source version constant: `1.2.2`
- Source size: 120,987 bytes
- Source format: single-file ES module
- Runtime-specific import: `cloudflare:sockets` (`connect`)
- External npm runtime dependencies: none visible in the supplied source
- Default carrier: `websocket-lanes`
- Alternate carrier: `websocket`
- Default session route: `/api/v1/session`
- Default WebSocket route: `/api/v1/ws`

## Runtime configuration defaults

| Setting | Baseline default |
|---|---:|
| `hostnames` | `[*]` |
| `debug` | `false` |
| `generatorEnabled` | `false` |
| `generatorKey` | empty |
| `acceptGenerated` | `false` |
| `dcPort` | `443` |
| `dcPorts` | `443, 80, 5222` |
| `carrier` | `websocket-lanes` |
| `sessionPath` | `/api/v1/session` |
| `wsPath` | `/api/v1/ws` |
| `batchBytes` | `2,097,152` |
| `bootstrapTtl` | `3,600` seconds |
| `sessionTtl` | `86,400` seconds |
| `maxStreams` | `6` |
| `maxQueued` | `16,777,216` bytes |
| `streamWindow` | `4,194,304` bytes |
| `dataChunk` | `65,536` bytes |
| `REQUEST_LIMIT` | `16,777,216` bytes |

The default DC address map is defined in the `CONFIG.dc` object in `worker.js`.
It should be moved without modification during the mechanical migration.

## Environment bindings read by the source

| Binding | Source behavior |
|---|---|
| `ADMIN_KEY` | Admin panel credential; accepted only when at least 16 characters for runtime setup |
| `SECRET` | Optional fixed proxy secret; accepts 32 hex characters or `dd` + 32 hex characters |
| `AD_TAG` | Optional 32-hex-character ad tag |
| `HOSTNAME` | Comma-separated host allowlist; defaults to `*` |
| `EXTRA_HOSTS` | Additional hostnames separated by commas or whitespace |
| `DEBUG` | Enabled by `true` or `1` |
| `DECOY_URL` | Optional upstream decoy URL |
| `MAX_STREAMS` | Parsed integer clamped to 1–32; default 6 |
| `SESSION_PATH` | Optional custom session path; default `/api/v1/session` |
| `WS_PATH` | Optional custom WebSocket path; default `/api/v1/ws` |
| `CARRIER` | `websocket` or `websocket-lanes`; otherwise default `websocket-lanes` |
| `GENERATOR_ENABLED` | Enabled by `true` or `1` when explicitly set; otherwise false |
| `GENERATOR_KEY` | Optional generator derivation seed |
| `ACCEPT_GENERATED` | Enabled by `true` or `1` when explicitly set; otherwise false |

The README currently documents only a subset of these bindings. This table is
based on direct reads of `env.*` in `worker.js` and `resolveConfig()`.

## HTTP routing contract

Routing order matters and must be preserved:

1. Parse URL, request host, and port; resolve runtime configuration.
2. If unconfigured, serve setup only at `/`; other requests return the source's not-found response.
3. If configured without an admin key, `/setup` can show setup guidance.
4. On GET, evaluate the admin panel route and status route.
5. Evaluate the legacy secret-generator route, gated by configuration and admin key.
6. Serve `/robots.txt` and `/favicon.ico` camouflage responses.
7. Serve `/health` and `/status` camouflage JSON responses.
8. Apply host allowlist; disallowed hosts receive the decoy response.
9. On GET `/`, accept exactly one `bridge` query parameter and validate its capability.
10. Route configured or legacy session paths to `serveSession()`.
11. Route configured or legacy WebSocket paths to `serveWebSocket()`.
12. Send remaining requests to the decoy response.
13. The outer catch also returns the decoy response using `DECOY_URL`.

The implementation accepts both configured custom paths and the legacy defaults
`/api/v1/session` and `/api/v1/ws`.

## WebSocket frame contract

Frames use an 8-byte header:

- 1-byte type
- 3-byte big-endian stream identifier
- 4-byte big-endian payload length
- payload bytes

| Type | Name | Baseline handling |
|---:|---|---|
| `0x01` | OPEN | Requires nonzero stream ID and empty payload |
| `0x02` | DATA | Requires nonzero stream ID and nonempty payload |
| `0x03` | CLOSE | Requires nonzero stream ID and empty payload |
| `0x04` | WINDOW | Requires nonzero stream ID and exactly 4 payload bytes |
| `0x05` | PING | Session control uses ID zero; payload is limited to 64 bytes |
| `0x06` | PONG | Requires ID zero and updates the pong timestamp |

Additional source limits include a maximum 1 MiB individual frame payload, 4,096
frames per WebSocket message, and a 16 MiB maximum WebSocket message payload.

## Stream and session state

`Stream` initializes with `phase = "header"`, accumulates a 64-byte Obfuscated2
header, transitions through initialization, and uses `dead` as its terminal flag.
`WsSession` owns the WebSocket, stream map, queued-byte accounting, tombstones,
serialized message handling chain, heartbeat, and session shutdown.

The two carrier modes are materially different:

- `websocket`: one WebSocket session can multiplex multiple streams, bounded by
  `cfg.maxStreams`.
- `websocket-lanes`: the WebSocket is associated with a lane ID and accepts one
  stream on that connection; the lane path does not use the multiplexed session's
  `cfg.maxStreams` check.

## Important migration findings to retain

- `serveSession()` checks declared Content-Length against 4,096 bytes, then reads
  the body and requires exactly 9 bytes. It does not enforce an incremental read
  limit for a missing or misleading Content-Length.
- `DELETE` on the session endpoint verifies a session token and returns 204; the
  source does not maintain a revocation registry.
- The source's bridge HTML contains a separate browser-side JavaScript program.
  Functions around lines 392–815 belong to that embedded client program, not to
  the Worker module's top-level runtime.
- `Stream` and `WsSession` are the core Worker-side networking classes.
- The source has lightweight per-isolate telemetry and a bounded event log.
- Do not treat comments in the source as verified Cloudflare platform limits;
  check current Cloudflare documentation separately when changing runtime design.
