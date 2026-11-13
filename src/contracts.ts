export const IPC_VERSION = 'nb-im/1' as const;
export type ProviderId = 'telegram' | 'script' | 'windows_toast' | 'wecom_webhook' |
  'discord_webhook' | 'slack_webhook' | 'dingtalk_webhook' | 'feishu_webhook' | 'http';
export type Category = 'work_complete' | 'question_pending' | 'task_failed';
export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'transient' |
  'too_long' | 'bad_format' | 'dependency_missing' | 'configuration' | 'protocol' | 'unknown';
export interface SendResult {
  status: 'accepted' | 'suppressed' | 'failed' | 'unknown';
  message_ids: string[];
  retryable: boolean;
  error_kind?: ErrorKind;
  diagnostic_code?: string;
  retry_after_ms?: number;
}
export type CredentialPurpose = 'telegram_bot' | 'wecom_key' | 'discord_token' |
  'slack_path' | 'dingtalk_token' | 'feishu_token' | 'signing_secret' |
  'http_bearer' | 'http_path' | 'script_secret';
export interface CredentialScope {
  provider_id: ProviderId;
  provider_instance_id: string;
  purpose: CredentialPurpose;
}
export interface CredentialSlot extends CredentialScope { env: string }
export interface Instance {
  provider_id: ProviderId;
  enabled: boolean;
  revision: string;
  options: Record<string, unknown>;
}
export interface Channel {
  provider_instance_id: string;
  enabled: boolean;
  revision: string;
  target: Record<string, unknown>;
  directions: ['send'];
}
export interface Config {
  schema_version: '1';
  provider_instances: Record<string, Instance>;
  channels: Record<string, Channel>;
  credential_slots: Record<string, CredentialSlot>;
}
export interface DeliveryInput {
  idempotency_key: string;
  channel_id: string;
  category: Category;
  expires_at: string;
  correlation_ref?: string;
}
export type DeliveryStatus = 'queued' | 'sending' | 'accepted_by_provider' | 'suppressed' |
  'failed' | 'expired' | 'unknown' | 'cancelled';
export interface DeliveryView {
  delivery_id: string;
  channel_id: string;
  status: DeliveryStatus;
  attempt: number;
  created_at: string;
  expires_at: string;
  result: SendResult | null;
}
export interface ProviderContext {
  delivery_id: string;
  channel_id: string;
  category: Category;
  text: string;
  correlation_ref?: string;
  idempotency_key: string;
  expires_at: string;
  instance: Instance;
  target: Record<string, unknown>;
  // Read-only preflight; never grants permission to perform an external side effect.
  canDispatch(): 'ready' | 'expired' | 'stale';
  // One-shot durable CAS: invoke immediately before the external side effect.
  beginDispatch(): 'ready' | 'expired' | 'stale';
  resolveCredential(slot: string): string;
}
export interface Provider {
  readonly id: ProviderId;
  send(context: ProviderContext): Promise<SendResult>;
}
export const PROVIDERS = Object.freeze({
  telegram: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: true, supports_idempotency: false },
  script: { can_send: false, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  windows_toast: { can_send: true, can_receive: false, inbound_identity: 'not_applicable',
    provides_message_ids: false, supports_idempotency: false },
  wecom_webhook: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  discord_webhook: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  slack_webhook: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  dingtalk_webhook: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  feishu_webhook: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
  http: { can_send: true, can_receive: false, inbound_identity: 'not_implemented',
    provides_message_ids: false, supports_idempotency: false },
});
// Offline mappings are not live-platform verification; SMTP/Matrix have no adapters.
export const UNVERIFIED_CHANNELS = Object.freeze([
  'discord_webhook', 'slack_webhook', 'dingtalk_webhook', 'feishu_webhook', 'http',
  'smtp', 'matrix',
]);
// Explicit user exclusion: these are not candidates for the first release.
export const EXCLUDED_CHANNELS = Object.freeze([
  'ntfy', 'gotify', 'bark', 'pushover', 'pushbullet',
  'serverchan', 'wxpusher', 'pushplus', 'personal_wechat',
]);
