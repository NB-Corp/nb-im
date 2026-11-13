import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionHub, Runtime, SESSION_CONTRACT } from '../src/index.ts';
import type { SessionCursorStore, TelegramBotTransport } from '../src/index.ts';
import { abortError } from '../src/session/contract.ts';

const SECRET = '555555:EEEEEEEEEEEEEEEEEEEE';
function memory(): SessionCursorStore {
  const values = new Map<string, string>();
  return { async load(scope) { return values.get(scope); }, async save(scope, cursor) { values.set(scope, cursor); } };
}
test('one token keeps one poller and release allows a new adapter', async () => {
  let updates = 0;
  const transport: TelegramBotTransport = {
    async call(request, signal) {
      if (request.method === 'getMe') return { http_status: 200, body: { ok: true, result: { id: 1 } } };
      if (request.method === 'getWebhookInfo') return { http_status: 200, body: { ok: true, result: { url: '' } } };
      updates += 1;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
    },
    async download() { return { ok: false }; },
  };
  const store = memory();
  const hub = createSessionHub({ store });
  const spec = { platform: 'telegram' as const, instance_id: 'hub.1', token: SECRET, transport, retry_ms: 0 };
  const first = hub.acquire(spec);
  const second = hub.acquire({ ...spec, instance_id: 'hub.2' });
  assert.equal(second, first);
  assert.equal(first.instance_id, 'hub.1');
  assert.equal(hub.find({ ...spec, instance_id: 'hub.9' }), first);
  await first.start({ async admit() { return { decision: 'accepted' }; } });
  await second.start({ async admit() { return { decision: 'accepted' }; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updates, 1);
  await hub.release(spec);
  assert.equal(first.state, 'stopped');
  const third = hub.acquire(spec);
  assert.notEqual(third, first);
  await third.stop();
  assert.throws(() => hub.acquire({ ...spec, instance_id: `bad ${SECRET}` }), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, 'invalid_instance_id');
    return true;
  });
  const qqA = hub.acquire({ platform: 'qq_onebot_v11', mode: 'forward', endpoint: 'ws://127.0.0.1:6700/',
    instance_id: 'qq.a', access_token: 'alpha-token-value', retry_ms: 0 });
  const qqB = hub.acquire({ platform: 'qq_onebot_v11', mode: 'forward', endpoint: 'ws://127.0.0.1:6700/',
    instance_id: 'qq.b', access_token: 'beta-token-value', retry_ms: 0 });
  assert.notEqual(qqA, qqB);
  await hub.release({ platform: 'qq_onebot_v11', mode: 'forward', endpoint: 'ws://127.0.0.1:6700/',
    instance_id: 'qq.a', access_token: 'alpha-token-value' });
  await hub.release({ platform: 'qq_onebot_v11', mode: 'forward', endpoint: 'ws://127.0.0.1:6700/',
    instance_id: 'qq.b', access_token: 'beta-token-value' });
  assert.equal(SESSION_CONTRACT, 'nb-im-session/1');
  assert.equal(typeof Runtime, 'function');
});
