// Cloud 9 — moderator auth (env-configured users, stateless signed cookie). Agent B.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Me } from '../../../shared/api';
import type { Config } from '../config';
import type { AuthService, Repo } from '../contracts';

export const COOKIE_NAME = 'c9_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Account { me: Me; salt: Buffer; hash: Buffer }

const SCRYPT_LEN = 32;
const scrypt = (pw: string, salt: Buffer) => scryptSync(pw, salt, SCRYPT_LEN, { N: 16384, r: 8, p: 1 });

/** Minimal Cookie header parser (first occurrence wins). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
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

export function createAuth(config: Config, repo: Repo): AuthService {
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

  const logoutListeners = new Set<(cookieValue: string) => void>();

  function readToken(value: string | undefined): { me: Me; session: string } | null {
    if (!value || value.length > 1024) return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const sig = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: unknown; exp?: unknown; session?: unknown };
      if (typeof data.id !== 'string' || typeof data.exp !== 'number' || data.exp <= Date.now() || typeof data.session !== 'string') return null;
      const me = byId.get(data.id)?.me;
      return me && repo.hasModeratorSession(data.session, Date.now()) ? { me, session: data.session } : null;
    } catch {
      return null;
    }
  }

  const svc: AuthService = {
    verifyLogin(username, password) {
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 512) return null;
      const acc = byUsername.get(username.trim().toLowerCase());
      const hash = scrypt(password, acc ? acc.salt : dummySalt);
      const ok = timingSafeEqual(hash, acc ? acc.hash : dummyHash);
      return ok && acc ? acc.me : null;
    },
    issueCookieValue(me) {
      const session = randomBytes(24).toString('base64url');
      const exp = Date.now() + SESSION_TTL_MS;
      repo.saveModeratorSession(session, exp);
      const payload = Buffer.from(JSON.stringify({ id: me.id, exp, session })).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    logout(cookieHeader) {
      const value = parseCookieHeader(cookieHeader)[COOKIE_NAME];
      const token = readToken(value);
      if (!token) return;
      repo.deleteModeratorSession(token.session);
      for (const listener of logoutListeners) listener(value);
    },
    onLogout(listener) {
      logoutListeners.add(listener);
      return () => { logoutListeners.delete(listener); };
    },
    moderatorFromCookieHeader(cookieHeader) {
      return readToken(parseCookieHeader(cookieHeader)[COOKIE_NAME])?.me ?? null;
    },
    moderatorFromRequest(req: FastifyRequest) {
      return svc.moderatorFromCookieHeader(req.headers.cookie);
    },
    getModerator(id) {
      return byId.get(id)?.me ?? null;
    },
  };
  return svc;
}
