import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { publicAddress } from '../http-transport.ts';
import type { OneBotLink, OneBotTransport } from './contract.ts';
import { abortError } from './contract.ts';

const DOWNLOAD_CAP = 100 * 1024 * 1024;

function roleFromPath(url: string): OneBotLink['role'] {
  let path = '/';
  try { path = new URL(url).pathname; } catch { path = url; }
  if (path === '/api' || path === '/api/') return 'api';
  if (path === '/event' || path === '/event/') return 'event';
  return 'universal';
}
function roleFromHeader(value: string | undefined, url: string): OneBotLink['role'] {
  const role = value?.trim().toLowerCase();
  if (role === 'api') return 'api';
  if (role === 'event') return 'event';
  if (role === 'universal') return 'universal';
  return roleFromPath(url);
}
interface OneBotWsOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}
function linkFrom(socket: WebSocket, role: OneBotLink['role'], options: OneBotWsOptions): OneBotLink {
  const frames: Array<(frame: unknown) => void> = [];
  const closes: Array<() => void> = [];
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
  let stopped = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  const clearWatchdog = (): void => {
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    if (pongTimer !== undefined) clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
  };
  const fail = (): void => {
    if (stopped) return;
    stopped = true;
    clearWatchdog();
    socket.terminate();
  };
  const armPing = (): void => {
    if (stopped || pingTimer !== undefined || pongTimer !== undefined) return;
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      if (stopped) return;
      if (socket.readyState !== WebSocket.OPEN) { fail(); return; }
      pongTimer = setTimeout(fail, pongTimeoutMs);
      try { socket.ping(); } catch { fail(); }
    }, pingIntervalMs);
  };
  socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
    try {
      const frame = JSON.parse(text) as unknown;
      for (const handler of frames) handler(frame);
    } catch { /* Ignore a frame that is not JSON. */ }
  });
  socket.on('pong', () => {
    if (stopped) return;
    if (pongTimer !== undefined) clearTimeout(pongTimer);
    pongTimer = undefined;
    armPing();
  });
  socket.on('close', () => {
    stopped = true;
    clearWatchdog();
    for (const handler of closes) handler();
  });
  socket.on('error', fail);
  armPing();
  return {
    role,
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    },
    onFrame(handler) { frames.push(handler); },
    onClose(handler) { closes.push(handler); },
    close: fail,
  };
}
async function publicMedia(url: URL, signal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
    return { ok: false };
  }
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: string[];
  if (isIP(literal)) addresses = [literal];
  else {
    const answers = await Promise.allSettled([resolve4(literal), resolve6(literal)]);
    addresses = answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value : []);
  }
  if (addresses.length === 0 || addresses.some((ip) => !publicAddress(ip))) return { ok: false };
  const ip = addresses[0]!;
  const family = isIP(ip) === 6 ? 6 : 4;
  const request = url.protocol === 'https:' ? https.request : http.request;
  return new Promise((resolve) => {
    const req = request({ hostname: literal, servername: literal, path: `${url.pathname}${url.search}`,
      method: 'GET', timeout: 15_000, agent: false,
      lookup: (_hostname, _options, callback) => callback(null, ip, family),
    }, (res) => {
      if ((res.statusCode ?? 0) !== 200) { res.resume(); resolve({ ok: false }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > DOWNLOAD_CAP) req.destroy();
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(size > DOWNLOAD_CAP ? { ok: false } : { ok: true, bytes: Buffer.concat(chunks) }));
    });
    const onAbort = (): void => { req.destroy(); };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => resolve({ ok: false }));
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.end();
  });
}

export function createOneBotWsTransport(options: OneBotWsOptions = {}): OneBotTransport {
  return {
    async connect(input) {
      if (input.signal.aborted) throw abortError();
      const socket = new WebSocket(input.url, { headers: input.headers, handshakeTimeout: 15_000 });
      const abort = (): void => socket.terminate();
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', () => reject(new Error('onebot_connect_failed')));
        });
      } catch (error) {
        socket.terminate();
        throw error;
      }
      return linkFrom(socket, roleFromPath(input.url), options);
    },
    async listen(input) {
      if (input.host === '0.0.0.0' || input.host === '::' || input.host === '[::]') {
        throw new Error('onebot_listen_rejected');
      }
      const server = new WebSocketServer({ host: input.host, port: input.port });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('listening', () => resolve());
          server.once('error', () => reject(new Error('onebot_listen_failed')));
        });
      } catch (error) {
        server.close();
        throw error;
      }
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : input.port;
      const stop = (): void => { server.close(); };
      if (input.signal.aborted) stop();
      else input.signal.addEventListener('abort', stop, { once: true });
      server.on('connection', (socket, request) => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        const url = request.url ?? '/';
        if (!input.authorize(headers, url)) { socket.close(); return; }
        input.accept(linkFrom(socket, roleFromHeader(headers['x-client-role'], url), options));
      });
      return { port };
    },
    download: (url, signal) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return Promise.resolve({ ok: false }); }
      return publicMedia(parsed, signal);
    },
  };
}
