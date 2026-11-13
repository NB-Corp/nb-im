import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { REST } from 'discord.js';
import { WebSocketServer } from 'ws';
import { createDiscordConnection, createSlackConnection, createMatrixConnection,
  createSessionHub, PlatformFault } from '../src/index.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Discord uses real SDK REST multipart, thread URL, reply reference and disables mentions', async () => {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const rest = new REST({ version: '10', retries: 0, makeRequest: async (url, init) => {
    calls.push({ url: String(url), init }); return json({ id: '123' });
  } }).setToken('fixture-not-a-real-token');
  const connection = createDiscordConnection('fixture', rest);
  const signal = new AbortController().signal;
  assert.deepEqual(await connection.send({ op: 'message', chat_id: '11', topic_id: '22', reply_id: '33', text: 'hello',
    media: { kind: 'video', filename: 'clip.mp4', mime: 'video/mp4', bytes: new Uint8Array([1, 2, 3]) } }, signal), ['123']);
  assert.match(calls[0]!.url, /\/channels\/22\/messages$/);
  const form = calls[0]!.init.body as FormData;
  const payload = JSON.parse(String(form.get('payload_json')));
  assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(payload.message_reference.message_id, '33');
  assert.deepEqual([...new Uint8Array(await (form.get('files[0]') as Blob).arrayBuffer())], [1, 2, 3]);
  await connection.send({ op: 'edit', chat_id: '11', topic_id: '22', message_id: '123', text: 'edited' }, signal);
  assert.match(calls[1]!.url, /\/channels\/22\/messages\/123$/);
});

test('Slack real Socket Mode SDK receives envelope, admits, acks, sends thread text and uploads through V2', async () => {
  const originalFetch = globalThis.fetch;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(typeof address === 'object' && address);
  const calls: { method: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ method: path, body: init?.body });
    if (path.endsWith('/auth.test')) return json({ ok: true, user_id: 'B1', team_id: 'T1' });
    if (path.endsWith('/apps.connections.open')) return json({ ok: true, url: `ws://127.0.0.1:${address.port}` });
    if (path.endsWith('/chat.postMessage')) return json({ ok: true, ts: '100.3' });
    if (path.endsWith('/files.getUploadURLExternal')) return json({ ok: true, upload_url: 'https://files.slack.com/upload-fixture', file_id: 'F1' });
    if (path.endsWith('/upload-fixture')) return new Response('OK');
    if (path.endsWith('/files.completeUploadExternal')) return json({ ok: true, files: [{ id: 'F1' }] });
    throw new Error(`Unexpected offline Slack request ${path}`);
  };
  const hub = createSessionHub({ store: { async load() { return undefined; }, async save() {} } });
  const spec = { platform: 'slack' as const, instance_id: 'slack-wire', bot_token: 'xoxb-fixture', app_token: 'xapp-fixture' };
  const adapter = hub.acquire(spec);
  let received!: () => void;
  const admitted = new Promise<void>((resolve) => { received = resolve; });
  const connected = once(server, 'connection');
  const started = adapter.start({ async admit(event) { assert.equal(event.identity.sender_id, 'U1'); received(); return { decision: 'accepted' }; } });
  try {
    const [socket] = await connected;
    socket.send(JSON.stringify({ type: 'hello', connection_info: { app_id: 'A1' }, num_connections: 1 }));
    await started;
    const acked = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'events_api', envelope_id: 'env1', payload: {
      event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', ts: '100.1', text: 'hello' } } }));
    await admitted;
    const [ack] = await acked;
    assert.equal(JSON.parse(String(ack)).envelope_id, 'env1');
    assert.equal((await adapter.send({ type: 'text', target: { chat_id: 'C1', topic_id: '100.1' }, text: 'reply' })).status, 'accepted');
    const text = calls.find((c) => c.method.endsWith('/chat.postMessage'))!;
    assert.equal(new URLSearchParams(String(text.body)).get('thread_ts'), '100.1');
    assert.equal((await adapter.send({ type: 'media', target: { chat_id: 'C1', topic_id: '100.1' }, media: {
      kind: 'audio', filename: 'audio.mp3', mime: 'audio/mpeg', bytes: new Uint8Array([7, 8]) } })).status, 'accepted');
    const complete = calls.find((c) => c.method.endsWith('/files.completeUploadExternal'))!;
    assert.equal(new URLSearchParams(String(complete.body)).get('thread_ts'), '100.1');
  } finally { await adapter.stop(); globalThis.fetch = originalFetch; for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('Matrix SDK preserves sync cursor admission, authenticates media, thread edit, and refuses encrypted plaintext', async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map<string, string>([['scope:matrix_sync', 'old']]);
  const store = { async load(k: string) { return values.get(k); }, async save(k: string, v: string) { values.set(k, v); } };
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const controller = new AbortController(); let sync = 0; let admitted = false; let account = '';
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); calls.push({ path: u.pathname, init });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    if (u.pathname.endsWith('/account/whoami')) return json({ user_id: '@bot:example' });
    if (u.pathname.endsWith('/account_data/m.direct')) return json({ '@user:example': ['!room:example'] });
    if (u.pathname.endsWith('/sync')) {
      sync++;
      assert.equal(u.searchParams.get('since'), sync === 1 ? 'old' : 'next');
      if (sync === 1) return json({ next_batch: 'next', rooms: { join: { '!room:example': { timeline: { events: [
        { type: 'm.room.message', event_id: '$event', sender: '@user:example', content: { msgtype: 'm.text', body: 'hello' } } ] } } } } });
      controller.abort(); throw new DOMException('aborted', 'AbortError');
    }
    if (u.pathname.includes('/state/m.room.encryption')) return u.pathname.includes('encrypted') ? json({ algorithm: 'm.megolm.v1.aes-sha2' }) : json({ errcode: 'M_NOT_FOUND', error: 'not found' }, 404);
    if (u.pathname.endsWith('/upload')) { assert.deepEqual([...new Uint8Array(init?.body as ArrayBuffer)], [1, 2]); return json({ content_uri: 'mxc://example/file' }); }
    if (u.pathname.includes('/send/m.room.message/')) return json({ event_id: '$sent' });
    if (u.pathname.includes('/media/download/')) return new Response(new Uint8Array([5, 6]), { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected offline Matrix path ${u.pathname}`);
  };
  try {
    const connection = createMatrixConnection('https://matrix.example', 'fixture-token');
    await assert.rejects(connection.run({ onReady(id) { account = id; }, onReconnecting() {}, async onEvent(event) {
      assert.equal(account, '@bot:example'); assert.equal(values.get('scope:matrix_sync'), 'old');
      assert.equal((event as { is_direct: boolean }).is_direct, true); admitted = true;
    } }, store, 'scope', controller.signal));
    assert.equal(admitted, true); assert.equal(values.get('scope:matrix_sync'), 'next');
    const signal = new AbortController().signal;
    assert.deepEqual(await connection.download('mxc://remote.example/file', signal), new Uint8Array([5, 6]));
    assert.ok(calls.some((c) => c.path.includes('/_matrix/client/v1/media/download/remote.example/file')));
    assert.deepEqual(await connection.send({ op: 'message', chat_id: '!room:example', topic_id: '$root', reply_id: '$reply', text: 'caption',
      media: { kind: 'image', filename: 'image.png', mime: 'image/png', bytes: new Uint8Array([1, 2]) } }, signal), ['$sent']);
    const content = JSON.parse(String(calls.find((c) => c.path.includes('/send/'))!.init?.body));
    assert.equal(content.msgtype, 'm.image'); assert.equal(content['m.relates_to'].event_id, '$root');
    await connection.send({ op: 'edit', chat_id: '!room:example', message_id: '$sent', text: 'edited' }, signal);
    const edited = JSON.parse(String(calls.filter((c) => c.path.includes('/send/'))[1]!.init?.body));
    assert.equal(edited['m.relates_to'].rel_type, 'm.replace'); assert.equal(edited['m.new_content'].body, 'edited');
    await assert.rejects(connection.send({ op: 'message', chat_id: '!encrypted:example', text: 'no plaintext' }, signal), (error: unknown) => error instanceof PlatformFault && error.kind === 'unsupported');
  } finally { globalThis.fetch = originalFetch; }
});
