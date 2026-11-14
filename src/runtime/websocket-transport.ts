import { createTcpStreamFactory, type TcpConnect } from "../stream/tcp-stream.ts";
import type { DcHealthRegistry } from "../dc-health.ts";
import { WsSession, type SessionConfig, type SessionSocket, type SessionStats } from "../session/ws-session.ts";
import type { TcpStreamStats } from "../stream/tcp-stream.ts";

export interface TransportStats extends SessionStats, TcpStreamStats {
  wsRejects?: number;
}

export interface WorkerWebSocket extends SessionSocket {
  binaryType: string;
  accept(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface WebSocketTransportOptions {
  connect: TcpConnect;
  stats?: TransportStats;
  log?: (event: string, detail: string) => void;
  heartbeat?: boolean;
  now?: () => number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  random?: () => number;
  randomBytes?: (target: Uint8Array) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onMeNotice?: () => void;
  dcHealth?: DcHealthRegistry;
  adaptiveDcSelection?: boolean;
  dcHealthCooldownMs?: number;
  onDcAttempt?: (success: boolean, latencyMs: number, target: { hostname: string; port: number }) => void;
  onStreamOpen?: () => void;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxConnectAttempts?: number;
  maxSessionBytes?: number;
  onSessionOpen?: () => void;
  onHeartbeat?: () => Promise<boolean | void> | boolean | void;
  onTraffic?: (bytesUp: number, bytesDown: number) => Promise<boolean> | boolean;
  onSessionClose?: (summary: { bytesUp: number; bytesDown: number; streams: number; durationMs: number }) => void;
}

/**
 * Binds the independently tested WebSocket session and TCP stream modules to
 * Cloudflare's accepted server-side WebSocket. Authentication and WebSocket
 * upgrade response construction remain the responsibility of the Worker route.
 */
export function attachWebSocketTransport(
  server: WorkerWebSocket,
  cfg: SessionConfig,
  secret: Uint8Array,
  options: WebSocketTransportOptions,
  laneId = 0,
): WsSession {
  const stats = options.stats ?? {};
  const createStream = createTcpStreamFactory({
    connect: options.connect,
    stats,
    random: options.random,
    randomBytes: options.randomBytes,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
    log: options.log,
    onMeNotice: options.onMeNotice,
    dcHealth: options.dcHealth,
    adaptiveDcSelection: options.adaptiveDcSelection,
    onDcAttempt: options.onDcAttempt,
    onStreamOpen: options.onStreamOpen,
    idleTimeoutMs: options.idleTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxConnectAttempts: options.maxConnectAttempts,
  });

  server.binaryType = "arraybuffer";
  server.accept();

  const session = new WsSession(server, cfg, secret, {
    createStream,
    stats,
    log: options.log,
    now: options.now,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    heartbeat: options.heartbeat,
    onSessionOpen: options.onSessionOpen,
    onHeartbeat: options.onHeartbeat,
    onTraffic: options.onTraffic,
    onSessionClose: options.onSessionClose,
  }, laneId);

  server.addEventListener("message", (event) => session.enqueue(event.data));
  server.addEventListener("close", () => session.dispose());
  server.addEventListener("error", () => session.dispose());
  return session;
}
