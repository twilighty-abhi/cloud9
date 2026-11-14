import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { trustProxyFromEnv, DEFAULT_TRUSTED_PROXIES } from '../src/http/trustProxy';
import { createRateLimiter } from '../src/util/rateLimit';

async function ipApp(trustProxy = trustProxyFromEnv('')) {
  const app = Fastify({ trustProxy });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  await app.ready();
  const ipOf = async (remoteAddress: string, xff?: string) =>
    (await app.inject({ method: 'GET', url: '/ip', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} })).json().ip as string;
  return { app, ipOf };
}

test('trustProxy: X-Forwarded-For ignored from a public peer', async () => {
  const { app, ipOf } = await ipApp();
  try {
    assert.equal(await ipOf('203.0.113.7', '198.51.100.1'), '203.0.113.7');
    assert.equal(await ipOf('203.0.113.7', '127.0.0.1'), '203.0.113.7');
    assert.equal(await ipOf('2001:db8::1', '198.51.100.1'), '2001:db8::1');
  } finally { await app.close(); }
});

test('trustProxy: X-Forwarded-For honoured from loopback / Docker bridge / private peers', async () => {
  const { app, ipOf } = await ipApp();
  try {
    assert.equal(await ipOf('127.0.0.1', '198.51.100.1'), '198.51.100.1');
    assert.equal(await ipOf('::1', '198.51.100.2'), '198.51.100.2');
    assert.equal(await ipOf('::ffff:127.0.0.1', '198.51.100.3'), '198.51.100.3');
    assert.equal(await ipOf('172.17.0.1', '198.51.100.4'), '198.51.100.4');   // host Nginx via docker0
    assert.equal(await ipOf('172.18.0.5', '198.51.100.5'), '198.51.100.5');   // Caddy on the compose network
    assert.equal(await ipOf('10.1.2.3', '198.51.100.6'), '198.51.100.6');
    assert.equal(await ipOf('192.168.1.10', '198.51.100.7'), '198.51.100.7');
    // spoofed left-most entries are not trusted past the first public hop
    assert.equal(await ipOf('172.17.0.1', '6.6.6.6, 198.51.100.8'), '198.51.100.8');
    // no header → socket address
    assert.equal(await ipOf('172.17.0.1'), '172.17.0.1');
    // 172.32.x is outside 172.16.0.0/12
    assert.equal(await ipOf('172.32.0.1', '198.51.100.9'), '172.32.0.1');
  } finally { await app.close(); }
});

test('trustProxy: TRUST_PROXY env parsing', async () => {
  assert.deepEqual(trustProxyFromEnv(undefined), DEFAULT_TRUSTED_PROXIES);
  assert.deepEqual(trustProxyFromEnv('  '), DEFAULT_TRUSTED_PROXIES);
  assert.equal(trustProxyFromEnv('false'), false);
  assert.equal(trustProxyFromEnv('true'), true);
  const hops = trustProxyFromEnv('2') as (a: string, h: number) => boolean;
  assert.equal(typeof hops, 'function');
  assert.equal(hops('203.0.113.1', 1), true);
  assert.equal(hops('203.0.113.1', 2), false);
  assert.deepEqual(trustProxyFromEnv('127.0.0.1, 10.0.0.0/8'), ['127.0.0.1', '10.0.0.0/8']);
  const { app, ipOf } = await ipApp(trustProxyFromEnv('false'));
  try { assert.equal(await ipOf('127.0.0.1', '198.51.100.1'), '127.0.0.1'); } finally { await app.close(); }
});

test('rateLimit: full map evicts the least-recently-used key instead of clearing everyone', () => {
  const rl = createRateLimiter({ max: 2, windowMs: 60_000, maxKeys: 3 });
  const t = 1_000_000;
  assert.equal(rl.hit('victim', t), true);
  assert.equal(rl.hit('victim', t), true);
  assert.equal(rl.hit('victim', t), false);          // victim is limited
  // spray new keys, touching victim in between so it stays recently used
  for (let i = 0; i < 50; i++) {
    rl.hit(`spray-${i}`, t);
    assert.equal(rl.hit('victim', t), false, `victim limit survived spray ${i}`);
    assert.ok(rl.size() <= 3);
  }
  // untouched keys are evicted oldest-first
  const r2 = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 2 });
  r2.hit('a', t); r2.hit('b', t); r2.hit('c', t);   // evicts a
  assert.equal(r2.size(), 2);
  assert.equal(r2.hit('b', t), false);
  assert.equal(r2.hit('c', t), false);
});
