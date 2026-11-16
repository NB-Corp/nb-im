import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createSessionHub, decryptWecomMedia } from '../src/index.ts';
import type { SessionInbound, SessionSpec, WecomAibotLink, WecomAibotTransport } from '../src/index.ts';

type Frame = { cmd?: string; headers: { req_id: string }; body?: Record<string, unknown> };
type Reply = { errcode?: number; body?: Record<string, unknown> } | 'silent';

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const pad = 32 - (plain.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]);
}

function fixture(answer: (frame: Frame) => Reply = () => ({})) {
  const sent: Frame[] = [];
  const values = new Map<string, string>();
  const downloads = new Map<string, Uint8Array>();
  let frameHandler: (frame: unknown) => void = () => undefined;
  let closeHandlers: Array<() => void> = [];
  let connects = 0;
  const transport: WecomAibotTransport = {
    async connect() {
      connects++;
      let closed = false;
      const link: WecomAibotLink = {
        send(raw) {
          const frame = raw as Frame;
          sent.push(frame);
          const reply = answer(frame);
          if (reply === 'silent') return;
          queueMicrotask(() => frameHandler({ headers: { req_id: frame.headers.req_id }, errcode: reply.errcode ?? 0, errmsg: 'ok', ...(reply.body ? { body: reply.body } : {}) }));
        },
        onFrame(handler) { frameHandler = handler; },
        onClose(handler) { closeHandlers.push(handler); },
        close() { if (closed) return; closed = true; const hs = closeHandlers; closeHandlers = []; for (const h of hs) h(); },
      };
      return link;
    },
    async download(url) { const bytes = downloads.get(url); return bytes ? { ok: true, bytes } : { ok: false }; },
  };
  const store = { async load(k: string) { return values.get(k); }, async save(k: string, v: string) { values.set(k, v); } };
  return { transport, store, sent, downloads, push: (frame: unknown) => frameHandler(frame), close: () => { for (const h of closeHandlers.splice(0)) h(); },
    get connects() { return connects; } };
}
const spec = (f: ReturnType<typeof fixture>, extra: Partial<SessionSpec> = {}) => ({ platform: 'wecom_aibot', instance_id: `wecom-${Math.random().toString(36).slice(2)}`,
  bot_id: `aib-${Math.random().toString(36).slice(2)}`, secret: 'secret-fixture', retry_ms: 1, ack_timeout_ms: 50, transport: f.transport, ...extra }) as SessionSpec;
const until = async (check: () => boolean, ms = 1000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); } };

test('wecom_aibot: subscribes, maps a group @ callback, answers it once, then pushes', async () => {
  const f = fixture();
  const s = spec(f);
  const adapter = createSessionHub({ store: f.store }).acquire(s);
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  assert.equal(adapter.state, 'running');
  const sub = f.sent[0]!;
  assert.equal(sub.cmd, 'aibot_subscribe');
  assert.deepEqual(sub.body, { bot_id: (s as { bot_id: string }).bot_id, secret: 'secret-fixture' });
  f.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'cb-1' }, body: { msgid: 'm1', aibotid: 'x', chatid: 'grp1', chattype: 'group',
    from: { userid: 'zhangsan' }, create_time: 1700000000, msgtype: 'text', text: { content: '@机器人 导出失败了' },
    quote: { msgtype: 'text', text: { content: '上一条' } } } });
  await until(() => got.length === 1);
  const event = got[0]!;
  assert.equal(event.identity.chat_id, 'grp1');
  assert.equal(event.identity.sender_id, 'zhangsan');
  assert.equal(event.identity.chat_kind, 'group');
  assert.equal(event.mentioned, true);
  assert.equal(event.quoted_text, '上一条');
  assert.equal(event.timestamp, 1700000000_000);
  assert.deepEqual(event.payload, { type: 'text', text: '@机器人 导出失败了' });
  const target = { chat_id: 'grp1', chat_kind: 'group' as const, reply_context: event.reply_context! };
  const first = await adapter.send({ type: 'text', target, text: '收到，我看看' });
  assert.equal(first.status, 'accepted');
  const respond = f.sent.at(-1)!;
  assert.equal(respond.cmd, 'aibot_respond_msg');
  assert.equal(respond.headers.req_id, 'cb-1');
  assert.equal((respond.body!.stream as { finish: boolean; content: string }).finish, true);
  assert.equal((respond.body!.stream as { content: string }).content, '收到，我看看');
  const second = await adapter.send({ type: 'text', target, text: '是文件太大了' });
  assert.equal(second.status, 'accepted');
  const push = f.sent.at(-1)!;
  assert.equal(push.cmd, 'aibot_send_msg');
  assert.deepEqual(push.body, { chatid: 'grp1', chat_type: 2, msgtype: 'markdown', markdown: { content: '是文件太大了' } });
  f.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'cb-dup' }, body: { msgid: 'm1', chattype: 'group', chatid: 'grp1', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: 'again' } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1, 'same msgid is admitted once');
  await adapter.stop();
});

test('wecom_aibot: a DM push uses the userid; errors and silence become failed and unknown', async () => {
  let mode: 'error' | 'silent' | 'ok' = 'error';
  const f = fixture((frame) => frame.cmd === 'aibot_send_msg' ? (mode === 'silent' ? 'silent' : mode === 'error' ? { errcode: 45009 } : {}) : {});
  const adapter = createSessionHub({ store: f.store }).acquire(spec(f));
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  const target = { chat_id: 'lisi', chat_kind: 'private' as const };
  const limited = await adapter.send({ type: 'text', target, text: 'hi' });
  assert.equal(limited.status, 'failed');
  assert.equal(limited.error_kind, 'rate_limited');
  assert.equal(limited.diagnostic_code, 'wecom_aibot_errcode_45009');
  assert.deepEqual(f.sent.at(-1)!.body, { chatid: 'lisi', chat_type: 1, msgtype: 'markdown', markdown: { content: 'hi' } });
  mode = 'silent';
  const lost = await adapter.send({ type: 'text', target, text: 'hi' });
  assert.equal(lost.status, 'unknown');
  mode = 'ok';
  assert.equal((await adapter.send({ type: 'edit_text', target, message_id: 'x', text: 'y' })).diagnostic_code, 'wecom_aibot_edit_unsupported');
  assert.equal((await adapter.send({ type: 'text', target, text: 'x'.repeat(20_481) })).error_kind, 'too_long');
  await adapter.stop();
});

test('wecom_aibot: an expired or refused answer falls back to a push', async () => {
  const f = fixture((frame) => frame.cmd === 'aibot_respond_msg' ? { errcode: 40058 } : {});
  const adapter = createSessionHub({ store: f.store }).acquire(spec(f));
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  const stale = JSON.stringify({ r: 'cb-old', t: Date.now() - 10 * 60_000 });
  assert.equal((await adapter.send({ type: 'text', target: { chat_id: 'u1', chat_kind: 'private', reply_context: stale }, text: 'a' })).status, 'accepted');
  assert.equal(f.sent.at(-1)!.cmd, 'aibot_send_msg');
  const fresh = JSON.stringify({ r: 'cb-new', t: Date.now() });
  assert.equal((await adapter.send({ type: 'text', target: { chat_id: 'u1', chat_kind: 'private', reply_context: fresh }, text: 'b' })).status, 'accepted');
  assert.deepEqual(f.sent.slice(-2).map((x) => x.cmd), ['aibot_respond_msg', 'aibot_send_msg']);
  await adapter.stop();
});

test('wecom_aibot: wrong credentials end in auth_expired; a newer connection ends in conflict', async () => {
  const bad = fixture((frame) => frame.cmd === 'aibot_subscribe' ? { errcode: 40001 } : {});
  const a = createSessionHub({ store: bad.store }).acquire(spec(bad));
  await a.start({ async admit() { return { decision: 'accepted' }; } });
  await until(() => a.state === 'auth_expired');
  assert.equal(bad.connects, 3);
  await a.stop();
  const f = fixture();
  const b = createSessionHub({ store: f.store }).acquire(spec(f));
  await b.start({ async admit() { return { decision: 'accepted' }; } });
  f.push({ cmd: 'aibot_event_callback', headers: { req_id: 'ev' }, body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } } });
  await until(() => b.state === 'conflict');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.connects, 1, 'no reconnect after being replaced');
  await b.stop();
});

test('wecom_aibot: reconnects after the link drops and keeps answering', async () => {
  const f = fixture();
  const adapter = createSessionHub({ store: f.store }).acquire(spec(f));
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  f.close();
  await until(() => f.connects === 2 && adapter.state === 'running');
  assert.equal(f.sent.filter((x) => x.cmd === 'aibot_subscribe').length, 2);
  await adapter.stop();
});

test('wecom_aibot: decrypts inbound media and uploads outbound media in chunks', async () => {
  const f = fixture((frame) => frame.cmd === 'aibot_upload_media_init' ? { body: { upload_id: 'up1' } } :
    frame.cmd === 'aibot_upload_media_finish' ? { body: { media_id: 'media-1', type: 'image' } } : {});
  const adapter = createSessionHub({ store: f.store }).acquire(spec(f));
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  const key = randomBytes(32);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(100)]);
  f.downloads.set('https://media.example/img', new Uint8Array(encrypt(png, key)));
  assert.deepEqual(Buffer.from(decryptWecomMedia(encrypt(png, key), key.toString('base64'))), png);
  f.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'cb-img' }, body: { msgid: 'm-img', chattype: 'single', from: { userid: 'u2' }, msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text', text: { content: '看图' } }, { msgtype: 'image', image: { url: 'https://media.example/img', aeskey: key.toString('base64') } },
      { msgtype: 'image', image: { url: 'https://media.example/gone', aeskey: key.toString('base64') } }] } } });
  await until(() => got.length === 1);
  const payload = got[0]!.payload as { type: 'parts'; parts: Array<{ type: string; text?: string; media?: { mime: string; bytes: Uint8Array } }> };
  assert.equal(got[0]!.identity.chat_id, 'u2');
  assert.equal(got[0]!.identity.chat_kind, 'private');
  assert.deepEqual(payload.parts.map((p) => p.type), ['text', 'media', 'media_unavailable']);
  assert.equal(payload.parts[1]!.media!.mime, 'image/png');
  assert.deepEqual(Buffer.from(payload.parts[1]!.media!.bytes), png);
  const bytes = new Uint8Array(randomBytes(600 * 1024));
  const receipt = await adapter.send({ type: 'media', target: { chat_id: 'u2', chat_kind: 'private' }, caption: '截图',
    media: { kind: 'image', filename: 'shot.png', mime: 'image/png', bytes } });
  assert.equal(receipt.status, 'accepted');
  const cmds = f.sent.map((x) => x.cmd).filter((c) => c && c !== 'ping' && c !== 'aibot_subscribe');
  assert.deepEqual(cmds, ['aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_chunk', 'aibot_upload_media_finish', 'aibot_send_msg', 'aibot_send_msg']);
  const chunks = f.sent.filter((x) => x.cmd === 'aibot_upload_media_chunk');
  assert.deepEqual(chunks.map((x) => x.body!.chunk_index), [0, 1]);
  assert.equal(f.sent.find((x) => x.cmd === 'aibot_upload_media_init')!.body!.total_chunks, 2);
  assert.deepEqual(f.sent.filter((x) => x.cmd === 'aibot_send_msg')[0]!.body, { chatid: 'u2', chat_type: 1, msgtype: 'image', image: { media_id: 'media-1' } });
  await adapter.stop();
});
