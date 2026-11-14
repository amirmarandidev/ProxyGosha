# HTTP Route Migration

## Scope

This milestone ports the two authenticated transport endpoints from `worker.js`
into `src/routes/proxy-routes.ts`:

- `POST /api/v1/session` — verifies the bootstrap bearer token, validates the
  fixed 9-byte handshake, and issues a session token.
- `DELETE /api/v1/session` — verifies a session token and returns 204.
- `GET /api/v1/ws` — validates the WebSocket upgrade and exactly one offered
  subprotocol, verifies the session token, applies generated-secret acceptance
  policy, selects the correct base/port/generated secret, and attaches the
  WebSocket/TCP transport.

## Platform boundary

Cloudflare-specific `WebSocketPair` construction and the status-101 response are
injected through `ProxyRouteDependencies`. This keeps route authentication and
protocol decisions testable under Node without pretending Node's standard
`Response` implementation supports Cloudflare's WebSocket response extension.
The next Worker-entrypoint milestone supplies those platform operations.

## Compatibility details retained

- Token kinds remain bootstrap `1` and session `2`.
- Bearer-token prefix, cookie rejection, content-type matching, declared-body
  limit, and exact 9-byte handshake validation match the baseline route.
- The session welcome payload and response headers are retained.
- WebSocket requests reject authorization headers and require exactly one
  offered subprotocol.
- Both `tproxy-v1.<token>` and `tproxy-lane-v1.<token>.<lane>` are supported.
- Lane IDs must be decimal, non-zero, and fit in 24 bits.
- Port mode selection uses the original HTTPS port ordering.
- Generated-secret modes remain gated by `ACCEPT_GENERATED`.
- Invalid/expired WebSocket tokens increment `wsRejects` and log a generic
  message without recording the token.

## Validation

`tests/unit/proxy-routes.test.mjs` covers bootstrap/session token handling,
handshake validation, DELETE behavior, generated-token policy, WebSocket
protocol validation, lane handling, per-port secret selection, and generated
secret derivation. WebSocket pair creation and the Cloudflare upgrade response
are fakes; actual Workers runtime integration remains a separate milestone.
