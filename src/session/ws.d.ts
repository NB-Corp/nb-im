declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  export class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    constructor(url: string, options?: { headers?: Record<string, string>; handshakeTimeout?: number });
    send(data: string): void;
    ping(): void;
    terminate(): void;
    close(): void;
    once(event: 'open', listener: () => void): void;
    once(event: 'close', listener: () => void): void;
    once(event: 'error', listener: () => void): void;
    on(event: 'message', listener: (data: Buffer | string | ArrayBuffer) => void): void;
    on(event: 'close', listener: () => void): void;
    on(event: 'error', listener: () => void): void;
    on(event: 'pong', listener: () => void): void;
  }
  export class WebSocketServer {
    constructor(options: { host: string; port: number });
    once(event: 'listening', listener: () => void): void;
    once(event: 'error', listener: () => void): void;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): void;
    close(): void;
    address(): { port: number } | string | null;
  }
}
