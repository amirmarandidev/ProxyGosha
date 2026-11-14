import { connect } from "cloudflare:sockets";
import { createWorker, type WorkerPlatform } from "./worker.ts";
import type { TcpConnect } from "./stream/tcp-stream.ts";
import type { WorkerWebSocket } from "./runtime/websocket-transport.ts";

const platform: WorkerPlatform = {
  connect: connect as unknown as TcpConnect,
  createWebSocketPair() {
    const Pair = (globalThis as typeof globalThis & {
      WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };
    }).WebSocketPair;
    const pair = new Pair();
    return [pair[0], pair[1] as unknown as WorkerWebSocket];
  },
  createUpgradeResponse(client, protocol) {
    return new Response(null, {
      status: 101,
      webSocket: client as WebSocket,
      headers: { "Sec-WebSocket-Protocol": protocol },
    } as ResponseInit & { webSocket: WebSocket });
  },
};

export default createWorker(platform);

export { ProxyGoshaControlPlane } from "./observability/control-plane.ts";
