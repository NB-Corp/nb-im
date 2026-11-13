import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionHub, PlatformFault } from '../src/index.ts';
import type { RealtimeConnection, RealtimeHandlers, RealtimeRequest, SessionInbound, SessionSpec } from '../src/index.ts';

function fixture() {
  const values = new Map<string, string>();
  const requests: RealtimeRequest[] = [];
  let handlers!: RealtimeHandlers;
  let live!: AbortSignal;
  let runs = 0;
  let disconnect!: () => void;
  const connection: RealtimeConnection = {
    async run(h, _store, _scope, signal) { runs++; handlers = h; live = signal; h.onReady('bot');
      await new Promise<void>((resolve) => { disconnect = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); }); },
    async send(request, signal) { signal.throwIfAborted(); requests.push(request); return ['123.456']; },
    async download(url) { if (url === 'fail') throw new Error('download'); return new Uint8Array([1, 2, 3]); },
  };
  const store = { async load(k: string) { return values.get(k); }, async save(k: string, v: string) { values.set(k, v); } };
  return { connection, store, requests, values, get handlers() { return handlers; }, get live() { return live; },
    get runs() { return runs; }, close() { disconnect(); } };
}
const cases = [
  { platform: 'discord', spec: { bot_token: 'discord-fixture' },
    raw: { id: '100', channel_id: '22', channel: { type: 11, parent_id: '11' }, author: { id: 'user' }, content: 'caption',
      attachments: [{ url: 'file', filename: 'clip.mp4', content_type: 'video/mp4', size: 3 }] },
    chat: '11', topic: '22', reply: '100', kind: 'video' },
  { platform: 'slack', spec: { bot_token: 'slack-fixture', app_token: 'app-fixture' },
    raw: { event_id: 'Ev100', event: { type: 'message', channel: 'C100', channel_type: 'im', user: 'user', ts: '100.2', thread_ts: '100.1', text: 'caption',
      files: [{ url_private: 'file', name: 'sound.mp3', mimetype: 'audio/mpeg', size: 3 }] } },
    chat: 'C100', topic: '100.1', reply: '100.2', kind: 'audio' },
  { platform: 'matrix', spec: { homeserver: 'https://matrix.example', access_token: 'matrix-fixture' },
    raw: { type: 'm.room.message', event_id: '$100', room_id: '!room:example', sender: 'user', is_direct: true,
      content: { msgtype: 'm.image', body: 'caption', filename: 'image.png', url: 'mxc://matrix.example/x', info: { mimetype: 'image/png', size: 3 },
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } },
    chat: '!room:example', topic: '$root', reply: '$100', kind: 'image' },
] as const;
for (const c of cases) test(`${c.platform}: SessionHub inbound bytes, identity, thread reply, defer/dedup and stop`, async () => {
  const f = fixture(); const hub = createSessionHub({ store: f.store });
  const spec = { ...c.spec, platform: c.platform, instance_id: `${c.platform}-e2e`, retry_ms: 1, connection: f.connection } as SessionSpec;
  const adapter = hub.acquire(spec);
  assert.equal(hub.find(spec), adapter);
  assert.equal(hub.acquire(spec), adapter);
  const received: SessionInbound[] = []; let attempts = 0;
  await adapter.start({ async admit(event) { attempts++; if (attempts === 1) return { decision: 'defer' }; received.push(event); return { decision: 'accepted' }; } });
  assert.equal(adapter.state, 'running');
  await f.handlers.onEvent(c.raw);
  assert.equal(attempts, 2); assert.equal(received.length, 1);
  const event = received[0]!;
  assert.deepEqual(event.identity, { platform: c.platform, account_id: 'bot', chat_id: c.chat, sender_id: 'user', topic_id: c.topic, chat_kind: c.platform === 'discord' ? 'group' : 'private' });
  assert.equal(event.reply_context, c.reply);
  assert.equal(event.payload.type, 'media');
  if (event.payload.type === 'media') { assert.equal(event.payload.media.kind, c.kind); assert.deepEqual([...event.payload.media.bytes], [1, 2, 3]); assert.equal(event.payload.caption, 'caption'); }
  await f.handlers.onEvent(c.raw); assert.equal(received.length, 1);
  const result = await adapter.send({ type: 'media', target: { chat_id: c.chat, topic_id: c.topic, reply_context: event.reply_context },
    media: { kind: 'video', filename: 'reply.mp4', mime: 'video/mp4', bytes: new Uint8Array([4, 5]) } });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(f.requests[0], { op: 'message', chat_id: c.chat, topic_id: c.topic, reply_id: c.reply, text: '',
    media: { kind: 'video', filename: 'reply.mp4', mime: 'video/mp4', bytes: new Uint8Array([4, 5]) } });
  assert.equal((await adapter.send({ type: 'callback_ack', callback_id: 'x' })).error_kind, 'unsupported');
  assert.equal((await adapter.send({ type: 'media', target: { chat_id: c.chat }, media: {
    kind: 'voice', filename: 'voice.ogg', mime: 'audio/ogg', bytes: new Uint8Array([1]) } })).error_kind, 'unsupported');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await adapter.send({ type: 'text', target: { chat_id: c.chat }, text: 'no send' }, cancelled.signal)).error_kind, 'cancelled');
  assert.equal(f.requests.length, 1);
  await hub.release(spec); assert.equal(adapter.state, 'stopped'); assert.equal(f.live.aborted, true); assert.equal(hub.find(spec), undefined);
});

test('reconnect remains cancellable, auth expires without retry and receipts do not expose errors', async () => {
  const f = fixture(); let calls = 0;
  const connection: RealtimeConnection = { ...f.connection,
    async run(h, store, scope, signal) { calls++; if (calls === 1) throw new Error('secret-token-never-in-state'); return f.connection.run(h, store, scope, signal); },
    async send() { throw new PlatformFault('auth', 'slack_auth'); } };
  const hub = createSessionHub({ store: f.store });
  const spec: SessionSpec = { platform: 'slack', bot_token: 'reconnect', app_token: 'app', instance_id: 'reconnect', retry_ms: 1, connection };
  const adapter = hub.acquire(spec);
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  assert.equal(calls, 2); assert.equal(adapter.state, 'running');
  const receipt = await adapter.send({ type: 'text', target: { chat_id: 'C1' }, text: 'x' });
  assert.equal(receipt.error_kind, 'auth'); assert.equal(adapter.state, 'auth_expired');
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
  await adapter.stop();
  const expired = hub.acquire({ ...spec, bot_token: 'expired', connection: { ...connection, async run() { throw new PlatformFault('auth', 'slack_auth'); } } });
  await expired.start({ async admit() { return { decision: 'accepted' }; } }); assert.equal(expired.state, 'auth_expired'); await expired.stop();
});

test('realtime adapter preserves caption on failed single attachment and coalesces multi-attachment messages into one multipart event', async () => {
  const f = fixture();
  const hub = createSessionHub({ store: f.store });
  const spec: SessionSpec = { platform: 'discord', bot_token: 'discord-multi', instance_id: 'discord-multi', retry_ms: 1, connection: f.connection };
  const adapter = hub.acquire(spec);
  const received: SessionInbound[] = [];
  await adapter.start({ async admit(event) { received.push(event); return { decision: 'accepted' }; } });
  await f.handlers.onEvent({
    id: '200',
    channel_id: '11',
    channel: { type: 1 },
    author: { id: 'user' },
    content: 'text with failed attachment',
    attachments: [{ url: 'fail', filename: 'broken.png', content_type: 'image/png', size: 3 }],
  });
  await f.handlers.onEvent({
    id: '201',
    channel_id: '11',
    channel: { type: 1 },
    author: { id: 'user' },
    content: 'two attachments once',
    attachments: [
      { url: 'ok-1', filename: 'one.png', content_type: 'image/png', size: 3 },
      { url: 'fail', filename: 'two.png', content_type: 'image/png', size: 3 },
    ],
  });
  assert.equal(received.length, 2);
  assert.deepEqual(received[0]?.payload, {
    type: 'media_unavailable',
    kind: 'image',
    reason: 'download_failed',
    caption: 'text with failed attachment',
  });
  assert.deepEqual(received[1]?.payload, {
    type: 'parts',
    parts: [
      { type: 'text', text: 'two attachments once' },
      { type: 'media', media: { kind: 'image', filename: 'one.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) } },
      { type: 'media_unavailable', kind: 'image', reason: 'download_failed' },
    ],
  });
  await hub.release(spec);
});
