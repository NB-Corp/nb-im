import type { WechatHttpResponse, WechatTransport } from './contract.ts';
import { abortError, isAbort } from './contract.ts';

const GETUPDATES_MS = 35_000;
const CALL_MS = 15_000;
const BYTE_CAP = 100 * 1024 * 1024;

export function wechatUrlAllowed(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  return host === 'ilinkai.weixin.qq.com' || host.endsWith('.weixin.qq.com');
}
async function timed(url: string, init: RequestInit, timeoutMs: number, signal: AbortSignal,
  emptyOnTimeout: boolean): Promise<WechatHttpResponse> {
  if (!wechatUrlAllowed(url)) return { status: 0, body: '' };
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) return { status: 0, body: '' };
    const encrypted = response.headers.get('x-encrypted-param') ?? undefined;
    const body = response.status === 200 ? await response.text() : '';
    return { status: response.status, body, ...(encrypted ? { headers: { 'x-encrypted-param': encrypted } } : {}) };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (emptyOnTimeout && (isAbort(error) || controller.signal.aborted)) {
      return { status: 200, body: '{"ret":0,"msgs":[]}' };
    }
    return { status: 0, body: '' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export function createWechatTransport(): WechatTransport {
  return {
    post(url, headers, body, signal) {
      const updates = url.includes('/getupdates');
      return timed(url, { method: 'POST', headers, body }, updates ? GETUPDATES_MS : CALL_MS, signal, updates);
    },
    async postBytes(url, headers, body, signal) {
      const response = await timed(url, { method: 'POST', headers, body: Buffer.from(body) }, CALL_MS, signal, false);
      if (response.status !== 200) return { status: response.status, body: '' };
      return response;
    },
    async getBytes(url, signal) {
      if (!wechatUrlAllowed(url)) return { status: 0, body: new Uint8Array() };
      if (signal.aborted) throw abortError();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_MS);
      const onAbort = (): void => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' });
        if (response.status !== 200 || !response.body) {
          return { status: response.status === 200 ? 0 : response.status, body: new Uint8Array() };
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          total += step.value.byteLength;
          if (total > BYTE_CAP) {
            await reader.cancel().catch(() => undefined);
            return { status: 0, body: new Uint8Array() };
          }
          chunks.push(step.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { status: 200, body: bytes };
      } catch (error) {
        if (signal.aborted) throw abortError();
        return { status: 0, body: new Uint8Array() };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
