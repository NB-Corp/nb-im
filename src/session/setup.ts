import { WebClient } from '@slack/web-api';
import { matrixHomeserver } from './matrix.ts';
import { object, str } from './realtime.ts';
import type { SessionMediaKind } from './contract.ts';

export interface SessionCapability {
  inbound: readonly ('text' | SessionMediaKind)[];
  outbound: readonly ('text' | SessionMediaKind)[];
  threads: boolean;
  edit_text: boolean;
  callbacks: boolean;
  encrypted_rooms: boolean;
  /** Explicit voice requests must not silently become ordinary audio/file uploads. */
  voice_rendering: 'unsupported';
  audio_rendering: 'attachment' | 'm.audio';
  transport: 'gateway' | 'socket_mode' | 'sync';
}
const INBOUND_MEDIA = ['text', 'image', 'file', 'voice', 'audio', 'video'] as const;
const OUTBOUND_MEDIA = ['text', 'image', 'file', 'audio', 'video'] as const;
export const SESSION_CAPABILITIES = {
  discord: { inbound: INBOUND_MEDIA, outbound: OUTBOUND_MEDIA, threads: true, edit_text: true, callbacks: false,
    encrypted_rooms: false, voice_rendering: 'unsupported', audio_rendering: 'attachment', transport: 'gateway' },
  slack: { inbound: OUTBOUND_MEDIA, outbound: OUTBOUND_MEDIA, threads: true, edit_text: true, callbacks: false,
    encrypted_rooms: false, voice_rendering: 'unsupported', audio_rendering: 'attachment', transport: 'socket_mode' },
  matrix: { inbound: INBOUND_MEDIA, outbound: OUTBOUND_MEDIA, threads: true, edit_text: true, callbacks: false,
    encrypted_rooms: false, voice_rendering: 'unsupported', audio_rendering: 'm.audio', transport: 'sync' },
} as const satisfies Record<string, SessionCapability>;
export interface SetupField { key: string; secret: boolean; required: boolean; label: string }
export interface SessionSetup {
  methods: readonly ('oauth_install' | 'manifest' | 'discovery' | 'sso' | 'password' | 'token')[];
  fields: readonly SetupField[];
  portal_url: string;
  instructions: readonly string[];
}
export const SESSION_SETUP = {
  discord: { methods: ['oauth_install', 'token'], portal_url: 'https://discord.com/developers/applications',
    fields: [{ key: 'bot_token', secret: true, required: true, label: 'Bot token' }],
    instructions: ['Create an application and copy its bot token once. User-account tokens are not supported.',
      'Enable Message Content Intent under Bot. Use discordInstallUrl(application_id) to choose a server and install the bot.',
      'The bot can read DMs and permitted server channels. Invite permissions include sending in threads and attaching files.'] },
  slack: { methods: ['manifest', 'oauth_install', 'token'], portal_url: 'https://api.slack.com/apps',
    fields: [{ key: 'bot_token', secret: true, required: true, label: 'Bot token (xoxb)' },
      { key: 'app_token', secret: true, required: true, label: 'App-level token (xapp)' }],
    instructions: ['Open slackManifestInstallUrl() to create the app with scopes, message events and Socket Mode already filled in.',
      'Install to your workspace. For a configured OAuth app, slackOAuthUrl/exchangeSlackOAuth return the bot token without pasting it.',
      'Generate one app-level token with connections:write in Basic Information. Slack OAuth does not issue this token.',
      'Invite the bot to channels you want it to read. No public webhook URL or signing secret is needed.'] },
  matrix: { methods: ['discovery', 'sso', 'password', 'token'], portal_url: 'https://matrix.org/ecosystem/clients/',
    fields: [{ key: 'homeserver', secret: false, required: true, label: 'Homeserver URL' },
      { key: 'access_token', secret: true, required: true, label: 'Access token' }],
    instructions: ['Pass your Matrix user ID or server domain to discoverMatrix() for .well-known and available login flows.',
      'Use matrixSsoUrl() and exchangeMatrixLogin() when SSO is available, or matrixPasswordLogin() for password login.',
      'Store the returned access_token; whoami discovers the account ID. Join unencrypted rooms with a Matrix client first.',
      'Encrypted rooms and encrypted attachments are not supported in this batch; outbound plaintext into encrypted rooms is refused.'] },
} as const satisfies Record<string, SessionSetup>;

const SLACK_SCOPES = ['channels:history', 'channels:read', 'chat:write', 'files:read', 'files:write',
  'groups:history', 'groups:read', 'im:history', 'im:read', 'mpim:history', 'mpim:read'];
export function createSlackManifest(name = 'Kiki') {
  return { display_information: { name, description: `${name} messaging connector` },
    features: { bot_user: { display_name: name, always_online: false }, app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
    oauth_config: { scopes: { bot: [...SLACK_SCOPES] } },
    settings: { socket_mode_enabled: true, event_subscriptions: {
      bot_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'] } } };
}
export function slackManifestInstallUrl(name = 'Kiki'): string {
  const url = new URL('https://api.slack.com/apps');
  url.searchParams.set('new_app', '1'); url.searchParams.set('manifest', JSON.stringify(createSlackManifest(name)));
  return url.href;
}
export function discordInstallUrl(applicationId: string, guildId?: string): string {
  if (!/^\d{1,22}$/.test(applicationId) || (guildId && !/^\d{1,22}$/.test(guildId))) throw new Error('discord_application_id');
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', applicationId); url.searchParams.set('scope', 'bot');
  // VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY | SEND_MESSAGES_IN_THREADS.
  url.searchParams.set('permissions', ((1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 38n)).toString());
  if (guildId) url.searchParams.set('guild_id', guildId);
  return url.href;
}
function redirectUri(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('setup_redirect_uri');
  if (url.username || url.password || url.hash) throw new Error('setup_redirect_uri');
  return url.href;
}
export function slackOAuthUrl(input: { client_id: string; redirect_uri: string; state: string }): string {
  if (!input.state || input.state.length < 16) throw new Error('oauth_state_required');
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', input.client_id); url.searchParams.set('redirect_uri', redirectUri(input.redirect_uri));
  url.searchParams.set('state', input.state); url.searchParams.set('scope', SLACK_SCOPES.join(',')); return url.href;
}
export async function exchangeSlackOAuth(input: { client_id: string; client_secret: string; code: string;
  redirect_uri: string; state: string; expected_state: string }, signal?: AbortSignal) {
  if (!input.expected_state || input.expected_state.length < 16 || input.state !== input.expected_state) throw new Error('oauth_state_mismatch');
  const client = new WebClient(undefined, { retryConfig: { retries: 0 }, timeout: 15000,
    fetch: (url, init) => fetch(url, { ...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal }) });
  const result = await client.oauth.v2.access({ client_id: input.client_id, client_secret: input.client_secret,
    code: input.code, redirect_uri: redirectUri(input.redirect_uri) });
  if (!result.access_token || result.token_type !== 'bot') throw new Error('slack_bot_token_not_issued');
  return { bot_token: result.access_token, account_id: result.bot_user_id, team_id: result.team?.id };
}
export interface MatrixDiscovery { homeserver: string; login_types: string[]; sso: boolean }
export async function discoverMatrix(input: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<MatrixDiscovery> {
  const domain = input.startsWith('@') ? input.slice(input.indexOf(':') + 1) : input;
  const origin = matrixHomeserver(domain.includes('://') ? domain : `https://${domain}`);
  let homeserver = origin;
  const wellKnown = await fetcher(`${origin}/.well-known/matrix/client`, { signal, redirect: 'error' });
  if (wellKnown.ok) {
    const config = object(await wellKnown.json());
    const base = str(object(config['m.homeserver']).base_url);
    if (base) homeserver = matrixHomeserver(base);
  } else if (wellKnown.status !== 404) throw new Error('matrix_discovery_failed');
  const response = await fetcher(`${homeserver}/_matrix/client/v3/login`, { signal, redirect: 'error' });
  if (!response.ok) throw new Error('matrix_login_flows_failed');
  const body = object(await response.json());
  const login_types = (Array.isArray(body.flows) ? body.flows : []).map((f) => str(object(f).type)).filter(Boolean);
  return { homeserver, login_types, sso: login_types.includes('m.login.sso') && login_types.includes('m.login.token') };
}
export function matrixSsoUrl(homeserver: string, redirect_uri: string, idp_id?: string): string {
  const url = new URL(`${matrixHomeserver(homeserver)}/_matrix/client/v3/login/sso/redirect${idp_id ? `/${encodeURIComponent(idp_id)}` : ''}`);
  url.searchParams.set('redirectUrl', redirectUri(redirect_uri)); return url.href;
}
async function matrixLogin(homeserver: string, body: Record<string, unknown>, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const base = matrixHomeserver(homeserver);
  const response = await fetcher(`${base}/_matrix/client/v3/login`, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, initial_device_display_name: 'Kiki IM' }) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'matrix_login_rejected' : 'matrix_login_failed');
  const result = object(await response.json());
  if (!str(result.access_token) || !str(result.user_id)) throw new Error('matrix_invalid_login');
  return { homeserver: base, access_token: str(result.access_token), account_id: str(result.user_id), device_id: str(result.device_id) };
}
/** Host binds the callback URI to its setup attempt before consuming the one-use loginToken. */
export function exchangeMatrixLogin(input: { homeserver: string; login_token: string }, signal?: AbortSignal, fetcher?: typeof fetch) {
  return matrixLogin(input.homeserver, { type: 'm.login.token', token: input.login_token }, signal, fetcher);
}
export function matrixPasswordLogin(input: { homeserver: string; user: string; password: string }, signal?: AbortSignal, fetcher?: typeof fetch) {
  return matrixLogin(input.homeserver, { type: 'm.login.password', identifier: { type: 'm.id.user', user: input.user }, password: input.password }, signal, fetcher);
}
