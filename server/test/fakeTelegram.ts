// Cloud 9 — fake Telegram Bot API server for tests. Owned by QA.
//
// A tiny node:http server that speaks enough of https://core.telegram.org/bots/api for the bot:
//   getMe, deleteWebhook, setMyCommands, getUpdates (real long-poll), sendMessage, sendDocument (multipart),
//   sendPhoto (multipart, raw bytes kept), answerCallbackQuery, editMessageText, editMessageReplyMarkup.
// Every call is recorded in `calls`. Point the server at it with TELEGRAM_API_BASE=fake.url.
//
//   const tg = await startFakeTelegram({ token: '123:abc' });
//   tg.userMessage(555, 555, '/live');
//   const reply = await tg.waitFor((c) => c.method === 'sendMessage' && chatOf(c) === '555');
//   tg.failNext('sendMessage', { code: 429, retry_after: 2 });
//   await tg.stop(); await tg.start();   // simulate an outage; same port, same recorded state
//   await tg.close();

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An uploaded file. `content` is the body decoded as UTF-8 (fine for CSV); `bytes` is the raw body (use it for PNGs). */
export interface TgDocument { field: string; filename: string; content: string; bytes: Buffer; mime: string }
export interface TgCall {
  seq: number;
  at: number;
  method: string;
  params: Record<string, any>;   // JSON / form / multipart fields; reply_markup parsed to an object when possible
  document?: TgDocument;         // sendDocument only
  photo?: TgDocument;            // sendPhoto only (multipart upload)
  status: number;                // HTTP status we answered with
}
export interface FailSpec { code: number; retry_after?: number; description?: string; times?: number }

export interface FakeTelegram {
  readonly token: string;
  /** API base for TELEGRAM_API_BASE (http://127.0.0.1:<port>), no trailing slash. */
  readonly url: string;
  readonly port: number;
  readonly calls: TgCall[];
  readonly running: boolean;
  /** Queue an Update (update_id assigned if missing) and wake any pending getUpdates. Returns the update. */
  pushUpdate(update: Record<string, any>): Record<string, any>;
  /** Push a text message update. chatType defaults to 'private' for positive ids, 'supergroup' for negative ids. */
  userMessage(fromId: number | string, chatId: number | string, text: string, chatType?: 'private' | 'group' | 'supergroup', extra?: Record<string, any>): Record<string, any>;
  /** Push a callback_query update (inline button press) on the last bot message in that chat. */
  clickButton(fromId: number | string, chatId: number | string, data: string): Record<string, any>;
  /** Resolves with the first recorded call (from `sinceSeq` on) matching predicate; rejects after ms. */
  waitFor(predicate: (c: TgCall) => boolean, ms?: number, sinceSeq?: number): Promise<TgCall>;
  /** Like waitFor but resolves null on timeout instead of rejecting. */
  tryWaitFor(predicate: (c: TgCall) => boolean, ms?: number, sinceSeq?: number): Promise<TgCall | null>;
  /** Make the next call(s) to `method` fail with error_code=code (and parameters.retry_after for 429). */
  failNext(method: string, spec: FailSpec): void;
  /** Calls by method (and optional chat id). */
  callsOf(method: string, chatId?: string | number): TgCall[];
  /** Everything the bot sent (sendMessage / sendDocument / sendPhoto / editMessageText), optionally to one chat. */
  sent(chatId?: string | number): TgCall[];
  /** Highest seq so far (use as a `sinceSeq` marker). */
  mark(): number;
  /** Stop listening (simulated outage): pending long-polls are dropped, connections destroyed. State is kept. */
  stop(): Promise<void>;
  /** Listen again on the same port. */
  start(): Promise<void>;
  /** Stop for good. */
  close(): Promise<void>;
  reset(): void;
}

// ───────────────────────────── helpers usable by tests ─────────────────────────────
export const chatOf = (c: TgCall): string => (c.params.chat_id === undefined ? '' : String(c.params.chat_id));
export const threadOf = (c: TgCall): number | null => {
  const t = c.params.message_thread_id;
  if (t === undefined || t === null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** text / caption of a call. */
export const textOf = (c: TgCall): string => String(c.params.text ?? c.params.caption ?? '');
/** Everything a human (or a leak check) could see in a call: text, caption, buttons, document name + body. */
export const visibleOf = (c: TgCall): string =>
  [textOf(c), c.params.reply_markup ? JSON.stringify(c.params.reply_markup) : '', c.document?.filename ?? '', c.document?.content ?? '', c.photo?.filename ?? ''].join('\n');
/** True if the bytes start with the PNG signature. */
export const isPng = (b: Buffer | undefined): boolean => !!b && b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
/** All callback_data values of the inline keyboard on a call. */
export const buttonsOf = (c: TgCall): string[] => {
  const kb = c.params.reply_markup?.inline_keyboard;
  if (!Array.isArray(kb)) return [];
  return kb.flat().map((b: any) => String(b?.callback_data ?? '')).filter(Boolean);
};

const SEND_METHODS = new Set(['sendMessage', 'sendDocument', 'sendPhoto', 'editMessageText']);

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try { return JSON.parse(s); } catch { return v; }
}

function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: TgDocument[] } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields: Record<string, string> = {};
  const files: TgDocument[] = [];
  if (!m) return { fields, files };
  const boundary = `--${(m[1] ?? m[2]).trim()}`;
  const raw = body.toString('latin1');
  for (let part of raw.split(boundary)) {
    if (part.startsWith('--')) break;                 // closing boundary
    part = part.replace(/^\r\n/, '');
    if (!part.trim()) continue;
    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    let content = part.slice(sep + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const value = Buffer.from(content, 'latin1').toString('utf8');
    const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '';
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const mime = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream';
    if (filename !== undefined) files.push({ field: name, filename: Buffer.from(filename, 'latin1').toString('utf8'), content: value, bytes: Buffer.from(content, 'latin1'), mime });
    else fields[name] = value;
  }
  return { fields, files };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startFakeTelegram(opts: { token?: string; botUsername?: string; port?: number; log?: boolean } = {}): Promise<FakeTelegram> {
  const token = opts.token ?? '123:abc';
  const botId = Number(token.split(':')[0]) || 123;
  const botUsername = opts.botUsername ?? 'cloud9_test_bot';
  const calls: TgCall[] = [];
  let updates: Record<string, any>[] = [];
  let nextUpdateId = 1000;
  let nextMessageId = 1;
  let nextCallbackId = 1;
  const lastMsgIdByChat = new Map<string, number>();
  const failures = new Map<string, FailSpec[]>();
  const pollers = new Set<{ offset: number; finish: (result: any[]) => void }>();
  const sockets = new Set<import('node:net').Socket>();
  let server: Server | null = null;
  let port = opts.port ?? 0;
  let seq = 0;
  const waiters = new Set<() => void>();

  const notify = () => { for (const w of [...waiters]) w(); };
  const log = (...a: unknown[]) => { if (opts.log) console.log('[fakeTelegram]', ...a); };

  function send(res: ServerResponse, status: number, body: unknown) {
    if (res.writableEnded || res.destroyed) return;
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }
  const ok = (res: ServerResponse, result: unknown) => send(res, 200, { ok: true, result });
  const err = (res: ServerResponse, code: number, description: string, extra?: Record<string, unknown>) =>
    send(res, code, { ok: false, error_code: code, description, ...(extra ? { parameters: extra } : {}) });

  function pending(offset: number) {
    return updates.filter((u) => u.update_id >= offset);
  }

  function makeMessage(chatId: string, params: Record<string, any>, extra: Record<string, any>) {
    const id = nextMessageId++;
    lastMsgIdByChat.set(chatId, id);
    const n = Number(chatId);
    return {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number.isFinite(n) ? n : chatId, type: n < 0 ? 'supergroup' : 'private' },
      from: { id: botId, is_bot: true, first_name: 'Cloud 9', username: botUsername },
      ...(threadOf({ params } as TgCall) !== null ? { message_thread_id: threadOf({ params } as TgCall), is_topic_message: true } : {}),
      ...extra,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m) return err(res, 404, 'Not Found');
    const [, tok, method] = m;
    const body = await readBody(req);

    // params: query string + body (json / urlencoded / multipart)
    const params: Record<string, any> = Object.fromEntries(url.searchParams);
    let document: TgDocument | undefined;
    let photo: TgDocument | undefined;
    const ct = String(req.headers['content-type'] ?? '');
    try {
      if (body.length) {
        if (ct.includes('application/json')) Object.assign(params, JSON.parse(body.toString('utf8')));
        else if (ct.includes('application/x-www-form-urlencoded')) Object.assign(params, Object.fromEntries(new URLSearchParams(body.toString('utf8'))));
        else if (ct.includes('multipart/form-data')) {
          const mp = parseMultipart(body, ct);
          Object.assign(params, mp.fields);
          if (method === 'sendPhoto') photo = mp.files.find((f) => f.field === 'photo') ?? mp.files[0];
          else document = mp.files.find((f) => f.field === 'document') ?? mp.files[0];
        }
      }
    } catch {
      return err(res, 400, 'Bad Request: can\'t parse request body');
    }
    for (const k of ['reply_markup', 'allowed_updates', 'commands']) if (k in params) params[k] = parseMaybeJson(params[k]);

    const call: TgCall = { seq: ++seq, at: Date.now(), method, params, document, ...(photo ? { photo } : {}), status: 200 };
    calls.push(call);
    log(method, JSON.stringify(params).slice(0, 200));
    const reply = (status: number, fn: () => void) => { call.status = status; fn(); notify(); };

    if (tok !== token) return reply(401, () => err(res, 401, 'Unauthorized'));

    const queue = failures.get(method);
    if (queue && queue.length) {
      const f = queue[0];
      if (f.times === undefined || f.times <= 1) queue.shift(); else f.times--;
      const desc = f.description ?? (f.code === 429 ? `Too Many Requests: retry after ${f.retry_after ?? 1}` : f.code >= 500 ? 'Internal Server Error' : 'Bad Request');
      return reply(f.code, () => err(res, f.code, desc, f.code === 429 ? { retry_after: f.retry_after ?? 1 } : undefined));
    }

    const needChat = () => {
      if (params.chat_id === undefined || params.chat_id === '') { reply(400, () => err(res, 400, 'Bad Request: chat_id is empty')); return false; }
      return true;
    };

    switch (method) {
      case 'getMe':
        return reply(200, () => ok(res, { id: botId, is_bot: true, first_name: 'Cloud 9', username: botUsername, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }));
      case 'deleteWebhook':
      case 'setMyCommands':
      case 'answerCallbackQuery':
      case 'editMessageReplyMarkup':
        return reply(200, () => ok(res, true));
      case 'sendMessage': {
        if (!needChat()) return;
        if (!String(params.text ?? '').trim()) return reply(400, () => err(res, 400, 'Bad Request: message text is empty'));
        return reply(200, () => ok(res, makeMessage(String(params.chat_id), params, { text: String(params.text) })));
      }
      case 'sendDocument': {
        if (!needChat()) return;
        if (!document && !params.document) return reply(400, () => err(res, 400, 'Bad Request: there is no document in the request'));
        const doc = { file_id: `f${seq}`, file_unique_id: `u${seq}`, file_name: document?.filename ?? 'file', mime_type: document?.mime, file_size: Buffer.byteLength(document?.content ?? '') };
        return reply(200, () => ok(res, makeMessage(String(params.chat_id), params, { document: doc, ...(params.caption ? { caption: String(params.caption) } : {}) })));
      }
      case 'sendPhoto': {
        if (!needChat()) return;
        if (!photo && !params.photo) return reply(400, () => err(res, 400, 'Bad Request: there is no photo in the request'));
        const size = photo?.bytes.length ?? 0;
        const sizes = [{ file_id: `p${seq}`, file_unique_id: `pu${seq}`, width: 320, height: 320, file_size: size }];
        return reply(200, () => ok(res, makeMessage(String(params.chat_id), params, { photo: sizes, ...(params.caption ? { caption: String(params.caption) } : {}) })));
      }
      case 'editMessageText': {
        if (!needChat()) return;
        if (!params.message_id) return reply(400, () => err(res, 400, 'Bad Request: message identifier is not specified'));
        return reply(200, () => ok(res, { ...makeMessage(String(params.chat_id), params, { text: String(params.text ?? '') }), message_id: Number(params.message_id) }));
      }
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0) || 0;
        if (offset > 0) updates = updates.filter((u) => u.update_id >= offset);  // confirm
        const timeoutSec = Math.max(0, Math.min(60, Number(params.timeout ?? 0) || 0));
        const ready = pending(offset);
        if (ready.length || timeoutSec === 0) return reply(200, () => ok(res, ready.slice(0, Number(params.limit ?? 100) || 100)));
        // a newer getUpdates supersedes older ones (real Telegram answers the older with 409; we just end it empty)
        for (const p of [...pollers]) p.finish([]);
        let done = false;
        const entry = {
          offset,
          finish: (result: any[]) => {
            if (done) return; done = true;
            clearTimeout(timer); pollers.delete(entry);
            reply(200, () => ok(res, result));
          },
        };
        const timer = setTimeout(() => entry.finish([]), timeoutSec * 1000);
        pollers.add(entry);
        res.on('close', () => { if (!done) { done = true; clearTimeout(timer); pollers.delete(entry); } });
        return;
      }
      default:
        return reply(404, () => err(res, 404, 'Not Found: method not found'));
    }
  }

  async function listen() {
    if (server) return;
    const s = createServer((req, res) => {
      handle(req, res).catch((e) => { try { err(res, 500, `Internal: ${(e as Error).message}`); } catch { /* ignore */ } });
    });
    s.keepAliveTimeout = 1000;
    s.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve()); });
    port = (s.address() as AddressInfo).port;
    server = s;
    log('listening on', port);
  }

  async function unlisten() {
    const s = server;
    if (!s) return;
    server = null;
    for (const p of [...pollers]) pollers.delete(p);
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    log('stopped');
  }

  function tryWaitFor(predicate: (c: TgCall) => boolean, ms = 10_000, sinceSeq = 0): Promise<TgCall | null> {
    return new Promise((resolve) => {
      const check = () => {
        const hit = calls.find((c) => c.seq > sinceSeq && c.status === 200 && predicate(c));
        if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); return true; }
        return false;
      };
      const timer = setTimeout(() => { waiters.delete(check); resolve(null); }, ms);
      if (!check()) waiters.add(check);
    });
  }

  await listen();

  const fake: FakeTelegram = {
    token,
    get url() { return `http://127.0.0.1:${port}`; },
    get port() { return port; },
    calls,
    get running() { return server !== null; },
    pushUpdate(update) {
      const u = { ...update };
      if (typeof u.update_id !== 'number') u.update_id = nextUpdateId++;
      else nextUpdateId = Math.max(nextUpdateId, u.update_id + 1);
      updates.push(u);
      for (const p of [...pollers]) {
        const ready = pending(p.offset);
        if (ready.length) p.finish(ready);
      }
      return u;
    },
    userMessage(fromId, chatId, text, chatType, extra = {}) {
      const cid = Number(chatId);
      const type = chatType ?? (cid < 0 ? 'supergroup' : 'private');
      const from = { id: Number(fromId), is_bot: false, first_name: `User${fromId}`, username: `user${fromId}`, language_code: 'en' };
      const cmd = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(text);
      return fake.pushUpdate({
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          from,
          chat: type === 'private' ? { id: cid, type, first_name: from.first_name, username: from.username } : { id: cid, type, title: 'Cloud 9 crew' },
          text,
          ...(cmd ? { entities: [{ type: 'bot_command', offset: 0, length: cmd[0].length }] } : {}),
          ...extra,
        },
      });
    },
    clickButton(fromId, chatId, data) {
      const cid = Number(chatId);
      const key = String(chatId);
      const msgId = lastMsgIdByChat.get(key) ?? 1;
      return fake.pushUpdate({
        callback_query: {
          id: `cb${nextCallbackId++}`,
          from: { id: Number(fromId), is_bot: false, first_name: `User${fromId}`, username: `user${fromId}` },
          chat_instance: `ci${key}`,
          data,
          message: {
            message_id: msgId,
            date: Math.floor(Date.now() / 1000),
            chat: cid < 0 ? { id: cid, type: 'supergroup', title: 'Cloud 9 crew' } : { id: cid, type: 'private' },
            from: { id: botId, is_bot: true, first_name: 'Cloud 9', username: botUsername },
            text: '…',
          },
        },
      });
    },
    async waitFor(predicate, ms = 10_000, sinceSeq = 0) {
      const hit = await tryWaitFor(predicate, ms, sinceSeq);
      if (!hit) throw new Error(`fakeTelegram.waitFor timed out after ${ms} ms (${calls.length} calls recorded: ${[...new Set(calls.map((c) => c.method))].join(', ') || 'none'})`);
      return hit;
    },
    tryWaitFor,
    failNext(method, spec) {
      const q = failures.get(method) ?? [];
      q.push({ ...spec });
      failures.set(method, q);
    },
    callsOf(method, chatId) {
      return calls.filter((c) => c.method === method && (chatId === undefined || chatOf(c) === String(chatId)));
    },
    sent(chatId) {
      return calls.filter((c) => SEND_METHODS.has(c.method) && c.status === 200 && (chatId === undefined || chatOf(c) === String(chatId)));
    },
    mark() { return seq; },
    stop: unlisten,
    start: listen,
    async close() { failures.clear(); await unlisten(); },
    reset() { calls.length = 0; updates = []; failures.clear(); lastMsgIdByChat.clear(); },
  };
  return fake;
}
