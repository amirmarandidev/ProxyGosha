import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWebSocketTransport } from '../../src/runtime/websocket-transport.ts';
import { encodeFrame } from '../../src/protocol/frame.ts';
import { FrameType } from '../../src/types/protocol.ts';

class MockWebSocket {
  readyState = 1;
  binaryType = '';
  accepted = false;
  sent = [];
  closed = [];
  listeners = new Map();

  accept() { this.accepted = true; }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; }
  addEventListener(type, listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function config() {
  return {
    carrier: 'websocket',
    maxStreams: 4,
    streamWindow: 1024,
    maxQueued: 4096,
    dataChunk: 1024,
    dc: { 1: ['127.0.0.1'] },
    dcPort: 443,
    dcPorts: [443],
    adTag: null,
    debug: false,
  };
}

test('transport accepts WebSocket and wires OPEN/CLOSE to TCP stream lifecycle', async () => {
  const ws = new MockWebSocket();
  const stats = {};
  let connects = 0;
  const session = attachWebSocketTransport(ws, config(), new Uint8Array(16), {
    connect() { connects++; throw new Error('unexpected connect'); },
    stats,
    heartbeat: false,
  });

  assert.equal(ws.binaryType, 'arraybuffer');
  assert.equal(ws.accepted, true);

  const open = encodeFrame({ type: FrameType.Open, streamId: 7, payload: new Uint8Array() });
  ws.emit('message', { data: open.buffer.slice(open.byteOffset, open.byteOffset + open.byteLength) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.streams.size, 1);
  assert.equal(stats.streams, 1);
  assert.equal(connects, 0, 'TCP connection must wait for the client header');

  const close = encodeFrame({ type: FrameType.Close, streamId: 7, payload: new Uint8Array() });
  ws.emit('message', { data: close.buffer.slice(close.byteOffset, close.byteOffset + close.byteLength) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.streams.size, 0);
  assert.equal(session.tombstones.has(7), true);
  assert.equal(connects, 0);
  session.dispose();
  assert.equal(stats.sessionsActive, 0);
});

test('transport disposes the session on WebSocket close and error events', async (t) => {
  for (const eventName of ['close', 'error']) {
    await t.test(eventName, () => {
      const ws = new MockWebSocket();
      const stats = {};
      const session = attachWebSocketTransport(ws, config(), new Uint8Array(16), {
        connect() { throw new Error('not expected'); },
        stats,
        heartbeat: false,
      });
      ws.emit(eventName);
      assert.equal(session.closed, true);
      assert.equal(stats.sessionsActive, 0);
    });
  }
});

test('transport lane ID is passed through to the session state machine', async () => {
  const ws = new MockWebSocket();
  const session = attachWebSocketTransport(ws, config(), new Uint8Array(16), {
    connect() { throw new Error('not expected'); },
    heartbeat: false,
  }, 12);
  assert.equal(session.laneId, 12);

  const wrongLane = encodeFrame({ type: FrameType.Open, streamId: 13, payload: new Uint8Array() });
  ws.emit('message', { data: wrongLane.buffer.slice(wrongLane.byteOffset, wrongLane.byteOffset + wrongLane.byteLength) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.closed, true);
  assert.equal(ws.closed[0].code, 1011);
});
