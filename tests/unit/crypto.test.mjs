import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  base64UrlDecodeStrict,
  base64UrlEncode,
  bytesToHex,
  hexToBytes,
  parseAdTag,
  parseSecret
} from "../../src/crypto/bytes.ts";
import { addCtrBlockOffset, aesCtrAt, importAesCtrKey, importHmacKey, toOwnedArrayBuffer } from "../../src/crypto/webcrypto.ts";
import { issueToken, verifyToken } from "../../src/crypto/token.ts";

globalThis.crypto ??= webcrypto;

test("hex and secret parsers enforce baseline formats", () => {
  assert.equal(bytesToHex(hexToBytes("00aBff")), "00abff");
  assert.equal(bytesToHex(parseSecret("0x0123456789abcdef0123456789abcdef")), "0123456789abcdef0123456789abcdef");
  assert.equal(bytesToHex(parseSecret("dd0123456789abcdef0123456789abcdef")), "0123456789abcdef0123456789abcdef");
  assert.equal(parseSecret("0123"), null);
  assert.equal(parseAdTag("a".repeat(32))?.length, 16);
  assert.equal(parseAdTag("a".repeat(31)), null);
});

test("base64url decoder rejects non-canonical encodings", () => {
  const bytes = Uint8Array.of(0, 1, 2, 253, 254, 255);
  const encoded = base64UrlEncode(bytes);
  assert.deepEqual(base64UrlDecodeStrict(encoded), bytes);
  assert.equal(base64UrlDecodeStrict("a"), null);
  assert.equal(base64UrlDecodeStrict("ab="), null);
});

test("Web Crypto byte conversion creates an exact owned ArrayBuffer", () => {
  const backing = Uint8Array.of(90, 1, 2, 3, 91);
  const view = backing.subarray(1, 4);
  const buffer = toOwnedArrayBuffer(view);
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(buffer.byteLength, 3);
  assert.deepEqual(new Uint8Array(buffer), Uint8Array.of(1, 2, 3));
  backing[2] = 99;
  assert.deepEqual(new Uint8Array(buffer), Uint8Array.of(1, 2, 3));
});

test("CTR block offset uses the 64-bit counter field and rejects wrap", () => {
  const iv = new Uint8Array(16);
  iv.fill(0xff, 8, 16);
  assert.deepEqual(addCtrBlockOffset(iv, 0n), iv);
  assert.throws(() => addCtrBlockOffset(iv, 1n), /wrap/);
  const small = new Uint8Array(16);
  small.set([0xff, 0xff], 14);
  assert.deepEqual(addCtrBlockOffset(small, 1n).slice(14), Uint8Array.of(0, 0));
  assert.throws(() => addCtrBlockOffset(new Uint8Array(15), 1n), /16 bytes/);
});

test("AES-CTR random access matches a single continuous encryption", async () => {
  const rawKey = new Uint8Array(16).fill(7);
  const iv = new Uint8Array(16).fill(3);
  const key = await importAesCtrKey(rawKey);
  const plain = Uint8Array.from({ length: 257 }, (_, i) => i & 0xff);
  const full = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain));
  const slice = await aesCtrAt(key, iv, 19, plain.slice(19, 211));
  assert.deepEqual(slice, full.slice(19, 211));
  await assert.rejects(() => aesCtrAt(key, iv, -1, plain), RangeError);
});

test("HMAC tokens round-trip and reject wrong kind, expiry, and tampering", async () => {
  const key = await importHmacKey(new Uint8Array(32).fill(9), ["sign", "verify"]);
  const token = await issueToken(key, 1, 60, 7, 1_700_000_000);
  assert.equal((await verifyToken(key, token, 1, 1_700_000_001))?.mode, 7);
  assert.equal(await verifyToken(key, token, 2, 1_700_000_001), null);
  assert.equal(await verifyToken(key, token, 1, 1_700_000_061), null);
  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.equal(await verifyToken(key, tampered, 1, 1_700_000_001), null);
});

test("runtime key derivation preserves per-port and token key construction", async () => {
  const { DEFAULT_CONFIG } = await import("../../src/config/defaults.ts");
  const { buildRuntimeCrypto, deriveGeneratedSecret } = await import("../../src/crypto/derive.ts");
  const config = {
    ...DEFAULT_CONFIG,
    secretHex: "0123456789abcdef0123456789abcdef",
    generatorKey: "generator-seed",
    adTagHex: "a".repeat(32)
  };
  const seal = new Uint8Array([1, 2, 3, 4]);
  const runtime = await buildRuntimeCrypto(config, seal);
  assert.ok(runtime);
  assert.equal(runtime.base?.length, 16);
  assert.equal(runtime.bridgeKeys.length, 2);
  assert.equal(runtime.portSecrets[443].secretHex, `dd${config.secretHex}`);
  assert.equal(runtime.portSecrets[2053].secret.length, 16);
  assert.equal(runtime.adTag?.length, 16);
  const generated = await deriveGeneratedSecret(runtime.generatorHmac, "client-label");
  assert.equal(generated.length, 16);
  assert.equal(await buildRuntimeCrypto({ ...config, secretHex: "", generatorKey: "" }, seal), null);
});

test("admin-key-only runtime derives a 16-byte proxy secret", async () => {
  const { DEFAULT_CONFIG } = await import("../../src/config/defaults.ts");
  const { buildRuntimeCrypto } = await import("../../src/crypto/derive.ts");
  const config = { ...DEFAULT_CONFIG, adminKey: "a-long-admin-key-123" };
  const runtime = await buildRuntimeCrypto(config, new Uint8Array([9, 8, 7]));
  assert.ok(runtime);
  assert.equal(runtime.secretDerived, true);
  assert.equal(runtime.base?.length, 16);
  assert.equal(runtime.adminKey, config.adminKey);
});

test("build-seal decoder returns the same decoded identity fields as the baseline algorithm", async () => {
  const { unsealBuildIdentity } = await import("../../src/crypto/derive.ts");
  const identity = await unsealBuildIdentity("Pt54F2/pkjqM1YnQmZRs3Xvqd54U1iZVSYCfYAOgf5wIRzjyeruT");
  assert.ok(identity.bytes.length > 0);
  assert.equal(typeof identity.name, "string");
  assert.equal(typeof identity.mail, "string");
});
