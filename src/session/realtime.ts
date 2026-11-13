import type { RealtimeConnection, RealtimeRequest, SessionAdapter, SessionCursorStore,
  SessionInbound, SessionInboundPart, SessionMediaKind, SessionOutbound, SessionReceipt, SessionSpec } from './contract.ts';
import { accepted, cursorScope, delay, failed, isAbort, unknownReceipt } from './contract.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';

export type RealtimeSpec = Extract<SessionSpec, { platform: 'discord' | 'slack' | 'matrix' }>;
export class PlatformFault extends Error {
  readonly kind: NonNullable<SessionReceipt['error_kind']>;
  readonly code: string;
  constructor(kind: NonNullable<SessionReceipt['error_kind']>, code: string) {
    super(code); this.kind = kind; this.code = code;
  }
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
const MiB = 1024 * 1024;
export const REALTIME_LIMITS = {
  discord: { text_characters: 2000, media_bytes: 10 * MiB },
  slack: { text_characters: 40000, media_bytes: 100 * MiB },
  matrix: { text_characters: 16000, media_bytes: 50 * MiB },
} as const;
function kind(mime: string, voice = false): SessionMediaKind {
  return voice ? 'voice' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' :
    mime.startsWith('audio/') ? 'audio' : 'file';
}
interface Attachment { url: string; filename: string; mime: string; size: number; kind: SessionMediaKind }
interface Message {
  id: string; chat: string; sender: string; topic: string; private: boolean; text: string; files: Attachment[];
}
function attachment(input: Record<string, unknown>, platform: RealtimeSpec['platform']): Attachment {
  const mime = str(input.content_type || input.mimetype) || 'application/octet-stream';
  return { url: str(platform === 'slack' ? input.url_private_download || input.url_private : input.url),
    filename: str(input.filename || input.name) || 'attachment', mime,
    size: typeof input.size === 'number' ? input.size : 0,
    kind: kind(mime, platform === 'discord' && typeof input.duration_secs === 'number') };
}
// The wire mappings follow OpenClaw/Hermes channel implementations. SDKs own protocol lifecycle.
function normalize(platform: RealtimeSpec['platform'], raw: unknown): Message | undefined {
  const e = object(raw);
  if (platform === 'discord') {
    if (object(e.author).bot || e.webhook_id) return;
    const channel = object(e.channel);
    const threaded = [10, 11, 12].includes(Number(channel.type));
    return { id: str(e.id), chat: threaded ? str(channel.parent_id) : str(e.channel_id),
      sender: str(object(e.author).id), topic: threaded ? str(e.channel_id) : '0',
      private: channel.type === 1, text: str(e.content),
      files: (Array.isArray(e.attachments) ? e.attachments : []).map((a) => attachment(object(a), platform)) };
  }
  if (platform === 'slack') {
    const event = object(e.event);
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    if (event.bot_id || (event.subtype && event.subtype !== 'file_share')) return;
    return { id: str(e.event_id) || `${str(event.channel)}:${str(event.ts)}`, chat: str(event.channel),
      sender: str(event.user), topic: str(event.thread_ts) || '0', private: event.channel_type === 'im',
      text: str(event.text), files: (Array.isArray(event.files) ? event.files : []).map((a) => attachment(object(a), platform)) };
  }
  if (e.type !== 'm.room.message') return;
  const c = object(e.content);
  const rel = object(c['m.relates_to']);
  if (rel.rel_type === 'm.replace') return;
  const info = object(c.info);
  const msgtype = str(c.msgtype);
  const media = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype);
  if (c.file) return; // E2EE is deliberately not advertised; encrypted attachments need a crypto store.
  const mime = str(info.mimetype) || 'application/octet-stream';
  return { id: str(e.event_id), chat: str(e.room_id), sender: str(e.sender),
    topic: rel.rel_type === 'm.thread' ? str(rel.event_id) : '0', private: e.is_direct === true,
    text: media ? (c.filename && c.filename !== c.body ? str(c.body) : '') : str(c.body),
    files: media ? [{ url: str(c.url), filename: str(c.filename || c.body) || 'attachment', mime,
      size: typeof info.size === 'number' ? info.size : 0,
      kind: c['org.matrix.msc3245.voice'] ? 'voice' : msgtype === 'm.image' ? 'image' :
        msgtype === 'm.video' ? 'video' : msgtype === 'm.audio' ? 'audio' : 'file' }] : [] };
}
export function createRealtimeSessionAdapter(spec: RealtimeSpec, store: SessionCursorStore,
  connection: RealtimeConnection): SessionAdapter {
  const key = sessionFingerprint(spec);
  return shareSession(key, () => {
    const limits = REALTIME_LIMITS[spec.platform];
    const scope = cursorScope(spec.instance_id);
    let accountId = '';
    let liveSignal: AbortSignal | undefined;
    // Serialize duplicates while a sink has deferred one. Store only bounded event keys, never media/secrets.
    let chain: Promise<void> = Promise.resolve();
    let recent: string[] = [];
    const adapter: SessionAdapter = {
      platform: spec.platform, instance_id: spec.instance_id,
      get account() { return { platform: spec.platform, account_id: accountId }; },
      limits: { text_characters: limits.text_characters, text_utf8_bytes: null, callback_data_bytes: null,
        voice_mime: null, image_bytes: limits.media_bytes, file_bytes: limits.media_bytes },
      get state() { return run.state; }, get connection_detail() { return run.detail; },
      start: (sink) => run.start(async (signal) => {
        liveSignal = signal;
        const saved = await store.load(`${scope}:recent`);
        if (saved) { try { const value: unknown = JSON.parse(saved); if (Array.isArray(value)) recent = value.filter((s): s is string => typeof s === 'string').slice(-512); } catch { /* Old/invalid dedup state is not a cursor. */ } }
        while (!signal.aborted) {
          try {
            await connection.run({
              onReady(id) { accountId = id; run.state = 'running'; },
              onReconnecting() { run.state = 'reconnecting'; run.detail = { code: 'transport_error' }; },
              onEvent(raw) {
                const task = chain.then(async () => {
                  if (signal.aborted) return;
                  const message = normalize(spec.platform, raw);
                  if (!message || !message.id || !message.chat || !message.sender || message.sender === accountId) return;
                  const baseKey = `${spec.platform}:${accountId}:${message.id}`;
                  const eventKey = `${baseKey}:0`;
                  const count = message.files.length ? 1 : (message.text ? 1 : 0);
                  if (!count || recent.includes(eventKey)) return;
                  const captionField = message.text ? { caption: message.text } : {};
                  let payload: SessionInbound['payload'];
                  if (!message.files.length) {
                    payload = { type: 'text', text: message.text };
                  } else if (message.files.length === 1) {
                    const file = message.files[0]!;
                    if (file.size > limits.media_bytes) {
                      payload = { type: 'media_unavailable', kind: file.kind, reason: 'too_large', ...captionField };
                    } else {
                      try {
                        const bytes = await connection.download(file.url, signal);
                        payload = bytes.byteLength > limits.media_bytes ?
                          { type: 'media_unavailable', kind: file.kind, reason: 'too_large', ...captionField } :
                          { type: 'media', media: { kind: file.kind, filename: file.filename, mime: file.mime, bytes },
                            ...captionField };
                      } catch {
                        if (signal.aborted) return;
                        payload = { type: 'media_unavailable', kind: file.kind, reason: 'download_failed', ...captionField };
                      }
                    }
                  } else {
                    const parts: SessionInboundPart[] = [];
                    if (message.text) parts.push({ type: 'text', text: message.text });
                    for (const file of message.files) {
                      if (file.size > limits.media_bytes) {
                        parts.push({ type: 'media_unavailable', kind: file.kind, reason: 'too_large' });
                        continue;
                      }
                      try {
                        const bytes = await connection.download(file.url, signal);
                        parts.push(bytes.byteLength > limits.media_bytes ?
                          { type: 'media_unavailable', kind: file.kind, reason: 'too_large' } :
                          { type: 'media', media: { kind: file.kind, filename: file.filename, mime: file.mime, bytes } });
                      } catch {
                        if (signal.aborted) return;
                        parts.push({ type: 'media_unavailable', kind: file.kind, reason: 'download_failed' });
                      }
                    }
                    payload = { type: 'parts', parts };
                  }
                  const inbound: SessionInbound = { event_key: eventKey, platform_event_id: message.id,
                    identity: { platform: spec.platform, account_id: accountId, chat_id: message.chat,
                      sender_id: message.sender, topic_id: message.topic || '0', chat_kind: message.private ? 'private' : 'group' },
                    payload, reply_context: spec.platform === 'slack' ? str(object(object(raw).event).ts) : message.id,
                    cursor: message.id };
                  while (!signal.aborted) {
                    const admitted = await sink.admit(inbound).catch(() => ({ decision: 'defer' as const }));
                    if (admitted.decision === 'accepted') {
                      const next = [...recent, eventKey].slice(-512);
                      await store.save(`${scope}:recent`, JSON.stringify(next));
                      recent = next;
                      break;
                    }
                    await delay(spec.retry_ms ?? 1000, signal);
                  }
                });
                chain = task.catch(() => undefined);
                return task;
              },
            }, store, scope, signal);
          } catch (error) {
            if (signal.aborted || isAbort(error)) break;
            if (error instanceof PlatformFault && error.kind === 'auth') { run.state = 'auth_expired'; return; }
            if (error instanceof PlatformFault && error.kind === 'conflict') { run.state = 'conflict'; return; }
          }
          if (!signal.aborted) await run.reconnect({ code: 'transport_error' }, signal);
        }
        await chain;
      }),
      stop: () => run.stop(), send,
    };
    const run = createSessionRun(key, adapter, spec.retry_ms);
    async function send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt> {
      if (signal?.aborted || liveSignal?.aborted) return failed('cancelled', 'cancelled');
      if (message.type === 'callback_ack' || ((message.type === 'text' || message.type === 'edit_text') && message.buttons?.length)) {
        return failed('unsupported', `${spec.platform}_buttons_unsupported`);
      }
      if (message.type === 'media' && message.media.kind === 'voice') return failed('unsupported', `${spec.platform}_native_voice_unsupported`);
      const target = message.target;
      const limit = limits.text_characters;
      const parts = message.type === 'text_parts' ? [...message.parts] : message.type === 'media' ? [message.caption ?? ''] : [message.text];
      if (parts.length === 0 || parts.some((p) => (message.type !== 'media' && !p) || p.length > limit)) return failed('too_long', `${spec.platform}_text_limit`);
      if (message.type === 'media' && (!message.media.bytes.byteLength || message.media.bytes.byteLength > limits.media_bytes)) return failed('too_long', `${spec.platform}_media_limit`);
      const active = signal && liveSignal ? AbortSignal.any([signal, liveSignal]) : signal ?? liveSignal ?? new AbortController().signal;
      const ids: string[] = [];
      for (const [index, text] of parts.entries()) {
        if (active.aborted) return { ...failed('cancelled', 'cancelled'), message_ids: ids, failed_part: index };
        const request: RealtimeRequest = { op: message.type === 'edit_text' ? 'edit' : 'message', chat_id: target.chat_id,
          ...(target.topic_id && target.topic_id !== '0' ? { topic_id: target.topic_id } : {}),
          ...(target.reply_context ? { reply_id: target.reply_context } : {}), text,
          ...(message.type === 'edit_text' ? { message_id: message.message_id } : {}),
          ...(message.type === 'media' ? { media: message.media } : {}) };
        try { ids.push(...await connection.send(request, active)); }
        catch (error) {
          if (error instanceof PlatformFault) {
            if (error.kind === 'auth') run.state = 'auth_expired';
            return { ...failed(error.kind, error.code), message_ids: ids, failed_part: index };
          }
          return { ...unknownReceipt(active.aborted ? 'cancelled_after_dispatch' : `${spec.platform}_transport_unknown`), message_ids: ids, failed_part: index };
        }
      }
      return accepted(ids);
    }
    return adapter;
  });
}
