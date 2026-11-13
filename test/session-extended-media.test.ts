import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionHub } from '../src/index.ts';
import type { SessionSpec } from '../src/index.ts';

test('new audio/video kinds do not silently fall through old adapters as image/file', async () => {
  const hub = createSessionHub({ store: { async load() { return undefined; }, async save() {} } });
  const specs: SessionSpec[] = [
    { platform: 'telegram', instance_id: 'old-tg', token: '12345:abcdefghijklmnopqrstuvwxyz' },
    { platform: 'feishu_app', instance_id: 'old-feishu', app_id: 'cli_fixture', app_secret: 'fixture' },
    { platform: 'qq_onebot_v11', instance_id: 'old-onebot', mode: 'forward', endpoint: 'ws://127.0.0.1:1' },
    { platform: 'personal_wechat', instance_id: 'old-wechat', token: 'fixture' },
  ];
  for (const spec of specs) {
    const adapter = hub.acquire(spec);
    const unsupportedKinds = spec.platform === 'feishu_app' ? (['audio'] as const) : (['audio', 'video'] as const);
    for (const kind of unsupportedKinds) {
      const receipt = await adapter.send({ type: 'media', target: { chat_id: '123', chat_kind: 'private' },
        media: { kind, filename: 'clip', mime: kind === 'audio' ? 'audio/mpeg' : 'video/mp4', bytes: new Uint8Array([1]) } });
      assert.equal(receipt.error_kind, 'unsupported'); assert.match(receipt.diagnostic_code!, /unsupported_media_kind/);
    }
    await adapter.stop();
  }
});
