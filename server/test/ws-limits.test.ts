// WS connection caps + failed room-lookup limit (#6). Run: npx tsx --test server/test/ws-limits.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { Registry } from '../src/game/registry';
import { attachRealtime, type RealtimeOptions } from '../src/realtime/ws';
import { clientIpFromRaw, trustProxy } from '../src/util/clientIp';
import type { AuthService } from '../src/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';
import { FakeRepo } from './fakeRepo';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://quiz.test', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [], maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};
const fakeAuth: AuthService = {
  verifyLogin: () => null, issueCookieValue: () => '', moderatorFromRequest: () => null, getModerator: () => null,
  moderatorFromCookieHeader: () => null,
};
const quiz: QuizDef = {
  id: 'quiz1', moderatorId: 'mod1', eventId: null, title: 'T', emailMode: 'off', scoring: 'speed',
  questions: [{ id: 'q1', text: 'Q', imageUrl: null, options: ['A', 'B'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 }],
  createdAt: 1, updatedAt: 1,
};

interface Conn { ws: WebSocket; first: Promise<any>; closed: Promise<number> }
function connect(port: number, qs: string, xff?: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`, { headers: xff ? { 'x-forwarded-for': xff } : {} });
    ws.on('error', () => {});
    const first = new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    ws.once('open', () => resolve({ ws, first, closed }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}
const closeAndWait = async (c: Conn) => { c.ws.close(); await c.closed; };

async function setup(opts: RealtimeOptions = {}) {
  const registry = new Registry(new FakeRepo() as any, config);
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const rt = attachRealtime(server, fakeAuth, registry, opts);
  const port = (server.address() as AddressInfo).port;
  const room = registry.createSession({ quiz, moderatorId: 'mod1', event: null, label: '', listed: false });
  const teardown = async () => {
    rt.close();
    registry.shutdown();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { registry, port, code: room.code, teardown };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('clientIpFromRaw matches Fastify req.ip with the server trustProxy setting', async () => {
  const app = Fastify({ trustProxy });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  await app.ready();
  const cases: { remote: string; xff?: string }[] = [
    { remote: '10.1.1.1' },
    { remote: '127.0.0.1', xff: '203.0.113.5' },
    { remote: '127.0.0.1', xff: '1.1.1.1, 2.2.2.2' },
    { remote: '127.0.0.1', xff: ' 6.6.6.6 ,7.7.7.7 ' },
    { remote: '::ffff:127.0.0.1', xff: '2001:db8::1' },
  ];
  try {
    for (const c of cases) {
      const res = await app.inject({ method: 'GET', url: '/ip', remoteAddress: c.remote, headers: c.xff ? { 'x-forwarded-for': c.xff } : {} });
      const fake = { socket: { remoteAddress: c.remote }, headers: c.xff ? { 'x-forwarded-for': c.xff } : {} } as unknown as IncomingMessage;
      assert.equal(clientIpFromRaw(fake), res.json().ip, JSON.stringify(c));
    }
  } finally {
    await app.close();
  }
});

test('per-IP socket cap closes extra sockets with 4429; other IPs and freed slots work', async () => {
  const t = await setup({ maxPerIp: 3 });
  try {
    const a = await Promise.all([1, 2, 3].map(() => connect(t.port, `role=present&code=${t.code}`, '198.51.100.1')));
    for (const c of a) assert.equal((await c.first).t, 'state');
    const extra = await connect(t.port, `role=present&code=${t.code}`, '198.51.100.1');
    assert.equal((await extra.first).code, 'rate_limited');
    assert.equal(await extra.closed, 4429);
    // a different client IP is not affected
    const other = await connect(t.port, `role=present&code=${t.code}`, '198.51.100.2');
    assert.equal((await other.first).t, 'state');
    // freeing a slot lets the first IP connect again
    await closeAndWait(a[0]);
    await settle();
    const again = await connect(t.port, `role=present&code=${t.code}`, '198.51.100.1');
    assert.equal((await again.first).t, 'state');
    for (const c of [a[1], a[2], other, again]) await closeAndWait(c);
  } finally {
    await t.teardown();
  }
});

test('global socket cap closes sockets beyond WS_MAX_TOTAL with 4429', async () => {
  const t = await setup({ maxTotal: 2 });
  try {
    const a = await connect(t.port, `role=present&code=${t.code}`, '192.0.2.1');
    const b = await connect(t.port, `role=present&code=${t.code}`, '192.0.2.2');
    assert.equal((await a.first).t, 'state');
    assert.equal((await b.first).t, 'state');
    const c = await connect(t.port, `role=present&code=${t.code}`, '192.0.2.3');
    assert.equal(await c.closed, 4429);
    await closeAndWait(a);
    await settle();
    const d = await connect(t.port, `role=present&code=${t.code}`, '192.0.2.3');
    assert.equal((await d.first).t, 'state');
    await closeAndWait(b);
    await closeAndWait(d);
  } finally {
    await t.teardown();
  }
});

test('failed room lookups are limited per IP (4429), valid lookups do not count', async () => {
  const t = await setup({ lookupFailsPerMin: 3 });
  try {
    // valid lookups from one IP never use up the budget
    for (let i = 0; i < 5; i++) {
      const ok = await connect(t.port, `role=present&code=${t.code}`, '203.0.113.9');
      assert.equal((await ok.first).t, 'state');
      await closeAndWait(ok);
    }
    for (const bad of ['000000', 'abc', '']) {
      const c = await connect(t.port, `role=present&code=${bad}`, '203.0.113.66');
      assert.equal(await c.closed, 4404);
    }
    // budget exhausted: even a valid code is refused for this IP, so hits and misses look the same
    const blocked = await connect(t.port, `role=present&code=${t.code}`, '203.0.113.66');
    assert.equal((await blocked.first).code, 'rate_limited');
    assert.equal(await blocked.closed, 4429);
    // other IPs unaffected
    const other = await connect(t.port, `role=present&code=${t.code}`, '203.0.113.9');
    assert.equal((await other.first).t, 'state');
    await closeAndWait(other);
  } finally {
    await t.teardown();
  }
});

test('venue NAT: 300 players on one IP connect and play with default limits', async () => {
  const t = await setup();
  try {
    const tokens: string[] = [];
    for (let i = 0; i < 300; i++) {
      const r = t.registry.join(t.code, { name: `P${i}` });
      assert.ok(r.ok);
      tokens.push((r as any).token);
    }
    const conns: Conn[] = [];
    for (let i = 0; i < 300; i += 50) {
      conns.push(...await Promise.all(tokens.slice(i, i + 50).map((tok) => connect(t.port, `role=player&code=${t.code}&token=${tok}`))));
    }
    const firsts = await Promise.all(conns.map((c) => c.first));
    assert.ok(firsts.every((m) => m.t === 'state'), 'every NAT player gets the room state');
    await settle(100);
    // none were closed by the limits
    const states = conns.map((c) => c.ws.readyState);
    assert.ok(states.every((s) => s === WebSocket.OPEN));
    await Promise.all(conns.map(closeAndWait));
  } finally {
    await t.teardown();
  }
});
