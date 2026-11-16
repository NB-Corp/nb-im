import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { SessionAdapter, SessionCursorStore, SessionErrorKind, SessionInbound, SessionInboundPart,
  SessionMediaKind, SessionOutbound, SessionReceipt, SessionSpec } from './contract.ts';
import { accepted, cursorScope, delay, failed, sessionReceipt, unknownReceipt } from './contract.ts';
import { createSessionRun } from './loop.ts';
import { sessionFingerprint, shareSession } from './registry.ts';

/**
 * Custom channels as a child process speaking JSON lines (UTF-8, one object per `\n`-terminated line) over stdio.
 * README.md "Custom channels (script)" documents every field.
 *
 * script -> nb-im (stdout):
 *   {"type":"ready","account_id":"my-bot"}                      required once per process, after hello
 *   {"type":"message","id":"evt-1","chat_id":"room-1","sender_id":"alice","text":"hi","cursor":"...", ...}
 *   {"type":"receipt","id":"<send id>","status":"accepted"|"failed"|"unknown","message_ids":["m-9"]}
 *   {"type":"error","code":"auth_expired"|"conflict","message":"..."}
 *   {"type":"log","message":"..."}
 * nb-im -> script (stdin):
 *   {"type":"hello","protocol":"nb-im-script/1","instance_id":"...","cursor":null|"<last admitted cursor>"}
 *   {"type":"admitted","id":"evt-1"}
 *   {"type":"send","id":"<send id>","message":{...SessionOutbound, media.bytes -> media.data base64}}
 * stderr is forwarded line by line to `on_log`.
 *
 * Lifecycle: the script runs as the leader of its own process group (POSIX). Stop closes its stdin, then sends
 * SIGTERM to the whole group and SIGKILL 3 s later; the group is also signalled whenever the leader exits, so
 * helpers it spawned do not survive a crash or restart. The script MUST exit when stdin reaches EOF: that is the
 * only signal it gets if the host process itself dies. Message `id` MUST be stable across restarts (it forms
 * `event_key`), and a stdout line longer than `max_line_bytes` kills and restarts the script.
 */
export const SCRIPT_PROTOCOL = 'nb-im-script/1' as const;
export const SCRIPT_TEXT_CHARACTERS = 100_000;
export const SCRIPT_MEDIA_BYTES = 25 * 1024 * 1024;
/** Default stdout line cap. Fits one maximum-size base64 attachment plus metadata. */
export const SCRIPT_LINE_BYTES = 40 * 1024 * 1024;
const STDERR_LINE_BYTES = 64 * 1024;
const LOG_CHARACTERS = 4000;
const KILL_GRACE_MS = 3000;
const SEND_TIMEOUT_MS = 30_000;
const RECENT_CAP = 512;
const QUEUE_HIGH = 64;
const QUEUE_LOW = 8;
const ID = /^[A-Za-z0-9_.$=+/:~@#-]{1,255}$/;
const KINDS = new Set<SessionMediaKind>(['image', 'file', 'voice', 'audio', 'video']);
const ERROR_KINDS = new Set<SessionErrorKind>(['auth', 'forbidden', 'not_found', 'conflict', 'rate_limited',
  'too_long', 'bad_format', 'unsupported', 'cancelled', 'configuration', 'unknown']);
const GROUPS = process.platform !== 'win32';

export type ScriptSessionSpec = Extract<SessionSpec, { platform: 'script' }>;

// Process groups that may still have members. On host exit they are signalled synchronously (best effort);
// a hard host kill is covered by the script's own stdin-EOF exit.
const liveGroups = new Map<number, 'running' | 'terminating'>();
let exitHooked = false;
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(GROUPS ? -pid : pid, signal); } catch { /* group already gone */ }
}
function trackGroup(pid: number): void {
  liveGroups.set(pid, 'running');
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const [group, phase] of liveGroups) signalGroup(group, phase === 'terminating' ? 'SIGKILL' : 'SIGTERM');
  });
}
/** Splits a byte stream on `\n` without ever holding more than `max` bytes of one line. */
function splitLines(input: Readable, max: number, onLine: (line: string) => void,
  onOverflow: (prefix: string) => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  const flush = (): void => {
    const line = Buffer.concat(parts, size).toString('utf8');
    parts = []; size = 0;
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  input.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!skipping) {
        if (size + end - start > max) {
          const prefix = Buffer.concat([...parts, chunk.subarray(start, end)]).subarray(0, LOG_CHARACTERS).toString('utf8');
          parts = []; size = 0; skipping = true;
          onOverflow(prefix);
        } else if (end > start) { parts.push(chunk.subarray(start, end)); size += end - start; }
      }
      if (newline === -1) break;
      if (skipping) skipping = false;
      else flush();
      start = newline + 1;
    }
  });
  input.on('end', () => { if (!skipping && size > 0) flush(); });
  input.on('error', () => undefined);
}

function str(value: unknown, max = 255): string {
  return typeof value === 'string' && value.length <= max ? value : '';
}
function mediaOf(value: unknown): { kind: SessionMediaKind; filename: string; mime: string; bytes: Uint8Array } | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const kind = KINDS.has(m.kind as SessionMediaKind) ? m.kind as SessionMediaKind : 'file';
  if (typeof m.data !== 'string') return null;
  const bytes = Buffer.from(m.data, 'base64');
  if (!bytes.byteLength || bytes.byteLength > SCRIPT_MEDIA_BYTES) return null;
  return { kind, filename: str(m.filename) || 'attachment', mime: str(m.mime) || 'application/octet-stream',
    bytes: new Uint8Array(bytes) };
}
function inboundOf(spec: ScriptSessionSpec, accountId: string, line: Record<string, unknown>): SessionInbound | null {
  const id = str(line.id);
  const chat = str(line.chat_id);
  const sender = str(line.sender_id);
  if (!ID.test(id) || !chat || !sender) return null;
  const text = typeof line.text === 'string' ? line.text.slice(0, SCRIPT_TEXT_CHARACTERS) : '';
  const media = (Array.isArray(line.media) ? line.media : []).map(mediaOf).filter((m) => m !== null);
  const op = line.op === 'edit' || line.op === 'retract' ? line.op : 'create';
  let payload: SessionInbound['payload'];
  if (media.length === 0) payload = { type: 'text', text };
  else if (media.length === 1) payload = { type: 'media', media: media[0]!, ...(text ? { caption: text } : {}) };
  else {
    const parts: SessionInboundPart[] = text ? [{ type: 'text', text }] : [];
    for (const m of media) parts.push({ type: 'media', media: m });
    payload = { type: 'parts', parts };
  }
  if (op === 'create' && !text && media.length === 0) return null;
  const chatKind = line.chat_kind === 'group' ? 'group' : line.chat_kind === 'private' ? 'private' : undefined;
  const timestamp = typeof line.timestamp === 'number' && Number.isSafeInteger(line.timestamp) ? line.timestamp : undefined;
  const mentionIds = Array.isArray(line.mention_ids) ?
    [...new Set(line.mention_ids.map((m) => str(m)).filter(Boolean))].slice(0, 100) : [];
  return {
    event_key: `script:${spec.instance_id}:${id}`, platform_event_id: id,
    identity: { platform: 'script', account_id: accountId, chat_id: chat, sender_id: sender,
      topic_id: str(line.topic_id) || '0',
      ...(chatKind ? { chat_kind: chatKind } : {}),
      ...(str(line.chat_title, 512) ? { chat_title: str(line.chat_title, 512) } : {}),
      ...(str(line.sender_name, 512) ? { sender_name: str(line.sender_name, 512) } : {}),
      ...(str(line.topic_title, 512) ? { topic_title: str(line.topic_title, 512) } : {}) },
    payload, source_message_id: str(line.message_id) || id, operation: op,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(line.mentioned === true ? { mentioned: true } : {}),
    ...(mentionIds.length ? { mention_ids: mentionIds } : {}),
    ...(str(line.reply_to) ? { reply_to_message_id: str(line.reply_to) } : {}),
    ...(typeof line.quoted_text === 'string' ? { quoted_text: line.quoted_text.slice(0, 4000) } : {}),
    ...(line.is_self === true ? { is_self: true } : {}),
    reply_context: str(line.reply_context, 1024) || id,
    cursor: str(line.cursor, 4096) || id,
  };
}
function encodeOutbound(message: SessionOutbound): Record<string, unknown> {
  if (message.type !== 'media') return { ...message };
  const { bytes, ...rest } = message.media;
  return { ...message, media: { ...rest, data: Buffer.from(bytes).toString('base64') } };
}
function childEnv(spec: ScriptSessionSpec): NodeJS.ProcessEnv {
  // Scripts get a minimal environment plus what the host passes explicitly; host secrets never leak in.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...(spec.env ?? {}), NB_IM_PROTOCOL: SCRIPT_PROTOCOL, NB_IM_INSTANCE_ID: spec.instance_id };
}
function writeLine(proc: ChildProcess, value: unknown): boolean {
  const stdin = proc.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return false;
  stdin.write(`${JSON.stringify(value)}\n`);
  return true;
}

export function createScriptSessionAdapter(spec: ScriptSessionSpec, store: SessionCursorStore): SessionAdapter {
  const key = sessionFingerprint(spec);
  return shareSession(key, () => {
    const scope = cursorScope(spec.instance_id);
    const maxLine = spec.max_line_bytes !== undefined && Number.isSafeInteger(spec.max_line_bytes) &&
      spec.max_line_bytes > 0 ? spec.max_line_bytes : SCRIPT_LINE_BYTES;
    let accountId = spec.instance_id;
    // The live process that accepts sends. Cleared as soon as it exits so no send targets a dead pipe.
    let child: ChildProcess | undefined;
    let seq = 0;
    const pending = new Map<string, (receipt: SessionReceipt) => void>();
    let liveSignal: AbortSignal | undefined;
    const settleAll = (receipt: SessionReceipt): void => {
      for (const resolve of pending.values()) resolve(receipt);
      pending.clear();
    };
    const log = (line: string): void => { try { spec.on_log?.(line.slice(0, LOG_CHARACTERS)); } catch { /* host logger */ } };
    const adapter: SessionAdapter = {
      platform: 'script', instance_id: spec.instance_id,
      get account() { return { platform: 'script' as const, account_id: accountId }; },
      limits: { text_characters: SCRIPT_TEXT_CHARACTERS, text_utf8_bytes: null, callback_data_bytes: null,
        voice_mime: null, image_bytes: SCRIPT_MEDIA_BYTES, file_bytes: SCRIPT_MEDIA_BYTES },
      get state() { return run.state; }, get connection_detail() { return run.detail; },
      start: (sink) => run.start(async (signal) => {
        liveSignal = signal;
        let recent: string[] = [];
        try {
          const saved = await store.load(`${scope}:recent`);
          const parsed: unknown = saved ? JSON.parse(saved) : [];
          if (Array.isArray(parsed)) recent = parsed.filter((s): s is string => typeof s === 'string').slice(-RECENT_CAP);
        } catch { /* invalid dedup state starts fresh */ }
        while (!signal.aborted) {
          const [command, ...args] = spec.command;
          if (!command) { run.state = 'auth_expired'; run.detail = { code: 'loop_failed' }; return; }
          const cursor = await store.load(scope);
          if (signal.aborted) return;
          const proc = spawn(command, args, { cwd: spec.cwd, env: childEnv(spec), stdio: ['pipe', 'pipe', 'pipe'],
            detached: GROUPS });
          const pid = proc.pid;
          if (pid !== undefined) trackGroup(pid);
          child = proc;
          let ending = false;
          // Close stdin, then SIGTERM the whole group, then SIGKILL whatever is left after the grace period.
          const end = (): void => {
            if (ending) return;
            ending = true;
            try { proc.stdin?.end(); } catch { /* already closed */ }
            if (pid === undefined) return;
            liveGroups.set(pid, 'terminating');
            signalGroup(pid, 'SIGTERM');
            setTimeout(() => { signalGroup(pid, 'SIGKILL'); liveGroups.delete(pid); }, KILL_GRACE_MS).unref();
          };
          const closed = new Promise<number | null>((resolve) => {
            proc.once('close', (code) => resolve(code));
            proc.once('error', () => { if (proc.pid === undefined) resolve(-1); });
          });
          proc.once('exit', () => {
            if (child === proc) child = undefined;
            end(); // reap helpers the leader left behind
          });
          proc.stdin.on('error', () => undefined);
          splitLines(proc.stderr, STDERR_LINE_BYTES, (line) => log(line), (prefix) => log(`${prefix} [truncated]`));
          let queued = 0;
          let chain: Promise<void> = Promise.resolve();
          let fatal: 'auth_expired' | 'conflict' | undefined;
          let overflowed = false;
          signal.addEventListener('abort', end, { once: true });
          writeLine(proc, { type: 'hello', protocol: SCRIPT_PROTOCOL, instance_id: spec.instance_id, cursor: cursor ?? null });
          const onLine = (raw: string): void => {
            // Lines still buffered after exit/stop are read too: late receipts must not be lost.
            if (!raw.trim()) return;
            let line: Record<string, unknown>;
            try {
              const parsed: unknown = JSON.parse(raw);
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                log(`[stdout] ${raw}`);
                return;
              }
              line = parsed as Record<string, unknown>;
            } catch { log(`[stdout] ${raw}`); return; }
            if (line.type === 'ready') {
              if (str(line.account_id)) accountId = str(line.account_id);
              run.state = 'running';
            } else if (line.type === 'receipt') {
              const id = str(line.id);
              const resolve = pending.get(id);
              if (!resolve) return;
              pending.delete(id);
              const kind = ERROR_KINDS.has(line.error_kind as SessionErrorKind) ? line.error_kind as SessionErrorKind : 'unknown';
              const ids = Array.isArray(line.message_ids) ? line.message_ids.filter((m): m is string => typeof m === 'string') : [];
              resolve(line.status === 'accepted' ? accepted(ids) :
                line.status === 'failed' ? failed(kind, str(line.code, 64) || 'script_send_failed', { message_ids: ids }) :
                sessionReceipt({ status: 'unknown', message_ids: ids, error_kind: 'unknown', diagnostic_code: 'script_send_unknown' }));
            } else if (line.type === 'error') {
              if (line.code === 'auth_expired' || line.code === 'conflict') { fatal = line.code; end(); }
              log(`[error] ${str(line.message, LOG_CHARACTERS)}`);
            } else if (line.type === 'log') {
              log(str(line.message, LOG_CHARACTERS));
            } else if (line.type === 'message') {
              if (run.state !== 'running') run.state = 'running';
              const inbound = inboundOf(spec, accountId, line);
              if (!inbound) { log('[nb-im] dropped malformed message line'); return; }
              queued += 1;
              if (queued >= QUEUE_HIGH) proc.stdout.pause();
              chain = chain.then(async () => {
                try {
                  if (signal.aborted) return;
                  // A replayed id the host already accepted is acknowledged again so the script can move on.
                  if (recent.includes(inbound.event_key)) { writeLine(proc, { type: 'admitted', id: inbound.platform_event_id }); return; }
                  while (!signal.aborted) {
                    const admitted = await sink.admit(inbound).catch(() => ({ decision: 'defer' as const }));
                    if (admitted.decision === 'accepted') {
                      recent = [...recent, inbound.event_key].slice(-RECENT_CAP);
                      await store.save(`${scope}:recent`, JSON.stringify(recent));
                      await store.save(scope, inbound.cursor);
                      writeLine(proc, { type: 'admitted', id: inbound.platform_event_id });
                      break;
                    }
                    await delay(spec.retry_ms ?? 1000, signal);
                  }
                } finally {
                  queued -= 1;
                  if (queued <= QUEUE_LOW) proc.stdout.resume();
                }
              });
            }
          };
          splitLines(proc.stdout, maxLine, onLine, () => {
            overflowed = true;
            log(`[nb-im] script stdout line exceeded ${maxLine} bytes; restarting`);
            end();
          });
          const code = await closed;
          signal.removeEventListener('abort', end);
          if (child === proc) child = undefined;
          end();
          // Every receipt the script managed to write has been read by now; the rest can never arrive.
          settleAll(unknownReceipt('script_exited'));
          await chain.catch(() => undefined);
          if (signal.aborted) return;
          if (fatal) { run.state = fatal; return; }
          if (!overflowed) log(`[nb-im] script exited with code ${code}; restarting`);
          await run.reconnect({ code: 'transport_error' }, signal);
        }
      }),
      stop: () => run.stop(),
      async send(message, signal) {
        if (signal?.aborted || liveSignal?.aborted) return failed('cancelled', 'cancelled');
        const proc = child;
        if (!proc || run.state !== 'running') return failed('configuration', 'script_not_running');
        if (message.type === 'media' && message.media.bytes.byteLength > SCRIPT_MEDIA_BYTES) {
          return failed('too_long', 'script_media_limit');
        }
        seq += 1;
        const id = `s${Date.now().toString(36)}${seq.toString(36)}`;
        const receipt = new Promise<SessionReceipt>((resolve) => {
          pending.set(id, resolve);
          const timer = setTimeout(() => {
            if (pending.delete(id)) resolve(unknownReceipt('script_send_timeout'));
          }, spec.send_timeout_ms ?? SEND_TIMEOUT_MS);
          timer.unref();
          signal?.addEventListener('abort', () => {
            if (pending.delete(id)) resolve(unknownReceipt('cancelled_after_dispatch'));
          }, { once: true });
        });
        if (!writeLine(proc, { type: 'send', id, message: encodeOutbound(message) })) {
          pending.delete(id);
          return failed('configuration', 'script_not_running');
        }
        return receipt;
      },
    };
    const run = createSessionRun(key, adapter, spec.retry_ms);
    return adapter;
  });
}
