/** Telegram MTProto transport tags accepted by the original Worker. */
export const Obfuscated2Transport = {
  Unknown: 0,
  Abridged: 1,
  Intermediate: 2,
  PaddedIntermediate: 3
} as const;

export type Obfuscated2Transport = (typeof Obfuscated2Transport)[keyof typeof Obfuscated2Transport];

export interface Obfuscated2Tail {
  transport: Obfuscated2Transport;
  /** Signed little-endian DC ID from bytes 4..5 of the decrypted tail. */
  dcId: number;
  /** Absolute DC lookup key used by the original Worker. */
  dcKey: number;
}

export function identifyObfuscated2Transport(tag: Uint8Array): Obfuscated2Transport {
  if (tag.length < 4) return Obfuscated2Transport.Unknown;
  if (tag[0] === 0xef && tag[1] === 0xef && tag[2] === 0xef && tag[3] === 0xef) {
    return Obfuscated2Transport.Abridged;
  }
  if (tag[0] === 0xee && tag[1] === 0xee && tag[2] === 0xee && tag[3] === 0xee) {
    return Obfuscated2Transport.Intermediate;
  }
  if (tag[0] === 0xdd && tag[1] === 0xdd && tag[2] === 0xdd && tag[3] === 0xdd) {
    return Obfuscated2Transport.PaddedIntermediate;
  }
  return Obfuscated2Transport.Unknown;
}

/**
 * Parse the 8-byte decrypted Obfuscated2 tail (transport tag + signed DC ID
 * + two reserved bytes). This function does not validate the reserved bytes;
 * the original Worker did not validate them either.
 */
export function parseObfuscated2Tail(tail: Uint8Array): Obfuscated2Tail {
  if (tail.byteLength !== 8) throw new RangeError("Obfuscated2 tail must be exactly 8 bytes");
  const transport = identifyObfuscated2Transport(tail.subarray(0, 4));
  const dcId = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getInt16(4, true);
  return { transport, dcId, dcKey: Math.abs(dcId) };
}

/**
 * Match the baseline's outbound DC obfuscation-header prefix exclusions.
 * The supplied value must contain the first eight bytes of a candidate header.
 */
export function isSafeDcHeaderPrefix(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) throw new RangeError("DC header prefix must contain at least 8 bytes");
  if (bytes[0] === 0xef) return false;
  if (bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0) return false;
  if (bytes[0] === 0x47 && bytes[1] === 0x45 && bytes[2] === 0x54 && bytes[3] === 0x20) return false;
  if (bytes[0] === 0x50 && bytes[1] === 0x4f && bytes[2] === 0x53 && bytes[3] === 0x54) return false;
  if (bytes[0] === 0x48 && bytes[1] === 0x45 && bytes[2] === 0x41 && bytes[3] === 0x44) return false;
  if (bytes[0] === 0x4f && bytes[1] === 0x50 && bytes[2] === 0x54 && bytes[3] === 0x49) return false;
  if (bytes[0] === 0xee && bytes[1] === 0xee && bytes[2] === 0xee && bytes[3] === 0xee) return false;
  if (bytes[0] === 0xdd && bytes[1] === 0xdd && bytes[2] === 0xdd && bytes[3] === 0xdd) return false;
  if (bytes[0] === 0x16 && bytes[1] === 0x03 && bytes[2] === 0x01 && bytes[3] === 0x02) return false;
  return true;
}
