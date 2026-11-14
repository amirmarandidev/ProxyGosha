declare module "cloudflare:sockets" {
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface SocketOptions {
    secureTransport: "off" | "on" | "starttls";
  }
  interface Socket {
    opened: Promise<unknown>;
    closed: Promise<unknown>;
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
