import { base64UrlDecodeStrict, base64UrlEncode, concatBytes } from "./bytes.ts";
import { tokenMacInput, toOwnedArrayBuffer } from "./webcrypto.ts";

export interface VerifiedToken {
  nonce: Uint8Array;
  mode: number;
}

export async function issueToken(
  key: CryptoKey,
  kind: number,
  ttlSeconds: number,
  mode?: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) throw new RangeError("Token TTL must be a non-negative integer");
  const nonce = new Uint8Array(16);
  new DataView(nonce.buffer).setUint32(0, (nowSeconds + ttlSeconds) >>> 0, false);
  nonce[4] = Number.isInteger(mode) && mode! >= 0 && mode! <= 255 ? mode! : 0;
  crypto.getRandomValues(nonce.subarray(5));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, toOwnedArrayBuffer(tokenMacInput(kind, nonce))));
  return base64UrlEncode(concatBytes(nonce, mac));
}

export async function verifyToken(
  key: CryptoKey,
  token: string,
  kind: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<VerifiedToken | null> {
  const raw = base64UrlDecodeStrict(token);
  if (!raw || raw.length !== 48) return null;
  const nonce = raw.subarray(0, 16);
  const mac = raw.subarray(16);
  if (!(await crypto.subtle.verify("HMAC", key, toOwnedArrayBuffer(mac), toOwnedArrayBuffer(tokenMacInput(kind, nonce))))) return null;
  const expires = new DataView(nonce.buffer, nonce.byteOffset, 4).getUint32(0, false);
  if (expires < nowSeconds) return null;
  return { nonce, mode: nonce[4] };
}
