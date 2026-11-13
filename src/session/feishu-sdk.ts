import { Readable } from 'node:stream';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuConnection, FeishuRequest, FeishuResponse } from './contract.ts';
import { abortError, isAbort } from './contract.ts';

const RESOURCE_CAP = 100 * 1024 * 1024;
type FileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
const FILE_TYPES = new Set<string>(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']);

function classify(error: unknown): 'auth' | 'conflict' | 'transport' {
  const text = error instanceof Error ? `${error.name}\n${error.message}` : '';
  if (/app secret|app_secret|invalid app|unauthorized|\b401\b|99991663|99991664/iu.test(text)) return 'auth';
  if (/conflict|already online|duplicate connection/iu.test(text)) return 'conflict';
  return 'transport';
}
function labeledCodes(value: string, out: string[]): void {
  for (const match of value.matchAll(/(?:^|[^\w])(?:code|errcode)\s*[:=]\s*(-?\d{1,12})\b/giu)) {
    if (match[1] && out.length < 4) out.push(match[1]);
  }
  for (const match of value.matchAll(/status code (\d{3})\b/giu)) {
    if (match[1] && out.length < 4) out.push(match[1]);
  }
}
function collectCodes(value: unknown, out: string[]): void {
  if (out.length >= 4 || value == null) return;
  if (typeof value === 'string') { labeledCodes(value, out); return; }
  if (typeof value !== 'object') return;
  if (value instanceof Error) {
    labeledCodes(value.message, out);
    const status = (value as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number' && status >= 100 && status <= 599) out.push(String(status));
    return;
  }
  const record = value as Record<string, unknown>;
  if (!('config' in record) && !('request' in record) && !('headers' in record) && !('data' in record)) return;
  if (typeof record.message === 'string') labeledCodes(record.message, out);
  const response = record.response;
  if (response && typeof response === 'object') {
    const status = (response as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 100 && status <= 599 && out.length < 4) out.push(String(status));
  }
}
function quietLogger(): lark.Logger {
  const silent = (): void => undefined;
  return {
    error(...args: unknown[]) {
      const codes: string[] = [];
      for (const arg of args) collectCodes(arg, codes);
      if (codes.length > 0) console.error(`feishu_sdk ${codes.join(' ')}`);
    },
    warn: silent, info: silent, debug: silent, trace: silent,
  };
}
async function readBounded(stream: Readable, signal: AbortSignal): Promise<FeishuResponse> {
  if (signal.aborted) { stream.destroy(); throw abortError(); }
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => { stream.destroy(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw abortError();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > RESOURCE_CAP) {
        stream.destroy();
        return { ok: false, too_large: true };
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

const BOT_INFO_TIMEOUT_MS = 2_000;

async function fetchBotOpenId(client: lark.Client, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const response = await Promise.race([
      client.request({ method: 'GET', url: '/open-apis/bot/v3/info', timeout: BOT_INFO_TIMEOUT_MS } as Parameters<lark.Client['request']>[0]),
      new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined);
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve(undefined), BOT_INFO_TIMEOUT_MS);
      }),
    ]) as {
      code?: unknown;
      bot?: { open_id?: unknown };
      data?: { bot?: { open_id?: unknown } };
    } | undefined;
    if (signal.aborted || !response || (response.code !== undefined && response.code !== 0)) return undefined;
    const openId = typeof response.bot?.open_id === 'string' ? response.bot.open_id :
      typeof response.data?.bot?.open_id === 'string' ? response.data.bot.open_id : '';
    return openId.length > 0 ? openId : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Enterprise self-built Feishu long connection. SDK errors are classified and not rethrown. */
export function createFeishuSdkConnection(input: {
  appId: string;
  appSecret: string;
  connectionHost?: string;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
}): FeishuConnection {
  const silent = (): void => undefined;
  const silentLogger: lark.Logger = { error: silent, warn: silent, info: silent, debug: silent, trace: silent };
  const logger = quietLogger();
  const client = new lark.Client({
    appId: input.appId, appSecret: input.appSecret, appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error, logger,
  });
  const botInfoClient = new lark.Client({
    appId: input.appId, appSecret: input.appSecret, appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error, logger: silentLogger,
  });
  return {
    open(handlers, signal) {
      if (signal.aborted) return Promise.resolve({ ok: false, reason: 'transport' });
      return new Promise((resolve) => {
        let settled = false;
        let ready = false;
        const finish = (result: { ok: true; bot_open_id?: string } | { ok: false; reason: 'auth' | 'conflict' | 'transport' }): void => {
          if (settled) return;
          settled = true;
          ready = result.ok;
          resolve(result);
        };
        if (!/^cli_[0-9a-fA-F]{16}$/u.test(input.appId)) {
          finish({ ok: false, reason: 'auth' });
          return;
        }
        const ws = new lark.WSClient({
          appId: input.appId, appSecret: input.appSecret, domain: lark.Domain.Feishu,
          logger, loggerLevel: lark.LoggerLevel.error, autoReconnect: true,
          ...(input.connectionHost === undefined ? {} : { connectionHost: input.connectionHost }),
          handshakeTimeoutMs: input.handshakeTimeoutMs ?? 15_000,
          wsConfig: { pingTimeout: input.pingTimeout ?? 15 },
          onReady: () => {
            finish({ ok: true });
            void fetchBotOpenId(botInfoClient, signal).then((botOpenId) => {
              if (botOpenId && !signal.aborted) handlers.onBotIdentity?.(botOpenId);
            });
          },
          onReconnecting: () => { if (!signal.aborted) handlers.onReconnecting?.(); },
          onReconnected: () => { if (!signal.aborted) handlers.onReconnected?.(); },
          onError: (error) => {
            if (ready || settled) handlers.onDisconnect();
            else finish({ ok: false, reason: classify(error) });
          },
        });
        const dispatcher = new lark.EventDispatcher({ logger, loggerLevel: lark.LoggerLevel.error });
        dispatcher.register({
          'im.message.receive_v1': (data) => handlers.onMessage(data),
          'card.action.trigger': (data: unknown) => handlers.onCardAction(data),
        } as Parameters<lark.EventDispatcher['register']>[0]);
        // start() returns before the socket exists. Ready is onReady; the first onError is the failure.
        void ws.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
          if (!settled) finish({ ok: false, reason: classify(error) });
        });
        signal.addEventListener('abort', () => {
          ws.close({ force: true });
          if (settled) handlers.onDisconnect();
          else finish({ ok: false, reason: 'transport' });
        }, { once: true });
      });
    },
    send: (request, signal) => dispatch(client, request, signal),
  };
}
function errorResponse(error: unknown): FeishuResponse {
  if (!error || typeof error !== 'object') return { ok: false };
  const record = error as { code?: unknown; response?: { status?: unknown; data?: { code?: unknown } } };
  const status = typeof record.response?.status === 'number' &&
    record.response.status >= 100 && record.response.status <= 599 ? record.response.status : undefined;
  const code = typeof record.response?.data?.code === 'number' ? record.response.data.code :
    typeof record.code === 'number' ? record.code : undefined;
  return { ok: false, ...(status !== undefined ? { http_status: status } : {}), ...(code !== undefined ? { code } : {}) };
}
async function dispatch(client: lark.Client, request: FeishuRequest, signal: AbortSignal): Promise<FeishuResponse> {
  if (signal.aborted) throw abortError();
  try {
    if (request.op === 'create_message') {
      const response = await client.im.message.create({
        data: { receive_id: request.chat_id ?? '', msg_type: request.msg_type ?? 'text', content: request.content ?? '' },
        params: { receive_id_type: 'chat_id' },
      });
      const messageId = response.data?.message_id;
      return { ok: response.code === 0 || (response.code === undefined && typeof messageId === 'string'),
        ...(messageId ? { message_id: messageId } : {}), ...(response.code === undefined ? {} : { code: response.code }) };
    }
    if (request.op === 'reply_message') {
      const response = await client.im.message.reply({
        data: { msg_type: request.msg_type ?? 'text', content: request.content ?? '', reply_in_thread: true },
        path: { message_id: request.message_id ?? '' },
      });
      const messageId = response.data?.message_id;
      return { ok: response.code === 0 || (response.code === undefined && typeof messageId === 'string'),
        ...(messageId ? { message_id: messageId } : {}), ...(response.code === undefined ? {} : { code: response.code }) };
    }
    if (request.op === 'update_message') {
      const response = await client.im.message.update({
        data: { msg_type: request.msg_type ?? 'text', content: request.content ?? '' },
        path: { message_id: request.message_id ?? '' },
      });
      return { ok: response.code === 0 || response.code === undefined,
        ...(request.message_id ? { message_id: request.message_id } : {}),
        ...(response.code === undefined ? {} : { code: response.code }) };
    }
    if (request.op === 'upload_image') {
      const response = await client.im.image.create({
        data: { image_type: 'message', image: Buffer.from(request.bytes ?? new Uint8Array()) },
      });
      return { ok: typeof response?.image_key === 'string', ...(response?.image_key ? { key: response.image_key } : {}) };
    }
    if (request.op === 'upload_file') {
      const fileType = request.file_type ?? '';
      if (!FILE_TYPES.has(fileType)) return { ok: false };
      const response = await client.im.file.create({
        data: { file_type: fileType as FileType, file_name: request.file_name ?? 'file',
          file: Buffer.from(request.bytes ?? new Uint8Array()) },
      });
      return { ok: typeof response?.file_key === 'string', ...(response?.file_key ? { key: response.file_key } : {}) };
    }
    const response = await client.im.messageResource.get({
      params: { type: request.resource_type ?? 'file' },
      path: { message_id: request.message_id ?? '', file_key: request.resource_key ?? '' },
    });
    return await readBounded(response.getReadableStream(), signal);
  } catch (error) {
    if (signal.aborted || isAbort(error)) throw abortError();
    return errorResponse(error);
  }
}
