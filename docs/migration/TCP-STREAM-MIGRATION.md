# TCP Stream Migration

## Scope

This milestone ports the baseline `Stream` lifecycle into `src/stream/tcp-stream.ts`.
It is deliberately not wired into the production route yet: `worker.js` remains
unchanged until the TypeScript entry point and route integration are ready.

## Ported behavior

- Buffer the first 64 bytes of each logical stream before initialization.
- Derive the client-to-proxy AES-CTR key from `header[8..40] || session.secret`.
- Decrypt the Obfuscated2 tail at byte offset 56 and parse the transport tag and
  signed little-endian DC ID.
- Derive the fast-mode DC encryption key/IV from the reversed client header key
  material, preserving the original direct-DC download fast path.
- Resolve the configured DC address list and try at most four address/port pairs.
  IP order is randomized; port order and the port-outer/IP-inner attempt ordering
  match the baseline.
- Apply a 3-second connection-open timeout and close failed candidate sockets.
- Construct and encrypt the outbound 64-byte DC Obfuscated2 header.
- Decrypt client upload chunks, re-encrypt them for the DC, and grant upload
  window credit after the write completes.
- Forward DC download bytes without re-encryption, bounded by send credit and
  `dataChunk` size.
- Enforce per-stream outstanding receive bytes and aggregate queued-byte limits.
- Release writer/reader locks, cancel the reader, close the TCP socket, clear
  queued bytes, resolve blocked credit waits, and tombstone the stream on teardown.

## Runtime boundary

`TcpStreamOptions.connect` is the adapter point for `cloudflare:sockets`.
The module also injects randomness, timers, stats, and logging so unit tests can
run without a Cloudflare runtime. `createTcpStreamFactory()` adapts the class to
`WsSessionOptions.createStream`.

The module is not yet instantiated by `worker.js`; production still uses the
original JavaScript `Stream` class. No live Telegram DC connection or workerd
runtime test was performed.

## Validation

The tests build a valid encrypted Obfuscated2 client header, exercise successful
initialization and data forwarding against mocked TCP streams, reject invalid
transport tags, verify the four-attempt failover bound, and test queue limits.
These tests validate deterministic local behavior, not Telegram interoperability.
