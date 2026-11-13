import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionRun } from '../src/session/loop.ts';
import type { SessionAdapter } from '../src/session/contract.ts';

const adapter: SessionAdapter = {
  platform: 'personal_wechat', instance_id: 'clock', account: { platform: 'personal_wechat', account_id: 'account' },
  limits: { text_characters: null, text_utf8_bytes: null, callback_data_bytes: null, voice_mime: null, image_bytes: null, file_bytes: null },
  state: 'idle', start: async () => undefined, stop: async () => undefined,
  send: async () => ({ status: 'accepted', message_ids: [] }),
};

test('retry uses a bounded increasing delay, a monotonic clock, success reset and abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const run = createSessionRun('clock', adapter);
  const controller = new AbortController();
  for (const [index, ms] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    let done = false;
    const pending = run.reconnect({ code: 'api_error', ret: -2 }, controller.signal).then(() => { done = true; });
    assert.equal(run.detail?.failure_count, index + 1);
    assert.equal(run.detail?.retry_in_ms, ms);
    t.mock.timers.setTime(Date.now() + 86_400_000);
    assert.equal(run.detail?.retry_in_ms, ms);
    clock += ms - 1;
    t.mock.timers.tick(ms - 1);
    await Promise.resolve();
    assert.equal(done, false);
    assert.equal(run.detail?.retry_in_ms, 1);
    clock += 1;
    t.mock.timers.tick(1);
    await pending;
    assert.equal(run.detail?.retry_in_ms, 0);
  }
  run.state = 'running';
  assert.equal(run.detail, undefined);
  const pending = run.reconnect({ code: 'transport_error' }, controller.signal);
  assert.equal(run.detail?.failure_count, 1);
  assert.equal(run.detail?.retry_in_ms, 1000);
  controller.abort();
  await pending;
});

test('stop before loop launch cannot start work, and loop failures are visible without error text', async () => {
  const stopped = createSessionRun('early-stop', adapter);
  let calls = 0;
  const ready = stopped.start(async () => { calls += 1; });
  await stopped.stop();
  await ready;
  assert.equal(calls, 0);
  assert.equal(stopped.state, 'stopped');
  const failed = createSessionRun('failed', adapter);
  await failed.start(async () => { throw new Error('private-payload'); });
  assert.equal(failed.state, 'stopped');
  assert.deepEqual(failed.detail, { code: 'loop_failed', retry_in_ms: undefined });
});
