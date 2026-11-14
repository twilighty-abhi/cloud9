// Session revocation via SESSION_NOT_BEFORE, iat in tokens, 24 h TTL (#33).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { openRepo } from '../src/db/repo';
import { COOKIE_NAME, SESSION_TTL_MS, createAuth } from '../src/auth/index';
import { registerRoutes } from '../src/http/index';
import { loadConfig, parseSessionNotBefore, type Config } from '../src/config';
import { FakeRegistry } from './fakeRegistry';

const SECRET = 's'.repeat(32);
const base: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://test.local', dbPath: ':memory:', sessionSecret: SECRET,
  moderators: [{ id: 'mod_alice', username: 'alice', password: 'pw-alice', displayName: 'alice', isSuper: false }],
  maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};
const quiet = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
};

/** Hand-signed token, e.g. the pre-iat format `{id, exp}` issued by older builds. */
function forge(data: object, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
const cookie = (v: string) => `${COOKIE_NAME}=${v}`;
const decode = (v: string) => JSON.parse(Buffer.from(v.slice(0, v.lastIndexOf('.')), 'base64url').toString('utf8'));

test('parseSessionNotBefore: unset → undefined, epoch seconds and ISO → ms, junk throws, future clamps', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.equal(parseSessionNotBefore(undefined, now), undefined);
  assert.equal(parseSessionNotBefore('  ', now), undefined);
  assert.equal(parseSessionNotBefore('1763100000', now), 1763100000 * 1000);
  assert.equal(parseSessionNotBefore('2026-11-14T10:00:00Z', now), Date.parse('2026-11-14T10:00:00Z'));
  assert.equal(parseSessionNotBefore(' 2026-11-14T10:00:00+05:30 ', now), Date.parse('2026-11-14T04:30:00Z'));
  assert.throws(() => parseSessionNotBefore('yesterday', now), /SESSION_NOT_BEFORE/);
  assert.throws(() => parseSessionNotBefore('-5', now), /SESSION_NOT_BEFORE/);
  assert.equal(quiet(() => parseSessionNotBefore('2099-01-01T00:00:00Z', now)), now);
  assert.equal(quiet(() => loadConfig({ SESSION_NOT_BEFORE: '1763100000' })).sessionNotBefore, 1763100000 * 1000);
  assert.equal(quiet(() => loadConfig({})).sessionNotBefore, undefined);
});

test('tokens carry iat and a 24 h expiry; login cookie Max-Age is 24 h', async () => {
  assert.equal(SESSION_TTL_MS, 24 * 60 * 60 * 1000);
  const repo = openRepo(':memory:');
  const auth = createAuth(base, repo);
  const app = Fastify();
  await registerRoutes(app, { repo, registry: new FakeRegistry(repo, base.publicUrl), auth, config: base });
  await app.ready();
  try {
    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw-alice' }, remoteAddress: '10.9.0.1' });
    assert.equal(res.statusCode, 200);
    const set = String(res.headers['set-cookie']);
    assert.match(set, /Max-Age=86400/);
    const value = decodeURIComponent(/c9_session=([^;]+)/.exec(set)![1]);
    const data = decode(value);
    assert.ok(data.iat >= before && data.iat <= Date.now());
    assert.equal(data.exp - data.iat, SESSION_TTL_MS);
    assert.equal(auth.moderatorFromCookieHeader(cookie(value))?.id, 'mod_alice');
  } finally { await app.close(); repo.close(); }
});

test('without SESSION_NOT_BEFORE: old tokens (no iat) still work', () => {
  const repo = openRepo(':memory:');
  try {
    const auth = createAuth(base, repo);
    const old = forge({ id: 'mod_alice', exp: Date.now() + 60_000 });
    assert.equal(auth.moderatorFromCookieHeader(cookie(old))?.id, 'mod_alice');
  } finally { repo.close(); }
});

test('SESSION_NOT_BEFORE rejects cookies issued before it (incl. pre-iat tokens), accepts newer ones', () => {
  const repo = openRepo(':memory:');
  try {
    const notBefore = Date.now() - 60_000;
    const auth = createAuth({ ...base, sessionNotBefore: notBefore }, repo);
    const exp = Date.now() + 60_000;
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', exp }))), null);                         // no iat
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', iat: notBefore - 1, exp }))), null);     // before
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', iat: 'x', exp }))), null);              // junk iat
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', iat: notBefore, exp })))?.id, 'mod_alice');
    const fresh = auth.issueCookieValue(auth.getModerator('mod_alice')!);
    assert.equal(auth.moderatorFromCookieHeader(cookie(fresh))?.id, 'mod_alice');
    // still rejected: expired, wrong signature
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', iat: Date.now(), exp: Date.now() - 1 }))), null);
    assert.equal(auth.moderatorFromCookieHeader(cookie(forge({ id: 'mod_alice', iat: Date.now(), exp }, 'other'.repeat(8)))), null);
  } finally { repo.close(); }
});
