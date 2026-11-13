// Cloud 9 — persistent Telegram outbox (own better-sqlite3 connection, same DB file). Agent SENDER.
import Database from 'better-sqlite3';
import type { OutMsg } from './contracts';

export interface OutboxRow {
  id: number;
  chat_id: string;
  thread_id: number | null;
  kind: 'text' | 'document';
  text: string | null;
  doc_name: string | null;
  doc_mime: string | null;
  doc_content: string | null;
  buttons_json: string | null;
  coalesce_key: string | null;
  priority: number;
  created_at: number;
  next_at: number;
  attempts: number;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  last_error: string | null;
}

export const PRIORITY = { low: 0, normal: 1, high: 2 } as const;
const DAY = 24 * 3600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT,
  doc_name TEXT,
  doc_mime TEXT,
  doc_content TEXT,
  buttons_json TEXT,
  coalesce_key TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_status_next ON telegram_outbox(status, next_at);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_coalesce ON telegram_outbox(chat_id, coalesce_key) WHERE coalesce_key IS NOT NULL;
`;

export interface Outbox {
  enqueue(m: OutMsg, now?: number): void;
  /** Due queued rows, priority DESC then id ASC. */
  due(now: number, limit: number): OutboxRow[];
  /** Earliest next_at among queued rows that are not yet due (null if none). */
  nextFutureAt(now: number): number | null;
  markSending(id: number): void;
  markSent(id: number): void;
  markFailed(id: number, err: string): void;
  reschedule(id: number, nextAt: number, err: string): void;
  expire(olderThan: number): number;
  counts(): { queued: number; sent: number; failed: number };
  close(): void;
}

export function openOutbox(dbPath: string, opts: { maxQueued?: number; purgeAgeMs?: number } = {}): Outbox {
  const maxQueued = opts.maxQueued ?? 5000;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const now0 = Date.now();
  // Purge old terminal rows, and recover rows that were in flight when the process died.
  db.prepare(`DELETE FROM telegram_outbox WHERE status IN ('sent','failed') AND created_at < ?`).run(now0 - (opts.purgeAgeMs ?? 3 * DAY));
  db.prepare(`UPDATE telegram_outbox SET status='queued' WHERE status='sending'`).run();

  const sCoalesce = db.prepare(`UPDATE telegram_outbox SET thread_id=@thread_id, kind=@kind, text=@text, doc_name=@doc_name, doc_mime=@doc_mime,
      doc_content=@doc_content, buttons_json=@buttons_json, priority=@priority, created_at=@created_at
    WHERE id = (SELECT id FROM telegram_outbox WHERE chat_id=@chat_id AND coalesce_key=@coalesce_key AND status='queued' ORDER BY id DESC LIMIT 1)`);
  const sInsert = db.prepare(`INSERT INTO telegram_outbox (chat_id, thread_id, kind, text, doc_name, doc_mime, doc_content, buttons_json, coalesce_key, priority, created_at, next_at)
    VALUES (@chat_id, @thread_id, @kind, @text, @doc_name, @doc_mime, @doc_content, @buttons_json, @coalesce_key, @priority, @created_at, @created_at)`);
  const sCountQueued = db.prepare(`SELECT COUNT(*) AS n FROM telegram_outbox WHERE status='queued'`);
  const sDropOverflow = db.prepare(`UPDATE telegram_outbox SET status='failed', last_error='dropped (outbox full)'
    WHERE id IN (SELECT id FROM telegram_outbox WHERE status='queued' ORDER BY priority ASC, id ASC LIMIT ?)`);
  const sDue = db.prepare(`SELECT * FROM telegram_outbox WHERE status='queued' AND next_at <= ? ORDER BY priority DESC, id ASC LIMIT ?`);
  const sNextFuture = db.prepare(`SELECT MIN(next_at) AS t FROM telegram_outbox WHERE status='queued' AND next_at > ?`);
  const sSending = db.prepare(`UPDATE telegram_outbox SET status='sending', attempts=attempts+1 WHERE id=?`);
  const sSent = db.prepare(`UPDATE telegram_outbox SET status='sent', last_error=NULL, doc_content=NULL WHERE id=?`);
  const sFailed = db.prepare(`UPDATE telegram_outbox SET status='failed', last_error=?, doc_content=NULL WHERE id=?`);
  const sResched = db.prepare(`UPDATE telegram_outbox SET status='queued', next_at=?, last_error=? WHERE id=?`);
  const sExpire = db.prepare(`UPDATE telegram_outbox SET status='failed', last_error='expired', doc_content=NULL WHERE status='queued' AND created_at < ?`);
  const sCounts = db.prepare(`SELECT status, COUNT(*) AS n FROM telegram_outbox GROUP BY status`);

  let queuedEstimate = (sCountQueued.get() as { n: number }).n;

  const enqueueTx = db.transaction((m: OutMsg, now: number) => {
    const row = {
      chat_id: String(m.chatId),
      thread_id: m.threadId ?? null,
      kind: m.kind === 'document' ? 'document' : 'text',
      text: m.text ?? null,
      doc_name: m.document?.filename ?? null,
      doc_mime: m.document?.mime ?? null,
      doc_content: m.document?.content ?? null,
      buttons_json: m.buttons && m.buttons.length ? JSON.stringify(m.buttons) : null,
      coalesce_key: m.coalesceKey ?? null,
      priority: PRIORITY[m.priority ?? 'normal'] ?? PRIORITY.normal,
      created_at: now,
    };
    if (row.coalesce_key && sCoalesce.run(row).changes > 0) return;
    sInsert.run(row);
    queuedEstimate++;
    if (queuedEstimate > maxQueued) {
      queuedEstimate = (sCountQueued.get() as { n: number }).n;
      if (queuedEstimate > maxQueued) {
        sDropOverflow.run(queuedEstimate - maxQueued);
        queuedEstimate = maxQueued;
      }
    }
  });

  return {
    enqueue: (m, now = Date.now()) => { enqueueTx(m, now); },
    due: (now, limit) => sDue.all(now, limit) as OutboxRow[],
    nextFutureAt: (now) => ((sNextFuture.get(now) as { t: number | null }).t ?? null),
    markSending: (id) => { sSending.run(id); },
    markSent: (id) => { sSent.run(id); queuedEstimate = Math.max(0, queuedEstimate - 1); },
    markFailed: (id, err) => { sFailed.run(err.slice(0, 300), id); queuedEstimate = Math.max(0, queuedEstimate - 1); },
    reschedule: (id, nextAt, err) => { sResched.run(nextAt, err.slice(0, 300), id); },
    expire: (olderThan) => {
      const n = sExpire.run(olderThan).changes;
      if (n) queuedEstimate = Math.max(0, queuedEstimate - n);
      return n;
    },
    counts: () => {
      const out = { queued: 0, sent: 0, failed: 0 };
      for (const r of sCounts.all() as { status: string; n: number }[]) {
        if (r.status === 'queued' || r.status === 'sending') out.queued += r.n;
        else if (r.status === 'sent') out.sent = r.n;
        else if (r.status === 'failed') out.failed = r.n;
      }
      return out;
    },
    close: () => { try { db.close(); } catch { /* ignore */ } },
  };
}
