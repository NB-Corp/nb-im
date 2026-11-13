import type { Channel, Config, CredentialPurpose, CredentialScope, Instance,
  ProviderId } from './contracts.ts';
import { validateHttpEndpoint } from './http-transport.ts';
import type { PrivateEndpointGrant } from './http-transport.ts';

const ids = /^[a-zA-Z0-9_.:-]{1,120}$/u;
const providers = new Set<ProviderId>(['telegram', 'script', 'windows_toast',
  'wecom_webhook', 'discord_webhook', 'slack_webhook', 'dingtalk_webhook',
  'feishu_webhook', 'http']);
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, permitted: readonly string[]): void {
  if (Object.keys(value).some((key) => !permitted.includes(key))) throw new Error('unsupported_config_field');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ids.test(value)) throw new Error('invalid_identifier');
}
export function credentialPurpose(instance: Instance, slotId: string): CredentialPurpose | undefined {
  const o = instance.options;
  const uses: [unknown, CredentialPurpose][] = instance.provider_id === 'telegram' ?
    [[o.token_slot, 'telegram_bot']] : instance.provider_id === 'wecom_webhook' ?
    [[o.key_slot, 'wecom_key']] : instance.provider_id === 'discord_webhook' ?
    [[o.token_slot, 'discord_token']] : instance.provider_id === 'slack_webhook' ?
    [[o.path_slot, 'slack_path']] : instance.provider_id === 'dingtalk_webhook' ?
    [[o.token_slot, 'dingtalk_token'], [o.secret_slot, 'signing_secret']] :
    instance.provider_id === 'feishu_webhook' ?
      [[o.token_slot, 'feishu_token'], [o.secret_slot, 'signing_secret']] :
    instance.provider_id === 'http' ?
      [[o.auth_slot, 'http_bearer'], [o.path_slot, 'http_path']] :
    instance.provider_id === 'script' && record(o.secret_env) ?
      Object.values(o.secret_env).filter(record).map((spec) =>
        [spec.credential_slot_id, 'script_secret'] as [unknown, CredentialPurpose]) : [];
  return uses.find(([value]) => value === slotId)?.[1];
}
function slot(config: Config, value: unknown, instanceId: string,
  purpose: CredentialPurpose): void {
  id(value);
  if (!own(config.credential_slots, value)) throw new Error('missing_credential_slot');
  const spec = config.credential_slots[value]!;
  if (spec.provider_instance_id !== instanceId ||
      spec.provider_id !== config.provider_instances[instanceId]?.provider_id ||
      spec.purpose !== purpose) throw new Error('credential_scope_violation');
}
export function validateConfig(config: Config): void {
  if (!record(config) || config.schema_version !== '1' ||
      !record(config.provider_instances) || !record(config.channels) ||
      !record(config.credential_slots)) throw new Error('invalid_config');
  keys(config, ['schema_version', 'provider_instances', 'channels', 'credential_slots']);
  for (const [name, entry] of Object.entries(config.provider_instances)) {
    id(name);
    if (!record(entry)) throw new Error('invalid_instance');
    keys(entry, ['provider_id', 'enabled', 'revision', 'options']);
    if (!providers.has(entry.provider_id as ProviderId) || typeof entry.enabled !== 'boolean' ||
        !record(entry.options)) throw new Error('invalid_instance');
    id(entry.revision);
  }
  const envs = new Set<string>();
  for (const [key, entry] of Object.entries(config.credential_slots)) {
    id(key);
    if (!record(entry)) throw new Error('invalid_credential_slot');
    keys(entry, ['env', 'provider_id', 'provider_instance_id', 'purpose']);
    id(entry.provider_instance_id);
    if (typeof entry.env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(entry.env) ||
        envs.has(entry.env) || !own(config.provider_instances, entry.provider_instance_id) ||
        config.provider_instances[entry.provider_instance_id]!.provider_id !== entry.provider_id ||
        credentialPurpose(config.provider_instances[entry.provider_instance_id]!, key) !==
          entry.purpose) throw new Error('invalid_credential_slot');
    envs.add(entry.env);
  }
  for (const [name, entry] of Object.entries(config.provider_instances)) {
    validateOptions(config, entry as unknown as Instance, name);
  }
  for (const [name, entry] of Object.entries(config.channels)) {
    id(name);
    if (!record(entry)) throw new Error('invalid_channel');
    keys(entry, ['provider_instance_id', 'enabled', 'revision', 'target', 'directions']);
    id(entry.provider_instance_id);
    id(entry.revision);
    if (typeof entry.enabled !== 'boolean' || !record(entry.target) ||
        !Array.isArray(entry.directions) || entry.directions.length !== 1 ||
        entry.directions[0] !== 'send') throw new Error('invalid_channel');
    const instance = config.provider_instances[entry.provider_instance_id];
    if (!instance) throw new Error('missing_instance');
    validateTarget(instance.provider_id, entry as unknown as Channel);
  }
}
function validateOptions(config: Config, instance: Instance, instanceId: string): void {
  const o = instance.options;
  if (instance.provider_id === 'telegram') {
    keys(o, ['token_slot']);
    slot(config, o.token_slot, instanceId, 'telegram_bot');
  } else if (instance.provider_id === 'wecom_webhook') {
    keys(o, ['key_slot']);
    slot(config, o.key_slot, instanceId, 'wecom_key');
  } else if (instance.provider_id === 'windows_toast') {
    keys(o, []);
  } else if (instance.provider_id === 'discord_webhook') {
    keys(o, ['webhook_id', 'token_slot']);
    if (typeof o.webhook_id !== 'string' || !/^[0-9]{15,22}$/u.test(o.webhook_id)) {
      throw new Error('invalid_webhook_options');
    }
    slot(config, o.token_slot, instanceId, 'discord_token');
  } else if (instance.provider_id === 'slack_webhook') {
    keys(o, ['path_slot']); slot(config, o.path_slot, instanceId, 'slack_path');
  } else if (instance.provider_id === 'dingtalk_webhook' ||
      instance.provider_id === 'feishu_webhook') {
    keys(o, instance.provider_id === 'dingtalk_webhook' ?
      ['token_slot', 'secret_slot', 'keyword'] : ['token_slot', 'secret_slot']);
    slot(config, o.token_slot, instanceId, instance.provider_id === 'dingtalk_webhook' ?
      'dingtalk_token' : 'feishu_token');
    if (o.secret_slot !== undefined) slot(config, o.secret_slot, instanceId, 'signing_secret');
    if (instance.provider_id === 'dingtalk_webhook' && o.keyword !== undefined &&
        (typeof o.keyword !== 'string' || !/^[^\r\n\0]{1,40}$/u.test(o.keyword))) {
      throw new Error('invalid_webhook_options');
    }
  } else if (instance.provider_id === 'http') {
    keys(o, ['endpoint', 'format', 'auth_slot', 'path_slot', 'private_grant']);
    if (typeof o.endpoint !== 'string' || !['json', 'form', 'xml'].includes(o.format as string)) {
      throw new Error('invalid_http_options');
    }
    if (o.auth_slot !== undefined) slot(config, o.auth_slot, instanceId, 'http_bearer');
    if (o.path_slot !== undefined) slot(config, o.path_slot, instanceId, 'http_path');
    if (o.private_grant !== undefined && !record(o.private_grant)) {
      throw new Error('invalid_private_grant');
    }
    const endpoint = validateHttpEndpoint(o.endpoint,
      o.private_grant as PrivateEndpointGrant | undefined);
    if (endpoint.search || endpoint.pathname !== '/' ||
        ((o.auth_slot !== undefined || o.path_slot !== undefined) &&
          endpoint.protocol !== 'https:')) {
      throw new Error('invalid_http_options');
    }
  } else {
    keys(o, ['protocol_version', 'send', 'env', 'secret_env']);
    if (o.protocol_version !== 'nb-im-script/1' || !record(o.send)) {
      throw new Error('invalid_script_options');
    }
    keys(o.send, ['command_argv', 'cwd', 'timeout_ms']);
    if (!Array.isArray(o.send.command_argv) || o.send.command_argv.length < 2 ||
        o.send.command_argv.length > 8 || o.send.command_argv.some(
          (arg: unknown) => typeof arg !== 'string' || arg.length === 0 || arg.length > 1024 ||
            /[\r\n\0]/u.test(arg),
        ) || typeof o.send.cwd !== 'string' || o.send.cwd.length > 1024 ||
        !Number.isInteger(o.send.timeout_ms) ||
        (o.send.timeout_ms as number) < 100 || (o.send.timeout_ms as number) > 120_000) {
      throw new Error('invalid_script_options');
    }
    if (!record(o.env) || !record(o.secret_env)) throw new Error('invalid_script_env');
    for (const [key, value] of Object.entries(o.env)) {
      if (!/^NBIM_PUBLIC_[A-Z0-9_]+$/u.test(key) || typeof value !== 'string' ||
          value.length > 1024) throw new Error('invalid_script_env');
    }
    for (const [key, value] of Object.entries(o.secret_env)) {
      if (!/^NBIM_SECRET_[A-Z0-9_]+$/u.test(key) || !record(value)) {
        throw new Error('invalid_script_env');
      }
      keys(value, ['credential_slot_id']);
      slot(config, value.credential_slot_id, instanceId, 'script_secret');
    }
  }
}
function validateTarget(provider: ProviderId, channel: Channel): void {
  const target = channel.target;
  if (provider === 'telegram') {
    keys(target, ['chat_id', 'message_thread_id']);
    if (typeof target.chat_id !== 'string' || !/^-?[0-9]{1,20}$/u.test(target.chat_id) ||
        (target.message_thread_id !== undefined &&
         (!Number.isSafeInteger(target.message_thread_id) || (target.message_thread_id as number) <= 0))) {
      throw new Error('invalid_telegram_target');
    }
  } else if (provider !== 'script') {
    keys(target, []);
  } else {
    keys(target, ['key']);
    if (typeof target.key !== 'string' || !ids.test(target.key)) {
      throw new Error('invalid_script_target');
    }
  }
}
export function createCredentialResolver(config: Config, environment: Readonly<Record<string, string | undefined>>) {
  return (slotId: string, scope: CredentialScope): string => {
    const spec = Object.hasOwn(config.credential_slots, slotId) ? config.credential_slots[slotId] :
      undefined;
    const instance = scope && Object.hasOwn(config.provider_instances, scope.provider_instance_id) ?
      config.provider_instances[scope.provider_instance_id] : undefined;
    if (!spec || !instance || spec.provider_instance_id !== scope.provider_instance_id ||
        spec.provider_id !== scope.provider_id || spec.purpose !== scope.purpose ||
        instance.provider_id !== scope.provider_id ||
        credentialPurpose(instance, slotId) !== scope.purpose) {
      throw new Error('credential_scope_violation');
    }
    const value = environment[spec.env];
    if (!value) throw new Error('credential_unavailable');
    return value;
  };
}
