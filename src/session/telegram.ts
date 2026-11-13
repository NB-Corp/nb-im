import type { SessionAccount, SessionAdapter, SessionAdmit, SessionButton, SessionCursorStore,
  SessionInbound, SessionLimits, SessionMedia, SessionOutbound, SessionReceipt, SessionSink,
  SessionSpec, TelegramBotTransport, TelegramCall } from './contract.ts';
import { TELEGRAM_CALLBACK_DATA_BYTES, TELEGRAM_CAPTION_CHARACTERS, TELEGRAM_DOWNLOAD_BYTES,
  TELEGRAM_FILE_BYTES, TELEGRAM_IMAGE_BYTES, TELEGRAM_TEXT_CHARACTERS, TELEGRAM_VOICE_BYTES,
  accepted, cursorScope, delay, failed, isAbort, unknownReceipt, withRequestDeadline } from './contract.ts';
import { loadOffset, offsetCursor } from './cursor.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';
import { createTelegramBotTransport } from './telegram-http.ts';

const TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u;
const VOICE_MIME = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'] as const;
const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const LIMITS: SessionLimits = {
  text_characters: TELEGRAM_TEXT_CHARACTERS, text_utf8_bytes: null,
  callback_data_bytes: TELEGRAM_CALLBACK_DATA_BYTES, voice_mime: VOICE_MIME,
  image_bytes: TELEGRAM_IMAGE_BYTES, file_bytes: TELEGRAM_FILE_BYTES,
};

type TelegramSpec = Extract<SessionSpec, { platform: 'telegram' }>;
interface TelegramFailure { ok: false; status: number; description: string }
interface TelegramSuccess { ok: true; result: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : undefined;
}
function textId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 64) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}
function nameOf(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  const parts = [value.first_name, value.last_name].filter((part): part is string =>
    typeof part === 'string' && part.length > 0);
  if (parts.length > 0) return parts.join(' ');
  return typeof value.username === 'string' && value.username.length > 0 ? value.username : undefined;
}
function topicName(value: unknown): string | undefined {
  const topic = record(value);
  return typeof topic?.name === 'string' && topic.name.length > 0 ? topic.name : undefined;
}
function timestampOf(message: Record<string, unknown>): number | undefined {
  if (typeof message.date !== 'number' || !Number.isSafeInteger(message.date) || message.date < 0) return undefined;
  const timestamp = message.date * 1000;
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}
function mentionInfo(message: Record<string, unknown>, selfUsername: string, accountId: string):
  { mentioned: boolean; mention_ids: readonly string[] } {
  const mentionIds = new Set<string>();
  let mentioned = false;
  const sources: { text: string | undefined; entities: unknown }[] = [
    { text: typeof message.text === 'string' ? message.text : undefined, entities: message.entities },
    { text: typeof message.caption === 'string' ? message.caption : undefined, entities: message.caption_entities },
  ];
  for (const source of sources) {
    if (source.text === undefined || !Array.isArray(source.entities)) continue;
    for (const value of source.entities) {
      const entity = record(value);
      if (!entity) continue;
      if (entity.type === 'text_mention') {
        const id = textId(record(entity.user)?.id);
        if (id) {
          mentionIds.add(id);
          if (id === accountId) mentioned = true;
        }
        continue;
      }
      if (entity.type !== 'mention' || selfUsername.length === 0) continue;
      const offset = entity.offset;
      const length = entity.length;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
          typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 ||
          !Number.isSafeInteger(offset + length)) continue;
      const valueAtEntity = source.text.slice(offset, offset + length);
      if (valueAtEntity.toLowerCase() === `@${selfUsername}`.toLowerCase()) {
        mentionIds.add(accountId);
        mentioned = true;
      }
    }
  }
  return { mentioned, mention_ids: [...mentionIds] };
}
function readCall(response: { http_status: number; body: unknown }): TelegramSuccess | TelegramFailure {
  const body = record(response.body);
  const description = typeof body?.description === 'string' ? body.description : '';
  if (body?.ok === true && response.http_status === 200) {
    return { ok: true, result: body.result };
  }
  const status = typeof body?.error_code === 'number' ? body.error_code : response.http_status;
  return { ok: false, status, description };
}
function mapFailure(failure: TelegramFailure): SessionReceipt {
  if (failure.status === 401) return failed('auth', 'telegram_auth');
  if (failure.status === 403) return failed('forbidden', 'telegram_forbidden');
  if (failure.status === 400) return failed('bad_format', 'telegram_bad_request');
  if (failure.status === 404) return failed('not_found', 'telegram_not_found');
  if (failure.status === 429) return failed('rate_limited', 'telegram_rate_limited');
  if (failure.status === 409) {
    const webhook = /webhook/iu.test(failure.description);
    return { status: 'conflict', message_ids: [], error_kind: 'conflict',
      diagnostic_code: webhook ? 'telegram_webhook_conflict' : 'telegram_poll_conflict' };
  }
  return unknownReceipt('telegram_response_unknown');
}
function webhookConflict(description: string): boolean {
  return /webhook/iu.test(description);
}
function safeFilePath(filePath: string): boolean {
  return filePath.length > 0 && filePath.length <= 512 && !filePath.includes('..') &&
    !filePath.includes('\\') && !filePath.includes('://') && !filePath.startsWith('/');
}
function buttonMarkup(buttons: readonly SessionButton[] | undefined):
  { ok: true; markup?: Record<string, unknown> } | { ok: false; receipt: SessionReceipt } {
  if (!buttons || buttons.length === 0) return { ok: true };
  const row = [];
  for (const button of buttons) {
    if (button.label.length < 1 || button.label.length > 64) {
      return { ok: false, receipt: failed('bad_format', 'telegram_button_label') };
    }
    const size = new TextEncoder().encode(button.data).byteLength;
    if (size < 1 || size > TELEGRAM_CALLBACK_DATA_BYTES) {
      return { ok: false, receipt: failed(size > TELEGRAM_CALLBACK_DATA_BYTES ? 'too_long' : 'bad_format', 'telegram_callback_data') };
    }
    row.push({ text: button.label, callback_data: button.data });
  }
  return { ok: true, markup: { inline_keyboard: [row] } };
}
function topicField(topic: string | undefined): Record<string, unknown> {
  if (!topic || topic === '0') return {};
  if (!/^-?\d{1,16}$/u.test(topic)) return {};
  const value = Number(topic);
  return Number.isSafeInteger(value) ? { message_thread_id: value } : {};
}

export function createTelegramSessionAdapter(spec: TelegramSpec, store: SessionCursorStore): SessionAdapter {
  if (spec.platform !== 'telegram') throw new Error('invalid_session_spec');
  const key = sessionFingerprint(spec);
  return shareSession(key, () => buildTelegram(spec, store, key));
}
function buildTelegram(spec: TelegramSpec, store: SessionCursorStore, key: string): SessionAdapter {
  const transport: TelegramBotTransport = spec.transport ?? createTelegramBotTransport(spec.token);
  const scope = cursorScope(spec.instance_id);
  const retry = spec.retry_ms ?? 1000;
  let accountId = '';
  let selfUsername = '';
  const acceptedKeys = new Set<string>();
  const adapter = {
    platform: 'telegram' as const,
    instance_id: spec.instance_id,
    get account(): SessionAccount { return { platform: 'telegram', account_id: accountId }; },
    limits: LIMITS,
    get state() { return run.state; },
    get connection_detail() { return run.detail; },
    start: (sink: SessionSink) => run.start((signal) => poll(signal, sink)),
    stop: () => run.stop(),
    send: (message: SessionOutbound, signal?: AbortSignal) => send(message, signal),
  };
  const run = createSessionRun(key, adapter, retry);

  async function call(request: TelegramCall, signal: AbortSignal) {
    return readCall(await transport.call(request, signal));
  }
  async function poll(signal: AbortSignal, sink: SessionSink): Promise<void> {
    if (signal.aborted) return;
    if (!TOKEN.test(spec.token)) { run.state = 'auth_expired'; return; }
    let me: TelegramSuccess | TelegramFailure;
    try { me = await call({ method: 'getMe' }, signal); }
    catch (error) {
      if (signal.aborted || isAbort(error)) return;
      await run.reconnect({ code: 'transport_error' }, signal);
      if (!signal.aborted) return poll(signal, sink);
      return;
    }
    if (signal.aborted) return;
    if (!me.ok) {
      if (me.status === 401) { run.state = 'auth_expired'; return; }
      await run.reconnect({ code: 'api_error', errcode: me.status }, signal);
      if (!signal.aborted) return poll(signal, sink);
      return;
    }
    const meRecord = record(me.result);
    accountId = textId(meRecord?.id) ?? '';
    selfUsername = typeof meRecord?.username === 'string' ? meRecord.username : '';
    if (!accountId) { run.state = 'auth_expired'; return; }
    const hook = await call({ method: 'getWebhookInfo' }, signal).catch(() => undefined);
    if (signal.aborted) return;
    if (!hook) {
      await run.reconnect({ code: 'transport_error' }, signal);
      if (!signal.aborted) return poll(signal, sink);
      return;
    }
    if (!hook.ok) {
      if (hook.status === 409 || webhookConflict(hook.description)) { run.state = 'conflict'; return; }
      if (hook.status === 401) { run.state = 'auth_expired'; return; }
      await run.reconnect({ code: 'api_error', errcode: hook.status }, signal);
      if (!signal.aborted) return poll(signal, sink);
      return;
    }
    const url = record(hook.result)?.url;
    if (typeof url === 'string' && url.length > 0) { run.state = 'conflict'; return; }
    let offset = await loadOffset(store, scope);
    run.state = 'running';
    while (!signal.aborted) {
      let page: TelegramSuccess | TelegramFailure;
      try {
        page = await withRequestDeadline(signal, spec.poll_timeout_ms ?? 35_000, (requestSignal) => call({ method: 'getUpdates', json: {
          ...(offset > 0 ? { offset } : {}), timeout: 25, limit: 100,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
        } }, requestSignal));
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        await run.reconnect({ code: 'transport_error' }, signal);
        continue;
      }
      if (signal.aborted) return;
      if (!page.ok) {
        if (page.status === 409) { run.state = 'conflict'; return; }
        if (page.status === 401) { run.state = 'auth_expired'; return; }
        await run.reconnect({ code: 'api_error', errcode: page.status }, signal);
        continue;
      }
      if (run.state !== 'running') run.state = 'running';
      const list = Array.isArray(page.result) ? page.result : [];
      let paused = false;
      for (const item of list) {
        const update = record(item);
        const updateId = update && typeof update.update_id === 'number' &&
          Number.isSafeInteger(update.update_id) ? update.update_id : undefined;
        if (!update || updateId === undefined) continue;
        const next = updateId + 1;
        const eventKey = `tg:${accountId}:${updateId}`;
        if (acceptedKeys.has(eventKey)) {
          offset = next;
          await store.save(scope, offsetCursor(offset));
          continue;
        }
        const inbound = await normalize(update, eventKey, String(updateId), signal);
        if (inbound === 'drop') {
          offset = next;
          await store.save(scope, offsetCursor(offset));
          continue;
        }
        if (!inbound) continue;
        let decision: SessionAdmit;
        try { decision = await sink.admit(inbound); }
        catch { decision = { decision: 'defer' }; }
        if (decision.decision !== 'accepted') { paused = true; break; }
        acceptedKeys.add(eventKey);
        offset = next;
        await store.save(scope, offsetCursor(offset));
        if (inbound.payload.type === 'callback' && decision.callback_ack !== undefined) {
          const text = decision.callback_ack.length <= 200 ? decision.callback_ack : undefined;
          await transport.call({ method: 'answerCallbackQuery', json: {
            callback_query_id: inbound.payload.callback_id, ...(text === undefined ? {} : { text }),
          } }, signal).catch(() => undefined);
        }
      }
      if (paused) {
        await delay(retry, signal);
      }
    }
  }
  async function normalize(update: Record<string, unknown>, eventKey: string, platformId: string,
    signal: AbortSignal): Promise<SessionInbound | 'drop' | undefined> {
    const callback = record(update.callback_query);
    if (callback) {
      const message = record(callback.message);
      const identity = identityOf(message, callback.from);
      if (!identity) return 'drop';
      const data = typeof callback.data === 'string' ? callback.data : '';
      const callbackId = textId(callback.id);
      if (!callbackId) return 'drop';
      return { event_key: eventKey, platform_event_id: platformId, identity,
        payload: { type: 'callback', callback_id: callbackId, data,
          ...(textId(message?.message_id) ? { message_id: textId(message?.message_id) } : {}) },
        cursor: offsetCursor((update.update_id as number) + 1) };
    }
    if (update.channel_post || update.edited_channel_post) return 'drop';
    const edited = record(update.edited_message);
    const message = edited ?? record(update.message);
    if (!message) return 'drop';
    if (message.sticker) return 'drop';
    const operation = edited ? 'edit' as const : 'create' as const;
    const identity = identityOf(message, message.from);
    if (!identity) return 'drop';
    const sourceMessageId = textId(message.message_id);
    const timestamp = timestampOf(message);
    const reply = record(message.reply_to_message);
    const replyToMessageId = textId(reply?.message_id);
    const mentions = mentionInfo(message, selfUsername, accountId);
    const cursor = offsetCursor((update.update_id as number) + 1);
    const base = { event_key: eventKey, platform_event_id: platformId, identity,
      ...(sourceMessageId === undefined ? {} : { source_message_id: sourceMessageId }), operation,
      ...(timestamp === undefined ? {} : { timestamp }), mentioned: mentions.mentioned,
      mention_ids: mentions.mention_ids,
      ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
      is_self: identity.sender_id === accountId, cursor };
    const caption = typeof message.caption === 'string' ? message.caption : undefined;
    if (typeof message.text === 'string' && !message.photo && !message.document && !message.voice) {
      return { ...base, payload: { type: 'text', text: message.text } };
    }
    const photo = Array.isArray(message.photo) ? record(message.photo[message.photo.length - 1]) : undefined;
    if (photo) return { ...base, payload: await mediaPayload('image', photo, 'photo.jpg', 'image/jpeg', caption, signal) };
    const voice = record(message.voice);
    if (voice) return { ...base, payload: await mediaPayload('voice', voice, 'voice.ogg', 'audio/ogg', caption, signal) };
    const document = record(message.document);
    if (document) {
      const name = typeof document.file_name === 'string' && document.file_name.length > 0 ?
        document.file_name.slice(0, 180) : 'file';
      const mime = typeof document.mime_type === 'string' ? document.mime_type : 'application/octet-stream';
      return { ...base, payload: await mediaPayload('file', document, name, mime, caption, signal) };
    }
    if (typeof message.text === 'string') return { ...base, payload: { type: 'text', text: message.text } };
    return 'drop';
  }
  async function mediaPayload(kind: 'image' | 'file' | 'voice', file: Record<string, unknown>,
    filename: string, mime: string, caption: string | undefined, signal: AbortSignal): Promise<SessionInbound['payload']> {
    const captionField = caption !== undefined && caption.length > 0 ? { caption } : {};
    const announced = typeof file.file_size === 'number' ? file.file_size : 0;
    if (announced > TELEGRAM_DOWNLOAD_BYTES) return { type: 'media_unavailable', kind, reason: 'too_large', ...captionField };
    const fileId = typeof file.file_id === 'string' ? file.file_id : '';
    if (!fileId) return { type: 'media_unavailable', kind, reason: 'download_failed', ...captionField };
    let info: TelegramSuccess | TelegramFailure;
    try { info = await call({ method: 'getFile', json: { file_id: fileId } }, signal); }
    catch { return { type: 'media_unavailable', kind, reason: 'download_failed', ...captionField }; }
    if (!info.ok) return { type: 'media_unavailable', kind, reason: 'download_failed', ...captionField };
    const infoResult = record(info.result);
    const remoteSize = typeof infoResult?.file_size === 'number' ? infoResult.file_size : announced;
    if (remoteSize > TELEGRAM_DOWNLOAD_BYTES) return { type: 'media_unavailable', kind, reason: 'too_large', ...captionField };
    const filePath = typeof infoResult?.file_path === 'string' ? infoResult.file_path : '';
    if (!safeFilePath(filePath)) return { type: 'media_unavailable', kind, reason: 'download_failed', ...captionField };
    const downloaded = await transport.download(filePath, signal).catch(() => ({ ok: false as const }));
    if (!downloaded.ok || downloaded.bytes.byteLength > TELEGRAM_DOWNLOAD_BYTES) {
      return { type: 'media_unavailable', kind, reason: downloaded.ok ? 'too_large' : 'download_failed', ...captionField };
    }
    const media: SessionMedia = { kind, filename, mime, bytes: downloaded.bytes };
    return { type: 'media', media, ...(caption === undefined ? {} : { caption }) };
  }
  function identityOf(message: Record<string, unknown> | undefined, from: unknown) {
    const chat = record(message?.chat);
    const sender = record(from);
    const chatId = textId(chat?.id);
    const senderId = textId(sender?.id);
    if (!chatId || !senderId) return undefined;
    const thread = textId(message?.message_thread_id) ?? '0';
    const kind = chat?.type === 'private' ? 'private' as const :
      chat?.type === 'group' || chat?.type === 'supergroup' ? 'group' as const : undefined;
    const chatTitle = typeof chat?.title === 'string' && chat.title.length > 0 ? chat.title : undefined;
    const senderName = nameOf(sender);
    const reply = record(message?.reply_to_message);
    const topicTitle = topicName(message?.forum_topic_created) ??
      topicName(message?.forum_topic_edited) ?? topicName(reply?.forum_topic_created);
    return { platform: 'telegram' as const, account_id: accountId, chat_id: chatId,
      sender_id: senderId, topic_id: thread, ...(kind ? { chat_kind: kind } : {}),
      ...(chatTitle === undefined ? {} : { chat_title: chatTitle }),
      ...(senderName === undefined ? {} : { sender_name: senderName }),
      ...(topicTitle === undefined ? {} : { topic_title: topicTitle }) };
  }
  async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
    if (signal?.aborted) return failed('cancelled', 'cancelled');
    const live = signal ?? new AbortController().signal;
    try {
      if (message.type === 'callback_ack') {
        const text = message.text && message.text.length <= 200 ? message.text : undefined;
        const answered = await call({ method: 'answerCallbackQuery', json: {
          callback_query_id: message.callback_id, ...(text === undefined ? {} : { text }),
        } }, live);
        return answered.ok ? accepted([]) : mapFailure(answered);
      }
      if (message.type === 'text' || message.type === 'edit_text') {
        if (message.text.length === 0) return failed('bad_format', 'session_empty_text');
        if (message.text.length > TELEGRAM_TEXT_CHARACTERS) return failed('too_long', 'telegram_text_too_long');
        const markup = buttonMarkup(message.buttons);
        if (!markup.ok) return markup.receipt;
        const json = { chat_id: message.target.chat_id, ...topicField(message.target.topic_id),
          text: message.text, ...(markup.markup ? { reply_markup: markup.markup } : {}) };
        const method = message.type === 'edit_text' ? 'editMessageText' : 'sendMessage';
        const edited = message.type === 'edit_text' ? { ...json, message_id: message.message_id } : json;
        const sent = await call({ method, json: edited }, live);
        if (!sent.ok) return mapFailure(sent);
        const id = textId(record(sent.result)?.message_id);
        return accepted(id ? [id] : []);
      }
      if (message.type === 'text_parts') {
        const ids: string[] = [];
        for (let index = 0; index < message.parts.length; index += 1) {
          const part = message.parts[index] ?? '';
          if (part.length === 0) return failed('bad_format', 'session_empty_text', { message_ids: ids, failed_part: index });
          if (part.length > TELEGRAM_TEXT_CHARACTERS) {
            return failed('too_long', 'telegram_text_too_long', { message_ids: ids, failed_part: index });
          }
          const sent = await call({ method: 'sendMessage', json: {
            chat_id: message.target.chat_id, ...topicField(message.target.topic_id), text: part,
          } }, live);
          if (!sent.ok) {
            const receipt = mapFailure(sent);
            return { ...receipt, message_ids: ids, failed_part: index };
          }
          const id = textId(record(sent.result)?.message_id);
          if (id) ids.push(id);
        }
        return accepted(ids);
      }
      return sendMedia(message.media, message.caption, message.target.chat_id, message.target.topic_id, live);
    } catch (error) {
      if (live.aborted || isAbort(error)) return unknownReceipt('cancelled_after_dispatch');
      return unknownReceipt('telegram_transport_unknown');
    }
  }
  async function sendMedia(media: SessionMedia, caption: string | undefined, chatId: string,
    topic: string | undefined, signal: AbortSignal): Promise<SessionReceipt> {
    if (media.kind === 'audio' || media.kind === 'video') return failed('unsupported', 'telegram_unsupported_media_kind');
    if (caption !== undefined && caption.length > TELEGRAM_CAPTION_CHARACTERS) {
      return failed('too_long', 'telegram_caption');
    }
    if (media.bytes.byteLength === 0) return failed('bad_format', 'telegram_empty_media');
    let method = '';
    let field = '';
    let limit = 0;
    if (media.kind === 'image') {
      if (!IMAGE_MIME.has(media.mime)) return failed('bad_format', 'telegram_image_type');
      method = 'sendPhoto'; field = 'photo'; limit = TELEGRAM_IMAGE_BYTES;
    } else if (media.kind === 'voice') {
      if (!VOICE_MIME.includes(media.mime as typeof VOICE_MIME[number])) {
        return failed('bad_format', 'telegram_voice_container');
      }
      method = 'sendVoice'; field = 'voice'; limit = TELEGRAM_VOICE_BYTES;
    } else {
      method = 'sendDocument'; field = 'document'; limit = TELEGRAM_FILE_BYTES;
    }
    if (media.bytes.byteLength > limit) return failed('too_long', `telegram_${media.kind}_too_large`);
    const sent = await call({ method, json: { chat_id: chatId, ...topicField(topic),
      ...(caption === undefined ? {} : { caption }) },
    file: { field, filename: media.filename || field, mime: media.mime, bytes: media.bytes } }, signal);
    if (!sent.ok) return mapFailure(sent);
    const id = textId(record(sent.result)?.message_id);
    return accepted(id ? [id] : []);
  }
  return adapter;
}
