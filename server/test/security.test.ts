import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSecurityHeaders, CONTENT_SECURITY_POLICY } from '../src/http/security';

async function build(publicUrl: string) {
  const app = Fastify();
  registerSecurityHeaders(app, { publicUrl });
  app.get('/api/x', async () => ({ ok: true }));
  app.get('/api/boom', async () => { throw new Error('boom'); });
  await app.ready();
  return app;
}

test('security headers on JSON, 404 and error responses', async () => {
  const app = await build('http://test.local');
  try {
    for (const url of ['/api/x', '/nope', '/api/boom']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.headers['content-security-policy'], CONTENT_SECURITY_POLICY, url);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin', url);
      assert.equal(r.headers['x-frame-options'], 'DENY', url);
      assert.equal(r.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()', url);
      assert.equal(r.headers['strict-transport-security'], undefined, url);
    }
    for (const d of ["frame-ancestors 'none'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", 'https://fonts.gstatic.com', 'wss:']) {
      assert.ok(CONTENT_SECURITY_POLICY.includes(d), d);
    }
  } finally { await app.close(); }
});

test('HSTS only when PUBLIC_URL is https', async () => {
  const app = await build('https://quiz.example.com');
  try {
    const r = await app.inject({ method: 'GET', url: '/api/x' });
    assert.equal(r.headers['strict-transport-security'], 'max-age=15552000');
  } finally { await app.close(); }
});
