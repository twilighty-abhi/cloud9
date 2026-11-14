// Login hashing: async scrypt (event loop stays responsive), concurrency cap, per-username lockout (#3).
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openRepo } from '../src/db/repo';
import { createAuth, LoginThrottledError, type AuthOptions } from '../src/auth/index';
import { registerRoutes } from '../src/http/index';
import type { Config } from '../src/config';
import { FakeRegistry } from './fakeRegistry';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://test.local', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [
    { id: 'mod_alice', username: 'alice', password: 'pw-alice', displayName: 'alice', isSuper: false },
    { id: 'mod_bob', username: 'bob', password: 'pw-bob', displayName: 'bob', isSuper: false },
  ],
  maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};

async function setup(opts?: AuthOptions) {
  process.env.LOGIN_RATE_PER_MIN = '1000';   // isolate from the per-IP limiter
  const repo = openRepo(':memory:');
  const auth = createAuth(config, repo, opts);
  const app = Fastify({ trustProxy: true });
  await registerRoutes(app, { repo, registry: new FakeRegistry(repo, config.publicUrl), auth, config });
  await app.ready();
  delete process.env.LOGIN_RATE_PER_MIN;
  const login = (username: string, password: string, ip = '10.1.1.1') =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, remoteAddress: ip });
  return { app, auth, login, close: async () => { await app.close(); repo.close(); } };
}

test('login: async verifyLogin still accepts good and rejects bad credentials', async () => {
  const t = await setup();
  try {
    assert.equal((await t.auth.verifyLogin('alice', 'pw-alice'))?.id, 'mod_alice');
    assert.equal((await t.auth.verifyLogin(' ALICE ', 'pw-alice'))?.id, 'mod_alice');
    assert.equal(await t.auth.verifyLogin('alice', 'nope'), null);
    assert.equal(await t.auth.verifyLogin('ghost', 'x'), null);
    const ok = await t.login('bob', 'pw-bob');
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['set-cookie']), /c9_session=/);
    assert.equal((await t.login('bob', 'wrong')).statusCode, 401);
  } finally { await t.close(); }
});

test('login: more than 4 verifications in flight → 429 login_busy', async () => {
  const t = await setup();
  try {
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => t.login('alice', 'pw-alice', `10.2.0.${i}`)));
    const codes = res.map((r) => r.statusCode);
    assert.equal(codes.filter((c) => c === 200).length, 4, codes.join(','));
    assert.equal(codes.filter((c) => c === 429).length, 8);
    const busy = res.find((r) => r.statusCode === 429)!;
    assert.equal(busy.json().error, 'login_busy');
    assert.equal(busy.headers['retry-after'], '1');
    // capacity is released afterwards
    assert.equal((await t.login('alice', 'pw-alice')).statusCode, 200);
  } finally { await t.close(); }
});

test('login: 10 failures for one username in 15 min → locked (429), others unaffected, unlocks after window', async () => {
  let clock = 1_000_000;
  const t = await setup({ now: () => clock });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await t.login('alice', `bad${i}`, `10.3.0.${i}`)).statusCode, 401);
    const locked = await t.login('alice', 'pw-alice', '10.3.1.1');   // even the right password, from a new IP
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.json().error, 'login_locked');
    assert.equal(locked.headers['retry-after'], String(15 * 60));
    await assert.rejects(t.auth.verifyLogin('Alice', 'pw-alice'), (e) => e instanceof LoginThrottledError && e.reason === 'locked');
    assert.equal((await t.login('bob', 'pw-bob')).statusCode, 200);         // per-username, not global
    clock += 15 * 60 * 1000;
    assert.equal((await t.login('alice', 'pw-alice')).statusCode, 200);
  } finally { await t.close(); }
});

test('login: success resets the failure counter; lockoutFails=0 disables lockout', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 9; i++) assert.equal(await t.auth.verifyLogin('alice', 'bad'), null);
    assert.ok(await t.auth.verifyLogin('alice', 'pw-alice'));
    for (let i = 0; i < 9; i++) assert.equal(await t.auth.verifyLogin('alice', 'bad'), null);
    assert.ok(await t.auth.verifyLogin('alice', 'pw-alice'));
  } finally { await t.close(); }
  const off = await setup({ lockoutFails: 0 });
  try {
    for (let i = 0; i < 15; i++) assert.equal(await off.auth.verifyLogin('alice', 'bad'), null);
    assert.ok(await off.auth.verifyLogin('alice', 'pw-alice'));
  } finally { await off.close(); }
});

test('login: 50 parallel logins do not block the event loop', async () => {
  // Raise the cap so all 50 really hash. With scryptSync the loop would stall for ~50× one hash in a single tick.
  const t = await setup({ maxConcurrentLogins: 50, lockoutFails: 0 });
  try {
    const s0 = performance.now();
    scryptSync('calibrate', Buffer.alloc(16), 32, { N: 16384, r: 8, p: 1 });
    const oneHash = performance.now() - s0;   // machine-relative bound (CI/shared boxes are slow and noisy)
    let maxLag = 0;
    let running = true;
    let ticks = 0;
    const probe = () => new Promise<void>((resolve) => {
      const loop = () => {
        const start = performance.now();
        setImmediate(() => {
          maxLag = Math.max(maxLag, performance.now() - start);
          ticks++;
          if (running) loop(); else resolve();
        });
      };
      loop();
    });
    const probing = probe();
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => t.auth.verifyLogin(i % 2 ? 'alice' : 'ghost', 'pw-alice')));
    const elapsed = performance.now() - t0;
    running = false;
    await probing;
    assert.equal(results.filter(Boolean).length, 25);
    assert.ok(ticks > 100, `event loop ticked ${ticks} times during ${elapsed.toFixed(0)} ms`);
    // Blocking would show up as one lag ≈ 50 × oneHash; allow scheduler noise up to a few hashes' worth.
    const bound = Math.max(100, 5 * oneHash);
    assert.ok(maxLag < bound, `max setImmediate lag ${maxLag.toFixed(1)} ms ≥ ${bound.toFixed(0)} ms (one hash ${oneHash.toFixed(0)} ms, 50 took ${elapsed.toFixed(0)} ms)`);
  } finally { await t.close(); }
});
