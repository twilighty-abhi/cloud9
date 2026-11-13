// Cloud 9 — bus events → Telegram notifications. Agent NOTIFY.
// Golden rule: never throw out of a listener, never block the game, never put emails/tokens in notify chats.
import type { AttachNotifications, Bus, NotifyEvent, OutMsg, Button, Sender, TelegramConfig } from './contracts';
import type { Repo, GameRegistry } from '../contracts';
import type { SessionSummary, BoardTop } from '../../../shared/model';
import type { SessionPatch } from '../../../shared/api';
import { esc, b, i, code, modName, fmtCode, medal, clip } from './html';
import { buildExportCsv } from '../http/exportCsv';
import { slugify } from '../util/csv';

// ───────────────────────────── pure formatting helpers ─────────────────────────────

const EMAIL_RE = /[^\s@<>]+@[^\s@<>]+/g;
/** Defensive: a player may type an email as their display name — never leak it into group chats. */
export const safeName = (s: unknown) => String(s ?? '').replace(EMAIL_RE, '[hidden]').replace(/@/g, '＠');

/** "HH:MM" in IST (UTC+5:30), independent of server TZ. */
export function fmtIst(ms: number): string {
  const d = new Date(ms + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const verb = (t: string) => t.slice(t.indexOf('.') + 1); // 'quiz.updated' → 'updated'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sessName = (s: Pick<SessionSummary, 'title' | 'label'>) => (s.label ? `${b(s.title)} — ${esc(s.label)}` : b(s.title));

export function fmtBoard(top: BoardTop[], limit = 10): string {
  if (!top.length) return i('no scores yet');
  return top.slice(0, limit).map((e) => `${medal(e.rank)} ${esc(safeName(e.name))} — ${b(e.score)}`).join('\n');
}

export function fmtEvent(e: Extract<NotifyEvent, { type: `event.${string}` }>): string {
  return `📅 Event ${verb(e.type)}: ${b(e.event.name)} · email ${e.event.emailRequired ? 'required' : 'optional'} · by ${esc(modName(e.actor))}`;
}

export function fmtQuiz(e: Extract<NotifyEvent, { type: `quiz.${string}` }>, eventName: string | null): string {
  let s = `📝 ${esc(modName(e.actor))} ${verb(e.type)} ${b(e.quiz.title)} (${e.quiz.questionCount} Qs)`;
  if (eventName) s += ` · in ${esc(eventName)}`;
  return s;
}

export function fmtSessionCreated(e: Extract<NotifyEvent, { type: 'session.created' }>): string {
  const s = e.session;
  return `🆕 ${sessName(s)} · code ${code(fmtCode(s.code))} · by ${esc(modName(e.actor))}` + (s.eventName ? `\n${i(s.eventName)}` : '');
}

export function fmtChanges(c: SessionPatch): string[] {
  const out: string[] = [];
  if (c.label !== undefined) out.push(`label → ${c.label ? esc(c.label) : i('none')}`);
  if (c.listed !== undefined) out.push(`home page: ${c.listed ? 'shown' : 'hidden'}`);
  if (c.joinOpen !== undefined) out.push(`joining: ${c.joinOpen ? 'open' : 'closed'}`);
  return out;
}

export function fmtSessionUpdated(session: SessionSummary, actor: string, changes: SessionPatch): string {
  const list = fmtChanges(changes);
  return `✏️ ${esc(modName(actor))} updated ${b(session.title)} (${code(fmtCode(session.code))})` + (list.length ? `\n• ${list.join('\n• ')}` : '');
}

export function fmtSessionStarted(s: SessionSummary): string {
  return `▶️ Started ${b(s.title)}${s.label ? ` · ${esc(s.label)}` : ''} · ${plural(s.players, 'player')}`;
}

export function fmtQuestionClosed(e: Extract<NotifyEvent, { type: 'question.closed' }>): string {
  const pct = e.answered > 0 ? Math.round((e.correct / e.answered) * 100) : 0;
  return `Q${e.qIndex + 1}/${e.session.total} closed · ${e.answered}/${e.playerCount} answered · ${pct}% correct · ${i(e.session.title)}`;
}

export function fmtSessionFinished(e: Extract<NotifyEvent, { type: 'session.finished' }>): string {
  const s = e.session;
  const parts = [`🏁 ${b(s.title)} finished (${plural(s.players, 'player')})${e.endedEarly ? ' · ended early' : ''}`, fmtBoard(e.leaderboard)];
  if (e.eventBoard) {
    parts.push(`${b(e.eventBoard.eventName)} standings\n${fmtBoard(e.eventBoard.top)}\n${i(`${plural(e.eventBoard.total, 'player')} in the event`)}`);
  }
  return clip(parts.join('\n\n'));
}

export function fmtKicked(e: Extract<NotifyEvent, { type: 'player.kicked' }>): string {
  return `🚫 ${esc(modName(e.actor))} removed ${b(safeName(e.playerName))} from ${esc(e.session.title)}`;
}

export function fmtDigest(eventName: string, top: BoardTop[], total: number, live: SessionSummary[], now: number): string {
  const lines = live.map((s) => {
    const prog = s.qIndex < 0 ? 'lobby' : s.state === 'FINISHED' ? 'done' : `Q${s.qIndex + 1}/${s.total}`;
    return `• ${b(s.title)}${s.label ? ` — ${esc(s.label)}` : ''} · ${code(fmtCode(s.code))} · ${prog} · ${plural(s.players, 'player')}`;
  });
  return clip(
    `📊 ${b(eventName)} · ${fmtIst(now)} IST\n${fmtBoard(top)}\n${i(`${plural(total, 'player')} in the event`)}\n\n` +
    `${b(`Live (${live.length})`)}\n${lines.join('\n') || i('none')}`,
  );
}

/** Message body for a bus event (null = not a plain-text notification / filtered). Exposed for tests. */
export function formatEvent(e: NotifyEvent, eventName: (id: string | null) => string | null = () => null): string | null {
  switch (e.type) {
    case 'event.created': case 'event.updated': case 'event.deleted': return fmtEvent(e);
    case 'quiz.created': case 'quiz.updated': case 'quiz.deleted': return fmtQuiz(e, eventName(e.quiz.eventId));
    case 'session.created': return fmtSessionCreated(e);
    case 'session.updated': return fmtSessionUpdated(e.session, e.actor, e.changes);
    case 'session.started': return fmtSessionStarted(e.session);
    case 'question.closed': return fmtQuestionClosed(e);
    case 'session.finished': return fmtSessionFinished(e);
    case 'player.kicked': return fmtKicked(e);
    case 'system.started': return `✅ Cloud 9 online · ${plural(e.restoredRooms, 'room')} restored`;
    case 'system.warning': return `⚠️ ${esc(safeName(e.message))}`;
  }
}

/** Moderator username owning the event's subject, or 'system' / 'admin'. */
export function topicKey(e: NotifyEvent): string {
  switch (e.type) {
    case 'system.started': case 'system.warning': return 'system';
    case 'quiz.created': case 'quiz.updated': case 'quiz.deleted': return modName(e.quiz.owner);
    case 'event.created': case 'event.updated': case 'event.deleted': return modName(e.actor);
    default: return modName(e.session.moderatorId);
  }
}

export function resolveThread(cfg: TelegramConfig, key: string): number | null {
  const t = cfg.topics[key] ?? cfg.topics['admin'];
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

function buttonsFor(e: NotifyEvent): Button[][] | undefined {
  switch (e.type) {
    case 'session.created': return [[{ text: 'Details', data: `ses:${e.session.code}` }, { text: 'Board', data: `lb:${e.session.code}` }]];
    case 'session.finished': {
      const row: Button[] = [{ text: 'Quiz board', data: `lb:${e.session.code}` }];
      if (e.session.eventId) row.push({ text: 'Event board', data: `lbe:${e.session.eventId}` });
      return [row];
    }
    default: return undefined;
  }
}

// ───────────────────────────── wiring ─────────────────────────────

export interface NotifyOptions {
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  log?: (msg: string) => void;
}

export function createNotifications(
  deps: { cfg: TelegramConfig; bus: Bus; sender: Sender; repo: Repo; registry: GameRegistry },
  opts: NotifyOptions = {},
): { stop(): void; handle(e: NotifyEvent): void; runDigest(): void } {
  const { cfg, bus, sender, repo, registry } = deps;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.error(`[notify] ${m}`));
  const errMsg = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : 'error').replace(EMAIL_RE, '[x]').slice(0, 200);

  const enqueue = (m: OutMsg) => { try { sender.enqueue(m); } catch (err) { log(`enqueue failed ${errMsg(err)}`); } };
  const broadcast = (base: Omit<OutMsg, 'chatId'>) => { for (const chatId of cfg.notifyChatIds) enqueue({ ...base, chatId }); };

  const eventName = (id: string | null) => {
    if (!id) return null;
    try { return repo.getEvent(id)?.name ?? null; } catch { return null; }
  };

  // session.updated bursts: the sender keeps only the latest queued message per coalesceKey, so we merge changes ourselves.
  const pendingUpdates = new Map<string, { at: number; changes: SessionPatch }>();
  const MERGE_WINDOW_MS = 2 * 60_000;

  function sendCsv(s: SessionSummary) {
    if (!cfg.sendCsv || !cfg.adminIds.length) return;
    const row = repo.getLatestSessionByCode(s.code);
    if (!row || row.id !== s.id) return;
    const csv = buildExportCsv(row, repo.listPlayers(row.id), repo.listAnswers(row.id));
    const filename = `cloud9-${s.code}-${slugify(row.quiz.title)}.csv`;
    for (const chatId of cfg.adminIds) {
      enqueue({ chatId, kind: 'document', document: { filename, content: csv, mime: 'text/csv' },
        text: `📎 ${b(s.title)} results · ${code(fmtCode(s.code))} (contains emails)`, priority: 'normal' });
    }
  }

  function handle(e: NotifyEvent) {
    try {
      if (e.type === 'question.closed' && !cfg.notifyQuestions) return;
      let text: string | null;
      if (e.type === 'session.updated') {
        const prev = pendingUpdates.get(e.session.code);
        const merged: SessionPatch = prev && e.at - prev.at < MERGE_WINDOW_MS ? { ...prev.changes, ...e.changes } : { ...e.changes };
        pendingUpdates.set(e.session.code, { at: e.at, changes: merged });
        if (pendingUpdates.size > 500) pendingUpdates.delete(pendingUpdates.keys().next().value as string);
        if (!fmtChanges(merged).length) return;
        text = fmtSessionUpdated(e.session, e.actor, merged);
      } else {
        text = formatEvent(e, eventName);
      }
      if (!text) return;
      const msg: Omit<OutMsg, 'chatId'> = { kind: 'text', text, threadId: resolveThread(cfg, topicKey(e)), priority: 'normal' };
      const buttons = buttonsFor(e);
      if (buttons) msg.buttons = buttons;
      if (e.type === 'session.updated') msg.coalesceKey = `sess-upd:${e.session.code}`;
      if (e.type === 'question.closed') { msg.priority = 'low'; msg.coalesceKey = `q:${e.session.code}`; }
      if (e.type === 'system.warning') msg.priority = 'high';
      broadcast(msg);
      if (e.type === 'session.finished') {
        pendingUpdates.delete(e.session.code);
        try { sendCsv(e.session); } catch (err) { log(`csv failed ${errMsg(err)}`); }
      }
    } catch (err) {
      log(`handle ${e?.type} failed ${errMsg(err)}`);
    }
  }

  const lastDigest = new Map<string, string>();
  function runDigest() {
    try {
      const live = registry.liveCountByEvent();
      for (const [eventId, count] of live) {
        if (count < 1) continue;
        try {
          const board = repo.eventLeaderboard(eventId);
          const top: BoardTop[] = board.slice(0, 10).map((x) => ({ name: x.name, score: x.score, rank: x.rank }));
          const sessions = registry.listSummaries().filter((s) => s.eventId === eventId && s.state !== 'FINISHED');
          const name = eventName(eventId) ?? sessions[0]?.eventName ?? 'Event';
          const hash = JSON.stringify([name, top, board.length, sessions.map((s) => [s.code, s.title, s.label, s.state, s.qIndex, s.players])]);
          if (lastDigest.get(eventId) === hash) continue;
          lastDigest.set(eventId, hash);
          broadcast({ kind: 'text', text: fmtDigest(name, top, board.length, sessions, now()), threadId: resolveThread(cfg, 'admin'),
            priority: 'low', coalesceKey: `digest:${eventId}` });
        } catch (err) { log(`digest ${eventId} failed ${errMsg(err)}`); }
      }
    } catch (err) { log(`digest failed ${errMsg(err)}`); }
  }

  const unsubscribe = bus.on(handle);
  let timer: unknown = null;
  if (cfg.digestMinutes > 0) {
    const si = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    timer = si(runDigest, cfg.digestMinutes * 60_000);
    (timer as { unref?: () => void } | null)?.unref?.();
  }

  return {
    handle,
    runDigest,
    stop() {
      try { unsubscribe(); } catch { /* ignore */ }
      if (timer !== null) { (opts.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout)))(timer); timer = null; }
    },
  };
}

export const attachNotifications: AttachNotifications = (deps) => {
  const n = createNotifications(deps);
  return { stop: () => n.stop() };
};
