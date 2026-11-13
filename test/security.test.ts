import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCredentialResolver, Runtime, scriptProvider, telegramProvider,
  windowsToastProvider } from '../src/index.ts';
import { authorizeScriptSnapshot, parseScriptReceipt } from '../src/script.ts';
import type { Config, DeliveryInput, ProviderContext } from '../src/index.ts';

const TOKEN = '987:EXAMPLE_TOKEN_WITHOUT_REAL_CREDENTIAL';
const base = (): Config => ({ schema_version: '1', credential_slots: { token: {
  env: 'NBIM_BOT', provider_id: 'telegram', provider_instance_id: 'bot', purpose: 'telegram_bot' } },
  provider_instances: { bot: { provider_id: 'telegram', enabled: true, revision: 'v1',
    options: { token_slot: 'token' } } },
  channels: { mine: { provider_instance_id: 'bot', enabled: true, revision: 'v1',
    target: { chat_id: '12345' }, directions: ['send'] } } });
const request = (key: string, channel = 'mine'): DeliveryInput => ({
  idempotency_key: key, channel_id: channel, category: 'work_complete',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'nb-im-audit-'));
  return { path: join(dir, 'outbox.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runtime(config: Config, path: string, adapters: ConstructorParameters<typeof Runtime>[2],
  epoch: () => string) {
  return new Runtime(config, path, adapters,
    createCredentialResolver(config, { NBIM_BOT: TOKEN }), epoch);
}
test('NBIM-01: host epoch rotation rejects old queued delivery before token resolution', async () => {
  const db = store(); const config = base(); let epoch = 'bot-one'; let sends = 0;
  const adapter = telegramProvider({ async post(_token, _body, permit) {
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++;
    return { status: 200, body: '{"ok":true,"result":{"message_id":52}}' };
  } });
  try {
    let lib = runtime(config, db.path, [adapter], () => epoch);
    const queued = lib.enqueue(request('old-key'));
    lib.close();
    epoch = 'bot-two';
    lib = runtime(config, db.path, [adapter], () => epoch);
    assert.equal((await lib.tick())?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(sends, 0);
    assert.throws(() => lib.enqueue({ ...request('old-key'), expires_at: queued.expires_at }),
      /idempotency_conflict/);
    const fresh = lib.enqueue(request('new-key'));
    assert.equal((await lib.tick())?.status, 'accepted_by_provider');
    assert.equal(sends, 1);
    assert.equal(lib.get(fresh.delivery_id)?.status, 'accepted_by_provider');
    assert.equal(readFileSync(db.path, 'utf8').includes(TOKEN), false);
    lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-01: a token replaced without rotating the host epoch cannot be detected', async () => {
  const db = store(); const config = base(); let token = TOKEN; let observed = '';
  const adapter = telegramProvider({ async post(value, _body, permit) {
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    observed = value;
    return { status: 200, body: '{"ok":true,"result":{"message_id":52}}' };
  } });
  try {
    const lib = new Runtime(config, db.path, [adapter], () => token, () => 'unchanged-epoch');
    lib.enqueue(request('host-epoch-omission'));
    token = '988:EXAMPLE_TOKEN_WITHOUT_REAL_CREDENTIAL';
    assert.equal((await lib.tick())?.status, 'accepted_by_provider');
    assert.equal(observed, token);
    lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-03: async transport preflight rechecks epoch, expiry and target before HTTP', async () => {
  const db = store(); const config = base(); let epoch = 'one'; let unblock!: () => void;
  let entered!: () => void; let sends = 0;
  const gate = () => new Promise<void>((resolve) => { unblock = resolve; entered(); });
  let ready = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = telegramProvider({ async post(_token, _body, permit) {
    await gate();
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++;
    return { status: 200, body: '{"ok":true,"result":{"message_id":52}}' };
  } });
  try {
    const lib = runtime(config, db.path, [adapter], () => epoch);
    const first = lib.enqueue(request('rotate-during-dns'));
    const pending = lib.tick();
    await ready; epoch = 'two'; unblock();
    assert.equal((await pending)?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(lib.get(first.delivery_id)?.status, 'failed');
    ready = new Promise<void>((resolve) => { entered = resolve; });
    const second = lib.enqueue({ ...request('expire-during-dns'),
      expires_at: new Date(Date.now() + 120).toISOString() });
    const next = lib.tick();
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 150));
    unblock();
    assert.equal((await next)?.status, 'expired');
    assert.equal(lib.get(second.delivery_id)?.result?.diagnostic_code, 'delivery_expired');
    ready = new Promise<void>((resolve) => { entered = resolve; });
    const third = lib.enqueue(request('target-during-dns'));
    const final = lib.tick();
    await ready;
    config.channels.mine!.target.chat_id = '98765';
    unblock();
    assert.equal((await final)?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(sends, 0);
    lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-03: queued and claimed-before-dispatch cancellation prevent stale toast', async () => {
  const db = store(); const config = base(); let unblock!: () => void; let entered!: () => void;
  const adapter = windowsToastProvider({ async show({ permit }) {
    entered(); await new Promise<void>((resolve) => { unblock = resolve; });
    const state = permit();
    return state === 'ready' ? undefined : state;
  } });
  config.credential_slots = {};
  config.provider_instances = { desktop: { provider_id: 'windows_toast', enabled: true,
    revision: 'v1', options: {} } };
  config.channels = { desktop: { provider_instance_id: 'desktop', enabled: true,
    revision: 'v1', target: {}, directions: ['send'] } };
  try {
    const lib = runtime(config, db.path, [adapter], () => 'desktop-v1');
    const queued = lib.enqueue(request('cancel-queued', 'desktop'));
    assert.equal(lib.cancel(queued.delivery_id), true);
    assert.equal(lib.get(queued.delivery_id)?.status, 'cancelled');
    const sending = lib.enqueue(request('cancel-sending', 'desktop'));
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = lib.tick(); await ready;
    const peer = runtime(config, db.path, [adapter], () => 'desktop-v1');
    assert.equal(peer.get(sending.delivery_id)?.status, 'sending');
    assert.equal(peer.cancel(sending.delivery_id), true);
    assert.equal(lib.get(sending.delivery_id)?.status, 'cancelled');
    unblock();
    assert.equal((await pending)?.status, 'cancelled');
    peer.close(); lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-03: once dispatch begins, cancellation is unknown and late receipt is fenced', async () => {
  const db = store(); const config = base(); let unblock!: () => void; let entered!: () => void;
  let sends = 0;
  const adapter = telegramProvider({ async post(_token, _body, permit) {
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    sends++; entered();
    await new Promise<void>((resolve) => { unblock = resolve; });
    return { status: 200, body: '{"ok":true,"result":{"message_id":52}}' };
  } });
  try {
    const lib = runtime(config, db.path, [adapter], () => 'bot-one');
    const delivery = lib.enqueue(request('cancel-after-boundary'));
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = lib.tick(); await ready;
    const peer = runtime(config, db.path, [adapter], () => 'bot-one');
    assert.equal(peer.cancel(delivery.delivery_id), false);
    assert.equal(lib.get(delivery.delivery_id)?.status, 'unknown');
    assert.equal(lib.get(delivery.delivery_id)?.result?.diagnostic_code, 'cancel_after_dispatch');
    unblock();
    assert.equal((await pending)?.status, 'unknown');
    assert.equal(sends, 1);
    assert.equal(await lib.tick(), undefined);
    peer.close(); lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-04: Windows script capability rejects before approval/spawn', async () => {
  if (process.platform !== 'win32') return;
  const db = store(); const config = base(); let approvals = 0;
  config.credential_slots = {};
  config.provider_instances = { local: { provider_id: 'script', enabled: true,
    revision: 'v1', options: { protocol_version: 'nb-im-script/1',
      send: { command_argv: [process.execPath, 'C:/not-a-user-script.mjs'],
        cwd: 'C:/', timeout_ms: 100 }, env: {}, secret_env: {} } } };
  config.channels = { local: { provider_instance_id: 'local', enabled: true,
    revision: 'v1', target: { key: 'alerts' }, directions: ['send'] } };
  try {
    const lib = runtime(config, db.path, [scriptProvider({ async isApproved() {
      approvals++; return true;
    } })], () => 'script-v1');
    assert.throws(() => lib.enqueue(request('blocked', 'local')), /provider_unavailable/);
    assert.equal(approvals, 0);
    lib.close();
  } finally { db.cleanup(); }
});
test('NBIM-02: approval snapshot changes with target/source and catches async invalidation', async () => {
  const fixture = new URL('./script-fixture.mjs', import.meta.url);
  const original = readFileSync(fixture);
  const context: ProviderContext = {
    delivery_id: 'delivery-1', channel_id: 'script.channel', category: 'question_pending',
    text: 'fixed', idempotency_key: 'key-1', expires_at: new Date(Date.now() + 60_000).toISOString(),
    instance: { provider_id: 'script', enabled: true, revision: 'v1', options: {
      // Authorization-only test: never spawn this small dummy executable.
      send: { command_argv: [fileURLToPath(fixture), fileURLToPath(fixture)],
        cwd: tmpdir(), timeout_ms: 2000 },
      env: {}, secret_env: {}, protocol_version: 'nb-im-script/1',
    } }, target: { key: 'alerts' }, resolveCredential: () => TOKEN,
    canDispatch: () => 'ready', beginDispatch: () => 'stale',
  };
  let digest1 = '';
  const first = await authorizeScriptSnapshot(context, { async isApproved(digest) {
    digest1 = digest; return true;
  } });
  assert.ok('executable' in first);
  if ('executable' in first) {
    assert.deepEqual(readFileSync(first.script), original);
    await first.dispose();
  }
  context.target = { key: 'different' };
  let digest2 = '';
  const changed = await authorizeScriptSnapshot(context, { async isApproved(digest) {
    digest2 = digest; return true;
  } });
  assert.ok('executable' in changed);
  if ('executable' in changed) await changed.dispose();
  assert.notEqual(digest1, digest2);
  const sourceDir = mkdtempSync(join(tmpdir(), 'nb-im-source-race-'));
  try {
    const mutable = join(sourceDir, 'notify.mjs');
    const replacement = join(sourceDir, 'replacement.mjs');
    copyFileSync(fileURLToPath(fixture), mutable);
    (context.instance.options.send as { command_argv: string[] }).command_argv[1] = mutable;
    let baseline = '';
    const before = await authorizeScriptSnapshot(context, { async isApproved(digest) {
      baseline = digest; return true;
    } });
    assert.ok('executable' in before);
    if ('executable' in before) await before.dispose();
    writeFileSync(replacement, 'console.log("different source");');
    renameSync(replacement, mutable);
    let afterDigest = '';
    const after = await authorizeScriptSnapshot(context, { async isApproved(digest) {
      afterDigest = digest; return true;
    } });
    assert.ok('executable' in after);
    if ('executable' in after) await after.dispose();
    assert.notEqual(baseline, afterDigest);
    const fakeExe = join(sourceDir, 'runtime.bin');
    writeFileSync(fakeExe, 'AAA');
    (context.instance.options.send as { command_argv: string[] }).command_argv[0] = fakeExe;
    const oldExe = await authorizeScriptSnapshot(context, { async isApproved() { return true; } });
    assert.ok('executable' in oldExe);
    if ('executable' in oldExe) assert.equal(readFileSync(oldExe.executable, 'utf8'), 'AAA');
    writeFileSync(fakeExe, 'BBB'); // same size; old size/mtime checks could miss this
    const newExe = await authorizeScriptSnapshot(context, { async isApproved() { return true; } });
    assert.ok('executable' in newExe);
    if ('executable' in oldExe && 'executable' in newExe) {
      assert.notEqual(oldExe.digest, newExe.digest);
      assert.equal(readFileSync(oldExe.executable, 'utf8'), 'AAA');
      assert.equal(readFileSync(newExe.executable, 'utf8'), 'BBB');
      await oldExe.dispose(); await newExe.dispose();
    }
  } finally { rmSync(sourceDir, { recursive: true, force: true }); }
  (context.instance.options.send as { command_argv: string[] }).command_argv =
    [fileURLToPath(fixture), fileURLToPath(fixture)];
  let release!: () => void; let waiting!: () => void; let allowed = true;
  const ready = new Promise<void>((resolve) => { waiting = resolve; });
  const pending = authorizeScriptSnapshot(context, { async isApproved() {
    waiting(); await new Promise<void>((resolve) => { release = resolve; }); return true;
  } });
  await ready; allowed = false; context.canDispatch = () => allowed ? 'ready' : 'stale';
  release();
  const denied = await pending;
  assert.equal('status' in denied && denied.diagnostic_code, 'dispatch_stale');
  let releaseAgain!: () => void; let waitingAgain!: () => void;
  const nextReady = new Promise<void>((resolve) => { waitingAgain = resolve; });
  allowed = true;
  context.canDispatch = () => allowed ? 'ready' : 'stale';
  const mutateTarget = authorizeScriptSnapshot(context, { async isApproved() {
    waitingAgain(); await new Promise<void>((resolve) => { releaseAgain = resolve; }); return true;
  } });
  await nextReady;
  context.target.key = 'changed-after-hash';
  allowed = false;
  releaseAgain();
  const refused = await mutateTarget;
  assert.equal('status' in refused && refused.diagnostic_code, 'dispatch_stale');
});
test('NBIM-05: script receipt drops free-form IDs and diagnostics even if they contain a secret', () => {
  const secret = TOKEN;
  const receipt = parseScriptReceipt({ protocol: 'nb-im-script/1', request_id: 'delivery-1',
    result: { status: 'accepted', message_ids: [secret], retryable: false,
      diagnostic_code: 'secret_token' } }, 'delivery-1');
  assert.deepEqual(receipt, { status: 'accepted', message_ids: [], retryable: false });
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(parseScriptReceipt({ protocol: 'nb-im-script/1', request_id: 'wrong',
    result: { status: 'accepted', message_ids: [secret], retryable: false } }, 'delivery-1'), null);
});
