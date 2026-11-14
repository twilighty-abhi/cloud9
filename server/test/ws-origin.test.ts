// Origin check for moderator WebSockets (#11). Run: npx tsx --test server/test/ws-origin.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createGame } from '../src/game/index';
import { makeModOriginCheck } from '../src/realtime/ws';
import type { AuthService, Game } from '../src/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';
import { FakeRepo } from './fakeRepo';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'https://quiz.test', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [], maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};
const fakeAuth: AuthService = {
  verifyLogin: () => null, issueCookieValue: () => '', moderatorFromRequest: () => null, getModerator: () => null,
  moderatorFromCookieHeader(h) {
    const m = /c9_session=([a-z0-9]+)/.exec(h ?? '');
    return m ? { id: m[1], username: m[1], displayName: m[1], isSuper: false } : null;
  },
};
const quiz: QuizDef = {
  id: 'quiz1', moderatorId: 'mod1', eventId: null, title: 'T', emailMode: 'off', scoring: 'speed',
  questions: [{ id: 'q1', text: 'Q', imageUrl: null, options: ['A', 'B'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 }],
  createdAt: 1, updatedAt: 1,
};
const COOKIE = 'c9_session=mod1';

/** Resolves with the first message type (or 'closed') and the close code. */
function attempt(port: number, qs: string, headers: Record<string, string>): Promise<{ first: string; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`, { headers });
    let first: string | null = null;
    ws.on('error', () => {});
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (first === null) {
        first = m.t === 'error' ? `error:${m.code}` : m.t;
        if (m.t !== 'error') ws.close();
      }
    });
    ws.on('close', (code) => resolve({ first: first ?? 'closed', code }));
    ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

async function setup() {
  process.env.ALLOWED_ORIGINS = ' https://cloud9.abhiramnj.com/ , HTTPS://Other.Example ';
  const game: Game = createGame({ repo: new FakeRepo() as any, config });
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  game.attach(server, fakeAuth);
  delete process.env.ALLOWED_ORIGINS;
  const port = (server.address() as AddressInfo).port;
  const code = game.registry.createSession({ quiz, moderatorId: 'mod1', event: null, label: '', listed: false }).code;
  const teardown = async () => { game.shutdown(); await new Promise<void>((r) => server.close(() => r())); };
  return { port, code, teardown };
}

test('moderator WS: allowed origins connect, foreign origins get 4401, missing Origin still needs the cookie', async () => {
  const t = await setup();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    const mod = (headers: Record<string, string>) => attempt(t.port, `role=mod&code=${t.code}`, headers);
    // PUBLIC_URL origin + ALLOWED_ORIGINS entries (trailing slash / case normalised)
    assert.equal((await mod({ origin: 'https://quiz.test', cookie: COOKIE })).first, 'state');
    assert.equal((await mod({ origin: 'https://cloud9.abhiramnj.com', cookie: COOKIE })).first, 'state');
    assert.equal((await mod({ origin: 'https://other.example', cookie: COOKIE })).first, 'state');
    // same-origin page (Origin host == Host header), e.g. direct IP or the Vite dev proxy
    assert.equal((await mod({ origin: `http://127.0.0.1:${t.port}`, cookie: COOKIE })).first, 'state');

    // foreign / sibling / opaque origins are rejected even with a valid cookie
    for (const origin of ['https://evil.test', 'https://evil.abhiramnj.com', 'http://quiz.test:8080', 'null', 'not a url']) {
      const r = await mod({ origin, cookie: COOKIE });
      assert.equal(r.code, 4401, origin);
      assert.equal(r.first, 'error:unauthorized', origin);
    }
    assert.ok(warnings.some((w) => w.includes('Origin') && w.includes('evil.test')));

    // no Origin header (non-browser client): allowed, logged, cookie still required
    warnings.length = 0;
    assert.equal((await mod({ cookie: COOKIE })).first, 'state');
    assert.ok(warnings.some((w) => w.includes('without Origin')));
    assert.equal((await mod({})).code, 4401);

    // players and projector screens are not origin-checked
    assert.equal((await attempt(t.port, `role=present&code=${t.code}`, { origin: 'https://evil.test' })).first, 'state');
  } finally {
    console.warn = warn;
    await t.teardown();
  }
});

test('makeModOriginCheck unit cases', () => {
  const check = makeModOriginCheck('https://quiz.test', ['https://cloud9.abhiramnj.com', 'garbage']);
  const req = (origin?: string, host = 'quiz.test') => ({ headers: { ...(origin === undefined ? {} : { origin }), host } }) as unknown as IncomingMessage;
  assert.equal(check(req('https://quiz.test')), 'ok');
  assert.equal(check(req('https://QUIZ.test')), 'ok');
  assert.equal(check(req('https://cloud9.abhiramnj.com', 'internal:3000')), 'ok');
  assert.equal(check(req('https://evil.test')), 'mismatch');
  assert.equal(check(req(undefined)), 'missing');
  assert.equal(check(req('')), 'missing');
  // no PUBLIC_URL / allow-list: only same-host origins pass
  const bare = makeModOriginCheck(undefined, []);
  assert.equal(bare(req('http://localhost:5173', 'localhost:5173')), 'ok');
  assert.equal(bare(req('http://localhost:5173', 'localhost:3000')), 'mismatch');
});
