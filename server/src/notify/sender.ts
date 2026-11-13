// Cloud 9 — Telegram send loop over the persistent outbox. Agent SENDER.
// Golden rule: never throws out, never spins hot, never blocks the event loop for long.
import { TgError, type CreateSender, type OutMsg, type Sender, type TelegramConfig, type TgClient, type Button } from './contracts';
import { clip } from './html';
import { inlineKeyboard } from './client';
import { openOutbox, type Outbox, type OutboxRow } from './outbox';

export interface SenderTuning {
  perChatMs: number;        // min gap between sends to one chat
  groupLimit: number;       // max sends per group chat per window
  groupWindowMs: number;
  globalLimit: number;      // max sends overall per window
  globalWindowMs: number;
  backoffBaseMs: number;    // 5xx / network
  backoffMaxMs: number;
  maxAgeMs: number;         // queued rows older than this are dropped
  maxQueued: number;
  expireEveryMs: number;
  stopTimeoutMs: number;
}

export const DEFAULT_TUNING: SenderTuning = {
  perChatMs: 1050,
  groupLimit: 20,
  groupWindowMs: 60_000,
  globalLimit: 25,
  globalWindowMs: 1000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  maxAgeMs: 24 * 3600_000,
  maxQueued: 5000,
  expireEveryMs: 10_000,
  stopTimeoutMs: 5000,
};

const CANDIDATES = 500;
const MAX_IDLE_MS = 60_000;

type Deps = { cfg: TelegramConfig; dbPath: string; client: TgClient };

/** Internal factory with tuning overrides (tests). Production code uses `createSender`. */
export function createSenderWithTuning(deps: Deps, tuningOverride: Partial<SenderTuning> = {}): Sender & { start(): void; stop(): Promise<void> } {
  const t: SenderTuning = { ...DEFAULT_TUNING, ...tuningOverride };
  const { client } = deps;
  let outbox: Outbox | null = null;
  let lastError: string | null = null;
  const loggedErrors = new Set<string>();

  try {
    outbox = openOutbox(deps.dbPath, { maxQueued: t.maxQueued });
  } catch (e: any) {
    lastError = `outbox open failed: ${String(e?.message ?? e).slice(0, 200)}`;
    console.error(`[telegram] ${lastError}`);
  }

  // ── rate-limit state (in memory) ──
  const chatReadyAt = new Map<string, number>();     // per-chat pacing / 429 blocks
  const groupSends = new Map<string, number[]>();    // sliding window per group chat
  let globalSends: number[] = [];
  let globalBlockedUntil = 0;

  const windowReady = (arr: number[], limit: number, windowMs: number, now: number) => {
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    return arr.length < limit ? now : arr[0] + windowMs;
  };
  const readyAt = (chatId: string, now: number) => {
    let r = Math.max(chatReadyAt.get(chatId) ?? 0, globalBlockedUntil, windowReady(globalSends, t.globalLimit, t.globalWindowMs, now));
    if (chatId.startsWith('-')) {
      const g = groupSends.get(chatId);
      if (g) {
        r = Math.max(r, windowReady(g, t.groupLimit, t.groupWindowMs, now));
        if (!g.length) groupSends.delete(chatId);
      }
    }
    return r;
  };
  const recordSend = (chatId: string, now: number) => {
    chatReadyAt.set(chatId, now + t.perChatMs);
    globalSends.push(now);
    if (chatId.startsWith('-')) {
      let g = groupSends.get(chatId);
      if (!g) groupSends.set(chatId, (g = []));
      g.push(now);
    }
    if (chatReadyAt.size > 2000) for (const [k, v] of chatReadyAt) if (v < now) chatReadyAt.delete(k);
  };

  // ── sleeping / wake-up ──
  let wakeFn: (() => void) | null = null;
  const wake = () => { const w = wakeFn; wakeFn = null; w?.(); };
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeFn = null; resolve(); }, Math.max(0, ms));
    timer.unref?.();
    wakeFn = () => { clearTimeout(timer); resolve(); };
  });

  let running = false;
  let loopPromise: Promise<void> | null = null;
  let inflight: Promise<void> | null = null;
  let lastExpire = 0;

  const logOnce = (key: string, msg: string) => {
    if (loggedErrors.has(key)) return;
    if (loggedErrors.size > 200) loggedErrors.clear();
    loggedErrors.add(key);
    console.warn(`[telegram] ${msg}`);
  };

  async function deliver(row: OutboxRow, threadId: number | null): Promise<void> {
    const buttons: Button[][] | undefined = row.buttons_json ? JSON.parse(row.buttons_json) : undefined;
    if (row.kind === 'document') {
      await client.sendDocument(row.chat_id, { filename: row.doc_name ?? 'file.txt', content: row.doc_content ?? '', mime: row.doc_mime ?? undefined }, {
        caption: row.text ? clip(row.text, 1024) : undefined,
        threadId,
        buttons,
      });
      return;
    }
    const params: Record<string, unknown> = {
      chat_id: row.chat_id,
      text: clip(row.text ?? '', 4096) || '…',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (threadId != null) params.message_thread_id = threadId;
    const rm = inlineKeyboard(buttons);
    if (rm) params.reply_markup = rm;
    await client.call('sendMessage', params);
  }

  async function sendOne(ob: Outbox, row: OutboxRow): Promise<void> {
    const now = Date.now();
    ob.markSending(row.id);
    recordSend(row.chat_id, now);
    try {
      try {
        await deliver(row, row.thread_id ?? null);
      } catch (e) {
        if (row.thread_id != null && e instanceof TgError && e.code === 400 && /thread not found/i.test(e.message)) {
          logOnce(`thread:${row.thread_id}`, `topic ${row.thread_id} not found — sending without thread`);
          await deliver(row, null);
        } else throw e;
      }
      ob.markSent(row.id);
    } catch (e: any) {
      const err = e instanceof TgError ? e : new TgError(String(e?.message ?? e).slice(0, 200), 0, null, false);
      lastError = `${err.code || 'net'}: ${err.message}`.slice(0, 300);
      const after = Date.now();
      if (err.code === 429) {
        const waitMs = Math.max(1, err.retryAfterSec ?? 5) * 1000;
        chatReadyAt.set(row.chat_id, after + waitMs);
        ob.reschedule(row.id, after + waitMs, lastError);
      } else if (err.permanent) {
        ob.markFailed(row.id, lastError);
        logOnce(`perm:${err.code}:${err.message}`, `message dropped (permanent ${err.code}): ${err.message}`);
      } else {
        const attempts = (row.attempts ?? 0) + 1; // markSending incremented in DB
        const backoff = Math.min(t.backoffMaxMs, t.backoffBaseMs * 2 ** Math.min(attempts - 1, 16));
        ob.reschedule(row.id, after + backoff, lastError);
        logOnce(`tmp:${err.code}`, `send failed (${err.code || 'network'}), retrying with backoff: ${err.message}`);
      }
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const ob = outbox;
      if (!ob) return;
      try {
        const now = Date.now();
        if (now - lastExpire >= t.expireEveryMs) {
          lastExpire = now;
          const n = ob.expire(now - t.maxAgeMs);
          if (n) logOnce(`expired:${Math.floor(now / 3600_000)}`, `${n} message(s) expired (older than ${Math.round(t.maxAgeMs / 3600_000)}h)`);
        }
        const rows = ob.due(now, CANDIDATES);
        let pick: OutboxRow | null = null;
        let wakeAt = now + MAX_IDLE_MS;
        for (const r of rows) {
          const ra = readyAt(r.chat_id, now);
          if (ra <= now) { pick = r; break; }
          if (ra < wakeAt) wakeAt = ra;
        }
        if (!pick) {
          const nf = ob.nextFutureAt(now);
          if (nf != null && nf < wakeAt) wakeAt = nf;
          await sleep(Math.max(5, wakeAt - now));
          continue;
        }
        inflight = sendOne(ob, pick);
        await inflight;
        inflight = null;
        // yield to the event loop between sends
        await new Promise<void>((r) => setImmediate(r));
      } catch (e: any) {
        inflight = null;
        lastError = `loop: ${String(e?.message ?? e).slice(0, 200)}`;
        logOnce(`loop:${lastError}`, lastError);
        if (running) await sleep(1000);
      }
    }
  }

  return {
    enqueue(m: OutMsg) {
      try {
        if (!outbox || !m || !m.chatId) return;
        outbox.enqueue(m);
        wake();
      } catch (e: any) {
        lastError = `enqueue: ${String(e?.message ?? e).slice(0, 200)}`;
        logOnce(`enq:${lastError}`, lastError);
      }
    },
    stats() {
      try {
        const c = outbox ? outbox.counts() : { queued: 0, sent: 0, failed: 0 };
        return { ...c, lastError };
      } catch {
        return { queued: 0, sent: 0, failed: 0, lastError };
      }
    },
    start() {
      if (running || !outbox) return;
      running = true;
      lastExpire = 0;
      loopPromise = loop().catch(() => { /* never surfaces */ });
    },
    async stop() {
      if (!running && !loopPromise) { outbox?.close(); outbox = null; return; }
      running = false;
      wake();
      const deadline = new Promise<void>((r) => { const tm = setTimeout(r, t.stopTimeoutMs); tm.unref?.(); });
      await Promise.race([Promise.all([inflight ?? Promise.resolve(), loopPromise ?? Promise.resolve()]).then(() => undefined), deadline]);
      loopPromise = null;
      outbox?.close();
      outbox = null;
    },
  };
}

export const createSender: CreateSender = (deps) => createSenderWithTuning(deps);
