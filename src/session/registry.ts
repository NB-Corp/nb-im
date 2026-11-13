import { createHash } from 'node:crypto';
import type { SessionAdapter, SessionSpec } from './contract.ts';
import { validInstanceId } from './contract.ts';

const pool = new Map<string, SessionAdapter>();

export function sessionFingerprint(spec: SessionSpec): string {
  if (!validInstanceId(spec.instance_id)) throw new Error('invalid_instance_id');
  let secret: string;
  if (spec.platform === 'telegram') secret = spec.token;
  else if (spec.platform === 'feishu_app') secret = `${spec.app_id}\0${spec.app_secret}`;
  else if (spec.platform === 'personal_wechat') secret = spec.token;
  else if (spec.platform === 'discord') secret = spec.bot_token;
  else if (spec.platform === 'slack') secret = `${spec.bot_token}\0${spec.app_token}`;
  else if (spec.platform === 'matrix') secret = `${new URL(spec.homeserver).href.replace(/\/$/, '')}\0${spec.access_token}`;
  else secret = `${spec.mode}\0${spec.endpoint}\0${spec.listen_port ?? ''}\0${spec.access_token ?? ''}`;
  return createHash('sha256').update(`${spec.platform}\0${secret}`).digest('hex');
}
export function shareSession(key: string, create: () => SessionAdapter): SessionAdapter {
  const found = pool.get(key);
  if (found && found.state !== 'stopped') return found;
  const created = create();
  pool.set(key, created);
  return created;
}
export function unshareSession(key: string, adapter: SessionAdapter): void {
  if (pool.get(key) === adapter) pool.delete(key);
}
export function findShared(key: string): SessionAdapter | undefined {
  const found = pool.get(key);
  return found && found.state !== 'stopped' ? found : undefined;
}
