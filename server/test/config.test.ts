// Config: fail closed in production, numeric env parsing with fallbacks (#10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseIntEnv } from '../src/config';

const quiet = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
};
const SECRET = 'a'.repeat(32);

test('parseIntEnv: unset/empty → default, valid → floored int, junk/out of range → default', () => {
  quiet(() => {
    assert.equal(parseIntEnv('X', undefined, 500), 500);
    assert.equal(parseIntEnv('X', '', 500), 500);
    assert.equal(parseIntEnv('X', '  ', 500), 500);
    assert.equal(parseIntEnv('X', '250', 500), 250);
    assert.equal(parseIntEnv('X', ' 42 ', 500), 42);
    assert.equal(parseIntEnv('X', '12.9', 500), 12);
    assert.equal(parseIntEnv('X', 'abc', 500), 500);
    assert.equal(parseIntEnv('X', '10abc', 500), 500);
    assert.equal(parseIntEnv('X', 'Infinity', 500), 500);
    assert.equal(parseIntEnv('X', '0', 500), 500);
    assert.equal(parseIntEnv('X', '-5', 500), 500);
    assert.equal(parseIntEnv('PORT', '70000', 3000, 1, 65535), 3000);
    assert.equal(parseIntEnv('PORT', '8080', 3000, 1, 65535), 8080);
  });
});

test('loadConfig (dev): keeps the admin:admin / random-secret defaults', () => {
  const c = quiet(() => loadConfig({}));
  assert.deepEqual(c.moderators.map((m) => `${m.username}:${m.isSuper}`), ['admin:true']);
  assert.ok(c.sessionSecret.length >= 32);
  assert.equal(c.port, 3000);
  assert.equal(c.maxPlayersPerRoom, 500);
  const d = quiet(() => loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 'short' }));
  assert.equal(d.moderators[0].username, 'admin');
});

test('loadConfig: invalid numeric env vars fall back instead of disabling limits', () => {
  const c = quiet(() => loadConfig({ MAX_PLAYERS_PER_ROOM: 'lots', PORT: 'abc' }));
  assert.equal(c.maxPlayersPerRoom, 500);
  assert.equal(c.port, 3000);
  assert.equal(c.publicUrl, 'http://localhost:3000');
  assert.equal(quiet(() => loadConfig({ MAX_PLAYERS_PER_ROOM: '300' })).maxPlayersPerRoom, 300);
});

test('loadConfig (production): refuses to start without MODERATORS or with a short SESSION_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET }), /Refusing to start.*MODERATORS is not set/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MODERATORS: '  ', SESSION_SECRET: SECRET }), /MODERATORS is not set/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MODERATORS: 'admin:pw:super' }), /SESSION_SECRET must be at least 32/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MODERATORS: 'admin:pw:super', SESSION_SECRET: 'x'.repeat(31) }), /SESSION_SECRET/);
  // both problems reported at once
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (e: Error) => /MODERATORS/.test(e.message) && /SESSION_SECRET/.test(e.message));
  const ok = loadConfig({ NODE_ENV: 'production', MODERATORS: 'admin:pw:super,mod1:x', SESSION_SECRET: SECRET });
  assert.equal(ok.sessionSecret, SECRET);
  assert.equal(ok.moderators.length, 2);
});
