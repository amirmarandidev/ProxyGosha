# Configuration and cryptography migration

This document records the TypeScript implementation added in the configuration
and cryptographic foundations milestone. `worker.js` remains the production
entry point; these modules are not wired into request handling yet.

## Modules

- `src/config/defaults.ts` — typed defaults copied from the source `CONFIG`.
- `src/config/resolve.ts` — environment binding parsing and normalization.
- `src/crypto/bytes.ts` — byte concatenation/reversal, hex, Base64URL, and secret parsers.
- `src/crypto/webcrypto.ts` — SHA-256, HMAC/AES-CTR key imports, token domain, and CTR random access.
- `src/crypto/token.ts` — existing 16-byte nonce + 32-byte HMAC token format.
- `src/crypto/derive.ts` — build-seal decoding, proxy/admin/generator key derivation, bridge keys, and per-port secrets.

## AES-CTR counter handling

The baseline uses WebCrypto AES-CTR with `length: 64`. The TypeScript
implementation treats the low 64 bits as the incrementing counter field, adds
the random-access block offset with `bigint`, and rejects offsets or operations
that would wrap that field. This avoids the baseline helper's `amount >>> 0`
truncation to 32 bits. The tests verify a non-block-aligned random-access slice
against the corresponding slice from a single continuous AES-CTR encryption.

The implementation intentionally does not silently wrap the counter. A caller
that reaches the end of the 64-bit counter space receives a `RangeError`.

## Compatibility boundaries

- Token nonce size, expiry encoding, mode byte, HMAC-SHA-256 construction,
  domain separator, and Base64URL representation are retained.
- Existing secret parsing accepts 32 hex characters and `dd` + 32 hex characters.
- `ADMIN_KEY`-derived and generator-derived secret domains are retained.
- Per-port secret derivation uses the original `HTTPS_PORTS` list and domain
  separator.
- The new TypeScript code is currently a parallel implementation. The
  production Worker continues to use its original JavaScript functions until
  differential tests and integration are complete.

## Validation

Run `npm test` and `npx tsc --noEmit`. Node.js 22.6 or newer is required for the
built-in TypeScript type-stripping test runner used by `npm test`.
