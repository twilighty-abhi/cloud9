// Cloud 9 — Telegram transport tests (client + outbox + sender) against a local fake Bot API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTgClient } from '../src/notify/client';
import { createSenderWithTuning } from '../src/notify/sender';
import { TgError, type TelegramConfig } from '../src/notify/contracts';

const TOKEN = '123456:SECRET_TOKEN_abc';

interface Call { method: string; at: number; params: Record<string, any>; files: Record<string, { name: string; content: string; type: string }> }
type Reply = { status: number; body: any } | null;

function fakeApi() {
  const calls: Call[] = [];
  let handler: (c: Call) => Reply = () => null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = Buffer.concat(chunks);
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    if (!m || m[1] !== TOKEN) { res.writeHead(404).end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' })); return; }
    const call: Call = { method: m[2], at: Date.now(), params: {}, files: {} };
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.startsWith('multipart/form-data')) {
      const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') call.params[k] = v;
        else call.files[k] = { name: (v as File).name, content: await (v as Blob).text(), type: (v as Blob).type };
      }
    } else if (body.length) call.params = JSON.parse(body.toString('utf8'));
    calls.push(call);
    const r = handler(call) ?? { status: 200, body: { ok: true, result: { message_id: calls.length } } };
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
  return {
    calls,
    setHandler(h: (c: Call) => Reply) { handler = h; },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address() as { port: number };
      return `http://127.0.0.1:${addr.port}`;
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'c9-tg-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let dbN = 0;
const newDb = () => join(dir, `t${++dbN}.db`);
const cfgFor = (apiBase: string): TelegramConfig => ({
  token: TOKEN, apiBase, notifyChatIds: [], adminIds: [], topics: {}, notifyQuestions: false, digestMinutes: 0, sendCsv: true,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await sleep(20);
  }
}

async function setup(tuning: Parameters<typeof createSenderWithTuning>[1] = {}) {
  const api = fakeApi();
  const base = await api.listen();
  const cfg = cfgFor(base);
  const client = createTgClient(cfg);
  const dbPath = newDb();
  const sender = createSenderWithTuning({ cfg, dbPath, client }, { perChatMs: 50, ...tuning });
  return { api, base, cfg, client, dbPath, sender, async done() { await sender.stop(); await api.close(); } };
}

test('client: parses errors into TgError and never leaks the token', async () => {
  const api = fakeApi();
  const base = await api.listen();
  const client = createTgClient(cfgFor(base));
  api.setHandler((c) => (c.method === 'getMe' ? null : c.method === 'flood'
    ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } }
    : { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }));
  const me = await client.call<{ message_id: number }>('getMe');
  assert.equal(me.message_id, 1);
  await assert.rejects(client.call('flood'), (e: any) => e instanceof TgError && e.code === 429 && e.retryAfterSec === 7 && !e.permanent);
  await assert.rejects(client.call('sendMessage', { chat_id: '1' }), (e: any) => e instanceof TgError && e.code === 403 && e.permanent);
  // network failure + timeout: message must not contain the token or URL
  const dead = createTgClient(cfgFor('http://127.0.0.1:1'));
  await assert.rejects(dead.call('getMe'), (e: any) => e instanceof TgError && e.code === 0 && !e.permanent && !e.message.includes(TOKEN) && !e.message.includes('127.0.0.1'));
  api.setHandler(() => null);
  await api.close();
});

test('delivers text with HTML params, buttons, threads; clips long text', async () => {
  const s = await setup();
  s.sender.start();
  s.sender.start(); // idempotent
  s.sender.enqueue({ chatId: '111', kind: 'text', text: '<b>hi</b>', buttons: [[{ text: 'Board', data: 'lb:123456' }]] });
  s.sender.enqueue({ chatId: '222', threadId: 12, kind: 'text', text: 'x\n'.repeat(5000) });
  await waitFor(() => s.api.calls.length === 2);
  const [a, b] = s.api.calls;
  assert.equal(a.method, 'sendMessage');
  assert.deepEqual(a.params, { chat_id: '111', text: '<b>hi</b>', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: 'Board', callback_data: 'lb:123456' }]] } });
  assert.equal(b.params.message_thread_id, 12);
  assert.ok(b.params.text.length <= 4096);
  await waitFor(() => s.sender.stats().sent === 2);
  assert.deepEqual({ ...s.sender.stats(), lastError: null }, { queued: 0, sent: 2, failed: 0, lastError: null });
  await s.done();
});

test('coalescing replaces queued content; priority orders delivery', async () => {
  const s = await setup();
  s.sender.enqueue({ chatId: '1', kind: 'text', text: 'low', priority: 'low' });
  s.sender.enqueue({ chatId: '1', kind: 'text', text: 'board v1', coalesceKey: 'lb' });
  s.sender.enqueue({ chatId: '1', kind: 'text', text: 'board v2', coalesceKey: 'lb' });
  s.sender.enqueue({ chatId: '2', kind: 'text', text: 'other chat v1', coalesceKey: 'lb' });
  s.sender.enqueue({ chatId: '1', kind: 'text', text: 'urgent', priority: 'high' });
  assert.equal(s.sender.stats().queued, 4);
  s.sender.start();
  await waitFor(() => s.api.calls.length === 4);
  const chat1 = s.api.calls.filter((c) => c.params.chat_id === '1').map((c) => c.params.text);
  assert.deepEqual(chat1, ['urgent', 'board v2', 'low']);
  await s.done();
});

test('per-chat pacing >= 1s with default tuning', async () => {
  const s = await setup({ perChatMs: 1050 });
  s.sender.start();
  for (let i = 0; i < 3; i++) s.sender.enqueue({ chatId: '42', kind: 'text', text: `m${i}` });
  s.sender.enqueue({ chatId: '43', kind: 'text', text: 'other' });
  await waitFor(() => s.api.calls.length === 4, 6000);
  const t = s.api.calls.filter((c) => c.params.chat_id === '42').map((c) => c.at);
  assert.ok(t[1] - t[0] >= 1000 && t[2] - t[1] >= 1000, `gaps ${t[1] - t[0]}, ${t[2] - t[1]}`);
  const other = s.api.calls.find((c) => c.params.chat_id === '43')!;
  assert.ok(other.at - t[0] < 500, 'other chat is not held back by chat 42 pacing');
  await s.done();
});

test('group chat sliding window limit respected (short window override)', async () => {
  const s = await setup({ perChatMs: 10, groupLimit: 3, groupWindowMs: 800 });
  s.sender.start();
  for (let i = 0; i < 5; i++) s.sender.enqueue({ chatId: '-100777', kind: 'text', text: `g${i}` });
  await waitFor(() => s.api.calls.length === 5, 5000);
  const t = s.api.calls.map((c) => c.at);
  assert.ok(t[2] - t[0] < 400, 'first 3 go quickly');
  assert.ok(t[3] - t[0] >= 790, `4th waits for window (${t[3] - t[0]}ms)`);
  assert.ok(t[4] - t[1] >= 790);
  await s.done();
});

test('429 retry_after is honoured; 5xx backs off then succeeds', async () => {
  const s = await setup({ backoffBaseMs: 100 });
  let n = 0;
  s.api.setHandler((c) => {
    n++;
    if (c.params.chat_id === '5' && n === 1) return { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } };
    if (c.params.chat_id === '6' && c.params.text === 'srv' && s.api.calls.filter((x) => x.params.chat_id === '6').length <= 2) return { status: 502, body: 'bad gateway' };
    return null;
  });
  s.sender.start();
  s.sender.enqueue({ chatId: '5', kind: 'text', text: 'flood' });
  await waitFor(() => s.api.calls.filter((c) => c.params.chat_id === '5').length === 2, 4000);
  const f = s.api.calls.filter((c) => c.params.chat_id === '5');
  assert.ok(f[1].at - f[0].at >= 950, `retry after ${f[1].at - f[0].at}ms`);
  s.sender.enqueue({ chatId: '6', kind: 'text', text: 'srv' });
  await waitFor(() => s.api.calls.filter((c) => c.params.chat_id === '6').length === 3, 4000);
  const g = s.api.calls.filter((c) => c.params.chat_id === '6').map((c) => c.at);
  assert.ok(g[1] - g[0] >= 90 && g[2] - g[1] >= 190, `backoff ${g[1] - g[0]}, ${g[2] - g[1]}`);
  await waitFor(() => s.sender.stats().sent === 2);
  await s.done();
});

test('403 marks failed (no retry)', async () => {
  const s = await setup();
  s.api.setHandler(() => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }));
  s.sender.start();
  s.sender.enqueue({ chatId: '9', kind: 'text', text: 'x' });
  await waitFor(() => s.sender.stats().failed === 1);
  await sleep(300);
  assert.equal(s.api.calls.length, 1);
  assert.match(s.sender.stats().lastError ?? '', /403/);
  await s.done();
});

test('thread not found → retried once without message_thread_id', async () => {
  const s = await setup();
  s.api.setHandler((c) => (c.params.message_thread_id != null
    ? { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message thread not found' } } : null));
  s.sender.start();
  s.sender.enqueue({ chatId: '-1001', threadId: 99, kind: 'text', text: 'topic msg' });
  await waitFor(() => s.sender.stats().sent === 1);
  assert.equal(s.api.calls.length, 2);
  assert.equal(s.api.calls[0].params.message_thread_id, 99);
  assert.equal(s.api.calls[1].params.message_thread_id, undefined);
  assert.equal(s.api.calls[1].params.text, 'topic msg');
  await s.done();
});

test('documents are sent multipart with filename, content, caption and buttons', async () => {
  const s = await setup();
  s.sender.start();
  const csv = 'rank,name,email\n1,Asha,asha@example.com\n';
  s.sender.enqueue({ chatId: '77', threadId: 3, kind: 'document', text: '<b>Results</b>', document: { filename: 'session-123456.csv', content: csv, mime: 'text/csv' }, buttons: [[{ text: 'Board', data: 'lb:1' }]] });
  await waitFor(() => s.sender.stats().sent === 1);
  const c = s.api.calls[0];
  assert.equal(c.method, 'sendDocument');
  assert.equal(c.params.chat_id, '77');
  assert.equal(c.params.message_thread_id, '3');
  assert.equal(c.params.caption, '<b>Results</b>');
  assert.equal(c.params.parse_mode, 'HTML');
  assert.deepEqual(JSON.parse(c.params.reply_markup), { inline_keyboard: [[{ text: 'Board', callback_data: 'lb:1' }]] });
  assert.equal(c.files.document.name, 'session-123456.csv');
  assert.equal(c.files.document.content, csv);
  await s.done();
});

test('persistence across restart; rows older than 24h expire', async () => {
  const api = fakeApi();
  const base = await api.listen();
  const cfg = cfgFor(base);
  const client = createTgClient(cfg);
  const dbPath = newDb();
  const a = createSenderWithTuning({ cfg, dbPath, client }, { perChatMs: 10 });
  a.enqueue({ chatId: '1', kind: 'text', text: 'survives' });
  a.enqueue({ chatId: '2', kind: 'text', text: 'too old' });
  await a.stop(); // never started
  assert.equal(api.calls.length, 0);
  const raw = new Database(dbPath);
  raw.prepare(`UPDATE telegram_outbox SET created_at = ? WHERE text = 'too old'`).run(Date.now() - 25 * 3600_000);
  raw.close();
  const b = createSenderWithTuning({ cfg, dbPath, client }, { perChatMs: 10 });
  b.start();
  await waitFor(() => b.stats().sent === 1);
  await sleep(200);
  assert.deepEqual(api.calls.map((c) => c.params.text), ['survives']);
  const st = b.stats();
  assert.equal(st.failed, 1);
  assert.equal(st.queued, 0);
  await b.stop();
  const raw2 = new Database(dbPath);
  assert.equal((raw2.prepare(`SELECT last_error FROM telegram_outbox WHERE text='too old'`).get() as any).last_error, 'expired');
  raw2.close();
  await api.close();
});

test('outbox cap drops lowest priority oldest first', async () => {
  const s = await setup({ maxQueued: 5 });
  for (let i = 0; i < 4; i++) s.sender.enqueue({ chatId: '1', kind: 'text', text: `low${i}`, priority: 'low' });
  for (let i = 0; i < 3; i++) s.sender.enqueue({ chatId: '1', kind: 'text', text: `norm${i}` });
  assert.deepEqual({ q: s.sender.stats().queued, f: s.sender.stats().failed }, { q: 5, f: 2 });
  s.sender.start();
  await waitFor(() => s.sender.stats().sent === 5);
  assert.deepEqual(s.api.calls.map((c) => c.params.text), ['norm0', 'norm1', 'norm2', 'low2', 'low3']);
  await s.done();
});

test('stop() is bounded and enqueue after stop never throws', async () => {
  const s = await setup({ stopTimeoutMs: 300 });
  s.api.setHandler(() => { return null; });
  s.sender.start();
  await s.sender.stop();
  assert.doesNotThrow(() => s.sender.enqueue({ chatId: '1', kind: 'text', text: 'late' }));
  await s.api.close();
});
