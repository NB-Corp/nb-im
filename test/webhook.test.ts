import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createCredentialResolver, createSafeHttpTransport, Runtime,
  validateConfig, webhookProvider } from '../src/index.ts';
import type { Config, CredentialPurpose, OutboundHttpTransport, ResolvedRequest,
  WebhookProviderId } from '../src/index.ts';

const TOKEN = 'FAKE_WEBHOOK_TOKEN_SECRET_12345678';
const SECRET = 'FAKE_SIGNING_SECRET_12345678';
const ENV = { NBIM_TOKEN: TOKEN, NBIM_SECRET: SECRET, NBIM_AUTH: TOKEN, NBIM_PATH: 'hook' };
const input = (key: string) => ({ idempotency_key: key, channel_id: 'channel',
  category: 'question_pending' as const,
  expires_at: new Date(Date.now() + 60_000).toISOString() });
const createStore = () => { const dir = mkdtempSync(join(tmpdir(), 'nbim-webhook-'));
  return { path: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; };
function config(id: WebhookProviderId, options: Record<string, unknown>): Config {
  const uses: [unknown, string, CredentialPurpose][] = id === 'http' ?
    [[options.auth_slot, 'NBIM_AUTH', 'http_bearer'],
      [options.path_slot, 'NBIM_PATH', 'http_path']] : id === 'slack_webhook' ?
    [[options.path_slot, 'NBIM_TOKEN', 'slack_path']] :
    [[options.token_slot, 'NBIM_TOKEN', id === 'discord_webhook' ? 'discord_token' :
      id === 'dingtalk_webhook' ? 'dingtalk_token' : 'feishu_token'],
    [options.secret_slot, 'NBIM_SECRET', 'signing_secret']];
  const credential_slots: Config['credential_slots'] = {};
  for (const [slot, env, purpose] of uses) {
    if (typeof slot === 'string') credential_slots[slot] = {
      env, purpose, provider_id: id, provider_instance_id: 'provider',
    };
  }
  return { schema_version: '1', credential_slots,
    provider_instances: { provider: { provider_id: id, enabled: true, revision: 'v1', options } },
    channels: { channel: { provider_instance_id: 'provider', enabled: true,
      revision: 'v1', directions: ['send'], target: {} } } };
}
function runtime(cfg: Config, path: string, transport: OutboundHttpTransport,
  id: WebhookProviderId, now: () => number = Date.now) {
  return new Runtime(cfg, path, [webhookProvider(id, transport, now)],
    createCredentialResolver(cfg, ENV), () => 'account-one');
}

test('fixed webhook mappings use official endpoints, slot secrets and actual response semantics', async () => {
  const fixedNow = 1_700_000_000_000;
  const cases: { id: WebhookProviderId; options: Record<string, unknown>;
    host: string; path: string; response: { status: number; body: string };
    assertPayload(value: Record<string, unknown>): void }[] = [
    { id: 'discord_webhook', options: { webhook_id: '123456789012345678', token_slot: 'token' },
      host: 'discord.com', path: `/api/webhooks/123456789012345678/${TOKEN}`,
      response: { status: 204, body: '' },
      assertPayload(value) { assert.equal(value.content, 'Kiki 有一项问题等待回答，请返回应用查看。');
        assert.deepEqual(value.allowed_mentions, { parse: [] }); } },
    { id: 'slack_webhook', options: { path_slot: 'token' }, host: 'hooks.slack.com',
      path: `/services/TEAM1234/CHANNEL1234/${TOKEN}`,
      response: { status: 200, body: 'ok' },
      assertPayload(value) { assert.equal(value.text, 'Kiki 有一项问题等待回答，请返回应用查看。'); } },
    { id: 'dingtalk_webhook', options: { token_slot: 'token', secret_slot: 'secret',
      keyword: 'Kiki' }, host: 'oapi.dingtalk.com', path: '/robot/send',
      response: { status: 200, body: '{"errcode":0,"errmsg":"ok"}' },
      assertPayload(value) { assert.deepEqual(value, { msgtype: 'text', text: {
        content: 'Kiki Kiki 有一项问题等待回答，请返回应用查看。' } }); } },
    { id: 'feishu_webhook', options: { token_slot: 'token', secret_slot: 'secret' },
      host: 'open.feishu.cn', path: `/open-apis/bot/v2/hook/${TOKEN}`,
      response: { status: 200, body: '{"code":0,"msg":"success"}' },
      assertPayload(value) { assert.equal(value.msg_type, 'text');
        assert.deepEqual(value.content, { text: 'Kiki 有一项问题等待回答，请返回应用查看。' });
        assert.equal(value.timestamp, String(fixedNow / 1000));
        assert.equal(value.sign, createHmac('sha256', `${fixedNow / 1000}\n${SECRET}`)
          .update('').digest('base64')); } },
  ];
  for (const entry of cases) {
    const db = createStore(); const requests: ResolvedRequest[] = [];
    const urlSecret = entry.id === 'slack_webhook' ? 'TEAM1234/CHANNEL1234/' + TOKEN : TOKEN;
    const env = entry.id === 'slack_webhook' ? { ...ENV, NBIM_TOKEN: urlSecret } : ENV;
    const cfg = config(entry.id, entry.options);
    const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async (planned) => {
      requests.push(planned); return entry.response;
    });
    try {
      const lib = new Runtime(cfg, db.path, [webhookProvider(entry.id, transport, () => fixedNow)],
        createCredentialResolver(cfg, env), () => 'account-one');
      const delivery = lib.enqueue(input(entry.id));
      assert.equal((await lib.tick())?.status, 'accepted_by_provider', entry.id);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.url.protocol, 'https:');
      assert.equal(requests[0]!.url.hostname, entry.host);
      assert.equal(requests[0]!.url.pathname, entry.path);
      assert.equal(requests[0]!.ip, '8.8.8.8');
      entry.assertPayload(JSON.parse(requests[0]!.body));
      if (entry.id === 'dingtalk_webhook') {
        const query = requests[0]!.url.searchParams;
        assert.equal(query.get('access_token'), TOKEN);
        assert.equal(query.get('timestamp'), String(fixedNow));
        assert.equal(query.get('sign'), createHmac('sha256', SECRET)
          .update(`${fixedNow}\n${SECRET}`).digest('base64'));
      }
      assert.deepEqual(lib.get(delivery.delivery_id)?.result?.message_ids, []);
      lib.close();
      const bytes = readFileSync(db.path, 'utf8');
      assert.equal(bytes.includes(TOKEN) || bytes.includes(SECRET), false);
    } finally { db.cleanup(); }
  }
});

test('generic HTTP JSON/form/XML is fixed POST, escapes data and never replays errors', async () => {
  for (const format of ['json', 'form', 'xml'] as const) {
    const db = createStore(); const requests: ResolvedRequest[] = [];
    const cfg = config('http', { endpoint: 'https://example.org/', format,
      path_slot: 'path', auth_slot: 'auth' });
    const transport = createSafeHttpTransport(async () => ['8.8.4.4'], async (request) => {
      requests.push(request); return { status: 202, body: '{"success":false}' };
    });
    try {
      const lib = runtime(cfg, db.path, transport, 'http');
      const delivery = lib.enqueue(input(`http-${format}`));
      assert.equal((await lib.tick())?.status, 'accepted_by_provider');
      assert.equal(requests[0]!.url.href, 'https://example.org/hook');
      assert.equal(requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(requests[0]!.headers['content-length'], Buffer.byteLength(requests[0]!.body));
      if (format === 'json') assert.deepEqual(JSON.parse(requests[0]!.body),
        { text: 'Kiki 有一项问题等待回答，请返回应用查看。', category: 'question_pending' });
      if (format === 'form') assert.equal(new URLSearchParams(requests[0]!.body).get('category'),
        'question_pending');
      if (format === 'xml') assert.match(requests[0]!.body,
        /^<notification><text>.+<\/text><category>question_pending<\/category><\/notification>$/u);
      assert.equal(readFileSync(db.path, 'utf8').includes(TOKEN), false);
      assert.deepEqual(lib.get(delivery.delivery_id)?.result?.message_ids, []);
      lib.close();
    } finally { db.cleanup(); }
  }
});

test('generic HTTP XML escapes arbitrary message data and cannot inject tags', async () => {
  let encoded = '';
  const provider = webhookProvider('http', { async post(request, permit) {
    assert.equal(permit(), 'ready'); encoded = request.body;
    return { status: 204, body: '' };
  } });
  const result = await provider.send({ delivery_id: 'id', channel_id: 'channel',
    category: 'task_failed', text: '<secret>&"\'', idempotency_key: 'key',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    instance: { provider_id: 'http', enabled: true, revision: 'v1',
      options: { endpoint: 'https://example.org/', format: 'xml' } },
    target: {}, resolveCredential: () => TOKEN, canDispatch: () => 'ready',
    beginDispatch: () => 'ready' });
  assert.equal(result.status, 'accepted');
  assert.match(encoded, /<text>&lt;secret&gt;&amp;&quot;&apos;<\/text>/u);
});

test('HTTP connection guard rejects rebinding, private/IP literals, mixed DNS and redirects', async () => {
  const cfg = config('http', { endpoint: 'https://example.org/', format: 'json' });
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254',
    '100.64.0.1', '192.168.1.1', '192.88.99.1', '192.88.99.2',
    '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', '2001:db8::1',
    '3fff::1', '3fff:0fff::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::7f00:1', '2002:c0a8:0101::1']) {
    const db = createStore(); let connects = 0; let permits = 0;
    try {
      const transport = createSafeHttpTransport(async () => ['8.8.8.8', address],
        async () => { connects++; return { status: 204, body: '' }; });
      const guarded: OutboundHttpTransport = { post: (request, permit) =>
        transport.post(request, () => { permits++; return permit(); }) };
      const lib = runtime(cfg, db.path, guarded, 'http');
      const delivery = lib.enqueue(input(`unsafe-${address.replaceAll(':', '-')}`));
      const result = await lib.tick();
      assert.equal(result?.status, 'unknown', address);
      assert.equal(result?.result?.diagnostic_code, 'webhook_transport_unknown');
      assert.equal(connects, 0); assert.equal(permits, 0);
      assert.equal(lib.get(delivery.delivery_id)?.status, 'unknown');
      lib.close();
    } finally { db.cleanup(); }
  }
  const db = createStore(); let attempts = 0;
  try {
    const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async () => {
      attempts++; return { status: 302, body: 'redirect to http://127.0.0.1/' };
    });
    const lib = runtime(cfg, db.path, transport, 'http');
    assert.equal((await (lib.enqueue(input('redirect')), lib.tick()))?.status, 'unknown');
    assert.equal(attempts, 1); lib.close();
  } finally { db.cleanup(); }
});

test('NBIM-09: globally routable dual-stack answers remain eligible for pinned dispatch', async () => {
  for (const address of ['8.8.8.8', '2606:4700:4700::1111', '3fff:1000::1']) {
    const db = createStore(); let selected = '';
    try {
      const transport = createSafeHttpTransport(async () => [address], async (request) => {
        selected = request.ip;
        assert.equal(request.family, address.includes(':') ? 6 : 4);
        return { status: 204, body: '' };
      });
      const lib = runtime(config('http', { endpoint: 'https://example.org/',
        format: 'json' }), db.path, transport, 'http');
      lib.enqueue(input(`global-${address.replaceAll(':', '-')}`));
      assert.equal((await lib.tick())?.status, 'accepted_by_provider');
      assert.equal(selected, address);
      lib.close();
    } finally { db.cleanup(); }
  }
});

test('nonsecret HTTP grant pins protocol/host/IP/port without exposing path slots', async () => {
  const grant = { host: 'internal.example', ip: '10.4.0.2', port: 8080,
    protocol: 'http:' as const };
  const cfg = config('http', { endpoint: 'http://internal.example:8080/',
    format: 'xml', private_grant: grant });
  const db = createStore(); let attempts = 0;
  try {
    const transport = createSafeHttpTransport(async () => ['10.4.0.2'], async (planned) => {
      attempts++; assert.equal(planned.ip, grant.ip);
      assert.equal(planned.url.pathname, '/');
      return { status: 204, body: '' };
    });
    const lib = runtime(cfg, db.path, transport, 'http');
    lib.enqueue(input('granted'));
    assert.equal((await lib.tick())?.status, 'accepted_by_provider');
    assert.equal(attempts, 1); lib.close();
  } finally { db.cleanup(); }
  const otherDb = createStore();
  try {
    const transport = createSafeHttpTransport(async () => ['10.4.0.3'], async () => {
      throw new Error('unexpected connection');
    });
    const lib = runtime(cfg, otherDb.path, transport, 'http');
    lib.enqueue(input('rebinding'));
    assert.equal((await lib.tick())?.result?.diagnostic_code, 'webhook_transport_unknown');
    lib.close();
  } finally { otherDb.cleanup(); }
  for (const change of [{ ...grant, port: 80 },
    { ...grant, host: 'other.example' }, { ...grant, protocol: 'https:' as const }]) {
    assert.throws(() => validateConfig(config('http', { endpoint: 'http://internal.example:8080/',
      format: 'xml', private_grant: change })), /invalid_private_grant/u);
  }
  assert.throws(() => validateConfig(config('http', { endpoint: 'http://internal.example:8080/',
    format: 'json' })), /unsafe_endpoint/u);
});

test('config rejects embedded secrets, excluded providers, URLs with query and unsafe HTTP auth', () => {
  assert.throws(() => validateConfig(config('http', { endpoint: 'https://user:secret@example.org/hook',
    format: 'json' })), /unsafe_endpoint/u);
  assert.throws(() => validateConfig(config('http', { endpoint: 'https://example.org/hook?token=secret',
    format: 'json' })), /unsafe_endpoint/u);
  assert.throws(() => validateConfig(config('http', { endpoint: 'http://169.254.169.254/data',
    format: 'json' })), /unsafe_endpoint/u);
  assert.throws(() => validateConfig(config('http', { endpoint: 'https://localhost/hook',
    format: 'json' })), /unsafe_endpoint/u);
  assert.throws(() => validateConfig(config('http', { endpoint: 'http://127.0.0.1/hook',
    format: 'json', auth_slot: 'auth', private_grant: { host: '127.0.0.1', ip: '127.0.0.1',
      port: 80, protocol: 'http:' } })), /invalid_http_options/u);
  const forged = config('discord_webhook', { webhook_id: '123456789012345678',
    token_slot: 'token', token: TOKEN });
  assert.throws(() => validateConfig(forged), /unsupported_config_field/u);
  (forged.provider_instances.provider as unknown as { provider_id: string }).provider_id = 'ntfy';
  assert.throws(() => validateConfig(forged), /invalid_instance/u);
});

test('failed and unknown provider replies are sanitized and never auto-replayed', async () => {
  for (const [id, options, response, expected] of [
    ['slack_webhook', { path_slot: 'token' }, { status: 200, body: 'invalid_payload ' + TOKEN },
      'webhook_response_unknown'],
    ['dingtalk_webhook', { token_slot: 'token' },
      { status: 200, body: JSON.stringify({ errcode: 310000, errmsg: TOKEN }) },
      'webhook_rejected_unknown'],
    ['feishu_webhook', { token_slot: 'token' }, { status: 500, body: TOKEN },
      'webhook_response_unknown'],
    ['discord_webhook', { webhook_id: '123456789012345678', token_slot: 'token' },
      { status: 429, body: TOKEN }, 'webhook_rate_limited_unknown'],
    ['discord_webhook', { webhook_id: '123456789012345678', token_slot: 'token' },
      { status: 200, body: TOKEN }, 'webhook_response_unknown'],
  ] as const) {
    const db = createStore(); let sends = 0;
    const cfg = config(id, options);
    try {
      const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async () => {
        sends++; return response;
      });
      const env = id === 'slack_webhook' ? { ...ENV,
        NBIM_TOKEN: `TEAM1234/CHANNEL1234/${TOKEN}` } : ENV;
      const lib = new Runtime(cfg, db.path, [webhookProvider(id, transport)],
        createCredentialResolver(cfg, env), () => 'account-one');
      const delivery = lib.enqueue(input(`failure-${id}`));
      const result = await lib.tick();
      assert.equal(result?.status, 'unknown');
      assert.equal(result?.result?.diagnostic_code, expected);
      assert.equal(result?.result?.retryable, false);
      assert.equal(JSON.stringify(lib.get(delivery.delivery_id)).includes(TOKEN), false);
      assert.equal(readFileSync(db.path, 'utf8').includes(TOKEN), false);
      assert.equal(await lib.tick(), undefined); assert.equal(sends, 1);
      lib.close();
    } finally { db.cleanup(); }
  }
});

test('webhook 401 remains a typed, redacted terminal auth failure', async () => {
  const db = createStore(); const cfg = config('discord_webhook', {
    webhook_id: '123456789012345678', token_slot: 'token' });
  try {
    const transport = createSafeHttpTransport(async () => ['8.8.8.8'], async () =>
      ({ status: 401, body: TOKEN }));
    const lib = runtime(cfg, db.path, transport, 'discord_webhook');
    const delivery = lib.enqueue(input('unauthorized'));
    const result = await lib.tick();
    assert.equal(result?.status, 'failed');
    assert.equal(result?.result?.error_kind, 'auth');
    assert.equal(result?.result?.diagnostic_code, 'webhook_auth');
    assert.equal(JSON.stringify(lib.get(delivery.delivery_id)).includes(TOKEN), false);
    lib.close();
  } finally { db.cleanup(); }
});

test('cross-connection cancellation during async HTTP DNS prevents any external dispatch', async () => {
  const db = createStore(); const cfg = config('http', { endpoint: 'https://example.org/',
    format: 'json' }); let dnsStarted!: () => void; let release!: () => void; let sends = 0;
  const ready = new Promise<void>((resolve) => { dnsStarted = resolve; });
  const transport = createSafeHttpTransport(async () => {
    dnsStarted(); await new Promise<void>((resolve) => { release = resolve; });
    return ['8.8.8.8'];
  }, async () => { sends++; return { status: 204, body: '' }; });
  try {
    const lib = runtime(cfg, db.path, transport, 'http');
    const delivery = lib.enqueue(input('cancel-dns'));
    const pending = lib.tick(); await ready;
    const peer = runtime(cfg, db.path, transport, 'http');
    assert.equal(peer.cancel(delivery.delivery_id), true);
    release();
    assert.equal((await pending)?.status, 'cancelled');
    assert.equal(sends, 0);
    peer.close(); lib.close();
  } finally { db.cleanup(); }
});
