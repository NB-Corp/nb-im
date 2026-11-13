import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createSafeHttpTransport } from '../src/index.ts';

test('default connector pins a local test socket, preserves Host and never follows redirects', async () => {
  let hits = 0; let host = ''; let peer = '';
  const server = createServer((request, response) => {
    hits++;
    host = request.headers.host ?? '';
    peer = request.socket.remoteAddress ?? '';
    request.resume();
    response.writeHead(302, { location: 'http://127.0.0.1:9/should-not-follow' });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const url = `http://fixture.invalid:${port}/`;
    let lookups = 0; let permits = 0;
    const transport = createSafeHttpTransport(async (name) => {
      lookups++; assert.equal(name, 'fixture.invalid'); return ['127.0.0.1'];
    });
    const response = await transport.post({ url, body: '{}', content_type: 'application/json',
      private_grant: { host: 'fixture.invalid', ip: '127.0.0.1', port,
        protocol: 'http:' } }, () => { permits++; return 'ready'; });
    assert.deepEqual(response, { status: 302, body: '' });
    assert.equal(lookups, 1); assert.equal(permits, 1); assert.equal(hits, 1);
    assert.equal(host, `fixture.invalid:${port}`);
    assert.equal(peer, '127.0.0.1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
