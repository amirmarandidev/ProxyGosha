# ProxyGosha v4 operator verification checklist

This repository can be unit-tested and type-checked without Cloudflare credentials. The following checks require the operator's package-registry access, Cloudflare account, production compatibility settings, or actual client.

## 1. Install and lock dependencies

Run from the repository root:

```sh
npm install --no-audit --no-fund
npm audit --audit-level=high
```

Commit the generated `package-lock.json`. Subsequent CI and reproducible builds should use `npm ci`. Do not deploy while dependency installation or the audit is incomplete.

## 2. Local checks

```sh
npm run test:all
npm run typecheck
npm run bench:core
npm run build
npm run test:workerd-tcp:all
```

The Node test suite checks protocol differential behavior, crypto, Worker routing, Durable Object policy, subscription sharding, lease expiry, both session carriers' state-machine behavior, and TCP loopback integration. The workerd tests exercise Cloudflare's `cloudflare:sockets` runtime and cannot be replaced by Node loopback tests.

## 3. Confirm the production compatibility date

Read the compatibility date from the currently deployed Worker settings. Then run:

```sh
PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE=YYYY-MM-DD npm run check:compatibility-date
```

Replace the placeholder with the exact date from the deployed baseline. Do not guess it or copy the repository's current date without verifying the old Worker.

## 4. Cloudflare staging deployment

1. Authenticate Wrangler against the intended Cloudflare account.
2. Confirm the `CONTROL_PLANE` Durable Object binding and SQLite-backed class export in `wrangler.jsonc` are accepted by Wrangler.
3. Confirm the staging Worker has the required secrets and variables (`SECRET`, `ADMIN_KEY`, hostnames, DC endpoints and ports).
4. Deploy staging with `npm run deploy:staging`.
5. Verify setup/admin/status routes and runtime settings.
6. Create a test subscription, authenticate a compatible client, verify its limits, revoke it, and confirm its WebSocket is closed at the next heartbeat.
7. Test both `websocket` and `websocket-lanes` carriers with the real client.
8. Verify IPv4, IPv6 (if enabled), and DNS endpoint connectivity from the Cloudflare Worker region(s).
9. Load-test concurrent sessions, quota accounting, Durable Object shard distribution, and control-plane outage behavior.

Do not set `requireSubscription=true` until the deployed client can send `X-Proxy-Gosha-Subscription` on both the session handshake and WebSocket upgrade. Stock Telegram clients should not be assumed to support this custom header.

## 5. Production rollout

Promote only after staging acceptance. Keep the original Worker deployment available for rollback. Confirm Cloudflare logs and Durable Object storage after rollout; the logical shard layout retains legacy reads from the original global object for subscriptions and metrics.

## 6. Tests that require the operator

- Confirm the original deployed Worker compatibility date.
- Install npm dependencies and commit the lockfile.
- Run Wrangler dry-run and both workerd TCP carrier tests.
- Run `npm audit` against the generated lockfile.
- Deploy to staging and validate real Cloudflare TCP connectivity.
- Test with Telegram Desktop / the actual custom client.
- Supply a compatible client implementation for subscription headers if subscription enforcement is required.
- Provide a real ME gateway contract and client integration if native Middle-End support is required.

The repository cannot safely invent a Telegram ME gateway protocol, implement transparent recovery of an established encrypted MTProto TCP stream without client cooperation, or complete payment-provider onboarding without the provider account and credentials.

## v5 follow-up checks

After extracting the v5 archive and installing the pinned dependencies, run:

```powershell
npm run test:all
npm run typecheck
npm run bench:core
npm run build
npm run test:workerd-tcp:all
npm audit --audit-level=high
```

The new runtime controls are available through the existing authenticated settings
API:

```json
{
  "dcConnectTimeoutMs": 3000,
  "maxDcConnectAttempts": 4
}
```

Use the defaults initially. Tune only after measuring connection establishment and
failure rates from your deployed Cloudflare locations. The local benchmark does not
measure Cloudflare network performance.
