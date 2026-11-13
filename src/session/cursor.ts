import type { SessionCursorStore } from './contract.ts';

const SEEN_CAP = 2000;

export async function loadOffset(store: SessionCursorStore, scope: string): Promise<number> {
  const raw = await store.load(scope);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; offset?: unknown };
    if (parsed.v === 1 && typeof parsed.offset === 'number' &&
        Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) return parsed.offset;
  } catch { /* The host stores this JSON opaquely. A bad value starts a fresh cursor. */ }
  return 0;
}
export function offsetCursor(offset: number): string {
  return JSON.stringify({ v: 1, offset });
}
export async function loadSeen(store: SessionCursorStore, scope: string): Promise<string[]> {
  const raw = await store.load(scope);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; seen?: unknown };
    if (parsed.v === 1 && Array.isArray(parsed.seen)) {
      return parsed.seen.filter((item): item is string => typeof item === 'string').slice(-SEEN_CAP);
    }
  } catch { /* fresh cursor */ }
  return [];
}
export function seenCursor(seen: readonly string[]): string {
  const kept = seen.slice(-SEEN_CAP);
  return JSON.stringify({ v: 1, seen: kept });
}
export async function remember(store: SessionCursorStore, scope: string, seen: string[], key: string): Promise<void> {
  if (!seen.includes(key)) seen.push(key);
  while (seen.length > SEEN_CAP) seen.shift();
  await store.save(scope, seenCursor(seen));
}
export async function loadBuf(store: SessionCursorStore, scope: string): Promise<string> {
  const raw = await store.load(scope);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; buf?: unknown };
    if (parsed.v === 1 && typeof parsed.buf === 'string') return parsed.buf;
  } catch { /* fresh cursor */ }
  return '';
}
export function bufCursor(buf: string): string {
  return JSON.stringify({ v: 1, buf });
}
