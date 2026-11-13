// Cloud 9 — Telegram ADMIN ACTIONS (v2). Agent ACTIONS.
// Create a lobby, joining on/off, hide/show, end. Every change needs a confirm tap; confirms expire after 10 minutes.
// Never throws: every error → friendly reply + log without PII.
import QRCode from 'qrcode';
import type { CreateActions, Button, OutMsg, TgCtx } from './contracts';
import type { SessionSummary, EventDef, QuizListItem } from '../../../shared/model';
import type { SessionPatch } from '../../../shared/api';
import { esc, b, code, modName, fmtCode, clip } from './html';
import { asCode } from './commands';

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const MAX_QUIZ_BUTTONS = 40;
const MAX_PENDING = 2000;

type Op = 'jon' | 'joff' | 'hide' | 'show' | 'end';
const OPS: ReadonlySet<string> = new Set(['jon', 'joff', 'hide', 'show', 'end']);

const ACTION_COMMANDS = [
  { command: 'newsession', description: 'Create a lobby: [quiz filter]' },
  { command: 'joining', description: 'Joining on/off: <code> on|off' },
  { command: 'hide', description: 'Hide from home page: <code>' },
  { command: 'show', description: 'Show on home page: <code>' },
  { command: 'end', description: 'End a session now: <code>' },
];

/** Start time of a time range: "2:00–2:30 PM" → "2:00 PM"; "11:55 AM–12:25 PM" → "11:55 AM"; "2 PM" → "2 PM". */
function startTime(seg: string): string | null {
  const m = /^(\d{1,2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\s*(?:[–—-]\s*\d{1,2}(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?)?$/.exec(seg.trim());
  if (!m) return null;
  const mer = (m[2] ?? m[3] ?? '').replace(/\./g, '').toUpperCase();
  return mer ? `${m[1]} ${mer}` : m[1];
}

/** "Hall 3 · 2:00–2:30 PM · Cloud Basics" → "Hall 3 · 2:00 PM"; no hall/time pattern → ''. */
export function parseLabel(title: string): string {
  const parts = String(title ?? '').split(/\s*[·•|]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const hall = parts[0];
  const t = startTime(parts[1]);
  if (!t || !hall || hall.length > 40) return '';
  return `${hall} · ${t}`.slice(0, 60);
}

const trimTitle = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const playersIn = (n: number) => (n === 1 ? '1 player is in.' : `${n} players are in.`);

export const createActions: CreateActions = ({ cfg, client, sender, repo, registry, config, bus }) => {
  const admins = new Set(cfg.adminIds.map(String));
  /** key `${chatId}|${data}` → expiry + preview message id (when known). */
  const pending = new Map<string, { exp: number; messageId: number | null }>();

  const log = (msg: string, err?: unknown) => {
    const e = err instanceof Error ? `${err.name}: ${err.message}` : err !== undefined ? String(err) : '';
    console.warn(`[telegram/actions] ${msg}${e ? ' — ' + e.slice(0, 200) : ''}`);
  };

  const send = (ctx: TgCtx, text: string, buttons?: Button[][]) => {
    const m: OutMsg = { chatId: ctx.chatId, threadId: ctx.threadId, kind: 'text', text: clip(text), priority: 'high' };
    if (buttons && buttons.length) m.buttons = buttons;
    sender.enqueue(m);
  };

  /** Edit the message the button sat on (removing/replacing buttons); fall back to a new message. */
  const reply = async (ctx: TgCtx, messageId: number | null, text: string, buttons?: Button[][]) => {
    if (messageId !== null) {
      try {
        await client.call('editMessageText', {
          chat_id: ctx.chatId, message_id: messageId, text: clip(text), parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: { inline_keyboard: (buttons ?? []).map((row) => row.map((x) => ({ text: x.text, callback_data: x.data }))) },
        });
        return;
      } catch (err) {
        log('editMessageText failed, sending new message', err);
      }
    }
    send(ctx, text, buttons);
  };

  // ───────────── confirmations ─────────────
  const pkey = (ctx: TgCtx, data: string) => `${ctx.chatId}|${data}`;
  const prune = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.exp <= now) pending.delete(k);
    if (pending.size > MAX_PENDING) pending.clear();
  };
  const arm = (ctx: TgCtx, data: string, messageId: number | null) => {
    prune();
    pending.set(pkey(ctx, data), { exp: Date.now() + CONFIRM_TTL_MS, messageId });
  };
  /** Consumes the confirmation (one use). */
  const take = (ctx: TgCtx, data: string): boolean => {
    const k = pkey(ctx, data);
    const p = pending.get(k);
    pending.delete(k);
    return !!p && p.exp > Date.now();
  };
  const EXPIRED = 'This button expired — run the command again.';

  // ───────────── helpers ─────────────
  const actorOf = (fromId: string) => `telegram:${fromId}`;
  const urls = (c: string) => ({
    join: `${config.publicUrl}/join/${c}`,
    present: `${config.publicUrl}/present/${c}`,
    mod: `${config.publicUrl}/mod/room/${c}`,
  });
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
  const liveOfQuiz = (quizId: string) => registry.listSummaries().find((s) => s.quizId === quizId && s.state !== 'FINISHED') ?? null;
  const roomName = (s: SessionSummary) => `${b(s.title)}${s.label ? ` (${esc(s.label)})` : ''}`;

  /** Live room for an action, or a friendly error string. */
  const liveRoom = (c: string): SessionSummary | string => {
    const s = registry.summary(c);
    if (!s) {
      const row = repo.getLatestSessionByCode(c);
      return row ? `Session ${code(fmtCode(c))} is no longer live.` : `Session ${code(fmtCode(c))} not found.`;
    }
    if (s.state === 'FINISHED') return `Session ${code(fmtCode(c))} (${esc(s.title)}) has already finished.`;
    return s;
  };

  // ───────────── /newsession ─────────────
  const createPreview = async (ctx: TgCtx, quizId: string, messageId: number | null) => {
    const quiz = repo.getQuiz(quizId);
    if (!quiz) return reply(ctx, messageId, 'That quiz no longer exists. Run /newsession again.');
    const label = parseLabel(quiz.title);
    const live = liveOfQuiz(quiz.id);
    const lines = [
      `Create a lobby for ${b(quiz.title)}?`,
      `Owner: ${esc(modName(quiz.moderatorId))} · Label: ${esc(label || '—')} · Players can join as soon as it's created.`,
    ];
    if (!quiz.questions.length) lines.push('', '⚠️ This quiz has no questions yet — it cannot be started.');
    if (live) lines.push('', `⚠️ Already live: code ${code(fmtCode(live.code))}`);
    const data = `nsy:${quiz.id}`;
    arm(ctx, data, messageId);
    await reply(ctx, messageId, lines.join('\n'), [[{ text: '✅ Create', data }, { text: '✖ Cancel', data: 'cxl' }]]);
  };

  const doNewSession = async (ctx: TgCtx, args: string) => {
    const ev = defaultEvent();
    let quizzes: QuizListItem[] = ev ? repo.listQuizzes(null, ev.id) : repo.listQuizzes(null);
    const f = args.trim().toLowerCase();
    if (f) quizzes = quizzes.filter((q) => q.title.toLowerCase().includes(f));
    const where = ev ? ` in ${b(ev.name)}` : '';
    if (!quizzes.length) return send(ctx, f ? `No quizzes match ${b(args.trim())}${where}.` : `No quizzes yet${where}.`);
    if (quizzes.length === 1) return createPreview(ctx, quizzes[0].id, null);
    const shown = quizzes.slice(0, MAX_QUIZ_BUTTONS).filter((q) => Buffer.byteLength(`nsq:${q.id}`) <= 64);
    const head = `🆕 ${b('New session')}${where} — pick a quiz${f ? ` matching ${b(args.trim())}` : ''}:`;
    const more = quizzes.length > shown.length ? `\nShowing ${shown.length} of ${quizzes.length} — add a filter: /newsession &lt;text&gt;` : '';
    send(ctx, head + more, shown.map((q) => [{ text: trimTitle(q.title), data: `nsq:${q.id}` }]));
  };

  const doCreate = async (ctx: TgCtx, quizId: string, fromId: string, messageId: number | null) => {
    const quiz = repo.getQuiz(quizId);
    if (!quiz) return reply(ctx, messageId, 'That quiz no longer exists.');
    if (quiz.questions.length < 1) return reply(ctx, messageId, `${b(quiz.title)} has no questions — add some first.`);
    const live = liveOfQuiz(quiz.id);
    if (live) return reply(ctx, messageId, `Already live: code ${code(fmtCode(live.code))} · ${esc(live.label || '—')}`, [[{ text: 'Details', data: `ses:${live.code}` }]]);
    const event = quiz.eventId ? repo.getEvent(quiz.eventId) : null;
    const label = parseLabel(quiz.title);
    const s = registry.createSession({ quiz, event, moderatorId: quiz.moderatorId, label, listed: true });
    try {
      bus.emit({ type: 'session.created', at: Date.now(), actor: actorOf(fromId), session: s });
    } catch (err) { log('emit session.created failed', err); }
    const u = urls(s.code);
    const lines = [
      `Done ✓ Lobby created for ${b(s.title)}`,
      `Code: ${code(fmtCode(s.code))} · ${esc(s.label || '—')} · owner ${esc(modName(s.moderatorId))}`,
      `Join: ${esc(u.join)}`,
      `Projector: ${esc(u.present)}`,
      `Moderator: ${esc(u.mod)}`,
    ];
    await reply(ctx, messageId, lines.join('\n'), [[
      { text: 'Details', data: `ses:${s.code}` },
      { text: 'Close joining', data: `act:joff:${s.code}` },
      { text: 'End', data: `act:end:${s.code}` },
    ]]);
    try {
      const png = await QRCode.toBuffer(u.join, { type: 'png', margin: 1, width: 600, errorCorrectionLevel: 'M' });
      await client.sendPhoto(ctx.chatId, { filename: `cloud9-${s.code}.png`, content: png }, { caption: `Scan to join · ${fmtCode(s.code)}`, threadId: ctx.threadId });
    } catch (err) {
      log('QR sendPhoto failed', err);
    }
  };

  // ───────────── joining / hide / show / end ─────────────
  const opPreview = async (ctx: TgCtx, op: Op, c: string, messageId: number | null) => {
    const r = liveRoom(c);
    if (typeof r === 'string') return reply(ctx, messageId, r);
    const who = roomName(r);
    let q: string;
    switch (op) {
      case 'jon':
        if (r.joinOpen) return reply(ctx, messageId, `Joining is already open for ${who}.`);
        q = `Open joining for ${who}? ${playersIn(r.players)}`; break;
      case 'joff':
        if (!r.joinOpen) return reply(ctx, messageId, `Joining is already closed for ${who}.`);
        q = `Close joining for ${who}? ${playersIn(r.players)}`; break;
      case 'hide':
        if (!r.listed) return reply(ctx, messageId, `${who} is already hidden from the home page.`);
        q = `Hide ${who} from the home page? Players with the code can still join.`; break;
      case 'show':
        if (r.listed) return reply(ctx, messageId, `${who} is already shown on the home page.`);
        q = `Show ${who} on the home page?`; break;
      case 'end':
        q = `End ${who} now? ${playersIn(r.players)} The final leaderboard will be posted.`; break;
    }
    const data = `acy:${op}:${r.code}`;
    arm(ctx, data, messageId);
    // From an inline button (act:) we answer with a new message so the session message keeps its links.
    send(ctx, `${q}\nCode: ${code(fmtCode(r.code))}`, [[{ text: '✅ Yes', data }, { text: '✖ Cancel', data: 'cxl' }]]);
  };

  const doOp = async (ctx: TgCtx, op: Op, c: string, fromId: string, messageId: number | null) => {
    const r = liveRoom(c);
    if (typeof r === 'string') return reply(ctx, messageId, r);
    const actor = actorOf(fromId);
    const who = roomName(r);
    if (op === 'end') {
      const res = registry.endSession(c, actor);
      if (!res.ok) return reply(ctx, messageId, res.error === 'finished' ? `${who} has already finished.` : `Session ${code(fmtCode(c))} not found.`);
      return reply(ctx, messageId, `Done ✓ Ended ${who} · ${code(fmtCode(c))}. Final leaderboard coming up.`, [[{ text: 'Details', data: `ses:${c}` }]]);
    }
    const patch: SessionPatch = op === 'jon' ? { joinOpen: true } : op === 'joff' ? { joinOpen: false } : { listed: op === 'show' };
    const s = registry.patch(c, patch);
    if (!s) return reply(ctx, messageId, `Session ${code(fmtCode(c))} not found.`);
    const changes: SessionPatch = {};
    if (s.listed !== r.listed) changes.listed = s.listed;
    if (s.joinOpen !== r.joinOpen) changes.joinOpen = s.joinOpen;
    if (Object.keys(changes).length) {
      try {
        bus.emit({ type: 'session.updated', at: Date.now(), actor, session: s, changes });
      } catch (err) { log('emit session.updated failed', err); }
    }
    const what = op === 'jon' ? 'Joining opened for' : op === 'joff' ? 'Joining closed for' : op === 'hide' ? 'Hidden from the home page:' : 'Shown on the home page:';
    await reply(ctx, messageId, `Done ✓ ${what} ${who} · ${code(fmtCode(c))}`, [[{ text: 'Details', data: `ses:${c}` }]]);
  };

  const usage: Record<string, string> = {
    joining: 'Usage: /joining &lt;6-digit code&gt; on|off',
    hide: 'Usage: /hide &lt;6-digit code&gt;',
    show: 'Usage: /show &lt;6-digit code&gt;',
    end: 'Usage: /end &lt;6-digit code&gt;',
  };

  return {
    async command(ctx, cmd, args, fromId) {
      if (!ACTION_COMMANDS.some((c) => c.command === cmd)) return false;
      if (!admins.has(String(fromId))) return false; // defence in depth — router already checked
      try {
        if (cmd === 'newsession') { await doNewSession(ctx, args); return true; }
        let op: Op;
        let rest = args;
        if (cmd === 'joining') {
          const m = /^([\s\S]*?)\s+(on|off|open|close|closed)$/i.exec(args.trim());
          if (!m) { send(ctx, usage.joining); return true; }
          rest = m[1];
          op = /^(on|open)$/i.test(m[2]) ? 'jon' : 'joff';
        } else op = cmd as Op;
        const c = asCode(rest);
        if (!c) { send(ctx, usage[cmd]); return true; }
        await opPreview(ctx, op, c, null);
      } catch (err) {
        log(`/${cmd} failed`, err);
        try { send(ctx, 'Sorry, that action failed. Nothing was changed.'); } catch { /* */ }
      }
      return true;
    },

    async callback(ctx, data, fromId, messageId) {
      const kind = data.split(':', 1)[0];
      if (!['nsq', 'nsy', 'act', 'acy', 'cxl'].includes(kind)) return false;
      if (!admins.has(String(fromId))) return true; // swallow: never act for non-admins
      try {
        if (kind === 'cxl') {
          if (messageId !== null) for (const [k, v] of pending) if (v.messageId === messageId && k.startsWith(`${ctx.chatId}|`)) pending.delete(k);
          await reply(ctx, messageId, 'Cancelled.');
          return true;
        }
        if (kind === 'nsq') { await createPreview(ctx, data.slice(4), messageId); return true; }
        if (kind === 'nsy') {
          if (!take(ctx, data)) { await reply(ctx, messageId, EXPIRED); return true; }
          await doCreate(ctx, data.slice(4), fromId, messageId);
          return true;
        }
        const [, op, raw] = data.split(':');
        const c = asCode(raw ?? '');
        if (!c || !OPS.has(op)) { await reply(ctx, messageId, 'Unknown action.'); return true; }
        if (kind === 'act') { await opPreview(ctx, op as Op, c, null); return true; }
        // acy
        if (!take(ctx, data)) { await reply(ctx, messageId, EXPIRED); return true; }
        await doOp(ctx, op as Op, c, fromId, messageId);
      } catch (err) {
        log(`callback ${kind} failed`, err);
        try { send(ctx, 'Sorry, that action failed. Nothing was changed.'); } catch { /* */ }
      }
      return true;
    },

    commands() {
      return ACTION_COMMANDS.map((c) => ({ ...c }));
    },
  };
};
