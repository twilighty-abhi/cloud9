import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShutdown } from '../src/shutdown';

function harness(opts: { tg?: 'ok' | 'hang' | 'reject' | 'throw' | null; http?: 'ok' | 'hang'; gameThrows?: boolean } = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  const deps = {
    closeHttp: () => { order.push('http:start'); return opts.http === 'hang' ? new Promise<void>(() => {}) : Promise.resolve().then(() => { order.push('http:done'); }); },
    shutdownGame: () => { order.push('game'); if (opts.gameThrows) throw new Error('boom'); },
    closeRepo: () => { order.push('repo'); },
    stopTelegram: opts.tg === null ? null : () => {
      order.push('tg:start');
      if (opts.tg === 'hang') return new Promise<void>(() => {});
      if (opts.tg === 'reject') return Promise.reject(new Error('tg down'));
      if (opts.tg === 'throw') throw new Error('tg sync');
      return new Promise<void>((r) => setTimeout(() => { order.push('tg:done'); r(); }, 5));
    },
    log: (m: string) => { logs.push(m); },
    stepTimeoutMs: 50,
  };
  return { deps, order, logs };
}

test('quiz data is flushed before Telegram, DB closed last', async () => {
  const h = harness({ tg: 'ok' });
  await runShutdown(h.deps);
  assert.deepEqual(h.order.filter((s) => s !== 'http:done'), ['http:start', 'game', 'tg:start', 'tg:done', 'repo']);
  assert.ok(h.order.indexOf('game') < h.order.indexOf('tg:start'));
  assert.equal(h.order.at(-1), 'repo');
});

test('a hanging Telegram stop and HTTP close are bounded', async () => {
  const h = harness({ tg: 'hang', http: 'hang' });
  const t0 = Date.now();
  await runShutdown(h.deps);
  const took = Date.now() - t0;
  assert.ok(took < 1000, `took ${took} ms`);
  assert.equal(h.order.at(-1), 'repo');
  assert.ok(h.logs.some((l) => l.includes('telegram stop still running')));
  assert.ok(h.logs.some((l) => l.includes('http close still running')));
});

test('failures in one step never skip the DB close', async () => {
  for (const tg of ['reject', 'throw'] as const) {
    const h = harness({ tg, gameThrows: true });
    await runShutdown(h.deps);
    assert.equal(h.order.at(-1), 'repo', tg);
    assert.ok(h.logs.some((l) => l.includes('game shutdown failed')));
    assert.ok(h.logs.some((l) => l.includes('telegram stop failed')), tg);
  }
});

test('Telegram off: game then DB', async () => {
  const h = harness({ tg: null });
  await runShutdown(h.deps);
  assert.deepEqual(h.order.filter((s) => s !== 'http:done'), ['http:start', 'game', 'repo']);
});
