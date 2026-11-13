let input = '';
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (process.argv[2] === 'timeout') { setTimeout(() => {}, 10_000); await new Promise(() => {}); }
if (process.argv[2] === 'empty') process.exit(0);
if (process.argv[2] === 'nonzero') { console.log(JSON.stringify({ protocol: request.protocol,
  request_id: request.request_id, result: { status: 'accepted', message_ids: [], retryable: false } }));
  process.exit(3); }
if (process.argv[2] === 'large') { console.log('x'.repeat(70_000)); process.exit(0); }
if (process.argv[2] === 'secret') { console.log(process.env.NBIM_SECRET_TOKEN); process.exit(0); }
console.log(JSON.stringify({ protocol: request.protocol,
  request_id: process.argv[2] === 'forged' ? 'forged-id' : request.request_id,
  result: { status: 'accepted', message_ids: ['external-1'], retryable: false } }));
