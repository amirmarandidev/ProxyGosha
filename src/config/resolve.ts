import { DEFAULT_CONFIG } from "./defaults.ts";
import type { RuntimeConfig, CarrierMode } from "../types/config.ts";
import type { ProxyGoshaBindings } from "../types/environment.ts";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value === "true" || value === "1";
}

function normalizePath(value: string | undefined, fallback: string): string {
  const path = value?.trim();
  return path ? (path.startsWith("/") ? path : `/${path}`) : fallback;
}

function isValidDcHost(host: string): boolean {
  if (!host || host.length > 253 || host.includes("..")) return false;
  if (host.includes(":")) return /^[0-9a-fA-F:.%]+$/.test(host) && host.includes(":");
  return /^[a-zA-Z0-9.-]+$/.test(host);
}

function parseExtraHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "").replace(/\.$/, ""))
    .filter((host) => /^[a-z0-9.-]+$/.test(host) && !host.includes(".."));
}

export function resolveConfig(env?: ProxyGoshaBindings): RuntimeConfig {
  const hostnames = typeof env?.HOSTNAME === "string" && env.HOSTNAME.trim()
    ? env.HOSTNAME.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
    : [...DEFAULT_CONFIG.hostnames];

  const parsedMaxStreams = env?.MAX_STREAMS ? Number.parseInt(env.MAX_STREAMS, 10) : Number.NaN;
  const maxStreams = Number.isNaN(parsedMaxStreams)
    ? DEFAULT_CONFIG.maxStreams
    : Math.min(32, Math.max(1, parsedMaxStreams));

  const carrierValue = env?.CARRIER?.trim().toLowerCase();
  const carrier: CarrierMode = carrierValue === "websocket" || carrierValue === "websocket-lanes"
    ? carrierValue
    : DEFAULT_CONFIG.carrier;

  const dc = { ...DEFAULT_CONFIG.dc };
  for (const id of [1, 2, 3, 4, 5, 203]) {
    const override = env?.[`DC${id}` as keyof ProxyGoshaBindings];
    if (typeof override === "string" && override.trim()) {
      const hosts = override.split(/[;,\s]+/).map((item) => item.trim().replace(/^\[|\]$/g, "")).filter(isValidDcHost);
      if (hosts.length) dc[id] = hosts;
    }
  }
  const parsedPorts = (env?.DC_PORTS ?? "").split(/[;,\s]+/).map((v) => Number.parseInt(v, 10)).filter((v) => Number.isInteger(v) && v >= 1 && v <= 65535);
  const dcPorts = parsedPorts.length ? [...new Set(parsedPorts)] : [...DEFAULT_CONFIG.dcPorts];
  // This override is inert unless an operator explicitly enables E2E_TEST_MODE.
  // It exists solely so Wrangler/workerd can exercise cloudflare:sockets against
  // a controlled loopback TCP endpoint; never set these bindings in production.
  if (env?.E2E_TEST_MODE === "true") {
    const testHost = env.E2E_DC_HOST?.trim() ?? "";
    const testPort = Number.parseInt(env.E2E_DC_PORT ?? "", 10);
    if (!/^(127\.0\.0\.1|localhost)$/.test(testHost) || !Number.isInteger(testPort) || testPort < 1 || testPort > 65535) {
      throw new Error("E2E_TEST_MODE requires E2E_DC_HOST=127.0.0.1 and a valid E2E_DC_PORT");
    }
    dc[2] = [testHost];
    dcPorts.splice(0, dcPorts.length, testPort);
  }

  return {
    ...DEFAULT_CONFIG,
    dc,
    dcPorts,
    secretHex: (typeof env?.SECRET === "string" ? env.SECRET : DEFAULT_CONFIG.secretHex).trim(),
    adTagHex: (typeof env?.AD_TAG === "string" ? env.AD_TAG : DEFAULT_CONFIG.adTagHex).trim(),
    debug: env?.DEBUG === "true" || env?.DEBUG === "1" || DEFAULT_CONFIG.debug,
    decoyUrl: (env?.DECOY_URL ?? "").trim(),
    hostnames,
    maxStreams,
    sessionPath: normalizePath(env?.SESSION_PATH, DEFAULT_CONFIG.sessionPath),
    wsPath: normalizePath(env?.WS_PATH, DEFAULT_CONFIG.wsPath),
    adminKey: (env?.ADMIN_KEY ?? "").trim(),
    extraHosts: parseExtraHosts(env?.EXTRA_HOSTS),
    carrier,
    generatorEnabled: parseBoolean(env?.GENERATOR_ENABLED, DEFAULT_CONFIG.generatorEnabled),
    generatorKey: (env?.GENERATOR_KEY ?? DEFAULT_CONFIG.generatorKey).trim(),
    acceptGenerated: parseBoolean(env?.ACCEPT_GENERATED, DEFAULT_CONFIG.acceptGenerated)
  };
}
