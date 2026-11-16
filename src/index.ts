import { createHash } from 'node:crypto';
import type { Channel, Config, CredentialScope, DeliveryInput, DeliveryView,
  Instance, Provider, SendResult } from './contracts.ts';
import { IPC_VERSION, PROVIDERS } from './contracts.ts';
import { credentialPurpose, validateConfig } from './config.ts';
import { Outbox } from './outbox.ts';
export { IPC_VERSION, PROVIDERS, UNVERIFIED_CHANNELS, EXCLUDED_CHANNELS } from './contracts.ts';
export type * from './contracts.ts';
export { createCredentialResolver, validateConfig } from './config.ts';
export { Outbox } from './outbox.ts';
export { telegramProvider, telegramHttps, scriptProvider, windowsToastProvider,
  wecomHttps } from './providers.ts';
export { wecomWebhookProvider } from './wecom.ts';
export type { WecomTransport } from './wecom.ts';
export type { ScriptApproval, TelegramTransport, ToastHost } from './providers.ts';
export { webhookProvider } from './webhook.ts';
export type { WebhookProviderId } from './webhook.ts';
export { createSafeHttpTransport, safeHttpTransport, planHttpConnection,
  validateHttpEndpoint } from './http-transport.ts';
export type { OutboundHttpTransport, OutboundHttpRequest, PrivateEndpointGrant,
  ResolvedRequest, ResolveAddresses, SendPinned } from './http-transport.ts';
export { SESSION_CONTRACT, TELEGRAM_TEXT_CHARACTERS, TELEGRAM_CAPTION_CHARACTERS,
  TELEGRAM_CALLBACK_DATA_BYTES, TELEGRAM_DOWNLOAD_BYTES, TELEGRAM_IMAGE_BYTES,
  TELEGRAM_FILE_BYTES, TELEGRAM_VOICE_BYTES, FEISHU_TEXT_UTF8_BYTES, FEISHU_CARD_UTF8_BYTES,
  FEISHU_IMAGE_BYTES, FEISHU_FILE_BYTES, WECOM_AIBOT_MARKDOWN_UTF8_BYTES, splitSessionText, splitFeishuText } from './session/contract.ts';
export type { SessionAccount, SessionAdmit, SessionAdapter, SessionButton, SessionChatKind, SessionConnectionDetail,
  SessionCursorStore, SessionIdentity, SessionInbound, SessionInboundPart, SessionInboundPayload,
  SessionInboundUnavailableReason, SessionLimits, SessionMedia,
  SessionOutbound, SessionPeer, SessionPlatformId, SessionReceipt, SessionRunState, SessionSink,
  SessionSpec, SessionTarget } from './session/contract.ts';
export { createSessionHub } from './session/hub.ts';
export type { SessionHub } from './session/hub.ts';
export { createTelegramSessionAdapter } from './session/telegram.ts';
export { createFeishuSessionAdapter } from './session/feishu.ts';
export { createFeishuSdkConnection } from './session/feishu-sdk.ts';
export { createOneBotSessionAdapter } from './session/onebot.ts';
export { createOneBotWsTransport } from './session/onebot-ws.ts';
export { createWechatSessionAdapter } from './session/wechat.ts';
export { createDiscordSessionAdapter, createDiscordConnection } from './session/discord.ts';
export { createSlackSessionAdapter, createSlackConnection } from './session/slack.ts';
export { createMatrixSessionAdapter, createMatrixConnection } from './session/matrix.ts';
export { createWecomAibotSessionAdapter, createWecomAibotTransport, decryptWecomMedia, WECOM_AIBOT_URL } from './session/wecom-aibot.ts';
export { createScriptSessionAdapter, SCRIPT_PROTOCOL, SCRIPT_TEXT_CHARACTERS, SCRIPT_MEDIA_BYTES,
  SCRIPT_LINE_BYTES } from './session/script.ts';
export { sessionFingerprint } from './session/registry.ts';
export type { RealtimeConnection, RealtimeRequest, RealtimeHandlers, SessionMediaKind, WecomAibotDownload, WecomAibotLink,
  WecomAibotTransport } from './session/contract.ts';
export { PlatformFault } from './session/realtime.ts';
export { SESSION_CAPABILITIES, SESSION_SETUP, createSlackManifest, slackManifestInstallUrl,
  discordInstallUrl, slackOAuthUrl, exchangeSlackOAuth, discoverMatrix, matrixSsoUrl,
  exchangeMatrixLogin, matrixPasswordLogin } from './session/setup.ts';
export type { SessionCapability, SessionSetup, SetupField, MatrixDiscovery } from './session/setup.ts';

const TEXT: Record<DeliveryInput['category'], string> = {
  work_complete: 'Kiki 的一轮工作已完成，请返回应用查看。',
  question_pending: 'Kiki 有一项问题等待回答，请返回应用查看。',
  task_failed: 'Kiki 有一项任务需要关注，请返回应用查看。',
};
const uncertain: SendResult = { status: 'unknown', message_ids: [], retryable: false,
  error_kind: 'unknown', diagnostic_code: 'send_outcome_unknown' };
function binding(value: unknown): string {
  // The queue retains a fingerprint, never the destination configuration or credentials.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const DIAGNOSTICS = new Set([
  'send_outcome_unknown', 'dispatch_stale', 'delivery_expired',
  'credential_unavailable', 'telegram_transport_unknown', 'telegram_invalid_response',
  'telegram_auth', 'telegram_forbidden', 'telegram_bad_request', 'telegram_not_found',
  'telegram_conflict', 'telegram_response_unknown', 'toast_host_unknown',
  'wecom_invalid_key', 'wecom_transport_unknown', 'wecom_response_unknown',
  'wecom_invalid_response', 'wecom_rejected_unknown', 'wecom_rate_limited',
  'wecom_busy_unknown', 'cancel_after_dispatch', 'script_execution_unavailable',
  'script_windows_unavailable', 'script_path_invalid', 'script_file_invalid',
  'script_file_missing', 'script_not_approved', 'script_request_too_large',
  'script_spawn_failed', 'script_timeout', 'script_output_limit', 'script_nonzero_exit',
  'script_signal', 'script_invalid_response', 'script_protocol_error',
  'script_preflight_failed', 'script_termination_unverified',
  'provider_unavailable', 'provider_diagnostic_redacted',
  'webhook_auth', 'webhook_forbidden', 'webhook_not_found',
  'webhook_rate_limited_unknown', 'webhook_response_unknown',
  'webhook_rejected_unknown', 'webhook_invalid_response',
  'webhook_transport_unknown', 'webhook_configuration',
]);
function safeReceipt(providerId: Instance['provider_id'], result: SendResult): SendResult {
  if (!result || !['accepted', 'suppressed', 'failed', 'unknown'].includes(result.status)) {
    return uncertain;
  }
  const code = typeof result.diagnostic_code === 'string' &&
    DIAGNOSTICS.has(result.diagnostic_code) ? result.diagnostic_code :
    result.diagnostic_code === undefined ? undefined : 'provider_diagnostic_redacted';
  const kinds = ['auth', 'forbidden', 'not_found', 'rate_limited', 'transient',
    'too_long', 'bad_format', 'dependency_missing', 'configuration', 'protocol', 'unknown'];
  return { status: result.status,
    message_ids: providerId === 'telegram' && Array.isArray(result.message_ids) ?
      result.message_ids.filter((id) => typeof id === 'string' && /^[0-9]{1,20}$/u.test(id)) : [],
    retryable: false,
    ...(result.error_kind && kinds.includes(result.error_kind) ? { error_kind: result.error_kind } : {}),
    ...(code ? { diagnostic_code: code } : {}),
  };
}
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(part: unknown): void {
    if (part !== null && typeof part === 'object') {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  }
  freeze(copy);
  return copy;
}
export class Runtime {
  readonly outbox: Outbox;
  readonly providers: Map<string, Provider>;
  readonly config: Config;
  readonly resolveCredential: (slot: string, scope: CredentialScope) => string;
  readonly getAccountEpoch: (instanceId: string) => string;
  #busy = false;
  #timer?: NodeJS.Timeout;
  constructor(config: Config, path: string, adapters: readonly Provider[],
    resolveCredential: (slot: string, scope: CredentialScope) => string,
    getAccountEpoch: (instanceId: string) => string) {
    validateConfig(config);
    if (typeof getAccountEpoch !== 'function') throw new Error('account_epoch_required');
    this.config = config;
    this.resolveCredential = resolveCredential;
    this.getAccountEpoch = getAccountEpoch;
    this.providers = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    if (this.providers.size !== adapters.length) throw new Error('duplicate_provider');
    this.outbox = new Outbox(path);
    this.outbox.recover();
  }
  #instanceBinding(instanceId: string, instance: Instance): string {
    const slots = Object.entries(this.config.credential_slots)
      .filter(([, spec]) => spec.provider_instance_id === instanceId)
      .sort(([left], [right]) => left.localeCompare(right));
    // Only nonsecret slot metadata enters the fingerprint. Slot reassignment stales old work.
    return binding([instance, slots]);
  }
  enqueue(input: DeliveryInput): DeliveryView {
    const channel = this.config.channels[input.channel_id];
    if (!channel?.enabled) throw new Error('channel_unavailable');
    const instance = this.config.provider_instances[channel.provider_instance_id];
    if (!instance?.enabled || PROVIDERS[instance.provider_id]?.can_send !== true ||
        !this.providers.has(instance.provider_id)) {
      throw new Error('provider_unavailable');
    }
    return this.outbox.enqueue(input,
      this.#instanceBinding(channel.provider_instance_id, instance), binding(channel),
      this.getAccountEpoch(channel.provider_instance_id));
  }
  get(id: string): DeliveryView | undefined { return this.outbox.get(id); }
  // true means stopped before dispatch. false means not cancelled; a claimed send that
  // crossed the durable dispatch boundary becomes unknown (possibly delivered).
  cancel(id: string): boolean { return this.outbox.cancel(id); }
  async tick(): Promise<DeliveryView | undefined> {
    if (this.#busy) return undefined;
    this.#busy = true;
    try {
      const row = this.outbox.claim();
      if (!row) return undefined;
      const channel = this.config.channels[row.channel_id];
      const instanceId = channel?.provider_instance_id;
      const instance = instanceId && this.config.provider_instances[instanceId];
      const canDispatch = (): 'ready' | 'expired' | 'stale' => {
        if (Date.parse(row.expires_at) <= Date.now()) return 'expired';
        if (!this.outbox.stillClaimed(row)) return 'stale';
        try {
          const currentChannel = this.config.channels[row.channel_id];
          const currentInstance = currentChannel &&
            this.config.provider_instances[currentChannel.provider_instance_id];
          if (!currentChannel?.enabled || !currentInstance?.enabled ||
              row.channel_revision !== binding(currentChannel) ||
              row.instance_revision !== this.#instanceBinding(
                currentChannel.provider_instance_id, currentInstance) ||
              row.account_epoch === null ||
              this.getAccountEpoch(currentChannel.provider_instance_id) !== row.account_epoch) {
            return 'stale';
          }
          return 'ready';
        } catch { return 'stale'; }
      };
      const beginDispatch = (): 'ready' | 'expired' | 'stale' => {
        const state = canDispatch();
        if (state !== 'ready') return state;
        return this.outbox.beginDispatch(row) ? 'ready' : 'stale';
      };
      const initial = canDispatch();
      if (initial !== 'ready' || !channel || !instance) {
        this.outbox.finish(row, initial === 'expired' ? 'expired' : 'failed',
          initial === 'expired' ? null : { status: 'failed', message_ids: [], retryable: false,
            error_kind: 'configuration', diagnostic_code: 'dispatch_stale' });
        return this.get(row.delivery_id);
      }
      // Never hand a live, mutable config reference across an awaited provider preflight.
      const channelSnapshot: Channel = snapshot(channel);
      const instanceSnapshot: Instance = snapshot(instance);
      const provider = this.providers.get(instanceSnapshot.provider_id);
      if (!provider || PROVIDERS[instanceSnapshot.provider_id]?.can_send !== true) {
        this.outbox.finish(row, 'failed', { status: 'failed', message_ids: [], retryable: false,
          error_kind: 'dependency_missing', diagnostic_code: 'provider_unavailable' });
        return this.get(row.delivery_id);
      }
      const resolveBound = (slotId: string): string => {
        if (!instanceId || canDispatch() !== 'ready') throw new Error('credential_scope_violation');
        const purpose = credentialPurpose(instanceSnapshot, slotId);
        const spec = Object.hasOwn(this.config.credential_slots, slotId) ?
          this.config.credential_slots[slotId] : undefined;
        if (!purpose || !spec || spec.provider_id !== instanceSnapshot.provider_id ||
            spec.provider_instance_id !== instanceId || spec.purpose !== purpose) {
          throw new Error('credential_scope_violation');
        }
        return this.resolveCredential(slotId, {
          provider_id: instanceSnapshot.provider_id, provider_instance_id: instanceId, purpose,
        });
      };
      let result: SendResult;
      try {
        result = await provider.send({ delivery_id: row.delivery_id, channel_id: row.channel_id,
          category: row.category, text: TEXT[row.category],
          ...(row.correlation_ref === null ? {} : { correlation_ref: row.correlation_ref }),
          idempotency_key: row.idempotency_key, expires_at: row.expires_at,
          instance: instanceSnapshot, target: channelSnapshot.target,
          canDispatch, beginDispatch, resolveCredential: resolveBound });
      } catch { result = uncertain; }
      result = safeReceipt(instanceSnapshot.provider_id, result);
      // If a provider bypasses its dispatch permit, never present its outcome as accepted.
      // Side effects already started cannot be revoked, so retain an honest unknown receipt.
      if (result.status === 'accepted' &&
          (!this.outbox.dispatched(row) || canDispatch() !== 'ready')) result = uncertain;
      const state = result.diagnostic_code === 'delivery_expired' ? 'expired' :
        result.status === 'accepted' ? 'accepted_by_provider' : result.status;
      this.outbox.finish(row, state, result);
      return this.get(row.delivery_id);
    } finally { this.#busy = false; }
  }
  start(onError: (error: unknown) => void, intervalMs = 1000): void {
    if (typeof onError !== 'function' || this.#timer ||
        !Number.isInteger(intervalMs) || intervalMs < 100) {
      throw new Error('invalid_poll_interval');
    }
    this.#timer = setInterval(() => { void this.tick().catch(onError); }, intervalMs);
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  close(): void { this.stop(); if (this.#busy) throw new Error('send_in_progress'); this.outbox.close(); }
}
export type IpcRequest = { protocol: typeof IPC_VERSION; request_id: string; op: 'enqueue';
  delivery: DeliveryInput } | { protocol: typeof IPC_VERSION; request_id: string;
  op: 'get' | 'cancel'; delivery_id: string };
export const IPC_MAX_FRAME_BYTES = 16_384; // Enforce before parsing in the authenticated host.
function deliveryInput(value: unknown): value is DeliveryInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).every((key) => ['idempotency_key', 'channel_id',
    'category', 'expires_at', 'correlation_ref'].includes(key)) &&
    typeof fields.idempotency_key === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/u.test(fields.idempotency_key) &&
    typeof fields.channel_id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(fields.channel_id) &&
    ['work_complete', 'question_pending', 'task_failed'].includes(fields.category as string) &&
    typeof fields.expires_at === 'string' && fields.expires_at.length <= 30 &&
    (fields.correlation_ref === undefined ||
      (typeof fields.correlation_ref === 'string' &&
       /^[A-Za-z0-9_.:-]{1,256}$/u.test(fields.correlation_ref)));
}
export async function handleIpc(runtime: Runtime, raw: unknown): Promise<unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { protocol: IPC_VERSION, error_code: 'bad_request' };
  }
  const input = raw as Record<string, unknown>;
  if (input.protocol !== IPC_VERSION || typeof input.request_id !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,120}$/u.test(input.request_id)) {
    return { protocol: IPC_VERSION, error_code: 'unsupported_protocol' };
  }
  try {
    let value: unknown;
    if (input.op === 'enqueue' && Object.keys(input).every((key) =>
      ['protocol', 'request_id', 'op', 'delivery'].includes(key)) &&
      deliveryInput(input.delivery)) {
      value = runtime.enqueue(input.delivery);
    } else if (input.op === 'get' && typeof input.delivery_id === 'string' &&
      /^[a-f0-9-]{36}$/u.test(input.delivery_id) &&
      Object.keys(input).every((key) => ['protocol', 'request_id', 'op', 'delivery_id'].includes(key))) {
      value = runtime.get(input.delivery_id) ?? null;
    } else if (input.op === 'cancel' && typeof input.delivery_id === 'string' &&
      /^[a-f0-9-]{36}$/u.test(input.delivery_id) &&
      Object.keys(input).every((key) => ['protocol', 'request_id', 'op', 'delivery_id'].includes(key))) {
      value = runtime.cancel(input.delivery_id);
    } else { throw new Error('bad_request'); }
    return { protocol: IPC_VERSION, request_id: input.request_id, value };
  } catch (error) {
    const code = error instanceof Error && ['idempotency_conflict', 'invalid_delivery',
      'invalid_expiry', 'channel_unavailable', 'provider_unavailable', 'bad_request'].includes(error.message)
      ? error.message : 'operation_failed';
    return { protocol: IPC_VERSION, request_id: input.request_id, error_code: code };
  }
}
