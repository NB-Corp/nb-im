import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCredentialResolver, handleIpc, Runtime, scriptProvider,
  telegramProvider, validateConfig, windowsToastProvider } from '../src/index.ts';
import type { Config, DeliveryInput } from '../src/index.ts';

const fixture = fileURLToPath(new URL('./script-fixture.mjs', import.meta.url));
const base = (): Config => ({ schema_version: '1', credential_slots: { bot: {
  env: 'NBIM_BOT', provider_id: 'telegram', provider_instance_id: 'bot', purpose: 'telegram_bot' } },
  provider_instances: { bot: { provider_id: 'telegram', enabled: true, revision: 'bot-v1',
    options: { token_slot: 'bot' } } },
  channels: { personal: { provider_instance_id: 'bot', enabled: true, revision: 'chat-v1',
    target: { chat_id: '12345' }, directions: ['send'] } } });
const input = (key: string, channel = 'personal'): DeliveryInput => ({
  idempotency_key: key, channel_id: channel, category: 'question_pending',
  expires_at: new Date(Date.now() + 60_000).toISOString(), correlation_ref: 'opaque-ref',
});
function tempDb() { const dir = mkdtempSync(join(tmpdir(), 'nb-im-test-'));
  return { path: join(dir, 'outbox.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
const BOT_TOKEN = '987:EXAMPLE_TOKEN_WITHOUT_REAL_CREDENTIAL';
function make(config: Config, path: string, adapters: ConstructorParameters<typeof Runtime>[2],
  epoch: () => string = () => 'account-v1') {
  return new Runtime(config, path, adapters,
    createCredentialResolver(config, { NBIM_BOT: BOT_TOKEN }), epoch);
}
test('Telegram: fixed template, actual ID, secret only in transport, crash/unknown no replay', async () => {
  const db = tempDb(); const config = base();
  let sends = 0;
  const adapter = telegramProvider({ post: async (token, payload, permit) => {
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++;
    assert.equal(token, BOT_TOKEN);
    assert.deepEqual(JSON.parse(payload), { chat_id: '12345',
      text: 'Kiki 有一项问题等待回答，请返回应用查看。', disable_web_page_preview: true });
    return { status: 200, body: '{"ok":true,"result":{"message_id":42}}' };
  } });
  try {
    let runtime = make(config, db.path, [adapter]);
    const queued = runtime.enqueue(input('same'));
    assert.deepEqual(runtime.enqueue({ ...input('same'), expires_at: queued.expires_at }), queued);
    assert.throws(() => runtime.enqueue({ ...input('same'), category: 'task_failed',
      expires_at: queued.expires_at }), /idempotency_conflict/);
    const done = await runtime.tick();
    assert.equal(done?.status, 'accepted_by_provider');
    assert.deepEqual(done?.result?.message_ids, ['42']);
    assert.equal(done?.attempt, 1);
    assert.equal(sends, 1);
    assert.equal(readFileSync(db.path, 'utf8').includes(BOT_TOKEN), false);
    runtime.close();
    runtime = make(config, db.path, [adapter]);
    assert.equal((await runtime.tick()), undefined);
    assert.equal(runtime.get(queued.delivery_id)?.status, 'accepted_by_provider');
    runtime.close();
  } finally { db.cleanup(); }
});
test('queued restart, interrupted send, expiry and revision change never redirect or replay', async () => {
  const db = tempDb(); const config = base(); let sends = 0;
  const adapter = telegramProvider({ post: async (_token, _body, permit) => {
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++;
    return { status: 429, body: '{"ok":false,"error_code":429,"parameters":{"retry_after":1}}' };
  } });
  try {
    let runtime = make(config, db.path, [adapter]);
    const toSend = runtime.enqueue(input('queued'));
    runtime.close();
    runtime = make(config, db.path, [adapter]);
    assert.equal((await runtime.tick())?.status, 'unknown');
    assert.equal(sends, 1);
    assert.equal((await runtime.tick()), undefined);
    const interrupted = runtime.enqueue(input('interrupted'));
    const claimed = runtime.outbox.claim();
    assert.equal(claimed?.delivery_id, interrupted.delivery_id);
    runtime.outbox.db.prepare('UPDATE deliveries SET lease_until = 0 WHERE delivery_id = ?')
      .run(interrupted.delivery_id);
    runtime.close();
    runtime = make(config, db.path, [adapter]);
    assert.equal(runtime.get(interrupted.delivery_id)?.status, 'unknown');
    assert.equal((await runtime.tick()), undefined);
    const changed = runtime.enqueue(input('revision'));
    config.channels.personal!.revision = 'chat-v2';
    assert.equal((await runtime.tick())?.status, 'failed');
    assert.equal(runtime.get(changed.delivery_id)?.result?.diagnostic_code, 'dispatch_stale');
    const mutated = runtime.enqueue(input('mutated-target'));
    config.channels.personal!.target.chat_id = '99999';
    assert.equal((await runtime.tick())?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(runtime.get(mutated.delivery_id)?.status, 'failed');
    assert.equal(sends, 1);
    const expired = runtime.enqueue(input('expired'));
    runtime.outbox.db.prepare('UPDATE deliveries SET expires_at = ? WHERE delivery_id = ?')
      .run(new Date(0).toISOString(), expired.delivery_id);
    assert.equal((await runtime.tick()), undefined);
    assert.equal(runtime.get(expired.delivery_id)?.status, 'expired');
    runtime.close();
  } finally { db.cleanup(); }
});
test('pre-boundary migration treats legacy claimed rows as unknown without replay', async () => {
  const db = tempDb(); const config = base(); let sends = 0;
  const adapter = telegramProvider({ async post(_token, _body, permit) {
    const state = permit(); if (state !== 'ready') return { blocked: state };
    sends++; return { status: 200, body: '{"ok":true,"result":{"message_id":53}}' };
  } });
  try {
    let runtime = make(config, db.path, [adapter]);
    const delivery = runtime.enqueue(input('legacy-claimed'));
    assert.equal(runtime.outbox.claim()?.delivery_id, delivery.delivery_id);
    runtime.outbox.db.exec('ALTER TABLE deliveries DROP COLUMN dispatch_started; PRAGMA user_version = 2');
    runtime.close();
    runtime = make(config, db.path, [adapter]);
    assert.equal(runtime.get(delivery.delivery_id)?.status, 'unknown');
    assert.equal(runtime.get(delivery.delivery_id)?.result?.diagnostic_code, 'send_interrupted');
    assert.equal((await runtime.tick()), undefined);
    assert.equal(sends, 0);
    runtime.close();
  } finally { db.cleanup(); }
});
test('config refuses plaintext credentials, receive, excluded providers and arbitrary fields', () => {
  const config = base();
  config.provider_instances.bot!.options = { token_slot: 'bot', token: 'LEAK' };
  assert.throws(() => validateConfig(config), /unsupported_config_field/);
  config.provider_instances.bot!.options = { token_slot: 'bot' };
  (config.channels.personal as unknown as { directions: string[] }).directions = ['receive'];
  assert.throws(() => validateConfig(config), /invalid_channel/);
  (config.channels.personal as unknown as { directions: string[] }).directions = ['send'];
  (config.provider_instances.bot as unknown as { provider_id: string }).provider_id = 'pushplus';
  assert.throws(() => validateConfig(config), /invalid_instance/);
});
test('script sending is unavailable on every OS, before approval or execution', async () => {
  const db = tempDb(); const config = base();
  config.credential_slots.bot = { env: 'NBIM_BOT', provider_id: 'script',
    provider_instance_id: 'local', purpose: 'script_secret' };
  config.provider_instances = { local: { provider_id: 'script', enabled: true,
    revision: 'script-v1', options: { protocol_version: 'nb-im-script/1',
      send: { command_argv: [process.execPath, fixture], cwd: dirname(fixture), timeout_ms: 2000 },
      env: {}, secret_env: { NBIM_SECRET_TOKEN: { credential_slot_id: 'bot' } } } } };
  config.channels = { local: { provider_instance_id: 'local', enabled: true,
    revision: 'target-v1', target: { key: 'alerts' }, directions: ['send'] } };
  let approvals = 0; let dispatches = 0;
  const adapter = scriptProvider({ async isApproved() { approvals++; return true; } });
  try {
    const runtime = make(config, db.path, [adapter]);
    assert.throws(() => runtime.enqueue(input('disabled', 'local')), /provider_unavailable/);
    assert.equal(await runtime.tick(), undefined);
    const result = await adapter.send({ delivery_id: 'test', channel_id: 'local',
      category: 'question_pending', idempotency_key: 'disabled', text: 'test',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      instance: config.provider_instances.local!, target: config.channels.local!.target,
      resolveCredential: () => BOT_TOKEN, canDispatch: () => 'ready',
      beginDispatch: () => { dispatches++; return 'ready'; } });
    assert.equal(result.diagnostic_code, 'script_execution_unavailable');
    assert.equal(approvals, 0);
    assert.equal(dispatches, 0);
    runtime.close();
  } finally { db.cleanup(); }
});
test('toast host is injected, click only opens app; IPC is versioned and rejects extra fields', async () => {
  const db = tempDb(); const config = base();
  config.credential_slots = {};
  config.provider_instances = { desktop: { provider_id: 'windows_toast', enabled: true,
    revision: 'desktop-v1', options: {} } };
  config.channels = { desktop: { provider_instance_id: 'desktop', enabled: true,
    revision: 'target-v1', target: {}, directions: ['send'] } };
  const calls: unknown[] = [];
  try {
    const runtime = make(config, db.path, [windowsToastProvider({ async show(call) {
      const state = call.permit();
      if (state !== 'ready') return state;
      calls.push({ text: call.text, activation: call.activation });
    } })]);
    const request = { protocol: 'nb-im/1', request_id: 'req-1', op: 'enqueue',
      delivery: input('toast', 'desktop') };
    const accepted = await handleIpc(runtime, request) as { value: { delivery_id: string } };
    assert.ok(accepted.value.delivery_id);
    assert.deepEqual(await handleIpc(runtime, { ...request, session_id: 'forged' }),
      { protocol: 'nb-im/1', request_id: 'req-1', error_code: 'bad_request' });
    assert.deepEqual(await handleIpc(runtime, { ...request, protocol: 'nb-im/999' }),
      { protocol: 'nb-im/1', error_code: 'unsupported_protocol' });
    const forgedInbound = { protocol: 'nb-im/1', request_id: 'req-2', op: 'inbound',
      event_id: 'same-update', sender_id: 'forged', session_id: 'admin' };
    assert.deepEqual(await handleIpc(runtime, forgedInbound),
      { protocol: 'nb-im/1', request_id: 'req-2', error_code: 'bad_request' });
    assert.deepEqual(await handleIpc(runtime, forgedInbound),
      { protocol: 'nb-im/1', request_id: 'req-2', error_code: 'bad_request' });
    for (const delivery of [null, undefined, { ...request.delivery, category: 'work_complete',
      session_id: 'forged' }, { ...request.delivery, correlation_ref: 'secret with spaces' },
      { ...request.delivery, idempotency_key: ['bad'] }]) {
      assert.deepEqual(await handleIpc(runtime, { ...request, delivery }),
        { protocol: 'nb-im/1', request_id: 'req-1', error_code: 'bad_request' });
    }
    assert.equal((await runtime.tick())?.status, 'accepted_by_provider');
    assert.deepEqual(calls, [{ text: 'Kiki 有一项问题等待回答，请返回应用查看。',
      activation: 'open_app' }]);
    runtime.close();
  } finally { db.cleanup(); }
});
