import type { Provider, ProviderContext, SendResult } from './contracts.ts';

// Minimal official WeCom group-robot mapping adapted from the reviewed nb-message
// WeCom outbound contract (Apache-2.0); this is not its server/UI, nor inbound.
export interface WecomTransport {
  post(key: string, payload: string, permit: ProviderContext['beginDispatch']):
    Promise<{ status: number; body: string } | { blocked: 'expired' | 'stale' }>;
}
const failed = (code: string): SendResult => ({ status: 'failed', message_ids: [],
  retryable: false, error_kind: 'configuration', diagnostic_code: code });
const unknown = (code: string): SendResult => ({ status: 'unknown', message_ids: [],
  retryable: false, error_kind: 'unknown', diagnostic_code: code });
export function wecomWebhookProvider(transport: WecomTransport): Provider {
  return { id: 'wecom_webhook', async send(context) {
    let key: string;
    try { key = context.resolveCredential(context.instance.options.key_slot as string); }
    catch { return failed('credential_unavailable'); }
    if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(key)) return failed('wecom_invalid_key');
    const payload = JSON.stringify({ msgtype: 'text', text: { content: context.text } });
    let response;
    try { response = await transport.post(key, payload, context.beginDispatch); }
    catch { return unknown('wecom_transport_unknown'); }
    if ('blocked' in response) return failed(response.blocked === 'expired' ?
      'delivery_expired' : 'dispatch_stale');
    if (response.status !== 200) return unknown('wecom_response_unknown');
    let body: unknown;
    try { body = JSON.parse(response.body); } catch { return unknown('wecom_invalid_response'); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return unknown('wecom_invalid_response');
    }
    const code = (body as Record<string, unknown>).errcode;
    if (code === 0) return { status: 'accepted', message_ids: [], retryable: false };
    // Official global errors identify these codes, but no webhook idempotency key exists.
    if (code === 45009) return { status: 'failed', message_ids: [], retryable: false,
      error_kind: 'rate_limited', diagnostic_code: 'wecom_rate_limited' };
    if (code === -1) return { status: 'unknown', message_ids: [], retryable: false,
      error_kind: 'transient', diagnostic_code: 'wecom_busy_unknown' };
    // Do not infer webhook-key errors from unrelated access_token API codes or errmsg.
    return typeof code === 'number' && Number.isSafeInteger(code) ?
      unknown('wecom_rejected_unknown') : unknown('wecom_invalid_response');
  } };
}
