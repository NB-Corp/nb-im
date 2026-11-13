import type { FeishuConnection, FeishuRequest, FeishuResponse, SessionAccount, SessionAdapter,
  SessionAdmit, SessionButton, SessionCursorStore, SessionIdentity, SessionInbound, SessionInboundPart,
  SessionLimits, SessionMedia, SessionMediaKind, SessionOutbound, SessionReceipt, SessionSink,
  SessionSpec, SessionTarget } from './contract.ts';
import { FEISHU_CARD_UTF8_BYTES, FEISHU_FILE_BYTES, FEISHU_IMAGE_BYTES, FEISHU_TEXT_UTF8_BYTES,
  accepted, cursorScope, delay, failed, feishuTextContent, isAbort, unknownReceipt,
  utf8Size } from './contract.ts';
import { loadSeen, remember, seenCursor } from './cursor.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';
import { createFeishuSdkConnection } from './feishu-sdk.ts';

const RESOURCE_CAP = 100 * 1024 * 1024;
const VOICE_MIME = ['audio/ogg', 'audio/opus'] as const;
const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/tiff', 'image/heic']);
const LIMITS: SessionLimits = {
  text_characters: null, text_utf8_bytes: FEISHU_TEXT_UTF8_BYTES, callback_data_bytes: null,
  voice_mime: VOICE_MIME, image_bytes: FEISHU_IMAGE_BYTES, file_bytes: FEISHU_FILE_BYTES,
};
type FeishuSpec = Extract<SessionSpec, { platform: 'feishu_app' }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : undefined;
}
function mimeBase(mime: string): string {
  return mime.split(';', 1)[0]!.trim().toLowerCase();
}
function safeId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
}
function fromResponse(response: FeishuResponse): SessionReceipt {
  if (response.ok) return accepted(response.message_id && safeId(response.message_id) ? [response.message_id] : []);
  const code = response.code ?? response.http_status ?? 0;
  if (code === 401 || code === 99991663 || code === 99991664) return failed('auth', 'feishu_auth');
  if (response.http_status === 403) return failed('forbidden', 'feishu_forbidden');
  if (response.http_status === 404) return failed('not_found', 'feishu_not_found');
  if (response.http_status === 429 || code === 99991400) return failed('rate_limited', 'feishu_rate_limited');
  if (response.http_status === 400) return failed('bad_format', 'feishu_bad_request');
  return unknownReceipt('feishu_rejected');
}
type FeishuPostToken =
  | { type: 'text'; text: string }
  | { type: 'newline' }
  | { type: 'media'; kind: SessionMediaKind; resourceKey: string; fileName?: string };

function resolvePostBody(content: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  if (Array.isArray(content.content) || typeof content.title === 'string') return content;
  for (const key of ['zh_cn', 'en_us', 'ja_jp', ...Object.keys(content)]) {
    const candidate = record(content[key]);
    if (candidate && (Array.isArray(candidate.content) || typeof candidate.title === 'string')) return candidate;
  }
  return content;
}
function collectPostNode(node: unknown, out: FeishuPostToken[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPostNode(item, out);
    return;
  }
  const body = record(node);
  if (!body) return;
  const tag = typeof body.tag === 'string' ? body.tag : '';
  if (tag === 'img') {
    const key = typeof body.image_key === 'string' ? body.image_key :
      typeof body.file_key === 'string' ? body.file_key : '';
    out.push({ type: 'media', kind: 'image', resourceKey: key });
    return;
  }
  if (tag === 'media') {
    const key = typeof body.file_key === 'string' ? body.file_key :
      typeof body.image_key === 'string' ? body.image_key : '';
    const fileName = typeof body.file_name === 'string' && body.file_name.length > 0 ? body.file_name : undefined;
    out.push({ type: 'media', kind: typeof body.file_key === 'string' ? 'video' : 'image', resourceKey: key,
      ...(fileName ? { fileName } : {}) });
    return;
  }
  if (tag === 'at') {
    const text = typeof body.text === 'string' && body.text.length > 0 ? body.text :
      typeof body.user_name === 'string' && body.user_name.length > 0 ? `@${body.user_name}` :
      typeof body.user_id === 'string' && body.user_id.length > 0 ? `@${body.user_id}` : '';
    if (text.length > 0) out.push({ type: 'text', text });
    return;
  }
  if (typeof body.text === 'string' && body.text.length > 0) {
    out.push({ type: 'text', text: body.text });
  }
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'text' && key !== 'tag' && key !== 'image_key' && key !== 'file_key') collectPostNode(value, out);
  }
}
function collectPostTokens(content: Record<string, unknown> | undefined): FeishuPostToken[] {
  const post = resolvePostBody(content);
  if (!post) return [];
  const tokens: FeishuPostToken[] = [];
  if (typeof post.title === 'string' && post.title.length > 0) {
    tokens.push({ type: 'text', text: post.title });
  }
  if (Array.isArray(post.content)) {
    for (const row of post.content) {
      const rowStart = tokens.length;
      if (rowStart > 0 && tokens[rowStart - 1]?.type === 'text') tokens.push({ type: 'newline' });
      collectPostNode(row, tokens);
      if (tokens.length === rowStart + 1 && tokens[rowStart]?.type === 'newline') tokens.pop();
    }
    return tokens;
  }
  for (const [key, value] of Object.entries(post)) {
    if (key !== 'title') collectPostNode(value, tokens);
  }
  return tokens;
}
function captionOf(content: Record<string, unknown> | undefined): string | undefined {
  const raw = typeof content?.text === 'string' ? content.text :
    typeof content?.caption === 'string' ? content.caption : '';
  return raw.length > 0 ? raw : undefined;
}
function parseContent(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === 'string') {
    try { return record(JSON.parse(content)); } catch { return undefined; }
  }
  return record(content);
}
function cardBody(text: string, buttons: readonly SessionButton[], topicId?: string): string {
  return JSON.stringify({ schema: '2.0', body: { elements: [
    { tag: 'markdown', content: text },
    ...buttons.map((button) => ({ tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      behaviors: [{ type: 'callback', value: { k: button.data, topic_id: topicId } }] })),
  ] } });
}
function fileTypeOf(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return ext === 'pdf' || ext === 'doc' || ext === 'xls' ? ext : 'stream';
}
function feishuTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d{10,16}$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e11 ? parsed * 1000 : parsed;
  }
  return undefined;
}
function feishuMentions(value: unknown, botOpenId: string | undefined): { mentioned?: true; mentionIds?: string[] } {
  if (!Array.isArray(value) || value.length === 0) return {};
  const ids: string[] = [];
  let mentioned = false;
  for (const item of value) {
    const entry = record(item);
    const id = record(entry?.id);
    const openId = typeof id?.open_id === 'string' && safeId(id.open_id) ? id.open_id : undefined;
    const userId = typeof id?.user_id === 'string' && safeId(id.user_id) ? id.user_id : undefined;
    const rawId = typeof entry?.id === 'string' && safeId(entry.id) ? entry.id : undefined;
    const candidate = openId ?? userId ?? rawId ?? '';
    if (candidate && !ids.includes(candidate)) ids.push(candidate);
    if (botOpenId && (openId === botOpenId || userId === botOpenId || rawId === botOpenId)) {
      mentioned = true;
    }
  }
  return {
    ...(mentioned ? { mentioned: true } : {}),
    ...(ids.length > 0 ? { mentionIds: ids } : {}),
  };
}
function attachMessageMetadata(
  inbound: SessionInbound,
  message: Record<string, unknown>,
  botOpenId: string | undefined,
): SessionInbound {
  const sourceMessageId = typeof message.message_id === 'string' && safeId(message.message_id) ? message.message_id : undefined;
  const replyToMessageId = typeof message.parent_id === 'string' && safeId(message.parent_id) ? message.parent_id :
    typeof message.root_id === 'string' && safeId(message.root_id) ? message.root_id : undefined;
  const timestamp = feishuTimestamp(message.create_time);
  const { mentioned, mentionIds } = feishuMentions(message.mentions, botOpenId);
  return {
    ...inbound,
    ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(mentioned ? { mentioned: true } : {}),
    ...(mentionIds ? { mention_ids: mentionIds } : {}),
  };
}

export function createFeishuSessionAdapter(spec: FeishuSpec, store: SessionCursorStore): SessionAdapter {
  if (spec.platform !== 'feishu_app') throw new Error('invalid_session_spec');
  const key = sessionFingerprint(spec);
  return shareSession(key, () => buildFeishu(spec, store, key));
}
function buildFeishu(spec: FeishuSpec, store: SessionCursorStore, key: string): SessionAdapter {
  const connection: FeishuConnection = spec.connection ??
    createFeishuSdkConnection({ appId: spec.app_id, appSecret: spec.app_secret });
  const scope = cursorScope(spec.instance_id);
  const retry = spec.retry_ms ?? 1000;
  const account: SessionAccount = { platform: 'feishu_app', account_id: spec.app_id };
  let botOpenId: string | undefined;
  let seen: string[] = [];
  const seenSet = new Set<string>();
  const adapter = {
    platform: 'feishu_app' as const,
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
  let currentSignal: AbortSignal = new AbortController().signal;
  function bindSignal(caller: AbortSignal | undefined): AbortSignal {
    if (!caller || caller === currentSignal) return currentSignal;
    if (caller.aborted || currentSignal.aborted) {
      const done = new AbortController();
      done.abort();
      return done.signal;
    }
    const linked = new AbortController();
    const abort = (): void => linked.abort();
    caller.addEventListener('abort', abort, { once: true });
    currentSignal.addEventListener('abort', abort, { once: true });
    return linked.signal;
  }

  async function loop(signal: AbortSignal, sink: SessionSink): Promise<void> {
    currentSignal = signal;
    seen = await loadSeen(store, scope);
    for (const id of seen) seenSet.add(id);
    while (!signal.aborted) {
      const attempt = new AbortController();
      let resolveDrop: () => void = () => undefined;
      const dropped = new Promise<void>((resolve) => { resolveDrop = resolve; });
      const onAbort = (): void => { attempt.abort(); resolveDrop(); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const opened = await connection.open({
          onMessage: (event) => onMessage(event, sink),
          onCardAction: (event) => onCard(event, sink),
          onDisconnect: () => resolveDrop(),
          onReconnecting: () => { if (!signal.aborted) run.state = 'reconnecting'; },
          onReconnected: () => { if (!signal.aborted) run.state = 'running'; },
          onBotIdentity: (nextId) => {
            if (typeof nextId === 'string' && safeId(nextId)) botOpenId = nextId;
          },
        }, attempt.signal);
        if (signal.aborted) return;
        if (!opened.ok) {
          if (opened.reason === 'auth') { run.state = 'auth_expired'; return; }
          if (opened.reason === 'conflict') { run.state = 'conflict'; return; }
        } else {
          if (typeof opened.bot_open_id === 'string' && safeId(opened.bot_open_id)) {
            botOpenId = opened.bot_open_id;
          }
          run.state = 'running';
          await dropped;
        }
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
      } finally {
        signal.removeEventListener('abort', onAbort);
        attempt.abort();
      }
      if (signal.aborted) return;
      await run.reconnect({ code: 'transport_error' }, signal);
    }
  }
  function mismatched(event: Record<string, unknown>): boolean {
    return typeof event.app_id === 'string' && event.app_id !== spec.app_id;
  }
  async function onMessage(event: unknown, sink: SessionSink): Promise<unknown> {
    const data = record(event) ?? {};
    const message = record(data.message);
    const eventId = typeof data.event_id === 'string' ? data.event_id :
      typeof message?.message_id === 'string' ? message.message_id : '';
    if (!eventId) return undefined;
    const eventKey = `feishu:${spec.app_id}:${eventId}`;
    if (mismatched(data)) { await keep(eventKey); return undefined; }
    if (seenSet.has(eventKey)) return undefined;
    const messageType = typeof message?.message_type === 'string' ? message.message_type : '';
    if (messageType === 'sticker' || !message) { await keep(eventKey); return undefined; }
    const identity = identityOf(data, message);
    const content = parseContent(message.content);
    let inbound: SessionInbound | 'drop' | 'skip' | undefined;
    if (messageType === 'text') {
      const text = typeof content?.text === 'string' ? content.text : '';
      inbound = text.length > 0 ? eventOf(eventKey, eventId, identity, { type: 'text', text }) : 'drop';
    } else if (messageType === 'post') {
      inbound = await postEvent(eventKey, eventId, identity, message, content);
    } else if (messageType === 'image' || messageType === 'audio' || messageType === 'file' || messageType === 'media') {
      inbound = await mediaEvent(eventKey, eventId, identity, message, content, messageType);
    } else inbound = 'drop';
    if (inbound === 'skip' || currentSignal.aborted || run.state === 'stopped') return undefined;
    if (inbound === 'drop' || !inbound) { await keep(eventKey); return undefined; }
    inbound = attachMessageMetadata(inbound, message, botOpenId);
    if (botOpenId && identity.sender_id === botOpenId) {
      inbound = { ...inbound, is_self: true };
    }
    if (identity.topic_id !== '0' && typeof message.message_id === 'string' && safeId(message.message_id)) {
      inbound = { ...inbound, reply_context: message.message_id };
    }
    await admitOrRetry(inbound, sink);
    return undefined;
  }
  async function onCard(event: unknown, sink: SessionSink): Promise<unknown> {
    const data = record(event) ?? {};
    if (mismatched(data)) {
      const id = typeof data.event_id === 'string' ? data.event_id : '';
      if (id) await keep(`feishu:${spec.app_id}:${id}`);
      return undefined;
    }
    const action = record(data.action);
    const value = action?.value;
    const callbackData = typeof value === 'string' ? value :
      typeof record(value)?.k === 'string' ? record(value)?.k as string : '';
    const context = record(data.context);
    const messageId = typeof context?.open_message_id === 'string' ? context.open_message_id :
      typeof data.open_message_id === 'string' ? data.open_message_id : '';
    const eventId = typeof data.event_id === 'string' ? data.event_id : '';
    const eventKey = eventId ? `feishu:${spec.app_id}:${eventId}` :
      `feishu:${spec.app_id}:card:${messageId}:${callbackData}`;
    if (!callbackData || seenSet.has(eventKey)) return undefined;
    const chatId = typeof context?.open_chat_id === 'string' ? context.open_chat_id :
      typeof data.open_chat_id === 'string' ? data.open_chat_id : '';
    const operator = record(data.operator);
    const sender = typeof operator?.open_id === 'string' ? operator.open_id : '0';
    const topic = typeof record(value)?.topic_id === 'string' ? record(value)?.topic_id as string : '0';
    const identity: SessionIdentity = { ...account, chat_id: chatId, sender_id: sender, topic_id: topic };
    const decision = await admitOrRetry(eventOf(eventKey, eventId || messageId, identity, {
      type: 'callback', callback_id: eventKey, data: callbackData,
      ...(messageId ? { message_id: messageId } : {}),
    }), sink);
    const ack = decision.decision === 'accepted' && decision.callback_ack ? decision.callback_ack : 'ok';
    return { toast: { type: 'info', content: ack } };
  }
  async function admitOrRetry(inbound: SessionInbound, sink: SessionSink): Promise<SessionAdmit> {
    let decision: SessionAdmit;
    try { decision = await sink.admit(inbound); }
    catch { decision = { decision: 'defer' }; }
    if (decision.decision !== 'accepted') throw new Error('feishu_deferred');
    await keep(inbound.event_key);
    return decision;
  }
  async function keep(eventKey: string): Promise<void> {
    if (seenSet.has(eventKey)) return;
    seenSet.add(eventKey);
    await remember(store, scope, seen, eventKey);
  }
  function identityOf(data: Record<string, unknown>, message: Record<string, unknown>): SessionIdentity {
    const sender = record(record(data.sender)?.sender_id);
    const senderId = typeof sender?.open_id === 'string' ? sender.open_id :
      typeof sender?.user_id === 'string' ? sender.user_id : '0';
    const chatId = typeof message.chat_id === 'string' ? message.chat_id : '';
    const topic = typeof message.thread_id === 'string' && message.thread_id.length > 0 ? message.thread_id : '0';
    const kind = message.chat_type === 'p2p' ? 'private' as const :
      message.chat_type === 'group' ? 'group' as const : undefined;
    return { ...account, chat_id: chatId, sender_id: senderId, topic_id: topic,
      ...(kind ? { chat_kind: kind } : {}) };
  }
  function eventOf(eventKey: string, platformId: string, identity: SessionIdentity,
    payload: SessionInbound['payload']): SessionInbound {
    return { event_key: eventKey, platform_event_id: platformId || eventKey, identity, payload,
      cursor: seenCursor(seen.concat(eventKey)) };
  }
  async function loadResource(kind: SessionMediaKind, messageId: string, resourceKey: string,
    fileName?: string): Promise<Extract<SessionInboundPart, { type: 'media' | 'media_unavailable' }> | 'skip'> {
    if (currentSignal.aborted || run.state === 'stopped') return 'skip';
    if (!resourceKey || !messageId) return { type: 'media_unavailable', kind, reason: 'download_failed' };
    let response: FeishuResponse | undefined;
    try {
      response = await connection.send({ op: 'download', message_id: messageId, resource_key: resourceKey,
        resource_type: kind === 'image' ? 'image' : 'file' }, currentSignal);
    } catch (error) {
      if (currentSignal.aborted || isAbort(error)) return 'skip';
      response = undefined;
    }
    if (currentSignal.aborted) return 'skip';
    if (!response) return { type: 'media_unavailable', kind, reason: 'download_failed' };
    if (response.too_large || (response.bytes && response.bytes.byteLength > RESOURCE_CAP)) {
      return { type: 'media_unavailable', kind, reason: 'too_large' };
    }
    if (!response.ok || !response.bytes) {
      return { type: 'media_unavailable', kind, reason: 'download_failed' };
    }
    const filename = kind === 'voice' ? 'voice.opus' :
      fileName && fileName.length > 0 ? fileName.slice(0, 180) :
      kind === 'image' ? 'image' : kind === 'video' ? 'video.mp4' : 'file';
    const mime = kind === 'voice' ? 'audio/opus' : kind === 'image' ? 'image/jpeg' :
      kind === 'video' ? 'video/mp4' : 'application/octet-stream';
    return { type: 'media', media: { kind, filename, mime, bytes: response.bytes } };
  }
  async function postEvent(eventKey: string, eventId: string, identity: SessionIdentity,
    message: Record<string, unknown>, content: Record<string, unknown> | undefined): Promise<SessionInbound | 'drop' | 'skip'> {
    const tokens = collectPostTokens(content);
    const hasMedia = tokens.some((token) => token.type === 'media');
    if (!hasMedia) {
      const text = tokens.map((token) => token.type === 'text' ? token.text : '\n').join('');
      return text.length > 0 ? eventOf(eventKey, eventId, identity, { type: 'text', text }) : 'drop';
    }
    const messageId = typeof message.message_id === 'string' ? message.message_id : '';
    const parts: SessionInboundPart[] = [];
    let buffer = '';
    const flushText = (): void => {
      const trimmed = buffer.replace(/^\n+|\n+$/gu, '');
      if (trimmed.length > 0) parts.push({ type: 'text', text: trimmed });
      buffer = '';
    };
    for (const token of tokens) {
      if (token.type === 'text') {
        buffer += token.text;
        continue;
      }
      if (token.type === 'newline') {
        if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n';
        continue;
      }
      flushText();
      const loaded = await loadResource(token.kind, messageId, token.resourceKey, token.fileName);
      if (loaded === 'skip') return 'skip';
      parts.push(loaded);
    }
    flushText();
    return parts.length > 0 ? eventOf(eventKey, eventId, identity, { type: 'parts', parts }) : 'drop';
  }
  async function mediaEvent(eventKey: string, eventId: string, identity: SessionIdentity,
    message: Record<string, unknown>, content: Record<string, unknown> | undefined,
    messageType: string): Promise<SessionInbound | 'drop' | 'skip'> {
    const kind = messageType === 'image' ? 'image' as const :
      messageType === 'audio' ? 'voice' as const :
      messageType === 'media' ? 'video' as const : 'file' as const;
    const resourceKey = typeof content?.file_key === 'string' && messageType !== 'image' ? content.file_key :
      typeof content?.image_key === 'string' ? content.image_key :
      typeof content?.file_key === 'string' ? content.file_key : '';
    const messageId = typeof message.message_id === 'string' ? message.message_id : '';
    const caption = captionOf(content);
    const fileName = typeof content?.file_name === 'string' ? content.file_name : undefined;
    const loaded = await loadResource(kind, messageId, resourceKey, fileName);
    if (loaded === 'skip') return 'skip';
    return eventOf(eventKey, eventId, identity, { ...loaded, ...(caption === undefined ? {} : { caption }) });
  }
  async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
    if (signal?.aborted || currentSignal.aborted || run.state === 'stopped') return failed('cancelled', 'cancelled');
    const live = bindSignal(signal);
    try {
      if (message.type === 'callback_ack') return failed('unsupported', 'feishu_callback_inline_only');
      if (message.type === 'edit_text' && message.buttons && message.buttons.length > 0) {
        return failed('unsupported', 'feishu_edit_card_unsupported');
      }
      if (message.type !== 'edit_text' && message.target.topic_id && message.target.topic_id !== '0' &&
          (!message.target.reply_context || !safeId(message.target.reply_context))) {
        return failed('configuration', 'feishu_thread_context_missing');
      }
      if (message.type === 'text' || message.type === 'edit_text') {
        return sendText(message.target, message.text, message.buttons,
          message.type === 'edit_text' ? message.message_id : undefined, live);
      }
      if (message.type === 'text_parts') {
        const ids: string[] = [];
        for (let index = 0; index < message.parts.length; index += 1) {
          const receipt = await sendText(message.target, message.parts[index] ?? '', undefined, undefined, live);
          if (receipt.status !== 'accepted') return { ...receipt, message_ids: ids, failed_part: index };
          ids.push(...receipt.message_ids);
        }
        return accepted(ids);
      }
      return sendMedia(message, live);
    } catch (error) {
      if (live.aborted || isAbort(error)) return unknownReceipt('cancelled_after_dispatch');
      return unknownReceipt('feishu_transport_unknown');
    }
  }
  function destination(target: SessionTarget): Pick<FeishuRequest, 'op' | 'chat_id' | 'message_id'> {
    return target.topic_id && target.topic_id !== '0' ?
      { op: 'reply_message', message_id: target.reply_context } : { op: 'create_message', chat_id: target.chat_id };
  }
  async function sendText(target: SessionTarget, text: string, buttons: readonly SessionButton[] | undefined,
    editId: string | undefined, signal: AbortSignal): Promise<SessionReceipt> {
    if (text.length === 0) return failed('bad_format', 'session_empty_text');
    if (buttons && buttons.length > 0) {
      if (buttons.some((button) => button.data.length === 0 || button.label.length === 0)) {
        return failed('bad_format', 'feishu_button');
      }
      const content = cardBody(text, buttons, target.topic_id === '0' ? undefined : target.topic_id);
      if (utf8Size(content) > FEISHU_CARD_UTF8_BYTES) return failed('too_long', 'feishu_card_too_long');
      return fromResponse(await connection.send({ ...destination(target), msg_type: 'interactive', content }, signal));
    }
    const content = feishuTextContent(text);
    if (utf8Size(content) > FEISHU_TEXT_UTF8_BYTES) return failed('too_long', 'feishu_text_too_long');
    const request: FeishuRequest = editId ? { op: 'update_message', message_id: editId, msg_type: 'text', content } :
      { ...destination(target), msg_type: 'text', content };
    return fromResponse(await connection.send(request, signal));
  }
  async function sendMedia(message: Extract<SessionOutbound, { type: 'media' }>, signal: AbortSignal): Promise<SessionReceipt> {
    const media = message.media;
    if (media.kind === 'audio') return failed('unsupported', 'feishu_unsupported_media_kind');
    if (media.bytes.byteLength === 0) return failed('bad_format', 'feishu_empty_media');
    if (message.caption !== undefined && utf8Size(feishuTextContent(message.caption)) > FEISHU_TEXT_UTF8_BYTES) {
      return failed('too_long', 'feishu_text_too_long');
    }
    if (media.kind === 'video') {
      const base = mimeBase(media.mime);
      const ext = media.filename.toLowerCase().split('.').pop() ?? '';
      if (base !== 'video/mp4' && (base !== 'application/octet-stream' || ext !== 'mp4')) {
        return failed('bad_format', 'feishu_video_container');
      }
      if (media.bytes.byteLength > FEISHU_FILE_BYTES) return failed('too_long', 'feishu_file_too_large');
      const fileName = media.filename && media.filename.toLowerCase().endsWith('.mp4') ?
        media.filename : `${media.filename || 'video'}.mp4`;
      const uploaded = await connection.send({ op: 'upload_file', file_type: 'mp4', file_name: fileName,
        mime: media.mime, bytes: media.bytes }, signal);
      if (!uploaded.ok || !uploaded.key) return fromResponse(uploaded);
      return fromResponse(await connection.send({ ...destination(message.target),
        msg_type: 'media', content: JSON.stringify({ file_key: uploaded.key }) }, signal));
    }
    if (media.kind === 'image') {
      if (!IMAGE_MIME.has(mimeBase(media.mime))) return failed('bad_format', 'feishu_image_type');
      if (media.bytes.byteLength > FEISHU_IMAGE_BYTES) return failed('too_long', 'feishu_image_too_large');
      const uploaded = await connection.send({ op: 'upload_image', mime: media.mime, bytes: media.bytes,
        file_name: media.filename }, signal);
      if (!uploaded.ok || !uploaded.key) return fromResponse(uploaded);
      const sent = await connection.send({ ...destination(message.target),
        msg_type: 'image', content: JSON.stringify({ image_key: uploaded.key }) }, signal);
      return fromResponse(sent);
    }
    if (media.kind === 'voice') {
      if (!VOICE_MIME.includes(mimeBase(media.mime) as typeof VOICE_MIME[number])) {
        return failed('bad_format', 'feishu_voice_container');
      }
      if (media.bytes.byteLength > FEISHU_FILE_BYTES) return failed('too_long', 'feishu_file_too_large');
      const uploaded = await connection.send({ op: 'upload_file', file_type: 'opus', file_name: 'voice.opus',
        mime: media.mime, bytes: media.bytes }, signal);
      if (!uploaded.ok || !uploaded.key) return fromResponse(uploaded);
      return fromResponse(await connection.send({ ...destination(message.target),
        msg_type: 'audio', content: JSON.stringify({ file_key: uploaded.key }) }, signal));
    }
    if (media.bytes.byteLength > FEISHU_FILE_BYTES) return failed('too_long', 'feishu_file_too_large');
    const uploaded = await connection.send({ op: 'upload_file', file_type: fileTypeOf(media.filename),
      file_name: media.filename || 'file', mime: media.mime, bytes: media.bytes }, signal);
    if (!uploaded.ok || !uploaded.key) return fromResponse(uploaded);
    return fromResponse(await connection.send({ ...destination(message.target),
      msg_type: 'file', content: JSON.stringify({ file_key: uploaded.key }) }, signal));
  }
  return adapter;
}
