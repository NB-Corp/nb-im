import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Provider, ProviderContext, SendResult } from './contracts.ts';

const failed = (kind: SendResult['error_kind'], code: string): SendResult => ({
  status: 'failed', message_ids: [], retryable: false, error_kind: kind, diagnostic_code: code,
});
function permitResult(context: ProviderContext): SendResult | null {
  const state = context.canDispatch();
  return state === 'ready' ? null : failed('configuration',
    state === 'expired' ? 'delivery_expired' : 'dispatch_stale');
}
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('preflight_timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export interface ScriptApproval {
  // Approval is owned by the host, not inferred from the instance's enabled flag.
  isApproved(digest: string): Promise<boolean>;
}
export interface ScriptSnapshot {
  digest: string;
  executable: string;
  script: string;
  cwd: string;
  args: readonly string[];
  dispose(): Promise<void>;
}

// Preview-only: this preparation never executes a script. A staging directory owned
// by this user is not an immutable execution object; no sender may spawn these paths.
export async function prepareScriptSnapshot(context: ProviderContext): Promise<ScriptSnapshot> {
  const options = context.instance.options;
  const send = options.send as { command_argv: string[]; cwd: string; timeout_ms: number };
  const [executable, script, ...args] = send.command_argv;
  if (!executable || !script || !isAbsolute(executable) || !isAbsolute(script) ||
      !isAbsolute(send.cwd) || args.some((arg) => /[\r\n\0]/u.test(arg))) {
    throw new Error('script_path_invalid');
  }
  const paths = await bounded(Promise.all([
    realpath(executable), realpath(script), realpath(send.cwd),
  ]), 5000);
  const [executablePath, scriptPath, cwd] = paths;
  const [exeStat, scriptStat] = await bounded(Promise.all([
    stat(executablePath), stat(scriptPath),
  ]), 5000);
  if (!exeStat.isFile() || !scriptStat.isFile() ||
      exeStat.size > 134_217_728 || scriptStat.size > 4_194_304) {
    throw new Error('script_file_invalid');
  }
  const [exeBytes, scriptBytes] = await bounded(Promise.all([
    readFile(executablePath), readFile(scriptPath),
  ]), 5000);
  if (exeBytes.length !== exeStat.size || scriptBytes.length !== scriptStat.size) {
    throw new Error('script_file_changed');
  }
  // Detect a path swap while reading, rather than authorizing bytes from an old pathname.
  const [exeAgain, scriptAgain] = await bounded(Promise.all([
    realpath(executable), realpath(script),
  ]), 5000);
  if (exeAgain !== executablePath || scriptAgain !== scriptPath) {
    throw new Error('script_file_changed');
  }
  const digest = createHash('sha256').update(JSON.stringify([
    executablePath, scriptPath, cwd, args, context.channel_id, context.target,
    context.instance.revision, Object.entries(options.env as object).sort(),
    Object.entries(options.secret_env as object).sort(),
    createHash('sha256').update(exeBytes).digest('hex'),
    createHash('sha256').update(scriptBytes).digest('hex'),
  ])).digest('hex');
  let directory: string | undefined;
  try {
    directory = await bounded(mkdtemp(join(tmpdir(), 'nb-im-script-')), 5000);
    const stagedExe = join(directory, 'runtime');
    const stagedScript = join(directory, 'script.mjs');
    await Promise.all([
      writeFile(stagedExe, exeBytes, { flag: 'wx', mode: 0o500 }),
      writeFile(stagedScript, scriptBytes, { flag: 'wx', mode: 0o400 }),
    ]);
    return { digest, executable: stagedExe, script: stagedScript, cwd, args: Object.freeze([...args]),
      async dispose() { await rm(directory!, { recursive: true, force: true }); } };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Reviewable preflight seam: also usable by offline tests without launching code.
export async function authorizeScriptSnapshot(context: ProviderContext,
  approval: ScriptApproval): Promise<ScriptSnapshot | SendResult> {
  const blocked = permitResult(context);
  if (blocked) return blocked;
  let staged: ScriptSnapshot;
  try { staged = await prepareScriptSnapshot(context); }
  catch { return failed('configuration', 'script_preflight_failed'); }
  const send = context.instance.options.send as { timeout_ms: number };
  const approved = await bounded(Promise.resolve().then(() =>
    approval.isApproved(staged.digest)), Math.min(send.timeout_ms, 10_000)).catch(() => false);
  const afterApproval = permitResult(context);
  if (!approved || afterApproval) {
    try { await staged.dispose(); } catch { /* no external send occurred */ }
    return afterApproval ?? failed('forbidden', 'script_not_approved');
  }
  return staged;
}

export function parseScriptReceipt(value: unknown, requestId: string): SendResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (Object.keys(frame).some((key) => !['protocol', 'request_id', 'result'].includes(key)) ||
      frame.protocol !== 'nb-im-script/1' || frame.request_id !== requestId ||
      typeof frame.result !== 'object' || frame.result === null || Array.isArray(frame.result)) return null;
  const result = frame.result as Record<string, unknown>;
  const status = result.status;
  const kinds = ['auth', 'forbidden', 'not_found', 'rate_limited', 'transient',
    'too_long', 'bad_format', 'dependency_missing', 'configuration', 'protocol', 'unknown'];
  if (Object.keys(result).some((key) => !['status', 'message_ids', 'retryable', 'error_kind',
    'diagnostic_code', 'retry_after_ms'].includes(key)) ||
      !['accepted', 'suppressed', 'failed', 'unknown'].includes(status as string) ||
      !Array.isArray(result.message_ids) || result.message_ids.length > 16 ||
      result.message_ids.some((id: unknown) => typeof id !== 'string' || id.length > 128) ||
      typeof result.retryable !== 'boolean' ||
      (status !== 'accepted' && result.message_ids.length > 0) ||
      (status !== 'failed' && result.retryable === true) ||
      (status === 'failed' && !kinds.includes(result.error_kind as string)) ||
      (result.error_kind !== undefined && !kinds.includes(result.error_kind as string)) ||
      (result.diagnostic_code !== undefined &&
        (typeof result.diagnostic_code !== 'string' ||
         !/^[a-z0-9_]{1,64}$/u.test(result.diagnostic_code))) ||
      (result.retry_after_ms !== undefined &&
        (!Number.isSafeInteger(result.retry_after_ms) || (result.retry_after_ms as number) < 0 ||
         status !== 'failed' || result.retryable !== true))) return null;
  // An authorized local script still controls stdout. IDs/diagnostic strings could contain
  // secret_env data, so never persist or expose these two free-form receipt fields.
  return { status: status as SendResult['status'], message_ids: [], retryable: false,
    ...(result.error_kind ? { error_kind: result.error_kind as SendResult['error_kind'] } : {}) };
}
export function scriptProvider(_approval: ScriptApproval): Provider {
  return { id: 'script', async send() {
    // Approval of a same-user writable staging path cannot bind its bytes to spawn.
    // Reject on every OS until a protected host execution mechanism is available.
    return failed('dependency_missing', 'script_execution_unavailable');
  } };
}
