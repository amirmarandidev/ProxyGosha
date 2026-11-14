import { decodeFrameBatch, encodeFrame } from "../protocol/frame.ts";
import { FrameType, type ProtocolFrame } from "../types/protocol.ts";

const EMPTY = new Uint8Array(0);
const MAX_TOMBSTONES = 4096;
const MAX_PING_BYTES = 64;

export interface SessionConfig {
  carrier: string;
  maxStreams: number;
  streamWindow: number;
  maxQueued: number;
  dataChunk: number;
  dc: Record<number, string | string[]>;
  dcPort: number;
  dcPorts: number[];
  adTag: Uint8Array | null;
  debug: boolean;
  maxSessionBytes?: number;
}

export interface SessionStream {
  feed(payload: Uint8Array): void;
  addCredit(amount: number): void;
  kill(notify: boolean): void;
}

export interface SessionSocket {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

export interface SessionStats {
  sessions?: number;
  sessionsActive?: number;
  bytesUp?: number;
  bytesDown?: number;
}

export interface WsSessionOptions {
  createStream: (session: WsSession, id: number) => SessionStream;
  stats?: SessionStats;
  log?: (event: string, detail: string) => void;
  now?: () => number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  heartbeat?: boolean;
  onSessionOpen?: () => void;
  onHeartbeat?: () => Promise<boolean | void> | boolean | void;
  onTraffic?: (bytesUp: number, bytesDown: number) => Promise<boolean> | boolean;
  onSessionClose?: (summary: { bytesUp: number; bytesDown: number; streams: number; durationMs: number }) => void;
}

export class WsSession {
  readonly laneId: number;
  laneUsed = false;
  readonly ws: SessionSocket;
  readonly cfg: SessionConfig;
  readonly secret: Uint8Array;
  readonly streams = new Map<number, SessionStream>();
  closed = false;
  queued = 0;
  readonly tombstones = new Set<number>();
  readonly tombstoneOrder: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private inboundQueuedBytes = 0;
  private outboundQueuedBytes = 0;
  private outboundChain: Promise<void> = Promise.resolve();
  lastPong: number;
  readonly openedAt: number;
  bytesUp = 0;
  bytesDown = 0;
  streamCount = 0;
  loggedMeNotice = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options: WsSessionOptions;
  private readonly now: () => number;
  private readonly stats: SessionStats;

  constructor(ws: SessionSocket, cfg: SessionConfig, secret: Uint8Array, options: WsSessionOptions, laneId = 0) {
    if (!Number.isInteger(laneId) || laneId < 0 || laneId > 0xffffff) throw new RangeError("Lane ID must fit in 24 bits");
    this.laneId = laneId;
    this.ws = ws;
    this.cfg = cfg;
    this.secret = secret;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.stats = options.stats ?? {};
    this.openedAt = this.now();
    this.lastPong = this.openedAt;
    this.stats.sessions = (this.stats.sessions ?? 0) + 1;
    this.stats.sessionsActive = (this.stats.sessionsActive ?? 0) + 1;
    options.onSessionOpen?.();
    options.log?.("session_open", `lane=${laneId} carrier=${cfg.carrier}`);

    if (options.heartbeat !== false) {
      const set = options.setIntervalFn ?? setInterval;
      this.keepAliveTimer = set(() => this.heartbeatTick(), 25_000);
    }
  }

  private heartbeatTick(): void {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      this.clearHeartbeat();
      return;
    }
    if (this.now() - this.lastPong > 90_000) {
      this.shutdown("pong watchdog");
      return;
    }
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, Math.floor(this.now() / 1000), false);
    this.sendFrame({ type: FrameType.Ping, streamId: 0, payload });
    try {
      void Promise.resolve(this.options.onHeartbeat?.()).then((allowed) => {
        if (allowed === false && !this.closed) this.shutdown("session authorization or lease expired");
      }).catch(() => {
        // A configured control plane is required to renew an active session.
        if (!this.closed) this.shutdown("session lease renewal failed");
      });
    } catch {
      this.shutdown("session lease renewal failed");
    }
  }

  private clearHeartbeat(): void {
    if (!this.keepAliveTimer) return;
    (this.options.clearIntervalFn ?? clearInterval)(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  sendFrame(frame: ProtocolFrame | Uint8Array): void {
    if (this.closed) return;
    // Frame objects are encoded by the shared wire-format implementation.
    const bytes = frame instanceof Uint8Array
      ? frame
      : encodeFrame(frame);
    this.bytesDown += bytes.length;
    this.stats.bytesDown = (this.stats.bytesDown ?? 0) + bytes.length;
    if ((this.cfg.maxSessionBytes ?? 0) > 0 && this.bytesUp + this.bytesDown > this.cfg.maxSessionBytes!) {
      this.shutdown("session byte quota");
      return;
    }
    if (!this.options.onTraffic) {
      try {
        if (this.ws.readyState !== 1) return;
        const buffered = this.ws.bufferedAmount;
        if (typeof buffered === "number" && Number.isFinite(buffered)
          && buffered + bytes.byteLength > this.cfg.maxQueued) {
          this.shutdown("outbound WebSocket buffered amount limit");
          return;
        }
        this.ws.send(bytes);
      } catch { this.dispose(); }
      return;
    }
    this.outboundQueuedBytes += bytes.length;
    if (this.outboundQueuedBytes > this.cfg.maxQueued) {
      this.shutdown("outbound WebSocket queue limit");
      return;
    }
    this.outboundChain = this.outboundChain.then(async () => {
      try {
        if (this.closed) return;
        if (this.options.onTraffic && !(await this.options.onTraffic(this.bytesUp, this.bytesDown))) {
          this.shutdown("traffic quota exceeded");
          return;
        }
        if (!this.closed && this.ws.readyState === 1) this.ws.send(bytes);
      } finally {
        this.outboundQueuedBytes = Math.max(0, this.outboundQueuedBytes - bytes.length);
      }
    }).catch(() => this.dispose());
  }

  onStreamClosed(id: number): void {
    if (!this.laneId || this.closed || id !== this.laneId) return;
    this.dispose();
    try {
      if (this.ws.readyState === 1) this.ws.close(1000, "done");
    } catch { /* socket already closed */ }
  }

  remember(id: number): void {
    if (this.tombstones.has(id)) return;
    if (this.tombstoneOrder.length === MAX_TOMBSTONES) {
      const oldest = this.tombstoneOrder.shift();
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
    this.tombstones.add(id);
    this.tombstoneOrder.push(id);
  }

  enqueue(data: unknown): void {
    if (this.closed) return;
    const size = data instanceof ArrayBuffer ? data.byteLength : 0;
    this.inboundQueuedBytes += size;
    if (this.inboundQueuedBytes > this.cfg.maxQueued) {
      this.shutdown("inbound WebSocket queue limit");
      return;
    }
    this.chain = this.chain.then(async () => {
      try { await this.handle(data); }
      finally { this.inboundQueuedBytes = Math.max(0, this.inboundQueuedBytes - size); }
    }).catch(() => this.shutdown());
  }

  async handle(data: unknown): Promise<void> {
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer)) {
      this.shutdown();
      return;
    }

    const bytes = new Uint8Array(data);
    this.bytesUp += bytes.length;
    this.stats.bytesUp = (this.stats.bytesUp ?? 0) + bytes.length;
    if ((this.cfg.maxSessionBytes ?? 0) > 0 && this.bytesUp + this.bytesDown > this.cfg.maxSessionBytes!) {
      this.shutdown("session byte quota");
      return;
    }
    if (this.options.onTraffic && !(await this.options.onTraffic(this.bytesUp, this.bytesDown))) {
      this.shutdown("traffic quota exceeded");
      return;
    }

    let frames: ProtocolFrame[];
    try {
      frames = decodeFrameBatch(bytes);
    } catch {
      this.shutdown();
      return;
    }

    for (const frame of frames) {
      if (this.closed) return;
      const { type, streamId: id, payload } = frame;
      const size = payload.length;

      if (this.laneId && id !== this.laneId) {
        this.shutdown();
        return;
      }

      if (type === FrameType.Open) {
        if (id === 0 || size !== 0) {
          this.shutdown();
          return;
        }
        if (this.laneId) {
          if (this.laneUsed) {
            this.shutdown();
            return;
          }
          this.laneUsed = true;
          this.streams.set(id, this.makeStream(id));
          continue;
        }
        if (this.streams.has(id) || this.tombstones.has(id) || this.streams.size >= this.cfg.maxStreams) {
          this.sendFrame({ type: FrameType.Close, streamId: id, payload: EMPTY });
          continue;
        }
        this.streams.set(id, this.makeStream(id));
      } else if (type === FrameType.Data) {
        if (id === 0 || size === 0) {
          this.shutdown();
          return;
        }
        const stream = this.streams.get(id);
        if (stream) stream.feed(payload);
        else if (!this.tombstones.has(id)) this.sendFrame({ type: FrameType.Close, streamId: id, payload: EMPTY });
      } else if (type === FrameType.Close) {
        if (id === 0 || size !== 0) {
          this.shutdown();
          return;
        }
        this.streams.get(id)?.kill(false);
      } else if (type === FrameType.Window) {
        if (id === 0 || size !== 4) {
          this.shutdown();
          return;
        }
        const credit = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
        this.streams.get(id)?.addCredit(credit);
      } else if (type === FrameType.Ping) {
        if (id === 0) {
          if (size > MAX_PING_BYTES) {
            this.shutdown();
            return;
          }
          this.sendFrame({ type: FrameType.Pong, streamId: 0, payload });
        }
      } else if (type === FrameType.Pong) {
        if (id !== 0) {
          this.shutdown();
          return;
        }
        this.lastPong = this.now();
      } else {
        this.shutdown();
        return;
      }
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stats.sessionsActive = Math.max(0, (this.stats.sessionsActive ?? 0) - 1);
    this.options.log?.("session_close", `streams=${this.streamCount} up=${this.bytesUp} down=${this.bytesDown}`);
    this.options.onSessionClose?.({
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      streams: this.streamCount,
      durationMs: Math.max(0, this.now() - this.openedAt),
    });
    this.clearHeartbeat();
    for (const stream of Array.from(this.streams.values())) stream.kill(false);
    this.streams.clear();
    this.tombstones.clear();
    this.tombstoneOrder.length = 0;
    this.queued = 0;
    this.inboundQueuedBytes = 0;
    this.outboundQueuedBytes = 0;
  }

  shutdown(reason?: string): void {
    this.options.log?.("session_kill", reason || "protocol");
    this.dispose();
    try {
      if (this.ws.readyState === 1) this.ws.close(1011, "closed");
    } catch { /* socket already closed */ }
  }

  private makeStream(id: number): SessionStream {
    this.streamCount++;
    return this.options.createStream(this, id);
  }
}

