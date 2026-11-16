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

async function collect(spec: SessionSpec, f: ReturnType<typeof fixture>, raws: unknown[]): Promise<SessionInbound[]> {
  const hub = createSessionHub({ store: f.store });
  const adapter = hub.acquire(spec);
  const received: SessionInbound[] = [];
  await adapter.start({ async admit(event) { received.push(event); return { decision: 'accepted' }; } });
  for (const raw of raws) await f.handlers.onEvent(raw);
  await hub.release(spec);
  return received;
}

test('discord inbound metadata: names, timestamp, mentions, reply-to-bot and reply id', async () => {
  const f = fixture();
  const [thread, reply, plain] = await collect({ platform: 'discord', bot_token: 'discord-meta', instance_id: 'discord-meta',
    retry_ms: 1, connection: f.connection }, f, [
    { id: '300', type: 0, channel_id: '22', channel: { type: 11, parent_id: '11', name: 'release-42', parent_name: 'deploys' },
      author: { id: 'user', username: 'alice', global_name: 'Alice' }, member: { nick: 'Alice (ops)' },
      timestamp: '2024-01-02T03:04:05.678Z', content: '<@bot> <@other> ship it', mentions: [{ id: 'bot' }, { id: 'other' }] },
    { id: '301', type: 19, channel_id: '11', channel: { type: 0, name: 'deploys' }, author: { id: 'user', username: 'alice' },
      content: 'thanks', mentions: [], message_reference: { message_id: '299' }, referenced_message: { author: { id: 'bot' } } },
    { id: '302', channel_id: '33', channel: { type: 1 }, author: { id: 'user', username: 'alice' }, content: 'dm' },
  ]);
  assert.deepEqual(thread?.identity, { platform: 'discord', account_id: 'bot', chat_id: '11', sender_id: 'user', topic_id: '22',
    chat_kind: 'group', chat_title: 'deploys', sender_name: 'Alice (ops)', topic_title: 'release-42' });
  assert.equal(thread?.timestamp, Date.parse('2024-01-02T03:04:05.678Z'));
  assert.equal(thread?.mentioned, true);
  assert.deepEqual(thread?.mention_ids, ['bot', 'other']);
  assert.equal(thread?.reply_to_message_id, undefined);
  assert.equal(thread?.source_message_id, '300');
  assert.equal(thread?.operation, 'create');
  assert.equal(reply?.mentioned, true, 'a reply to the bot counts as addressing it');
  assert.equal(reply?.reply_to_message_id, '299');
  assert.equal(reply?.identity.sender_name, 'alice');
  assert.equal(plain?.mentioned, false);
  assert.equal(plain?.identity.chat_kind, 'private');
  assert.equal(plain?.identity.chat_title, undefined);
});

test('slack inbound metadata: profile name, ts timestamp, <@> mentions, app_mention and thread reply to the bot', async () => {
  const f = fixture();
  const events = await collect({ platform: 'slack', bot_token: 'slack-meta', app_token: 'app', instance_id: 'slack-meta',
    retry_ms: 1, connection: f.connection }, f, [
    { event_id: 'Ev1', event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1700000000.123456',
      text: 'hey <@bot> and <@U2|bob>', user_profile: { display_name: '', real_name: 'Alice Smith', name: 'alice' } } },
    { event_id: 'Ev2', event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1700000001.000100',
      thread_ts: '1700000000.000001', parent_user_id: 'bot', text: 'replying in your thread' } },
    { event_id: 'Ev3', event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1700000002.000000', text: 'ping' } },
  ]);
  const [mention, threadReply, appMention] = events;
  assert.equal(mention?.identity.sender_name, 'Alice Smith');
  assert.equal(mention?.timestamp, 1_700_000_000_123);
  assert.equal(mention?.mentioned, true);
  assert.deepEqual(mention?.mention_ids, ['bot', 'U2']);
  assert.equal(mention?.source_message_id, '1700000000.123456');
  assert.equal(threadReply?.mentioned, true);
  assert.equal(threadReply?.reply_to_message_id, '1700000000.000001');
  assert.equal(threadReply?.identity.topic_id, '1700000000.000001');
  assert.equal(appMention?.mentioned, true);
});

test('matrix inbound metadata: room/member names, origin_server_ts, m.mentions, legacy pills and real replies only', async () => {
  const f = fixture();
  const events = await collect({ platform: 'matrix', homeserver: 'https://matrix.example', access_token: 'matrix-meta',
    instance_id: 'matrix-meta', retry_ms: 1, connection: f.connection }, f, [
    { type: 'm.room.message', event_id: '$1', room_id: '!r:example', sender: '@alice:example', origin_server_ts: 1_700_000_000_000,
      room_name: 'Ops', sender_name: 'Alice', content: { msgtype: 'm.text', body: 'hi bot', 'm.mentions': { user_ids: ['bot'] },
        'm.relates_to': { 'm.in_reply_to': { event_id: '$0' } } } },
    { type: 'm.room.message', event_id: '$2', room_id: '!r:example', sender: '@alice:example',
      content: { msgtype: 'm.text', body: 'bob: hi', formatted_body: '<a href="https://matrix.to/#/%40bob%3Aexample">bob</a>: hi',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true, 'm.in_reply_to': { event_id: '$root' } } } },
  ]);
  const [direct, threaded] = events;
  assert.equal(direct?.identity.chat_title, 'Ops');
  assert.equal(direct?.identity.sender_name, 'Alice');
  assert.equal(direct?.timestamp, 1_700_000_000_000);
  assert.equal(direct?.mentioned, true);
  assert.equal(direct?.reply_to_message_id, '$0');
  assert.deepEqual(threaded?.mention_ids, ['@bob:example']);
  assert.equal(threaded?.mentioned, false);
  assert.equal(threaded?.reply_to_message_id, undefined, 'thread fallback is not a reply');
  assert.equal(threaded?.identity.topic_id, '$root');
});

test('own messages are dropped by default and emitted with is_self under include_self', async () => {
  const own = {
    discord: { id: '400', channel_id: '11', channel: { type: 0 }, author: { id: 'bot', bot: true }, content: 'from me' },
    slack: { event_id: 'Ev400', event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'bot', bot_id: 'B1',
      ts: '1700000000.000400', text: 'from me' } },
    matrix: { type: 'm.room.message', event_id: '$400', room_id: '!r:example', sender: 'bot', content: { msgtype: 'm.text', body: 'from me' } },
  } as const;
  const otherBot = { id: '401', channel_id: '11', channel: { type: 0 }, author: { id: 'robot', bot: true }, content: 'other bot' };
  for (const c of cases) {
    const base = { ...c.spec, platform: c.platform, retry_ms: 1 };
    const off = fixture();
    const dropped = await collect({ ...base, instance_id: `${c.platform}-self-off`, connection: off.connection } as SessionSpec, off,
      [own[c.platform]]);
    assert.equal(dropped.length, 0, c.platform);
    const on = fixture();
    const kept = await collect({ ...base, instance_id: `${c.platform}-self-on`, include_self: true, connection: on.connection } as SessionSpec,
      on, c.platform === 'discord' ? [own.discord, otherBot] : [own[c.platform]]);
    assert.equal(kept.length, 1, c.platform);
    assert.equal(kept[0]?.is_self, true);
    assert.equal(kept[0]?.identity.sender_id, 'bot');
    assert.deepEqual(kept[0]?.payload, { type: 'text', text: 'from me' });
  }
});

test('slack and matrix edits/retractions are dropped by default and emitted under include_edits', async () => {
  const slackEvents = [
    { event_id: 'Ev500', event: { type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: '1700000009.000000',
      message: { type: 'message', user: 'U1', text: 'fixed <@bot>', ts: '1700000000.000500', thread_ts: '1700000000.000001',
        edited: { user: 'U1', ts: '1700000009.000000' } } } },
    // Link unfurl: no `edited`, never an edit.
    { event_id: 'Ev501', event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1700000010.000000',
      message: { type: 'message', user: 'U1', text: 'see https://x', ts: '1700000000.000501', attachments: [{}] } } },
    { event_id: 'Ev502', event: { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '1700000011.000000',
      deleted_ts: '1700000000.000500', previous_message: { user: 'U1', text: 'fixed', ts: '1700000000.000500' } } },
  ];
  const matrixEvents = [
    { type: 'm.room.message', event_id: '$e1', room_id: '!r:example', sender: '@alice:example', origin_server_ts: 1_700_000_009_000,
      content: { msgtype: 'm.text', body: '* fixed', 'm.new_content': { msgtype: 'm.text', body: 'fixed' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' } } },
    { type: 'm.room.redaction', event_id: '$e2', room_id: '!r:example', sender: '@alice:example', redacts: '$orig', content: {} },
  ];
  for (const [platform, spec, raws] of [
    ['slack', { platform: 'slack', bot_token: 'slack-edit', app_token: 'app' }, slackEvents],
    ['matrix', { platform: 'matrix', homeserver: 'https://matrix.example', access_token: 'matrix-edit' }, matrixEvents],
  ] as const) {
    const off = fixture();
    assert.equal((await collect({ ...spec, instance_id: `${platform}-edit-off`, retry_ms: 1, connection: off.connection } as SessionSpec,
      off, [...raws])).length, 0, platform);
    const on = fixture();
    const events = await collect({ ...spec, instance_id: `${platform}-edit-on`, retry_ms: 1, include_edits: true,
      connection: on.connection } as SessionSpec, on, [...raws]);
    assert.deepEqual(events.map((e) => [e.operation, e.source_message_id, e.payload]), platform === 'slack' ? [
      ['edit', '1700000000.000500', { type: 'text', text: 'fixed <@bot>' }],
      ['retract', '1700000000.000500', { type: 'text', text: '' }],
    ] : [
      ['edit', '$orig', { type: 'text', text: 'fixed' }],
      ['retract', '$orig', { type: 'text', text: '' }],
    ]);
    assert.notEqual(events[0]?.event_key, events[1]?.event_key);
    if (platform === 'slack') {
      assert.equal(events[0]?.identity.topic_id, '1700000000.000001');
      assert.equal(events[0]?.mentioned, true);
      assert.equal(events[0]?.timestamp, 1_700_000_009_000);
      assert.equal(events[1]?.identity.sender_id, 'U1');
    } else assert.equal(events[0]?.timestamp, 1_700_000_009_000);
  }
});
