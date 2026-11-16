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
  /** Authored by the connected bot/account itself. */
  self: boolean;
  op: 'create' | 'edit' | 'retract';
  /** Platform message the event is about (for edit/retract: the original message). */
  source: string;
  reply: string;
  timestamp?: number; senderName?: string; chatTitle?: string; topicTitle?: string; replyTo?: string;
  mentionIds: string[]; mentioned: boolean;
}
function attachment(input: Record<string, unknown>, platform: RealtimeSpec['platform']): Attachment {
  const mime = str(input.content_type || input.mimetype) || 'application/octet-stream';
  return { url: str(platform === 'slack' ? input.url_private_download || input.url_private : input.url),
    filename: str(input.filename || input.name) || 'attachment', mime,
    size: typeof input.size === 'number' ? input.size : 0,
    kind: kind(mime, platform === 'discord' && typeof input.duration_secs === 'number') };
}
function name(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.slice(0, 512);
  return undefined;
}
function millis(value: unknown): number | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(Math.trunc(ms)) && ms > 0 ? Math.trunc(ms) : undefined;
}
function slackMillis(ts: unknown): number | undefined {
  const match = /^(\d{1,12})\.(\d{1,6})$/.exec(str(ts));
  return match ? Number(match[1]) * 1000 + Number(match[2]!.padEnd(3, '0').slice(0, 3)) : undefined;
}
// Slack user mentions are `<@ID>` or `<@ID|label>`; `<!here>`/`<#C…>` are not users.
const SLACK_MENTION = /<@([^|>\s]+)(?:\|[^>]*)?>/g;
function unique(ids: string[]): string[] { return [...new Set(ids.filter(Boolean))].slice(0, 100); }
// The wire mappings follow OpenClaw/Hermes channel implementations. SDKs own protocol lifecycle.
function normalize(platform: RealtimeSpec['platform'], raw: unknown, accountId: string): Message | undefined {
  const e = object(raw);
  const mine = (sender: string): boolean => accountId !== '' && sender === accountId;
  if (platform === 'discord') {
    const author = object(e.author);
    const sender = str(author.id);
    if ((author.bot || e.webhook_id) && !mine(sender)) return;
    const channel = object(e.channel);
    const threaded = [10, 11, 12].includes(Number(channel.type));
    const mentionIds = unique((Array.isArray(e.mentions) ? e.mentions : []).map((m) => typeof m === 'string' ? m : str(object(m).id)));
    const repliedTo = str(object(object(e.referenced_message).author).id);
    const replyTo = Number(e.type) === 19 ? str(object(e.message_reference).message_id) : '';
    return { id: str(e.id), chat: threaded ? str(channel.parent_id) : str(e.channel_id),
      sender, topic: threaded ? str(e.channel_id) : '0',
      private: channel.type === 1, text: str(e.content),
      files: (Array.isArray(e.attachments) ? e.attachments : []).map((a) => attachment(object(a), platform)),
      self: mine(sender), op: 'create', source: str(e.id), reply: str(e.id),
      timestamp: millis(e.timestamp), senderName: name(object(e.member).nick, author.global_name, author.username),
      chatTitle: name(threaded ? channel.parent_name : channel.name), topicTitle: threaded ? name(channel.name) : undefined,
      ...(replyTo ? { replyTo } : {}), mentionIds, mentioned: mentionIds.includes(accountId) || mine(repliedTo) };
  }
  if (platform === 'slack') {
    const event = object(e.event);
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    const id = str(e.event_id) || `${str(event.channel)}:${str(event.ts)}`;
    const thread = (m: Record<string, unknown>): string => str(m.thread_ts) && m.thread_ts !== m.ts ? str(m.thread_ts) : '0';
    const base = { id, chat: str(event.channel), private: event.channel_type === 'im', files: [] as Attachment[],
      mentionIds: [] as string[], mentioned: false };
    if (event.subtype === 'message_changed') {
      const m = object(event.message);
      // Link unfurls also arrive as message_changed; only a user edit carries `edited`.
      if (!object(m.edited).ts || (m.bot_id && !mine(str(m.user)))) return;
      const mentionIds = unique([...str(m.text).matchAll(SLACK_MENTION)].map((x) => x[1]!));
      return { ...base, sender: str(m.user), topic: thread(m), text: str(m.text), self: mine(str(m.user)),
        op: 'edit', source: str(m.ts), reply: str(m.ts), timestamp: slackMillis(object(m.edited).ts),
        mentionIds, mentioned: mentionIds.includes(accountId) };
    }
    if (event.subtype === 'message_deleted') {
      const m = object(event.previous_message);
      if (m.bot_id && !mine(str(m.user))) return;
      return { ...base, sender: str(m.user), topic: thread(m), text: '', self: mine(str(m.user)),
        op: 'retract', source: str(event.deleted_ts), reply: str(event.deleted_ts), timestamp: slackMillis(event.ts) };
    }
    const sender = str(event.user);
    if ((event.bot_id && !mine(sender)) || (event.subtype && event.subtype !== 'file_share')) return;
    const mentionIds = unique([...str(event.text).matchAll(SLACK_MENTION)].map((x) => x[1]!));
    const topic = str(event.thread_ts) || '0';
    const profile = object(event.user_profile);
    return { ...base, sender, topic, text: str(event.text),
      files: (Array.isArray(event.files) ? event.files : []).map((a) => attachment(object(a), platform)),
      self: mine(sender), op: 'create', source: str(event.ts), reply: str(event.ts), timestamp: slackMillis(event.ts),
      senderName: name(profile.display_name, profile.real_name, profile.name),
      ...(topic !== '0' && topic !== str(event.ts) ? { replyTo: topic } : {}), mentionIds,
      mentioned: event.type === 'app_mention' || mentionIds.includes(accountId) ||
        (topic !== '0' && topic !== str(event.ts) && mine(str(event.parent_user_id))) };
  }
  const sender = str(e.sender);
  const meta = { id: str(e.event_id), chat: str(e.room_id), sender, private: e.is_direct === true, self: mine(sender),
    timestamp: millis(e.origin_server_ts), senderName: name(e.sender_name), chatTitle: name(e.room_name) };
  if (e.type === 'm.room.redaction') {
    const redacts = str(e.redacts) || str(object(e.content).redacts);
    return { ...meta, topic: '0', text: '', files: [], op: 'retract', source: redacts, reply: meta.id,
      mentionIds: [], mentioned: false };
  }
  if (e.type !== 'm.room.message') return;
  const c = object(e.content);
  const rel = object(c['m.relates_to']);
  const mentionsOf = (content: Record<string, unknown>): string[] => {
    const intentional = object(content['m.mentions']);
    if (Array.isArray(intentional.user_ids)) return unique(intentional.user_ids.map((u) => str(u)));
    // Legacy clients only link the user ("pill") in formatted_body.
    return unique([...str(content.formatted_body).matchAll(/https:\/\/matrix\.to\/#\/((?:@|%40)[^"'<>?/\s]+)/g)]
      .map((x) => { try { return decodeURIComponent(x[1]!); } catch { return ''; } }));
  };
  if (rel.rel_type === 'm.replace') {
    const next = object(c['m.new_content']);
    const mentionIds = mentionsOf(next);
    return { ...meta, topic: '0', text: str(next.body), files: [], op: 'edit', source: str(rel.event_id),
      reply: str(rel.event_id), mentionIds, mentioned: mentionIds.includes(accountId) };
  }
  const info = object(c.info);
  const msgtype = str(c.msgtype);
  const media = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype);
  if (c.file) return; // E2EE is deliberately not advertised; encrypted attachments need a crypto store.
  const mime = str(info.mimetype) || 'application/octet-stream';
  const inReplyTo = rel.is_falling_back === true ? '' : str(object(rel['m.in_reply_to']).event_id);
  const mentionIds = mentionsOf(c);
  return { ...meta, topic: rel.rel_type === 'm.thread' ? str(rel.event_id) : '0',
    text: media ? (c.filename && c.filename !== c.body ? str(c.body) : '') : str(c.body),
    files: media ? [{ url: str(c.url), filename: str(c.filename || c.body) || 'attachment', mime,
      size: typeof info.size === 'number' ? info.size : 0,
      kind: c['org.matrix.msc3245.voice'] ? 'voice' : msgtype === 'm.image' ? 'image' :
        msgtype === 'm.video' ? 'video' : msgtype === 'm.audio' ? 'audio' : 'file' }] : [],
    op: 'create', source: meta.id, reply: meta.id, ...(inReplyTo ? { replyTo: inReplyTo } : {}),
    mentionIds, mentioned: mentionIds.includes(accountId) };
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
                  const message = normalize(spec.platform, raw, accountId);
                  if (!message || !message.id || !message.chat || !message.sender) return;
                  if (message.self && !spec.include_self) return;
                  if (message.op !== 'create' && (!spec.include_edits || !message.source)) return;
                  const baseKey = `${spec.platform}:${accountId}:${message.id}`;
                  const eventKey = `${baseKey}:0`;
                  const count = message.op === 'retract' || message.files.length ? 1 : (message.text ? 1 : 0);
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
                      sender_id: message.sender, topic_id: message.topic || '0', chat_kind: message.private ? 'private' : 'group',
                      ...(message.chatTitle ? { chat_title: message.chatTitle } : {}),
                      ...(message.senderName ? { sender_name: message.senderName } : {}),
                      ...(message.topicTitle ? { topic_title: message.topicTitle } : {}) },
                    payload, ...(message.source ? { source_message_id: message.source } : {}), operation: message.op,
                    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
                    mentioned: message.mentioned, mention_ids: message.mentionIds,
                    ...(message.replyTo ? { reply_to_message_id: message.replyTo } : {}),
                    ...(message.self ? { is_self: true } : {}),
                    reply_context: message.reply, cursor: message.id };
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
