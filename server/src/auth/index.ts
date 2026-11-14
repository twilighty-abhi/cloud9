// Cloud 9 — moderator auth (env-configured users, stateless signed cookie). Agent B.
import { createHmac, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Me } from '../../../shared/api';
import type { Config } from '../config';
import type { AuthService, Repo } from '../contracts';

export const COOKIE_NAME = 'c9_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Account { me: Me; salt: Buffer; hash: Buffer }

const SCRYPT_LEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
/** Boot-time only (hashing the configured passwords once). */
const scrypt = (pw: string, salt: Buffer) => scryptSync(pw, salt, SCRYPT_LEN, SCRYPT_OPTS);
/** Login path: runs on the libuv threadpool so a burst of logins never stalls the event loop / WebSockets. */
const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, SCRYPT_LEN, SCRYPT_OPTS, (err, key) => (err ? rej(err) : res(key))));

/** Defaults for login throttling (on top of the per-IP rate limit in the HTTP layer). */
export const LOGIN_MAX_CONCURRENT = 4;          // scrypt verifications in flight; more → 429 busy
export const LOGIN_LOCKOUT_FAILS = 10;          // failures per username within the window → locked
export const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MAX_KEYS = 10_000;                // bound memory for random-username floods

export interface AuthOptions {
  maxConcurrentLogins?: number;
  lockoutFails?: number;       // 0 disables the per-username lockout
  lockoutWindowMs?: number;
  now?: () => number;
}

/** Thrown by verifyLogin when the attempt is refused without checking the password (HTTP 429). */
export class LoginThrottledError extends Error {
  constructor(readonly reason: 'busy' | 'locked', readonly retryAfterSec: number) {
    super(reason === 'busy' ? 'Too many logins in progress, try again in a moment' : 'Too many failed attempts for this account, try again later');
  }
}

/** Minimal Cookie header parser (first occurrence wins). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in out) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

export function createAuth(config: Config, repo: Repo, opts: AuthOptions = {}): AuthService {
  const maxConcurrent = Math.max(1, opts.maxConcurrentLogins ?? LOGIN_MAX_CONCURRENT);
  const lockoutFails = Math.max(0, opts.lockoutFails ?? LOGIN_LOCKOUT_FAILS);
  const lockoutWindowMs = opts.lockoutWindowMs ?? LOGIN_LOCKOUT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let inFlight = 0;
  /** username (lowercased, known or not) → failures in the current window */
  const failures = new Map<string, { count: number; since: number }>();
  const failureEntry = (key: string) => {
    const f = failures.get(key);
    if (f && now() - f.since >= lockoutWindowMs) { failures.delete(key); return undefined; }
    return f;
  };
  const recordFailure = (key: string) => {
    if (lockoutFails === 0) return;
    const f = failureEntry(key);
    if (f) { f.count++; return; }
    if (failures.size >= LOCKOUT_MAX_KEYS) {
      for (const [k, v] of failures) if (now() - v.since >= lockoutWindowMs) failures.delete(k);
      if (failures.size >= LOCKOUT_MAX_KEYS) failures.delete(failures.keys().next().value as string);
    }
    failures.set(key, { count: 1, since: now() });
  };

  const byUsername = new Map<string, Account>();
  const byId = new Map<string, Account>();
  for (const m of config.moderators) {
    const me: Me = { id: m.id, username: m.username, displayName: m.displayName, isSuper: m.isSuper };
    const salt = randomBytes(16);
    const acc: Account = { me, salt, hash: scrypt(m.password, salt) };
    byUsername.set(m.username.toLowerCase(), acc);
    byId.set(m.id, acc);
    repo.upsertModerator({ id: m.id, username: m.username, displayName: m.displayName, isSuper: m.isSuper });
  }
  // a fixed dummy so unknown usernames cost the same scrypt time
  const dummySalt = randomBytes(16);
  const dummyHash = scrypt(randomBytes(16).toString('hex'), dummySalt);

  const sign = (payload: string) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

  function verifyToken(value: string | undefined): Me | null {
    if (!value || value.length > 1024) return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const sig = Buffer.from(value.slice(dot + 1), 'base64url');
    const expected = Buffer.from(sign(payload), 'base64url');
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: unknown; exp?: unknown };
      if (typeof data.id !== 'string' || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
      return byId.get(data.id)?.me ?? null; // removed moderators are logged out
    } catch {
      return null;
    }
  }

  const svc: AuthService = {
    async verifyLogin(username, password) {
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 512) return null;
      const key = username.trim().toLowerCase();
      if (lockoutFails > 0) {
        const f = failureEntry(key);
        if (f && f.count >= lockoutFails) {
          throw new LoginThrottledError('locked', Math.max(1, Math.ceil((f.since + lockoutWindowMs - now()) / 1000)));
        }
      }
      if (inFlight >= maxConcurrent) throw new LoginThrottledError('busy', 1);
      inFlight++;
      try {
        const acc = byUsername.get(key);
        const hash = await scryptAsync(password, acc ? acc.salt : dummySalt);
        const ok = timingSafeEqual(hash, acc ? acc.hash : dummyHash);
        if (ok && acc) { failures.delete(key); return acc.me; }
        recordFailure(key);
        return null;
      } finally {
        inFlight--;
      }
    },
    issueCookieValue(me) {
      const payload = Buffer.from(JSON.stringify({ id: me.id, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    moderatorFromCookieHeader(cookieHeader) {
      return verifyToken(parseCookieHeader(cookieHeader)[COOKIE_NAME]);
    },
    moderatorFromRequest(req: FastifyRequest) {
      const fromPlugin = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[COOKIE_NAME];
      return verifyToken(fromPlugin ?? parseCookieHeader(req.headers.cookie)[COOKIE_NAME]);
    },
    getModerator(id) {
      return byId.get(id)?.me ?? null;
    },
  };
  return svc;
}
