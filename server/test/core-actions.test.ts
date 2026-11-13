// Core support for Telegram actions: Registry.endSession + TgClient.sendPhoto. Agent CORE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from '../src/game/registry';
import { bus } from '../src/notify/bus';
import type { NotifyEvent } from '../src/notify/contracts';
import { createTgClient } from '../src/notify/client';
import { TgError } from '../src/notify/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';
import { FakeRepo } from './fakeRepo';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://quiz.test', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [], maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};

function makeQuiz(): QuizDef {
  const q = (id: string, correctIndex: number) => ({
    id, text: `Question ${id}`, imageUrl: null, options: ['A', 'B', 'C', 'D'], correctIndex, timeLimitSec: 20, pointsMax: 1000,
  });
  return {
    id: 'quiz1', moderatorId: 'mod1', eventId: null, title: 'Test Quiz', emailMode: 'optional', scoring: 'speed',
    questions: [q('q1', 1), q('q2', 2), q('q3', 0)], createdAt: 1, updatedAt: 1,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const repo = new FakeRepo();
  const registry = new Registry(repo, config);
  const events: NotifyEvent[] = [];
  const off = bus.on((e) => events.push(e));
  const done = () => { off(); registry.shutdown(); };
  const create = () => registry.createSession({ quiz: makeQuiz(), event: null, moderatorId: 'mod1', label: '', listed: true });
  return { repo, registry, events, done, create };
}

test('endSession from LOBBY → FINISHED, persisted, session.finished with telegram actor; second call → finished', async () => {
  const { repo, registry, events, done, create } = setup();
  try {
    const s = create();
    assert.equal(registry.join(s.code, { name: 'Ann' } as any).ok, true);
    assert.deepEqual(registry.endSession(s.code, 'telegram:555'), { ok: true });
    assert.equal(registry.summary(s.code)?.state, 'FINISHED');
    assert.ok(registry.summary(s.code)?.endedAt);
    const row = repo.sessions.get(s.id)!;
    assert.equal(row.state, 'FINISHED');
    assert.ok(row.endedAt);
    await tick();
    const fin = events.filter((e) => e.type === 'session.finished' && (e as any).session.code === s.code);
    assert.equal(fin.length, 1);
    assert.equal((fin[0] as any).actor, 'telegram:555');
    assert.equal((fin[0] as any).endedEarly, true);
    assert.deepEqual(registry.endSession(s.code, 'telegram:555'), { ok: false, error: 'finished' });
    await tick();
    assert.equal(events.filter((e) => e.type === 'session.finished' && (e as any).session.code === s.code).length, 1);
  } finally { done(); }
});

test('endSession mid-QUESTION (any qIndex, no expectQ) → FINISHED', async () => {
  const { registry, events, done, create } = setup();
  try {
    const s = create();
    const room = registry.get(s.code)!;
    assert.equal(room.modAction('start', -1, 'mod1').ok, true);
    assert.equal(registry.summary(s.code)?.state, 'QUESTION');
    assert.equal(registry.summary(s.code)?.qIndex, 0);
    assert.deepEqual(registry.endSession(s.code, 'telegram:555'), { ok: true });
    assert.equal(registry.summary(s.code)?.state, 'FINISHED');
    await tick();
    const fin = events.find((e) => e.type === 'session.finished' && (e as any).session.code === s.code) as any;
    assert.ok(fin);
    assert.equal(fin.actor, 'telegram:555');
    assert.equal(fin.session.state, 'FINISHED');
    assert.ok(Array.isArray(fin.leaderboard));
  } finally { done(); }
});

test('endSession unknown code → not_found', () => {
  const { registry, done } = setup();
  try {
    assert.deepEqual(registry.endSession('999999', 'telegram:555'), { ok: false, error: 'not_found' });
  } finally { done(); }
});

// ───────────── sendPhoto against a tiny Bot API fake ─────────────

async function withServer(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void, fn: (base: string) => Promise<void>) {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally { await new Promise((r) => srv.close(r)); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0x7f]);
const TOKEN = '123456:SECRET-token';

test('sendPhoto posts multipart with photo (png bytes, filename), HTML caption, reply_markup, thread id', async () => {
  let got: { url: string; ct: string; body: Buffer } | null = null;
  await withServer((req, body, res) => {
    got = { url: req.url ?? '', ct: String(req.headers['content-type'] ?? ''), body };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }, async (base) => {
    const client = createTgClient({ apiBase: base, token: TOKEN } as any);
    await client.sendPhoto('-100777', { filename: 'qr-123456.png', content: PNG }, {
      caption: '<b>Join</b> ' + 'x'.repeat(2000), threadId: 42, buttons: [[{ text: 'End', data: 'act:end:123456' }]],
    });
  });
  assert.ok(got);
  const g = got as { url: string; ct: string; body: Buffer };
  assert.equal(g.url, `/bot${TOKEN}/sendPhoto`);
  assert.match(g.ct, /^multipart\/form-data; boundary=/);
  // Parse the multipart body with the platform's own parser.
  const fd = await new Response(new Uint8Array(g.body), { headers: { 'content-type': g.ct } }).formData();
  assert.equal(fd.get('chat_id'), '-100777');
  assert.equal(fd.get('message_thread_id'), '42');
  assert.equal(fd.get('parse_mode'), 'HTML');
  const caption = String(fd.get('caption'));
  assert.ok(caption.startsWith('<b>Join</b> '));
  assert.equal(caption.length, 1024);
  assert.deepEqual(JSON.parse(String(fd.get('reply_markup'))), { inline_keyboard: [[{ text: 'End', callback_data: 'act:end:123456' }]] });
  const photo = fd.get('photo') as File;
  assert.ok(photo && typeof photo !== 'string');
  assert.equal(photo.name, 'qr-123456.png');
  assert.equal(photo.type, 'image/png');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG);
});

test('sendPhoto without options omits caption/thread/markup; API errors map to TgError with token redacted', async () => {
  let fields: string[] = [];
  await withServer(async (req, body, res) => {
    const fd = await new Response(new Uint8Array(body), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    fields = [...fd.keys()];
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: wrong file for bot${TOKEN}` }));
  }, async (base) => {
    const client = createTgClient({ apiBase: base, token: TOKEN } as any);
    await assert.rejects(client.sendPhoto('1', { filename: 'qr.png', content: PNG }), (e: unknown) => {
      assert.ok(e instanceof TgError);
      assert.equal(e.code, 400);
      assert.equal(e.permanent, true);
      assert.ok(!e.message.includes('SECRET'), e.message);
      assert.match(e.message, /^sendPhoto: /);
      return true;
    });
  });
  assert.deepEqual(fields.sort(), ['chat_id', 'photo']);
});
