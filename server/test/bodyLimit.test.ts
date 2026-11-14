import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openRepo } from '../src/db/repo';
import { createAuth } from '../src/auth/index';
import { registerRoutes, SMALL_BODY_LIMIT } from '../src/http/index';
import type { Config } from '../src/config';
import { FakeRegistry } from './fakeRegistry';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://test.local', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [{ id: 'mod_root', username: 'root', password: 'pw-root', displayName: 'root', isSuper: true }],
  maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};

const pad = (n: number) => 'x'.repeat(n);

test('body limits: 16 KB on small routes, 2 MB kept for quiz create/update/import', async () => {
  const repo = openRepo(':memory:');
  const app = Fastify({ bodyLimit: 2_000_000 });
  await registerRoutes(app, { repo, registry: new FakeRegistry(repo, config.publicUrl), auth: createAuth(config, repo), config });
  await app.ready();
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'pw-root' } });
    assert.equal(login.statusCode, 200);
    const cookie = `c9_session=${login.cookies.find((c) => c.name === 'c9_session')!.value}`;
    const big = { junk: pad(SMALL_BODY_LIMIT + 1024) };

    // anonymous routes
    const join = await app.inject({ method: 'POST', url: '/api/play/123456/join', payload: { name: 'A', ...big } });
    assert.equal(join.statusCode, 413);
    assert.equal(join.json().error, 'too_large');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: pad(20_000) } })).statusCode, 413);
    // a normal-sized join is not rejected for size (room doesn't exist → 404)
    assert.notEqual((await app.inject({ method: 'POST', url: '/api/play/123456/join', payload: { name: 'A' } })).statusCode, 413);

    // authenticated small routes
    for (const [method, url] of [['POST', '/api/events'], ['PUT', '/api/events/ev_x'], ['POST', '/api/sessions'], ['PATCH', '/api/sessions/123456']] as const) {
      const r = await app.inject({ method, url, payload: big, headers: { cookie } });
      assert.equal(r.statusCode, 413, `${method} ${url}`);
    }

    // quiz routes still accept large bodies (~300 KB here) — validated, not size-rejected
    const content = 'question,a,b,correct\n' + Array.from({ length: 4000 }, (_, i) => `Q${i} ${pad(50)},yes,no,1`).join('\n');
    assert.ok(content.length > 200_000);
    const imp = await app.inject({ method: 'POST', url: '/api/quizzes/import', payload: { format: 'csv', content }, headers: { cookie } });
    assert.notEqual(imp.statusCode, 413, imp.body);
    const create = await app.inject({ method: 'POST', url: '/api/quizzes', payload: { title: 'T', questions: [], ...{ junk: pad(300_000) } }, headers: { cookie } });
    assert.notEqual(create.statusCode, 413, create.body);
    const put = await app.inject({ method: 'PUT', url: '/api/quizzes/q_missing', payload: { title: 'T', questions: [], junk: pad(300_000) }, headers: { cookie } });
    assert.notEqual(put.statusCode, 413, put.body);
    // and the 2 MB ceiling still applies there
    const huge = await app.inject({ method: 'POST', url: '/api/quizzes/import', payload: { format: 'csv', content: pad(2_100_000) }, headers: { cookie } });
    assert.equal(huge.statusCode, 413);
  } finally { await app.close(); repo.close(); }
});
