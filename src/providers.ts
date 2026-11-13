import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import type { Provider, ProviderContext, SendResult } from './contracts.ts';
import { publicAddress } from './http-transport.ts';

const failed = (kind: SendResult['error_kind'], code: string): SendResult =>
  ({ status: 'failed', message_ids: [], retryable: false,
    error_kind: kind, diagnostic_code: code });
const unknown = (code: string): SendResult =>
  ({ status: 'unknown', message_ids: [], retryable: false,
    error_kind: 'unknown', diagnostic_code: code });
type Permit = ProviderContext['beginDispatch'];
function denied(outcome: ReturnType<Permit>): SendResult {
  return failed('configuration', outcome === 'expired' ? 'delivery_expired' : 'dispatch_stale');
}
export interface TelegramTransport {
  // Every transport must check the permit synchronously after DNS/preflight, before HTTP dispatch.
  post(token: string, payload: string, permit: Permit):
    Promise<{ status: number; body: string } | { blocked: 'expired' | 'stale' }>;
}
type OfficialHost = 'api.telegram.org' | 'qyapi.weixin.qq.com';
async function postOfficial(host: OfficialHost, path: string, payload: string, permit: Permit) {
  let timer: NodeJS.Timeout | undefined;
  let addresses: string[];
  try {
    addresses = await Promise.race([
      resolve4(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('dns_timeout')), 5000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (addresses.length === 0 || addresses.some((ip) => !publicAddress(ip))) {
    throw new Error('unsafe_endpoint');
  }
  const approval = permit();
  if (approval !== 'ready') return { blocked: approval } as const;
  const ip = addresses[0]!;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: host, family: 4, port: 443, path, method: 'POST', timeout: 15_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      agent: false, // Do not reuse a socket bound to an earlier DNS resolution.
      lookup: (_hostname, _options, callback) => callback(null, ip, 4),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 65_536) req.destroy(new Error('response_too_large'));
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 15_000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => { clearTimeout(deadline); reject(error); });
    req.on('close', () => clearTimeout(deadline));
    req.end(payload);
  });
}
export const telegramHttps: TelegramTransport = {
  post: (token, payload, permit) => postOfficial('api.telegram.org',
    `/bot${token}/sendMessage`, payload, permit),
};
export const wecomHttps = {
  post: (key: string, payload: string, permit: Permit) => postOfficial('qyapi.weixin.qq.com',
    `/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`, payload, permit),
};
export function telegramProvider(transport: TelegramTransport = telegramHttps): Provider {
  return { id: 'telegram', async send(context) {
    let token: string;
    try { token = context.resolveCredential(context.instance.options.token_slot as string); }
    catch { return failed('configuration', 'credential_unavailable'); }
    if (!/^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u.test(token)) {
      return failed('auth', 'telegram_auth');
    }
    const target = context.target;
    const payload = JSON.stringify({ chat_id: target.chat_id,
      ...(target.message_thread_id === undefined ? {} : { message_thread_id: target.message_thread_id }),
      text: context.text, disable_web_page_preview: true });
    let response;
    try { response = await transport.post(token, payload, context.beginDispatch); }
    catch { return unknown('telegram_transport_unknown'); }
    if ('blocked' in response) return denied(response.blocked);
    let data: unknown;
    try { data = JSON.parse(response.body); } catch { return unknown('telegram_invalid_response'); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return unknown('telegram_invalid_response');
    }
    const answer = data as Record<string, unknown>;
    if (answer.ok === true && response.status === 200) {
      const result = answer.result as Record<string, unknown> | undefined;
      const mid = result?.message_id;
      return { status: 'accepted', message_ids: Number.isSafeInteger(mid) ? [String(mid)] : [],
        retryable: false };
    }
    if (answer.ok === false) {
      const code = typeof answer.error_code === 'number' ? answer.error_code : response.status;
      if (code === 401) return failed('auth', 'telegram_auth');
      if (code === 403) return failed('forbidden', 'telegram_forbidden');
      if (code === 400) return failed('bad_format', 'telegram_bad_request');
      if (code === 404) return failed('not_found', 'telegram_not_found');
      // 429/5xx may follow side effects; no Telegram idempotency key is available.
      return unknown(code === 409 ? 'telegram_conflict' : 'telegram_response_unknown');
    }
    return unknown('telegram_response_unknown');
  } };
}
export interface ToastHost {
  // The host may perform async preflight, but must call permit immediately before OS dispatch.
  show(input: { text: string; activation: 'open_app'; permit: Permit }): Promise<void | 'expired' | 'stale'>;
}
export function windowsToastProvider(host: ToastHost): Provider {
  return { id: 'windows_toast', async send(context) {
    const approval = context.canDispatch();
    if (approval !== 'ready') return denied(approval);
    try {
      const result = await host.show({ text: context.text, activation: 'open_app',
        permit: context.beginDispatch });
      if (result === 'expired' || result === 'stale') return denied(result);
      return { status: 'accepted', message_ids: [], retryable: false };
    } catch { return unknown('toast_host_unknown'); }
  } };
}
export { scriptProvider } from './script.ts';
export type { ScriptApproval } from './script.ts';
