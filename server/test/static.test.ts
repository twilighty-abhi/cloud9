import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { registerStatic, IMMUTABLE, NO_CACHE } from '../src/http/static';

test('static: cache headers, precompressed br/gz, SPA fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c9-static-'));
  const html = `<!doctype html><html><head><title>t</title></head><body>${'<p>hello</p>'.repeat(200)}</body></html>`;
  const js = `console.log(${JSON.stringify('x'.repeat(5000))});`;
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), html);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), js);
  writeFileSync(join(dir, 'assets', 'tiny-abc.css'), 'a{}'); // below threshold: no compressed variant
  execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/precompress.mjs'), dir], { stdio: 'pipe' });
  assert.ok(existsSync(join(dir, 'assets', 'index-abc123.js.br')));
  assert.ok(existsSync(join(dir, 'assets', 'index-abc123.js.gz')));
  assert.ok(!existsSync(join(dir, 'assets', 'tiny-abc.css.br')));

  const app = Fastify();
  app.get('/api/x', async () => ({ ok: true }));
  await registerStatic(app, dir);
  await app.ready();
  const get = (url: string, enc?: string) => app.inject({ method: 'GET', url, headers: enc ? { 'accept-encoding': enc } : {} });
  try {
    // hashed asset: immutable, brotli preferred
    let r = await get('/assets/index-abc123.js', 'gzip, deflate, br');
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], IMMUTABLE);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.match(String(r.headers['content-type']), /javascript/);
    assert.equal(r.headers['vary'], 'accept-encoding');
    assert.equal(brotliDecompressSync(r.rawPayload).toString(), js);

    r = await get('/assets/index-abc123.js', 'gzip');
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers['cache-control'], IMMUTABLE);
    assert.equal(gunzipSync(r.rawPayload).toString(), js);

    r = await get('/assets/index-abc123.js');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.body, js);
    assert.equal(r.headers['cache-control'], IMMUTABLE);

    // asset without a compressed variant falls back to the plain file
    r = await get('/assets/tiny-abc.css', 'br');
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.body, 'a{}');
    assert.equal(r.headers['cache-control'], IMMUTABLE);

    // index.html, "/" and SPA routes: no-cache (+ compressed)
    for (const url of ['/', '/index.html', '/join/123456', '/mod/room/123456']) {
      r = await get(url, 'br');
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers['cache-control'], NO_CACHE, url);
      assert.match(String(r.headers['content-type']), /text\/html/, url);
      assert.equal(r.headers['content-encoding'], 'br', url);
      assert.equal(brotliDecompressSync(r.rawPayload).toString(), html, url);
    }
    r = await get('/join/123456');
    assert.equal(r.body, html);
    assert.equal(r.headers['cache-control'], NO_CACHE);

    // API 404s stay JSON
    r = await get('/api/missing');
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'not_found');
    assert.equal((await get('/api/x')).json().ok, true);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
