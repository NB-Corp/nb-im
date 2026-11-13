import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createTelegramSessionAdapter } from '../src/session/telegram.ts';
import { splitSessionText, TELEGRAM_TEXT_CHARACTERS, abortError } from '../src/session/contract.ts';
import type { SessionCursorStore, SessionInbound, TelegramBotTransport, TelegramCall } from '../src/session/contract.ts';

const SECRET = '123456789:ABCDEFGHIJklmnopqrstuvwxyz';
function memory(): SessionCursorStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async load(scope) { return values.get(scope); }, async save(scope, cursor) { values.set(scope, cursor); } };
}
function hang(signal: AbortSignal): Promise<{ http_status: number; body: unknown }> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}
function update(id: number, extra: Record<string, unknown>) {
  return { update_id: id, ...extra };
}
test('splitSessionText keeps every character', () => {
  const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`;
  const parts = splitSessionText(text, TELEGRAM_TEXT_CHARACTERS);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.length <= TELEGRAM_TEXT_CHARACTERS));
});
test('Telegram receive, cursor, duplicate, send, edit, callback, media, cancel, reconnect, conflict', async () => {
  const calls: TelegramCall[] = [];
  let updates = 0;
  let sinkCount = 0;
  let admit: (event: SessionInbound) => Promise<{ decision: 'accepted'; callback_ack?: string } | { decision: 'defer' }> =
    async () => ({ decision: 'accepted' });
  const seen: SessionInbound[] = [];
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      calls.push(request);
      if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 42 } } };
      if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
      if (request.method === 'getUpdates') {
        updates += 1;
        if (updates === 1) throw new Error('down');
        if (updates === 2) {
          return { http_status: 200, body: { ok: true, result: [
            update(7, { message: { message_id: 1, text: 'hello', chat: { id: 9, type: 'private' }, from: { id: 8 } } }),
            update(8, { message: { message_id: 2, text: 'again', chat: { id: 9, type: 'private' }, from: { id: 8 } } }),
          ] } };
        }
        if (updates === 3) {
          return { http_status: 200, body: { ok: true, result: [
            update(8, { message: { message_id: 2, text: 'again', chat: { id: 9, type: 'private' }, from: { id: 8 } } }),
            update(9, { callback_query: { id: 'cb1', data: 'yes', from: { id: 8 },
              message: { message_id: 3, chat: { id: 9, type: 'private' } } } }),
          ] } };
        }
        return hang(signal);
      }
      if (request.method === 'sendMessage' && request.json?.text === 'block') {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
      }
      if (request.method === 'getFile') return { http_status: 200, body: { ok: true, result: { file_path: 'photos/a.jpg', file_size: 4 } } };
      return { http_status: 200, body: { ok: true, result: { message_id: 100 + calls.length } } };
    },
    async download(filePath) {
      assert.equal(filePath.includes('..'), false);
      return { ok: true, bytes: Uint8Array.from([1, 2, 3, 4]) };
    },
  };
  const store = memory();
  const spec = { platform: 'telegram' as const, instance_id: 'tg.main', token: SECRET, transport, retry_ms: 0 };
  const adapter = createTelegramSessionAdapter(spec, store);
  const again = createTelegramSessionAdapter({ ...spec, instance_id: 'tg.other' }, store);
  assert.equal(again, adapter);
  assert.equal(adapter.instance_id, 'tg.main');
  let sawReconnecting = false;
  const original = transport.call.bind(transport);
  transport.call = async (request, signal) => {
    if (request.method === 'getUpdates' && updates === 1) sawReconnecting = adapter.state === 'reconnecting';
    return original(request, signal);
  };
  const started = adapter.start({ async admit(event) {
    sinkCount += 1; seen.push(event);
    return event.payload.type === 'callback' ? { decision: 'accepted', callback_ack: 'ok' } : { decision: 'accepted' };
  } });
  await started;
  for (let i = 0; i < 30 && seen.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sawReconnecting, true);
  assert.equal(seen[0]?.event_key, 'tg:42:7');
  assert.equal(seen[0]?.payload.type === 'text' && seen[0].payload.text, 'hello');
  assert.equal(store.values.get('nb-im-session:tg.main'), '{"v":1,"offset":10}');
  assert.equal(sinkCount, 3);
  assert.equal(seen[2]?.payload.type, 'callback');
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
  const answered = calls.some((call) => call.method === 'answerCallbackQuery');
  assert.equal(answered, true);
  const sent = await adapter.send({ type: 'text', target: { chat_id: '9', topic_id: '0' }, text: 'pong',
    buttons: [{ data: 'yes', label: 'Yes' }] });
  assert.equal(sent.status, 'accepted');
  assert.equal(JSON.stringify(sent).includes(SECRET), false);
  const markup = calls.find((call) => call.method === 'sendMessage' && call.json?.text === 'pong');
  assert.equal((markup?.json?.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]?.[0]?.callback_data, 'yes');
  const edited = await adapter.send({ type: 'edit_text', target: { chat_id: '9' }, message_id: '100', text: 'edited' });
  assert.equal(edited.status, 'accepted');
  assert.equal(calls.some((call) => call.method === 'editMessageText'), true);
  const parts = await adapter.send({ type: 'text_parts', target: { chat_id: '9' }, parts: ['one', 'x'.repeat(4097)] });
  assert.equal(parts.failed_part, 1);
  assert.equal(parts.message_ids.length, 1);
  const tooLong = await adapter.send({ type: 'text', target: { chat_id: '9' }, text: 'y'.repeat(4097) });
  assert.equal(tooLong.diagnostic_code, 'telegram_text_too_long');
  const empty = await adapter.send({ type: 'text', target: { chat_id: '9' }, text: '' });
  assert.equal(empty.diagnostic_code, 'session_empty_text');
  const voice = await adapter.send({ type: 'media', target: { chat_id: '9' },
    media: { kind: 'voice', filename: 'a.wav', mime: 'audio/wav', bytes: Uint8Array.from([1]) } });
  assert.equal(voice.diagnostic_code, 'telegram_voice_container');
  assert.equal(calls.some((call) => call.method === 'sendDocument' || call.method === 'sendVoice'), false);
  const photo = await adapter.send({ type: 'media', target: { chat_id: '9' }, caption: 'cap',
    media: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: Uint8Array.from([1, 2]) } });
  assert.equal(photo.status, 'accepted');
  assert.equal(calls.some((call) => call.method === 'sendPhoto' && call.file?.field === 'photo'), true);
  const pre = new AbortController();
  pre.abort();
  const before = calls.filter((call) => call.method === 'sendMessage').length;
  const cancelled = await adapter.send({ type: 'text', target: { chat_id: '9' }, text: 'nope' }, pre.signal);
  assert.equal(cancelled.diagnostic_code, 'cancelled');
  assert.equal(calls.filter((call) => call.method === 'sendMessage').length, before);
  const during = new AbortController();
  const unknown = adapter.send({ type: 'text', target: { chat_id: '9' }, text: 'block' }, during.signal);
  during.abort();
  assert.equal((await unknown).diagnostic_code, 'cancelled_after_dispatch');
  await adapter.stop();
  assert.equal(calls.some((call) => call.method === 'deleteWebhook'), false);
  const source = readFileSync(new URL('../src/session/telegram.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../src/session/telegram-http.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('deleteWebhook'), false);
});
test('Telegram normal and edited messages preserve source metadata without extra transport calls', async () => {
  const calls: TelegramCall[] = [];
  let pages = 0;
  const text = 'Hi 😀 @sElFbOt @other';
  const selfOffset = text.indexOf('@sElFbOt');
  const otherOffset = text.indexOf('@other');
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      calls.push(request);
      if (request.method === 'getMe') {
        return { http_status: 200, body: { ok: true, result: { id: 42, username: 'SelfBot' } } };
      }
      if (request.method === 'getWebhookInfo') {
        return { http_status: 200, body: { ok: true, result: { url: '' } } };
      }
      if (request.method === 'getUpdates') {
        pages += 1;
        if (pages === 1) {
          return { http_status: 200, body: { ok: true, result: [
            update(41, { message: {
              message_id: 9001, date: 1_700_000_000, text,
              entities: [
                { type: 'text_mention', offset: 0, length: 2, user: { id: 77 } },
                { type: 'mention', offset: selfOffset, length: '@sElFbOt'.length },
                { type: 'mention', offset: otherOffset, length: '@other'.length },
              ],
              chat: { id: -100, type: 'supergroup', title: 'Real room' },
              from: { id: 8, first_name: 'Alice', last_name: 'Sender' }, message_thread_id: 12,
              reply_to_message: { message_id: 8999, forum_topic_created: { name: 'Original' } },
            } }),
            update(42, { edited_message: {
              message_id: 9001, date: 1_700_000_010, text: 'edited',
              chat: { id: -100, type: 'supergroup', title: 'Real room' },
              from: { id: 42, first_name: 'Self', last_name: 'Bot', username: 'selfbot' }, message_thread_id: 12,
              reply_to_message: { message_id: 9000 },
            } }),
          ] } };
        }
        return hang(signal);
      }
      throw new Error(`unexpected telegram method: ${request.method}`);
    },
    async download() { throw new Error('unexpected telegram download'); },
  };
  const events: SessionInbound[] = [];
  const adapter = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'tg.metadata',
    token: '555555:EEEEEEEEEEEEEEEEEEEE', transport, retry_ms: 0 }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 2);
  const normal = events[0]!;
  assert.equal(normal.event_key, 'tg:42:41');
  assert.equal(normal.platform_event_id, '41');
  assert.equal(normal.source_message_id, '9001');
  assert.equal(normal.operation, 'create');
  assert.equal(normal.timestamp, 1_700_000_000_000);
  assert.equal(normal.mentioned, true);
  assert.deepEqual(normal.mention_ids, ['77', '42']);
  assert.equal(normal.reply_to_message_id, '8999');
  assert.equal(normal.is_self, false);
  assert.deepEqual(normal.identity, {
    platform: 'telegram', account_id: '42', chat_id: '-100', sender_id: '8', topic_id: '12',
    chat_kind: 'group', chat_title: 'Real room', sender_name: 'Alice Sender', topic_title: 'Original',
  });
  assert.equal(normal.payload.type === 'text' && normal.payload.text, text);
  const edited = events[1]!;
  assert.equal(edited.event_key, 'tg:42:42');
  assert.equal(edited.platform_event_id, '42');
  assert.equal(edited.source_message_id, '9001');
  assert.equal(edited.operation, 'edit');
  assert.equal(edited.timestamp, 1_700_000_010_000);
  assert.equal(edited.mentioned, false);
  assert.deepEqual(edited.mention_ids, []);
  assert.equal(edited.reply_to_message_id, '9000');
  assert.equal(edited.is_self, true);
  assert.deepEqual(edited.identity, {
    platform: 'telegram', account_id: '42', chat_id: '-100', sender_id: '42', topic_id: '12',
    chat_kind: 'group', chat_title: 'Real room', sender_name: 'Self Bot',
  });
  const poll = calls.find((call) => call.method === 'getUpdates');
  assert.deepEqual(poll?.json?.allowed_updates, ['message', 'edited_message', 'callback_query']);
  await adapter.stop();
  assert.deepEqual(calls.slice(0, 3).map((call) => call.method), ['getMe', 'getWebhookInfo', 'getUpdates']);
  assert.ok(calls.slice(3).every((call) => call.method === 'getUpdates'));
});
test('Telegram webhook and poll conflict do not delete the webhook', async () => {
  for (const mode of ['info', 'poll'] as const) {
    const calls: string[] = [];
    const transport: TelegramBotTransport = {
      async call(request) {
        calls.push(request.method);
        if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 1 } } };
        if (request.method === 'getWebhookInfo') {
          return mode === 'info' ? { http_status: 200, body: { ok: true, result: { url: 'https://example.com/hook' } } } :
            { http_status: 200, body: { ok: true, result: { url: '' } } };
        }
        return { http_status: 409, body: { ok: false, error_code: 409, description: 'Conflict: terminated by setWebhook' } };
      },
      async download() { return { ok: false }; },
    };
    const adapter = createTelegramSessionAdapter({ platform: 'telegram', instance_id: `tg.${mode}`,
      token: mode === 'info' ? '111111:AAAAAAAAAAAAAAAAAAAA' : '222222:BBBBBBBBBBBBBBBBBBBB',
      transport, retry_ms: 0 }, memory());
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    try {
      for (let i = 0; i < 20 && adapter.state !== 'conflict'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(adapter.state, 'conflict');
      assert.equal(calls.includes('deleteWebhook'), false);
      assert.equal(calls.includes('getUpdates'), mode === 'poll');
    } finally {
      await adapter.stop();
    }
  }
});
test('Telegram oversize photo is not downloaded and a bad file path is refused', async () => {
  const downloads: string[] = [];
  let page = 0;
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 3 } } };
      if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
      if (request.method === 'getUpdates') {
        page += 1;
        if (page === 1) return { http_status: 200, body: { ok: true, result: [
          update(1, { message: { message_id: 1, photo: [{ file_id: 'big', file_size: 21 * 1024 * 1024 }],
            chat: { id: 1, type: 'private' }, from: { id: 2 } } }),
          update(2, { message: { message_id: 2, document: { file_id: 'doc', file_name: 'a.txt' },
            chat: { id: 1, type: 'private' }, from: { id: 2 } } }),
        ] } };
        return hang(signal);
      }
      if (request.method === 'getFile') return { http_status: 200, body: { ok: true, result: { file_path: '../secret', file_size: 4 } } };
      return { http_status: 200, body: { ok: true, result: {} } };
    },
    async download(filePath) { downloads.push(filePath); return { ok: true, bytes: Uint8Array.from([1]) }; },
  };
  const events: SessionInbound[] = [];
  const adapter = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'tg.media',
    token: '333333:CCCCCCCCCCCCCCCCCCCC',
    transport, retry_ms: 0 }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events[0]?.payload.type, 'media_unavailable');
  assert.equal(events[1]?.payload.type, 'media_unavailable');
  assert.deepEqual(downloads, []);
  await adapter.stop();
});
test('Telegram defer does not advance the cursor', async () => {
  let page = 0;
  const store = memory();
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 5 } } };
      if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
      page += 1;
      if (page <= 2) return { http_status: 200, body: { ok: true, result: [
        update(4, { message: { message_id: 1, text: 'hold', chat: { id: 1, type: 'private' }, from: { id: 2 } } }),
      ] } };
      return hang(signal);
    },
    async download() { return { ok: false }; },
  };
  let calls = 0;
  const adapter = createTelegramSessionAdapter({ platform: 'telegram', instance_id: 'tg.defer',
    token: '444444:DDDDDDDDDDDDDDDDDDDD',
    transport, retry_ms: 0 }, store);
  await adapter.start({ async admit() { calls += 1; return calls === 1 ? { decision: 'defer' } : { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && calls < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls >= 2, true);
  assert.equal(store.values.get('nb-im-session:tg.defer'), '{"v":1,"offset":5}');
  await adapter.stop();
  assert.equal(JSON.stringify(calls).includes(SECRET), false);
});
test('Telegram preserves caption on failed or oversized media download', async () => {
  let page = 0;
  const store = memory();
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 6, username: 'KikiBot' } } };
      if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
      if (request.method === 'getUpdates') {
        page += 1;
        if (page === 1) {
          return {
            http_status: 200,
            body: {
              ok: true,
              result: [
                update(10, {
                  message: {
                    message_id: 100,
                    caption: 'Caption for failed photo',
                    photo: [{ file_id: 'bad_photo', file_size: 10 }],
                    chat: { id: 1, type: 'private' },
                    from: { id: 2 },
                  },
                }),
                update(11, {
                  message: {
                    message_id: 101,
                    caption: 'Caption for huge photo',
                    photo: [{ file_id: 'huge_photo', file_size: 30_000_000 }],
                    chat: { id: 1, type: 'private' },
                    from: { id: 2 },
                  },
                }),
              ],
            },
          };
        }
        return hang(signal);
      }
      if (request.method === 'getFile') {
        return { http_status: 500, body: { ok: false, error_code: 500, description: 'failed' } };
      }
      return { http_status: 200, body: { ok: true, result: {} } };
    },
    async download() {
      return { ok: true, bytes: Uint8Array.from([7, 8]) };
    },
  };
  const events: SessionInbound[] = [];
  const adapter = createTelegramSessionAdapter({
    platform: 'telegram',
    instance_id: 'tg.caption-fail',
    token: '666666:FFFFFFFFFFFFFFFFFFFF',
    transport,
    retry_ms: 0,
  }, store);
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && events.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]?.payload, {
    type: 'media_unavailable',
    kind: 'image',
    reason: 'download_failed',
    caption: 'Caption for failed photo',
  });
  assert.deepEqual(events[1]?.payload, {
    type: 'media_unavailable',
    kind: 'image',
    reason: 'too_large',
    caption: 'Caption for huge photo',
  });
  assert.equal(store.values.get('nb-im-session:tg.caption-fail'), '{"v":1,"offset":12}');
  await adapter.stop();
});

test('Telegram local HTTP recovers a hung poll and consecutive 429 responses before accepting and advancing once', async () => {
  let polls = 0;
  let hungPollsClosed = 0;
  let rateLimited = 0;
  const server = createServer((request, response) => {
    request.resume();
    const method = request.url?.slice(1);
    if (method === 'getMe') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { id: 42 } }));
      return;
    }
    if (method === 'getWebhookInfo') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { url: '' } }));
      return;
    }
    if (method !== 'getUpdates') {
      response.statusCode = 404;
      response.end();
      return;
    }
    polls += 1;
    if (polls === 1 || polls >= 5) {
      response.on('close', () => { if (!response.writableEnded) hungPollsClosed += 1; });
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (polls === 2 || polls === 3) {
      rateLimited += 1;
      response.statusCode = 429;
      response.end(JSON.stringify({ ok: false, error_code: 429, description: 'rate limited' }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: [update(7, { message: {
      message_id: 1, text: 'recovered', chat: { id: 9, type: 'private' }, from: { id: 8 },
    } })] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture_port_missing');
  const base = `http://127.0.0.1:${address.port}`;
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      const response = await fetch(`${base}/${request.method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.json ?? {}), signal,
      });
      return { http_status: response.status, body: await response.json() as unknown };
    },
    async download() { return { ok: false }; },
  };
  const store = memory();
  const events: SessionInbound[] = [];
  const adapter = createTelegramSessionAdapter({
    platform: 'telegram', instance_id: 'tg.local-recovery', token: SECRET,
    transport, retry_ms: 5, poll_timeout_ms: 30,
  }, store);
  try {
    await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
    for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.type === 'text' && events[0].payload.text, 'recovered');
    assert.equal(rateLimited, 2);
    assert.equal(store.values.get('nb-im-session:tg.local-recovery'), '{"v":1,"offset":8}');
    assert.equal(adapter.state, 'running');
    await adapter.stop();
    assert.equal(adapter.state, 'stopped');
    assert.ok(hungPollsClosed >= 1);
  } finally {
    await adapter.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
