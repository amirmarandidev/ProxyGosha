# Native Telegram Middle-End (ME) research

## Findings

The public Telegram MTProxy source contains an internal front/proxy-to-Middle-End
RPC path. In `mtproto/mtproto-common.h`, the source defines `RPC_PROXY_REQ`,
`RPC_PROXY_ANS`, `RPC_CLOSE_CONN`, `RPC_CLOSE_EXT`, and `RPC_SIMPLE_ACK`, plus
request/answer structures carrying an external connection ID, remote/local IPv6
addresses and ports, flags, and opaque data. The MTProxy executable logs a
connection as `Connected to RPC Middle-End` when that path is established.

This is more concrete than an unspecified “ME gateway”: the public MTProxy source
exposes protocol constants and data structures. It is not, however, a standalone
public protocol specification or a simple raw-TCP forwarding target. The associated
RPC transport has its own connection setup, nonce/DH and AES crypto handling,
packet sequencing, checksums, permission negotiation, and connection lifecycle.
The source must be treated as the normative reference for a compatible client.

## What this means for ProxyGosha

ProxyGosha currently terminates the client-side Obfuscated2 handshake and opens a
regular TCP connection to a configured Telegram DC endpoint. A native ME mode would
be a different egress implementation: it would need to establish an authenticated
RPC connection to a compatible Middle-End service and map each ProxyGosha stream
onto the RPC proxy request/answer/close lifecycle. It cannot be achieved by simply
changing the target hostname or TCP port.

The Cloudflare Worker TCP socket API can create outbound TCP sockets, but the
Worker would still need a correct implementation of the Middle-End RPC protocol
and access to a compatible ME endpoint. The RPC protocol is stateful and has
cryptographic setup; the existing v1.2.2 WebSocket frame protocol should remain
unchanged while this is explored behind a separate egress adapter.

## Recommended implementation plan

1. Pin a specific upstream MTProxy source revision and license review.
2. Extract the RPC handshake, permission negotiation, packet framing, encryption,
   sequencing, CRC behavior, and reconnect semantics into a protocol specification.
3. Build a standalone test harness against the official MTProxy implementation
   or a controlled compatible ME test server. Do not test against an undocumented
   production endpoint.
4. Implement the ME RPC client as an independent module with deterministic test
   vectors and fault-injection tests.
5. Add an `egressMode` deployment setting only after the module passes handshake,
   multi-stream, flow-control, close, timeout, and failure tests. Keep Direct-DC as
   the default and preserve the existing client wire protocol.
6. Validate with a staging ME service before considering production use.

## Important distinction: Telegram WEB proxy relay

The separate `telegramdesktop/tproxy-server` project documents a WEB-proxy relay
architecture where the Telegram app performs the normal MTProxy transform, a
WebView multiplexes logical streams, and the server forwards each stream to a stock
official MTProxy instance. Its shared-frame relay protocol is not the same thing
as the MTProxy front-to-Middle-End RPC protocol. It may inform future client/relay
interop work, but it does not provide the missing ME RPC client implementation.

## Sources

- Telegram's official MTProxy setup and architecture: https://core.telegram.org/proxy
- Official MTProxy RPC constants and structures: https://github.com/TelegramMessenger/MTProxy/blob/master/mtproto/mtproto-common.h
- Official MTProxy front/ME client implementation: https://github.com/TelegramMessenger/MTProxy/blob/master/mtproto/mtproto-proxy.c
- Official MTProxy TCP RPC server implementation: https://github.com/TelegramMessenger/MTProxy/blob/master/net/net-tcp-rpc-server.c
- Telegram Desktop WEB proxy relay proof of concept: https://github.com/telegramdesktop/tproxy-server
- Its shared relay protocol: https://github.com/telegramdesktop/tproxy-server/blob/master/PROTOCOL.md

## Status

Research and architecture notes only. No ME RPC client, endpoint configuration,
or egress-mode switch is implemented in this revision.
