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
 * Integer env var with a fallback: unset/empty → `def`; non-numeric or outside [min, max] → warn and use `def`.
 * (Previously e.g. MAX_PLAYERS_PER_ROOM=abc became NaN and silently disabled the room cap.)
 */
export function parseIntEnv(name: string, raw: string | undefined, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[config] ${name}="${raw}" is not a number in ${min}..${max} — using ${def}`);
    return def;
  }
  return Math.floor(n);
}

export const MIN_PROD_SECRET_LEN = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // Fail closed: in production never fall back to the dev admin:admin account or a weak/missing session secret.
  if (production) {
    const problems: string[] = [];
    if (!(env.MODERATORS ?? '').trim()) problems.push('MODERATORS is not set (format: user:password[:super],...)');
    if ((env.SESSION_SECRET ?? '').length < MIN_PROD_SECRET_LEN) {
      problems.push(`SESSION_SECRET must be at least ${MIN_PROD_SECRET_LEN} characters (generate with: openssl rand -hex 32)`);
    }
    if (problems.length) {
      throw new Error(`[config] Refusing to start with NODE_ENV=production: ${problems.join('; ')}. Set them in .env and restart.`);
    }
  }
  const port = parseIntEnv('PORT', env.PORT, 3000, 1, 65535);
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
    maxPlayersPerRoom: parseIntEnv('MAX_PLAYERS_PER_ROOM', env.MAX_PLAYERS_PER_ROOM, 500),
    webDist: env.WEB_DIST ?? resolve('dist/web'),
    secureCookies: publicUrl.startsWith('https://'),
    telegram: parseTelegram(env),
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
