# Protocol and transport interoperability validation

## Baseline differential protocol test

Run:

```sh
npm run test:protocol-diff
```

The test extracts the original `frame`, `windowFrame`, `tagKind`, and
`safeDcHeaderPrefix` functions directly from the preserved `worker.js` and executes
them as a JavaScript oracle. It compares their output with the TypeScript frame and
Obfuscated2 helpers, including frame header bytes, stream IDs, payload lengths,
WINDOW credit, transport tags, signed little-endian DC IDs, and DC-header exclusions.

This is a source-to-source differential test for those helpers. It is not a test
against a Telegram client or a live Telegram data center, and it does not establish
full MTProto/Obfuscated2 interoperability.

## Workerd TCP round-trip test

Run:

```sh
npm run test:workerd-tcp
```

The script starts a local TCP endpoint and Wrangler's local workerd runtime. It
issues an authenticated session, upgrades a WebSocket, opens stream 1, sends a
valid encrypted Obfuscated2 client header plus a small payload, and checks that
`cloudflare:sockets` connects to the local endpoint. The endpoint checks that it
receives a 64-byte outbound obfuscation header followed by transformed upload bytes,
then returns a fixed response which must arrive as a downstream DATA frame.

The test-only `E2E_TEST_MODE`, `E2E_DC_HOST`, and `E2E_DC_PORT` bindings are accepted
only when `E2E_TEST_MODE=true`, and the host is restricted to `127.0.0.1` or
`localhost`. Do not configure these bindings in a deployed Worker. The test uses
`websocket` carrier mode because it exercises a single full TCP stream lifecycle.

This is a local workerd socket integration test; it does not contact Telegram DCs
or prove compatibility with an independently implemented Telegram client.

## Independent-client validation still required

For an external interoperability check, run the original JavaScript Worker and the
TypeScript Worker against the same independently controlled MTProto/Obfuscated2
client and compare successful handshake, upload, download, reconnect, and close
behavior. The source archive does not contain a compatible client or test vectors
from one, so this cannot be honestly marked complete from the repository alone.
