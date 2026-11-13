import { randomUUID } from 'node:crypto';
import { createClient, Method } from 'matrix-js-sdk';
import type { RealtimeConnection, SessionCursorStore, SessionSpec } from './contract.ts';
import { createRealtimeSessionAdapter, object, PlatformFault, REALTIME_LIMITS, str } from './realtime.ts';

type MatrixSpec = Extract<SessionSpec, { platform: 'matrix' }>;
function fault(error: unknown): never {
  const e = object(error); const code = str(e.errcode); const status = Number(e.httpStatus);
  if (['M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN'].includes(code) || status === 401) throw new PlatformFault('auth', 'matrix_auth');
  if (status === 403) throw new PlatformFault('forbidden', 'matrix_forbidden');
  if (status === 404) throw new PlatformFault('not_found', 'matrix_not_found');
  if (status === 429) throw new PlatformFault('rate_limited', 'matrix_rate_limited');
  if (status === 400) throw new PlatformFault('bad_format', 'matrix_bad_request');
  throw error;
}
export function matrixHomeserver(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('matrix_homeserver_https_required');
  return url.href.replace(/\/$/, '');
}
export function createMatrixConnection(homeserver: string, token: string): RealtimeConnection {
  const baseUrl = matrixHomeserver(homeserver);
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return logger; } };
  const client = createClient({ baseUrl, accessToken: token, useAuthorizationHeader: true, logger,
    fetchFn: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'error' });
      if (!String(url).includes('/media/download/') || !response.ok || !response.body) return response;
      const cap = REALTIME_LIMITS.matrix.media_bytes;
      if (Number(response.headers.get('content-length') ?? 0) > cap) { await response.body.cancel(); throw new Error('media_too_large'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > cap) { await reader.cancel(); throw new Error('media_too_large'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } });
  const encrypted = new Set<string>();
  const direct = new Set<string>();
  // SDK timeoutSignal leaves referenced timers after requests; native timeout signals do not hold the host open.
  const opts = (signal: AbortSignal) => ({ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(40000)]) });
  return {
    async run(handlers, store, scope, signal) {
      try {
        const me = await client.http.authedRequest<{ user_id: string }>(Method.Get, '/account/whoami', undefined, undefined, opts(signal));
        if (!me.user_id) throw new PlatformFault('auth', 'matrix_auth');
        // Account identity is established before admitting any event after a process restart.
        handlers.onReady(me.user_id);
        try {
          const dm = await client.http.authedRequest<Record<string, unknown>>(Method.Get,
            `/user/${encodeURIComponent(me.user_id)}/account_data/m.direct`, undefined, undefined, opts(signal));
          direct.clear();
          for (const rooms of Object.values(dm)) if (Array.isArray(rooms)) for (const room of rooms) if (typeof room === 'string') direct.add(room);
        } catch (error) { if (object(error).errcode !== 'M_NOT_FOUND') throw error; }
        let since = await store.load(`${scope}:matrix_sync`);
        // First sync establishes a baseline instead of replaying a room's old history as new requests.
        let baseline = !since;
        while (!signal.aborted) {
          const page = await client.http.authedRequest<Record<string, unknown>>(Method.Get, '/sync', {
            ...(since ? { since } : {}), timeout: baseline ? 0 : 25000,
            filter: JSON.stringify({ room: { timeline: { limit: 100 }, state: { lazy_load_members: true } } }),
          }, undefined, opts(signal));
          const account = object(page.account_data);
          for (const raw of Array.isArray(account.events) ? account.events : []) {
            const event = object(raw);
            if (event.type === 'm.direct') {
              direct.clear();
              for (const rooms of Object.values(object(event.content))) if (Array.isArray(rooms)) for (const room of rooms) if (typeof room === 'string') direct.add(room);
            }
          }
          const rooms = object(object(page.rooms).join);
          for (const [roomId, raw] of Object.entries(rooms)) {
            const room = object(raw);
            const state = object(room.state); const timeline = object(room.timeline);
            const stateEvents = Array.isArray(state.events) ? state.events : [];
            const events = Array.isArray(timeline.events) ? timeline.events : [];
            for (const raw of [...stateEvents, ...events]) {
              const event = object(raw);
              if (event.type === 'm.room.encryption') encrypted.add(roomId);
            }
            if (!baseline && !encrypted.has(roomId)) for (const raw of events) {
              await handlers.onEvent({ ...object(raw), room_id: roomId, is_direct: direct.has(roomId) });
            }
          }
          const next = str(page.next_batch);
          if (!next) throw new Error('matrix_invalid_sync');
          if (signal.aborted) break;
          await store.save(`${scope}:matrix_sync`, next);
          since = next;
          baseline = false;
          handlers.onReady(me.user_id);
        }
      } catch (error) { fault(error); }
    },
    async send(request, signal) {
      try {
        if (!request.chat_id.startsWith('!')) throw new PlatformFault('bad_format', 'matrix_room_id');
        // A joined encrypted room must never receive an accidental plaintext message.
        try {
          await client.http.authedRequest(Method.Get, `/rooms/${encodeURIComponent(request.chat_id)}/state/m.room.encryption/`, undefined, undefined, opts(signal));
          encrypted.add(request.chat_id);
        } catch (error) { if (object(error).errcode !== 'M_NOT_FOUND') throw error; }
        if (encrypted.has(request.chat_id)) throw new PlatformFault('unsupported', 'matrix_encryption_unsupported');
        const content: Record<string, unknown> = { msgtype: 'm.text', body: request.text ?? '' };
        if (request.media) {
          const media = request.media;
          const upload = await client.http.authedRequest<{ content_uri: string }>(Method.Post, '/upload', { filename: media.filename },
            Buffer.from(media.bytes), { ...opts(signal), prefix: '/_matrix/media/v3', headers: { 'Content-Type': media.mime } });
          if (!upload.content_uri) throw new Error('matrix_missing_upload_receipt');
          Object.assign(content, { msgtype: media.kind === 'image' ? 'm.image' : media.kind === 'audio' || media.kind === 'voice' ? 'm.audio' : media.kind === 'video' ? 'm.video' : 'm.file',
            body: request.text || media.filename, filename: media.filename, url: upload.content_uri,
            info: { mimetype: media.mime, size: media.bytes.byteLength } });
          // Native Matrix voice events require duration/waveform metadata; generic voice bytes are sent as m.audio.
        }
        if (request.op === 'edit') {
          content['m.new_content'] = { ...content };
          content['m.relates_to'] = { rel_type: 'm.replace', event_id: request.message_id };
          content.body = `* ${request.text ?? ''}`;
        } else if (request.topic_id) content['m.relates_to'] = { rel_type: 'm.thread', event_id: request.topic_id,
          is_falling_back: true, 'm.in_reply_to': { event_id: request.reply_id || request.topic_id } };
        else if (request.reply_id) content['m.relates_to'] = { 'm.in_reply_to': { event_id: request.reply_id } };
        const result = await client.http.authedRequest<{ event_id: string }>(Method.Put,
          `/rooms/${encodeURIComponent(request.chat_id)}/send/m.room.message/${randomUUID()}`, undefined, content, opts(signal));
        if (!result.event_id) throw new Error('matrix_missing_receipt');
        return [result.event_id];
      } catch (error) { return fault(error); }
    },
    async download(mxc, signal) {
      if (!/^mxc:\/\/[^/?#]+\/[^/?#]+$/.test(mxc)) throw new Error('matrix_mxc_required');
      const parsed = new URL(mxc);
      // Authenticated media stays on the configured homeserver, not a remote URL supplied by a sender.
      const response = await client.http.authedRequest<Blob>(Method.Get,
        `/media/download/${encodeURIComponent(parsed.host)}/${encodeURIComponent(parsed.pathname.slice(1))}`,
        undefined, undefined, { ...opts(signal), prefix: '/_matrix/client/v1', rawResponseBody: true });
      if (response.size > REALTIME_LIMITS.matrix.media_bytes) throw new Error('media_too_large');
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
export function createMatrixSessionAdapter(spec: MatrixSpec, store: SessionCursorStore) {
  return createRealtimeSessionAdapter(spec, store, spec.connection ?? createMatrixConnection(spec.homeserver, spec.access_token));
}
