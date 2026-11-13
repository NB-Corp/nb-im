import { randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { publicAddress } from '../http-transport.ts';
import type { TelegramBotTransport, TelegramCall } from './contract.ts';
import { abortError } from './contract.ts';

const HOST = 'api.telegram.org';
const RESPONSE_CAP = 2_000_000;

async function pinnedAddress(): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  let addresses: string[];
  try {
    addresses = await Promise.race([
      resolve4(HOST),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('dns_timeout')), 5000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (addresses.length === 0 || addresses.some((ip) => !publicAddress(ip))) {
    throw new Error('unsafe_endpoint');
  }
  return addresses[0]!;
}
function postPinned(ip: string, path: string, body: Buffer, headers: Record<string, string>,
  timeoutMs: number, signal: AbortSignal): Promise<{ http_status: number; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const req = request({ hostname: HOST, family: 4, port: 443, path, method: 'POST', timeout: timeoutMs,
      headers: { ...headers, 'content-length': body.length }, agent: false,
      lookup: (_hostname, _options, callback) => callback(null, ip, 4),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_CAP) req.destroy(new Error('response_too_large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ http_status: res.statusCode ?? 0, raw: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    const onAbort = (): void => { req.destroy(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => { clearTimeout(deadline); signal.removeEventListener('abort', onAbort); reject(error); });
    req.on('close', () => { clearTimeout(deadline); signal.removeEventListener('abort', onAbort); });
    req.end(body);
  });
}
function getPinned(ip: string, path: string, signal: AbortSignal): Promise<{ http_status: number; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const req = request({ hostname: HOST, family: 4, port: 443, path, method: 'GET', timeout: 15_000,
      agent: false, lookup: (_hostname, _options, callback) => callback(null, ip, 4),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024 + 1024) req.destroy(new Error('response_too_large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ http_status: res.statusCode ?? 0, raw: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 15_000);
    const onAbort = (): void => { req.destroy(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => { clearTimeout(deadline); signal.removeEventListener('abort', onAbort); reject(error); });
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}
function encodeForm(json: Record<string, unknown> | undefined, file: TelegramCall['file']): { body: Buffer; headers: Record<string, string> } {
  if (!file) {
    const payload = JSON.stringify(json ?? {});
    return { body: Buffer.from(payload), headers: { 'content-type': 'application/json' } };
  }
  const boundary = `nbim${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(json ?? {})) {
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`));
  }
  const filename = file.filename.replace(/["\r\n]/gu, '_').slice(0, 180) || 'file';
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`));
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
function safeFilePath(filePath: string): boolean {
  return filePath.length > 0 && filePath.length <= 512 && !filePath.includes('..') &&
    !filePath.includes('\\') && !filePath.includes('://') && !filePath.startsWith('/');
}

/** Fixed api.telegram.org client. The bot token stays in the path and is never copied into errors. */
export function createTelegramBotTransport(token: string): TelegramBotTransport {
  return {
    async call(call, signal) {
      const ip = await pinnedAddress();
      const form = encodeForm(call.json, call.file);
      const timeout = call.method === 'getUpdates' ? 35_000 : 15_000;
      const response = await postPinned(ip, `/bot${token}/${call.method}`, form.body, form.headers, timeout, signal);
      let body: unknown = {};
      try { body = JSON.parse(response.raw.toString('utf8')); } catch { body = {}; }
      return { http_status: response.http_status, body };
    },
    async download(filePath, signal) {
      if (!safeFilePath(filePath)) return { ok: false };
      const ip = await pinnedAddress();
      const response = await getPinned(ip, `/file/bot${token}/${filePath}`, signal);
      if (response.http_status !== 200 || response.raw.length === 0) return { ok: false };
      return { ok: true, bytes: response.raw };
    },
  };
}
