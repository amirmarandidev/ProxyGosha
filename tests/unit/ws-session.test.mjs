import test from 'node:test';
import assert from 'node:assert/strict';
import { WsSession } from '../../src/session/ws-session.ts';
import { encodeFrame } from '../../src/protocol/frame.ts';
import { FrameType } from '../../src/types/protocol.ts';

function setup({ laneId = 0, maxStreams = 2, maxSessionBytes = 0, maxQueued = 1_000_000, heartbeat = false, now = () => 1000, onTraffic, onHeartbeat, setIntervalFn } = {}) {
  const sent = [];
  const closed = [];
  const created = [];
  const stats = {};
  const ws = {
    readyState: 1,
    send(bytes) { sent.push(bytes.slice()); },
    close(code, reason) { closed.push({ code, reason }); this.readyState = 3; }
  };
  const session = new WsSession(ws, {
    carrier: 'websocket', maxStreams, maxSessionBytes, streamWindow: 65536, maxQueued, dataChunk: 16384
  }, new Uint8Array([1, 2, 3]), {
    heartbeat,
    now,
    stats,
    onTraffic,
    onHeartbeat,
    setIntervalFn,
    createStream(owner, id) {
      const stream = {
        id,
        fed: [],
        credits: [],
        kills: [],
        feed(payload) { this.fed.push(payload.slice()); },
        addCredit(amount) { this.credits.push(amount); },
        kill(notify) {
          this.kills.push(notify);
          owner.streams.delete(id);
          owner.remember(id);
          owner.onStreamClosed(id);
        }
      };
      created.push(stream);
      return stream;
    }
  }, laneId);
  return { session, ws, sent, closed, created, stats };
}

const msg = (...frames) => {
  const parts = frames.map(({ type, id = 1, payload = new Uint8Array() }) => encodeFrame({ type, streamId: id, payload }));
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out.buffer;
};

test('OPEN creates stream; DATA and WINDOW dispatch to it', async () => {
  const x = setup();
  await x.session.handle(msg({ type: FrameType.Open, id: 7 }));
  assert.equal(x.session.streams.size, 1);
  const payload = Uint8Array.of(9, 8, 7);
  const credit = new Uint8Array(4);
  new DataView(credit.buffer).setUint32(0, 1234, false);
  await x.session.handle(msg({ type: FrameType.Data, id: 7, payload }, { type: FrameType.Window, id: 7, payload: credit }));
  assert.deepEqual([...x.created[0].fed[0]], [9, 8, 7]);
  assert.deepEqual(x.created[0].credits, [1234]);
});

test('duplicate OPEN and unknown stream DATA return CLOSE frames', async () => {
  const x = setup();
  await x.session.handle(msg({ type: FrameType.Open, id: 3 }));
  await x.session.handle(msg({ type: FrameType.Open, id: 3 }, { type: FrameType.Data, id: 4, payload: Uint8Array.of(1) }));
  assert.equal(x.sent.length, 2);
  assert.deepEqual(x.sent.map(b => b[0]), [FrameType.Close, FrameType.Close]);
});

test('max stream count rejects new stream with CLOSE', async () => {
  const x = setup({ maxStreams: 1 });
  await x.session.handle(msg({ type: FrameType.Open, id: 1 }, { type: FrameType.Open, id: 2 }));
  assert.equal(x.session.streams.size, 1);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0][0], FrameType.Close);
  assert.equal((x.sent[0][1] << 16) | (x.sent[0][2] << 8) | x.sent[0][3], 2);
});

test('PING echoes PONG; PONG updates watchdog timestamp', async () => {
  let time = 5000;
  const x = setup({ now: () => time });
  const payload = Uint8Array.of(1, 2, 3, 4);
  await x.session.handle(msg({ type: FrameType.Ping, id: 0, payload }));
  assert.equal(x.sent[0][0], FrameType.Pong);
  assert.deepEqual([...x.sent[0].subarray(8)], [1, 2, 3, 4]);
  time = 6000;
  await x.session.handle(msg({ type: FrameType.Pong, id: 0 }));
  assert.equal(x.session.lastPong, 6000);
});

test('invalid control frames and non-binary messages shut down session', async () => {
  for (const input of [msg({ type: FrameType.Open, id: 0 }), msg({ type: FrameType.Ping, id: 0, payload: new Uint8Array(65) }), 'not binary']) {
    const x = setup();
    await x.session.handle(input);
    assert.equal(x.session.closed, true);
    assert.equal(x.closed.at(-1).code, 1011);
  }
});

test('lane rejects cross-lane IDs and permits only one OPEN', async () => {
  const cross = setup({ laneId: 12 });
  await cross.session.handle(msg({ type: FrameType.Open, id: 13 }));
  assert.equal(cross.session.closed, true);

  const reused = setup({ laneId: 12 });
  await reused.session.handle(msg({ type: FrameType.Open, id: 12 }));
  await reused.session.handle(msg({ type: FrameType.Open, id: 12 }));
  assert.equal(reused.session.closed, true);
});

test('tombstones suppress CLOSE for late DATA and are bounded', async () => {
  const x = setup();
  x.session.remember(9);
  await x.session.handle(msg({ type: FrameType.Data, id: 9, payload: Uint8Array.of(1) }));
  assert.equal(x.sent.length, 0);
  for (let id = 1; id <= 4100; id++) x.session.remember(id);
  assert.equal(x.session.tombstones.size, 4096);
  assert.equal(x.session.tombstones.has(9), false);
});

test('dispose kills active streams and decrements active session count once', async () => {
  const x = setup();
  await x.session.handle(msg({ type: FrameType.Open, id: 1 }));
  x.session.dispose();
  x.session.dispose();
  assert.equal(x.created[0].kills.length, 1);
  assert.equal(x.stats.sessionsActive, 0);
  assert.equal(x.session.closed, true);
});

test('lane stream close disposes and closes its WebSocket', async () => {
  const x = setup({ laneId: 12 });
  await x.session.handle(msg({ type: FrameType.Open, id: 12 }));
  x.created[0].kill(false);
  assert.equal(x.session.closed, true);
  assert.deepEqual(x.closed.at(-1), { code: 1000, reason: 'done' });
});

test('session traffic quota shuts down after the configured WebSocket-byte budget is exceeded', async () => {
  const x = setup({ maxSessionBytes: 20 });
  await x.session.handle(msg({ type: FrameType.Ping, id: 0 }));
  assert.equal(x.session.closed, false);
  await x.session.handle(msg({ type: FrameType.Ping, id: 0 }));
  assert.equal(x.session.closed, true);
  assert.equal(x.closed.at(-1).code, 1011);
});

test('WebSocket inbound message queue is bounded before serialized processing catches up', async () => {
  const { session, ws } = setup({ maxQueued: 8 });
  let release;
  session.handle = () => new Promise((resolve) => { release = resolve; });
  session.enqueue(new Uint8Array(8).buffer);
  session.enqueue(new Uint8Array(8).buffer);
  assert.equal(session.closed, true);
  assert.equal(ws.readyState, 3);
  await Promise.resolve();
  release?.();
});


test('incremental quota callback rejects inbound traffic before frame dispatch', async () => {
  const x = setup({ onTraffic: async () => false });
  await x.session.handle(msg({ type: FrameType.Open, id: 9 }));
  assert.equal(x.session.closed, true);
  assert.equal(x.created.length, 0);
  assert.equal(x.closed.at(-1).code, 1011);
});

test('incremental quota callback prevents queued outbound frames from being sent after rejection', async () => {
  const x = setup({ onTraffic: async () => false });
  await x.session.handle(msg({ type: FrameType.Ping, id: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(x.sent.length, 0);
  assert.equal(x.session.closed, true);
  assert.equal(x.closed.at(-1).code, 1011);
});


test('heartbeat closes the session when lease renewal or authorization fails', async () => {
  let tick;
  const x = setup({ heartbeat: true, onHeartbeat: async () => false, setIntervalFn(callback) { tick = callback; return 1; }, });
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(x.session.closed, true);
  assert.equal(x.closed.at(-1).code, 1011);
});

test('websocket-lanes sessions also renew their independent leases', () => {
  let registered = false;
  const x = setup({ laneId: 9, heartbeat: true, setIntervalFn() { registered = true; return 1; } });
  assert.equal(registered, true);
  x.session.dispose();
});


test('outbound WebSocket buffered amount is bounded when quota callbacks are disabled', async () => {
  const x = setup({ maxQueued: 32 });
  x.ws.bufferedAmount = 28;
  await x.session.handle(msg({ type: FrameType.Ping, id: 0 }));
  assert.equal(x.session.closed, true);
  assert.equal(x.closed.at(-1).code, 1011);
});
