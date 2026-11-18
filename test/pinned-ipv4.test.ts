import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { createServer, request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setDefaultAutoSelectFamily } from 'node:net';
import { test } from 'node:test';
import { createTelegramBotTransport } from '../src/session/telegram-http.ts';
import { downloadPlatformMedia } from '../src/session/media-http.ts';
import { createOneBotWsTransport } from '../src/session/onebot-ws.ts';
import { createWecomAibotTransport } from '../src/session/wecom-aibot.ts';
import { telegramHttps } from '../src/providers.ts';

await test('packaged Telegram poll, send, download and notification use Node 24 pinned IPv4', async (t) => {
  const seen: Array<[string | undefined, string | undefined]> = [];
  const server = createServer((req, res) => {
    seen.push([req.method, req.url]);
    req.resume();
    res.setHeader('connection', 'close');
    if (req.method === 'GET') res.end('fixture-file');
    else res.end('{"ok":true,"result":{"message_id":42}}');
  });
  await new Promise<void>((done, reject) => server.listen(0, '127.0.0.1', () => done()).once('error', reject));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  setDefaultAutoSelectFamily(true);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const publicIp = '149.154.167.220';
  t.mock.method(dns, 'resolve4', async (host: string) => {
    assert.equal(host, 'api.telegram.org');
    return [publicIp];
  });
  t.mock.method(https, 'request', (options: any, onResponse: any) => {
    assert.equal(options.hostname, 'api.telegram.org');
    assert.equal(options.port, 443);
    assert.equal(options.agent, false);
    return request({
      ...options, hostname: 'pinned.example.test', port,
      lookup: (_host: string, lookupOptions: any, done: any) => options.lookup(options.hostname, lookupOptions, (error: Error | null, addr: any, family?: number) => {
        if (error) return done(error);
        if (lookupOptions.all && Array.isArray(addr)) {
          assert.deepEqual(addr, [{ address: publicIp, family: 4 }]);
          return done(null, [{ address: '127.0.0.1', family: 4 }]);
        }
        assert.equal(addr, publicIp);
        assert.equal(family, 4);
        return done(null, '127.0.0.1', 4);
      }),
    }, onResponse);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const token = 'fixture-token';
  const transport = createTelegramBotTransport(token);
  const signal = AbortSignal.timeout(3000);
  assert.equal((await transport.call({ method: 'getUpdates' }, signal)).http_status, 200);
  assert.equal((await transport.call({ method: 'sendMessage', json: { text: 'fixture' } }, signal)).http_status, 200);
  const download = await transport.download('photos/a.jpg', signal);
  assert.equal(download.ok, true);
  assert.equal(Buffer.from(download.bytes).toString(), 'fixture-file');
  assert.equal((await telegramHttps.post(token, '{}', () => 'ready')).status, 200);
  assert.deepEqual(seen, [
    ['POST', '/botfixture-token/getUpdates'],
    ['POST', '/botfixture-token/sendMessage'],
    ['GET', '/file/botfixture-token/photos/a.jpg'],
    ['POST', '/botfixture-token/sendMessage'],
  ]);
});

await test('Discord/Slack, OneBot and WeCom media downloads pass explicit family under Node 24 autoSelectFamily', async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('connection', 'close');
    res.end(`ok:${req.url}`);
  });
  await new Promise<void>((done, reject) => server.listen(0, '127.0.0.1', () => done()).once('error', reject));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  setDefaultAutoSelectFamily(true);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const publicIp = '162.159.130.233';
  t.mock.method(dns, 'resolve4', async () => [publicIp]);
  t.mock.method(dns, 'resolve6', async () => []);
  t.mock.method(https, 'request', (options: any, onResponse: any) => {
    assert.equal(options.family, 4);
    return request({
      ...options, hostname: 'pinned.example.test', port,
      lookup: (_host: string, lookupOptions: any, done: any) => options.lookup(options.hostname, lookupOptions, (error: Error | null, addr: any, family?: number) => {
        if (error) return done(error);
        assert.equal(Boolean(lookupOptions.all), false);
        assert.equal(addr, publicIp);
        assert.equal(family, 4);
        return done(null, '127.0.0.1', 4);
      }),
    }, onResponse);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const signal = AbortSignal.timeout(3000);
  const discordBytes = await downloadPlatformMedia('https://cdn.discordapp.com/attachments/1/2/pic.png', { platform: 'discord', cap: 1024, signal });
  assert.equal(Buffer.from(discordBytes).toString(), 'ok:/attachments/1/2/pic.png');
  const onebot = await createOneBotWsTransport().download('https://media.example.test/img.jpg', signal);
  assert.equal(onebot.ok, true);
  if (onebot.ok) assert.equal(Buffer.from(onebot.bytes).toString(), 'ok:/img.jpg');
  const wecom = await createWecomAibotTransport().download('https://media.example.test/doc.pdf', 1024, signal);
  assert.equal(wecom.ok, true);
  if (wecom.ok) assert.equal(Buffer.from(wecom.bytes).toString(), 'ok:/doc.pdf');
});
