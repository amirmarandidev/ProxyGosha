import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { once } from 'node:events';
import { concatBytes } from '../../src/crypto/bytes.ts';
import { aesCtrAt, importAesCtrKey, sha256 } from '../../src/crypto/webcrypto.ts';
import { decodeFrameBatch } from '../../src/protocol/frame.ts';
import { TcpStream } from '../../src/stream/tcp-stream.ts';
import { FrameType } from '../../src/types/protocol.ts';

const secret = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const payload = Uint8Array.from([0x50, 0x72, 0x6f, 0x78, 0x79, 0x47, 0x6f, 0x73, 0x68, 0x61]);
const responsePayload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x10, 0x20]);

async function makeClientHeader() {
  const header = new Uint8Array(64);
  for (let index = 8; index < 56; index++) header[index] = (index * 13 + 7) & 0xff;
  const readKey = await importAesCtrKey(await sha256(concatBytes(header.subarray(8, 40), secret)));
  const tail = new Uint8Array(8);
  tail.set([0xef, 0xef, 0xef, 0xef]);
  new DataView(tail.buffer).setInt16(4, 2, true);
  header.set(await aesCtrAt(readKey, header.subarray(40, 56), 56, tail), 56);
  return header;
}

function createTcpSocket(address) {
  const socket = netConnect(address.port, address.hostname);
  let readableController;
  let readableCancelled = false;
  const opened = once(socket, 'connect').then(() => undefined);
  const closed = new Promise((resolve) => socket.once('close', resolve));

  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;
      socket.on('data', (chunk) => {
        if (!readableCancelled) controller.enqueue(new Uint8Array(chunk));
      });
      socket.once('end', () => {
        if (!readableCancelled) controller.close();
      });
      socket.once('error', (error) => {
        if (!readableCancelled) controller.error(error);
      });
    },
    cancel() {
      readableCancelled = true;
      socket.destroy();
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        socket.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve());
      });
    },
    close() {
      socket.end();
    },
    abort(reason) {
      socket.destroy(reason instanceof Error ? reason : undefined);
    },
  });

  return {
    opened,
    closed,
    readable,
    writable,
    async close() {
      if (!socket.destroyed) socket.destroy();
    },
  };
}

function makeSession(port) {
  const sent = [];
  const cfg = {
    carrier: 'websocket',
    maxStreams: 2,
    streamWindow: 4096,
    maxQueued: 16_384,
    dataChunk: 1024,
    dc: { 2: ['127.0.0.1'] },
    dcPort: port,
    dcPorts: [port],
    adTag: null,
    debug: false,
  };
  return {
    cfg,
    secret,
    streams: new Map(),
    closed: false,
    queued: 0,
    loggedMeNotice: false,
    sent,
    sendFrame(frame) { sent.push(frame); },
    remember(id) { this.tombstone = id; },
    onStreamClosed(id) { this.closedStream = id; },
  };
}

async function waitUntil(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('TCP stream exchanges data with a real loopback TCP endpoint', async (t) => {
  let received = Buffer.alloc(0);
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let acceptedSocket;
  server.once('connection', (socket) => { acceptedSocket = socket; });

  const session = makeSession(address.port);
  const stream = new TcpStream(session, 17, {
    connect: createTcpSocket,
    random: () => 0,
    randomBytes(target) { target.set([1, 2, 3, 4, 5, 6, 7, 8]); },
  });
  session.streams.set(stream.id, stream);

  stream.feed(await makeClientHeader());
  await waitUntil(() => stream.phase === 'ready' && received.length >= 64, 'the 64-byte outbound obfuscation header');
  assert.equal(received.length, 64, 'the endpoint should first receive exactly the obfuscation header');

  stream.feed(payload);
  await waitUntil(() => received.length >= 64 + payload.length, 'the outbound encrypted payload');
  assert.equal(received.length, 64 + payload.length, 'the endpoint should receive one encrypted payload after the header');
  assert.notDeepEqual([...received.subarray(64)], [...payload], 'client payload must be transformed before it reaches the DC socket');

  const dataPromise = waitUntil(
    () => session.sent.flatMap((batch) => decodeFrameBatch(batch)).some((frame) => frame.type === FrameType.Data && frame.streamId === stream.id),
    'a downstream DATA frame',
  );
  acceptedSocket.write(Buffer.from(responsePayload));
  await dataPromise;
  const frames = session.sent.flatMap((batch) => decodeFrameBatch(batch));
  const downstream = frames.find((frame) => frame.type === FrameType.Data && frame.streamId === stream.id);
  assert.deepEqual([...downstream.payload], [...responsePayload], 'raw DC response bytes must be forwarded in a DATA frame');
  assert.ok(frames.some((frame) => frame.type === FrameType.Window), 'stream must grant receive-window credit');

  stream.kill(false);
  assert.equal(stream.dead, true);
  assert.equal(session.closedStream, stream.id);
  assert.equal(session.tombstone, stream.id);
});
