# TCP loopback integration validation

Run this test after `npm install`:

```sh
npm run test:tcp-integration
```

The test creates a real TCP server bound to `127.0.0.1` and injects a Node TCP
socket adapter into the migrated `TcpStream`. It builds a valid 64-byte
Obfuscated2 client header for DC 2, sends the header and a payload through the
stream, and checks that the loopback endpoint receives the 64-byte outbound
header followed by transformed (encrypted) payload bytes. The endpoint then
sends a fixed response; the test checks that those exact bytes are emitted in a
stream DATA frame and that receive-window credit is granted. Finally, it checks
stream teardown and tombstone bookkeeping.

This test exercises the TypeScript TCP stream implementation against a real
local TCP socket. It does not run inside workerd, validate Cloudflare's
`cloudflare:sockets` implementation, exercise a Telegram DC, or prove Telegram
client interoperability. The E2E harness separately covers workerd session and
WebSocket lifecycle behavior; neither test alone proves end-to-end Telegram
proxy compatibility.
