import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSlackManifest, slackManifestInstallUrl, discordInstallUrl, slackOAuthUrl,
  exchangeSlackOAuth, discoverMatrix, matrixSsoUrl, exchangeMatrixLogin, matrixPasswordLogin,
  SESSION_CAPABILITIES, SESSION_SETUP } from '../src/index.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('setup generates usable install URLs and credential schemas match declared capabilities', () => {
  const manifest = createSlackManifest();
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.ok(manifest.oauth_config.scopes.bot.includes('files:read'));
  assert.ok(manifest.oauth_config.scopes.bot.includes('files:write'));
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('message.im'));
  assert.deepEqual(JSON.parse(new URL(slackManifestInstallUrl()).searchParams.get('manifest')!), manifest);
  const discord = new URL(discordInstallUrl('123', '456'));
  assert.equal(discord.hostname, 'discord.com'); assert.equal(discord.searchParams.get('scope'), 'bot');
  assert.ok(BigInt(discord.searchParams.get('permissions')!) & (1n << 38n));
  assert.throws(() => discordInstallUrl('not-numeric'));
  assert.throws(() => slackOAuthUrl({ client_id: 'id', redirect_uri: 'http://remote.example', state: 'nonce-1234567890123456' }));
  for (const platform of ['discord', 'slack', 'matrix'] as const) {
    assert.equal(SESSION_CAPABILITIES[platform].outbound.includes('voice' as never), false);
    assert.equal(SESSION_CAPABILITIES[platform].voice_rendering, 'unsupported');
    assert.ok(SESSION_SETUP[platform].fields.some((f) => f.secret && f.required));
  }
  assert.equal(SESSION_CAPABILITIES.matrix.audio_rendering, 'm.audio');
});

test('Slack OAuth exchanges code with matching state and returns bot credentials, no real login', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(new URL(String(url)).pathname, '/api/oauth.v2.access');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_secret'), 'fixture-secret'); assert.equal(body.get('code'), 'one-use-code');
    return json({ ok: true, access_token: 'xoxb-returned-fixture', token_type: 'bot', bot_user_id: 'B1', team: { id: 'T1' } });
  };
  const input = { client_id: 'id', client_secret: 'fixture-secret', code: 'one-use-code', redirect_uri: 'http://127.0.0.1:4567/callback',
    state: '1234567890abcdef', expected_state: '1234567890abcdef' };
  try {
    await assert.rejects(exchangeSlackOAuth({ ...input, state: 'wrong-state' }), /oauth_state_mismatch/); assert.equal(calls, 0);
    const credentials = await exchangeSlackOAuth(input);
    assert.deepEqual(credentials, { bot_token: 'xoxb-returned-fixture', account_id: 'B1', team_id: 'T1' });
  } finally { globalThis.fetch = original; }
});

test('Matrix .well-known discovery, SSO token exchange and password flow return SessionSpec fields', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (String(url).endsWith('/.well-known/matrix/client')) return json({ 'm.homeserver': { base_url: 'https://hs.example/' } });
    if (init?.method === 'POST') return json({ access_token: 'matrix-fixture', user_id: '@bot:example', device_id: 'D1' });
    return json({ flows: [{ type: 'm.login.sso' }, { type: 'm.login.token' }, { type: 'm.login.password' }] });
  };
  const discovery = await discoverMatrix('@bot:example', undefined, fetcher);
  assert.equal(discovery.homeserver, 'https://hs.example'); assert.equal(discovery.sso, true);
  const sso = new URL(matrixSsoUrl(discovery.homeserver, 'http://127.0.0.1:4567/callback?attempt=fixture'));
  assert.equal(sso.searchParams.get('redirectUrl'), 'http://127.0.0.1:4567/callback?attempt=fixture');
  const result = await exchangeMatrixLogin({ homeserver: discovery.homeserver, login_token: 'one-use-token' }, undefined, fetcher);
  assert.deepEqual(result, { homeserver: 'https://hs.example', access_token: 'matrix-fixture', account_id: '@bot:example', device_id: 'D1' });
  assert.equal(requests[2]!.body.type, 'm.login.token');
  await matrixPasswordLogin({ homeserver: discovery.homeserver, user: '@bot:example', password: 'fixture-password' }, undefined, fetcher);
  assert.equal(requests[3]!.body.type, 'm.login.password');
  assert.deepEqual(requests[3]!.body.identifier, { type: 'm.id.user', user: '@bot:example' });
});
