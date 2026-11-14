/** Numeric frame values observed in WsSession.handle() in the JavaScript baseline. */
export const FrameType = {
  Open: 0x01,
  Data: 0x02,
  Close: 0x03,
  Window: 0x04,
  Ping: 0x05,
  Pong: 0x06
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface ProtocolFrame {
  /** Kept numeric so unknown values can be parsed and rejected by the state machine. */
  type: number;
  /** 24-bit stream identifier; zero is reserved for session control frames. */
  streamId: number;
  payload: Uint8Array;
}

export type StreamPhase = "header" | "init" | "ready" | "dead";
