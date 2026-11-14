export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new TypeError("Invalid hexadecimal input");
  }
  const output = new Uint8Array(hex.length / 2);
  for (let i = 0; i < output.length; i++) output[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecodeStrict(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const output = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return base64UrlEncode(output) === value ? output : null;
  } catch {
    return null;
  }
}

export function parseSecret(hexValue: string | undefined): Uint8Array | null {
  let hex = (hexValue ?? "").trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 32) return hexToBytes(hex);
  if (hex.length === 34 && hex.startsWith("dd")) return hexToBytes(hex.slice(2));
  return null;
}

export function parseAdTag(hexValue: string | undefined): Uint8Array | null {
  const hex = (hexValue ?? "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hexToBytes(hex) : null;
}
