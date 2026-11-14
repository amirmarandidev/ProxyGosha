import { concatBytes, bytesToHex, parseAdTag, parseSecret } from "./bytes.ts";
import { importHmacKey, sha256 } from "./webcrypto.ts";
import type { RuntimeConfig } from "../types/config.ts";

export const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443] as const;
const textEncoder = new TextEncoder();

export interface PortSecret {
  secret: Uint8Array;
  secretHex: string;
  keys: CryptoKey[];
}

export interface RuntimeCrypto {
  base: Uint8Array | null;
  portSecrets: Record<number, PortSecret>;
  adminKey: string;
  secretDerived: boolean;
  bridgeKeys: CryptoKey[];
  generatorHmac: CryptoKey | null;
  tokenKey: CryptoKey;
  adTag: Uint8Array | null;
}

export interface UnsealedBuildIdentity {
  bytes: Uint8Array;
  name: string;
  mail: string;
}

export async function unsealBuildIdentity(buildSeal: string): Promise<UnsealedBuildIdentity> {
  const raw = atob(buildSeal);
  const data = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const tokenDomain = textEncoder.encode("tgweb-token-v1\0");
  const salt = concatBytes(tokenDomain, Uint8Array.of(0x50, 0x47, 0x01));
  const streamParts: Uint8Array[] = [];
  let streamLength = 0;
  for (let block = 0; streamLength < data.length; block++) {
    const part = await sha256(concatBytes(salt, Uint8Array.of(block)));
    streamParts.push(part);
    streamLength += part.length;
  }
  const stream = concatBytes(...streamParts);
  const bytes = data.map((byte, index) => byte ^ stream[index]);
  const value = new TextDecoder().decode(bytes);
  const separator = value.indexOf(" | ");
  return {
    bytes,
    name: separator > 0 ? value.slice(0, separator) : value,
    mail: separator > 0 ? value.slice(separator + 3) : ""
  };
}

export async function buildRuntimeCrypto(
  config: RuntimeConfig,
  sealBytes: Uint8Array
): Promise<RuntimeCrypto | null> {
  const adminKey = config.adminKey && config.adminKey.length >= 16 ? config.adminKey : "";
  let base = parseSecret(config.secretHex);
  const secretDerived = !base && Boolean(adminKey);
  if (secretDerived) {
    base = (await sha256(concatBytes(
      textEncoder.encode("proxygosha-secret-from-admin-v2\n"),
      sealBytes,
      textEncoder.encode(`\n${adminKey}`)
    ))).slice(0, 16);
  }

  const generatorText = config.generatorKey.trim();
  if (!base && !generatorText) return null;

  const fallback = base ?? (await sha256(concatBytes(
    textEncoder.encode("tgweb-fallback-v1\0"),
    textEncoder.encode(generatorText)
  )));
  const generatorRaw = generatorText
    ? await sha256(concatBytes(textEncoder.encode("tgweb-generator-v1\0"), textEncoder.encode(generatorText)))
    : base;

  const bridgeKeys: CryptoKey[] = [];
  if (base) {
    bridgeKeys.push(await importHmacKey(base, ["verify"]));
    bridgeKeys.push(await importHmacKey(concatBytes(Uint8Array.of(0xdd), base), ["verify"]));
  }

  const portSecrets: Record<number, PortSecret> = {};
  if (base) {
    for (const port of HTTPS_PORTS) {
      const secret = port === 443
        ? base
        : (await sha256(concatBytes(
            textEncoder.encode("proxygosha-port-secret-v1\n"),
            base,
            textEncoder.encode(`\n${port}`)
          ))).slice(0, 16);
      portSecrets[port] = {
        secret,
        secretHex: `dd${bytesToHex(secret)}`,
        keys: [
          await importHmacKey(secret, ["verify"]),
          await importHmacKey(concatBytes(Uint8Array.of(0xdd), secret), ["verify"])
        ]
      };
    }
  }

  const tokenMaterial = await sha256(concatBytes(
    textEncoder.encode("tgweb-token-key-v1\0"),
    sealBytes,
    fallback
  ));
  return {
    base,
    portSecrets,
    adminKey,
    secretDerived,
    bridgeKeys,
    generatorHmac: generatorRaw ? await importHmacKey(generatorRaw, ["sign", "verify"]) : null,
    tokenKey: await importHmacKey(tokenMaterial, ["sign", "verify"]),
    adTag: parseAdTag(config.adTagHex)
  };
}

/** Derive a session-token HMAC key scoped to a validated subscription credential. */
export async function deriveSubscriptionTokenKey(subscriptionToken: string): Promise<CryptoKey> {
  const material = await sha256(concatBytes(
    textEncoder.encode("proxygosha-subscription-session-token-v1\0"),
    textEncoder.encode(subscriptionToken),
  ));
  return importHmacKey(material, ["sign", "verify"]);
}

export async function deriveGeneratedSecret(generatorHmac: CryptoKey, label: string): Promise<Uint8Array> {
  const message = textEncoder.encode(`tgweb-secret-v1\n${label}`);
  return new Uint8Array(await crypto.subtle.sign("HMAC", generatorHmac, message)).subarray(0, 16);
}
