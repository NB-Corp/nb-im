import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, LogLevel } from '@slack/web-api';
import type { RealtimeConnection, SessionCursorStore, SessionSpec } from './contract.ts';
import { createRealtimeSessionAdapter, object, PlatformFault, REALTIME_LIMITS, str } from './realtime.ts';
import { downloadPlatformMedia } from './media-http.ts';

type SlackSpec = Extract<SessionSpec, { platform: 'slack' }>;
const logger = { debug() {}, info() {}, warn() {}, error() {}, getLevel: () => LogLevel.ERROR,
  setLevel() {}, setName() {} };
function fault(error: unknown): never {
  const e = object(error); const data = object(e.data); const code = str(data.error || e.error || e.code);
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(code)) throw new PlatformFault('auth', 'slack_auth');
  if (['missing_scope', 'not_allowed_token_type', 'no_permission', 'not_in_channel', 'is_archived'].includes(code)) throw new PlatformFault('forbidden', 'slack_forbidden');
  if (code === 'channel_not_found' || code === 'message_not_found') throw new PlatformFault('not_found', 'slack_not_found');
  if (code === 'slack_webapi_rate_limited_error' || code === 'ratelimited') throw new PlatformFault('rate_limited', 'slack_rate_limited');
  if (['invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'msg_too_long'].includes(code)) throw new PlatformFault('bad_format', 'slack_bad_request');
  throw error;
}
function web(token: string, signal: AbortSignal) {
  return new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15000, logger,
    fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) });
}
export function createSlackConnection(botToken: string, appToken: string): RealtimeConnection {
  return {
    async run(handlers, _store, _scope, signal) {
      signal.throwIfAborted();
      const socket = new SocketModeClient({ appToken, logger, autoReconnectEnabled: true,
        clientOptions: { retryConfig: { retries: 0 }, timeout: 15000,
          fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) } });
      let finish!: () => void; let reject!: (e: unknown) => void;
      const ended = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
      void ended.catch(() => undefined);
      let id = '';
      const stop = () => { void socket.disconnect().then(finish, reject); };
      signal.addEventListener('abort', stop, { once: true });
      socket.on('connected', () => { if (id) handlers.onReady(id); });
      socket.on('reconnecting', () => handlers.onReconnecting());
      socket.on('disconnected', () => finish());
      socket.on('error', (error) => reject(error));
      socket.on('slack_event', ({ type, body, ack }: { type: string; body: unknown; ack: () => Promise<void> }) => {
        // Socket Mode emits message/app_mention by event subtype, plus this all-events envelope.
        // Acknowledge after host admission, not after the eventual model turn.
        const task = type === 'events_api' ? handlers.onEvent(body) : Promise.resolve();
        void task.then(() => signal.aborted ? undefined : ack()).catch(reject);
      });
      try {
        const auth = await web(botToken, signal).auth.test();
        id = auth.user_id ?? '';
        if (!id) throw new PlatformFault('auth', 'slack_auth');
        await Promise.race([socket.start(), ended]);
        if (!signal.aborted) await ended;
      } catch (error) { fault(error); }
      finally { signal.removeEventListener('abort', stop); await socket.disconnect(); socket.removeAllListeners(); }
    },
    async send(request, signal) {
      const client = web(botToken, signal);
      const thread = request.topic_id || request.reply_id;
      try {
        if (request.media) {
          const upload = { initial_comment: request.text || undefined,
            file: Buffer.from(request.media.bytes), filename: request.media.filename || 'attachment' };
          const result = await client.filesUploadV2(thread ? { ...upload, channel_id: request.chat_id, thread_ts: thread } :
            { ...upload, channel_id: request.chat_id });
          // SDK v8 returns one files.completeUploadExternal response per destination, not flat files.
          const completions = Array.isArray(result.files) ? result.files : [];
          const ids = completions.flatMap((completion) => {
            const files = object(completion).files;
            return Array.isArray(files) ? files.map((file) => str(object(file).id)).filter(Boolean) : [];
          });
          if (!ids.length) throw new Error('slack_missing_file_receipt');
          return ids;
        }
        const result = request.op === 'edit' ? await client.chat.update({ channel: request.chat_id,
          ts: request.message_id ?? '', text: request.text ?? '' }) : await client.chat.postMessage({ channel: request.chat_id,
          text: request.text ?? '', ...(thread ? { thread_ts: thread } : {}),
          unfurl_links: false, unfurl_media: false, mrkdwn: false });
        if (!result.ts) throw new Error('slack_missing_receipt');
        return [result.ts];
      } catch (error) { return fault(error); }
    },
    download: (url, signal) => downloadPlatformMedia(url, { platform: 'slack', token: botToken,
      cap: REALTIME_LIMITS.slack.media_bytes, signal }),
  };
}
export function createSlackSessionAdapter(spec: SlackSpec, store: SessionCursorStore) {
  return createRealtimeSessionAdapter(spec, store, spec.connection ?? createSlackConnection(spec.bot_token, spec.app_token));
}
