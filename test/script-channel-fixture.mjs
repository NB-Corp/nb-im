// nb-im-script/1 test channel. Mode is argv[2]; FIXTURE_STATE (env) is a scratch file shared across restarts.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const state = process.env.FIXTURE_STATE;
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const firstRun = () => {
  if (!state || existsSync(state)) return false;
  writeFileSync(state, 'started');
  return true;
};

for await (const raw of createInterface({ input: process.stdin })) {
  const line = JSON.parse(raw);
  if (line.type === 'hello') {
    if (mode === 'crash') {
      out({ type: 'ready', account_id: 'crash-bot' });
      // Replays m1 after the restart: a stable id must not be admitted twice.
      out({ type: 'message', id: 'm1', chat_id: 'c', sender_id: 'u', text: 'first', cursor: 'c1' });
      if (line.cursor) out({ type: 'message', id: 'm2', chat_id: 'c', sender_id: 'u', text: `resumed from ${line.cursor}`, cursor: 'c2' });
    } else if (mode === 'malformed') {
      process.stdout.write('not json\n[1,2]\nnull\n\n{"type":"message"}\n{"type":"mystery"}\n{"type":"message","id":"bad id","chat_id":"c","sender_id":"u","text":"x"}\n');
      out({ type: 'ready' });
      out({ type: 'message', id: 'ok-1', chat_id: 'c', sender_id: 'u', text: 'still works' });
    } else if (mode === 'overflow') {
      out({ type: 'ready' });
      if (firstRun()) {
        // An endless line without a newline: nb-im must cut it off instead of buffering it.
        process.stdout.write('{"type":"log","message":"');
        const chunk = 'x'.repeat(1024);
        setInterval(() => process.stdout.write(chunk), 5);
      } else out({ type: 'message', id: 'after-overflow', chat_id: 'c', sender_id: 'u', text: 'restarted' });
    } else if (mode === 'group') {
      // A helper that ignores stdin (and with "stubborn", SIGTERM): only the process-group kill can stop it.
      const body = `${process.argv[3] === 'stubborn' ? 'process.on("SIGTERM",()=>{});' : ''}` +
        'process.stdout.write("up\\n");setInterval(()=>{},1000)';
      const helper = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'ignore'] });
      out({ type: 'ready' });
      helper.stdout.once('data', () => out({ type: 'log', message: `pids ${process.pid} ${helper.pid}` }));
    }
  } else if (line.type === 'send') {
    if (mode === 'crash') process.exit(7); // dies with the send in flight: no receipt
    out({ type: 'receipt', id: line.id, status: 'accepted', message_ids: ['r1'] });
  }
}
