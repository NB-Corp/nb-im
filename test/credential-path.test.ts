import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCredentialResolver, createSafeHttpTransport, Runtime,
  validateConfig, webhookProvider } from '../src/index.ts';
import type { Config, CredentialScope, Provider, ResolvedRequest } from '../src/index.ts';

const BEARER = 'FAKE_HTTP_BEARER_SECRET_0123456789';
const BOT = '987:EXAMPLE_TOKEN_WITHOUT_REAL_CREDENTIAL';
const PATH = 'incoming/FAKE_PATH_TOKEN_SECRET_0123456789';
const request = (key: string) => ({ idempotency_key: key, channel_id: 'notify',
  category: 'work_complete' as const, expires_at: new Date(Date.now() + 60_000).toISOString() });
const config = (): Config => ({ schema_version: '1',
  provider_instances: {
    generic: { provider_id: 'http', enabled: true, revision: 'v1',
      options: { endpoint: 'https://example.org/', format: 'json', auth_slot: 'auth',
        path_slot: 'route' } },
    second: { provider_id: 'http', enabled: true, revision: 'v1',
      options: { endpoint: 'https://second.example/', format: 'form', auth_slot: 'secondAuth' } },
    telegram: { provider_id: 'telegram', enabled: true, revision: 'v1',
      options: { token_slot: 'bot' } },
  },
  channels: { notify: { provider_instance_id: 'generic', enabled: true,
    revision: 'v1', target: {}, directions: ['send'] } },
  credential_slots: {
    auth: { env: 'NBIM_AUTH', provider_id: 'http', provider_instance_id: 'generic',
      purpose: 'http_bearer' },
    route: { env: 'NBIM_ROUTE', provider_id: 'http', provider_instance_id: 'generic',
      purpose: 'http_path' },
    secondAuth: { env: 'NBIM_SECOND_AUTH', provider_id: 'http',
      provider_instance_id: 'second', purpose: 'http_bearer' },
    bot: { env: 'NBIM_BOT', provider_id: 'telegram', provider_instance_id: 'telegram',
      purpose: 'telegram_bot' },
  },
});
const env = { NBIM_AUTH: BEARER, NBIM_ROUTE: PATH, NBIM_BOT: BOT,
  NBIM_SECOND_AUTH: 'FAKE_OTHER_SECRET_0123456789' };
function store() { const dir = mkdtempSync(join(tmpdir(), 'nb-im-credential-scope-'));
  return { path: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }

test('NBIM-07: cross-provider, cross-instance and wrong-purpose slot borrowing fails before resolver', async () => {
  const cfg = config(); validateConfig(cfg);
  const resolver = createCredentialResolver(cfg, env);
  for (const scope of [
    { provider_id: 'http', provider_instance_id: 'generic', purpose: 'http_bearer' },
    { provider_id: 'telegram', provider_instance_id: 'generic', purpose: 'telegram_bot' },
    { provider_id: 'telegram', provider_instance_id: 'telegram', purpose: 'http_bearer' },
  ] as CredentialScope[]) {
    assert.throws(() => resolver('bot', scope), /credential_scope_violation/u);
  }
  assert.throws(() => resolver('route', { provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' }), /credential_scope_violation/u);
  assert.throws(() => resolver('secondAuth', { provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' }), /credential_scope_violation/u);
  assert.equal(resolver('auth', { provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' }), BEARER);
  assert.equal(resolver('route', { provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_path' }), PATH);
  cfg.provider_instances.generic!.options.auth_slot = 'secondAuth';
  delete cfg.credential_slots.auth;
  assert.throws(() => validateConfig(cfg), /credential_scope_violation/u);
  cfg.provider_instances.generic!.options.auth_slot = 'auth';
  cfg.credential_slots.auth = { env: 'NBIM_AUTH', provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' };
  cfg.provider_instances.generic!.options.auth_slot = 'bot';
  delete cfg.credential_slots.auth;
  assert.throws(() => validateConfig(cfg), /credential_scope_violation/u);
  cfg.provider_instances.generic!.options.auth_slot = 'auth';
  cfg.credential_slots.auth = { env: 'NBIM_AUTH', provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' };
  cfg.provider_instances.generic!.options.auth_slot = 'route';
  delete cfg.credential_slots.auth;
  assert.throws(() => validateConfig(cfg), /credential_scope_violation|invalid_credential_slot/u);
  cfg.provider_instances.generic!.options.auth_slot = 'auth';
  cfg.credential_slots.auth = { env: 'NBIM_AUTH', provider_id: 'http',
    provider_instance_id: 'generic', purpose: 'http_bearer' };
  const db = store(); let hostReads = 0;
  const malicious: Provider = { id: 'http', async send(context) {
    assert.throws(() => context.resolveCredential('bot'), /credential_scope_violation/u);
    assert.throws(() => context.resolveCredential('secondAuth'), /credential_scope_violation/u);
    assert.throws(() => context.resolveCredential('unknown-slot'), /credential_scope_violation/u);
    return { status: 'failed', message_ids: [], retryable: false,
      error_kind: 'configuration', diagnostic_code: 'webhook_configuration' };
  } };
  try {
    const lib = new Runtime(cfg, db.path, [malicious], (slot, scope) => {
      hostReads++; return resolver(slot, scope);
    }, () => 'epoch-one');
    lib.enqueue(request('borrowed-slot'));
    const result = await lib.tick();
    assert.equal(result?.status, 'failed');
    assert.equal(hostReads, 0);
    lib.close();
  } finally { db.cleanup(); }
});

test('NBIM-07: slot rebinding after enqueue fails closed before credential read or HTTP', async () => {
  const cfg = config(); const db = store(); let reads = 0; let sends = 0;
  try {
    const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async () => {
      sends++; return { status: 204, body: '' };
    });
    const resolver = createCredentialResolver(cfg, env);
    const lib = new Runtime(cfg, db.path, [webhookProvider('http', transport)],
      (slot, scope) => { reads++; return resolver(slot, scope); }, () => 'epoch-one');
    const queued = lib.enqueue(request('rebind-after-enqueue'));
    cfg.credential_slots.auth!.provider_instance_id = 'second';
    assert.equal((await lib.tick())?.result?.diagnostic_code, 'dispatch_stale');
    assert.equal(lib.get(queued.delivery_id)?.status, 'failed');
    assert.equal(reads, 0); assert.equal(sends, 0);
    lib.close();
  } finally { db.cleanup(); }
});

test('NBIM-08: typical webhook token path lives only in scoped secret slot, never canonical config/outbox', async () => {
  const cfg = config(); validateConfig(cfg);
  assert.equal(JSON.stringify(cfg).includes(PATH), false);
  const db = store(); const requests: ResolvedRequest[] = [];
  try {
    const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async (planned) => {
      requests.push(planned); return { status: 204, body: '' };
    });
    const lib = new Runtime(cfg, db.path, [webhookProvider('http', transport)],
      createCredentialResolver(cfg, env), () => 'epoch-one');
    const delivery = lib.enqueue(request('secret-in-path'));
    assert.equal((await lib.tick())?.status, 'accepted_by_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url.pathname, '/' + PATH);
    assert.equal(requests[0]!.headers.authorization, 'Bearer ' + BEARER);
    assert.deepEqual(lib.get(delivery.delivery_id)?.result?.message_ids, []);
    lib.close();
    const bytes = readFileSync(db.path, 'utf8');
    assert.equal(bytes.includes(PATH) || bytes.includes(BEARER) || bytes.includes(BOT), false);
  } finally { db.cleanup(); }
  for (const suffix of ['/incoming/' + PATH.split('/')[1], '/public-route']) {
    const bad = config(); bad.provider_instances.generic!.options.endpoint = 'https://example.org' + suffix;
    assert.throws(() => validateConfig(bad), /invalid_http_options/u);
  }
  const bad = config(); bad.provider_instances.generic!.options.path_slot = 'auth';
  delete bad.credential_slots.route;
  assert.throws(() => validateConfig(bad), /credential_scope_violation/u);
});

test('NBIM-08: exact HTTP grant cannot expose a secret path slot over cleartext', async () => {
  const cfg = config();
  const options = cfg.provider_instances.generic!.options;
  options.endpoint = 'http://internal.example:8080/';
  options.private_grant = { host: 'internal.example', ip: '10.4.0.2',
    port: 8080, protocol: 'http:' };
  delete options.auth_slot;
  delete cfg.credential_slots.auth;
  assert.throws(() => validateConfig(cfg), /invalid_http_options/u);
  let posts = 0; let permits = 0; let reads = 0;
  const result = await webhookProvider('http', { async post() {
    posts++; return { status: 204, body: '' };
  } }).send({ delivery_id: 'offline', channel_id: 'notify',
    category: 'work_complete', text: 'fixed', idempotency_key: 'offline',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    instance: cfg.provider_instances.generic!, target: {},
    canDispatch: () => 'ready',
    beginDispatch: () => { permits++; return 'ready'; },
    resolveCredential: () => { reads++; return PATH; } });
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnostic_code, 'webhook_configuration');
  assert.equal(posts, 0); assert.equal(permits, 0); assert.equal(reads, 0);
});
