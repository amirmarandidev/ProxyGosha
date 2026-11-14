# Cloudflare runtime validation

## Local preflight

Run these checks from the repository root:

```sh
npm install
npm run check
npm run smoke:worker
```

`smoke:worker` launches the locally installed `wrangler/bin/wrangler.js` through the
current Node executable, requests `/`, and verifies that the unconfigured TypeScript
Worker returns its bilingual setup page. Calling the JavaScript CLI directly avoids
Windows `npm.cmd` spawn-shim errors. Set `PROXY_GOSHA_SMOKE_PORT` to use a different
local port.

This smoke test exercises the actual TypeScript entry point through Wrangler and
workerd when those dependencies are installed. It is not a Telegram interoperability
test and does not exercise authenticated proxy traffic or a live Cloudflare deploy.

## Current execution result

The user previously confirmed on Windows that dependency installation, type checking,
smoke tests, authenticated E2E tests, Node TCP loopback, protocol differential tests,
workerd TCP integration, and compatibility-date comparison passed. This feature update
adds control-plane and adaptive-DC unit tests, plus a separate workerd TCP harness for
`websocket-lanes`.

In the current authoring environment, `node --experimental-strip-types --test`
passes 77/77 tests and `tsc --noEmit` passes with TypeScript 5.8.3. Wrangler was not
installed here: the npm registry request timed out, so the updated workerd harnesses
and Wrangler dry-run build were not executed in this environment. Run them locally or
through the added GitHub Actions workflow before deploying this update.

## Before staging/production deployment

1. Install dependencies with registry access; commit the generated `package-lock.json`.
2. Run `npm run test:all`.
3. Run `npm run test:workerd-tcp:all` to test both carrier modes through workerd.
4. Run `npm run build` to validate Wrangler bundling and the Durable Object migration.
5. Deploy to a separate staging Worker, then perform the independent Telegram Desktop
   acceptance test described in `DEPLOYMENT-AND-CLIENT-VALIDATION.md`.

## Authenticated end-to-end validation

After the basic `smoke:worker` test passes, run:

```sh
npm run test:e2e
```

This starts two isolated local Wrangler/workerd instances, one for each carrier mode.
It uses test-only credentials passed as local `--var` values; it does not use or
print production secrets. The harness obtains a bridge bootstrap token using a
host-bound HMAC capability, completes the 9-byte session handshake, verifies
session-token deletion, checks health/admin routes, and establishes an authenticated
WebSocket. In `websocket` mode it verifies a PING/PONG frame round trip. In
`websocket-lanes` mode it opens and closes lane 1 without sending TCP payload, so
no Telegram DC connection is attempted.

The test requires Node's global WebSocket client and a local Wrangler installation.
It validates the Cloudflare-compatible WebSocket runtime and authenticated route
lifecycle, but does not prove Telegram interoperability, successful TCP connections
to Telegram DCs, or production deployment behavior.

Set `PROXY_GOSHA_E2E_PORT` to reserve a chosen base port. The second carrier uses
base port + 1. If unset, the harness reserves two ephemeral localhost ports.


## TCP loopback integration validation

Run:

```sh
npm run test:tcp-integration
```

This test uses a real Node TCP loopback endpoint and injects its socket adapter into
the TypeScript `TcpStream`. It validates the outbound obfuscation header and transformed
payload, downstream DATA frame forwarding, receive-window credit, and stream cleanup.
It does not run in workerd or contact Telegram DCs. See
[`TCP-INTEGRATION-VALIDATION.md`](./TCP-INTEGRATION-VALIDATION.md).


## Final integration checks

Run the baseline differential protocol test:

```sh
npm run test:protocol-diff
```

Run the controlled TCP round-trip through Wrangler/workerd:

```sh
npm run test:workerd-tcp:all
```

Both tests require local Wrangler dependencies and use an explicitly enabled
loopback-only `E2E_TEST_MODE` binding. The first exercises the `websocket` carrier;
the second exercises the default `websocket-lanes` carrier. See
[`INTEROPERABILITY-VALIDATION.md`](./INTEROPERABILITY-VALIDATION.md).

Verify the original deployed compatibility date using
[`COMPATIBILITY-DATE.md`](./COMPATIBILITY-DATE.md):

```sh
# PowerShell
$env:PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE = "YYYY-MM-DD"
npm run check:compatibility-date
```

The original archive did not contain deployment metadata, so this check cannot pass
until the operator supplies the authoritative date.
