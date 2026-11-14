import type { RuntimeConfig } from "../types/config.js";

/** Defaults copied from CONFIG in the 1.2.2 JavaScript baseline. */
export const DEFAULT_CONFIG: RuntimeConfig = {
  secretHex: "",
  adminKey: "",
  extraHosts: [],
  adTagHex: "",
  debug: false,
  hostnames: ["*"],
  decoyUrl: "",
  maxStreams: 6,
  sessionPath: "/api/v1/session",
  wsPath: "/api/v1/ws",
  generatorEnabled: false,
  generatorKey: "",
  acceptGenerated: false,
  dc: {
    1: ["149.154.175.50", "149.154.175.53", "149.154.175.54"],
    2: ["149.154.167.51", "149.154.167.50", "149.154.167.40", "149.154.167.41"],
    3: ["149.154.175.100", "149.154.175.101"],
    4: ["149.154.167.91", "149.154.167.92", "149.154.167.90"],
    5: ["91.108.56.156", "91.108.56.165", "91.108.56.170"],
    203: ["91.105.192.110"]
  },
  dcPort: 443,
  dcPorts: [443, 80, 5222],
  carrier: "websocket-lanes",
  batchBytes: 2_097_152,
  bootstrapTtl: 3_600,
  sessionTtl: 86_400,
  maxQueued: 16_777_216,
  streamWindow: 4_194_304,
  dataChunk: 65_536
};
