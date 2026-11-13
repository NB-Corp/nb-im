import type { SessionAdapter, SessionCursorStore, SessionSpec } from './contract.ts';
import { createFeishuSessionAdapter } from './feishu.ts';
import { createOneBotSessionAdapter } from './onebot.ts';
import { findShared, sessionFingerprint } from './registry.ts';
import { createTelegramSessionAdapter } from './telegram.ts';
import { createWechatSessionAdapter } from './wechat.ts';
import { createDiscordSessionAdapter } from './discord.ts';
import { createSlackSessionAdapter } from './slack.ts';
import { createMatrixSessionAdapter } from './matrix.ts';

export interface SessionHub {
  acquire(spec: SessionSpec): SessionAdapter;
  find(spec: SessionSpec): SessionAdapter | undefined;
  release(spec: SessionSpec): Promise<void>;
}
export function createSessionHub(input: { store: SessionCursorStore }): SessionHub {
  const store = input.store;
  const hub: SessionHub = {
    acquire(spec) {
      if (spec.platform === 'telegram') return createTelegramSessionAdapter(spec, store);
      if (spec.platform === 'feishu_app') return createFeishuSessionAdapter(spec, store);
      if (spec.platform === 'qq_onebot_v11') return createOneBotSessionAdapter(spec, store);
      if (spec.platform === 'discord') return createDiscordSessionAdapter(spec, store);
      if (spec.platform === 'slack') return createSlackSessionAdapter(spec, store);
      if (spec.platform === 'matrix') return createMatrixSessionAdapter(spec, store);
      return createWechatSessionAdapter(spec, store);
    },
    find(spec) {
      try { return findShared(sessionFingerprint(spec)); }
      catch { return undefined; }
    },
    async release(spec) {
      const found = hub.find(spec);
      if (found) await found.stop();
    },
  };
  return hub;
}
