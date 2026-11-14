# Protocol primitives migration

This milestone adds pure TypeScript protocol helpers while leaving `worker.js`
as the production entry point. The new helpers are not yet called by
`WsSession` or `Stream`.

## WebSocket frame format

A message is a concatenation of frames. Each frame has an 8-byte header:

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 1 byte | Frame type |
| 1–3 | 3 bytes | Stream ID, unsigned big-endian |
| 4–7 | 4 bytes | Payload length, unsigned big-endian |
| 8 onward | Variable | Payload |

Frame types retained from the baseline:

| Value | Name |
| ---: | --- |
| `0x01` | OPEN |
| `0x02` | DATA |
| `0x03` | CLOSE |
| `0x04` | WINDOW |
| `0x05` | PING |
| `0x06` | PONG |

`src/protocol/frame.ts` provides `encodeFrame`, `encodeWindowFrame`, and
`decodeFrameBatch`. The decoder enforces the baseline's 16 MiB message limit,
1 MiB per-frame payload limit, and 4096 frames per message. It deliberately
retains unknown frame type bytes as numeric values; the session state machine
is responsible for rejecting unknown types, matching the original handling
boundary.

The encoder rejects values that do not fit the wire fields. The baseline
encoder simply wrote low-order bytes for the stream ID, so the TypeScript
encoder's validation is an intentional defensive boundary for internal calls;
valid baseline frame values encode identically.

## Obfuscated2 helpers

`src/protocol/obfuscated2.ts` provides pure helpers for:

- Identifying abridged (`ef ef ef ef`), intermediate (`ee ee ee ee`), and
  padded-intermediate (`dd dd dd dd`) transport tags.
- Parsing the 8-byte decrypted tail and reading the signed DC ID as
  little-endian, with `Math.abs(dcId)` as the DC lookup key.
- Applying the baseline's outbound DC header-prefix exclusions (HTTP methods,
  TLS record prefix, MTProto transport tags, and the other rejected patterns).

This is not the complete Obfuscated2 handshake migration. Header key derivation,
AES-CTR decryption of the client header, outbound header construction, and TCP
connection setup remain in `Stream.init()` in `worker.js`.

## Validation

The protocol tests cover known wire-format vectors, concatenated frames,
subarray offsets, malformed batches, unknown frame types, signed DC IDs, and
header-prefix exclusions. These are deterministic unit tests, not end-to-end
Telegram compatibility tests. No production behavior changes in this
milestone.
