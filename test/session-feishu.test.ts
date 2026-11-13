import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { WebSocketServer } from 'ws';
import { createFeishuSdkConnection, createFeishuSessionAdapter, splitFeishuText } from '../src/index.ts';
import type { FeishuConnection, FeishuHandlers, FeishuRequest, SessionCursorStore, SessionInbound } from '../src/index.ts';

const APP = 'cli_app';
const SECRET = 'feishu-app-secret-should-stay-out';
function memory(): SessionCursorStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async load(scope) { return values.get(scope); }, async save(scope, cursor) { values.set(scope, cursor); } };
}
function connection(script: (request: FeishuRequest) => { ok: boolean; message_id?: string; key?: string; bytes?: Uint8Array; too_large?: boolean }):
  FeishuConnection & { handlers?: FeishuHandlers; sent: FeishuRequest[]; opens: number } {
  const sent: FeishuRequest[] = [];
  const api = {
    sent, opens: 0, handlers: undefined as FeishuHandlers | undefined,
    async open(handlers: FeishuHandlers, signal: AbortSignal) {
      api.opens += 1;
      api.handlers = handlers;
      signal.addEventListener('abort', () => handlers.onDisconnect(), { once: true });
      return { ok: true as const };
    },
    async send(request: FeishuRequest) {
      sent.push(request);
      return script(request);
    },
  };
  return api;
}
test('Feishu SDK exports the long-connection client', () => {
  assert.equal(typeof lark.Client, 'function');
  assert.equal(typeof lark.WSClient, 'function');
  assert.equal(typeof lark.EventDispatcher, 'function');
  assert.equal(lark.AppType.SelfBuild, 0);
  assert.equal(lark.Domain.Feishu, 0);
  const built = createFeishuSdkConnection({ appId: APP, appSecret: SECRET });
  assert.equal(typeof built.open, 'function');
  assert.equal(typeof built.send, 'function');
  const joined = splitFeishuText('你好'.repeat(20)).join('');
  assert.equal(joined, '你好'.repeat(20));
});
test('Feishu receive, dedupe, sticker drop, card, send, edit, media and reconnect', async () => {
  const link = connection((request) => {
    if (request.op === 'upload_image' || request.op === 'upload_file') return { ok: true, key: 'file-key' };
    if (request.op === 'download') return { ok: true, bytes: Uint8Array.from([9, 9]) };
    return { ok: true, message_id: 'om_1' };
  });
  const store = memory();
  const events: SessionInbound[] = [];
  let admitCount = 0;
  const adapter = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.1', app_id: APP,
    app_secret: SECRET, connection: link, retry_ms: 0 }, store);
  await adapter.start({ async admit(event) {
    admitCount += 1;
    events.push(event);
    return { decision: 'accepted', callback_ack: event.payload.type === 'callback' ? 'clicked' : undefined };
  } });
  await link.handlers?.onMessage({ event_id: 'e1', token: 'verification-token', app_id: APP,
    sender: { sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_in', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: 'hello' }) } });
  await link.handlers?.onMessage({ event_id: 'e1', token: 'verification-token', app_id: APP,
    sender: { sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_in', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: 'hello' }) } });
  await link.handlers?.onMessage({ event_id: 'e-sticker', app_id: APP, message: { message_id: 'om_s',
    chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'sticker', content: '{}' } });
  await link.handlers?.onMessage({ event_id: 'e-other-app', app_id: 'cli_other', message: { message_id: 'om_x',
    chat_id: 'oc_chat', message_type: 'text', content: '{"text":"no"}' } });
  const toast = await link.handlers?.onCardAction({ token: 'verification-token',
    operator: { open_id: 'ou_user' }, action: { value: { k: 'yes' } },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' } });
  assert.deepEqual(toast, { toast: { type: 'info', content: 'clicked' } });
  assert.equal(admitCount, 2);
  assert.equal(events[0]?.event_key, `feishu:${APP}:e1`);
  assert.equal(events[0]?.identity.sender_id, 'ou_user');
  assert.equal(events[0]?.identity.topic_id, '0');
  assert.equal(events[1]?.payload.type, 'callback');
  assert.equal(JSON.stringify(events).includes(SECRET), false);
  assert.equal(JSON.stringify(events).includes('verification-token'), false);
  const saved = store.values.get('nb-im-session:fs.1') ?? '';
  assert.equal(saved.includes('e1'), true);
  assert.equal(saved.includes('e-sticker'), true);
  assert.equal(saved.includes('e-other-app'), true);
  const sent = await adapter.send({ type: 'text', target: { chat_id: 'oc_chat' }, text: 'pong',
    buttons: [{ data: 'yes', label: 'Yes' }] });
  assert.equal(sent.status, 'accepted');
  assert.equal(link.sent.some((item) => item.msg_type === 'interactive' && item.content?.includes('"k":"yes"')), true);
  const edited = await adapter.send({ type: 'edit_text', target: { chat_id: 'oc_chat' }, message_id: 'om_1', text: 'next' });
  assert.equal(edited.status, 'accepted');
  assert.equal(link.sent.some((item) => item.op === 'update_message'), true);
  const blocked = await adapter.send({ type: 'edit_text', target: { chat_id: 'oc_chat' }, message_id: 'om_1',
    text: 'next', buttons: [{ data: 'yes', label: 'Yes' }] });
  assert.equal(blocked.diagnostic_code, 'feishu_edit_card_unsupported');
  const ack = await adapter.send({ type: 'callback_ack', callback_id: 'c1', text: 'no' });
  assert.equal(ack.diagnostic_code, 'feishu_callback_inline_only');
  const image = await adapter.send({ type: 'media', target: { chat_id: 'oc_chat' },
    media: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: Uint8Array.from([1]) } });
  assert.equal(image.status, 'accepted');
  assert.equal(link.sent.some((item) => item.op === 'upload_image'), true);
  const voice = await adapter.send({ type: 'media', target: { chat_id: 'oc_chat' },
    media: { kind: 'voice', filename: 'a.mp3', mime: 'audio/mpeg', bytes: Uint8Array.from([1]) } });
  assert.equal(voice.diagnostic_code, 'feishu_voice_container');
  const opus = await adapter.send({ type: 'media', target: { chat_id: 'oc_chat' },
    media: { kind: 'voice', filename: 'a.ogg', mime: 'audio/ogg', bytes: Uint8Array.from([1, 2]) } });
  assert.equal(opus.status, 'accepted');
  assert.equal(link.sent.some((item) => item.op === 'upload_file' && item.file_type === 'opus'), true);
  const file = await adapter.send({ type: 'media', target: { chat_id: 'oc_chat' },
    media: { kind: 'file', filename: 'note.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Uint8Array.from([1]) } });
  assert.equal(file.status, 'accepted');
  assert.equal(link.sent.some((item) => item.file_type === 'stream' && item.file_name === 'note.docx'), true);
  const pdf = await adapter.send({ type: 'media', target: { chat_id: 'oc_chat' },
    media: { kind: 'file', filename: 'a.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1]) } });
  assert.equal(pdf.status, 'accepted');
  assert.equal(link.sent.some((item) => item.file_type === 'pdf'), true);
  const parts = await adapter.send({ type: 'text_parts', target: { chat_id: 'oc_chat' }, parts: ['one', ''] });
  assert.equal(parts.failed_part, 1);
  assert.equal(parts.message_ids.length, 1);
  link.handlers?.onDisconnect();
  for (let i = 0; i < 20 && link.opens < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(link.opens >= 2, true);
  await adapter.stop();
  assert.equal(JSON.stringify(link.sent).includes(SECRET), false);
});
test('Feishu defer does not save the cursor and auth stops the loop', async () => {
  const store = memory();
  const link = connection(() => ({ ok: true, message_id: 'om_1' }));
  const adapter = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.defer', app_id: APP,
    app_secret: SECRET, connection: link, retry_ms: 0 }, store);
  await adapter.start({ async admit() { return { decision: 'defer' }; } });
  await assert.rejects(() => link.handlers?.onMessage({ event_id: 'e2', app_id: APP,
    sender: { sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_2', chat_id: 'oc_chat', chat_type: 'group', message_type: 'text',
      content: '{"text":"later"}' } }), /feishu_deferred/);
  assert.equal(store.values.has('nb-im-session:fs.defer'), false);
  await adapter.stop();
  const auth = connection(() => ({ ok: false }));
  auth.open = async () => ({ ok: false, reason: 'auth' });
  const expired = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.auth', app_id: APP,
    app_secret: SECRET, connection: auth, retry_ms: 0 }, memory());
  await expired.start({ async admit() { return { decision: 'accepted' }; } });
  assert.equal(expired.state, 'auth_expired');
  await expired.stop();
});
test('Feishu stop cancels a hung inbound download and does not admit it', async () => {
  let sinkCalls = 0;
  let handlers: FeishuHandlers | undefined;
  const link: FeishuConnection = {
    async open(next, signal) {
      handlers = next;
      signal.addEventListener('abort', () => next.onDisconnect(), { once: true });
      return { ok: true };
    },
    send(request, signal) {
      if (request.op !== 'download') return Promise.resolve({ ok: true, message_id: 'om_1' });
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  const store = memory();
  const adapter = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.stop-media', app_id: APP,
    app_secret: SECRET, connection: link, retry_ms: 0 }, store);
  await adapter.start({ async admit() { sinkCalls += 1; return { decision: 'accepted' }; } });
  const pending = handlers?.onMessage({ event_id: 'e-media', app_id: APP, message: { message_id: 'om_m',
    chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"img_key"}' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sinkCalls, 0);
  await adapter.stop();
  await Promise.race([pending, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('download_not_cancelled')), 500))]);
  assert.equal(sinkCalls, 0);
  assert.equal(store.values.has('nb-im-session:fs.stop-media'), false);
});
test('Feishu SDK open waits for the auth error and does not log the secret', async () => {
  const appId = 'cli_aabbccddeeff0011';
  const secret = 'feishu-live-app-secret-must-not-log';
  const accessToken = 't-access-token-must-not-log';
  const http = lark.defaultHttpInstance;
  const originalRequest = http.request;
  const originalPost = http.post;
  let endpoints = 0;
  const logs: string[] = [];
  const names = ['error', 'warn', 'info', 'debug', 'log'] as const;
  const saved = names.map((name) => console[name]);
  const secretError = (): Error => Object.assign(new Error('Request failed with status code 401'), {
    config: { data: JSON.stringify({ app_id: appId, app_secret: secret }), headers: { Authorization: `Bearer ${accessToken}` } },
    request: { secret },
    response: { status: 401, data: { app_secret: secret } },
  });
  http.request = ((config: { url?: string }) => {
    endpoints += 1;
    if (String(config?.url ?? '').includes('/callback/ws/endpoint') || endpoints === 1) {
      return Promise.resolve({ code: 99991663, msg: 'invalid credential', data: {} });
    }
    return Promise.reject(secretError());
  }) as typeof http.request;
  http.post = (() => Promise.reject(secretError())) as typeof http.post;
  for (const name of names) {
    console[name] = ((...args: unknown[]) => { logs.push(args.map((arg) => String(arg)).join(' ')); }) as typeof console.log;
  }
  const connection = createFeishuSdkConnection({ appId, appSecret: secret });
  const adapter = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.sdk-auth', app_id: appId,
    app_secret: secret, connection, retry_ms: 0 }, memory());
  try {
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    assert.equal(adapter.state, 'auth_expired');
    assert.equal(endpoints, 1);
    const sent = await connection.send({ op: 'create_message', chat_id: 'oc_chat', msg_type: 'text', content: '{}' },
      new AbortController().signal);
    assert.equal(sent.ok, false);
    assert.equal(JSON.stringify(sent).includes(secret), false);
    assert.equal(JSON.stringify(sent).includes(accessToken), false);
    const beforeStop = endpoints;
    await adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(endpoints, beforeStop);
    const text = logs.join('\n');
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(accessToken), false);
    assert.equal(text.includes('app_secret'), false);
  } finally {
    await adapter.stop().catch(() => undefined);
    http.request = originalRequest;
    http.post = originalPost;
    names.forEach((name, index) => { console[name] = saved[index] as typeof console.log; });
  }
});

test('Feishu threads preserve inbound reply context for text, cards, parts and media without changing main-chat sends', async () => {
  const link = connection((request) => request.op === 'upload_image' || request.op === 'upload_file' ? { ok: true, key: 'uploaded' } : { ok: true, message_id: 'om_out' });
  const events: SessionInbound[] = [];
  const adapter = createFeishuSessionAdapter({ platform: 'feishu_app', instance_id: 'fs.threads', app_id: 'cli_threads', app_secret: SECRET, connection: link, retry_ms: 0 }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  try {
    for (const suffix of ['a', 'b']) await link.handlers?.onMessage({ event_id: `event-${suffix}`, app_id: 'cli_threads', sender: { sender_id: { open_id: 'sender' } }, message: {
      message_id: `om_in_${suffix}`, chat_id: 'oc_same', thread_id: `omt_${suffix}`, chat_type: 'group', message_type: 'text', content: '{"text":"pair"}',
    } });
    assert.deepEqual(events.map((event) => [event.identity.topic_id, event.reply_context]), [['omt_a', 'om_in_a'], ['omt_b', 'om_in_b']]);
    for (const event of events) {
      const target = { chat_id: event.identity.chat_id, topic_id: event.identity.topic_id, reply_context: event.reply_context };
      await adapter.send({ type: 'text', target, text: 'reply' });
      await adapter.send({ type: 'text_parts', target, parts: ['part 1', 'part 2'] });
      await adapter.send({ type: 'text', target, text: 'choose', buttons: [{ data: `ticket-${event.identity.topic_id}`, label: 'Yes' }] });
      for (const [kind, mime] of [['image', 'image/png'], ['voice', 'audio/ogg'], ['file', 'text/plain']] as const) {
        const sent = await adapter.send({ type: 'media', target, media: { kind, mime, filename: 'sample', bytes: Uint8Array.from([1]) } });
        assert.equal(sent.status, 'accepted');
      }
    }
    const replies = link.sent.filter((request) => request.op === 'reply_message');
    assert.equal(replies.length, 14);
    assert.deepEqual([...new Set(replies.map((request) => request.message_id))], ['om_in_a', 'om_in_b']);
    assert.equal(link.sent.some((request) => request.op === 'create_message'), false);
    const card = replies.find((request) => request.msg_type === 'interactive')!;
    const value = JSON.parse(card.content!).body.elements[1].behaviors[0].value;
    assert.equal(value.topic_id, 'omt_a');
    await link.handlers?.onCardAction({ event_id: 'click', operator: { open_id: 'sender' }, action: { value }, context: { open_message_id: 'om_out', open_chat_id: 'oc_same' } });
    assert.equal(events.at(-1)?.identity.topic_id, 'omt_a');
    const calls = link.sent.length;
    for (const message of [
      { type: 'text' as const, target: { chat_id: 'oc_same', topic_id: 'omt_missing' }, text: 'do not leak' },
      { type: 'media' as const, target: { chat_id: 'oc_same', topic_id: 'omt_missing' }, media: { kind: 'file' as const, filename: 'sample', mime: 'text/plain', bytes: Uint8Array.from([1]) } },
    ]) assert.equal((await adapter.send(message)).diagnostic_code, 'feishu_thread_context_missing');
    assert.equal(link.sent.length, calls);
    assert.equal((await adapter.send({ type: 'text', target: { chat_id: 'oc_main' }, text: 'ordinary' })).status, 'accepted');
    assert.equal(link.sent.at(-1)?.op, 'create_message');
    assert.equal(link.sent.at(-1)?.chat_id, 'oc_main');
  } finally { await adapter.stop(); }
});

test('Feishu SDK emits reply endpoint and thread flag, while ordinary sends keep create endpoint', async () => {
  const http = lark.defaultHttpInstance;
  const originalRequest = http.request;
  const originalPost = http.post;
  const requests: { url?: string; data?: unknown }[] = [];
  http.post = (() => Promise.resolve({ code: 0, tenant_access_token: 'offline-token', expire: 7200 })) as typeof http.post;
  http.request = ((request: { url?: string; data?: unknown }) => {
    requests.push(request);
    return Promise.resolve({ code: 0, data: { message_id: 'om_sent' } });
  }) as typeof http.request;
  try {
    const sdk = createFeishuSdkConnection({ appId: 'cli_0011223344556677', appSecret: 'offline-secret' });
    assert.equal((await sdk.send({ op: 'reply_message', message_id: 'om_parent', msg_type: 'text', content: '{"text":"reply"}' }, new AbortController().signal)).ok, true);
    assert.equal((await sdk.send({ op: 'create_message', chat_id: 'oc_main', msg_type: 'text', content: '{"text":"ordinary"}' }, new AbortController().signal)).ok, true);
    assert.ok(requests[0]?.url?.endsWith('/im/v1/messages/om_parent/reply'));
    assert.deepEqual(requests[0]?.data, { msg_type: 'text', content: '{"text":"reply"}', reply_in_thread: true });
    assert.ok(requests[1]?.url?.endsWith('/im/v1/messages'));
    assert.deepEqual(requests[1]?.data, { receive_id: 'oc_main', msg_type: 'text', content: '{"text":"ordinary"}' });
  } finally {
    http.request = originalRequest;
    http.post = originalPost;
  }
});

test('Feishu separates mp4 file attachments (stream + file) from native video sends (mp4 + media) and preserves rejected/unknown outcomes', async () => {
  const http = lark.defaultHttpInstance;
  const originalRequest = http.request;
  const originalPost = http.post;
  const requests: { url?: string; data?: Record<string, unknown> }[] = [];
  let mode: 'ok' | 'rejected_upload' | 'unknown_send' = 'ok';
  let fileIndex = 0;
  http.post = (() => Promise.resolve({ code: 0, tenant_access_token: 'offline-token', expire: 7200 })) as typeof http.post;
  http.request = ((request: { url?: string; data?: Record<string, unknown> }) => {
    requests.push(request);
    if (String(request?.url ?? '').endsWith('/im/v1/files')) {
      if (mode === 'rejected_upload') {
        return Promise.reject(Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 234001 } },
        }));
      }
      fileIndex += 1;
      return Promise.resolve({ data: { file_key: `file_v_${fileIndex}` } });
    }
    if (mode === 'unknown_send') {
      return Promise.reject(new Error('socket hang up'));
    }
    return Promise.resolve({ code: 0, data: { message_id: `om_vid_${fileIndex}` } });
  }) as typeof http.request;

  const sdk = createFeishuSdkConnection({ appId: 'cli_0011223344556677', appSecret: 'offline-secret' });
  const inbound: SessionInbound[] = [];
  let handlers: FeishuHandlers | undefined;
  const adapter = createFeishuSessionAdapter({
    platform: 'feishu_app',
    instance_id: 'fs.video-outbound',
    app_id: 'cli_0011223344556677',
    app_secret: 'offline-secret',
    connection: {
      async open(next) {
        handlers = next;
        return { ok: true, bot_open_id: 'ou_bot' };
      },
      send: (request, signal) => sdk.send(request, signal),
    },
    retry_ms: 0,
  }, memory());

  await adapter.start({ async admit(event) { inbound.push(event); return { decision: 'accepted' }; } });
  try {
    await handlers?.onMessage({
      event_id: 'e-group-mention-self',
      app_id: 'cli_0011223344556677',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_group_1',
        parent_id: 'om_root_0',
        create_time: '1762680000000',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 @_user_2 check clip' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Other' },
          { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Bot' },
        ],
      },
    });
    await handlers?.onMessage({
      event_id: 'e-group-mention-other',
      app_id: 'cli_0011223344556677',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_group_2',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 only for other member' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Other' },
          { key: '@_user_2', name: 'PlaceholderWithoutId' },
        ],
      },
    });
    assert.equal(inbound[0]?.source_message_id, 'om_group_1');
    assert.equal(inbound[0]?.reply_to_message_id, 'om_root_0');
    assert.equal(inbound[0]?.mentioned, true);
    assert.deepEqual(inbound[0]?.mention_ids, ['ou_other', 'ou_bot']);
    assert.equal(inbound[0]?.timestamp, 1762680000000);
    assert.equal(inbound[1]?.source_message_id, 'om_group_2');
    assert.equal(inbound[1]?.mentioned, undefined);
    assert.deepEqual(inbound[1]?.mention_ids, ['ou_other']);

    const unknownBotInbound: SessionInbound[] = [];
    let unknownBotHandlers: FeishuHandlers | undefined;
    const unknownBotAdapter = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'fs.unknown-bot-identity',
      app_id: 'cli_0011223344556678',
      app_secret: 'offline-secret',
      connection: {
        async open(next) {
          unknownBotHandlers = next;
          return { ok: true };
        },
        send: (request, signal) => sdk.send(request, signal),
      },
      retry_ms: 0,
    }, memory());
    await unknownBotAdapter.start({ async admit(event) { unknownBotInbound.push(event); return { decision: 'accepted' }; } });
    try {
      await unknownBotHandlers?.onMessage({
        event_id: 'e-unknown-bot',
        app_id: 'cli_0011223344556678',
        sender: { sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_unknown_1',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 hello' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone' }, name: 'Someone' }],
        },
      });
      assert.equal(unknownBotInbound[0]?.mentioned, undefined);
      assert.deepEqual(unknownBotInbound[0]?.mention_ids, ['ou_someone']);
    } finally {
      await unknownBotAdapter.stop();
    }

    const fileMp4 = await adapter.send({
      type: 'media',
      target: { chat_id: 'oc_group' },
      media: { kind: 'file', filename: 'archive.mp4', mime: 'video/mp4', bytes: Uint8Array.from([1, 2, 3]) },
    });
    assert.equal(fileMp4.status, 'accepted');
    assert.equal(requests[0]?.data?.file_type, 'stream');
    assert.equal(requests[0]?.data?.file_name, 'archive.mp4');
    assert.deepEqual(requests[1]?.data, {
      receive_id: 'oc_group',
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file_v_1' }),
    });

    const nativeVideo = await adapter.send({
      type: 'media',
      target: { chat_id: 'oc_group' },
      media: { kind: 'video', filename: 'demo.mp4', mime: 'video/mp4', bytes: Uint8Array.from([4, 5, 6]) },
    });
    assert.equal(nativeVideo.status, 'accepted');
    assert.equal(requests[2]?.data?.file_type, 'mp4');
    assert.equal(requests[2]?.data?.file_name, 'demo.mp4');
    assert.deepEqual(requests[3]?.data, {
      receive_id: 'oc_group',
      msg_type: 'media',
      content: JSON.stringify({ file_key: 'file_v_2' }),
    });

    const badVideo = await adapter.send({
      type: 'media',
      target: { chat_id: 'oc_group' },
      media: { kind: 'video', filename: 'demo.webm', mime: 'video/webm', bytes: Uint8Array.from([7]) },
    });
    assert.equal(badVideo.status, 'failed');
    assert.equal(badVideo.error_kind, 'bad_format');
    assert.equal(badVideo.diagnostic_code, 'feishu_video_container');
    assert.equal(requests.length, 4);

    mode = 'rejected_upload';
    const rejected = await adapter.send({
      type: 'media',
      target: { chat_id: 'oc_group' },
      media: { kind: 'video', filename: 'reject.mp4', mime: 'video/mp4', bytes: Uint8Array.from([8]) },
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error_kind, 'bad_format');
    assert.equal(rejected.diagnostic_code, 'feishu_bad_request');
    assert.equal(requests.length, 5);

    mode = 'unknown_send';
    const unknown = await adapter.send({
      type: 'media',
      target: { chat_id: 'oc_group' },
      media: { kind: 'video', filename: 'uncertain.mp4', mime: 'video/mp4', bytes: Uint8Array.from([9]) },
    });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.diagnostic_code, 'feishu_rejected');
    assert.equal(requests.length, 7);
  } finally {
    await adapter.stop();
    http.request = originalRequest;
    http.post = originalPost;
  }
});

test('Feishu SDK publishes ready and receives messages even when /bot/v3/info hangs or rejects, then applies late bot identity', async () => {
  const appId = 'cli_0011223344556699';
  const secret = 'offline-secret';
  const http = lark.defaultHttpInstance;
  const originalRequest = http.request;
  const originalPost = http.post;
  const originalWsStart = lark.WSClient.prototype.start;
  const originalWsClose = lark.WSClient.prototype.close;

  let botInfoMode: 'hang' | 'reject' | 'resolve_late' = 'hang';
  let releaseBotInfo: ((value: unknown) => void) | undefined;
  let capturedDispatcher: lark.EventDispatcher | undefined;

  http.post = (() => Promise.resolve({ code: 0, tenant_access_token: 'offline-token', expire: 7200 })) as typeof http.post;
  http.request = ((request: { url?: string }) => {
    const url = String(request?.url ?? '');
    if (url.includes('/bot/v3/info')) {
      if (botInfoMode === 'reject') {
        return Promise.reject(Object.assign(new Error('bot info forbidden'), { response: { status: 403 } }));
      }
      if (botInfoMode === 'resolve_late') {
        return new Promise((resolve) => { releaseBotInfo = resolve; });
      }
      return new Promise(() => undefined);
    }
    return Promise.resolve({ code: 0, data: { message_id: 'om_sdk_1' } });
  }) as typeof http.request;

  lark.WSClient.prototype.start = async function (this: { onReady?: () => void }, params: { eventDispatcher: lark.EventDispatcher }) {
    capturedDispatcher = params.eventDispatcher;
    this.onReady?.();
  };
  lark.WSClient.prototype.close = function () {};

  try {
    for (const [index, mode] of (['hang', 'reject'] as const).entries()) {
      botInfoMode = mode;
      const modeAppId = `cli_001122334455660${index}`;
      const sdk = createFeishuSdkConnection({ appId: modeAppId, appSecret: secret });
      const admitted: SessionInbound[] = [];
      const adapter = createFeishuSessionAdapter({
        platform: 'feishu_app',
        instance_id: `fs.sdk-ready-${index}`,
        app_id: modeAppId,
        app_secret: secret,
        connection: sdk,
        retry_ms: 0,
      }, memory());

      await Promise.race([
        adapter.start({ async admit(event) { admitted.push(event); return { decision: 'accepted' }; } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`start_hung_${mode}`)), 300)),
      ]);
      assert.equal(adapter.state, 'running');

      await capturedDispatcher?.invoke({
        schema: '2.0',
        header: { event_id: `ev-${mode}-1`, event_type: 'im.message.receive_v1', app_id: modeAppId },
        event: {
          sender: { sender_id: { open_id: 'ou_member' } },
          message: {
            message_id: `om_${mode}_1`,
            chat_id: 'oc_room',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@_user_1 hello while bot info unavailable' }),
            mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_real' }, name: 'Bot' }],
          },
        },
      }, { needCheck: false });

      assert.equal(admitted.length, 1);
      assert.equal(admitted[0]?.mentioned, undefined);
      assert.deepEqual(admitted[0]?.mention_ids, ['ou_bot_real']);
      await adapter.stop();
    }

    botInfoMode = 'resolve_late';
    const sdk = createFeishuSdkConnection({ appId, appSecret: secret });
    const admitted: SessionInbound[] = [];
    const adapter = createFeishuSessionAdapter({
      platform: 'feishu_app',
      instance_id: 'fs.sdk-ready-late',
      app_id: appId,
      app_secret: secret,
      connection: sdk,
      retry_ms: 0,
    }, memory());

    await adapter.start({ async admit(event) { admitted.push(event); return { decision: 'accepted' }; } });
    assert.equal(adapter.state, 'running');
    for (let i = 0; i < 20 && !releaseBotInfo; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseBotInfo?.({ code: 0, bot: { open_id: 'ou_bot_real' } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await capturedDispatcher?.invoke({
      schema: '2.0',
      header: { event_id: 'ev-late-2', event_type: 'im.message.receive_v1', app_id: appId },
      event: {
        sender: { sender_id: { open_id: 'ou_member' } },
        message: {
          message_id: 'om_late_2',
          chat_id: 'oc_room',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 now bot identity is known' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_real' }, name: 'Bot' }],
        },
      },
    }, { needCheck: false });

    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.mentioned, true);
    assert.deepEqual(admitted[0]?.mention_ids, ['ou_bot_real']);
    await adapter.stop();
  } finally {
    http.request = originalRequest;
    http.post = originalPost;
    lark.WSClient.prototype.start = originalWsStart;
    lark.WSClient.prototype.close = originalWsClose;
  }
});

test('Feishu post rich-text messages extract ordered text and images, locale wrappers, failed images and single-media captions', async () => {
  const link = connection((request) => {
    if (request.op === 'download') {
      if (request.resource_key === 'img_fail') return { ok: false, http_status: 404 };
      if (request.resource_key === 'img_big') return { ok: false, too_large: true };
      if (request.resource_key === 'img_1') return { ok: true, bytes: Uint8Array.from([1, 1]) };
      if (request.resource_key === 'img_2') return { ok: true, bytes: Uint8Array.from([2, 2]) };
      return { ok: true, bytes: Uint8Array.from([3, 3]) };
    }
    return { ok: true, message_id: 'om_out' };
  });
  const events: SessionInbound[] = [];
  const adapter = createFeishuSessionAdapter({
    platform: 'feishu_app',
    instance_id: 'fs.rich-post',
    app_id: 'cli_0011223344556688',
    app_secret: SECRET,
    connection: link,
    retry_ms: 0,
  }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  try {
    await link.handlers?.onMessage({
      event_id: 'e-post-direct',
      app_id: 'cli_0011223344556688',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_post_1',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          title: 'Bug Report',
          content: [
            [{ tag: 'at', user_id: '@_user_1', user_name: 'Kiki' }, { tag: 'text', text: ' look at first screenshot:' }],
            [{ tag: 'img', image_key: 'img_1' }],
            [{ tag: 'text', text: 'and second screenshot:' }, { tag: 'img', image_key: 'img_2' }, { tag: 'text', text: 'After second image' }],
          ],
        }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Kiki' }],
      },
    });
    await link.handlers?.onMessage({
      event_id: 'e-post-locale-fail',
      app_id: 'cli_0011223344556688',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_post_2',
        chat_id: 'oc_group',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '',
            content: [
              [{ tag: 'text', text: 'Text before broken image' }],
              [{ tag: 'img', image_key: 'img_fail' }],
              [{ tag: 'text', text: 'Text after broken image' }],
            ],
          },
        }),
      },
    });
    await link.handlers?.onMessage({
      event_id: 'e-post-text-only',
      app_id: 'cli_0011223344556688',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_post_3',
        chat_id: 'oc_group',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: 'Heading',
          content: [
            [{ tag: 'text', text: 'Line 1 ' }, { tag: 'a', text: 'link', href: 'https://example.com' }],
            [{ tag: 'text', text: 'Line 2' }],
          ],
        }),
      },
    });
    await link.handlers?.onMessage({
      event_id: 'e-single-media-caption',
      app_id: 'cli_0011223344556688',
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: {
        message_id: 'om_img_cap',
        chat_id: 'oc_group',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_fail', caption: 'Single image caption survives failure' }),
      },
    });

    assert.equal(events.length, 4);
    assert.deepEqual(events[0]?.payload, {
      type: 'parts',
      parts: [
        { type: 'text', text: 'Bug Report\n@Kiki look at first screenshot:' },
        { type: 'media', media: { kind: 'image', filename: 'image', mime: 'image/jpeg', bytes: Uint8Array.from([1, 1]) } },
        { type: 'text', text: 'and second screenshot:' },
        { type: 'media', media: { kind: 'image', filename: 'image', mime: 'image/jpeg', bytes: Uint8Array.from([2, 2]) } },
        { type: 'text', text: 'After second image' },
      ],
    });
    assert.deepEqual(events[1]?.payload, {
      type: 'parts',
      parts: [
        { type: 'text', text: 'Text before broken image' },
        { type: 'media_unavailable', kind: 'image', reason: 'download_failed' },
        { type: 'text', text: 'Text after broken image' },
      ],
    });
    assert.deepEqual(events[2]?.payload, {
      type: 'text',
      text: 'Heading\nLine 1 link\nLine 2',
    });
    assert.deepEqual(events[3]?.payload, {
      type: 'media_unavailable',
      kind: 'image',
      reason: 'download_failed',
      caption: 'Single image caption survives failure',
    });
  } finally {
    await adapter.stop();
  }
});

test('Feishu SDK keeps quiet healthy sockets open and automatically recovers half-open and closed local sockets', async () => {
  const appId = 'cli_0011223344556677';
  const http = lark.defaultHttpInstance;
  const originalRequest = http.request;
  const originalPost = http.post;
  let mode: 'responsive' | 'half-open' = 'responsive';
  let connections = 0;
  let frames = 0;
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/callback/ws/endpoint')) {
      response.end(JSON.stringify({ code: 0, data: {
        URL: 'ws://fixture.invalid/socket?device_id=fixture&service_id=1',
        ClientConfig: { PingInterval: 0.1, ReconnectCount: 5, ReconnectInterval: 0.02, ReconnectNonce: 0 },
      } }));
      return;
    }
    response.end(JSON.stringify({ code: 0, bot: { open_id: 'ou_fixture' }, data: {} }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    connections += 1;
    socket.on('message', (data) => {
      frames += 1;
      if (mode === 'responsive') socket.send(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture_port_missing');
  const port = address.port;
  const observed = new Set<string>();
  const until = async (read: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      observed.add(adapter.state);
      if (read()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${label}: state=${adapter.state} connections=${connections} frames=${frames} observed=${[...observed].join(',')}`);
  };
  http.post = (() => Promise.resolve({ code: 0, tenant_access_token: 'offline-token', expire: 7200 })) as typeof http.post;
  http.request = (async (config: { method?: string; url?: string; data?: unknown }) => {
    const url = new URL(config.url ?? '/callback/ws/endpoint', 'https://fixture.invalid');
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: config.method ?? 'POST', headers: { 'content-type': 'application/json' },
      body: config.data === undefined ? undefined : JSON.stringify(config.data), signal: AbortSignal.timeout(1000),
    });
    return await response.json();
  }) as typeof http.request;
  const connection = createFeishuSdkConnection({
    appId, appSecret: 'offline-fixture-secret', connectionHost: `127.0.0.1:${port}`,
    handshakeTimeoutMs: 500, pingTimeout: 0.05,
  });
  const adapter = createFeishuSessionAdapter({
    platform: 'feishu_app', instance_id: 'fs.local-recovery', app_id: appId,
    app_secret: 'offline-fixture-secret', connection, retry_ms: 0,
  }, memory());
  try {
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    assert.equal(adapter.state, 'running');
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(connections, 1);
    assert.ok(frames >= 2);
    mode = 'half-open';
    await until(() => adapter.state === 'reconnecting', 'half-open socket did not enter reconnecting');
    mode = 'responsive';
    await until(() => connections >= 2 && adapter.state === 'running', 'half-open socket did not recover');
    assert.equal(connections, 2);
    for (const socket of sockets.clients) socket.close();
    await until(() => connections >= 3 && adapter.state === 'running', 'closed socket did not recover');
    assert.equal(connections, 3);
    await adapter.stop();
    const stopped = connections;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, stopped);
  } finally {
    await adapter.stop().catch(() => undefined);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    http.request = originalRequest;
    http.post = originalPost;
  }
});
