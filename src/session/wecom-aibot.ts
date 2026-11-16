import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebSocket } from 'ws';
import { publicAddress } from '../http-transport.ts';
import type { SessionAdapter, SessionCursorStore, SessionInbound, SessionInboundPart, SessionMedia, SessionMediaKind,
  SessionOutbound, SessionReceipt, SessionSpec, SessionTarget, WecomAibotDownload, WecomAibotLink,
  WecomAibotTransport } from './contract.ts';
import { abortError, accepted, cursorScope, delay, failed, unknownReceipt, utf8Size,
  WECOM_AIBOT_MARKDOWN_UTF8_BYTES } from './contract.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';

// WeCom AI bot (企业微信智能机器人), API mode over the long connection (developer.work.weixin.qq.com/document/path/101463).
// Frames are `{cmd, headers: {req_id}, body}`; acks are `{headers: {req_id}, errcode, errmsg, body?}`. Wire names follow
// the official @wecom/aibot-node-sdk 1.0.7. One live connection per bot: a newer subscribe gets the old one a
// `disconnected_event`, after which this adapter stops (state `conflict`) instead of fighting for the bot.
//
// Receives: every DM message (text, image, mixed, voice as its transcript, file, video) and, in groups, only messages that
// @ the bot (text, mixed, quote). Callbacks carry the sender's userid and the group's chatid; no names or titles.
// Sends: the first reply to a fresh callback answers it (`aibot_respond_msg`, one finished stream); everything else is a
// push (`aibot_send_msg`, markdown or media), which WeCom allows in chats where the user has talked to the bot.

type WecomSpec = Extract<SessionSpec, { platform: 'wecom_aibot' }>;
type Frame = { cmd?: string; headers?: { req_id?: string }; body?: unknown; errcode?: number; errmsg?: string };
type Ack = { kind: 'ack'; errcode: number; body: Record<string, unknown> } | { kind: 'timeout' } | { kind: 'closed' };

export const WECOM_AIBOT_URL = 'wss://openws.work.weixin.qq.com';
const MiB = 1024 * 1024;
const LIMITS = { image: 10 * MiB, video: 10 * MiB, voice: 2 * MiB, file: 20 * MiB, inbound: 30 * MiB };
const CHUNK = 512 * 1024;
/** A callback can be answered directly this long; later replies are pushes. */
const RESPOND_WINDOW_MS = 5 * 60_000;
const RATE_LIMITED = new Set([45009, 45033, 45047]);
const BAD_FORMAT = new Set([40008, 40058, 44004, 40003]);
const FORBIDDEN = new Set([48002, 60011, 60020, 81013]);

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const reqId = (prefix: string): string => `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`;

/** AES-256-CBC, IV = first 16 key bytes, PKCS#7 padded to 32 bytes (so Node's own unpadding cannot be used). */
export function decryptWecomMedia(bytes: Uint8Array, aeskey: string): Uint8Array {
  const key = Buffer.from(aeskey, 'base64');
  if (key.length !== 32 || bytes.byteLength === 0 || bytes.byteLength % 16 !== 0) throw new Error('wecom_media_key');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
  const pad = plain[plain.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('wecom_media_padding');
  for (let i = plain.length - pad; i < plain.length; i++) if (plain[i] !== pad) throw new Error('wecom_media_padding');
  return new Uint8Array(plain.subarray(0, plain.length - pad));
}

function sniffImage(bytes: Uint8Array): { mime: string; ext: string } {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return { mime: 'image/webp', ext: 'webp' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}
const EXT_MIME: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', log: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

function quoteText(raw: unknown): string | undefined {
  const q = object(raw);
  const type = str(q.msgtype);
  if (!type) return undefined;
  if (type === 'text') return str(object(q.text).content) || undefined;
  if (type === 'voice') return str(object(q.voice).content) || undefined;
  if (type === 'mixed') {
    const items = Array.isArray(object(q.mixed).msg_item) ? object(q.mixed).msg_item as unknown[] : [];
    return items.map((i) => str(object(i).msgtype) === 'text' ? str(object(object(i).text).content) : '[图片]').join(' ') || undefined;
  }
  return type === 'image' ? '[图片]' : type === 'file' ? '[文件]' : type === 'video' ? '[视频]' : undefined;
}

/** Pinned public HTTPS download, redirects re-resolved; never a private address. */
async function fetchPublic(raw: string, cap: number, signal: AbortSignal, redirects = 0): Promise<WecomAibotDownload> {
  if (signal.aborted) throw abortError();
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return { ok: false };
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let ips: string[];
  if (isIP(host)) ips = [host];
  else {
    const answers = await Promise.allSettled([resolve4(host), resolve6(host)]);
    ips = answers.flatMap((a) => a.status === 'fulfilled' ? a.value : []);
  }
  if (!ips.length || ips.some((ip) => !publicAddress(ip))) return { ok: false };
  const ip = ips.find((x) => isIP(x) === 4) ?? ips[0]!;
  return new Promise((resolve) => {
    const req = https.request({ hostname: host, servername: isIP(host) ? undefined : host, port: url.port || 443,
      path: url.pathname + url.search, method: 'GET', agent: false, signal, timeout: 20_000,
      lookup: (_h, _o, callback) => callback(null, ip, isIP(ip) as 4 | 6) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume();
        fetchPublic(new URL(res.headers.location, url).href, cap, signal, redirects + 1).then(resolve, () => resolve({ ok: false }));
        return;
      }
      if (status !== 200) { res.resume(); resolve({ ok: false }); return; }
      if (Number(res.headers['content-length'] ?? 0) > cap) { res.resume(); req.destroy(); resolve({ ok: false, too_large: true }); return; }
      const disposition = String(res.headers['content-disposition'] ?? '');
      const star = /filename\*=UTF-8''([^;\s]+)/iu.exec(disposition)?.[1];
      const plain = /filename="?([^";]+)"?/iu.exec(disposition)?.[1];
      let filename: string | undefined;
      try { filename = star ? decodeURIComponent(star) : plain ? decodeURIComponent(plain) : undefined; } catch { filename = plain; }
      const mime = String(res.headers['content-type'] ?? '').split(';')[0]?.trim() || undefined;
      let size = 0; let over = false; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) { over = true; req.destroy(); } else chunks.push(chunk);
      });
      res.on('error', () => resolve(over ? { ok: false, too_large: true } : { ok: false }));
      res.on('end', () => resolve(over ? { ok: false, too_large: true } :
        { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)), ...(filename ? { filename } : {}), ...(mime ? { mime } : {}) }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

export function createWecomAibotTransport(): WecomAibotTransport {
  return {
    connect(url, signal) {
      return new Promise<WecomAibotLink>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        const socket = new WebSocket(url, { handshakeTimeout: 15_000 });
        const frames: Array<(frame: unknown) => void> = [];
        const closes: Array<() => void> = [];
        let open = false;
        let closed = false;
        const onAbort = (): void => socket.terminate();
        signal.addEventListener('abort', onAbort, { once: true });
        socket.once('open', () => {
          open = true;
          resolve({
            send(frame) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); },
            onFrame(handler) { frames.push(handler); },
            onClose(handler) { if (closed) handler(); else closes.push(handler); },
            close() { socket.terminate(); },
          });
        });
        socket.on('message', (data) => {
          const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
          let frame: unknown;
          try { frame = JSON.parse(text); } catch { return; }
          for (const handler of frames) handler(frame);
        });
        socket.on('error', () => { if (!open) reject(new Error('wecom_connect_failed')); socket.terminate(); });
        socket.on('close', () => {
          closed = true;
          signal.removeEventListener('abort', onAbort);
          if (!open) reject(new Error('wecom_connect_failed'));
          for (const handler of closes.splice(0)) handler();
        });
      });
    },
    download: (url, cap, signal) => fetchPublic(url, cap, signal).catch(() => ({ ok: false })),
  };
}

interface Live {
  request(cmd: string, body: unknown, id: string, timeoutMs: number): Promise<Ack>;
  close(): void;
  ended: Promise<'closed' | 'conflict'>;
}

export function createWecomAibotSessionAdapter(spec: WecomSpec, store: SessionCursorStore): SessionAdapter {
  const key = sessionFingerprint(spec);
  return shareSession(key, () => {
    const transport = spec.transport ?? createWecomAibotTransport();
    const url = spec.ws_url ?? WECOM_AIBOT_URL;
    const scope = cursorScope(spec.instance_id);
    const heartbeatMs = spec.heartbeat_ms ?? 30_000;
    const ackMs = spec.ack_timeout_ms ?? 10_000;
    const limits = { text_characters: 5000, text_utf8_bytes: WECOM_AIBOT_MARKDOWN_UTF8_BYTES, callback_data_bytes: null,
      voice_mime: ['audio/amr'] as const, image_bytes: LIMITS.image, file_bytes: LIMITS.file };
    let current: Live | undefined;
    let liveSignal: AbortSignal | undefined;
    let recent: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const answered = new Map<string, number>();

    function open(link: WecomAibotLink, sink: Parameters<SessionAdapter['start']>[0], signal: AbortSignal): Live {
      const pending = new Map<string, (ack: Ack) => void>();
      let finish!: (how: 'closed' | 'conflict') => void;
      const ended = new Promise<'closed' | 'conflict'>((resolve) => { finish = resolve; });
      let done = false;
      const end = (how: 'closed' | 'conflict'): void => {
        if (done) return;
        done = true;
        for (const settle of pending.values()) settle({ kind: 'closed' });
        pending.clear();
        finish(how);
      };
      link.onClose(() => end('closed'));
      link.onFrame((raw) => {
        const frame = object(raw) as Frame;
        const id = str(object(frame.headers).req_id);
        if (frame.cmd === 'aibot_msg_callback') {
          chain = chain.then(() => inbound(frame, sink, signal)).catch(() => undefined);
          return;
        }
        if (frame.cmd === 'aibot_event_callback') {
          if (str(object(object(frame.body).event).eventtype) === 'disconnected_event') { end('conflict'); link.close(); }
          return;
        }
        if (frame.cmd) return;
        const settle = pending.get(id);
        if (!settle) return;
        pending.delete(id);
        settle({ kind: 'ack', errcode: typeof frame.errcode === 'number' ? frame.errcode : -1, body: object(frame.body) });
      });
      return {
        ended,
        close: () => link.close(),
        request(cmd, body, id, timeoutMs) {
          if (done) return Promise.resolve({ kind: 'closed' });
          return new Promise<Ack>((resolve) => {
            const timer = setTimeout(() => { if (pending.get(id) === settle) pending.delete(id); resolve({ kind: 'timeout' }); }, timeoutMs);
            const settle = (ack: Ack): void => { clearTimeout(timer); resolve(ack); };
            pending.set(id, settle);
            link.send(body === undefined ? { cmd, headers: { req_id: id } } : { cmd, headers: { req_id: id }, body });
          });
        },
      };
    }

    async function media(kind: SessionMediaKind, raw: unknown, signal: AbortSignal): Promise<SessionInboundPart> {
      const item = object(raw);
      const link = str(item.url);
      if (!link) return { type: 'media_unavailable', kind, reason: 'download_failed' };
      const got = await transport.download(link, LIMITS.inbound, signal).catch(() => ({ ok: false } as WecomAibotDownload));
      if (!got.ok || !got.bytes) return { type: 'media_unavailable', kind, reason: got.too_large ? 'too_large' : 'download_failed' };
      let bytes = got.bytes;
      const aeskey = str(item.aeskey);
      if (aeskey) {
        try { bytes = decryptWecomMedia(bytes, aeskey); } catch { return { type: 'media_unavailable', kind, reason: 'download_failed' }; }
      }
      let filename = got.filename?.slice(0, 255);
      let mime = got.mime && got.mime !== 'application/octet-stream' ? got.mime : undefined;
      if (kind === 'image') {
        const sniffed = sniffImage(bytes);
        mime = sniffed.mime;
        filename ??= `image.${sniffed.ext}`;
      } else if (kind === 'video') {
        mime ??= 'video/mp4';
        filename ??= 'video.mp4';
      } else {
        filename ??= 'file';
        mime ??= EXT_MIME[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
      }
      const out: SessionMedia = { kind, filename, mime: mime ?? 'application/octet-stream', bytes };
      return { type: 'media', media: out };
    }

    async function payloadOf(body: Record<string, unknown>, signal: AbortSignal): Promise<SessionInbound['payload'] | undefined> {
      const type = str(body.msgtype);
      if (type === 'text') { const text = str(object(body.text).content); return text ? { type: 'text', text } : undefined; }
      if (type === 'voice') { const text = str(object(body.voice).content); return text ? { type: 'text', text } : undefined; }
      if (type === 'image' || type === 'file' || type === 'video') {
        const part = await media(type, body[type], signal);
        return part.type === 'media' ? { type: 'media', media: part.media } :
          part.type === 'media_unavailable' ? { type: 'media_unavailable', kind: part.kind, reason: part.reason } : undefined;
      }
      if (type === 'mixed') {
        const items = Array.isArray(object(body.mixed).msg_item) ? object(body.mixed).msg_item as unknown[] : [];
        const parts: SessionInboundPart[] = [];
        for (const raw of items) {
          const item = object(raw);
          if (str(item.msgtype) === 'text') { const text = str(object(item.text).content); if (text) parts.push({ type: 'text', text }); }
          else if (str(item.msgtype) === 'image') parts.push(await media('image', item.image, signal));
        }
        return parts.length ? { type: 'parts', parts } : undefined;
      }
      return undefined;
    }

    async function inbound(frame: Frame, sink: Parameters<SessionAdapter['start']>[0], signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      const body = object(frame.body);
      const msgid = str(body.msgid);
      const group = str(body.chattype) === 'group';
      const sender = str(object(body.from).userid);
      const chat = group ? str(body.chatid) : sender;
      if (!msgid || !sender || !chat) return;
      const eventKey = `wecom_aibot:${spec.bot_id}:${msgid}`;
      if (recent.includes(eventKey)) return;
      const payload = await payloadOf(body, signal);
      if (!payload || signal.aborted) return;
      const quoted = quoteText(body.quote);
      const created = Number(body.create_time);
      const event: SessionInbound = {
        event_key: eventKey, platform_event_id: msgid, source_message_id: msgid, operation: 'create',
        identity: { platform: 'wecom_aibot', account_id: spec.bot_id, chat_id: chat, sender_id: sender, topic_id: '0',
          chat_kind: group ? 'group' : 'private' },
        payload,
        ...(Number.isSafeInteger(created) && created > 0 ? { timestamp: created * 1000 } : {}),
        // A group callback only exists because someone @'d the bot; a DM is always addressed to it.
        mentioned: true,
        ...(quoted ? { quoted_text: quoted } : {}),
        reply_context: JSON.stringify({ r: str(object(frame.headers).req_id), t: Date.now() }),
        cursor: msgid,
      };
      while (!signal.aborted) {
        const admitted = await sink.admit(event).catch(() => ({ decision: 'defer' as const }));
        if (admitted.decision === 'accepted') {
          recent = [...recent, eventKey].slice(-512);
          await store.save(`${scope}:recent`, JSON.stringify(recent)).catch(() => undefined);
          return;
        }
        await delay(spec.retry_ms ?? 1000, signal);
      }
    }

    const adapter: SessionAdapter = {
      platform: 'wecom_aibot', instance_id: spec.instance_id,
      account: { platform: 'wecom_aibot', account_id: spec.bot_id },
      limits,
      get state() { return run.state; },
      get connection_detail() { return run.detail; },
      start: (sink) => run.start(async (signal) => {
        liveSignal = signal;
        const saved = await store.load(`${scope}:recent`).catch(() => undefined);
        if (saved) { try { const v: unknown = JSON.parse(saved); if (Array.isArray(v)) recent = v.filter((s): s is string => typeof s === 'string').slice(-512); } catch { /* Not a cursor. */ } }
        let authFailures = 0;
        while (!signal.aborted) {
          let link: WecomAibotLink;
          try { link = await transport.connect(url, signal); }
          catch {
            if (signal.aborted) break;
            await run.reconnect({ code: 'transport_error' }, signal);
            continue;
          }
          const live = open(link, sink, signal);
          const ack = await live.request('aibot_subscribe', { bot_id: spec.bot_id, secret: spec.secret }, reqId('aibot_subscribe'), ackMs);
          if (ack.kind === 'ack' && ack.errcode === 0) {
            authFailures = 0;
            current = live;
            run.state = 'running';
            let waiting = false;
            let missed = 0;
            const beat = setInterval(() => {
              if (waiting && ++missed >= 2) { live.close(); return; }
              waiting = true;
              void live.request('ping', undefined, reqId('ping'), heartbeatMs).then((a) => {
                if (a.kind === 'ack') { waiting = false; missed = 0; }
              });
            }, heartbeatMs);
            const onAbort = (): void => live.close();
            signal.addEventListener('abort', onAbort, { once: true });
            const how = await live.ended;
            clearInterval(beat);
            signal.removeEventListener('abort', onAbort);
            if (current === live) current = undefined;
            if (how === 'conflict') { run.state = 'conflict'; break; }
            if (signal.aborted) break;
            await run.reconnect({ code: 'transport_error' }, signal);
            continue;
          }
          live.close();
          if (signal.aborted) break;
          if (ack.kind === 'ack') {
            // Subscribe is rate limited, so wrong credentials are retried slowly and given up after three answers.
            if (++authFailures >= 3) { run.state = 'auth_expired'; break; }
            await run.reconnect({ code: 'api_error', errcode: ack.errcode }, signal);
          } else await run.reconnect({ code: 'transport_error' }, signal);
        }
        current = undefined;
        await chain;
      }),
      stop: () => run.stop(),
      send,
    };
    const run = createSessionRun(key, adapter, spec.retry_ms);

    const errorKind = (code: number): NonNullable<SessionReceipt['error_kind']> =>
      RATE_LIMITED.has(code) ? 'rate_limited' : BAD_FORMAT.has(code) ? 'bad_format' : FORBIDDEN.has(code) ? 'forbidden' : 'unknown';

    /** Answer the callback once while it is fresh, otherwise push into the chat. */
    async function deliver(live: Live, target: SessionTarget, body: Record<string, unknown>, respond: Record<string, unknown>): Promise<SessionReceipt> {
      let context: { r?: unknown; t?: unknown } = {};
      try { context = object(JSON.parse(target.reply_context ?? '{}')); } catch { context = {}; }
      const callback = str(context.r);
      const at = Number(context.t);
      const now = Date.now();
      for (const [id, when] of answered) if (now - when > 2 * RESPOND_WINDOW_MS) answered.delete(id);
      if (callback && Number.isFinite(at) && now - at < RESPOND_WINDOW_MS && !answered.has(callback)) {
        answered.set(callback, now);
        const ack = await live.request('aibot_respond_msg', respond, callback, ackMs);
        if (ack.kind === 'ack' && ack.errcode === 0) return accepted([callback]);
        if (ack.kind !== 'ack') return unknownReceipt(ack.kind === 'closed' ? 'wecom_aibot_closed_after_dispatch' : 'wecom_aibot_ack_timeout');
      }
      const id = reqId('aibot_send_msg');
      const chatType = target.chat_kind === 'group' ? 2 : target.chat_kind === 'private' ? 1 : 0;
      const ack = await live.request('aibot_send_msg', { chatid: target.chat_id, chat_type: chatType, ...body }, id, ackMs);
      if (ack.kind !== 'ack') return unknownReceipt(ack.kind === 'closed' ? 'wecom_aibot_closed_after_dispatch' : 'wecom_aibot_ack_timeout');
      return ack.errcode === 0 ? accepted([id]) : failed(errorKind(ack.errcode), `wecom_aibot_errcode_${Math.abs(ack.errcode)}`);
    }

    /** Temporary material over the connection: init, 512 KB chunks, finish → media_id (valid three days). */
    async function upload(live: Live, type: string, m: SessionMedia): Promise<string | SessionReceipt> {
      const bytes = Buffer.from(m.bytes);
      const total = Math.ceil(bytes.length / CHUNK);
      if (total < 1 || total > 100 || bytes.length < 5) return failed('too_long', 'wecom_aibot_media_size');
      const md5 = createHash('md5').update(bytes).digest('hex');
      const init = await live.request('aibot_upload_media_init', { type, filename: m.filename.slice(0, 200) || 'file',
        total_size: bytes.length, total_chunks: total, md5 }, reqId('aibot_upload_media_init'), ackMs);
      if (init.kind !== 'ack') return failed('unknown', 'wecom_aibot_upload_timeout');
      if (init.errcode !== 0) return failed(errorKind(init.errcode), `wecom_aibot_errcode_${Math.abs(init.errcode)}`);
      const uploadId = str(init.body.upload_id);
      if (!uploadId) return failed('unknown', 'wecom_aibot_upload_invalid');
      for (let index = 0; index < total; index++) {
        const chunk = bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK));
        const ack = await live.request('aibot_upload_media_chunk', { upload_id: uploadId, chunk_index: index,
          base64_data: chunk.toString('base64') }, reqId('aibot_upload_media_chunk'), ackMs * 3);
        if (ack.kind !== 'ack') return failed('unknown', 'wecom_aibot_upload_timeout');
        if (ack.errcode !== 0) return failed(errorKind(ack.errcode), `wecom_aibot_errcode_${Math.abs(ack.errcode)}`);
      }
      const finish = await live.request('aibot_upload_media_finish', { upload_id: uploadId }, reqId('aibot_upload_media_finish'), ackMs * 3);
      if (finish.kind !== 'ack') return failed('unknown', 'wecom_aibot_upload_timeout');
      if (finish.errcode !== 0) return failed(errorKind(finish.errcode), `wecom_aibot_errcode_${Math.abs(finish.errcode)}`);
      return str(finish.body.media_id) || failed('unknown', 'wecom_aibot_upload_invalid');
    }

    async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
      if (signal?.aborted || liveSignal?.aborted) return failed('cancelled', 'cancelled');
      if (message.type === 'callback_ack') return accepted([]);
      if (message.type === 'edit_text') return failed('unsupported', 'wecom_aibot_edit_unsupported');
      if (message.type === 'text' && message.buttons?.length) return failed('unsupported', 'wecom_aibot_buttons_unsupported');
      const live = current;
      if (!live || run.state !== 'running') return failed('configuration', 'wecom_aibot_not_connected');
      const target = message.target;
      const markdown = (content: string) => [{ msgtype: 'markdown', markdown: { content } },
        { msgtype: 'stream', stream: { id: randomBytes(8).toString('hex'), finish: true, content } }] as const;
      if (message.type === 'media') {
        const m = message.media;
        const size = m.bytes.byteLength;
        let type = 'file';
        if (m.kind === 'image' && ['image/png', 'image/jpeg', 'image/gif'].includes(m.mime) && size <= LIMITS.image) type = 'image';
        else if (m.kind === 'video' && m.mime === 'video/mp4' && size <= LIMITS.video) type = 'video';
        else if ((m.kind === 'voice' || m.kind === 'audio') && m.mime === 'audio/amr' && size <= LIMITS.voice) type = 'voice';
        if (type === 'file' && size > LIMITS.file) return failed('too_long', 'wecom_aibot_media_limit');
        if (message.caption && utf8Size(message.caption) > WECOM_AIBOT_MARKDOWN_UTF8_BYTES) return failed('too_long', 'wecom_aibot_text_limit');
        const mediaId = await upload(live, type, m);
        if (typeof mediaId !== 'string') return mediaId;
        const content = { msgtype: type, [type]: { media_id: mediaId } };
        const sent = await deliver(live, target, content, content);
        if (sent.status !== 'accepted' || !message.caption) return sent;
        const [push, respond] = markdown(message.caption);
        const caption = await deliver(live, target, push, respond);
        return caption.status === 'accepted' ? accepted([...sent.message_ids, ...caption.message_ids]) :
          { ...caption, message_ids: sent.message_ids, failed_part: 1 };
      }
      const parts = message.type === 'text_parts' ? [...message.parts] : [message.text];
      if (!parts.length || parts.some((p) => !p.trim())) return failed('bad_format', 'wecom_aibot_empty_text');
      if (parts.some((p) => utf8Size(p) > WECOM_AIBOT_MARKDOWN_UTF8_BYTES)) return failed('too_long', 'wecom_aibot_text_limit');
      const ids: string[] = [];
      for (const [index, text] of parts.entries()) {
        if (signal?.aborted) return { ...failed('cancelled', 'cancelled'), message_ids: ids, failed_part: index };
        const [push, respond] = markdown(text);
        const sent = await deliver(live, target, push, respond);
        if (sent.status !== 'accepted') return { ...sent, message_ids: ids, failed_part: index };
        ids.push(...sent.message_ids);
      }
      return accepted(ids);
    }
    return adapter;
  });
}
