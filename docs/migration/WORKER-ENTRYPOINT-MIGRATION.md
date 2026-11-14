# Worker entry point migration

## Selected entry point

`wrangler.jsonc` now selects `src/index.ts` as the TypeScript Worker entry point.
The Cloudflare adapter imports `connect` from `cloudflare:sockets`, constructs a
`WebSocketPair`, and returns the Worker WebSocket upgrade response with the
`Sec-WebSocket-Protocol` header.

The original `worker.js` remains unchanged as the behavioral baseline and rollback
implementation. `wrangler.baseline.jsonc` points to that file and uses a separate
Worker name for optional side-by-side validation.

## Migrated runtime

- Runtime configuration and environment bindings are resolved in TypeScript.
- The original build-seal value is retained for token-key derivation.
- Authenticated session and WebSocket routes are connected to the TCP stream and
  WebSocket transport implementations.
- Auxiliary setup/admin pages, browser bridge, secret generator, diagnostics,
  health/status routes, and decoy templates are routed through the migrated
  auxiliary route handler.
- Cloudflare-specific socket and WebSocket primitives are isolated in `src/index.ts`.

## Validation status

The user reports that the full local test sequence passed, including the Wrangler
workerd TCP test and compatibility-date comparison. Local checks in the authoring
environment also passed for the 69-test Node suite, TypeScript compilation with the
available TypeScript 5.8.3 compiler, and byte-identity of `worker.js` against the
original source archive.

The automated tests do not replace a real Telegram Desktop WEB-proxy test. The
independent-client procedure and staging deployment instructions are in
[`DEPLOYMENT-AND-CLIENT-VALIDATION.md`](DEPLOYMENT-AND-CLIENT-VALIDATION.md).

## Rollback

To select the original implementation again, change `main` in `wrangler.jsonc` to
`worker.js` and redeploy. Do not delete or modify the baseline file.
