export const SESSION_CONTRACT = 'nb-im-session/1' as const;

export const TELEGRAM_TEXT_CHARACTERS = 4096;
export const TELEGRAM_CAPTION_CHARACTERS = 1024;
export const TELEGRAM_CALLBACK_DATA_BYTES = 64;
export const TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_BYTES = 50 * 1024 * 1024;
export const FEISHU_TEXT_UTF8_BYTES = 150 * 1024;
export const FEISHU_CARD_UTF8_BYTES = 30 * 1024;
export const FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
export const FEISHU_FILE_BYTES = 30 * 1024 * 1024;

export const WECOM_AIBOT_MARKDOWN_UTF8_BYTES = 20_480;

export type SessionPlatformId = 'telegram' | 'feishu_app' | 'qq_onebot_v11' | 'personal_wechat' |
  'discord' | 'slack' | 'matrix' | 'wecom_aibot' | 'script';
export type SessionErrorKind = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' |
  'too_long' | 'bad_format' | 'unsupported' | 'cancelled' | 'configuration' | 'unknown';
export type SessionRunState = 'idle' | 'starting' | 'running' | 'reconnecting' | 'conflict' |
  'auth_expired' | 'stopped';
export interface SessionConnectionDetail {
  code: 'transport_error' | 'http_error' | 'api_error' | 'invalid_response' | 'auth_expired' | 'loop_failed';
  http_status?: number;
  ret?: number;
  errcode?: number;
  failure_count?: number;
  retry_in_ms?: number;
}
export type SessionChatKind = 'private' | 'group';
export type SessionMediaKind = 'image' | 'file' | 'voice' | 'audio' | 'video';

export interface SessionAccount {
  platform: SessionPlatformId;
  account_id: string;
}
export interface SessionPeer {
  chat_id: string;
  sender_id: string;
  /** "0" when the platform message has no topic. */
  topic_id: string;
  chat_kind?: SessionChatKind;
  chat_title?: string;
  sender_name?: string;
  topic_title?: string;
}
export interface SessionIdentity extends SessionAccount, SessionPeer {}
export interface SessionMedia {
  kind: SessionMediaKind;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}
export type SessionInboundUnavailableReason = 'too_large' | 'download_failed' | 'local_path_not_fetched';
export type SessionInboundPart =
  | { type: 'text'; text: string }
  | { type: 'media'; media: SessionMedia; caption?: string }
  | { type: 'media_unavailable'; kind: SessionMediaKind; reason: SessionInboundUnavailableReason };
export type SessionInboundPayload =
  | { type: 'text'; text: string }
  | { type: 'media'; media: SessionMedia; caption?: string }
  | { type: 'media_unavailable'; kind: SessionMediaKind; reason: SessionInboundUnavailableReason; caption?: string }
  | { type: 'parts'; parts: readonly SessionInboundPart[] }
  | { type: 'callback'; callback_id: string; data: string; message_id?: string };
export interface SessionInbound {
  event_key: string;
  platform_event_id: string;
  identity: SessionIdentity;
  payload: SessionInboundPayload;
  source_message_id?: string;
  operation?: 'create' | 'edit' | 'retract';
  timestamp?: number;
  mentioned?: boolean;
  mention_ids?: readonly string[];
  reply_to_message_id?: string;
  quoted_text?: string;
  is_self?: boolean;
  /** Host passes this back on send. It is not a bot credential. Do not put it in a model prompt. */
  reply_context?: string;
  cursor: string;
}
export type SessionAdmit =
  | { decision: 'accepted'; callback_ack?: string }
  | { decision: 'defer' };
export interface SessionSink {
  /** Record the drop or the prompt receipt. Do not run a model turn inside this call. */
  admit(event: SessionInbound): Promise<SessionAdmit>;
}
export interface SessionCursorStore {
  load(scope: string): Promise<string | undefined>;
  /** Called only after the host has accepted the events that cursor covers, or the adapter has decided to drop them. */
  save(scope: string, cursor: string): Promise<void>;
}
export interface SessionTarget {
  chat_id: string;
  topic_id?: string;
  reply_context?: string;
  chat_kind?: SessionChatKind;
}
export interface SessionButton {
  data: string;
  label: string;
}
export type SessionOutbound =
  | { type: 'text'; target: SessionTarget; text: string; buttons?: readonly SessionButton[] }
  | { type: 'edit_text'; target: SessionTarget; message_id: string; text: string; buttons?: readonly SessionButton[] }
  | { type: 'text_parts'; target: SessionTarget; parts: readonly string[] }
  | { type: 'media'; target: SessionTarget; media: SessionMedia; caption?: string }
  | { type: 'callback_ack'; callback_id: string; text?: string };
export interface SessionReceipt {
  status: 'accepted' | 'failed' | 'unknown' | 'conflict';
  message_ids: string[];
  error_kind?: SessionErrorKind;
  diagnostic_code?: string;
  failed_part?: number;
}
export interface SessionLimits {
  text_characters: number | null;
  text_utf8_bytes: number | null;
  callback_data_bytes: number | null;
  voice_mime: readonly string[] | null;
  image_bytes: number | null;
  file_bytes: number | null;
}
export interface SessionAdapter {
  readonly platform: SessionPlatformId;
  readonly instance_id: string;
  readonly account: SessionAccount;
  readonly limits: SessionLimits;
  readonly state: SessionRunState;
  readonly connection_detail?: SessionConnectionDetail;
  start(sink: SessionSink): Promise<void>;
  stop(): Promise<void>;
  send(message: SessionOutbound, signal?: AbortSignal): Promise<SessionReceipt>;
}

export interface TelegramCall {
  method: string;
  json?: Record<string, unknown>;
  file?: { field: string; filename: string; mime: string; bytes: Uint8Array };
}
export interface TelegramBotTransport {
  call(request: TelegramCall, signal: AbortSignal): Promise<{ http_status: number; body: unknown }>;
  download(file_path: string, signal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
}
export interface FeishuRequest {
  op: 'create_message' | 'reply_message' | 'update_message' | 'upload_image' | 'upload_file' | 'download';
  chat_id?: string;
  message_id?: string;
  msg_type?: string;
  content?: string;
  file_type?: string;
  file_name?: string;
  mime?: string;
  bytes?: Uint8Array;
  resource_key?: string;
  resource_type?: 'image' | 'file';
}
export interface FeishuResponse {
  ok: boolean;
  message_id?: string;
  key?: string;
  bytes?: Uint8Array;
  http_status?: number;
  code?: number;
  /** Set when a download crosses the SDK's 100 MB resource cap. Bytes are not returned. */
  too_large?: boolean;
}
export interface FeishuHandlers {
  onMessage(event: unknown): Promise<unknown>;
  onCardAction(event: unknown): Promise<unknown>;
  onDisconnect(): void;
  onReconnecting?(): void;
  onReconnected?(): void;
  onBotIdentity?(botOpenId: string): void;
}
export interface FeishuConnection {
  open(handlers: FeishuHandlers, signal: AbortSignal): Promise<
    { ok: true; bot_open_id?: string } | { ok: false; reason: 'auth' | 'conflict' | 'transport' }>;
  send(request: FeishuRequest, signal: AbortSignal): Promise<FeishuResponse>;
}
export interface OneBotLink {
  role: 'universal' | 'api' | 'event';
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
export interface OneBotTransport {
  connect(input: { url: string; headers: Record<string, string>; signal: AbortSignal }): Promise<OneBotLink>;
  listen(input: {
    host: string;
    port: number;
    signal: AbortSignal;
    authorize: (headers: Record<string, string | undefined>, url: string) => boolean;
    accept: (link: OneBotLink) => void;
  }): Promise<{ port: number }>;
  /** Optional inbound media fetch. Private addresses are not a valid target. */
  download?(url: string, signal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
}
export interface WechatHttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export interface WechatTransport {
  post(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<WechatHttpResponse>;
  postBytes(url: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal): Promise<WechatHttpResponse>;
  getBytes(url: string, signal: AbortSignal): Promise<{ status: number; body: Uint8Array }>;
}

/** One WeCom AI-bot long connection: JSON frames `{cmd, headers: {req_id}, body}` over a WebSocket. */
export interface WecomAibotLink {
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
export interface WecomAibotDownload {
  ok: boolean;
  bytes?: Uint8Array;
  filename?: string;
  mime?: string;
  too_large?: boolean;
}
export interface WecomAibotTransport {
  connect(url: string, signal: AbortSignal): Promise<WecomAibotLink>;
  /** Inbound media URLs (valid five minutes, AES-encrypted). Private addresses are not a valid target. */
  download(url: string, cap: number, signal: AbortSignal): Promise<WecomAibotDownload>;
}

/** Raw platform events cross this seam; production connections use the pinned SDKs. */
export interface RealtimeHandlers {
  onReady(account_id: string): void;
  onEvent(event: unknown): Promise<void>;
  onReconnecting(): void;
}
export interface RealtimeRequest {
  op: 'message' | 'edit';
  chat_id: string;
  topic_id?: string;
  reply_id?: string;
  message_id?: string;
  text?: string;
  media?: SessionMedia;
}
export interface RealtimeConnection {
  /** Runs until abort/disconnect. Resolves only after all owned resources close. */
  run(handlers: RealtimeHandlers, store: SessionCursorStore, scope: string, signal: AbortSignal): Promise<void>;
  send(request: RealtimeRequest, signal: AbortSignal): Promise<string[]>;
  download(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

interface SessionSpecBase {
  instance_id: string;
  retry_ms?: number;
  poll_timeout_ms?: number;
  /**
   * Emit the bot/account's own messages (with `is_self: true`) where the adapter otherwise drops them:
   * Discord/Slack/Matrix own messages, WeChat iLink bot messages, OneBot `message_sent`. Default false.
   * Telegram, Feishu and script channels already report `is_self` and are unaffected.
   */
  include_self?: boolean;
  /**
   * Emit `operation: 'edit' | 'retract'` events where the adapter otherwise drops them: Slack
   * `message_changed`/`message_deleted`, Matrix `m.replace` edits and redactions. Default false.
   * `source_message_id` names the edited/retracted message; a retract carries an empty text payload.
   */
  include_edits?: boolean;
}
export type SessionSpec = SessionSpecBase & (
  | { platform: 'telegram'; token: string; transport?: TelegramBotTransport }
  | { platform: 'feishu_app'; app_id: string; app_secret: string; connection?: FeishuConnection }
  | { platform: 'qq_onebot_v11'; mode: 'forward' | 'reverse'; endpoint: string;
      access_token?: string; listen_port?: number; transport?: OneBotTransport;
      call_timeout_ms?: number }
  | { platform: 'personal_wechat'; token: string; base_url?: string; account_id?: string;
      cdn_base_url?: string; transport?: WechatTransport }
  | { platform: 'discord'; bot_token: string; connection?: RealtimeConnection }
  | { platform: 'slack'; bot_token: string; app_token: string; connection?: RealtimeConnection }
  | { platform: 'matrix'; homeserver: string; access_token: string; connection?: RealtimeConnection }
  /** WeCom AI bot (企业微信智能机器人) in API mode over the long connection: Bot ID + long-connection Secret. */
  | { platform: 'wecom_aibot'; bot_id: string; secret: string; ws_url?: string; transport?: WecomAibotTransport;
      heartbeat_ms?: number; ack_timeout_ms?: number }
  /** Custom channel: a child process speaking nb-im-script/1 JSON lines over stdio (see session/script.ts). */
  | { platform: 'script'; command: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>;
      send_timeout_ms?: number; on_log?: (line: string) => void;
      /** Longest accepted stdout line in bytes (default SCRIPT_LINE_BYTES, 40 MiB); longer kills and restarts. */
      max_line_bytes?: number }
);

const KINDS = new Set<SessionErrorKind>(['auth', 'forbidden', 'not_found', 'conflict', 'rate_limited',
  'too_long', 'bad_format', 'unsupported', 'cancelled', 'configuration', 'unknown']);
const CODE = /^[a-z0-9_]{1,64}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.$=+/:~-]{1,255}$/;

export function sessionReceipt(input: SessionReceipt): SessionReceipt {
  const status = input.status === 'accepted' || input.status === 'failed' ||
    input.status === 'unknown' || input.status === 'conflict' ? input.status : 'unknown';
  const code = typeof input.diagnostic_code === 'string' && CODE.test(input.diagnostic_code) ?
    input.diagnostic_code : input.diagnostic_code === undefined ? undefined : 'session_diagnostic_redacted';
  const ids = Array.isArray(input.message_ids) ? input.message_ids.filter((id) =>
    typeof id === 'string' && MESSAGE_ID.test(id)) : [];
  return { status, message_ids: ids,
    ...(input.error_kind && KINDS.has(input.error_kind) ? { error_kind: input.error_kind } : {}),
    ...(code ? { diagnostic_code: code } : {}),
    ...(Number.isInteger(input.failed_part) ? { failed_part: input.failed_part } : {}) };
}
export function failed(kind: SessionErrorKind, code: string, extra: Partial<SessionReceipt> = {}): SessionReceipt {
  return sessionReceipt({ status: 'failed', message_ids: [], error_kind: kind, diagnostic_code: code, ...extra });
}
export function accepted(ids: string[], extra: Partial<SessionReceipt> = {}): SessionReceipt {
  return sessionReceipt({ status: 'accepted', message_ids: ids, ...extra });
}
export function unknownReceipt(code: string): SessionReceipt {
  return sessionReceipt({ status: 'unknown', message_ids: [], error_kind: 'unknown', diagnostic_code: code });
}
export function splitSessionText(text: string, characterLimit: number): string[] {
  if (!Number.isInteger(characterLimit) || characterLimit < 1) throw new Error('invalid_text_limit');
  if (text.length === 0) return [''];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > characterLimit) {
    const window = rest.slice(0, characterLimit);
    const soft = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = soft >= Math.floor(characterLimit / 2) ? soft + 1 : characterLimit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}
export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export function feishuTextContent(text: string): string {
  return JSON.stringify({ text });
}
export function splitFeishuText(text: string): string[] {
  if (utf8Size(feishuTextContent(text)) <= FEISHU_TEXT_UTF8_BYTES) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let low = 1;
    let high = rest.length;
    let fit = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (utf8Size(feishuTextContent(rest.slice(0, mid))) <= FEISHU_TEXT_UTF8_BYTES) {
        fit = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (fit < 1) throw new Error('feishu_text_unit_exceeds_limit');
    const window = rest.slice(0, fit);
    const soft = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = soft >= Math.floor(fit / 2) ? soft + 1 : fit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}
export function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
export async function withRequestDeadline<T>(parent: AbortSignal, timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent.aborted) throw abortError();
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const onAbort = (): void => {
    rejectDeadline(abortError());
    controller.abort();
  };
  const timer = setTimeout(() => {
    rejectDeadline(new Error('request_timeout'));
    controller.abort();
  }, Math.max(1, timeoutMs));
  parent.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms > 0 ? ms : 0);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export function validInstanceId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(value);
}
export function cursorScope(instanceId: string): string {
  return `nb-im-session:${instanceId}`;
}
