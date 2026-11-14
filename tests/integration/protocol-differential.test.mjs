import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { encodeFrame, encodeWindowFrame, decodeFrameBatch } from '../../src/protocol/frame.ts';
import { identifyObfuscated2Transport, isSafeDcHeaderPrefix, parseObfuscated2Tail } from '../../src/protocol/obfuscated2.ts';
import { FrameType } from '../../src/types/protocol.ts';

const baseline = await readFile(new URL('../../worker.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `baseline function ${name} must exist`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `baseline function ${name} must have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated baseline function ${name}`);
}

const oracleSource = [
  extractFunction(baseline, 'frame'),
  extractFunction(baseline, 'windowFrame'),
  extractFunction(baseline, 'tagKind'),
  extractFunction(baseline, 'safeDcHeaderPrefix'),
  'globalThis.oracle = { frame, windowFrame, tagKind, safeDcHeaderPrefix };'
].join('\n');
const oracleContext = vm.createContext({ Uint8Array, DataView });
vm.runInContext(oracleSource, oracleContext, { timeout: 1000 });
const oracle = oracleContext.oracle;

const toArray = (bytes) => Array.from(bytes);

test('TypeScript frame encoding matches the original JavaScript baseline byte-for-byte', () => {
  const vectors = [
    { type: 1, streamId: 1, payload: Uint8Array.of() },
    { type: 2, streamId: 0x123456, payload: Uint8Array.of(0, 1, 0x7f, 0x80, 0xff) },
    { type: 6, streamId: 0, payload: Uint8Array.from({ length: 32 }, (_, i) => i * 7 & 0xff) },
    { type: 0xfe, streamId: 0xffffff, payload: Uint8Array.of(0xaa) }
  ];
  for (const vector of vectors) {
    const expected = oracle.frame(vector.type, vector.streamId, vector.payload);
    const actual = encodeFrame(vector);
    assert.deepEqual(toArray(actual), toArray(expected));
    const decoded = decodeFrameBatch(actual);
    assert.equal(decoded[0].type, vector.type);
    assert.equal(decoded[0].streamId, vector.streamId);
    assert.deepEqual(toArray(decoded[0].payload), toArray(vector.payload));
  }
});

test('TypeScript WINDOW frame matches the original JavaScript baseline byte-for-byte', () => {
  for (const [streamId, credit] of [[1, 64], [0x123456, 0x01020304], [0xffffff, 0xffffffff]]) {
    assert.deepEqual(
      toArray(encodeWindowFrame(streamId, credit)),
      toArray(oracle.windowFrame(streamId, credit)),
    );
  }
});

test('TypeScript Obfuscated2 tag and DC parsing matches the baseline rules', () => {
  const cases = [
    [0xef, 0xef, 0xef, 0xef, 2, 0, 0, 0],
    [0xee, 0xee, 0xee, 0xee, 3, 0, 0, 0],
    [0xdd, 0xdd, 0xdd, 0xdd, 5, 0, 0, 0],
    [0, 0, 0, 0, 0xff, 0xff, 0, 0],
  ];
  for (const vector of cases) {
    const tail = Uint8Array.from(vector);
    const baselineKind = oracle.tagKind(tail.subarray(0, 4));
    const parsed = parseObfuscated2Tail(tail);
    assert.equal(parsed.transport, baselineKind);
    assert.equal(parsed.dcId, new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getInt16(4, true));
    assert.equal(parsed.dcKey, Math.abs(parsed.dcId));
    assert.equal(identifyObfuscated2Transport(tail.subarray(0, 4)), baselineKind);
  }
});

test('TypeScript outbound DC header exclusions match the original JavaScript baseline', () => {
  const prefixes = [
    [0xef, 1, 2, 3, 4, 5, 6, 7],
    [1, 2, 3, 4, 0, 0, 0, 0],
    [0x47, 0x45, 0x54, 0x20, 1, 2, 3, 4],
    [0x50, 0x4f, 0x53, 0x54, 1, 2, 3, 4],
    [0x48, 0x45, 0x41, 0x44, 1, 2, 3, 4],
    [0x4f, 0x50, 0x54, 0x49, 1, 2, 3, 4],
    [0xee, 0xee, 0xee, 0xee, 1, 2, 3, 4],
    [0xdd, 0xdd, 0xdd, 0xdd, 1, 2, 3, 4],
    [0x16, 0x03, 0x01, 0x02, 1, 2, 3, 4],
    [0x12, 0x34, 0x56, 0x78, 1, 2, 3, 4],
  ];
  for (const prefix of prefixes) {
    const bytes = Uint8Array.from(prefix);
    assert.equal(isSafeDcHeaderPrefix(bytes), oracle.safeDcHeaderPrefix(bytes));
  }
});

// Keep the enum import live as a guard against accidental frame-number drift.
assert.equal(FrameType.Open, 1);
