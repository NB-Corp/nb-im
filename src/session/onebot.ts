import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { OneBotLink, OneBotTransport, SessionAccount, SessionAdapter, SessionCursorStore,
  SessionIdentity, SessionInbound, SessionInboundPart, SessionLimits, SessionOutbound, SessionReceipt,
  SessionSink, SessionSpec, SessionTarget } from './contract.ts';
import { accepted, cursorScope, delay, failed, isAbort, unknownReceipt } from './contract.ts';
import { loadSeen, remember, seenCursor } from './cursor.ts';
import { createSessionRun } from './loop.ts';
import { createOneBotWsTransport } from './onebot-ws.ts';
import { sessionFingerprint, shareSession } from './registry.ts';

const LIMITS: SessionLimits = { text_characters: null, text_utf8_bytes: null, callback_data_bytes: null,
  voice_mime: null, image_bytes: null, file_bytes: null };
type OneBotSpec = Extract<SessionSpec, { platform: 'qq_onebot_v11' }>;
interface Pending { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : undefined;
}
function safeUser(value: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/u, '');
  if (/^localhost$/iu.test(host) || host === '::1') return true;
  if (isIP(host) === 6) return false;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}
export function oneBotEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('onebot_endpoint_rejected'); }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname || url.username ||
      url.password || url.search || url.hash) {
    throw new Error('onebot_endpoint_rejected');
  }
  if (!privateHost(url.hostname)) throw new Error('onebot_endpoint_rejected');
  return url;
}
function accountOf(url: URL): string {
  const port = url.port || (url.protocol === 'wss:' ? '443' : '80');
  return `${url.hostname}:${port}`;
}
function sameToken(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorized(expected: string | undefined, headers: Record<string, string | undefined>, url: string): boolean {
  if (!expected) return true;
  const header = headers.authorization ?? headers.Authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ') && sameToken(expected, header.slice(7))) return true;
  try {
    const token = new URL(url, 'ws://127.0.0.1').searchParams.get('access_token') ?? undefined;
    return sameToken(expected, token);
  } catch { return false; }
}
function textOf(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map((segment) => {
    const body = record(segment);
    return body?.type === 'text' && typeof record(body.data)?.text === 'string' ? record(body.data)?.text as string : '';
  }).join('');
}
function httpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://');
}
function mediaRef(segment: Record<string, unknown>): string {
  const data = record(segment.data);
  const file = typeof data?.file === 'string' ? data.file : '';
  const url = typeof data?.url === 'string' ? data.url : '';
  // OneBot v11 puts the filename in `file`. The same segment's `url` is the fetchable copy.
  if (file.startsWith('base64://') || httpUrl(file)) return file;
  if (httpUrl(url)) return url;
  return file || url;
}

export function createOneBotSessionAdapter(spec: OneBotSpec, store: SessionCursorStore): SessionAdapter {
  if (spec.platform !== 'qq_onebot_v11') throw new Error('invalid_session_spec');
  const key = sessionFingerprint(spec);
  return shareSession(key, () => buildOneBot(spec, store, key));
}
function buildOneBot(spec: OneBotSpec, store: SessionCursorStore, key: string): SessionAdapter {
  if (spec.mode === 'forward' && spec.listen_port !== undefined) throw new Error('onebot_mode_conflict');
  const endpoint = oneBotEndpoint(spec.endpoint);
  if (spec.mode === 'reverse' && (endpoint.hostname === '0.0.0.0' || endpoint.hostname === '::')) {
    throw new Error('onebot_listen_rejected');
  }
  const transport = spec.transport ?? createOneBotWsTransport();
  const scope = cursorScope(spec.instance_id);
  const retry = spec.retry_ms ?? 1000;
  const timeout = spec.call_timeout_ms ?? 15_000;
  const accountId = accountOf(endpoint);
  const account: SessionAccount = { platform: 'qq_onebot_v11', account_id: accountId };
  const links = new Map<OneBotLink['role'], OneBotLink>();
  const pending = new Map<string, Pending>();
  let selfHeader = '';
  let seen: string[] = [];
  const seenSet = new Set<string>();
  const inflight = new Set<string>();
  const adapter = {
    platform: 'qq_onebot_v11' as const,
    instance_id: spec.instance_id,
    account,
    limits: LIMITS,
    get state() { return run.state; },
    get connection_detail() { return run.detail; },
    start: (sink: SessionSink) => run.start((signal) => loop(signal, sink)),
    stop: () => run.stop(),
    send: (message: SessionOutbound, signal?: AbortSignal) => send(message, signal),
  };
  const run = createSessionRun(key, adapter, retry);

  function adopt(link: OneBotLink): void {
    const previous = links.get(link.role);
    if (previous && previous !== link) previous.close();
    links.set(link.role, link);
    link.onFrame((frame) => { void onFrame(frame); });
    link.onClose(() => { if (links.get(link.role) === link) links.delete(link.role); });
  }
  function apiLink(): OneBotLink | undefined {
    return links.get('api') ?? links.get('universal');
  }
  async function loop(signal: AbortSignal, sink: SessionSink): Promise<void> {
    void sink;
    seen = await loadSeen(store, scope);
    for (const id of seen) seenSet.add(id);
    if (spec.mode === 'reverse') {
      const port = spec.listen_port ?? Number(endpoint.port || 0);
      await transport.listen({ host: endpoint.hostname, port, signal,
        authorize: (headers, url) => {
          const selfId = headers['x-self-id'];
          if (typeof selfId === 'string' && /^[1-9]\d{0,15}$/u.test(selfId)) selfHeader = selfId;
          return authorized(spec.access_token, headers, url);
        },
        accept: adopt });
      run.state = 'running';
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      for (const link of links.values()) link.close();
      return;
    }
    const headers: Record<string, string> = {};
    if (spec.access_token) headers.Authorization = `Bearer ${spec.access_token}`;
    while (!signal.aborted) {
      try {
        const link = await transport.connect({ url: spec.endpoint, headers, signal });
        if (signal.aborted) { link.close(); return; }
        adopt(link);
        run.state = 'running';
        await new Promise<void>((resolve) => {
          const finish = (): void => { signal.removeEventListener('abort', onAbort); resolve(); };
          const onAbort = (): void => { link.close(); };
          if (signal.aborted) { onAbort(); finish(); return; }
          link.onClose(finish);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
      }
      if (signal.aborted) return;
      await run.reconnect({ code: 'transport_error' }, signal);
    }
  }
  async function onFrame(frame: unknown): Promise<void> {
    const body = record(frame);
    if (!body) return;
    const echo = typeof body.echo === 'string' ? body.echo : '';
    if (echo && pending.has(echo)) {
      pending.get(echo)?.resolve(body);
      return;
    }
    if (body.post_type !== 'message' && body.post_type !== undefined) return;
    if (body.message_type !== 'private' && body.message_type !== 'group') return;
    const selfId = typeof body.self_id === 'number' || typeof body.self_id === 'string' ?
      String(body.self_id) : selfHeader || accountId;
    const messageId = typeof body.message_id === 'number' || typeof body.message_id === 'string' ?
      String(body.message_id) : '';
    if (!messageId) return;
    const eventKey = `qq:${selfId}:${body.message_type}:${messageId}`;
    if (seenSet.has(eventKey) || inflight.has(eventKey)) return;
    inflight.add(eventKey);
    try {
      const userId = textOfId(body.user_id);
      const groupId = textOfId(body.group_id);
      const senderId = userId || textOfId(record(body.sender)?.user_id);
      if (!senderId) return;
      if (body.message_type === 'group' && !groupId) return;
      const identity: SessionIdentity = body.message_type === 'group' ? {
        ...account, chat_id: groupId, sender_id: senderId, topic_id: '0', chat_kind: 'group',
      } : { ...account, chat_id: senderId, sender_id: senderId, topic_id: '0', chat_kind: 'private' };
      const inbound = await inboundOf(body, eventKey, messageId, identity);
      if (!inbound) { await keep(eventKey); return; }
      // OneBot does not redeliver a frame. Retry admit locally until the host accepts or the loop stops.
      while (run.state !== 'stopped' && run.state !== 'conflict' && run.state !== 'auth_expired') {
        let decision;
        try { decision = await currentSink?.admit(inbound); }
        catch { decision = { decision: 'defer' as const }; }
        if (decision?.decision === 'accepted') { await keep(eventKey); return; }
        await delay(retry, currentSignal);
        if (currentSignal.aborted) return;
      }
    } finally { inflight.delete(eventKey); }
  }
  let currentSink: SessionSink | undefined;
  let currentSignal: AbortSignal = new AbortController().signal;
  const originalLoop = loop;
  async function startLoop(signal: AbortSignal, sink: SessionSink): Promise<void> {
    currentSink = sink;
    currentSignal = signal;
    return originalLoop(signal, sink);
  }
  adapter.start = (sink) => run.start((signal) => startLoop(signal, sink));

  async function inboundOf(body: Record<string, unknown>, eventKey: string, messageId: string,
    identity: SessionIdentity): Promise<SessionInbound | undefined> {
    const cursor = seenCursor(seen.concat(eventKey));
    const base = { event_key: eventKey, platform_event_id: messageId, identity, cursor };
    const message = body.message;
    if (typeof message === 'string' || (Array.isArray(message) && message.every((segment) => record(segment)?.type === 'text' || record(segment)?.type === undefined))) {
      return { ...base, payload: { type: 'text', text: textOf(message) } };
    }
    if (!Array.isArray(message)) return { ...base, payload: { type: 'text', text: textOf(message) } };
    const caption = textOf(message);
    const mediaSegments = message.map(record).filter((segment): segment is Record<string, unknown> =>
      segment?.type === 'image' || segment?.type === 'record');
    if (mediaSegments.length === 0) return { ...base, payload: { type: 'text', text: caption } };
    const parts: SessionInboundPart[] = [];
    let textBuffer = '';
    const flushText = (): void => {
      if (textBuffer.length > 0) parts.push({ type: 'text', text: textBuffer });
      textBuffer = '';
    };
    for (const rawSegment of message) {
      const segment = record(rawSegment);
      if (!segment) continue;
      if (segment.type === 'text' && typeof record(segment.data)?.text === 'string') {
        textBuffer += record(segment.data)?.text as string;
        continue;
      }
      if (segment.type === 'image' || segment.type === 'record') {
        flushText();
        const kind = segment.type === 'record' ? 'voice' as const : 'image' as const;
        const loaded = await loadMedia(mediaRef(segment));
        if (loaded.kind === 'unavailable') {
          parts.push({ type: 'media_unavailable', kind, reason: loaded.reason });
        } else {
          parts.push({ type: 'media', media: { kind, filename: kind === 'voice' ? 'record' : 'image',
            mime: kind === 'voice' ? 'application/octet-stream' : 'image/jpeg', bytes: loaded.bytes } });
        }
      }
    }
    flushText();
    if (mediaSegments.length === 1 && parts.length === 1 && parts[0]?.type !== 'text') {
      return { ...base, payload: parts[0]! };
    }
    if (mediaSegments.length === 1 && parts.length === 2 && parts[0]?.type === 'text' && parts[1]?.type !== 'text') {
      return { ...base, payload: { ...parts[1]!, caption: parts[0].text } };
    }
    return { ...base, payload: { type: 'parts', parts } };
  }
  async function loadMedia(ref: string): Promise<{ kind: 'bytes'; bytes: Uint8Array } | { kind: 'unavailable'; reason: 'local_path_not_fetched' | 'download_failed' }> {
    if (ref.startsWith('base64://')) {
      try { return { kind: 'bytes', bytes: Buffer.from(ref.slice('base64://'.length), 'base64') }; }
      catch { return { kind: 'unavailable', reason: 'download_failed' }; }
    }
    if (ref.startsWith('https://') || ref.startsWith('http://')) {
      if (!transport.download) return { kind: 'unavailable', reason: 'download_failed' };
      const downloaded = await transport.download(ref, currentSignal).catch(() => ({ ok: false as const }));
      return downloaded.ok ? { kind: 'bytes', bytes: downloaded.bytes } : { kind: 'unavailable', reason: 'download_failed' };
    }
    return { kind: 'unavailable', reason: 'local_path_not_fetched' };
  }
  async function keep(eventKey: string): Promise<void> {
    if (seenSet.has(eventKey)) return;
    seenSet.add(eventKey);
    await remember(store, scope, seen, eventKey);
  }
  async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
    if (message.type === 'edit_text') return failed('unsupported', 'onebot_unsupported_edit');
    if (message.type === 'callback_ack' || (message.type === 'text' && message.buttons && message.buttons.length > 0)) {
      return failed('unsupported', 'onebot_unsupported_callback');
    }
    if (message.type === 'media' && (message.media.kind === 'audio' || message.media.kind === 'video')) return failed('unsupported', 'onebot_unsupported_media_kind');
    if (message.type === 'media' && message.media.kind === 'file') return failed('unsupported', 'onebot_unsupported_file');
    if (signal?.aborted) return failed('cancelled', 'cancelled');
    const live = signal ?? new AbortController().signal;
    try {
      if (message.type === 'text') return await callSend(message.target, message.text, undefined, live);
      if (message.type === 'text_parts') {
        const ids: string[] = [];
        for (let index = 0; index < message.parts.length; index += 1) {
          const receipt = await callSend(message.target, message.parts[index] ?? '', undefined, live);
          if (receipt.status !== 'accepted') return { ...receipt, message_ids: ids, failed_part: index };
          ids.push(...receipt.message_ids);
        }
        return accepted(ids);
      }
      if (message.type === 'media') {
        const segment = message.media.kind === 'voice' ? 'record' : 'image';
        const payload = [{ type: segment, data: { file: `base64://${Buffer.from(message.media.bytes).toString('base64')}` } }];
        return callSend(message.target, payload, message.caption, live);
      }
      return failed('unsupported', 'onebot_unsupported_callback');
    } catch (error) {
      if (error instanceof Error && error.message === 'onebot_timeout') return unknownReceipt('onebot_timeout');
      if (live.aborted || isAbort(error)) return unknownReceipt('cancelled_after_dispatch');
      return unknownReceipt('onebot_transport_unknown');
    }
  }
  async function callSend(target: SessionTarget, message: unknown,
    caption: string | undefined, signal: AbortSignal): Promise<SessionReceipt> {
    if (!target.chat_kind) return failed('configuration', 'onebot_chat_kind');
    const id = safeUser(target.chat_id);
    if (id === undefined) return failed('bad_format', 'onebot_target');
    const link = apiLink();
    if (!link) return failed('configuration', 'onebot_no_api_socket');
    const params: Record<string, unknown> = { message_type: target.chat_kind, message,
      ...(target.chat_kind === 'group' ? { group_id: id } : { user_id: id }) };
    if (typeof message === 'string') {
      if (message.length === 0) return failed('bad_format', 'session_empty_text');
      params.auto_escape = true;
    } else if (caption) {
      (message as Array<unknown>).unshift({ type: 'text', data: { text: caption } });
    }
    const echo = `ob_${randomBytes(8).toString('hex')}`;
    const frame = { action: 'send_msg', params, echo };
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (kind: 'ok' | 'err', value: Record<string, unknown> | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        pending.delete(echo);
        if (kind === 'ok') resolve(value as Record<string, unknown>);
        else reject(value as Error);
      };
      const onAbort = (): void => { finish('ok', { status: 'cancelled_local' }); };
      timer = setTimeout(() => finish('err', new Error('onebot_timeout')), timeout);
      pending.set(echo, { resolve: (value) => finish('ok', value), reject: (error) => finish('err', error) });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      else link.send(frame);
    });
    if (response.status === 'cancelled_local') return unknownReceipt('cancelled_after_dispatch');
    return receiptOf(response);
  }
  return adapter;
}
function textOfId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value)) return value;
  return '';
}
function receiptOf(response: Record<string, unknown>): SessionReceipt {
  if (response.status === 'async') return unknownReceipt('onebot_async');
  const retcode = typeof response.retcode === 'number' ? response.retcode : -1;
  if (response.status === 'ok' && retcode === 0) {
    const id = textOfId(record(response.data)?.message_id);
    return accepted(id ? [id] : []);
  }
  if (retcode === 1400) return failed('bad_format', 'onebot_bad_request');
  if (retcode === 1401) return failed('auth', 'onebot_auth');
  if (retcode === 1403) return failed('forbidden', 'onebot_forbidden');
  if (retcode === 1404) return failed('not_found', 'onebot_not_found');
  return unknownReceipt(retcode === -1 ? 'onebot_timeout' : 'onebot_rejected');
}
