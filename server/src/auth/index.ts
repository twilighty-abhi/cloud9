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
    verifyLogin(username, password) {
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 512) return null;
      const acc = byUsername.get(username.trim().toLowerCase());
      const hash = scrypt(password, acc ? acc.salt : dummySalt);
      const ok = timingSafeEqual(hash, acc ? acc.hash : dummyHash);
      return ok && acc ? acc.me : null;
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
