import test from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "../../src/crypto/bytes.ts";
import { aesCtrAt, importAesCtrKey, sha256 } from "../../src/crypto/webcrypto.ts";
import { decodeFrameBatch } from "../../src/protocol/frame.ts";
import { TcpStream } from "../../src/stream/tcp-stream.ts";
import { FrameType } from "../../src/types/protocol.ts";

const secret = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const cfg = {
  carrier: "websocket",
  maxStreams: 6,
  streamWindow: 1024,
  maxQueued: 4096,
  dataChunk: 64,
  dc: { 2: ["149.154.167.51", "149.154.167.50"] },
  dcPort: 443,
  dcPorts: [443, 80],
  adTag: null,
  debug: false,
};

async function makeClientHeader(dcId = 2, tag = [0xef, 0xef, 0xef, 0xef]) {
  const header = new Uint8Array(64);
  for (let i = 8; i < 56; i++) header[i] = (i * 13 + 7) & 0xff;
  const readKey = await importAesCtrKey(await sha256(concatBytes(header.subarray(8, 40), secret)));
  const tail = new Uint8Array(8);
  tail.set(tag, 0);
  new DataView(tail.buffer).setInt16(4, dcId, true);
  header.set(await aesCtrAt(readKey, header.subarray(40, 56), 56, tail), 56);
  return header;
}

function makeSession() {
  const sent = [];
  const session = {
    cfg: { ...cfg, dc: { ...cfg.dc }, dcPorts: [...cfg.dcPorts] },
    secret,
    streams: new Map(),
    closed: false,
    queued: 0,
    loggedMeNotice: false,
    sendFrame(bytes) { sent.push(bytes); },
    remember(id) { this.lastTombstone = id; },
    onStreamClosed(id) { this.closedStream = id; },
    sent,
  };
  return session;
}

function makeSocket() {
  const writes = [];
  let controller;
  let cancelled = false;
  const readable = new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  });
  const writable = new WritableStream({ write(chunk) { writes.push(chunk.slice()); } });
  const socket = {
    opened: Promise.resolve(),
    closed: new Promise(() => {}),
    readable,
    writable,
    async close() { try { controller.close(); } catch {} },
    push(bytes) { controller.enqueue(bytes); },
    writes,
    wasCancelled: () => cancelled,
  };
  return socket;
}

async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition did not become true");
}

test("TCP stream decrypts the client header, connects, writes DC header, and grants credit", async () => {
  const session = makeSession();
  const socket = makeSocket();
  const attempts = [];
  const stream = new TcpStream(session, 7, {
    connect(address, options) { attempts.push({ address, options }); return socket; },
    random: () => 0,
    randomBytes(target) { target.set([1, 2, 3, 4, 5, 6, 7, 8]); },
  });
  session.streams.set(7, stream);
  const header = await makeClientHeader();
  const payload = Uint8Array.from([9, 8, 7, 6, 5]);
  stream.feed(concatBytes(header, payload));

  await waitUntil(() => stream.phase === "ready" && socket.writes.length === 2);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].address, { hostname: "149.154.167.50", port: 443 });
  assert.deepEqual(attempts[0].options, { secureTransport: "off" });
  assert.equal(socket.writes[0].length, 64);
  assert.equal(socket.writes[1].length, payload.length);
  const grants = session.sent.map((frame) => decodeFrameBatch(frame)[0]);
  assert.deepEqual(grants.map((frame) => frame.type), [FrameType.Window, FrameType.Window]);
  assert.deepEqual(grants.map((frame) => new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, false)), [64, payload.length]);
  assert.equal(session.queued, 0);

  socket.push(Uint8Array.from([1, 2, 3, 4]));
  await waitUntil(() => session.sent.length === 3);
  const downloadFrame = decodeFrameBatch(session.sent[2])[0];
  assert.equal(downloadFrame.type, FrameType.Data);
  assert.equal(downloadFrame.streamId, 7);
  assert.deepEqual([...downloadFrame.payload], [1, 2, 3, 4]);

  stream.kill(false);
  assert.equal(stream.phase, "dead");
  assert.equal(session.closedStream, 7);
  assert.equal(session.lastTombstone, 7);
});

test("TCP stream rejects unknown Obfuscated2 tags without opening a socket", async () => {
  const session = makeSession();
  let connects = 0;
  const stream = new TcpStream(session, 9, {
    connect() { connects++; throw new Error("must not connect"); },
  });
  session.streams.set(9, stream);
  stream.feed(await makeClientHeader(2, [1, 2, 3, 4]));
  await waitUntil(() => stream.dead);
  assert.equal(connects, 0);
  assert.equal(session.lastTombstone, 9);
  assert.equal(decodeFrameBatch(session.sent[0])[0].type, FrameType.Close);
});

test("TCP stream bounds failover to four connection attempts and closes failed sockets", async () => {
  const session = makeSession();
  const failed = [];
  const stream = new TcpStream(session, 11, {
    connect() {
      const socket = {
        opened: Promise.reject(new Error("refused")),
        closed: Promise.resolve(),
        writable: { getWriter() { throw new Error("not opened"); } },
        readable: { getReader() { throw new Error("not opened"); } },
        async close() { failed.push("closed"); },
      };
      return socket;
    },
    random: () => 0,
  });
  session.streams.set(11, stream);
  stream.feed(await makeClientHeader());
  await waitUntil(() => stream.dead);
  assert.equal(failed.length, 4);
  assert.equal(decodeFrameBatch(session.sent[0])[0].type, FrameType.Close);
});

test("TCP stream enforces inbound outstanding and aggregate queue limits", () => {
  const session = makeSession();
  const stream = new TcpStream(session, 13, { connect() { throw new Error("unused"); } });
  session.streams.set(13, stream);
  stream.feed(new Uint8Array(cfg.streamWindow + 65_537));
  assert.equal(stream.dead, true);
  assert.equal(session.queued, 0);

  const secondSession = makeSession();
  secondSession.cfg.maxQueued = 10;
  const second = new TcpStream(secondSession, 15, { connect() { throw new Error("unused"); } });
  secondSession.streams.set(15, second);
  second.feed(new Uint8Array(11));
  assert.equal(second.dead, true);
  assert.equal(secondSession.queued, 0);
});

test("TCP stream idle timeout closes an inactive stream and clears its timer", async () => {
  const session = makeSession();
  const timers = [];
  const cleared = new Set();
  const stream = new TcpStream(session, 23, {
    connect() { throw new Error("no socket should be opened before the header is complete"); },
    idleTimeoutMs: 30_000,
    setTimeoutFn(callback) { const timer = { callback }; timers.push(timer); return timer; },
    clearTimeoutFn(timer) { cleared.add(timer); },
  });
  session.streams.set(23, stream);
  assert.equal(timers.length, 1);
  stream.feed(Uint8Array.of(1));
  assert.equal(timers.length, 2);
  assert.ok(cleared.has(timers[0]));
  timers[1].callback();
  assert.equal(stream.dead, true);
  assert.equal(session.closedStream, 23);
});

test('TCP stream refuses a predictable fallback when secure DC header randomness fails', async () => {
  const session = makeSession();
  const socket = makeSocket();
  const stream = new TcpStream(session, 29, {
    connect() { return socket; },
    random: () => 0,
    randomBytes(target) { target.fill(0); },
  });
  session.streams.set(29, stream);
  stream.feed(await makeClientHeader());
  await waitUntil(() => stream.dead);
  assert.equal(socket.writes.length, 0);
  assert.equal(session.lastTombstone, 29);
});


test('TCP stream detaches tiny queued payloads from disproportionately large WebSocket buffers', () => {
  const session = makeSession();
  const stream = new TcpStream(session, 31, { connect() { throw new Error('unused'); } });
  stream.phase = 'init';
  session.streams.set(31, stream);
  const backing = new Uint8Array(512 * 1024);
  backing.set([1, 2, 3, 4], 128);
  stream.feed(backing.subarray(128, 132));
  assert.equal(stream.inQueue[0].byteLength, 4);
  assert.equal(stream.inQueue[0].buffer.byteLength, 4);
  stream.kill(false);
});

test('TCP stream honors configured maximum DC connection attempts', async () => {
  const session = makeSession();
  const attempts = [];
  const logs = [];
  const stream = new TcpStream(session, 33, {
    connect() { attempts.push(1); return { opened: Promise.reject(new Error('refused')), closed: Promise.resolve(), writable: { getWriter() { throw new Error('unused'); } }, readable: { getReader() { throw new Error('unused'); } }, async close() {} }; },
    random: () => 0,
    randomBytes(target) { target.set([1, 2, 3, 4, 5, 6, 7, 8]); },
    maxConnectAttempts: 2,
    connectTimeoutMs: 500,
    log(event, detail) { logs.push(`${event}:${detail}`); },
  });
  session.streams.set(33, stream);
  stream.feed(await makeClientHeader());
  await waitUntil(() => stream.dead);
  assert.equal(attempts.length, 2, logs.join(' | '));
});


test('TCP stream applies the configured timeout to each bounded DC attempt', async () => {
  const session = makeSession();
  const attempts = [];
  const delays = [];
  const stream = new TcpStream(session, 35, {
    connect() { attempts.push(1); return { opened: new Promise(() => {}), closed: new Promise(() => {}), writable: { getWriter() { throw new Error('unused'); } }, readable: { getReader() { throw new Error('unused'); } }, async close() {} }; },
    random: () => 0,
    randomBytes(target) { target.set([1, 2, 3, 4, 5, 6, 7, 8]); },
    maxConnectAttempts: 2,
    connectTimeoutMs: 750,
    setTimeoutFn(callback, delay) { delays.push(delay); const timer = { callback }; queueMicrotask(callback); return timer; },
    clearTimeoutFn() {},
  });
  session.streams.set(35, stream);
  stream.feed(await makeClientHeader());
  await waitUntil(() => stream.dead);
  assert.equal(attempts.length, 2);
  assert.deepEqual(delays, [750, 750]);
});
