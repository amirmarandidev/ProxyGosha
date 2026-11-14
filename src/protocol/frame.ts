import { FrameType, type ProtocolFrame } from "../types/protocol.ts";

export const FRAME_HEADER_BYTES = 8;
export const MAX_FRAME_PAYLOAD_BYTES = 1_048_576;
export const MAX_MESSAGE_BYTES = 16_777_216;
export const MAX_FRAMES_PER_MESSAGE = 4096;

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

/** Encode the 8-byte big-endian frame header used by the Worker bridge. */
export function encodeFrame(frame: ProtocolFrame): Uint8Array {
  const { type, streamId, payload } = frame;
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new RangeError("Frame type must fit in one byte");
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffff) {
    throw new RangeError("Stream ID must fit in 24 bits");
  }
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new RangeError("Frame payload exceeds the protocol limit");
  }

  const output = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  output[0] = type;
  output[1] = (streamId >>> 16) & 0xff;
  output[2] = (streamId >>> 8) & 0xff;
  output[3] = streamId & 0xff;
  const length = payload.byteLength;
  output[4] = (length >>> 24) & 0xff;
  output[5] = (length >>> 16) & 0xff;
  output[6] = (length >>> 8) & 0xff;
  output[7] = length & 0xff;
  output.set(payload, FRAME_HEADER_BYTES);
  return output;
}

export function encodeWindowFrame(streamId: number, credit: number): Uint8Array {
  if (!Number.isInteger(credit) || credit < 0 || credit > 0xffffffff) {
    throw new RangeError("Window credit must fit in an unsigned 32-bit integer");
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, credit, false);
  return encodeFrame({ type: FrameType.Window, streamId, payload });
}

/**
 * Decode all concatenated frames in one WebSocket message.
 * Unknown frame types are retained as numeric values so the session state
 * machine can reject them at the same point as the JavaScript baseline.
 */
export function decodeFrameBatch(message: Uint8Array): ProtocolFrame[] {
  if (message.byteLength === 0 || message.byteLength > MAX_MESSAGE_BYTES) {
    throw new FrameDecodeError("Invalid WebSocket message size");
  }

  const frames: ProtocolFrame[] = [];
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  let offset = 0;

  while (offset < message.byteLength) {
    if (message.byteLength - offset < FRAME_HEADER_BYTES || frames.length + 1 > MAX_FRAMES_PER_MESSAGE) {
      throw new FrameDecodeError("Truncated frame header or too many frames");
    }

    const type = message[offset];
    const streamId = (message[offset + 1] << 16) | (message[offset + 2] << 8) | message[offset + 3];
    const payloadLength = view.getUint32(offset + 4, false);
    const payloadStart = offset + FRAME_HEADER_BYTES;
    const end = payloadStart + payloadLength;

    if (payloadLength > MAX_FRAME_PAYLOAD_BYTES || end > message.byteLength) {
      throw new FrameDecodeError("Invalid frame payload length");
    }

    frames.push({ type: type as FrameType, streamId, payload: message.subarray(payloadStart, end) });
    offset = end;
  }

  return frames;
}
