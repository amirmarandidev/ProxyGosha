# Auxiliary routes migration

This milestone ports the auxiliary HTTP surfaces from the original `worker.js`
into `src/routes/auxiliary-routes.ts` and moves the embedded HTML/JavaScript
payloads into `src/ui/templates.ts`.

## Migrated surfaces

- Unconfigured root setup page and configured `/setup` page.
- Bilingual admin panel and authenticated `/<ADMIN_KEY>/status` page.
- Per-domain secret generator (`--create-secret`, `create-secret`, and
  `create_secret`) with the original `GENERATOR_ENABLED` and `ADMIN_KEY` gates.
- Browser bridge root route (`/?bridge=<capability>`), including capability
  verification, bootstrap token issuance, nonce substitution, CSP, and response
  security headers.
- `/robots.txt`, `/favicon.ico`, `/health`, and `/status` camouflage routes.
- Original LUXVEIL decoy storefront and optional `DECOY_URL` upstream fetch.
- On-demand Telegram DC TCP reachability probe, limited to batches of three
  concurrent connection attempts and a 2.5-second open timeout.

## Runtime dependencies

`handleAuxiliaryRoute()` receives the TCP connector, build identity, shared
transport counters, isolate start time, clock, and event logger through
`AuxiliaryDependencies`. This keeps Cloudflare-specific socket access injectable
for Node tests. The status page reads the same counters updated by session and
TCP stream code.

The browser bridge and decoy HTML were extracted from the original template
literals. The bridge is not re-authored or simplified in this milestone.

## Validation

- Worker integration tests cover setup, static camouflage routes, decoy HTML,
  admin panel/status, bridge capability, generator authorization, and DC probe.
- The DC probe test uses injected mock sockets; it does not establish real DC
  reachability from a Cloudflare location.
- Cloudflare workerd/Wrangler execution and Telegram client interoperability
  remain unverified.
