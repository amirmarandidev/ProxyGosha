import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFrameBatch,
  encodeFrame,
  encodeWindowFrame,
  FrameDecodeError,
  MAX_FRAMES_PER_MESSAGE,
  MAX_FRAME_PAYLOAD_BYTES,
} from "../../src/protocol/frame.ts";
import {
  identifyObfuscated2Transport,
  isSafeDcHeaderPrefix,
  Obfuscated2Transport,
  parseObfuscated2Tail,
} from "../../src/protocol/obfuscated2.ts";
import { FrameType } from "../../src/types/protocol.ts";

const bytes = (...values) => Uint8Array.from(values);

test("frame encoding preserves the 8-byte wire header and big-endian fields", () => {
  const encoded = encodeFrame({ type: FrameType.Data, streamId: 0x123456, payload: bytes(1, 2, 3) });
  assert.deepEqual([...encoded], [2, 0x12, 0x34, 0x56, 0, 0, 0, 3, 1, 2, 3]);
});

test("frame batch decoder handles concatenated frames and subarray offsets", () => {
  const first = encodeFrame({ type: FrameType.Open, streamId: 7, payload: new Uint8Array() });
  const second = encodeFrame({ type: FrameType.Data, streamId: 7, payload: bytes(9, 8) });
  const joined = new Uint8Array(first.length + second.length + 4);
  joined.set(first, 2);
  joined.set(second, 2 + first.length);
  const decoded = decodeFrameBatch(joined.subarray(2, joined.length - 2));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].type, FrameType.Open);
  assert.equal(decoded[0].streamId, 7);
  assert.deepEqual([...decoded[1].payload], [9, 8]);
});

test("unknown frame types remain parseable for state-machine rejection", () => {
  const decoded = decodeFrameBatch(encodeFrame({ type: 0x7f, streamId: 1, payload: new Uint8Array() }));
  assert.equal(decoded[0].type, 0x7f);
});

test("window frame encodes a big-endian 32-bit credit", () => {
  assert.deepEqual([...encodeWindowFrame(0x010203, 0x10203040)], [4, 1, 2, 3, 0, 0, 0, 4, 0x10, 0x20, 0x30, 0x40]);
});

test("frame decoder rejects empty, truncated, oversized, and over-count batches", () => {
  assert.throws(() => decodeFrameBatch(new Uint8Array()), FrameDecodeError);
  assert.throws(() => decodeFrameBatch(bytes(1, 2, 3)), FrameDecodeError);
  const badLength = bytes(2, 0, 0, 1, 0, 0, 0x10, 0x01);
  assert.throws(() => decodeFrameBatch(badLength), FrameDecodeError);
  const tooLarge = new Uint8Array(8 + MAX_FRAME_PAYLOAD_BYTES + 1);
  tooLarge[0] = FrameType.Data;
  new DataView(tooLarge.buffer).setUint32(4, MAX_FRAME_PAYLOAD_BYTES + 1, false);
  assert.throws(() => decodeFrameBatch(tooLarge), FrameDecodeError);
  const many = new Uint8Array(MAX_FRAMES_PER_MESSAGE * 8 + 8);
  for (let offset = 0; offset < many.length; offset += 8) new DataView(many.buffer).setUint32(offset + 4, 0, false);
  assert.throws(() => decodeFrameBatch(many), FrameDecodeError);
});

test("frame encoder rejects values outside the wire field widths", () => {
  assert.throws(() => encodeFrame({ type: 1, streamId: 0x1000000, payload: new Uint8Array() }), RangeError);
  assert.throws(() => encodeWindowFrame(1, -1), RangeError);
});

test("Obfuscated2 tags identify all supported transport modes", () => {
  assert.equal(identifyObfuscated2Transport(bytes(0xef, 0xef, 0xef, 0xef)), Obfuscated2Transport.Abridged);
  assert.equal(identifyObfuscated2Transport(bytes(0xee, 0xee, 0xee, 0xee)), Obfuscated2Transport.Intermediate);
  assert.equal(identifyObfuscated2Transport(bytes(0xdd, 0xdd, 0xdd, 0xdd)), Obfuscated2Transport.PaddedIntermediate);
  assert.equal(identifyObfuscated2Transport(bytes(0, 0, 0, 0)), Obfuscated2Transport.Unknown);
});

test("Obfuscated2 tail parses signed little-endian DC IDs", () => {
  assert.deepEqual(parseObfuscated2Tail(bytes(0xef, 0xef, 0xef, 0xef, 2, 0, 0, 0)), {
    transport: Obfuscated2Transport.Abridged,
    dcId: 2,
    dcKey: 2,
  });
  assert.deepEqual(parseObfuscated2Tail(bytes(0xee, 0xee, 0xee, 0xee, 0xfe, 0xff, 0, 0)), {
    transport: Obfuscated2Transport.Intermediate,
    dcId: -2,
    dcKey: 2,
  });
  assert.throws(() => parseObfuscated2Tail(bytes(1, 2, 3)), RangeError);
});

test("DC header prefix rejects protocol signatures and zero suffix", () => {
  assert.equal(isSafeDcHeaderPrefix(bytes(0x47, 0x45, 0x54, 0x20, 1, 2, 3, 4)), false);
  assert.equal(isSafeDcHeaderPrefix(bytes(1, 2, 3, 4, 0, 0, 0, 0)), false);
  assert.equal(isSafeDcHeaderPrefix(bytes(0x12, 0x34, 0x56, 0x78, 1, 2, 3, 4)), true);
  assert.throws(() => isSafeDcHeaderPrefix(bytes(1, 2, 3)), RangeError);
});

test('frame encoder rejects payloads larger than the decoder protocol limit', async () => {
  assert.throws(() => encodeFrame({ type: FrameType.Data, streamId: 1, payload: new Uint8Array(1_048_577) }), /protocol limit/);
});


test('frame decoder returns zero-copy payload views into the original WebSocket message', async () => {
  const { encodeFrame, decodeFrameBatch } = await import('../../src/protocol/frame.ts');
  const message = encodeFrame({ type: 2, streamId: 7, payload: Uint8Array.of(1, 2, 3, 4) });
  const [frame] = decodeFrameBatch(message);
  assert.equal(frame.payload.buffer, message.buffer);
  assert.equal(frame.payload.byteOffset, message.byteOffset + 8);
});
