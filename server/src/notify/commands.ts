// Cloud 9 — Telegram bot commands + inline buttons. Agent BOT.
// Only admins (cfg.adminIds, by Telegram USER id) may use anything. Emails only in admin PRIVATE chats; CSV only in private chats.
import type { CreateCommandRouter, Button, OutMsg } from './contracts';
import type { SessionRow } from '../contracts';
import type { SessionSummary, EventDef, EventLeaderEntry, RoomState } from '../../../shared/model';
import { esc, b, i, code, modName, fmtCode, medal, clip } from './html';
import { buildExportCsv } from '../http/exportCsv';
import { csvRow, slugify } from '../util/csv';

const CODE_RE = /^\d{6}$/;
const PRIVATE_REPLY_EVERY_MS = 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';

const COMMANDS: { command: string; description: string }[] = [
  { command: 'live', description: 'Live sessions right now' },
  { command: 'events', description: 'All events with counts' },
  { command: 'event', description: 'Event run sheet: quizzes, sessions, top 5' },
  { command: 'leaderboard', description: 'Leaderboard: [code | event name]' },
  { command: 'winner', description: 'Event #1: [event name]' },
  { command: 'session', description: 'Session details: <code>' },
  { command: 'quizzes', description: 'Quizzes of an event: [event name]' },
  { command: 'export', description: 'CSV: <code> | event [name] (private chat only)' },
  { command: 'stats', description: 'Server health + outbox stats' },
  { command: 'help', description: 'List commands' },
];

interface Ctx {
  chatId: string;
  threadId: number | null;
  isPrivate: boolean; // private chat with an admin → may see emails + CSV
}

/** Normalizes "123 456" / "123456" → "123456", else null. */
export function asCode(s: string): string | null {
  const c = s.replace(/[\s-]/g, '');
  return CODE_RE.test(c) ? c : null;
}

/** "/live@Cloud9Bot arg" → { cmd: 'live', bot: 'Cloud9Bot', args: 'arg' } */
export function parseCommand(text: string): { cmd: string; bot: string | null; args: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), bot: m[2] ?? null, args: (m[3] ?? '').trim() };
}

export function stateLabel(s: { state: RoomState; qIndex: number; total: number }): string {
  switch (s.state) {
    case 'LOBBY': return 'Lobby';
    case 'FINISHED': return 'Finished';
    case 'QUESTION': return `Q${s.qIndex + 1} of ${s.total}`;
    case 'CLOSED': return `Q${s.qIndex + 1} of ${s.total} (closed)`;
    case 'REVEAL': return `Q${s.qIndex + 1} of ${s.total} (reveal)`;
    case 'LEADERBOARD': return `Q${s.qIndex + 1} of ${s.total} (leaderboard)`;
    default: return String(s.state);
  }
}

const fmtTime = (ms: number | null | undefined): string => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return new Date(ms).toISOString();
  }
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w.endsWith('z') ? 'zes' : 's'}`;

export const createCommandRouter: CreateCommandRouter = ({ cfg, client, sender, repo, registry, config, actions }) => {
  const admins = new Set(cfg.adminIds.map(String));
  const lastPrivateReply = new Map<string, number>();
  let botUsername: string | null = null;
  let botUsernameTried = false;

  const log = (msg: string, err?: unknown) => {
    // no PII: only error message/class
    const e = err instanceof Error ? `${err.name}: ${err.message}` : err !== undefined ? String(err) : '';
    console.warn(`[telegram/bot] ${msg}${e ? ' — ' + e.slice(0, 200) : ''}`);
  };

  const send = (ctx: Ctx, text: string, buttons?: Button[][]) => {
    const m: OutMsg = { chatId: ctx.chatId, threadId: ctx.threadId, kind: 'text', text: clip(text), priority: 'high' };
    if (buttons && buttons.length) m.buttons = buttons;
    sender.enqueue(m);
  };
  const sendDoc = (ctx: Ctx, filename: string, content: string, caption: string) => {
    sender.enqueue({ chatId: ctx.chatId, threadId: ctx.threadId, kind: 'document', text: clip(caption, 1000), document: { filename, content, mime: 'text/csv' }, priority: 'high' });
  };

  // ───────────── data helpers ─────────────
  const joinUrl = (c: string) => `${config.publicUrl}/join/${c}`;
  const summaryFromRow = (row: SessionRow): SessionSummary => ({
    id: row.id, code: row.code, quizId: row.quizId, moderatorId: row.moderatorId, eventId: row.eventId,
    eventName: row.eventId ? repo.getEvent(row.eventId)?.name ?? null : null,
    title: row.quiz.title, label: row.label, state: row.state, qIndex: row.qIndex, total: row.quiz.questions.length,
    players: repo.countPlayers(row.id), listed: row.listed, joinOpen: row.joinOpen, joinUrl: joinUrl(row.code),
    createdAt: row.createdAt, endedAt: row.endedAt,
  });
  /** Live (memory) summary preferred, else latest persisted. */
  const findSession = (c: string): { s: SessionSummary; row: SessionRow | null } | null => {
    const live = registry.summary(c);
    const row = repo.getLatestSessionByCode(c);
    if (live) return { s: live, row: row && row.id === live.id ? row : null };
    if (row) return { s: summaryFromRow(row), row };
    return null;
  };
  const liveSessions = () => registry.listSummaries().filter((s) => s.state !== 'FINISHED');

  const eventSessions = (eventId: string): SessionSummary[] => {
    const byId = new Map<string, SessionSummary>();
    for (const s of registry.listSummaries()) if (s.eventId === eventId) byId.set(s.id, s);
    for (const row of repo.listSessions(null)) {
      if (row.eventId !== eventId || byId.has(row.id)) continue;
      byId.set(row.id, summaryFromRow(row));
      if (byId.size >= 100) break;
    }
    return [...byId.values()].sort((a, b2) => b2.createdAt - a.createdAt);
  };

  const defaultEvent = (): EventDef | null => {
    const events = repo.listEvents();
    if (!events.length) return null;
    const live = registry.liveCountByEvent();
    let best: EventDef | null = null;
    let bestN = 0;
    for (const e of events) {
      const n = live.get(e.id) ?? 0;
      if (n > bestN) { best = e; bestN = n; }
    }
    return best ?? events[0];
  };
  /** Resolve "[name or id]" → event. Empty → default. Returns string error when not found. */
  const resolveEvent = (arg: string): EventDef | string => {
    const q = arg.trim();
    if (!q) return defaultEvent() ?? 'No events yet.';
    const byId = repo.getEvent(q);
    if (byId) return byId;
    const events = repo.listEvents();
    const lq = q.toLowerCase();
    const exact = events.find((e) => e.name.toLowerCase() === lq);
    if (exact) return exact;
    const partial = events.filter((e) => e.name.toLowerCase().includes(lq));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) return `Several events match ${b(q)}: ${partial.slice(0, 10).map((e) => esc(e.name)).join(', ')}`;
    return `Event ${b(q)} not found. Try /events.`;
  };

  const quizBoard = (s: SessionSummary) => {
    const players = repo.listPlayers(s.id).filter((p) => !p.kicked);
    players.sort((x, y) => y.score - x.score || x.joinedAt - y.joinedAt);
    return players;
  };

  const sessionLine = (s: SessionSummary) =>
    `${b(s.label || '—')} · ${esc(s.title)} · ${code(fmtCode(s.code))}\n   ${esc(stateLabel(s))} · ${plural(s.players, 'player')}`;

  const eventEntry = (e: EventLeaderEntry, ctx: Ctx, extra = '') =>
    `${medal(e.rank)} ${esc(e.name)}${ctx.isPrivate && e.email ? ` &lt;${esc(e.email)}&gt;` : ''} — ${b(e.score)}${extra}`;

  // ───────────── outputs ─────────────
  /** Read-only commands, then admin actions (if wired), then help last. */
  const allCommands = (): { command: string; description: string }[] => {
    let extra: { command: string; description: string }[] = [];
    try { extra = actions ? actions.commands() : []; } catch (err) { log('actions.commands failed', err); }
    const base = COMMANDS.filter((c) => c.command !== 'help');
    const helpCmd = COMMANDS.filter((c) => c.command === 'help');
    return [...base, ...extra, ...helpCmd].map((c) => ({ ...c }));
  };
  const help = (ctx: Ctx, prefix = '') =>
    send(ctx, `${prefix}${b('Cloud 9 bot')}\n` + allCommands().map((c) => `/${c.command} — ${esc(c.description)}`).join('\n'));

  const doLive = (ctx: Ctx) => {
    const live = liveSessions().sort((a, b2) => (a.label || '').localeCompare(b2.label || '') || b2.createdAt - a.createdAt);
    if (!live.length) return send(ctx, '🟢 No live sessions right now.');
    const total = live.reduce((n, s) => n + s.players, 0);
    const lines = [`🔴 ${b(`Live sessions (${live.length})`)} · ${plural(total, 'player')}`, ''];
    for (const s of live.slice(0, 30)) lines.push(sessionLine(s));
    const buttons = live.slice(0, 30).map((s) => [
      { text: `Details ${fmtCode(s.code)}`, data: `ses:${s.code}` },
      { text: `Top 10 ${fmtCode(s.code)}`, data: `lb:${s.code}` },
    ]);
    send(ctx, lines.join('\n'), buttons);
  };

  const doEvents = (ctx: Ctx) => {
    const events = repo.listEvents();
    if (!events.length) return send(ctx, 'No events yet.');
    const live = registry.liveCountByEvent();
    const lines = [b(`Events (${events.length})`), ''];
    for (const e of events.slice(0, 30)) {
      const n = live.get(e.id) ?? 0;
      lines.push(`${n ? '🔴' : '•'} ${b(e.name)} — ${plural(e.quizCount, 'quiz')}, ${plural(e.sessionCount, 'session')}, ${n} live`);
    }
    const buttons = events.slice(0, 10).map((e) => [{ text: `🏆 ${e.name}`.slice(0, 40), data: `lbe:${e.id}` }]);
    send(ctx, lines.join('\n'), buttons);
  };

  const doEvent = (ctx: Ctx, arg: string) => {
    const ev = resolveEvent(arg);
    if (typeof ev === 'string') return send(ctx, ev);
    const quizzes = repo.listQuizzes(null, ev.id);
    const sessions = eventSessions(ev.id);
    const board = repo.eventLeaderboard(ev.id);
    const lines = [`📅 ${b(ev.name)}${ev.emailRequired ? '' : ' (email optional)'}`, ''];
    lines.push(b(`Run sheet — ${quizzes.length} ${quizzes.length === 1 ? 'quiz' : 'quizzes'}`));
    if (!quizzes.length) lines.push(i('no quizzes yet'));
    quizzes.slice(0, 40).forEach((q, n) => lines.push(`${n + 1}. ${esc(q.title)} — ${esc(modName(q.moderatorId))} (${q.questionCount}q)`));
    lines.push('', b(`Sessions (${sessions.length})`));
    if (!sessions.length) lines.push(i('none yet'));
    for (const s of sessions.slice(0, 20)) lines.push(sessionLine(s));
    lines.push('', b(`Top 5 of ${board.length}`));
    if (!board.length) lines.push(i('no scores yet'));
    for (const e of board.slice(0, 5)) lines.push(eventEntry(e, ctx));
    const row: Button[] = [{ text: '🏆 Leaderboard', data: `lbe:${ev.id}` }];
    if (ctx.isPrivate) row.push({ text: '⬇️ CSV', data: `expe:${ev.id}` });
    send(ctx, lines.join('\n'), [row]);
  };

  const doEventBoard = (ctx: Ctx, ev: EventDef, size = 10) => {
    const board = repo.eventLeaderboard(ev.id);
    const lines = [`🏆 ${b(ev.name)} — event leaderboard (${plural(board.length, 'player')})`, ''];
    if (!board.length) lines.push(i('no scores yet'));
    for (const e of board.slice(0, size)) lines.push(eventEntry(e, ctx, ` · ${plural(e.quizzesPlayed, 'quiz')}`));
    const buttons = ctx.isPrivate ? [[{ text: '⬇️ CSV', data: `expe:${ev.id}` }]] : undefined;
    send(ctx, lines.join('\n'), buttons);
  };

  const doQuizBoard = (ctx: Ctx, c: string) => {
    const found = findSession(c);
    if (!found) return send(ctx, `Session ${code(fmtCode(c))} not found.`);
    const { s } = found;
    const players = quizBoard(s);
    const lines = [`🏆 ${b(s.title)} · ${esc(s.label || '—')} · ${code(fmtCode(s.code))}`, `${esc(stateLabel(s))} · ${plural(players.length, 'player')}`, ''];
    if (!players.length) lines.push(i('no players yet'));
    players.slice(0, 10).forEach((p, n) =>
      lines.push(`${medal(n + 1)} ${esc(p.name)}${ctx.isPrivate && p.email ? ` &lt;${esc(p.email)}&gt;` : ''} — ${b(p.score)}`));
    const row: Button[] = [{ text: 'Details', data: `ses:${s.code}` }];
    if (ctx.isPrivate) row.push({ text: '⬇️ CSV', data: `exp:${s.code}` });
    send(ctx, lines.join('\n'), [row]);
  };

  const doLeaderboard = (ctx: Ctx, arg: string) => {
    const c = arg ? asCode(arg) : null;
    if (c) return doQuizBoard(ctx, c);
    const ev = resolveEvent(arg);
    if (typeof ev === 'string') return send(ctx, ev);
    doEventBoard(ctx, ev);
  };

  const doWinner = (ctx: Ctx, arg: string) => {
    const ev = resolveEvent(arg);
    if (typeof ev === 'string') return send(ctx, ev);
    const top = repo.eventLeaderboard(ev.id)[0];
    if (!top) return send(ctx, `${b(ev.name)}: no scores yet.`);
    const lines = [`🥇 ${b(ev.name)} — current #1`, '', `${b(top.name)} — ${b(top.score)} points`];
    if (ctx.isPrivate) {
      lines.push(`Email: ${top.email ? esc(top.email) : i('none')}`);
      lines.push(`Quizzes played: ${top.quizzesPlayed}`);
    }
    send(ctx, lines.join('\n'));
  };

  const doSession = (ctx: Ctx, arg: string) => {
    const c = asCode(arg);
    if (!c) return send(ctx, 'Usage: /session &lt;6-digit code&gt;');
    const found = findSession(c);
    if (!found) return send(ctx, `Session ${code(fmtCode(c))} not found.`);
    const { s } = found;
    const row = found.row ?? repo.getLatestSessionByCode(c);
    let answeredLine = '';
    if (s.qIndex >= 0) {
      const answers = repo.listAnswers(s.id);
      const cur = answers.filter((a) => a.qIndex === s.qIndex).length;
      answeredLine = `Answered Q${s.qIndex + 1}: ${cur}/${s.players} · ${answers.length} answers total`;
    }
    const lines = [
      `🎯 ${b(s.title)}`,
      `Code: ${code(fmtCode(s.code))}`,
      `Hall: ${esc(s.label || '—')}`,
      `Event: ${esc(s.eventName ?? '—')}`,
      `Moderator: ${esc(modName(s.moderatorId))}`,
      `State: ${b(stateLabel(s))}`,
      `Players: ${s.players}`,
    ];
    if (answeredLine) lines.push(esc(answeredLine));
    lines.push(`Join: ${s.joinOpen ? 'open' : 'closed'} · ${s.listed ? 'listed' : 'unlisted'}`);
    lines.push(`Created: ${esc(fmtTime(s.createdAt))}`);
    if (row?.qStartedAt) lines.push(`Current question started: ${esc(fmtTime(row.qStartedAt))}`);
    if (s.endedAt) lines.push(`Ended: ${esc(fmtTime(s.endedAt))}`);
    const btns: Button[] = [{ text: '🏆 Top 10', data: `lb:${s.code}` }];
    if (ctx.isPrivate) btns.push({ text: '⬇️ CSV', data: `exp:${s.code}` });
    send(ctx, lines.join('\n'), [btns]);
  };

  const doQuizzes = (ctx: Ctx, arg: string) => {
    const ev = resolveEvent(arg);
    if (typeof ev === 'string') return send(ctx, ev);
    const quizzes = repo.listQuizzes(null, ev.id);
    const lines = [`📝 ${b(ev.name)} — ${quizzes.length} ${quizzes.length === 1 ? 'quiz' : 'quizzes'}`, ''];
    if (!quizzes.length) lines.push(i('no quizzes yet'));
    quizzes.slice(0, 60).forEach((q, n) => lines.push(`${n + 1}. ${esc(q.title)} — ${esc(modName(q.moderatorId))} · ${plural(q.questionCount, 'question')}`));
    send(ctx, lines.join('\n'));
  };

  const exportSession = (ctx: Ctx, c: string) => {
    const row = repo.getLatestSessionByCode(c);
    if (!row) return send(ctx, `Session ${code(fmtCode(c))} not found.`);
    const csv = buildExportCsv(row, repo.listPlayers(row.id), repo.listAnswers(row.id));
    sendDoc(ctx, `cloud9-${c}-${slugify(row.quiz.title)}.csv`, csv, `${b(row.quiz.title)} · ${code(fmtCode(c))} — results CSV`);
  };
  const exportEvent = (ctx: Ctx, ev: EventDef) => {
    const lines = [csvRow(['rank', 'name', 'email', 'score', 'quizzes_played'])];
    for (const e of repo.eventLeaderboard(ev.id)) lines.push(csvRow([e.rank, e.name, e.email ?? '', e.score, e.quizzesPlayed]));
    sendDoc(ctx, `cloud9-event-${slugify(ev.name)}.csv`, '﻿' + lines.join('\r\n') + '\r\n', `${b(ev.name)} — event leaderboard CSV`);
  };
  const doExport = (ctx: Ctx, arg: string) => {
    if (!ctx.isPrivate) return send(ctx, 'Ask me in a private chat for the CSV.');
    const c = asCode(arg);
    if (c) return exportSession(ctx, c);
    const m = /^event\b\s*([\s\S]*)$/i.exec(arg);
    if (m) {
      const ev = resolveEvent(m[1]);
      if (typeof ev === 'string') return send(ctx, ev);
      return exportEvent(ctx, ev);
    }
    send(ctx, 'Usage: /export &lt;6-digit code&gt; or /export event [name]');
  };

  const doStats = (ctx: Ctx) => {
    const g = registry.stats();
    const o = sender.stats();
    const up = Math.floor(process.uptime());
    const upStr = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    const lines = [
      `⚙️ ${b('Cloud 9 status')}`,
      `Rooms: ${g.rooms} (${liveSessions().length} live) · sockets: ${g.sockets}`,
      `Uptime: ${upStr} · RSS: ${rss} MB`,
      `Telegram outbox: ${o.queued} queued · ${o.sent} sent · ${o.failed} failed`,
    ];
    if (o.lastError) lines.push(`Last error: ${esc(o.lastError.slice(0, 200))}`);
    send(ctx, lines.join('\n'));
  };

  // ───────────── dispatch ─────────────
  const runCommand = async (ctx: Ctx, cmd: string, args: string, explicitlyAddressed: boolean) => {
    switch (cmd) {
      case 'start': case 'help': return help(ctx);
      case 'live': return doLive(ctx);
      case 'events': return doEvents(ctx);
      case 'event': return doEvent(ctx, args);
      case 'leaderboard': case 'lb': return doLeaderboard(ctx, args);
      case 'winner': return doWinner(ctx, args);
      case 'session': return doSession(ctx, args);
      case 'quizzes': return doQuizzes(ctx, args);
      case 'export': return doExport(ctx, args);
      case 'stats': return doStats(ctx);
      default:
        // In groups, unknown commands may be for other bots — only answer when addressed to us.
        if (ctx.isPrivate || explicitlyAddressed) return help(ctx, `Unknown command /${esc(cmd)}.\n\n`);
    }
  };

  const runCallback = (ctx: Ctx, data: string) => {
    const idx = data.indexOf(':');
    const kind = idx > 0 ? data.slice(0, idx) : data;
    const arg = idx > 0 ? data.slice(idx + 1) : '';
    switch (kind) {
      case 'lb': { const c = asCode(arg); return c ? doQuizBoard(ctx, c) : undefined; }
      case 'lbe': { const ev = repo.getEvent(arg); return ev ? doEventBoard(ctx, ev) : send(ctx, 'Event not found.'); }
      case 'ses': return doSession(ctx, arg);
      case 'exp': {
        if (!ctx.isPrivate) return send(ctx, 'Ask me in a private chat for the CSV.');
        const c = asCode(arg); return c ? exportSession(ctx, c) : undefined;
      }
      case 'expe': {
        if (!ctx.isPrivate) return send(ctx, 'Ask me in a private chat for the CSV.');
        const ev = repo.getEvent(arg); return ev ? exportEvent(ctx, ev) : send(ctx, 'Event not found.');
      }
      default: return undefined;
    }
  };

  const ensureBotUsername = async () => {
    if (botUsername || botUsernameTried) return;
    botUsernameTried = true;
    try {
      const me = await client.call<{ username?: string }>('getMe');
      botUsername = me?.username ?? null;
    } catch (err) {
      botUsernameTried = false; // retry next time
      log('getMe failed', err);
    }
  };

  const rejectPrivate = (ctx: Ctx, userId: string) => {
    if (!ctx.isPrivate) return; // silence in groups
    const now = Date.now();
    const last = lastPrivateReply.get(userId) ?? 0;
    if (now - last < PRIVATE_REPLY_EVERY_MS) return;
    if (lastPrivateReply.size > 5000) lastPrivateReply.clear();
    lastPrivateReply.set(userId, now);
    sender.enqueue({ chatId: ctx.chatId, threadId: null, kind: 'text', text: 'This bot is private.', priority: 'normal' });
  };

  const ctxFrom = (msg: any): Ctx | null => {
    const chat = msg?.chat;
    if (!chat || chat.id === undefined || chat.id === null) return null;
    const threadId = msg.is_topic_message && typeof msg.message_thread_id === 'number' ? msg.message_thread_id : null;
    return { chatId: String(chat.id), threadId, isPrivate: chat.type === 'private' };
  };

  const handleMessage = async (msg: any) => {
    const ctx = ctxFrom(msg);
    if (!ctx) return;
    const text: unknown = msg.text;
    if (typeof text !== 'string' || !text) return;
    const fromId = msg.from?.id !== undefined ? String(msg.from.id) : '';
    const parsed = text.startsWith('/') ? parseCommand(text) : null;
    if (!fromId || !admins.has(fromId)) {
      // groups: stay silent; private: one polite note per hour
      return rejectPrivate(ctx, fromId || ctx.chatId);
    }
    if (!parsed) {
      if (ctx.isPrivate) help(ctx);
      return;
    }
    if (parsed.bot) {
      await ensureBotUsername();
      if (botUsername && parsed.bot.toLowerCase() !== botUsername.toLowerCase()) return; // for another bot
    }
    if (actions && (await actions.command(ctx, parsed.cmd, parsed.args, fromId))) return;
    await runCommand(ctx, parsed.cmd, parsed.args, !!parsed.bot);
  };

  const handleCallback = async (cq: any) => {
    const id = cq?.id;
    const answer = (text?: string) => {
      if (!id) return;
      client.call('answerCallbackQuery', text ? { callback_query_id: id, text } : { callback_query_id: id }).catch((err) => log('answerCallbackQuery failed', err));
    };
    const fromId = cq?.from?.id !== undefined ? String(cq.from.id) : '';
    if (!fromId || !admins.has(fromId)) return answer('This bot is private.');
    answer();
    const ctx = ctxFrom(cq.message);
    if (!ctx) return;
    const data = typeof cq.data === 'string' ? cq.data : '';
    const messageId = typeof cq.message?.message_id === 'number' ? cq.message.message_id : null;
    if (actions && (await actions.callback(ctx, data, fromId, messageId))) return;
    runCallback(ctx, data);
  };

  return {
    async handleUpdate(update: any) {
      try {
        if (update?.message) await handleMessage(update.message);
        else if (update?.callback_query) await handleCallback(update.callback_query);
      } catch (err) {
        log('update failed', err);
        try {
          const ctx = ctxFrom(update?.message ?? update?.callback_query?.message);
          const fromId = String(update?.message?.from?.id ?? update?.callback_query?.from?.id ?? '');
          if (ctx && admins.has(fromId)) send(ctx, 'Sorry, something went wrong with that command.');
        } catch { /* ignore */ }
      }
    },
    commands() {
      return allCommands();
    },
  };
};
