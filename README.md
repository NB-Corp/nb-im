# @nb-corp/nb-im

Bidirectional messaging sessions and a separate durable notification outbox for Node >=24.15. Version 0.3.1 includes Discord, Slack, unencrypted Matrix and WeCom AI-bot sessions alongside the Telegram, Feishu, OneBot v11 and WeChat iLink adapters, plus Node 24 pinned IPv4, multipart rich-message ordering, and inbound reconnect watchdogs. The adapters use pinned SDKs, return typed receipts, and leave authorization and agent turns to the host.

## Receive a message and reply

```ts
import { createSessionHub } from '@nb-corp/nb-im';

// Replace this Map with durable host storage before deployment.
const cursors = new Map<string, string>();
const hub = createSessionHub({ store: {
  async load(scope) { return cursors.get(scope); },
  async save(scope, cursor) { cursors.set(scope, cursor); },
} });
const spec = { platform: 'slack', instance_id: 'work',
  bot_token: secrets.bot_token, app_token: secrets.app_token } as const;
const session = hub.acquire(spec);
await session.start({
  async admit(event) {
    // Authorize identity, durably enqueue the event by event_key, then return.
    // Do not wait for an agent turn here. Return defer if admission is unavailable.
    await hostInbox.enqueue(event);
    return { decision: 'accepted' };
  },
});

// When the host has a response, preserve the target from its admitted event.
await session.send({ type: 'text', target: {
  chat_id: event.identity.chat_id, topic_id: event.identity.topic_id,
  reply_context: event.reply_context,
}, text: 'Received.' }, abortSignal);
await hub.release(spec);
```

`SessionHub.acquire/find/release`, `SessionSpec`, `SessionLimits`, `SessionReceipt` and `nb-im-session/1` remain the consumer interface. The same credential shares one live session in a process; use one receiving host per bot/app. Credentials are passed only at acquisition and must stay out of prompts, event keys and diagnostic logs. `reply_context` is an opaque reply handle, not an authentication credential.

A receipt of `accepted` means the platform accepted the operation. It does not mean a person read it. Cancellation before dispatch returns `failed/cancelled`; interruption after an external request may have started returns `unknown/cancelled_after_dispatch`. Do not automatically replay an unknown send.

## Inbound metadata

Besides `identity`, `payload` and `reply_context`, a `SessionInbound` carries optional metadata copied from the platform payload. A field is absent when the platform did not send it; nb-im never fabricates it.

| Field | Meaning | Populated by |
| --- | --- | --- |
| `identity.chat_kind` | `private` or `group` | all adapters (Telegram/Feishu when the chat type is known) |
| `identity.sender_name` | display name of the sender | Telegram, OneBot (`card` or `nickname`), Discord (nick, global or user name), Slack (`user_profile`, when sent), Matrix (member names seen in sync), script |
| `identity.chat_title` | group/channel/room name | Telegram, OneBot (`group_name`, when the implementation sends it), Discord (channel; parent channel for threads), Matrix (`m.room.name` seen in sync), script |
| `timestamp` | send time, ms since epoch | all adapters |
| `mentioned`, `mention_ids` | the bot was addressed / IDs that were @-mentioned | Telegram, Feishu, OneBot (`at`), Discord (also a reply to the bot), Slack (`<@…>`, `app_mention`, a reply in a thread the bot started), Matrix (`m.mentions`, legacy pills), script |
| `reply_to_message_id` | message this one replies to | Telegram, Feishu, OneBot (`reply`), WeChat (`ref_msg`), Discord, Slack (thread root), Matrix (`m.in_reply_to`, not the thread fallback), script |
| `source_message_id` | platform message ID (for an edit/retract: the original message) | all adapters |
| `operation` | `create`, `edit` or `retract`; absent means `create` | Telegram, Discord, Slack, Matrix, script |
| `is_self` | authored by the connected bot/account | Telegram, Feishu, script; the others only with `include_self` |

Two optional `SessionSpec` fields widen what is admitted. Both default to `false`, which keeps today's behaviour:

- `include_self: true` admits the account's own messages with `is_self: true`: Discord/Slack/Matrix messages from the bot user, WeChat iLink bot messages, OneBot `post_type: 'message_sent'` (private ones use `target_id` as `chat_id`). Hosts that act on inbound messages must not answer these.
- `include_edits: true` admits Slack `message_changed` (user edits only, not link unfurls) / `message_deleted` and Matrix `m.replace` / `m.room.redaction` as `operation: 'edit' | 'retract'`. `source_message_id` names the original message, an edit's payload is the new text, a retract's is empty text, and each has its own `event_key`. A Matrix edit does not carry its thread, so its `topic_id` is `'0'`; a redaction's `sender_id` is whoever redacted.

Options other than credentials are not part of the session fingerprint: the first `acquire` of a credential decides them.

## Configure the new sessions

`SESSION_SETUP` exposes setup methods, required credential fields and instructions. `SESSION_CAPABILITIES` describes the three new adapters; it is not the notification-provider registry. Hosts should render these descriptors rather than infer support from a platform name.

| Platform | `SessionSpec` fields beyond `platform`, `instance_id` | Start with |
| --- | --- | --- |
| `discord` | `bot_token` | `discordInstallUrl(application_id)` |
| `slack` | `bot_token`, `app_token` | `slackManifestInstallUrl()` |
| `matrix` | `homeserver`, `access_token` | `discoverMatrix(user_id_or_domain)` |

### Discord

Create an application at the Discord developer portal and copy its bot token once. Enable **Message Content Intent** under Bot. `discordInstallUrl(application_id, guild_id?)` opens Discord's bot installation flow with View Channel, Send Messages, Attach Files, Read Message History and Send Messages in Threads permissions. Bot installation does not issue a bot token; user-account tokens are not supported.

The connection uses `discord.js@14.27.0` for gateway heartbeat, resume, reconnect and REST multipart uploads. Discord threads retain the parent channel as `chat_id` and thread channel as `topic_id`. DMs use `topic_id:'0'`. A missing privileged intent reports `conflict`; an invalid token reports `auth_expired`.

### Slack

1. Open `slackManifestInstallUrl(name?)`. The manifest preconfigures Socket Mode, bot scopes, DMs, channel messages and file read/write access.
2. Install the app to the workspace. If the host has an OAuth application, use `slackOAuthUrl({client_id,redirect_uri,state})` and `exchangeSlackOAuth(...)` to receive the bot token directly. The exchange requires matching `state` and `expected_state`; the host owns the pending setup attempt and callback listener.
3. Generate one app-level token with `connections:write` in Basic Information. Slack OAuth does not issue this token. Store it as `app_token` and the installation bot token as `bot_token`.
4. Invite the bot to the channels it should read. No public webhook URL or signing secret is required for Socket Mode.

`@slack/socket-mode@3.1.0` owns websocket lifecycle; `@slack/web-api@8.2.0` handles Web API calls. Media uses the supported external-upload/V2 sequence, not retired `files.upload`. `chat_id` is a channel/DM ID, `topic_id` is `thread_ts` or `'0'`, and `reply_context` is the received message timestamp. Passing the original target replies in its existing thread or starts a reply thread to the received top-level message. Media receipts contain file IDs; text/edit receipts contain message timestamps.

### Matrix

`discoverMatrix('@user:example.org')` reads `/.well-known/matrix/client`, then the server's login flows. Review the discovered `homeserver` before starting login. If SSO is offered, open `matrixSsoUrl(homeserver, callback_uri)` and pass its one-use `loginToken` to `exchangeMatrixLogin({homeserver,login_token})`. Bind that callback to the host's setup attempt. `matrixPasswordLogin(...)` is available on servers that offer password login. Store the returned `access_token`; `whoami` obtains the account ID. Helpers do not read another app's credential files or persist passwords.

This adapter uses `matrix-js-sdk@44.0.0` and joined **unencrypted** rooms. Join rooms with a Matrix client first. It does not auto-accept invitations or initialize a crypto/device store. Encrypted timelines are not admitted, and sending into a room with `m.room.encryption` returns `matrix_encryption_unsupported` instead of sending plaintext. `topic_id` is the `m.thread` root event ID or `'0'`; `reply_context` is the incoming event ID. Matrix event IDs beginning with `$` are retained in receipts.

The first sync establishes a baseline without replaying old room history. Later sync tokens advance only after covered events are admitted. Discord's gateway resumes within a connection lifetime; Slack envelopes are acknowledged after host admission and follow Slack's retry window. These transports do not provide an unlimited offline inbox. All three retain bounded accepted-event keys for deduplication; the host should also deduplicate durable admission by `event_key`.

### WeCom AI bot (`wecom_aibot`)

`SessionSpec` fields: `bot_id`, `secret`. In the WeCom admin console, open the AI bot (智能机器人), choose API mode with the **long connection** (长连接), and copy its Bot ID and long-connection Secret; no public URL, Token or EncodingAESKey is needed. The adapter connects to `wss://openws.work.weixin.qq.com`, subscribes (`aibot_subscribe`), pings every 30 s and reconnects with back-off. WeCom keeps one connection per bot: when another client subscribes with the same bot, this one receives `disconnected_event` and stops in `conflict` instead of taking the bot back. Three refused subscribes end in `auth_expired`. The fingerprint is the bot id alone.

What WeCom delivers: every DM message (text, image, text+image, voice as its transcript, file, video) and, in groups, only messages that @ the bot (text, text+image, quotes). `chat_id` is the group's `chatid` or, in a DM, the sender's `userid`; `sender_id` is the `userid` (plain text only when the bot's creator is a super admin). WeCom sends no display names or chat titles. Every event is `mentioned: true`. Media URLs are valid five minutes and encrypted per URL (`aeskey`); the adapter downloads them over pinned public HTTPS (30 MiB cap) and decrypts them (`decryptWecomMedia`). A quoted message becomes `quoted_text`.

Sending: the first reply to a callback within five minutes answers it (`aibot_respond_msg`, one finished stream, `reply_context` carries the callback's `req_id`); everything else is a push (`aibot_send_msg`, markdown up to 20,480 UTF-8 bytes, or media), which WeCom accepts only in chats where the user has talked to the bot. Media is uploaded as temporary material over the connection (512 KB chunks): images (png/jpeg/gif) and mp4 video up to 10 MiB, amr voice up to 2 MiB, anything else as a file up to 20 MiB. Edits and buttons are `unsupported`. WeCom limits each conversation to 30 messages a minute and 1,000 an hour; a refusal is `failed` with `wecom_aibot_errcode_<n>`, a missing ack is `unknown`.

## Text and media support

All three new adapters receive/send text, images, files, audio and video bytes; they support thread replies and text edits. Multiple attachments become separately keyed inbound media events with the message's caption. Files are downloaded, not handed to the host as remote URLs. Discord/Slack downloads use allowlisted, DNS-pinned public CDN connections; Slack bearer credentials are only attached to its designated file hosts. Matrix uses authenticated homeserver media download. Downloads and sends respect these package caps; a server may enforce a lower limit.

| Platform | Text characters per send | Media bytes per file |
| --- | ---: | ---: |
| Discord | 2,000 | 10 MiB |
| Slack | 40,000 | 100 MiB |
| Matrix | 16,000 | 50 MiB |

`text_parts` sends ordered parts and reports partial message IDs plus `failed_part` if a part fails. Call `splitSessionText` when needed. New adapters reject buttons and `callback_ack` with `unsupported`.

**Voice notes are distinct from audio.** The new adapters recognize native inbound Discord voice attachments and Matrix voice markers, but reject outbound `kind:'voice'` with `${platform}_native_voice_unsupported`. They do not invent duration, waveform or codec metadata. Use explicit `kind:'audio'` to send an ordinary attachment in Discord/Slack or `m.audio` in Matrix; that is not a native voice-note promise. Existing Telegram/Feishu/OneBot/WeChat voice behavior is unchanged. The old four adapters reject the newly added `audio`/`video` kinds instead of silently coercing them to an image or file.

`auth_expired` requires replacing credentials and reacquiring the session. Transient receive failures use the existing bounded reconnect backoff and expose redacted `connection_detail`. `stop()` aborts owned receive work and in-flight sends that use the session signal; stopped instances are removed from the shared pool.

## Custom channels (script)

`platform: 'script'` runs any executable as a channel. nb-im spawns `command` (argv array, no shell) with `cwd` and a minimal environment (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, plus `env` and `NB_IM_PROTOCOL`, `NB_IM_INSTANCE_ID`); host secrets are not inherited. The two speak protocol `nb-im-script/1`: one UTF-8 JSON object per `\n`-terminated line on stdin/stdout. stderr lines go to `on_log`.

```ts
const spec = { platform: 'script', instance_id: 'my-channel',
  command: [process.execPath, '/abs/path/script-channel-echo.mjs'],
  env: { MY_TOKEN: secrets.token }, on_log: (line) => logger.info(line) } as const;
```

| Field | Default | Meaning |
| --- | --- | --- |
| `command`, `cwd`, `env` | — | Process to run. Together they form the session fingerprint (one live process per distinct triple). |
| `send_timeout_ms` | 30000 | A send without a `receipt` in time resolves `unknown/script_send_timeout`. |
| `max_line_bytes` | 40 MiB (`SCRIPT_LINE_BYTES`) | Longest accepted stdout line. Longer lines are never buffered: nb-im logs, kills and restarts the script. |
| `retry_ms` | 1000 | Restart backoff base (doubles per consecutive failure, max 30 s) and admit-retry delay. |

### nb-im → script (stdin)

| `type` | Fields | When |
| --- | --- | --- |
| `hello` | `protocol: "nb-im-script/1"`, `instance_id`, `cursor: string \| null` | First line of every process start. `cursor` is the `cursor` of the last message the host admitted (`null` if none yet). Resume from there. |
| `admitted` | `id` | The host durably accepted message `id` (also re-sent for an `id` it had already accepted). Safe to drop it from the script's own queue. |
| `send` | `id`, `message` | Deliver a `SessionOutbound` (`text`, `edit_text`, `text_parts`, `media`, `callback_ack`). For `media`, `message.media` is `{kind, filename, mime, data}` with the bytes base64 in `data`. Answer with one `receipt` carrying the same `id`. |

### script → nb-im (stdout)

| `type` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `account_id?` | Required after `hello`. Marks the session `running` (sends are refused before it) and sets `account.account_id` (default: `instance_id`). |
| `message` | required `id`, `chat_id`, `sender_id`, and `text` and/or `media`; optional `cursor`, `op`, `message_id`, `topic_id`, `topic_title`, `chat_kind` (`private`\|`group`), `chat_title`, `sender_name`, `timestamp` (ms), `mentioned`, `mention_ids`, `reply_to`, `quoted_text`, `is_self`, `reply_context` | One inbound event. `media` is an array of `{kind: image\|file\|voice\|audio\|video, filename, mime, data}` (base64, ≤ 25 MiB each). `op` is `create` (default), `edit` or `retract`. `id` matches `[A-Za-z0-9_.$=+/:~@#-]{1,255}` and **must be stable across restarts**: `event_key` is `script:<instance_id>:<id>`, so replays are deduplicated. `cursor` (default: `id`) is opaque to nb-im, stored only after admission, and handed back in the next `hello`. `reply_context` (default: `id`) comes back in `send.message.target.reply_context`. |
| `receipt` | `id`, `status` (`accepted`\|`failed`\|`unknown`), `message_ids?`, `error_kind?`, `code?` | Result of `send` `id`. `error_kind` is a `SessionErrorKind`; `code` is `[a-z0-9_]{1,64}`. |
| `error` | `code`, `message?` | `code: "auth_expired"` or `"conflict"` stops the session in that state without restart; other codes are only logged. |
| `log` | `message` | Forwarded to `on_log`. |

Messages are admitted one at a time in order; nb-im stops reading stdout while 64 are queued. Non-JSON lines, unknown `type`s and malformed `message` lines are logged and skipped.

### Lifecycle

- On POSIX the script is the leader of its own process group. `stop()` closes its stdin, sends `SIGTERM` to the whole group and `SIGKILL` 3 s later. The group is signalled the same way whenever the leader exits, so helpers it spawned (pollers, browsers) do not outlive it. Helpers that create their own session/group are out of reach.
- **The script must exit when stdin reaches EOF.** If the host exits normally nb-im also sends `SIGTERM` to live groups, but EOF is the only signal left after a hard host kill.
- When the script exits or crashes, sends still waiting for a receipt resolve `unknown/script_exited`, and nb-im restarts it with backoff and a new `hello` carrying the last admitted cursor.

[`examples/script-channel-echo.mjs`](examples/script-channel-echo.mjs) is a complete channel: it greets once, then echoes each send back as an inbound message.

```js
import { createInterface } from 'node:readline';
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let n = 0;
// The loop ends when stdin closes, so the script exits with the host.
for await (const raw of createInterface({ input: process.stdin })) {
  const line = JSON.parse(raw);
  if (line.type === 'hello') {
    out({ type: 'ready', account_id: 'echo-bot' });
    if (!line.cursor) out({ type: 'message', id: 'hello-1', chat_id: 'room-1', chat_kind: 'group',
      sender_id: 'alice', sender_name: 'Alice', text: 'Hello from a script channel', timestamp: Date.now(), cursor: 'c1' });
  } else if (line.type === 'send') {
    n += 1;
    out({ type: 'receipt', id: line.id, status: 'accepted', message_ids: [`out-${n}`] });
    if (line.message.type === 'text') out({ type: 'message', id: `echo-${n}`, chat_id: line.message.target.chat_id,
      sender_id: 'echo', text: `echo: ${line.message.text}`, timestamp: Date.now(), cursor: `c${n + 1}` });
  }
}
```

## Notification outbox (unchanged interface)

Notification providers are outbound-only and separate from the session adapters. `discord_webhook` and `slack_webhook` are not bidirectional sessions. Construct `Runtime(config, sqlitePath, providers, resolveCredential, getAccountEpoch)` for durable notifications; use `createSessionHub` for conversations.

The outbox keeps stable idempotency keys, expiry, config bindings and a host-owned account epoch in SQLite. The host must atomically update its credential resolver and account epoch on credential replacement. Expired/unknown/crash-recovered sends are not replayed automatically. `cancel(id)` succeeds only before the one-shot persisted `beginDispatch` boundary; after dispatch it records an unknown possible delivery rather than pretending to retract it.

Credential slots remain bound to provider ID, instance ID and purpose. For example, Telegram uses `credential_slots.bot={env:'NBIM_BOT',provider_id:'telegram',provider_instance_id:'bot',purpose:'telegram_bot'}` and an instance option `{token_slot:'bot'}`. Secret values belong in the resolver, not the config. Every slot must be used by exactly its declared instance and purpose. Legacy `{env}`-only slots do not validate.

| Notification provider | Instance options | Channel target |
| --- | --- | --- |
| `telegram` | `token_slot` | `{chat_id}` |
| `wecom_webhook` | `key_slot` | `{}` |
| `discord_webhook` | `webhook_id`, `token_slot` | `{}` |
| `slack_webhook` | `path_slot` containing `TEAM/CHANNEL/SECRET` | `{}` |
| `dingtalk_webhook` | `token_slot`, optional `secret_slot`, `keyword` | `{}` |
| `feishu_webhook` | `token_slot`, optional `secret_slot` | `{}` |
| `http` | root-only `endpoint`, `format`, optional `auth_slot`, `path_slot`, `private_grant` | `{}` |

Generic HTTP is fixed POST JSON/form/XML and only confirms HTTP acceptance. Confidential paths are composed from their scoped credential slot at dispatch. It pins validated public A/AAAA resolution to a fresh connection and does not follow redirects. A private exception must match protocol, host, IP and port exactly. Cleartext private exceptions permit only unauthenticated root paths; secret-bearing endpoints require HTTPS. Fixed platform webhook providers use official HTTPS hosts. `script` delivery remains disabled on every OS; SMTP is not registered. Toast requires a host implementation that honors the dispatch permit.

`handleIpc` is a library handler, not an authenticated listener. Hosts must authenticate callers, authorize channels, and enforce `IPC_MAX_FRAME_BYTES=16384` before JSON parsing. Its `nb-im/1` operations remain `enqueue`, `get` and `cancel`; it does not admit prompts or approvals. The host owns authorization, allowlists, prompt routing, DND and activation. A provider acceptance receipt is not permission to run a model or approve an action.

## Build and verify

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

The offline suite exercises the original adapters, the new SessionHub flows, real Discord SDK multipart encoding, a local Slack Socket Mode websocket with envelope acknowledgement and V2 uploads, Matrix authenticated sync/media/thread operations, and setup exchanges. No real account login or platform send has been performed. Real-account checks require operator credentials and permission.

## Reuse and attribution

The batch uses mature SDKs directly and adapts wire identity, thread, media and setup contracts from OpenClaw and Hermes. OpenClaw's plugin runtime/SQLite authority and Hermes's Python gateway are not imported into the package. See `NOTICE` and `LICENSES` for licenses and source identities. Existing notification mappings retain their Apprise and Message-Push-Nest attribution.
