import { createHmac } from 'node:crypto';
import type { Provider, ProviderContext, ProviderId, SendResult } from './contracts.ts';
import { safeHttpTransport, validateHttpEndpoint, type OutboundHttpRequest,
  type OutboundHttpTransport } from './http-transport.ts';

const failure = (kind: SendResult['error_kind'], code: string): SendResult => ({
  status: 'failed', message_ids: [], retryable: false, error_kind: kind, diagnostic_code: code,
});
const unknown = (code: string, kind: SendResult['error_kind'] = 'unknown'): SendResult => ({
  status: 'unknown', message_ids: [], retryable: false, error_kind: kind, diagnostic_code: code,
});
const accepted = (): SendResult => ({ status: 'accepted', message_ids: [], retryable: false });
function credential(context: ProviderContext, option: string, pattern: RegExp): string {
  const value = context.resolveCredential(context.instance.options[option] as string);
  if (!pattern.test(value)) throw new Error('invalid_credential');
  return value;
}
function responseStatus(status: number): SendResult {
  if (status === 401) return failure('auth', 'webhook_auth');
  if (status === 403) return failure('forbidden', 'webhook_forbidden');
  if (status === 404) return failure('not_found', 'webhook_not_found');
  // Rate limits, redirects and server errors may have followed partial side effects.
  return unknown(status === 429 ? 'webhook_rate_limited_unknown' : 'webhook_response_unknown',
    status === 429 ? 'rate_limited' : 'unknown');
}
function jsonCode(body: string, name: 'errcode' | 'code'): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    }
  } catch { /* never return raw downstream text */ }
  return null;
}
function xml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;',
    '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
function build(context: ProviderContext, now: () => number): OutboundHttpRequest {
  const id: ProviderId = context.instance.provider_id;
  const options = context.instance.options;
  if (id === 'discord_webhook') {
    const token = credential(context, 'token_slot', /^[A-Za-z0-9._-]{16,256}$/u);
    return { url: `https://discord.com/api/webhooks/${options.webhook_id}/${token}`,
      body: JSON.stringify({ content: context.text, allowed_mentions: { parse: [] } }),
      content_type: 'application/json' };
  }
  if (id === 'slack_webhook') {
    const path = credential(context, 'path_slot', /^[A-Za-z0-9_-]{2,128}\/[A-Za-z0-9_-]{2,128}\/[A-Za-z0-9_-]{8,256}$/u);
    return { url: `https://hooks.slack.com/services/${path}`,
      body: JSON.stringify({ text: context.text }), content_type: 'application/json' };
  }
  if (id === 'dingtalk_webhook') {
    const token = credential(context, 'token_slot', /^[A-Za-z0-9_-]{16,256}$/u);
    const text = options.keyword ? `${options.keyword} ${context.text}` : context.text;
    const parameters = new URLSearchParams({ access_token: token });
    if (options.secret_slot) {
      const secret = credential(context, 'secret_slot', /^[A-Za-z0-9_+=/-]{8,256}$/u);
      const timestamp = String(now());
      const signature = createHmac('sha256', secret).update(`${timestamp}\n${secret}`)
        .digest('base64');
      parameters.set('timestamp', timestamp); parameters.set('sign', signature);
    }
    return { url: `https://oapi.dingtalk.com/robot/send?${parameters}`,
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      content_type: 'application/json' };
  }
  if (id === 'feishu_webhook') {
    const token = credential(context, 'token_slot', /^[A-Za-z0-9_-]{16,256}$/u);
    const payload: Record<string, unknown> = { msg_type: 'text',
      content: { text: context.text } };
    if (options.secret_slot) {
      const secret = credential(context, 'secret_slot', /^[A-Za-z0-9_+=/-]{8,256}$/u);
      const timestamp = String(Math.floor(now() / 1000));
      // Feishu signs an empty message with timestamp + newline + secret as the HMAC key.
      payload.timestamp = timestamp;
      payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
    }
    return { url: `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`,
      body: JSON.stringify(payload), content_type: 'application/json' };
  }
  if (id === 'http') {
    const endpoint = validateHttpEndpoint(options.endpoint as string,
      options.private_grant as OutboundHttpRequest['private_grant']);
    if (endpoint.pathname !== '/' || endpoint.search ||
        ((options.path_slot !== undefined || options.auth_slot !== undefined) &&
          endpoint.protocol !== 'https:')) throw new Error('invalid_http_endpoint');
    if (options.path_slot) {
      // Treat the *entire* non-root path as secret, including ordinary-looking prefixes.
      const path = credential(context, 'path_slot', /^[A-Za-z0-9._~-]{1,128}(?:\/[A-Za-z0-9._~-]{1,128}){0,15}$/u);
      const segments = path.split('/');
      if (segments.some((segment) => segment === '.' || segment === '..')) {
        throw new Error('invalid_http_path');
      }
      endpoint.pathname = '/' + segments.map(encodeURIComponent).join('/');
    }
    const format = options.format;
    const body = format === 'form' ? new URLSearchParams({ text: context.text,
      category: context.category }).toString() : format === 'xml' ?
      `<notification><text>${xml(context.text)}</text><category>${context.category}</category></notification>` :
      JSON.stringify({ text: context.text, category: context.category });
    const authorization = options.auth_slot ? `Bearer ${credential(context, 'auth_slot',
      /^[A-Za-z0-9._~+/-]{1,1024}$/u)}` : undefined;
    return { url: endpoint.href, body,
      content_type: format === 'form' ? 'application/x-www-form-urlencoded' :
        format === 'xml' ? 'application/xml' : 'application/json',
      ...(authorization ? { authorization } : {}),
      ...(options.private_grant ? { private_grant: options.private_grant as
        OutboundHttpRequest['private_grant'] } : {}) };
  }
  throw new Error('unsupported_provider');
}
export type WebhookProviderId = 'discord_webhook' | 'slack_webhook' | 'dingtalk_webhook' |
  'feishu_webhook' | 'http';
export function webhookProvider(id: WebhookProviderId,
  transport: OutboundHttpTransport = safeHttpTransport,
  now: () => number = Date.now): Provider {
  return { id, async send(context) {
    if (context.instance.provider_id !== id) return failure('configuration', 'webhook_configuration');
    let request: OutboundHttpRequest;
    try { request = build(context, now); }
    catch { return failure('configuration', 'webhook_configuration'); }
    let response;
    try { response = await transport.post(request, context.beginDispatch); }
    catch { return unknown('webhook_transport_unknown'); }
    if ('blocked' in response) return failure('configuration',
      response.blocked === 'expired' ? 'delivery_expired' : 'dispatch_stale');
    if (id === 'http') return response.status >= 200 && response.status < 300 ? accepted() :
      responseStatus(response.status);
    // wait=false has a documented no-content success. An unexpected 200 is not proof.
    if (id === 'discord_webhook') return response.status === 204 ?
      accepted() : responseStatus(response.status);
    if (id === 'slack_webhook') return response.status === 200 && response.body.trim() === 'ok' ?
      accepted() : responseStatus(response.status);
    if (response.status !== 200) return responseStatus(response.status);
    const code = jsonCode(response.body, id === 'dingtalk_webhook' ? 'errcode' : 'code');
    return code === 0 ? accepted() : unknown(code === null ?
      'webhook_invalid_response' : 'webhook_rejected_unknown');
  } };
}
