// Cloud 9 — configuration from environment. Owned by lead.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { BlockList, isIP } from 'node:net';

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
  allowedOrigins?: readonly string[];
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
  const publicUrl = webOrigin((env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''));
  const production = env.NODE_ENV === 'production';
  const moderators = parseModerators(env.MODERATORS ?? (production ? '' : 'admin:admin:super'));
  const names = new Set(moderators.map((moderator) => moderator.username));
  if (names.size !== moderators.length) throw new Error('MODERATORS usernames must be unique');
  if (production && (!moderators.length || moderators.some(({ password }) =>
    /^(?:admin|password|changeme|change_me)$/i.test(password.trim()) || password.length > 512))) {
    throw new Error('Production requires explicit moderator accounts with non-default passwords');
  }
  if (!env.MODERATORS && !production) console.warn('[config] MODERATORS not set — using admin:admin (dev only!)');
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (production && (sessionSecret.trim().length < 32 || /^change[ _-]?me/i.test(sessionSecret.trim()))) {
    throw new Error('Production requires a random SESSION_SECRET of at least 32 characters');
  }
  if (sessionSecret.length < 16) {
    console.warn('[config] SESSION_SECRET missing/short — generating a random one (moderators will be logged out on restart)');
    sessionSecret = randomBytes(32).toString('hex');
  }
  const allowedOrigins = [publicUrl];
  if (!production) allowedOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    dbPath: env.DB_PATH ?? resolve('data/cloud9.db'),
    sessionSecret,
    moderators,
    maxPlayersPerRoom: Number(env.MAX_PLAYERS_PER_ROOM ?? 500),
    webDist: resolve(env.WEB_DIST ?? 'dist/web'),
    allowedOrigins,
    secureCookies: publicUrl.startsWith('https://'),
  };
}

function webOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL must be an HTTP or HTTPS origin');
  }
  return url.origin;
}

export function trustedProxy(config: string | undefined): false | ((address: string, hop: number) => boolean) {
  if (!config?.trim()) return false;
  const list = new BlockList();
  for (const entry of config.split(',').map((value) => value.trim())) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      throw new Error('TRUSTED_PROXY must contain IP addresses or CIDR ranges');
    }
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return (address, hop) => {
    if (hop !== 0) return false;
    const ip = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
  };
}
