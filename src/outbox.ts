import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeliveryInput, DeliveryStatus, DeliveryView, SendResult } from './contracts.ts';

interface Row {
  delivery_id: string; idempotency_key: string; fingerprint: string; channel_id: string;
  category: DeliveryInput['category']; correlation_ref: string | null; status: DeliveryStatus;
  attempt: number; created_at: string; expires_at: string; instance_revision: string;
  channel_revision: string; account_epoch: string | null; lease_until: number | null;
  dispatch_started: number; result: string | null;
}
function view(row: Row): DeliveryView {
  return { delivery_id: row.delivery_id, channel_id: row.channel_id, status: row.status,
    attempt: row.attempt, created_at: row.created_at, expires_at: row.expires_at,
    result: row.result === null ? null : JSON.parse(row.result) as SendResult };
}
export class Outbox {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32' && existsSync(path) && (statSync(path).mode & 0o077)) {
        throw new Error('insecure_store_permissions');
      }
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
        fingerprint TEXT NOT NULL, channel_id TEXT NOT NULL, category TEXT NOT NULL,
        correlation_ref TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, instance_revision TEXT NOT NULL,
        channel_revision TEXT NOT NULL, lease_until INTEGER, result TEXT,
        account_epoch TEXT, dispatch_started INTEGER NOT NULL DEFAULT 0
      );`);
    const columns = this.db.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'account_epoch')) {
      // Legacy queued rows have NULL epoch and will fail closed; no token-derived migration.
      this.db.exec('ALTER TABLE deliveries ADD COLUMN account_epoch TEXT');
    }
    if (!columns.some((column) => column.name === 'dispatch_started')) {
      this.db.exec('ALTER TABLE deliveries ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 0');
    }
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version < 3) {
      // Old claimed deliveries have no reliable external-send boundary: never replay them.
      // Earlier script receipts might include secrets; remove legacy result fields too.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`UPDATE deliveries SET status = 'unknown', lease_until = NULL,
          result = '{"status":"unknown","message_ids":[],"retryable":false,"error_kind":"unknown","diagnostic_code":"send_interrupted"}'
          WHERE status = 'sending'`);
        if (version < 2) this.db.exec('UPDATE deliveries SET result = NULL');
        this.db.exec('PRAGMA user_version = 3; COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  close(): void { this.db.close(); }
  enqueue(input: DeliveryInput, instanceRevision: string, channelRevision: string,
    accountEpoch: string, now = new Date()): DeliveryView {
    if (!input || typeof input !== 'object' ||
        typeof input.idempotency_key !== 'string' || !input.idempotency_key ||
        input.idempotency_key.length > 256 || typeof input.channel_id !== 'string' ||
        !input.channel_id || input.channel_id.length > 120 ||
        !['work_complete', 'question_pending', 'task_failed'].includes(input.category) ||
        (input.correlation_ref !== undefined &&
         (typeof input.correlation_ref !== 'string' || input.correlation_ref.length > 256))) {
      throw new Error('invalid_delivery');
    }
    const expires = Date.parse(input.expires_at);
    if (!Number.isFinite(expires) || new Date(expires).toISOString() !== input.expires_at ||
        expires <= now.getTime() || expires > now.getTime() + 7 * 86_400_000) {
      throw new Error('invalid_expiry');
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(accountEpoch)) {
      throw new Error('invalid_account_epoch');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      input.channel_id, input.category, input.expires_at, input.correlation_ref ?? null,
      instanceRevision, channelRevision, accountEpoch,
    ])).digest('hex');
    const existing = this.db.prepare('SELECT * FROM deliveries WHERE idempotency_key = ?')
      .get(input.idempotency_key) as Row | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      return view(existing);
    }
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO deliveries (delivery_id, idempotency_key, fingerprint,
        channel_id, category, correlation_ref, status, attempt, created_at, expires_at,
        instance_revision, channel_revision, account_epoch)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`)
        .run(id, input.idempotency_key, fingerprint, input.channel_id, input.category,
          input.correlation_ref ?? null, now.toISOString(), input.expires_at,
          instanceRevision, channelRevision, accountEpoch);
    } catch (error) {
      // Another process may have won the unique key; never replace its result.
      const winner = this.db.prepare('SELECT * FROM deliveries WHERE idempotency_key = ?')
        .get(input.idempotency_key) as Row | undefined;
      if (!winner) throw error;
      if (winner.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      return view(winner);
    }
    return this.get(id)!;
  }
  get(id: string): DeliveryView | undefined {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(id) as Row | undefined;
    return row && view(row);
  }
  recover(now = new Date()): void {
    this.db.prepare(`UPDATE deliveries SET status = 'unknown', lease_until = NULL,
      result = ? WHERE status = 'sending' AND lease_until <= ?`)
      .run(JSON.stringify({ status: 'unknown', message_ids: [], retryable: false,
        error_kind: 'unknown', diagnostic_code: 'send_interrupted' }), now.getTime());
    this.db.prepare(`UPDATE deliveries SET status = 'expired' WHERE status = 'queued'
      AND expires_at <= ?`).run(now.toISOString());
  }
  claim(now = new Date()): Row | undefined {
    this.recover(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = this.db.prepare(`SELECT * FROM deliveries WHERE status = 'queued'
        ORDER BY created_at, delivery_id LIMIT 1`).get() as Row | undefined;
      if (!candidate) { this.db.exec('COMMIT'); return undefined; }
      const lease = now.getTime() + 125_000;
      this.db.prepare(`UPDATE deliveries SET status = 'sending', attempt = attempt + 1,
        dispatch_started = 0, lease_until = ? WHERE delivery_id = ? AND status = 'queued'`)
        .run(lease, candidate.delivery_id);
      const claimed = this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
        .get(candidate.delivery_id) as unknown as Row | undefined;
      if (!claimed) throw new Error('claimed_row_missing');
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stillClaimed(row: Row, now = Date.now()): boolean {
    const current = this.db.prepare(`SELECT 1 FROM deliveries WHERE delivery_id = ?
      AND status = 'sending' AND attempt = ? AND lease_until = ? AND lease_until > ?`)
      .get(row.delivery_id, row.attempt, row.lease_until, now);
    return current !== undefined;
  }
  dispatched(row: Row): boolean {
    return this.db.prepare(`SELECT 1 FROM deliveries WHERE delivery_id = ?
      AND status = 'sending' AND attempt = ? AND dispatch_started = 1`)
      .get(row.delivery_id, row.attempt) !== undefined;
  }
  beginDispatch(row: Row, now = Date.now()): boolean {
    // The only transition granting an external side effect. CAS is serialized by SQLite
    // against cancel in other processes; any later cancellation is possibly too late.
    return this.db.prepare(`UPDATE deliveries SET dispatch_started = 1 WHERE delivery_id = ?
      AND status = 'sending' AND dispatch_started = 0 AND attempt = ?
      AND lease_until = ? AND lease_until > ? AND expires_at > ?`)
      .run(row.delivery_id, row.attempt, row.lease_until, now,
        new Date(now).toISOString()).changes === 1;
  }
  finish(row: Row, status: DeliveryStatus, result: SendResult | null): boolean {
    const changed = this.db.prepare(`UPDATE deliveries SET status = ?, result = ?, lease_until = NULL
      WHERE delivery_id = ? AND status = 'sending' AND attempt = ? AND lease_until = ?`)
      .run(status, result && JSON.stringify(result), row.delivery_id, row.attempt, row.lease_until);
    return changed.changes === 1;
  }
  cancel(id: string): boolean {
    if (this.db.prepare(`UPDATE deliveries SET status = 'cancelled', lease_until = NULL
      WHERE delivery_id = ? AND (status = 'queued' OR
        (status = 'sending' AND dispatch_started = 0))`).run(id).changes === 1) return true;
    this.db.prepare(`UPDATE deliveries SET status = 'unknown', lease_until = NULL,
      result = ? WHERE delivery_id = ? AND status = 'sending' AND dispatch_started = 1`)
      .run(JSON.stringify({ status: 'unknown', message_ids: [], retryable: false,
        error_kind: 'unknown', diagnostic_code: 'cancel_after_dispatch' }), id);
    return false;
  }
}
export type ClaimedDelivery = NonNullable<ReturnType<Outbox['claim']>>;
