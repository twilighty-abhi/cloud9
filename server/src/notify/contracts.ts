// Cloud 9 — Telegram integration contracts. FROZEN: only the lead edits this file.
//
// Ownership (one agent per file group):
//   bus.ts, html.ts, contracts.ts, index.ts ........ lead
//   Agent EMIT    server/src/game/**, server/src/http/**   → calls bus.emit(...) at the right moments (no other behaviour change)
//   Agent SENDER  notify/client.ts, notify/outbox.ts, notify/sender.ts  → createTgClient, createSender
//   Agent NOTIFY  notify/notifications.ts                 → attachNotifications (bus → messages, coalescing, digest, topic routing)
//   Agent BOT     notify/commands.ts, notify/poller.ts     → createCommandRouter, startPoller (commands, inline buttons)
//   Agent QA      server/test/telegram*.test.ts, server/test/fakeTelegram.ts, README.md (Telegram section), .env.example
//
// Golden rule: Telegram must NEVER affect the quiz. Every call is async, wrapped, bounded; failures are logged (no PII) and retried via the outbox.
// Feature is OFF unless config.telegram !== null (TELEGRAM_BOT_TOKEN set).

import type { SessionSummary, BoardTop } from '../../../shared/model';
import type { SessionPatch } from '../../../shared/api';
import type { Repo, GameRegistry } from '../contracts';
import type { Config } from '../config';

// ───────────────────────────── config (parsed in config.ts) ─────────────────────────────
export interface TelegramConfig {
  token: string;                         // TELEGRAM_BOT_TOKEN
  apiBase: string;                       // TELEGRAM_API_BASE, default https://api.telegram.org (tests point it at the fake server)
  notifyChatIds: string[];               // TELEGRAM_NOTIFY_CHAT_IDS — where notifications go (names only, NEVER emails)
  adminIds: string[];                    // TELEGRAM_ADMIN_IDS — Telegram USER ids allowed to run commands; their PRIVATE chats may see emails
  topics: Record<string, number>;        // TELEGRAM_TOPICS "hall1=12,hall2=13,hall3=14,admin=15,system=16" → message_thread_id by moderator username / 'system'
  notifyQuestions: boolean;              // TELEGRAM_NOTIFY_QUESTIONS=1 → one line per closed question (default off)
  digestMinutes: number;                 // TELEGRAM_DIGEST_MINUTES, default 30, 0 = off (event leaderboard digest while any session of the event is live)
  sendCsv: boolean;                      // TELEGRAM_SEND_CSV, default true → attach session CSV on session.finished (CSV contains emails ⇒ only to admin private chats, see below)
}

// ───────────────────────────── domain events (bus) ─────────────────────────────
// actor = moderator username ('admin', 'hall1', …) or null for system/timer-driven events.
export type NotifyEvent =
  | { type: 'event.created' | 'event.updated' | 'event.deleted'; at: number; actor: string; event: { id: string; name: string; emailRequired: boolean } }
  | { type: 'quiz.created' | 'quiz.updated' | 'quiz.deleted'; at: number; actor: string; quiz: { id: string; title: string; eventId: string | null; questionCount: number; owner: string } }
  | { type: 'session.created'; at: number; actor: string; session: SessionSummary }
  | { type: 'session.updated'; at: number; actor: string; session: SessionSummary; changes: SessionPatch }
  | { type: 'session.started'; at: number; actor: string | null; session: SessionSummary }
  | { type: 'question.closed'; at: number; actor: string | null; session: SessionSummary; qIndex: number; answered: number; playerCount: number; correct: number }
  | { type: 'session.finished'; at: number; actor: string | null; session: SessionSummary; endedEarly: boolean;
      leaderboard: BoardTop[] /* quiz top 10 */; eventBoard: { eventName: string; top: BoardTop[] /* top 10 */; total: number } | null }
  | { type: 'player.kicked'; at: number; actor: string; session: SessionSummary; playerName: string }
  | { type: 'system.started'; at: number; actor: null; restoredRooms: number; moderators: number }
  | { type: 'system.warning'; at: number; actor: null; message: string };

export interface Bus {
  emit(e: NotifyEvent): void;                         // never throws, never blocks (listeners run in a microtask)
  on(listener: (e: NotifyEvent) => void): () => void; // returns unsubscribe
}

// ───────────────────────────── outgoing messages ─────────────────────────────
export interface Button { text: string; data: string }  // callback_data, ≤64 bytes. Formats below.
// Callback data formats (BOT agent handles them; NOTIFY agent attaches them):
//   "lb:<code>"   quiz leaderboard of a session      "lbe:<eventId>"  event leaderboard
//   "ses:<code>"  session details                     "exp:<code>"     session CSV (admin private chat only)
//   "expe:<eventId>" event CSV (admin private chat only)

export interface OutMsg {
  chatId: string;
  threadId?: number | null;      // forum topic (message_thread_id)
  kind: 'text' | 'document';
  text?: string;                 // HTML parse mode (use html.ts esc()); ≤4096 chars for text, ≤1024 for document caption — sender truncates safely
  document?: { filename: string; content: string; mime?: string };   // ≤ 5 MB in practice
  buttons?: Button[][];          // inline keyboard rows
  coalesceKey?: string;          // if a not-yet-sent message with the same (chatId, coalesceKey) is queued, REPLACE it (keeps the latest)
  priority?: 'high' | 'normal' | 'low';   // high: command replies; normal: lifecycle; low: digests / question lines (dropped first under pressure)
}

export interface Sender {
  enqueue(m: OutMsg): void;      // persists to the outbox (SQLite) and wakes the loop; never throws
  stats(): { queued: number; sent: number; failed: number; lastError: string | null };
}

export interface TgClient {
  /** Calls https://<apiBase>/bot<token>/<method> with JSON params. Resolves `result`; throws TgError. Timeout 15s (getUpdates: timeout+10s). */
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  /** multipart sendDocument. */
  sendDocument(chatId: string, doc: { filename: string; content: string; mime?: string }, opts?: { caption?: string; threadId?: number | null; buttons?: Button[][] }): Promise<void>;
  /** multipart sendPhoto (PNG). Used for the session QR code. */
  sendPhoto(chatId: string, photo: { filename: string; content: Buffer }, opts?: { caption?: string; threadId?: number | null; buttons?: Button[][] }): Promise<void>;
}
export class TgError extends Error {
  constructor(message: string, public code: number, public retryAfterSec: number | null, public permanent: boolean) { super(message); }
}

// ───────────────────────────── module factories ─────────────────────────────
export type CreateTgClient = (cfg: TelegramConfig) => TgClient;
/** Rate limits (Telegram FAQ): ≤1 msg/s per chat, ≤20 msg/min per group/supergroup (chat id starts with "-"), ≤25 msg/s overall.
 *  On 429 honour retry_after; on 5xx/network back off (1s→60s); permanent 400/403 → mark failed (log once). Drop items older than 24h.
 *  Outbox table `telegram_outbox` lives in the SAME SQLite file (own connection, WAL, busy_timeout). */
export type CreateSender = (deps: { cfg: TelegramConfig; dbPath: string; client: TgClient }) => Sender & { start(): void; stop(): Promise<void> };
export type AttachNotifications = (deps: { cfg: TelegramConfig; bus: Bus; sender: Sender; repo: Repo; registry: GameRegistry; config: Config }) => { stop(): void };
export interface CommandRouter {
  handleUpdate(update: any): Promise<void>;   // a Telegram Update (message or callback_query). Never throws.
  commands(): { command: string; description: string }[];  // for setMyCommands
}
export type CreateCommandRouter = (deps: { cfg: TelegramConfig; client: TgClient; sender: Sender; repo: Repo; registry: GameRegistry; config: Config; actions?: ActionHandler }) => CommandRouter;
//   The router checks admin auth FIRST, then offers every command/callback to `actions` before its own handlers.

// ───────────────────────────── v2: actions from Telegram (admin only, every change needs a confirm tap) ─────────────────────────────
// Allowed: create a session (LOBBY), joining on/off, hide/show on home page, end a session. NOT allowed: start/close/reveal/next (moderator screen only).
// Commands:  /newsession [text]  → buttons of the default event's quizzes (filter by text) → tap → preview + [✅ Create] [✖ Cancel]
//            /joining <code> on|off · /hide <code> · /show <code> · /end <code>   → preview + confirm buttons
// Callback data (≤64 bytes):
//   "nsq:<quizId>"  show create-preview for quiz        "nsy:<quizId>"  confirmed → create session
//   "act:<op>:<code>" show confirm for op                "acy:<op>:<code>" confirmed → do it        op ∈ jon | joff | hide | show | end
//   "cxl"           cancel (edit the confirm message to "Cancelled")
// Created sessions: owner = quiz.moderatorId (so the hall moderator runs it), label = "<Hall> · <start time>" parsed from a title like
//   "Hall 3 · 2:00–2:30 PM · …" (→ "Hall 3 · 2:00 PM"), else ''. listed = true. Reply: text (title, code, join link, projector link
//   `${publicUrl}/present/<code>`, moderator link `${publicUrl}/mod/room/<code>`) + QR PNG via client.sendPhoto (fallback: text only).
// Actions emit bus events with actor "telegram:<admin user id>": session.created / session.updated. End → registry.endSession(code, actor)
//   which makes the room emit session.finished (leaderboard message + CSV as usual).
// Confirm buttons expire after 10 minutes (store pending confirmations in memory keyed by chatId+data; expired → "This button expired").
export interface TgCtx { chatId: string; threadId: number | null; isPrivate: boolean }
export interface ActionHandler {
  /** Return true if handled. `cmd` without slash/bot suffix, lowercased; `args` raw. */
  command(ctx: TgCtx, cmd: string, args: string, fromId: string): Promise<boolean>;
  /** Return true if handled. */
  callback(ctx: TgCtx, data: string, fromId: string, messageId: number | null): Promise<boolean>;
  commands(): { command: string; description: string }[];
}
export type CreateActions = (deps: { cfg: TelegramConfig; client: TgClient; sender: Sender; repo: Repo; registry: GameRegistry; config: Config; bus: Bus }) => ActionHandler;
/** Long polling getUpdates (timeout 30, allowed_updates ["message","callback_query"]). Calls deleteWebhook once at start. Backoff on errors. */
export type StartPoller = (deps: { cfg: TelegramConfig; client: TgClient; router: CommandRouter }) => { stop(): Promise<void> };
