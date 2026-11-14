// Cloud 9 — configuration from environment. Owned by lead.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { TelegramConfig } from './notify/contracts';

export interface ModeratorConfig { id: string; username: string; password: string; displayName: string; isSuper: boolean }

export interface Config {
  port: number;
  host: string;
  publicUrl: string;          // e.g. https://quiz.example.com (no trailing slash). Join URLs = `${publicUrl}/join/${code}`
  dbPath: string;
  sessionSecret: string;
  moderators: ModeratorConfig[];
  maxPlayersPerRoom: number;
  webDist: string;            // built frontend directory
  secureCookies: boolean;     // true when publicUrl is https
  telegram: TelegramConfig | null;   // null = Telegram integration off
  /** Epoch ms from SESSION_NOT_BEFORE: moderator cookies issued before it are rejected (revoke all sessions). */
  sessionNotBefore?: number;
}

/** MODERATORS="admin:pass:super,anu:pass,rahul:pass" — optional 3rd field "super". Display name = username. */
export function parseModerators(raw: string): ModeratorConfig[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':');
      const username = (parts[0] ?? '').trim().toLowerCase();
      const isSuper = parts.length > 2 && parts[parts.length - 1].trim().toLowerCase() === 'super';
      const password = (isSuper ? parts.slice(1, -1) : parts.slice(1)).join(':');
      if (!/^[a-z0-9_.-]{1,32}$/.test(username) || !password) throw new Error(`Invalid MODERATORS entry: "${username}"`);
      return { id: `mod_${username}`, username, password, displayName: username, isSuper };
    });
}

/**
 * SESSION_NOT_BEFORE = epoch seconds (e.g. `date +%s`) or an ISO date/time. Returns epoch ms, or undefined when unset.
 * Throws on an unparseable value (an operator asked for a revocation — don't silently ignore it).
 * A future value is clamped to `now` so it can't lock every moderator out until then.
 */
export function parseSessionNotBefore(raw: string | undefined, now = Date.now()): number | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`[config] SESSION_NOT_BEFORE="${raw}" is not epoch seconds or an ISO date (e.g. 2026-11-14T10:00:00Z)`);
  if (ms > now) {
    console.warn('[config] SESSION_NOT_BEFORE is in the future — using the current time instead');
    return now;
  }
  return ms;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const moderators = parseModerators(env.MODERATORS ?? 'admin:admin:super');
  if (!env.MODERATORS) console.warn('[config] MODERATORS not set — using admin:admin (dev only!)');
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 16) {
    console.warn('[config] SESSION_SECRET missing/short — generating a random one (moderators will be logged out on restart)');
    sessionSecret = randomBytes(32).toString('hex');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    dbPath: env.DB_PATH ?? resolve('data/cloud9.db'),
    sessionSecret,
    moderators,
    maxPlayersPerRoom: Number(env.MAX_PLAYERS_PER_ROOM ?? 500),
    webDist: env.WEB_DIST ?? resolve('dist/web'),
    secureCookies: publicUrl.startsWith('https://'),
    telegram: parseTelegram(env),
    sessionNotBefore: parseSessionNotBefore(env.SESSION_NOT_BEFORE),
  };
}

const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
export function parseTelegram(env: NodeJS.ProcessEnv): TelegramConfig | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  const topics: Record<string, number> = {};
  for (const pair of list(env.TELEGRAM_TOPICS)) {
    const [k, v] = pair.split('=');
    const n = Number(v);
    if (k && Number.isInteger(n) && n > 0) topics[k.trim().toLowerCase()] = n;
  }
  const flag = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
  return {
    token,
    apiBase: (env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    notifyChatIds: list(env.TELEGRAM_NOTIFY_CHAT_IDS),
    adminIds: list(env.TELEGRAM_ADMIN_IDS),
    topics,
    notifyQuestions: flag(env.TELEGRAM_NOTIFY_QUESTIONS, false),
    digestMinutes: Math.max(0, Number(env.TELEGRAM_DIGEST_MINUTES ?? 30) || 0),
    sendCsv: flag(env.TELEGRAM_SEND_CSV, true),
  };
}
