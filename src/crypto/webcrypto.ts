import { concatBytes } from "./bytes.ts";

export const TOKEN_DOMAIN = new TextEncoder().encode("tgweb-token-v1\0");

/** Copy bytes into an owned ArrayBuffer accepted by the Web Crypto BufferSource APIs. */
export function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toOwnedArrayBuffer(bytes)));
}

export function importHmacKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toOwnedArrayBuffer(raw), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export function importAesCtrKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toOwnedArrayBuffer(raw), { name: "AES-CTR" }, false, ["encrypt"]);
}

/** Adds a block offset to the low 64-bit AES-CTR counter field. */
export function addCtrBlockOffset(iv: Uint8Array, blockOffset: bigint): Uint8Array {
  if (iv.length !== 16) throw new RangeError("AES-CTR counter must be 16 bytes");
  if (blockOffset < 0n || blockOffset > 0xffff_ffff_ffff_ffffn) throw new RangeError("AES-CTR block offset is out of range");
  const output = new Uint8Array(iv);
  let counter = 0n;
  for (let i = 8; i < 16; i++) counter = (counter << 8n) | BigInt(output[i]);
  const sum = counter + blockOffset;
  if (sum > 0xffff_ffff_ffff_ffffn) throw new RangeError("AES-CTR counter would wrap");
  for (let i = 15; i >= 8; i--) {
    output[i] = Number(sum >> BigInt((15 - i) * 8) & 0xffn);
  }
  return output;
}

export async function aesCtrAt(
  key: CryptoKey,
  iv: Uint8Array,
  position: number | bigint,
  data: Uint8Array
): Promise<Uint8Array> {
  const offset = typeof position === "bigint" ? position : BigInt(position);
  if (offset < 0n || (typeof position === "number" && (!Number.isSafeInteger(position) || position < 0))) {
    throw new RangeError("AES-CTR position must be a non-negative safe integer or bigint");
  }
  const blockOffset = offset / 16n;
  const skip = Number(offset % 16n);
  const blocksNeeded = BigInt(Math.ceil((skip + data.length) / 16));
  const counter = addCtrBlockOffset(iv, blockOffset);
  let low = 0n;
  for (let i = 8; i < 16; i++) low = (low << 8n) | BigInt(counter[i]);
  if (blocksNeeded > 0n && low + blocksNeeded - 1n > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("AES-CTR operation would wrap the 64-bit counter");
  }

  if (skip === 0) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: toOwnedArrayBuffer(counter), length: 64 }, key, toOwnedArrayBuffer(data)));
  }
  const input = new Uint8Array(skip + data.length);
  input.set(data, skip);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: toOwnedArrayBuffer(counter), length: 64 }, key, toOwnedArrayBuffer(input)));
  return encrypted.subarray(skip);
}

export function tokenMacInput(kind: number, nonce: Uint8Array): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) throw new RangeError("Token kind must fit in one byte");
  return concatBytes(TOKEN_DOMAIN, Uint8Array.of(kind), nonce);
}
