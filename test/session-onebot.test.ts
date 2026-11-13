import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createOneBotSessionAdapter, createOneBotWsTransport } from '../src/index.ts';
import type { OneBotLink, OneBotTransport, SessionCursorStore, SessionInbound } from '../src/index.ts';
import { abortError } from '../src/session/contract.ts';

const TOKEN = 'qq-access-token-secret';
function memory(): SessionCursorStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, async load(scope) { return values.get(scope); }, async save(scope, cursor) { values.set(scope, cursor); } };
}
async function until(read: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > 2_000) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}
function link(role: OneBotLink['role'] = 'universal') {
  const sent: unknown[] = [];
  let onFrame: ((frame: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const value: OneBotLink & { sent: unknown[]; emit: (frame: unknown) => void } = {
    role, sent,
    send(frame) { sent.push(frame); },
    onFrame(handler) { onFrame = handler; },
    onClose(handler) { onClose = handler; },
    close() { onClose?.(); },
    emit(frame) { onFrame?.(frame); },
  };
  return value;
}
test('OneBot text, image, record, unsupported calls, cursor and cancel', async () => {
  const api = link('universal');
  let connects = 0;
  const transport: OneBotTransport = {
    async connect(_input) {
      connects += 1;
      if (connects === 1) throw new Error('down');
      return api;
    },
    async listen() { throw new Error('onebot_listen_unused'); },
    async download(url) {
      assert.equal(url.startsWith('https://'), true);
      return { ok: true, bytes: Uint8Array.from([7, 7]) };
    },
  };
  const store = memory();
  const events: SessionInbound[] = [];
  const adapter = createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'ws://127.0.0.1:6700/', instance_id: 'qq.1', access_token: TOKEN, transport,
    retry_ms: 0, call_timeout_ms: 50 }, store);
  assert.equal(adapter.account.account_id, '127.0.0.1:6700');
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && connects < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.state, 'running');
  api.emit({ post_type: 'message', message_type: 'private', message_id: 15, self_id: 100, user_id: 200, message: 'hi' });
  api.emit({ post_type: 'message', message_type: 'private', message_id: 15, self_id: 100, user_id: 200, message: 'hi' });
  api.emit({ post_type: 'message', message_type: 'group', message_id: 16, self_id: 100, user_id: 200, group_id: 300,
    message: [{ type: 'text', data: { text: 'cap' } }, { type: 'image', data: { file: 'base64://QQ==' } }] });
  api.emit({ post_type: 'message', message_type: 'private', message_id: 17, self_id: 100, user_id: 200,
    message: [{ type: 'record', data: { file: 'file:///tmp/a.silk' } }] });
  for (let i = 0; i < 20 && events.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 3);
  assert.equal(events[0]?.event_key, 'qq:100:private:15');
  assert.equal(events[0]?.identity.chat_kind, 'private');
  assert.equal(events[1]?.identity.chat_id, '300');
  assert.equal(events[1]?.payload.type, 'media');
  assert.equal(events[2]?.payload.type, 'media_unavailable');
  assert.equal(JSON.stringify(events).includes(TOKEN), false);
  assert.equal(store.values.get('nb-im-session:qq.1')?.includes('qq:100:private:17'), true);
  const pending = adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'pong' });
  const frame = api.sent[0] as { echo: string; params: { auto_escape?: boolean; message: string } };
  assert.equal(frame.params.auto_escape, true);
  assert.equal(frame.params.message, 'pong');
  assert.equal(JSON.stringify(frame).includes(TOKEN), false);
  api.emit({ status: 'ok', retcode: 0, echo: frame.echo, data: { message_id: 90 } });
  assert.equal((await pending).status, 'accepted');
  const image = adapter.send({ type: 'media', target: { chat_id: '300', chat_kind: 'group' },
    media: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: Uint8Array.from([1, 2]) } });
  const imageFrame = api.sent[1] as { echo: string; params: { message: { type: string; data: { file: string } }[] } };
  assert.equal(imageFrame.params.message[0]?.type, 'image');
  assert.equal(imageFrame.params.message[0]?.data.file.startsWith('base64://'), true);
  api.emit({ status: 'async', retcode: 1, echo: imageFrame.echo });
  assert.equal((await image).diagnostic_code, 'onebot_async');
  const missing = await adapter.send({ type: 'edit_text', target: { chat_id: '200', chat_kind: 'private' }, message_id: '1', text: 'no' });
  assert.equal(missing.diagnostic_code, 'onebot_unsupported_edit');
  const file = await adapter.send({ type: 'media', target: { chat_id: '200', chat_kind: 'private' },
    media: { kind: 'file', filename: 'a.bin', mime: 'application/octet-stream', bytes: Uint8Array.from([1]) } });
  assert.equal(file.diagnostic_code, 'onebot_unsupported_file');
  const button = await adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'no',
    buttons: [{ data: 'x', label: 'X' }] });
  assert.equal(button.diagnostic_code, 'onebot_unsupported_callback');
  assert.equal(api.sent.length, 2);
  const controller = new AbortController();
  const blocked = adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'late' }, controller.signal);
  controller.abort();
  assert.equal((await blocked).diagnostic_code, 'cancelled_after_dispatch');
  const already = new AbortController();
  already.abort();
  const before = api.sent.length;
  const cancelled = await adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'no' }, already.signal);
  assert.equal(cancelled.diagnostic_code, 'cancelled');
  assert.equal(api.sent.length, before);
  const timed = adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'slow' });
  assert.equal((await timed).diagnostic_code, 'onebot_timeout');
  const failed = adapter.send({ type: 'text', target: { chat_id: '200', chat_kind: 'private' }, text: 'bad' });
  const bad = api.sent.at(-1) as { echo: string };
  api.emit({ status: 'failed', retcode: 1404, echo: bad.echo, data: null });
  assert.equal((await failed).diagnostic_code, 'onebot_not_found');
  await adapter.stop();
});
test('OneBot rejects public endpoints and a reverse socket checks the token', async () => {
  assert.throws(() => createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'wss://example.com/api', instance_id: 'qq.public', transport: {
      async connect() { throw abortError(); }, async listen() { return { port: 1 }; } },
  }, memory()), /onebot_endpoint_rejected/);
  assert.throws(() => createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'ws://127.0.0.1:6700/?access_token=hidden', instance_id: 'qq.query',
  }, memory()), /onebot_endpoint_rejected/);
  const inner = createOneBotWsTransport();
  let port = 0;
  const transport: OneBotTransport = {
    connect: (input) => inner.connect(input),
    download: inner.download?.bind(inner),
    async listen(input) {
      const listened = await inner.listen(input);
      port = listened.port;
      return listened;
    },
  };
  const events: SessionInbound[] = [];
  const adapter = createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'reverse',
    endpoint: 'ws://127.0.0.1:9/', listen_port: 0, access_token: TOKEN, instance_id: 'qq.reverse',
    transport, retry_ms: 0 }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  assert.ok(port > 0);
  const denied = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Authorization: 'Bearer wrong' } });
  await new Promise((resolve) => denied.once('close', resolve));
  const allowed = new WebSocket(`ws://127.0.0.1:${port}/?access_token=${encodeURIComponent(TOKEN)}`, {
    headers: { 'X-Client-Role': 'Universal', 'X-Self-ID': '10001' } });
  await new Promise((resolve, reject) => { allowed.once('open', resolve); allowed.once('error', reject); });
  allowed.send(JSON.stringify({ post_type: 'message', message_type: 'private', message_id: 4,
    self_id: 10001, user_id: 42, message: 'ping' }));
  for (let i = 0; i < 30 && events.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events[0]?.event_key, 'qq:10001:private:4');
  assert.equal(JSON.stringify(events).includes(TOKEN), false);
  allowed.close();
  await adapter.stop();
});
test('OneBot keeps private endpoints that only differ by a slash or a default port', () => {
  const transport: OneBotTransport = {
    async connect() { throw new Error('onebot_connect_unused'); },
    async listen() { return { port: 0 }; },
  };
  for (const [endpoint, id] of [
    ['ws://127.0.0.1:6700', 'qq.slashless'],
    ['ws://127.0.0.1:80/', 'qq.ws80'],
    ['wss://127.0.0.1:443/', 'qq.wss443'],
  ] as const) {
    const adapter = createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward', endpoint,
      instance_id: id, transport }, memory());
    assert.equal(adapter.platform, 'qq_onebot_v11');
  }
  assert.throws(() => createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'wss://8.8.8.8/onebot', instance_id: 'qq.public-ip', transport }, memory()),
  /onebot_endpoint_rejected/);
});
test('OneBot uses the segment url when file is a name or a file URI', async () => {
  const api = link();
  const downloads: string[] = [];
  const transport: OneBotTransport = {
    async connect() { return api; },
    async listen() { throw new Error('onebot_listen_unused'); },
    async download(url) {
      downloads.push(url);
      return { ok: true, bytes: Uint8Array.from([3, 3]) };
    },
  };
  const store = memory();
  const events: SessionInbound[] = [];
  const adapter = createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'ws://127.0.0.1:6702/', instance_id: 'qq.media-url', transport, retry_ms: 0 }, store);
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && adapter.state !== 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  api.emit({ post_type: 'message', message_type: 'private', message_id: 21, self_id: 100, user_id: 200,
    message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://1.1.1.1/a.jpg' } }] });
  api.emit({ post_type: 'message', message_type: 'private', message_id: 22, self_id: 100, user_id: 200,
    message: [{ type: 'image', data: { file: 'file:///tmp/a.jpg', url: 'http://1.1.1.1/b.jpg' } }] });
  api.emit({ post_type: 'message', message_type: 'private', message_id: 23, self_id: 100, user_id: 200,
    message: [{ type: 'record', data: { file: 'file:///tmp/a.silk' } }] });
  for (let i = 0; i < 20 && events.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const event = (id: string) => events.find((item) => item.event_key === `qq:100:private:${id}`);
  assert.equal(events.length, 3);
  assert.equal(event('21')?.payload.type, 'media');
  assert.equal(event('22')?.payload.type, 'media');
  assert.equal(event('23')?.payload.type, 'media_unavailable');
  if (event('23')?.payload.type === 'media_unavailable') assert.equal(event('23')?.payload.reason, 'local_path_not_fetched');
  assert.deepEqual(downloads, ['https://1.1.1.1/a.jpg', 'http://1.1.1.1/b.jpg']);
  const saved = store.values.get('nb-im-session:qq.media-url') ?? '';
  assert.equal(saved.includes('qq:100:private:21'), true);
  assert.equal(saved.includes('qq:100:private:22'), true);
  await adapter.stop();
});
test('OneBot malformed frames release inflight and a later complete frame is admitted once', async () => {
  const api = link();
  const transport: OneBotTransport = {
    async connect() { return api; },
    async listen() { throw new Error('onebot_listen_unused'); },
  };
  const events: SessionInbound[] = [];
  const store = memory();
  const adapter = createOneBotSessionAdapter({ platform: 'qq_onebot_v11', mode: 'forward',
    endpoint: 'ws://127.0.0.1:6703/', instance_id: 'qq.inflight', transport, retry_ms: 0 }, store);
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && adapter.state !== 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  api.emit({ post_type: 'message', message_type: 'private', message_id: 30, self_id: 100, message: 'no-sender' });
  api.emit({ post_type: 'message', message_type: 'group', message_id: 31, self_id: 100, user_id: 200, message: 'no-group' });
  api.emit({ post_type: 'message', message_type: 'private', message_id: 30, self_id: 100, user_id: 200, message: 'later' });
  for (let i = 0; i < 20 && events.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_key, 'qq:100:private:30');
  const saved = store.values.get('nb-im-session:qq.inflight') ?? '';
  assert.equal(saved.includes('qq:100:private:30'), true);
  assert.equal(saved.includes(':31'), false);
  await adapter.stop();
});
test('OneBot default download reads public http and does not call private addresses', async () => {
  const calls: string[] = [];
  const scripted = (status: number, body: Buffer) => function request(options: { hostname?: string },
    callback?: (res: EventEmitter) => void) {
    calls.push(options.hostname ?? '');
    const req = new EventEmitter() as EventEmitter & { destroy: () => void; end: () => void };
    req.destroy = () => undefined;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      res.statusCode = status;
      res.resume = () => undefined;
      callback?.(res);
      setTimeout(() => {
        if (status === 200) res.emit('data', body);
        res.emit('end');
      }, 0);
    };
    return req;
  };
  const httpMock = mock.method(http, 'request', scripted(200, Buffer.from('pic')));
  const httpsMock = mock.method(https, 'request', scripted(200, Buffer.from('pic')));
  try {
    const transport = createOneBotWsTransport();
    const signal = new AbortController().signal;
    const ok = await transport.download!('http://1.1.1.1/a.jpg', signal);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual([...ok.bytes], [...Buffer.from('pic')]);
    assert.deepEqual(calls, ['1.1.1.1']);
    assert.equal((await transport.download!('http://127.0.0.1/a.jpg', signal)).ok, false);
    assert.equal((await transport.download!('https://169.254.169.254/latest', signal)).ok, false);
    assert.deepEqual(calls, ['1.1.1.1']);
  } finally {
    httpMock.mock.restore();
    httpsMock.mock.restore();
  }
  calls.length = 0;
  const redirect = mock.method(http, 'request', scripted(302, Buffer.alloc(0)));
  try {
    const transport = createOneBotWsTransport();
    assert.equal((await transport.download!('http://1.1.1.1/go', new AbortController().signal)).ok, false);
    assert.deepEqual(calls, ['1.1.1.1']);
  } finally {
    redirect.mock.restore();
  }
});
test('OneBot preserves caption when single media is unavailable and emits ordered parts for text-image-text and multi-image messages', async () => {
  const api = link();
  const transport: OneBotTransport = {
    async connect() { return api; },
    async listen() { throw new Error('onebot_listen_unused'); },
  };
  const events: SessionInbound[] = [];
  const adapter = createOneBotSessionAdapter({
    platform: 'qq_onebot_v11',
    mode: 'forward',
    endpoint: 'ws://127.0.0.1:6704/',
    instance_id: 'qq.multipart',
    transport,
    retry_ms: 0,
  }, memory());
  await adapter.start({ async admit(event) { events.push(event); return { decision: 'accepted' }; } });
  for (let i = 0; i < 20 && adapter.state !== 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  api.emit({
    post_type: 'message',
    message_type: 'private',
    message_id: 40,
    self_id: 100,
    user_id: 200,
    message: [
      { type: 'text', data: { text: 'caption stays visible' } },
      { type: 'image', data: { file: 'file:///tmp/local.jpg' } },
    ],
  });
  api.emit({
    post_type: 'message',
    message_type: 'private',
    message_id: 41,
    self_id: 100,
    user_id: 200,
    message: [
      { type: 'text', data: { text: 'before ' } },
      { type: 'image', data: { file: 'base64://AQ==' } },
      { type: 'text', data: { text: 'after' } },
    ],
  });
  api.emit({
    post_type: 'message',
    message_type: 'private',
    message_id: 42,
    self_id: 100,
    user_id: 200,
    message: [
      { type: 'text', data: { text: 'first ' } },
      { type: 'image', data: { file: 'base64://AQ==' } },
      { type: 'text', data: { text: 'middle' } },
      { type: 'image', data: { file: 'file:///tmp/missing.jpg' } },
    ],
  });
  for (let i = 0; i < 20 && events.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 3);
  assert.deepEqual(events[0]?.payload, {
    type: 'media_unavailable',
    kind: 'image',
    reason: 'local_path_not_fetched',
    caption: 'caption stays visible',
  });
  assert.deepEqual(events[1]?.payload, {
    type: 'parts',
    parts: [
      { type: 'text', text: 'before ' },
      { type: 'media', media: { kind: 'image', filename: 'image', mime: 'image/jpeg', bytes: Buffer.from([1]) } },
      { type: 'text', text: 'after' },
    ],
  });
  assert.deepEqual(events[2]?.payload, {
    type: 'parts',
    parts: [
      { type: 'text', text: 'first ' },
      { type: 'media', media: { kind: 'image', filename: 'image', mime: 'image/jpeg', bytes: Buffer.from([1]) } },
      { type: 'text', text: 'middle' },
      { type: 'media_unavailable', kind: 'image', reason: 'local_path_not_fetched' },
    ],
  });
  await adapter.stop();
});

test('OneBot real forward WS stays healthy while silent and reconnects a half-open socket once', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const peers = new Set<WebSocket>();
  let connections = 0;
  let pings = 0;
  let responsive = true;
  server.on('connection', (socket) => {
    connections += 1;
    if (connections > 1) responsive = true;
    const originalPong = socket.pong;
    socket.pong = (...args) => { if (responsive) originalPong.apply(socket, args); };
    socket.on('ping', () => { pings += 1; });
    peers.add(socket);
    socket.on('close', () => { peers.delete(socket); });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture_port_missing');
  const transport = createOneBotWsTransport({ pingIntervalMs: 30, pongTimeoutMs: 25 });
  const adapter = createOneBotSessionAdapter({
    platform: 'qq_onebot_v11', mode: 'forward', endpoint: `ws://127.0.0.1:${address.port}/api`,
    instance_id: 'qq.real-forward-recovery', transport, retry_ms: 5,
  }, memory());
  try {
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    assert.equal(adapter.state, 'running');
    assert.equal(connections, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(pings >= 2);
    assert.equal(connections, 1);
    assert.equal(adapter.state, 'running');
    responsive = false;
    await until(() => connections >= 2 && adapter.state === 'running', 'forward half-open socket did not recover');
    assert.equal(connections, 2);
    await adapter.stop();
    const stopped = connections;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(connections, stopped);
    assert.equal(adapter.state, 'stopped');
  } finally {
    await adapter.stop().catch(() => undefined);
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OneBot reverse WS drops only the half-open role and keeps listening for its replacement', async () => {
  const inner = createOneBotWsTransport({ pingIntervalMs: 30, pongTimeoutMs: 25 });
  const accepted: OneBotLink['role'][] = [];
  const closed: OneBotLink['role'][] = [];
  let port = 0;
  const transport: OneBotTransport = {
    connect: (input) => inner.connect(input),
    download: inner.download?.bind(inner),
    async listen(input) {
      const listened = await inner.listen({
        ...input,
        accept(link) {
          accepted.push(link.role);
          link.onClose(() => { closed.push(link.role); });
          input.accept(link);
        },
      });
      port = listened.port;
      return listened;
    },
  };
  const adapter = createOneBotSessionAdapter({
    platform: 'qq_onebot_v11', mode: 'reverse', endpoint: 'ws://127.0.0.1:9/', listen_port: 0,
    access_token: TOKEN, instance_id: 'qq.real-reverse-recovery', transport, retry_ms: 0,
  }, memory());
  const clients: WebSocket[] = [];
  const connect = (role: 'api' | 'event'): WebSocket => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/${role}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Client-Role': role },
    });
    clients.push(client);
    return client;
  };
  try {
    await adapter.start({ async admit() { return { decision: 'accepted' }; } });
    assert.ok(port > 0);
    const api = connect('api');
    const event = connect('event');
    let apiResponsive = true;
    const originalPong = api.pong;
    api.pong = (...args) => { if (apiResponsive) originalPong.apply(api, args); };
    await Promise.all([opened(api), opened(event)]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(closed, []);
    assert.equal(adapter.state, 'running');
    apiResponsive = false;
    await until(() => closed.includes('api'), 'reverse api socket did not fail its pong watchdog');
    assert.deepEqual(closed, ['api']);
    assert.equal(event.readyState, WebSocket.OPEN);
    assert.equal(adapter.state, 'running');
    const replacement = connect('api');
    await opened(replacement);
    await until(() => accepted.filter((role) => role === 'api').length === 2, 'reverse listener did not accept replacement');
    assert.equal(event.readyState, WebSocket.OPEN);
    assert.equal(replacement.readyState, WebSocket.OPEN);
    assert.equal(adapter.state, 'running');
    await adapter.stop();
    assert.equal(adapter.state, 'stopped');
  } finally {
    for (const client of clients) client.terminate();
    await adapter.stop().catch(() => undefined);
  }
});
