// Cloud 9 — Telegram Bot API client (transport only). Agent SENDER.
// Never logs the token or full URLs; error messages are redacted.
import { TgError, type CreateTgClient, type TgClient, type TelegramConfig, type Button } from './contracts';

const DEFAULT_TIMEOUT_MS = 15_000;
const DOC_TIMEOUT_MS = 60_000;
const PERMANENT = new Set([400, 401, 403, 404]);

interface ApiResponse { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } }

export const createTgClient: CreateTgClient = (cfg: TelegramConfig): TgClient => {
  const base = cfg.apiBase.replace(/\/+$/, '');
  const token = cfg.token;
  const redact = (s: string) => (token ? s.split(token).join('<token>') : s).replace(/\/bot[^/\s]+/g, '/bot<token>');
  const urlFor = (method: string) => `${base}/bot${token}/${method}`;

  async function request<T>(method: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    let bodyText: string;
    try {
      res = await fetch(urlFor(method), { ...init, signal: ac.signal });
      bodyText = await res.text();
    } catch (e: any) {
      const aborted = ac.signal.aborted;
      const msg = aborted ? `timeout after ${timeoutMs}ms` : `network error: ${redact(String(e?.cause?.code ?? e?.message ?? e))}`;
      throw new TgError(`${method}: ${msg}`, 0, null, false);
    } finally {
      clearTimeout(timer);
    }
    let data: ApiResponse | null = null;
    try { data = JSON.parse(bodyText) as ApiResponse; } catch { data = null; }
    if (data && data.ok === true) return data.result as T;
    const code = Number(data?.error_code ?? res.status) || res.status || 0;
    const retryAfter = data?.parameters?.retry_after;
    const description = redact(String(data?.description ?? `HTTP ${res.status}`)).slice(0, 300);
    throw new TgError(`${method}: ${description}`, code, typeof retryAfter === 'number' ? retryAfter : null, code !== 429 && PERMANENT.has(code));
  }

  return {
    call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts?: { timeoutMs?: number }): Promise<T> {
      let timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!opts?.timeoutMs && method === 'getUpdates' && typeof params.timeout === 'number') timeoutMs = (params.timeout + 10) * 1000;
      return request<T>(method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, timeoutMs);
    },
    async sendDocument(chatId, doc, opts) {
      const fd = new FormData();
      fd.append('chat_id', chatId);
      if (opts?.threadId != null) fd.append('message_thread_id', String(opts.threadId));
      if (opts?.caption) { fd.append('caption', opts.caption); fd.append('parse_mode', 'HTML'); }
      const rm = inlineKeyboard(opts?.buttons);
      if (rm) fd.append('reply_markup', JSON.stringify(rm));
      fd.append('document', new Blob([doc.content], { type: doc.mime ?? 'text/csv' }), doc.filename);
      await request<unknown>('sendDocument', { method: 'POST', body: fd }, DOC_TIMEOUT_MS);
    },
  };
};

/** Button[][] → Telegram reply_markup (shared with sender). */
export const inlineKeyboard = (buttons?: Button[][]) =>
  buttons && buttons.length ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined;
