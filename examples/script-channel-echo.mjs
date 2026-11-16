#!/usr/bin/env node
// Minimal nb-im-script/1 custom channel: emits one greeting, echoes every send back as an inbound message.
// Run it via SessionSpec { platform: 'script', command: [process.execPath, '/abs/path/script-channel-echo.mjs'] }.
import { createInterface } from 'node:readline';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let n = 0;
// The loop ends when stdin closes (nb-im stopped or the host died), so the script exits with it.
for await (const raw of createInterface({ input: process.stdin })) {
  const line = JSON.parse(raw);
  if (line.type === 'hello') {
    out({ type: 'ready', account_id: 'echo-bot' });
    if (!line.cursor) {
      out({ type: 'message', id: 'hello-1', chat_id: 'room-1', chat_kind: 'group', chat_title: 'Echo room',
        sender_id: 'alice', sender_name: 'Alice', text: 'Hello from a script channel', timestamp: Date.now(),
        cursor: 'c1' });
    }
  } else if (line.type === 'send') {
    n += 1;
    const message = line.message;
    out({ type: 'receipt', id: line.id, status: 'accepted', message_ids: [`out-${n}`] });
    if (message.type === 'text') {
      out({ type: 'message', id: `echo-${n}`, chat_id: message.target.chat_id, sender_id: 'echo',
        sender_name: 'Echo', text: `echo: ${message.text}`, timestamp: Date.now(), cursor: `c${n + 1}` });
    }
  }
}
