import { concatBytes, reverseBytes } from "../crypto/bytes.ts";
import type { DcHealthRegistry } from "../dc-health.ts";
import { aesCtrAt, importAesCtrKey, sha256 } from "../crypto/webcrypto.ts";
import { encodeFrame, encodeWindowFrame } from "../protocol/frame.ts";
import {
  identifyObfuscated2Transport,
  isSafeDcHeaderPrefix,
  Obfuscated2Transport,
  parseObfuscated2Tail,
} from "../protocol/obfuscated2.ts";
import { FrameType } from "../types/protocol.ts";
import type { SessionConfig, SessionStream } from "../session/ws-session.ts";

const EMPTY = new Uint8Array(0);
const HEADER_BYTES = 64;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CONNECT_ATTEMPTS = 4;

export interface TcpWriter {
  write(data: Uint8Array): Promise<void>;
  releaseLock(): void;
}

export interface TcpReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface TcpSocket {
  readonly opened: Promise<unknown>;
  readonly closed: Promise<unknown>;
  readonly writable: { getWriter(): TcpWriter };
  readonly readable: { getReader(): TcpReader };
  close(): Promise<void>;
}

export interface TcpConnectAddress {
  hostname: string;
  port: number;
}

export type TcpConnect = (
  address: TcpConnectAddress,
  options: { secureTransport: "off" },
) => TcpSocket;

export interface TcpStreamSession {
  readonly cfg: SessionConfig;
  readonly secret: Uint8Array;
  readonly streams: Map<number, SessionStream>;
  readonly closed: boolean;
  queued: number;
  loggedMeNotice: boolean;
  sendFrame(frame: Uint8Array): void;
  remember(id: number): void;
  onStreamClosed(id: number): void;
}

export interface TcpStreamStats {
  streams?: number;
  dcAttempts?: number;
  dcFails?: number;
}

export interface TcpStreamOptions {
  connect: TcpConnect;
  stats?: TcpStreamStats;
  random?: () => number;
  randomBytes?: (target: Uint8Array) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: (event: string, detail: string) => void;
  onMeNotice?: () => void;
  dcHealth?: DcHealthRegistry;
  adaptiveDcSelection?: boolean;
  now?: () => number;
  onDcAttempt?: (success: boolean, latencyMs: number, target: TcpConnectAddress) => void;
  onStreamOpen?: () => void;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxConnectAttempts?: number;
}

/**
 * Port of the original Worker TCP Stream. All platform-specific socket access
 * is injected so the protocol and lifecycle can be exercised outside workerd.
 */
export class TcpStream implements SessionStream {
  readonly session: TcpStreamSession;
  readonly id: number;
  phase: "header" | "init" | "ready" | "dead" = "header";
  readonly header = new Uint8Array(HEADER_BYTES);
  headerLength = 0;
  dead = false;
  socket: TcpSocket | null = null;
  writer: TcpWriter | null = null;
  reader: TcpReader | null = null;
  readonly inQueue: Uint8Array[] = [];
  inRunning = false;
  queuedLocal = 0;
  recvOutstanding = 0;
  sendCredit: number;
  creditResolve: (() => void) | null = null;
  clientReadKey: CryptoKey | null = null;
  clientReadIv: Uint8Array | null = null;
  dcWriteKey: CryptoKey | null = null;
  dcWriteIv: Uint8Array | null = null;
  clientReadPos = 64;
  dcWritePos = 64;
  private readonly options: TcpStreamOptions;
  private readonly stats: TcpStreamStats;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(session: TcpStreamSession, id: number, options: TcpStreamOptions) {
    this.session = session;
    this.id = id;
    this.options = options;
    this.stats = options.stats ?? {};
    this.stats.streams = (this.stats.streams ?? 0) + 1;
    options.onStreamOpen?.();
    this.sendCredit = session.cfg.streamWindow;
    this.touchIdleTimer();
  }

  feed(payload: Uint8Array): void {
    if (this.dead || payload.length === 0) return;
    this.touchIdleTimer();
    this.recvOutstanding += payload.length;
    if (this.recvOutstanding > this.session.cfg.streamWindow + 65_536) {
      this.kill(true);
      return;
    }
    // Keep zero-copy views for normal batches, but detach tiny payload views from
    // disproportionately large message buffers so a small queued frame cannot
    // pin an entire multi-megabyte WebSocket message in memory.
    const backingBytes = payload.buffer.byteLength;
    const chunk = backingBytes >= 262_144 && payload.byteLength * 4 < backingBytes
      ? payload.slice()
      : payload;
    this.inQueue.push(chunk);
    this.queuedLocal += chunk.length;
    this.session.queued += chunk.length;
    if (this.session.queued > this.session.cfg.maxQueued) {
      this.kill(true);
      return;
    }
    void this.runIn();
  }

  private async runIn(): Promise<void> {
    if (this.inRunning || this.dead) return;
    this.inRunning = true;
    try {
      while (!this.dead && this.inQueue.length) {
        let payload = this.inQueue[0];
        if (this.phase === "header") {
          const take = Math.min(HEADER_BYTES - this.headerLength, payload.length);
          this.header.set(payload.subarray(0, take), this.headerLength);
          this.headerLength += take;
          payload = payload.subarray(take);
          this.decrementQueued(take);
          if (payload.length) this.inQueue[0] = payload;
          else this.inQueue.shift();
          if (this.headerLength === HEADER_BYTES) {
            this.phase = "init";
            await this.initialize();
            this.grant(HEADER_BYTES);
          }
          continue;
        }
        if (this.phase !== "ready") break;
        this.inQueue.shift();
        this.decrementQueued(payload.length);
        await this.writeToDc(payload);
      }
    } catch (error) {
      this.options.log?.("stream_error", `id=${this.id} phase=${this.phase} error=${error instanceof Error ? error.message : String(error)}`);
      this.kill(true);
    } finally {
      this.inRunning = false;
      if (!this.dead && this.inQueue.length && this.phase === "ready") void this.runIn();
    }
  }

  private touchIdleTimer(): void {
    const timeout = this.options.idleTimeoutMs ?? 0;
    if (timeout <= 0 || this.dead) return;
    const clear = this.options.clearTimeoutFn ?? clearTimeout;
    const set = this.options.setTimeoutFn ?? setTimeout;
    if (this.idleTimer !== null) clear(this.idleTimer);
    this.idleTimer = set(() => {
      this.idleTimer = null;
      this.options.log?.("stream_idle_timeout", `id=${this.id}`);
      this.kill(true);
    }, timeout);
  }

  private decrementQueued(amount: number): void {
    this.queuedLocal = Math.max(0, this.queuedLocal - amount);
    this.session.queued = Math.max(0, this.session.queued - amount);
  }

  private async initialize(): Promise<void> {
    const header = this.header;
    const readKeyBytes = await sha256(concatBytes(header.subarray(8, 40), this.session.secret));
    const readIv = header.slice(40, 56);
    this.clientReadKey = await importAesCtrKey(readKeyBytes);
    this.clientReadIv = readIv;
    const tail = await aesCtrAt(this.clientReadKey, readIv, 56, header.subarray(56, 64));
    const parsed = parseObfuscated2Tail(tail);
    if (parsed.transport === Obfuscated2Transport.Unknown) throw new Error("bad tag");
    const address = this.session.cfg.dc[parsed.dcKey];
    if (!address) throw new Error("bad dc");

    const ips = (Array.isArray(address) ? address : [address]).slice();
    const ports = this.session.cfg.dcPorts.length
      ? this.session.cfg.dcPorts
      : [this.session.cfg.dcPort || 443];
    if (this.session.cfg.adTag && this.session.cfg.debug && !this.session.loggedMeNotice) {
      this.session.loggedMeNotice = true;
      this.options.onMeNotice?.();
    }

    const reversed = reverseBytes(header.subarray(8, 56));
    const writeKeyBytes = await sha256(concatBytes(reversed.subarray(0, 32), this.session.secret));
    const clientWriteIv = reversed.slice(32, 48);
    // Fast mode: DC encrypts with this material, producing bytes already
    // encrypted for the client in the download direction.
    const dcKeyMaterial = reverseBytes(concatBytes(writeKeyBytes, clientWriteIv));
    this.dcWriteKey = await importAesCtrKey(dcKeyMaterial.slice(0, 32));
    this.dcWriteIv = dcKeyMaterial.slice(32, 48);
    if (this.dead) return;
    this.clientReadPos = 64;
    this.dcWritePos = 64;

    // Preserve baseline ordering: ports are outermost; randomized IPs are inner.
    const random = this.options.random ?? Math.random;
    for (let i = ips.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ips[i], ips[j]] = [ips[j], ips[i]];
    }
    const attempts: TcpConnectAddress[] = [];
    for (const port of ports) for (const hostname of ips) attempts.push({ hostname, port });
    const orderedAttempts = this.options.dcHealth
      ? this.options.dcHealth.order(attempts, this.options.adaptiveDcSelection ?? true)
      : attempts;
    const connectTimeoutMs = clampInteger(this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 500, 15_000);
    const maxConnectAttempts = clampInteger(this.options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS, 1, 8);

    let connected: TcpSocket | null = null;
    let lastError: unknown = null;
    const setTimer = this.options.setTimeoutFn ?? setTimeout;
    const clearTimer = this.options.clearTimeoutFn ?? clearTimeout;
    for (const target of orderedAttempts.slice(0, maxConnectAttempts)) {
      if (this.dead) return;
      this.stats.dcAttempts = (this.stats.dcAttempts ?? 0) + 1;
      let candidate: TcpSocket | null = null;
      const attemptStarted = (this.options.now ?? Date.now)();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        candidate = this.options.connect(target, { secureTransport: "off" });
        void candidate.closed.catch(() => undefined);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimer(() => reject(new Error("connect timeout")), connectTimeoutMs);
        });
        await Promise.race([candidate.opened, timeout]);
        connected = candidate;
        this.options.dcHealth?.reportSuccess(target, (this.options.now ?? Date.now)() - attemptStarted);
        this.options.onDcAttempt?.(true, (this.options.now ?? Date.now)() - attemptStarted, target);
      } catch (error) {
        lastError = error;
        this.options.dcHealth?.reportFailure(target);
        this.options.onDcAttempt?.(false, (this.options.now ?? Date.now)() - attemptStarted, target);
        this.stats.dcFails = (this.stats.dcFails ?? 0) + 1;
        if (candidate) {
          try { void candidate.close().catch(() => undefined); } catch { /* socket may already be closed */ }
        }
      } finally {
        if (timer !== null) clearTimer(timer);
      }
      if (connected) break;
    }

    if (!connected) {
      this.options.log?.("dc_fail", `dc=${parsed.dcKey}`);
      throw lastError ?? new Error("failed to connect to DC");
    }
    this.socket = connected;
    if (this.dead) {
      try { await connected.close(); } catch { /* ignore close failure */ }
      return;
    }
    this.writer = connected.writable.getWriter();
    this.reader = connected.readable.getReader();

    const dcHeader = new Uint8Array(HEADER_BYTES);
    const randomBytes = this.options.randomBytes ?? ((target: Uint8Array) => crypto.getRandomValues(target));
    let safe = false;
    for (let i = 0; i < 16 && !safe; i++) {
      randomBytes(dcHeader.subarray(0, 8));
      safe = isSafeDcHeaderPrefix(dcHeader);
    }
    if (!safe) throw new Error("unable to generate a safe obfuscated2 DC header prefix");
    dcHeader.set(dcKeyMaterial, 8);
    dcHeader.set(tail.subarray(0, 4), 56);
    const view = new DataView(dcHeader.buffer);
    view.setInt16(60, parsed.dcId, true);
    view.setUint16(62, 0, true);
    const encryptedTail = await aesCtrAt(this.dcWriteKey, this.dcWriteIv, 56, dcHeader.subarray(56, 64));
    dcHeader.set(encryptedTail, 56);
    await this.writer.write(dcHeader);
    if (this.dead) return;
    this.phase = "ready";
    void this.pump().catch(() => this.kill(true));
  }

  private async writeToDc(payload: Uint8Array): Promise<void> {
    if (this.dead || !this.writer || !this.clientReadKey || !this.clientReadIv || !this.dcWriteKey || !this.dcWriteIv) return;
    const plain = await aesCtrAt(this.clientReadKey, this.clientReadIv, this.clientReadPos, payload);
    this.clientReadPos += payload.length;
    if (this.dead) return;
    const encrypted = await aesCtrAt(this.dcWriteKey, this.dcWriteIv, this.dcWritePos, plain);
    this.dcWritePos += payload.length;
    await this.writer.write(encrypted);
    this.grant(payload.length);
  }

  private async pump(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    try {
      while (!this.dead) {
        if (this.sendCredit <= 0) {
          await this.waitCredit();
          continue;
        }
        const result = await reader.read();
        if (result.done) break;
        const value = result.value;
        if (value.length) this.touchIdleTimer();
        let offset = 0;
        while (offset < value.length && !this.dead) {
          if (this.sendCredit <= 0) {
            await this.waitCredit();
            continue;
          }
          const size = Math.min(value.length - offset, this.sendCredit, this.session.cfg.dataChunk);
          if (size <= 0) continue;
          const chunk = value.subarray(offset, offset + size);
          this.sendCredit -= size;
          this.session.sendFrame(encodeFrame({ type: FrameType.Data, streamId: this.id, payload: chunk }));
          offset += size;
        }
      }
    } catch { /* reader cancellation and socket errors converge on kill */ }
    this.kill(true);
  }

  private waitCredit(): Promise<void> {
    if (this.dead || this.sendCredit > 0) return Promise.resolve();
    return new Promise((resolve) => { this.creditResolve = resolve; });
  }

  addCredit(amount: number): void {
    if (this.dead) return;
    this.sendCredit = Math.min(0xffff_ffff, this.sendCredit + amount);
    if (this.creditResolve) {
      const resolve = this.creditResolve;
      this.creditResolve = null;
      resolve();
    }
  }

  private grant(amount: number): void {
    if (this.dead || amount <= 0) return;
    this.recvOutstanding = Math.max(0, this.recvOutstanding - amount);
    this.session.sendFrame(encodeWindowFrame(this.id, amount));
  }

  kill(notify: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.phase = "dead";
    if (this.idleTimer !== null) { (this.options.clearTimeoutFn ?? clearTimeout)(this.idleTimer); this.idleTimer = null; }
    this.session.streams.delete(this.id);
    this.session.remember(this.id);
    this.session.queued = Math.max(0, this.session.queued - this.queuedLocal);
    this.queuedLocal = 0;
    this.inQueue.length = 0;
    if (this.creditResolve) {
      const resolve = this.creditResolve;
      this.creditResolve = null;
      resolve();
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* lock may already be released */ }
      this.writer = null;
    }
    if (this.reader) {
      try { void this.reader.cancel().catch(() => undefined); this.reader.releaseLock(); } catch { /* reader may already be released */ }
      this.reader = null;
    }
    if (this.socket) {
      try { void this.socket.close().catch(() => undefined); } catch { /* socket may already be closed */ }
      this.socket = null;
    }
    if (notify && !this.session.closed) {
      this.session.sendFrame(encodeFrame({ type: FrameType.Close, streamId: this.id, payload: EMPTY }));
    }
    this.session.onStreamClosed(this.id);
  }
}

export function createTcpStreamFactory(options: TcpStreamOptions) {
  return (session: Parameters<NonNullable<import("../session/ws-session.ts").WsSessionOptions["createStream"]>>[0], id: number): TcpStream =>
    new TcpStream(session as unknown as TcpStreamSession, id, options);
}

function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min;
}
