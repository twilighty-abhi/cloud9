// Cloud 9 — configuration from environment. Owned by lead.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

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
  };
}
