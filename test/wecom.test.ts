import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCredentialResolver, Runtime, wecomWebhookProvider } from '../src/index.ts';
import type { Config, DeliveryInput } from '../src/index.ts';
const KEY = 'abcdef12-3456-7890-ABCD-abcdef123456';
const config = (): Config => ({ schema_version: '1',
  credential_slots: { webhook: { env: 'NBIM_WECOM_KEY', provider_id: 'wecom_webhook',
    provider_instance_id: 'robot', purpose: 'wecom_key' } },
  provider_instances: { robot: { provider_id: 'wecom_webhook', enabled: true,
    revision: 'v1', options: { key_slot: 'webhook' } } },
  channels: { team: { provider_instance_id: 'robot', enabled: true,
    revision: 'v1', target: {}, directions: ['send'] } },
});
const input = (key: string): DeliveryInput => ({ idempotency_key: key, channel_id: 'team',
  category: 'question_pending', expires_at: new Date(Date.now() + 60_000).toISOString() });
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'nb-im-wecom-'));
  return { path: join(dir, 'outbox.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('official WeCom webhook: mapping, no fabricated ID, secret omitted from outbox', async () => {
  const db = store(); let sends = 0;
  try {
    const cfg = config();
    const lib = new Runtime(cfg, db.path, [wecomWebhookProvider({ async post(key, body, permit) {
      const state = permit();
      if (state !== 'ready') return { blocked: state };
      sends++;
      assert.equal(key, KEY);
      assert.deepEqual(JSON.parse(body), { msgtype: 'text',
        text: { content: 'Kiki 有一项问题等待回答，请返回应用查看。' } });
      return { status: 200, body: '{"errcode":0,"errmsg":"ok"}' };
    } })], createCredentialResolver(cfg, { NBIM_WECOM_KEY: KEY }), () => 'wecom-bot-1');
    const delivery = lib.enqueue(input('a'));
    assert.equal((await lib.tick())?.status, 'accepted_by_provider');
    assert.deepEqual(lib.get(delivery.delivery_id)?.result?.message_ids, []);
    lib.close();
    assert.equal(readFileSync(db.path, 'utf8').includes(KEY), false);
  } finally { db.cleanup(); }
  assert.equal(sends, 1);
});
test('WeCom webhook: explicit error classification and async stale permit', async () => {
  const db = store(); const cfg = config(); let sends = 0;
  let epoch = 'bot-one'; let release!: () => void; let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const lib = new Runtime(cfg, db.path, [wecomWebhookProvider({ async post(_key, _body, permit) {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++;
    return { status: 200, body: '{"errcode":93000,"errmsg":"ignore private response"}' };
  } })], createCredentialResolver(cfg, { NBIM_WECOM_KEY: KEY }), () => epoch);
  try {
    const delivery = lib.enqueue(input('b'));
    const pending = lib.tick(); await ready;
    epoch = 'bot-two'; release();
    assert.equal((await pending)?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(lib.get(delivery.delivery_id)?.status, 'failed');
    assert.equal(sends, 0);
    lib.close();
  } finally { db.cleanup(); }
});
test('WeCom: verified codes classified, other numeric codes remain unknown; errmsg redacted', async () => {
  for (const [code, status, kind, diagnostic] of [
    [45009, 'failed', 'rate_limited', 'wecom_rate_limited'],
    [-1, 'unknown', 'transient', 'wecom_busy_unknown'],
    [93000, 'unknown', 'unknown', 'wecom_rejected_unknown'],
    [40014, 'unknown', 'unknown', 'wecom_rejected_unknown'],
  ] as const) {
    const db = store(); const cfg = config();
    try {
      const lib = new Runtime(cfg, db.path, [wecomWebhookProvider({ async post(_key, _body, permit) {
        const state = permit();
        if (state !== 'ready') return { blocked: state };
        return { status: 200, body: JSON.stringify({ errcode: code, errmsg: KEY }) };
      } })], createCredentialResolver(cfg, { NBIM_WECOM_KEY: KEY }), () => 'bot-one');
      const queued = lib.enqueue(input(`error-${code}`));
      const delivered = await lib.tick();
      assert.equal(delivered?.status, status);
      assert.equal(delivered?.result?.error_kind, kind);
      assert.equal(delivered?.result?.diagnostic_code, diagnostic);
      assert.equal(delivered?.result?.retryable, false);
      assert.equal(JSON.stringify(lib.get(queued.delivery_id)).includes(KEY), false);
      lib.close();
    } finally { db.cleanup(); }
  }
});
