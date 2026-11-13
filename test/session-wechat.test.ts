import { createCipheriv, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock, test } from 'node:test';
import { createWechatTransport } from '../src/session/wechat-http.ts';
import { createWechatSessionAdapter, parseWeixinApiJson } from '../src/session/wechat.ts';
import type { SessionCursorStore, SessionInbound, WechatTransport } from '../src/index.ts';

const TOKEN = 'ilink-bot-token-secret';
function memory(): SessionCursorStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async load(scope) { return values.get(scope); }, async save(scope, cursor) { values.set(scope, cursor); } };
}
test('uint64 message ids stay decimal strings', () => {
  const parsed = parseWeixinApiJson('{"message_id":18446744073709551615,"text":"18446744073709551615"}');
  assert.equal(parsed.message_id, '18446744073709551615');
  assert.equal(parsed.text, '18446744073709551615');
});
test('WeChat receive, cursor, media, voice container, edit refusal and auth', async () => {
  const calls: { url: string; body: string; bytes?: Uint8Array }[] = [];
  const key = randomBytes(16);
  const aes = createCipheriv('aes-128-ecb', key, null);
  const cipher = Buffer.concat([aes.update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), aes.final()]);
  let admits = 0;
  let releaseAuth = false;
  let holdPolls = false;
  const events: SessionInbound[] = [];
  let mode: 'defer' | 'accept' = 'defer';
  let noteDefer: () => void = () => undefined;
  const sawDefer = new Promise<void>((resolve) => { noteDefer = resolve; });
  let noteSave: () => void = () => undefined;
  const sawSave = new Promise<void>((resolve) => { noteSave = resolve; });
  const batch = '{"ret":0,"get_updates_buf":"buf-2","msgs":[{"message_id":18446744073709551615,"from_user_id":"user-1","to_user_id":"bot-9","message_type":1,"message_state":2,"group_id":"group-7","context_token":"ctx-not-the-bot-token","item_list":[{"type":1,"text_item":{"text":"hello"}},{"type":2,"image_item":{"aeskey":"' + key.toString('hex') + '","media":{"encrypt_query_param":"q","full_url":"https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q"}}}]},{"message_id":"m2","from_user_id":"user-1","to_user_id":"bot-9","message_type":2,"message_state":2,"item_list":[{"type":1,"text_item":{"text":"echo"}}]}]}';
  const transport: WechatTransport = {
    async post(url, headers, body) {
      calls.push({ url, body });
      assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(headers['iLink-App-Id'], 'bot');
      assert.equal(headers['iLink-App-ClientVersion'], '512');
      if (url.endsWith('notifystart') || url.endsWith('notifystop')) return { status: 200, body: '{"ret":0}' };
      if (url.endsWith('getupdates')) {
        if (holdPolls) await new Promise((resolve) => setTimeout(resolve, 5));
        if (releaseAuth) return { status: 200, body: '{"ret":-14,"errmsg":"' + TOKEN + '"}' };
        return { status: 200, body: batch };
      }
      if (url.endsWith('getuploadurl')) {
        return { status: 200, body: '{"ret":0,"upload_full_url":"https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1"}' };
      }
      if (url.endsWith('sendmessage')) return { status: 200, body: '{"ret":0,"message_id":"77"}' };
      return { status: 200, body: '{"ret":0}' };
    },
    async postBytes(url, _headers, body) {
      calls.push({ url, body: '', bytes: body });
      return { status: 200, body: '', headers: { 'x-encrypted-param': 'download-param' } };
    },
    async getBytes() { return { status: 200, body: cipher }; },
  };
  const store = memory();
  const originalSave = store.save.bind(store);
  store.save = async (scope, cursor) => { await originalSave(scope, cursor); noteSave(); };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.1', token: TOKEN,
    account_id: 'bot-9', transport, retry_ms: 0 }, store);
  try {
  await adapter.start({ async admit(event) {
    admits += 1;
    events.push(event);
    if (mode === 'defer') { mode = 'accept'; noteDefer(); return { decision: 'defer' }; }
    return { decision: 'accepted' };
  } });
  await sawDefer;
  assert.equal(store.values.has('nb-im-session:wx.1'), false);
  await sawSave;
  holdPolls = true;
  assert.equal(store.values.get('nb-im-session:wx.1'), '{"v":1,"buf":"buf-2"}');
  assert.equal(events[0]?.cursor, '{"v":1,"buf":"buf-2"}');
  assert.equal(events[0]?.cursor.includes('ctx-not-the-bot-token'), false);
  assert.equal(events[0]?.event_key, 'wx:bot-9:18446744073709551615:0');
  assert.equal(events[0]?.identity.topic_id, 'group-7');
  assert.equal(events[0]?.identity.chat_kind, 'group');
  assert.equal(events[0]?.reply_context, 'ctx-not-the-bot-token');
  const imageEvent = events.find((event) => event.event_key.endsWith(':1'));
  assert.equal(imageEvent?.payload.type, 'media');
  if (imageEvent?.payload.type === 'media') assert.equal(imageEvent.payload.media.mime, 'image/png');
  assert.equal(events.some((event) => event.payload.type === 'text' && event.payload.text === 'echo'), false);
  const admitted = admits;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(admits, admitted);
  assert.equal(JSON.stringify(events).includes(TOKEN), false);
  const sent = await adapter.send({ type: 'text', target: { chat_id: 'user-1', reply_context: 'ctx-not-the-bot-token' }, text: 'pong' });
  assert.equal(sent.status, 'accepted');
  assert.equal(sent.message_ids[0], '77');
  assert.equal(JSON.stringify(sent).includes(TOKEN), false);
  const parts = await adapter.send({ type: 'text_parts', target: { chat_id: 'user-1' }, parts: ['a', 'b'] });
  assert.equal(parts.message_ids.length, 2);
  const edited = await adapter.send({ type: 'edit_text', target: { chat_id: 'user-1' }, message_id: '77', text: 'no' });
  assert.equal(edited.diagnostic_code, 'wechat_unsupported_edit');
  const button = await adapter.send({ type: 'text', target: { chat_id: 'user-1' }, text: 'no', buttons: [{ data: 'x', label: 'X' }] });
  assert.equal(button.diagnostic_code, 'wechat_unsupported_callback');
  const uploadsBefore = calls.filter((call) => call.url.endsWith('getuploadurl')).length;
  const badVoice = await adapter.send({ type: 'media', target: { chat_id: 'user-1' },
    media: { kind: 'voice', filename: 'a.ogg', mime: 'audio/ogg', bytes: Uint8Array.from([1, 2, 3]) } });
  assert.equal(badVoice.diagnostic_code, 'wechat_voice_container');
  assert.equal(calls.filter((call) => call.url.endsWith('getuploadurl')).length, uploadsBefore);
  const voice = await adapter.send({ type: 'media', target: { chat_id: 'user-1' },
    media: { kind: 'voice', filename: 'a.silk', mime: 'audio/silk', bytes: Uint8Array.from([1, 2, 3, 4]) } });
  assert.equal(voice.status, 'accepted');
  const upload = calls.find((call) => call.url.endsWith('getuploadurl') && call.body.includes('"media_type":4'));
  assert.ok(upload);
  assert.equal(upload?.body.includes('"no_need_thumb":true'), true);
  const sendBody = calls.filter((call) => call.url.endsWith('sendmessage')).at(-1)?.body ?? '';
  assert.equal(sendBody.includes('"encode_type":6'), true);
  assert.equal(sendBody.includes('"message_type":2'), true);
  const wireKey = JSON.parse(upload?.body ?? '{}').aeskey as string;
  assert.equal(sendBody.includes(Buffer.from(wireKey, 'utf8').toString('base64')), true);
  const image = await adapter.send({ type: 'media', target: { chat_id: 'user-1' }, caption: 'pic',
    media: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: Uint8Array.from([1]) } });
  assert.equal(image.status, 'accepted');
  assert.equal(calls.some((call) => call.url.includes('/upload?') && call.bytes !== undefined), true);
  releaseAuth = true;
  for (let i = 0; i < 40 && adapter.state !== 'auth_expired'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.state, 'auth_expired');
  } finally {
    await adapter.stop();
  }
  assert.equal(calls.some((call) => call.url.endsWith('notifystop')), true);
});
test('WeChat send cancel does not post and a bad base URL is refused', async () => {
  const calls: string[] = [];
  const transport: WechatTransport = {
    async post(url) { calls.push(url); return { status: 200, body: '{"ret":0}' }; },
    async postBytes() { return { status: 200, body: '' }; },
    async getBytes() { return { status: 0, body: new Uint8Array() }; },
  };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.cancel', token: 'ilink-bot-token-cancel',
    transport, retry_ms: 0 }, memory());
  const controller = new AbortController();
  controller.abort();
  const receipt = await adapter.send({ type: 'text', target: { chat_id: 'user-1' }, text: 'no' }, controller.signal);
  assert.equal(receipt.diagnostic_code, 'cancelled');
  assert.equal(calls.length, 0);
  assert.throws(() => createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.bad', token: 'ilink-bot-token-rejected',
    base_url: 'http://127.0.0.1/ilink', transport }, memory()), /wechat_endpoint_rejected/);
});
test('WeChat send confirms ret 0 or message id, never an empty HTTP 200', async () => {
  let body = '';
  let status = 200;
  const transport: WechatTransport = {
    async post(url) {
      if (url.endsWith('getuploadurl')) return { status: 200, body: '{"ret":0,"upload_param":"upload-test"}' };
      return { status, body };
    },
    async postBytes() { return { status: 200, body: '', headers: { 'x-encrypted-param': 'download-test' } }; },
    async getBytes() { return { status: 0, body: new Uint8Array() }; },
  };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.receipt',
    token: 'ilink-bot-token-receipt', transport }, memory());
  const send = async (next: string) => {
    body = next;
    const receipt = await adapter.send({ type: 'text', target: { chat_id: 'user-1' }, text: 'pong' });
    assert.equal(JSON.stringify(receipt).includes('ilink-bot-token-receipt'), false);
    return receipt;
  };
  assert.equal((await send('{"ret":1}')).diagnostic_code, 'wechat_rejected');
  assert.equal((await send('not-json')).diagnostic_code, 'wechat_unconfirmed');
  assert.equal((await send('{}')).diagnostic_code, 'wechat_unconfirmed');
  assert.equal((await send('{"errcode":-2}')).diagnostic_code, 'wechat_rejected');
  assert.equal((await send('{"ret":0,"errcode":-2}')).diagnostic_code, 'wechat_rejected');
  assert.equal((await send('{"ret":-2,"errmsg":"prepare failed","message_id":7520810038038921608}')).diagnostic_code, 'wechat_rejected');
  assert.equal((await send('')).diagnostic_code, 'wechat_unconfirmed');
  assert.equal((await send('{"message_id":""}')).diagnostic_code, 'wechat_unconfirmed');
  assert.equal((await send('{"message_id":"   "}')).diagnostic_code, 'wechat_unconfirmed');
  status = 500;
  assert.equal((await send('{"message_id":7520810038038921608}')).status, 'failed');
  status = 200;
  const zero = await send('{"ret":0}');
  assert.equal(zero.status, 'accepted');
  assert.deepEqual(zero.message_ids, []);
  assert.equal((await send('{"ret":0,"errmsg":""}')).status, 'accepted');
  const named = await send('{"ret":0,"message_id":"9"}');
  assert.equal(named.status, 'accepted');
  assert.deepEqual(named.message_ids, ['9']);
  body = '{"message_id":7520810038038921608}';
  const target = { chat_id: 'user-1' };
  for (const message of [
    { type: 'text' as const, target, text: 'pong' },
    { type: 'media' as const, target, media: { kind: 'image' as const, filename: 'a.png', mime: 'image/png', bytes: Uint8Array.of(1) } },
    { type: 'media' as const, target, media: { kind: 'voice' as const, filename: 'a.silk', mime: 'audio/silk', bytes: Uint8Array.of(1) } },
  ]) {
    const receipt = await adapter.send(message);
    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(receipt.message_ids, ['7520810038038921608']);
  }
});
test('WeChat item ref_msg keeps referenced ID and bounded text separate from current text and media', async () => {
  const events: SessionInbound[] = [];
  let polls = 0;
  const response = '{"ret":0,"get_updates_buf":"quoted","msgs":[{"message_id":100,"from_user_id":"friend","to_user_id":"bot","message_type":1,"message_state":2,"item_list":[' +
    JSON.stringify({ type: 1, text_item: { text: 'new question' }, ref_msg: { title: 'not original', message_item: { msg_id: 'NUMERIC_ID', type: 1, text_item: { text: 'original text' } } } }).replace('"NUMERIC_ID"', '7520810038038921608') + ',' +
    JSON.stringify({ type: 2, image_item: { media: { encrypt_query_param: 'image' } }, ref_msg: { title: 'image title only', message_item: { msg_id: '22', type: 2 } } }) + ',' +
    JSON.stringify({ type: 3, voice_item: { media: { encrypt_query_param: 'voice' } }, ref_msg: { title: 'not original', message_item: { msg_id: '23', type: 1, text_item: { text: '😀'.repeat(1025) } } } }) + ',' +
    JSON.stringify({ type: 1, text_item: { text: 'no reference' }, ref_msg: { title: 'title must not become quote', message_item: { msg_id: '', text_item: { text: '  ' } } } }) +
    ']}]}';
  const transport: WechatTransport = {
    async post(url) {
      if (url.endsWith('getupdates')) return polls++ === 0 ? { status: 200, body: response } : { status: 401, body: '' };
      return { status: 200, body: '{"ret":0}' };
    },
    async postBytes() { throw new Error('unexpected upload'); },
    async getBytes() { return { status: 0, body: new Uint8Array() }; },
  };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.quote', token: 'offline-quote', transport, retry_ms: 0 }, memory());
  try {
    await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
    for (let i = 0; i < 40 && adapter.state !== 'auth_expired'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(adapter.state, 'auth_expired');
    assert.equal(events.length, 4);
    assert.equal(events[0]?.reply_to_message_id, '7520810038038921608');
    assert.equal(events[0]?.quoted_text, 'original text');
    assert.deepEqual(events[0]?.payload, { type: 'text', text: 'new question' });
    assert.equal(events[1]?.reply_to_message_id, '22');
    assert.equal(events[1]?.quoted_text, undefined);
    assert.equal(events[1]?.payload.type, 'media_unavailable');
    assert.equal(events[2]?.reply_to_message_id, '23');
    assert.equal(events[2]?.quoted_text, `${'😀'.repeat(1024)}…`);
    assert.equal(events[2]?.payload.type, 'media_unavailable');
    assert.equal(events[3]?.reply_to_message_id, undefined);
    assert.equal(events[3]?.quoted_text, undefined);
    assert.deepEqual(events[3]?.payload, { type: 'text', text: 'no reference' });
    assert.equal(JSON.stringify(events).includes('image title only'), false);
  } finally { await adapter.stop(); }
});
test('WeChat getBytes stops reading once the body passes 100 MiB', async () => {
  const chunk = 34 * 1024 * 1024;
  let pulls = 0;
  let cancelled = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() { cancelled = true; },
  }), { status: 200 })) as typeof fetch;
  try {
    const transport = createWechatTransport();
    const result = await transport.getBytes('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', new AbortController().signal);
    assert.equal(result.status, 0);
    assert.equal(result.body.byteLength, 0);
    assert.equal(cancelled, true);
    assert.equal(pulls >= 3 && pulls <= 4, true);
  } finally {
    globalThis.fetch = original;
  }
});

const OFFICIAL_CONTRACT = 'https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts';

test('official optional ret accepts omitted zero fields but rejects explicit errors and invalid shapes', async () => {
  assert.ok(OFFICIAL_CONTRACT.endsWith('monitor.ts'));
  const responses = [
    { status: 200, body: '{"ret":-2}' },
    { status: 200, body: '{"errcode":-2}' },
    { status: 200, body: '{"ret":0,"errcode":9}' },
    { status: 200, body: '{"ret":"0","msgs":[]}' },
    { status: 200, body: '{"ret":0,"msgs":{}}' },
    { status: 200, body: '[]' },
    { status: 503, body: '{"ret":0}' },
    { status: 200, body: '{"msgs":[],"get_updates_buf":"optional-ret"}' },
    { status: 200, body: '{"errcode":0,"msgs":[],"get_updates_buf":"optional-ret-2"}' },
    { status: 200, body: '{"ret":0,"msgs":[],"get_updates_buf":"explicit-zero"}' },
    { status: 200, body: '{"errcode":-14,"errmsg":"private-error-text"}' },
  ];
  let polls = 0;
  const store = memory();
  const transport: WechatTransport = {
    async post(url) {
      if (!url.endsWith('getupdates')) return { status: 200, body: '{}' };
      return responses[polls++] ?? { status: 401, body: '' };
    },
    async postBytes() { return { status: 0, body: '' }; },
    async getBytes() { return { status: 0, body: new Uint8Array() }; },
  };
  const saved: string[] = [];
  store.save = async (_scope, cursor) => { saved.push(cursor); };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.optional', token: 'optional-ret-test', transport, retry_ms: 0 }, store);
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  for (let attempt = 0; attempt < 100 && adapter.state !== 'auth_expired'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(adapter.state, 'auth_expired');
  assert.equal(polls, responses.length);
  assert.deepEqual(saved, ['{"v":1,"buf":"optional-ret"}', '{"v":1,"buf":"optional-ret-2"}', '{"v":1,"buf":"explicit-zero"}']);
  assert.deepEqual(adapter.connection_detail, { code: 'auth_expired', http_status: 200, ret: undefined, errcode: -14, retry_in_ms: undefined });
  assert.equal(JSON.stringify(adapter.connection_detail).includes('private-error-text'), false);
  await adapter.stop();
});

test('HTTP 401 terminates without retry and cursor errors become stopped diagnostics', async () => {
  let polls = 0;
  const transport: WechatTransport = {
    async post(url) { if (url.endsWith('getupdates')) { polls += 1; return { status: 401, body: '' }; } return { status: 200, body: '{}' }; },
    async postBytes() { return { status: 0, body: '' }; },
    async getBytes() { return { status: 0, body: new Uint8Array() }; },
  };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.httpauth', token: 'http-auth-test', transport }, memory());
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  assert.equal(adapter.state, 'auth_expired');
  assert.equal(polls, 1);
  assert.equal(adapter.connection_detail?.http_status, 401);
  await adapter.stop();
  const broken = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.cursorfail', token: 'cursor-fail-test', transport }, {
    async load() { throw new Error('private-cursor-value'); }, async save() {},
  });
  await broken.start({ async admit() { return { decision: 'accepted' }; } });
  assert.equal(broken.state, 'stopped');
  assert.equal(broken.connection_detail?.code, 'loop_failed');
  assert.equal(polls, 1);
  await broken.stop();
});

test('WeChat group destinations never fall through to direct text or media sends', async () => {
  let calls = 0;
  const transport: WechatTransport = {
    async post() { calls += 1; return { status: 200, body: '{"ret":0}' }; },
    async postBytes() { calls += 1; return { status: 200, body: '' }; },
    async getBytes() { calls += 1; return { status: 0, body: new Uint8Array() }; },
  };
  const adapter = createWechatSessionAdapter({ platform: 'personal_wechat', instance_id: 'wx.directonly', token: 'direct-only-test', transport }, memory());
  for (const target of [{ chat_id: 'user', topic_id: 'group' }, { chat_id: 'user', topic_id: '0', chat_kind: 'group' as const }]) {
    assert.equal((await adapter.send({ type: 'text', target, text: 'no private leak' })).diagnostic_code, 'wechat_group_unsupported');
    assert.equal((await adapter.send({ type: 'media', target, media: { kind: 'file', filename: 'sample', mime: 'text/plain', bytes: Uint8Array.from([1]) } })).diagnostic_code, 'wechat_group_unsupported');
  }
  assert.equal(calls, 0);
  assert.equal((await adapter.send({ type: 'text', target: { chat_id: 'user' }, text: 'ordinary' })).status, 'accepted');
  assert.equal(calls, 1);
  await adapter.stop();
});

test('WeChat local HTTP bounds hung polls and retries consecutive 429 responses without advancing early', async () => {
  let polls = 0;
  let hungPollsClosed = 0;
  let rateLimited = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (!request.url?.endsWith('getupdates')) {
      response.setHeader('content-type', 'application/json');
      response.end('{"ret":0}');
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
      response.end('{"ret":-2}');
      return;
    }
    response.end(JSON.stringify({ ret: 0, get_updates_buf: 'recovered-buf', msgs: [{
      message_id: 'recovered-message', from_user_id: 'friend', to_user_id: 'bot', message_type: 1,
      message_state: 2, item_list: [{ type: 1, text_item: { text: 'recovered' } }],
    }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture_port_missing');
  const base = `http://127.0.0.1:${address.port}`;
  const transport: WechatTransport = {
    async post(url, _headers, body, signal) {
      const path = new URL(url).pathname;
      const response = await fetch(`${base}${path}`, { method: 'POST', body, signal });
      return { status: response.status, body: await response.text() };
    },
    async postBytes() { throw new Error('unexpected upload'); },
    async getBytes() { throw new Error('unexpected download'); },
  };
  const store = memory();
  const events: SessionInbound[] = [];
  const adapter = createWechatSessionAdapter({
    platform: 'personal_wechat', instance_id: 'wx.local-recovery', token: 'offline-local-fixture',
    account_id: 'bot', transport, retry_ms: 5, poll_timeout_ms: 30,
  }, store);
  try {
    await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
    for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.type === 'text' && events[0].payload.text, 'recovered');
    assert.equal(rateLimited, 2);
    assert.equal(store.values.get('nb-im-session:wx.local-recovery'), '{"v":1,"buf":"recovered-buf"}');
    assert.equal(adapter.state, 'running');
    await adapter.stop();
    assert.equal(adapter.state, 'stopped');
    assert.ok(hungPollsClosed >= 1);
  } finally {
    await adapter.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WeChat default transport settles a silent 35 second poll without entering backoff', async () => {
  const originalFetch = globalThis.fetch;
  let polls = 0;
  let silentTimeouts = 0;
  let entered = (): void => undefined;
  const pollEntered = new Promise<void>((resolve) => { entered = resolve; });
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith('getupdates')) {
      return new Response('{"ret":0}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    polls += 1;
    entered();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => {
        silentTimeouts += 1;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;
  mock.timers.enable({ apis: ['setTimeout'] });
  const adapter = createWechatSessionAdapter({
    platform: 'personal_wechat', instance_id: 'wx.default-silence', token: 'offline-default-transport',
    account_id: 'bot', retry_ms: 60_000,
  }, memory());
  try {
    const started = adapter.start({ async admit() { return { decision: 'accepted' }; } });
    await pollEntered;
    mock.timers.tick(35_000);
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    assert.equal(adapter.state, 'running');
    assert.equal(adapter.connection_detail, undefined);
    assert.equal(silentTimeouts, 1);
    assert.equal(polls, 1);
    await started;
    await adapter.stop();
    assert.equal(adapter.state, 'stopped');
  } finally {
    await adapter.stop().catch(() => undefined);
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});
