export type CarrierMode = "websocket" | "websocket-lanes";

/**
 * Typed target for the resolved runtime configuration.
 * This describes the current worker.js configuration; resolution is migrated
 * into TypeScript in a subsequent milestone.
 */
export interface RuntimeConfig {
  secretHex: string;
  adminKey: string;
  extraHosts: string[];
  adTagHex: string;
  debug: boolean;
  hostnames: string[];
  decoyUrl: string;
  maxStreams: number;
  sessionPath: string;
  wsPath: string;
  generatorEnabled: boolean;
  generatorKey: string;
  acceptGenerated: boolean;
  dc: Record<number, string[]>;
  dcPort: number;
  dcPorts: number[];
  carrier: CarrierMode;
  batchBytes: number;
  bootstrapTtl: number;
  sessionTtl: number;
  maxQueued: number;
  streamWindow: number;
  dataChunk: number;
}
