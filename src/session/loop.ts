import type { SessionAdapter, SessionConnectionDetail, SessionRunState } from './contract.ts';
import { delay } from './contract.ts';
import { unshareSession } from './registry.ts';

export function createSessionRun(key: string, adapter: SessionAdapter, retryMs = 1000) {
  let state: SessionRunState = 'idle';
  let detail: SessionConnectionDetail | undefined;
  let retryAt: number | undefined;
  let failures = 0;
  let ready: Promise<void> | undefined;
  let resolveReady: (() => void) | undefined;
  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const opened = (): void => {
    resolveReady?.();
    resolveReady = undefined;
  };
  return {
    get state(): SessionRunState { return state; },
    get detail(): SessionConnectionDetail | undefined {
      return detail === undefined ? undefined : { ...detail,
        retry_in_ms: retryAt === undefined ? undefined : Math.max(0, Math.ceil(retryAt - performance.now())) };
    },
    set detail(next: SessionConnectionDetail | undefined) { detail = next; retryAt = undefined; },
    set state(next: SessionRunState) {
      if (controller?.signal.aborted && next !== 'stopped') return;
      state = next;
      if (next === 'running') { failures = 0; detail = undefined; retryAt = undefined; }
      if (next === 'auth_expired') { detail = { code: 'auth_expired' }; retryAt = undefined; }
      if (next === 'running' || next === 'conflict' || next === 'auth_expired' || next === 'stopped') opened();
    },
    async reconnect(next: SessionConnectionDetail, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      state = 'reconnecting';
      const ms = Math.min(30_000, retryMs * 2 ** Math.min(failures, 20));
      failures += 1;
      detail = { ...next, failure_count: failures };
      retryAt = performance.now() + ms;
      await delay(ms, signal);
    },
    start(body: (signal: AbortSignal) => Promise<void>): Promise<void> {
      if (state === 'stopped') throw new Error('session_stopped');
      if (state === 'conflict' || state === 'auth_expired') return Promise.resolve();
      if (ready) return ready;
      controller = new AbortController();
      state = 'starting';
      ready = new Promise((resolve) => { resolveReady = resolve; });
      const signal = controller.signal;
      task = Promise.resolve().then(() => signal.aborted ? undefined : body(signal)).catch(() => {
        if (!signal.aborted) detail = { code: 'loop_failed' };
      }).finally(() => {
        if (state !== 'conflict' && state !== 'auth_expired' && state !== 'stopped') state = 'stopped';
        opened();
        if (state === 'stopped') unshareSession(key, adapter);
      });
      return ready;
    },
    async stop(): Promise<void> {
      state = 'stopped';
      controller?.abort();
      opened();
      await task;
      state = 'stopped';
      unshareSession(key, adapter);
    },
  };
}
