// A host that starts a script channel and exits without stopping it. nb-im must not leave the group behind.
import { createSessionHub } from '../src/session/hub.ts';

const fixture = new URL('./script-channel-fixture.mjs', import.meta.url).pathname;
const hub = createSessionHub({ store: { async load() { return undefined; }, async save() {} } });
const adapter = hub.acquire({ platform: 'script', instance_id: 'host_exit', command: [process.execPath, fixture, 'group'],
  on_log(line) { if (line.startsWith('pids ')) { process.stdout.write(`${line}\n`); process.exit(0); } } });
await adapter.start({ async admit() { return { decision: 'accepted' }; } });
