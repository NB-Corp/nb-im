import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSessionHub } from '../src/session/hub.ts';
import { sessionFingerprint } from '../src/session/registry.ts';
import type { SessionInbound } from '../src/session/contract.ts';

const echo = fileURLToPath(new URL('../examples/script-channel-echo.mjs', import.meta.url));

function memoryStore() {
  const map = new Map<string, string>();
  return { map, async load(k: string) { return map.get(k); }, async save(k: string, v: string) { map.set(k, v); } };
}
async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v !== undefined) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
}

test('script channel admits inbound lines, sends, and receives receipts', async () => {
  const store = memoryStore();
  const hub = createSessionHub({ store });
  const spec = { platform: 'script', instance_id: 'conn_echo_1', command: [process.execPath, echo], retry_ms: 50 } as const;
  const adapter = hub.acquire(spec);
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  const first = await waitFor(() => got[0]);
  assert.equal(first.identity.chat_id, 'room-1');
  assert.equal(first.identity.chat_kind, 'group');
  assert.equal(first.identity.sender_name, 'Alice');
  assert.deepEqual(first.payload, { type: 'text', text: 'Hello from a script channel' });
  assert.equal(adapter.account.account_id, 'echo-bot');
  const receipt = await adapter.send({ type: 'text', target: { chat_id: 'room-1' }, text: 'ping' });
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(receipt.message_ids, ['out-1']);
  const echoed = await waitFor(() => got[1]);
  assert.deepEqual(echoed.payload, { type: 'text', text: 'echo: ping' });
  await waitFor(() => store.map.get('nb-im-session:conn_echo_1') === 'c2' ? true : undefined);
  await hub.release(spec);
  assert.equal(adapter.state, 'stopped');
});

test('script fingerprint covers command, cwd and env so hosts can enforce one binding per credential', () => {
  const a = { platform: 'script', instance_id: 'conn_a', command: [process.execPath, echo], env: { TOKEN: 'x' } } as const;
  assert.equal(sessionFingerprint(a), sessionFingerprint({ ...a, instance_id: 'conn_b' }));
  assert.notEqual(sessionFingerprint(a), sessionFingerprint({ ...a, env: { TOKEN: 'y' } }));
});

test('script that is not running fails sends honestly', async () => {
  const hub = createSessionHub({ store: memoryStore() });
  const adapter = hub.acquire({ platform: 'script', instance_id: 'conn_idle', command: [process.execPath, echo] });
  const receipt = await adapter.send({ type: 'text', target: { chat_id: 'x' }, text: 'hi' });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.diagnostic_code, 'script_not_running');
  await adapter.stop();
});

const fixture = fileURLToPath(new URL('./script-channel-fixture.mjs', import.meta.url));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function scratch(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'nb-im-script-')), name);
}

test('script crash: in-flight send resolves unknown, restart resumes from the last admitted cursor without re-admitting', async () => {
  const store = memoryStore();
  const hub = createSessionHub({ store });
  const logs: string[] = [];
  const spec = { platform: 'script', instance_id: 'conn_crash', command: [process.execPath, fixture, 'crash'],
    retry_ms: 20, on_log: (line: string) => logs.push(line) } as const;
  const adapter = hub.acquire(spec);
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  await waitFor(() => store.map.get('nb-im-session:conn_crash') === 'c1' ? true : undefined);
  const receipt = await adapter.send({ type: 'text', target: { chat_id: 'c' }, text: 'boom' });
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.diagnostic_code, 'script_exited');
  const resumed = await waitFor(() => got.find((e) => e.platform_event_id === 'm2'));
  assert.deepEqual(resumed.payload, { type: 'text', text: 'resumed from c1' });
  assert.deepEqual(got.map((e) => e.platform_event_id), ['m1', 'm2']);
  assert.ok(logs.some((l) => l.includes('exited with code 7')));
  await waitFor(() => adapter.state === 'running' ? true : undefined);
  await hub.release(spec);
});

test('script: malformed stdout lines are logged and ignored, later lines still work', async () => {
  const hub = createSessionHub({ store: memoryStore() });
  const logs: string[] = [];
  const spec = { platform: 'script', instance_id: 'conn_malformed', command: [process.execPath, fixture, 'malformed'],
    on_log: (line: string) => logs.push(line) } as const;
  const adapter = hub.acquire(spec);
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  const ok = await waitFor(() => got[0]);
  assert.equal(ok.platform_event_id, 'ok-1');
  assert.equal(got.length, 1);
  assert.ok(logs.includes('[stdout] not json'));
  assert.ok(logs.includes('[stdout] [1,2]'));
  assert.equal(logs.filter((l) => l === '[nb-im] dropped malformed message line').length, 2);
  assert.equal(adapter.state, 'running');
  await hub.release(spec);
});

test('script: a stdout line over max_line_bytes is cut off, logged, and the script restarted', async () => {
  const hub = createSessionHub({ store: memoryStore() });
  const logs: string[] = [];
  const spec = { platform: 'script', instance_id: 'conn_overflow', command: [process.execPath, fixture, 'overflow'],
    env: { FIXTURE_STATE: scratch('state') }, max_line_bytes: 16 * 1024, retry_ms: 20,
    on_log: (line: string) => logs.push(line) } as const;
  const adapter = hub.acquire(spec);
  const got: SessionInbound[] = [];
  await adapter.start({ async admit(event) { got.push(event); return { decision: 'accepted' }; } });
  const after = await waitFor(() => got[0]);
  assert.equal(after.platform_event_id, 'after-overflow');
  assert.ok(logs.includes(`[nb-im] script stdout line exceeded ${16 * 1024} bytes; restarting`));
  await hub.release(spec);
});

test('script stop kills the whole process group, including helpers that ignore SIGTERM', async () => {
  const hub = createSessionHub({ store: memoryStore() });
  let pids: number[] = [];
  const spec = { platform: 'script', instance_id: 'conn_group', command: [process.execPath, fixture, 'group', 'stubborn'],
    on_log: (line: string) => { if (line.startsWith('pids ')) pids = line.slice(5).split(' ').map(Number); } } as const;
  const adapter = hub.acquire(spec);
  await adapter.start({ async admit() { return { decision: 'accepted' }; } });
  await waitFor(() => pids.length === 2 ? true : undefined);
  assert.ok(pids.every(alive));
  await hub.release(spec);
  assert.equal(alive(pids[0]!), false);
  await waitFor(() => pids.every((pid) => !alive(pid)) ? true : undefined, 6000);
});

test('script group is signalled when the host process exits without stopping it', async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL('./script-host-exit-fixture.mjs', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  host.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const code = await new Promise((resolve) => host.once('close', resolve));
  assert.equal(code, 0);
  const pids = output.trim().replace(/^pids /, '').split(' ').map(Number);
  assert.equal(pids.length, 2);
  await waitFor(() => pids.every((pid) => !alive(pid)) ? true : undefined);
});
