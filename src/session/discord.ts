import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import type { RealtimeConnection, SessionCursorStore, SessionSpec } from './contract.ts';
import { abortError } from './contract.ts';
import { createRealtimeSessionAdapter, object, PlatformFault, REALTIME_LIMITS, str } from './realtime.ts';
import { downloadPlatformMedia } from './media-http.ts';

type DiscordSpec = Extract<SessionSpec, { platform: 'discord' }>;
function fault(error: unknown): never {
  const e = object(error); const status = Number(e.status); const code = Number(e.code);
  if (status === 401 || code === 4004 || code === 50014 || e.code === 'TokenInvalid') throw new PlatformFault('auth', 'discord_auth');
  if (code === 4013 || code === 4014) throw new PlatformFault('conflict', 'discord_intents_required');
  if (status === 403) throw new PlatformFault('forbidden', 'discord_forbidden');
  if (status === 404) throw new PlatformFault('not_found', 'discord_not_found');
  if (status === 429) throw new PlatformFault('rate_limited', 'discord_rate_limited');
  if (status === 400) throw new PlatformFault('bad_format', 'discord_bad_request');
  throw error;
}
export function createDiscordConnection(token: string, rest = new REST({ version: '10', retries: 0, timeout: 15000 }).setToken(token)): RealtimeConnection {
  return {
    async run(handlers, _store, _scope, signal) {
      signal.throwIfAborted();
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel],
        rest: { retries: 0, timeout: 15000 } });
      let finish!: () => void; let fail!: (error: unknown) => void;
      const ended = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      // Attach immediately so an error during login cannot become an unhandled rejection.
      void ended.catch(() => undefined);
      const stop = () => { void client.destroy().then(finish, fail); };
      signal.addEventListener('abort', stop, { once: true });
      client.on(Events.ClientReady, (ready) => handlers.onReady(ready.user.id));
      client.on(Events.ShardReconnecting, () => handlers.onReconnecting());
      client.on(Events.ShardResume, () => { if (client.user) handlers.onReady(client.user.id); });
      client.on(Events.ShardDisconnect, (event) => {
        if ([4004, 4013, 4014].includes(event.code)) fail({ code: event.code });
        else if (!signal.aborted) handlers.onReconnecting();
      });
      client.on(Events.Error, fail);
      client.on(Events.MessageCreate, (message) => {
        const channel = message.channel;
        // Discord API field names; normalize() in realtime.ts reads this shape.
        const raw = { ...object(message.toJSON()), id: message.id, type: message.type, content: message.content,
          channel_id: message.channelId, timestamp: message.createdAt.toISOString(),
          webhook_id: message.webhookId ?? undefined,
          author: { id: message.author.id, bot: message.author.bot, username: message.author.username,
            global_name: message.author.globalName ?? undefined },
          member: message.member ? { nick: message.member.nickname ?? undefined } : undefined,
          mentions: [...message.mentions.users.keys()],
          referenced_message: message.mentions.repliedUser ? { author: { id: message.mentions.repliedUser.id } } : undefined,
          message_reference: message.reference ? { message_id: message.reference.messageId } : undefined,
          channel: { type: channel.type, parent_id: channel.isThread() ? channel.parentId : undefined,
            name: 'name' in channel ? channel.name ?? undefined : undefined,
            parent_name: channel.isThread() ? channel.parent?.name : undefined },
          attachments: [...message.attachments.values()].map((a) => ({ id: a.id, url: a.url,
            filename: a.name, content_type: a.contentType, size: a.size, duration_secs: a.duration ?? undefined })) };
        void handlers.onEvent(raw).catch(fail);
      });
      try {
        await Promise.race([client.login(token), ended]);
        if (!signal.aborted) await ended;
      } catch (error) { fault(error); }
      finally { signal.removeEventListener('abort', stop); await client.destroy(); }
    },
    async send(request, signal) {
      if (signal.aborted) throw abortError();
      if (!/^\d{1,22}$/.test(request.chat_id) || (request.topic_id && !/^\d{1,22}$/.test(request.topic_id))) throw new PlatformFault('bad_format', 'discord_channel_id');
      const channel = request.topic_id ?? request.chat_id;
      const body: Record<string, unknown> = { content: request.text ?? '', allowed_mentions: { parse: [], replied_user: false } };
      if (request.op !== 'edit' && request.reply_id) body.message_reference = { message_id: request.reply_id, fail_if_not_exists: false };
      if (request.media) body.attachments = [{ id: 0, filename: request.media.filename || 'attachment' }];
      try {
        const result = await (request.op === 'edit' ? rest.patch(Routes.channelMessage(channel, request.message_id ?? ''), { body, signal }) :
          rest.post(Routes.channelMessages(channel), { body, signal,
            ...(request.media ? { files: [{ name: request.media.filename || 'attachment', contentType: request.media.mime, data: Buffer.from(request.media.bytes) }] } : {}) }));
        const id = str(object(result).id);
        if (!id) throw new Error('discord_missing_receipt');
        return [id];
      } catch (error) { return fault(error); }
    },
    download: (url, signal) => downloadPlatformMedia(url, { platform: 'discord', cap: REALTIME_LIMITS.discord.media_bytes, signal }),
  };
}
export function createDiscordSessionAdapter(spec: DiscordSpec, store: SessionCursorStore) {
  return createRealtimeSessionAdapter(spec, store, spec.connection ?? createDiscordConnection(spec.bot_token));
}
