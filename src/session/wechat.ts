import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SessionAccount, SessionAdapter, SessionCursorStore, SessionIdentity, SessionInbound,
  SessionLimits, SessionMedia, SessionOutbound, SessionReceipt, SessionSink, SessionSpec,
  WechatTransport } from './contract.ts';
import { accepted, cursorScope, delay, failed, isAbort, unknownReceipt, withRequestDeadline } from './contract.ts';
import { bufCursor, loadBuf } from './cursor.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';
import { createWechatTransport, wechatUrlAllowed } from './wechat-http.ts';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const BASE_INFO = { channel_version: '0.2.0', bot_agent: 'nb-im/0.2.0' };
const CLIENT_VERSION = '512';
const VOICE = new Map<string, number>([
  ['audio/amr', 5], ['audio/amr-wb', 5], ['audio/silk', 6], ['audio/x-silk', 6],
  ['audio/mpeg', 7], ['audio/mp3', 7], ['audio/ogg-speex', 8], ['audio/x-speex', 8],
]);
const LIMITS: SessionLimits = {
  text_characters: null, text_utf8_bytes: null, callback_data_bytes: null,
  voice_mime: [...VOICE.keys()], image_bytes: null, file_bytes: null,
};
const ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);
type WechatSpec = Extract<SessionSpec, { platform: 'personal_wechat' }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
    value as Record<string, unknown> : undefined;
}
/** Quote uint64 id fields before JSON.parse. Matches the official iLink scanner. */
export function parseWeixinApiJson(rawText: string): Record<string, unknown> {
  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') { output += rawText[index++] ?? ''; continue; }
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++] ?? '';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;
    let cursor = index;
    while (/\s/u.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;
    let key: unknown;
    try { key = JSON.parse(stringToken); } catch { continue; }
    if (typeof key !== 'string' || !ID_FIELDS.has(key)) continue;
    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/u.test(rawText[cursor] ?? '')) { output += rawText[cursor++] ?? ''; }
    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/u.test(rawText[cursor] ?? '')) cursor += 1;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else index = numberStart;
  }
  const parsed = record(JSON.parse(output) as unknown);
  if (!parsed) throw new Error('wechat_response_invalid');
  return parsed;
}
function headers(token: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0);
  return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(uin), 'utf8').toString('base64'),
    Authorization: `Bearer ${token}`, 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION };
}
function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/u, '')}/${path}`;
}
function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function decrypt(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function parseKey(hexKey: unknown, encoded: unknown): Buffer | undefined {
  if (typeof hexKey === 'string' && /^[0-9a-fA-F]{32}$/u.test(hexKey)) return Buffer.from(hexKey, 'hex');
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString('ascii');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(ascii)) return Buffer.from(ascii, 'hex');
  return undefined;
}
function sniff(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'application/octet-stream';
}
function voiceMime(encode: unknown): string {
  if (encode === 5) return 'audio/amr';
  if (encode === 7) return 'audio/mpeg';
  if (encode === 8) return 'audio/ogg-speex';
  if (encode === 6 || encode === undefined) return 'audio/silk';
  return 'application/octet-stream';
}
function mimeBase(mime: string): string {
  return mime.split(';', 1)[0]!.trim().toLowerCase();
}
function joinUrl(base: string, pathAndQuery: string): string {
  return `${base.replace(/\/$/u, '')}/${pathAndQuery.replace(/^\//u, '')}`;
}
function quotedText(text: string): string {
  let excerpt = '';
  let length = 0;
  for (const character of text) {
    if (length === 1024) return `${excerpt}…`;
    excerpt += character;
    length += 1;
  }
  return excerpt;
}

export function createWechatSessionAdapter(spec: WechatSpec, store: SessionCursorStore): SessionAdapter {
  if (spec.platform !== 'personal_wechat') throw new Error('invalid_session_spec');
  const key = sessionFingerprint(spec);
  return shareSession(key, () => buildWechat(spec, store, key));
}
function buildWechat(spec: WechatSpec, store: SessionCursorStore, key: string): SessionAdapter {
  const base = spec.base_url ?? BASE;
  const cdn = (spec.cdn_base_url ?? CDN).replace(/\/$/u, '');
  if (!wechatUrlAllowed(base) || !wechatUrlAllowed(cdn)) throw new Error('wechat_endpoint_rejected');
  const transport: WechatTransport = spec.transport ?? createWechatTransport();
  const scope = cursorScope(spec.instance_id);
  const retry = spec.retry_ms ?? 1000;
  const pollTimeout = spec.poll_timeout_ms ?? (spec.transport === undefined ? 40_000 : 35_000);
  let learned = spec.account_id ?? '';
  const seen = new Set<string>();
  const adapter = {
    platform: 'personal_wechat' as const,
    instance_id: spec.instance_id,
    get account(): SessionAccount {
      return { platform: 'personal_wechat', account_id: learned || 'wechat' };
    },
    limits: LIMITS,
    get state() { return run.state; },
    get connection_detail() { return run.detail; },
    start: (sink: SessionSink) => run.start((signal) => loop(signal, sink)),
    stop: () => run.stop(),
    send: (message: SessionOutbound, signal?: AbortSignal) => send(message, signal),
  };
  const run = createSessionRun(key, adapter, retry);

  async function post(path: string, body: unknown, signal: AbortSignal) {
    return transport.post(endpoint(base, path), headers(spec.token), JSON.stringify(body), signal);
  }
  async function loop(signal: AbortSignal, sink: SessionSink): Promise<void> {
    let buf = await loadBuf(store, scope);
    if (signal.aborted) return;
    try {
      await post('ilink/bot/msg/notifystart', { base_info: BASE_INFO }, signal).catch(() => undefined);
      while (!signal.aborted) {
        let response;
        try {
          response = await withRequestDeadline(signal, pollTimeout, (requestSignal) =>
            post('ilink/bot/getupdates', { get_updates_buf: buf, base_info: BASE_INFO }, requestSignal));
        } catch (error) {
          if (signal.aborted || isAbort(error)) break;
          await run.reconnect({ code: 'transport_error' }, signal);
          continue;
        }
        if (signal.aborted) break;
        if (response.status === 401) {
          run.state = 'auth_expired';
          run.detail = { code: 'auth_expired', http_status: response.status };
          break;
        }
        if (response.status !== 200) {
          await run.reconnect({ code: response.status === 0 ? 'transport_error' : 'http_error', http_status: response.status }, signal);
          continue;
        }
        let parsed: Record<string, unknown>;
        try { parsed = parseWeixinApiJson(response.body); }
        catch {
          await run.reconnect({ code: 'invalid_response', http_status: response.status }, signal);
          continue;
        }
        const ret = parsed.ret;
        const errcode = parsed.errcode;
        const codes = { http_status: response.status, ret: typeof ret === 'number' ? ret : undefined,
          errcode: typeof errcode === 'number' ? errcode : undefined };
        if (ret === -14 || errcode === -14) {
          run.state = 'auth_expired';
          run.detail = { code: 'auth_expired', ...codes };
          break;
        }
        if ((ret !== undefined && (typeof ret !== 'number' || !Number.isFinite(ret))) ||
            (errcode !== undefined && (typeof errcode !== 'number' || !Number.isFinite(errcode))) ||
            (parsed.msgs !== undefined && !Array.isArray(parsed.msgs)) ||
            (parsed.get_updates_buf !== undefined && typeof parsed.get_updates_buf !== 'string')) {
          await run.reconnect({ code: 'invalid_response', ...codes }, signal);
          continue;
        }
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          await run.reconnect({ code: 'api_error', ...codes }, signal);
          continue;
        }
        run.state = 'running';
        const nextBuf = typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : buf;
        const messages = Array.isArray(parsed.msgs) ? parsed.msgs : [];
        const batch: SessionInbound[] = [];
        let hold = false;
        for (const item of messages) {
          const message = record(item);
          if (!message || message.message_type === 2) continue;
          if (typeof message.message_state === 'number' && message.message_state !== 2) { hold = true; break; }
          batch.push(...await eventsFrom(message, signal, nextBuf));
        }
        if (hold) { await delay(retry, signal); continue; }
        let paused = false;
        for (const event of batch) {
          if (seen.has(event.event_key)) continue;
          let decision;
          try { decision = await sink.admit(event); }
          catch { decision = { decision: 'defer' as const }; }
          if (decision.decision !== 'accepted') { paused = true; break; }
          seen.add(event.event_key);
        }
        if (paused) { await delay(retry, signal); continue; }
        buf = nextBuf;
        await store.save(scope, bufCursor(buf));
        await delay(0, signal);
      }
    } finally {
      await post('ilink/bot/msg/notifystop', { base_info: BASE_INFO }, new AbortController().signal).catch(() => undefined);
    }
  }
  async function eventsFrom(message: Record<string, unknown>, signal: AbortSignal,
    nextBuf: string): Promise<SessionInbound[]> {
    const toUser = typeof message.to_user_id === 'string' ? message.to_user_id : '';
    if (!spec.account_id && toUser) learned = toUser;
    const accountId = spec.account_id || toUser || learned || 'wechat';
    const from = typeof message.from_user_id === 'string' ? message.from_user_id : '';
    const group = typeof message.group_id === 'string' && message.group_id.length > 0 ? message.group_id : '';
    const identity: SessionIdentity = { platform: 'personal_wechat', account_id: accountId, chat_id: from,
      sender_id: from, topic_id: group || '0', chat_kind: group ? 'group' : 'private' };
    const context = typeof message.context_token === 'string' ? message.context_token : undefined;
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    const events: SessionInbound[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = record(items[index]);
      if (!item) continue;
      const messageId = typeof message.message_id === 'string' ? message.message_id :
        typeof item.msg_id === 'string' ? item.msg_id : '';
      if (!messageId) continue;
      const eventKey = `wx:${accountId}:${messageId}:${index}`;
      const cursor = bufCursor(nextBuf);
      const referenced = record(record(item.ref_msg)?.message_item);
      const replyId = typeof referenced?.msg_id === 'string' && referenced.msg_id.trim() ? referenced.msg_id : undefined;
      const referenceText = record(referenced?.text_item)?.text;
      const quote = typeof referenceText === 'string' && referenceText.trim() ? quotedText(referenceText) : undefined;
      const base = { event_key: eventKey, platform_event_id: messageId, identity, cursor,
        ...(replyId === undefined ? {} : { reply_to_message_id: replyId }),
        ...(quote === undefined ? {} : { quoted_text: quote }),
        ...(context ? { reply_context: context } : {}) };
      const type = item.type;
      if (type === 1) {
        const text = typeof record(item.text_item)?.text === 'string' ? record(item.text_item)?.text as string : '';
        events.push({ ...base, payload: { type: 'text', text } });
      } else if (type === 2 || type === 3 || type === 4) {
        events.push({ ...base, payload: await mediaPayload(item, type, signal) });
      }
    }
    return events;
  }
  async function mediaPayload(item: Record<string, unknown>, type: number, signal: AbortSignal): Promise<SessionInbound['payload']> {
    const kind = type === 2 ? 'image' as const : type === 3 ? 'voice' as const : 'file' as const;
    const container = type === 2 ? record(item.image_item) : type === 3 ? record(item.voice_item) : record(item.file_item);
    const media = record(container?.media);
    const loaded = await downloadMedia(media, container?.aeskey, signal);
    if (loaded === 'failed') return { type: 'media_unavailable', kind, reason: 'download_failed' };
    const filename = kind === 'voice' ? 'voice' : typeof container?.file_name === 'string' ? container.file_name : kind;
    const mime = kind === 'voice' ? voiceMime(container?.encode_type) : kind === 'image' ? sniff(loaded) : 'application/octet-stream';
    return { type: 'media', media: { kind, filename, mime, bytes: loaded } };
  }
  async function downloadMedia(media: Record<string, unknown> | undefined, hexKey: unknown,
    signal: AbortSignal): Promise<Uint8Array | 'failed'> {
    const full = typeof media?.full_url === 'string' ? media.full_url : '';
    const param = typeof media?.encrypt_query_param === 'string' ? media.encrypt_query_param : '';
    const url = full && wechatUrlAllowed(full) ? full :
      param ? joinUrl(cdn, `download?encrypted_query_param=${encodeURIComponent(param)}`) : '';
    if (!url) return 'failed';
    const response = await transport.getBytes(url, signal).catch(() => undefined);
    if (!response || response.status !== 200 || response.body.byteLength === 0) return 'failed';
    const key = parseKey(hexKey, media?.aes_key);
    if (!key) return 'failed';
    try { return decrypt(Buffer.from(response.body), key); }
    catch { return 'failed'; }
  }
  async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
    if ('target' in message && (message.target.chat_kind === 'group' || (message.target.topic_id !== undefined && message.target.topic_id !== '0'))) {
      return failed('unsupported', 'wechat_group_unsupported');
    }
    if (message.type === 'edit_text') return failed('unsupported', 'wechat_unsupported_edit');
    if (message.type === 'callback_ack' || ('buttons' in message && message.buttons && message.buttons.length > 0)) {
      return failed('unsupported', 'wechat_unsupported_callback');
    }
    if (signal?.aborted) return failed('cancelled', 'cancelled');
    const live = signal ?? new AbortController().signal;
    try {
      if (message.type === 'text') return sendText(message.target.chat_id, message.target.reply_context, message.text, live);
      if (message.type === 'text_parts') {
        const ids: string[] = [];
        for (let index = 0; index < message.parts.length; index += 1) {
          const receipt = await sendText(message.target.chat_id, message.target.reply_context, message.parts[index] ?? '', live);
          if (receipt.status !== 'accepted') return { ...receipt, message_ids: ids, failed_part: index };
          ids.push(...receipt.message_ids);
        }
        return accepted(ids);
      }
      return sendMedia(message.target.chat_id, message.target.reply_context, message.media, message.caption, live);
    } catch (error) {
      if (live.aborted || isAbort(error)) return unknownReceipt('cancelled_after_dispatch');
      return unknownReceipt('wechat_transport_unknown');
    }
  }
  async function sendText(chatId: string, context: string | undefined, text: string, signal: AbortSignal): Promise<SessionReceipt> {
    if (text.length === 0) return failed('bad_format', 'session_empty_text');
    return finishSend(await post('ilink/bot/sendmessage', messageBody(chatId, context, [
      { type: 1, text_item: { text } }]), signal), spec.token);
  }
  async function sendMedia(chatId: string, context: string | undefined, media: SessionMedia,
    caption: string | undefined, signal: AbortSignal): Promise<SessionReceipt> {
    if (media.kind === 'audio' || media.kind === 'video') return failed('unsupported', 'wechat_unsupported_media_kind');
    if (media.bytes.byteLength === 0) return failed('bad_format', 'wechat_empty_media');
    const encode = media.kind === 'voice' ? VOICE.get(mimeBase(media.mime)) : undefined;
    if (media.kind === 'voice' && encode === undefined) return failed('bad_format', 'wechat_voice_container');
    const mediaType = media.kind === 'image' ? 1 : media.kind === 'voice' ? 4 : 3;
    const uploaded = await upload(chatId, media, mediaType, signal);
    if ('status' in uploaded) return uploaded;
    const item = media.kind === 'image' ? { type: 2, image_item: { media: uploaded.media, mid_size: uploaded.cipherSize } } :
      media.kind === 'voice' ? { type: 3, voice_item: { media: uploaded.media, encode_type: encode } } :
      { type: 4, file_item: { media: uploaded.media, file_name: media.filename || 'file', len: String(media.bytes.byteLength) } };
    const items = caption ? [{ type: 1, text_item: { text: caption } }, item] : [item];
    return finishSend(await post('ilink/bot/sendmessage', messageBody(chatId, context, items), signal), spec.token);
  }
  async function upload(chatId: string, media: SessionMedia, mediaType: number, signal: AbortSignal):
    Promise<SessionReceipt | { media: Record<string, unknown>; cipherSize: number }> {
    const plaintext = Buffer.from(media.bytes);
    const aes = randomBytes(16);
    const filekey = randomBytes(16).toString('hex');
    const cipherSize = Math.ceil((plaintext.length + 1) / 16) * 16;
    const response = await post('ilink/bot/getuploadurl', {
      filekey, media_type: mediaType, to_user_id: chatId, rawsize: plaintext.length,
      rawfilemd5: createHash('md5').update(plaintext).digest('hex'), filesize: cipherSize,
      no_need_thumb: true, aeskey: aes.toString('hex'), base_info: BASE_INFO,
    }, signal);
    let parsed: Record<string, unknown>;
    try { parsed = parseWeixinApiJson(response.body); }
    catch { return unknownReceipt('wechat_unconfirmed'); }
    if (response.status === 401 || parsed.ret === -14 || parsed.errcode === -14) return failed('auth', 'wechat_auth');
    if (response.status === 0) return unknownReceipt('wechat_unconfirmed');
    if (response.status !== 200 || (typeof parsed.ret === 'number' && parsed.ret !== 0) ||
        (typeof parsed.errcode === 'number' && parsed.errcode !== 0)) {
      return failed('unknown', 'wechat_rejected');
    }
    const full = typeof parsed.upload_full_url === 'string' ? parsed.upload_full_url : '';
    const param = typeof parsed.upload_param === 'string' ? parsed.upload_param : '';
    const target = full && wechatUrlAllowed(full) ? full :
      param ? joinUrl(cdn, `upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`) : '';
    if (!target) return failed('unknown', 'wechat_upload');
    const posted = await transport.postBytes(target, { 'Content-Type': 'application/octet-stream' },
      encrypt(plaintext, aes), signal);
    const downloadParam = posted.headers?.['x-encrypted-param'];
    if (posted.status !== 200 || !downloadParam) return failed('unknown', 'wechat_upload');
    return { cipherSize, media: { encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aes.toString('hex'), 'utf8').toString('base64'), encrypt_type: 1 } };
  }
  return adapter;
}
function messageBody(chatId: string, context: string | undefined, itemList: unknown[]): Record<string, unknown> {
  return { msg: { from_user_id: '', to_user_id: chatId,
    client_id: `nbim_${randomBytes(8).toString('hex')}`, message_type: 2, message_state: 2,
    item_list: itemList, ...(context ? { context_token: context } : {}) }, base_info: BASE_INFO };
}
function finishSend(response: { status: number; body: string }, token: string): SessionReceipt {
  if (response.status === 401) return failed('auth', 'wechat_auth');
  if (response.status === 0) return unknownReceipt('wechat_unconfirmed');
  let parsed: Record<string, unknown>;
  try { parsed = parseWeixinApiJson(response.body); }
  catch { return unknownReceipt('wechat_unconfirmed'); }
  const ret = parsed.ret;
  const errcode = parsed.errcode;
  if (ret === -14 || errcode === -14) return failed('auth', 'wechat_auth');
  if (response.status >= 400 || (typeof ret === 'number' && ret !== 0) ||
      (typeof errcode === 'number' && errcode !== 0) || parsed.errmsg === token) {
    return failed('unknown', 'wechat_rejected');
  }
  if (response.status !== 200 || (ret !== undefined && ret !== 0) ||
      (errcode !== undefined && errcode !== 0)) return unknownReceipt('wechat_unconfirmed');
  const id = typeof parsed.message_id === 'string' && parsed.message_id.trim() ? parsed.message_id : '';
  if (ret !== 0 && !id) return unknownReceipt('wechat_unconfirmed');
  return accepted(id ? [id] : []);
}
