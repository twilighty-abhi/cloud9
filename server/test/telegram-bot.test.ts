// Telegram bot: command router + poller. Agent BOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeRepo } from './fakeRepo';
import { FakeRegistry } from './fakeRegistry';
import { createCommandRouter, parseCommand } from '../src/notify/commands';
import { startPoller } from '../src/notify/poller';
import { TgError } from '../src/notify/contracts';
import type { OutMsg, Sender, TgClient, TelegramConfig, CommandRouter } from '../src/notify/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';

const ADMIN = 111;
const STRANGER = 999;
const GROUP = -100500;

const cfg: TelegramConfig = {
  token: 'T', apiBase: 'http://x', notifyChatIds: [String(GROUP)], adminIds: [String(ADMIN)], topics: {},
  notifyQuestions: false, digestMinutes: 0, sendCsv: true,
};

function quiz(id: string, title: string, mod: string, eventId: string | null, n: number): QuizDef {
  return {
    id, moderatorId: mod, eventId, title, emailMode: 'required', scoring: 'speed', createdAt: 1, updatedAt: 1,
    questions: Array.from({ length: n }, (_, k) => ({ id: `${id}_q${k}`, text: `Q${k}`, imageUrl: null, options: ['a', 'b'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 })),
  };
}

function setup() {
  const repo = new FakeRepo();
  const registry = new FakeRegistry(repo);
  const ev = { id: 'ev_ccd', moderatorId: 'mod_admin', name: 'CCD Kochi 26', emailRequired: true, createdAt: 10, updatedAt: 10 };
  repo.saveEvent(ev);
  repo.saveEvent({ id: 'ev_old', moderatorId: 'mod_admin', name: 'Old Meetup', emailRequired: true, createdAt: 5, updatedAt: 5 });
  const q1 = quiz('qz1', 'Cloud Basics', 'mod_hall1', ev.id, 5);
  const q2 = quiz('qz2', 'Kubernetes <Deep> Dive', 'mod_hall2', ev.id, 3);
  repo.saveQuiz(q1); repo.saveQuiz(q2);
  const s1 = registry.createSession({ quiz: q1, event: ev, moderatorId: 'mod_hall1', label: 'Hall 1', listed: true });
  const s2 = registry.createSession({ quiz: q2, event: ev, moderatorId: 'mod_hall2', label: 'Hall 2', listed: true });
  const join = (c: string, name: string, email: string, score: number) => {
    const r = registry.join(c, { name, email });
    assert.ok(r.ok);
    repo.updatePlayer((r as any).playerId, { score });
  };
  join(s1.code, 'Anu', 'anu@x.test', 3000);
  join(s1.code, 'Rahul', 'rahul@x.test', 2500);
  join(s1.code, 'Meera', 'meera@x.test', 1200);
  join(s2.code, 'Anu', 'anu@x.test', 900);
  join(s2.code, 'Zed', 'zed@x.test', 2000);
  // s1 live on Q3 of 5; s2 finished
  const r1 = registry.rooms.get(s1.code)!.summary; r1.state = 'QUESTION'; r1.qIndex = 2;
  repo.updateSession(s1.id, { state: 'QUESTION', qIndex: 2, qStartedAt: Date.now() });
  const r2 = registry.rooms.get(s2.code)!.summary; r2.state = 'FINISHED'; r2.qIndex = 2; r2.endedAt = Date.now();
  repo.updateSession(s2.id, { state: 'FINISHED', qIndex: 2, endedAt: Date.now() });

  const out: OutMsg[] = [];
  const sender: Sender = { enqueue: (m) => { out.push(m); }, stats: () => ({ queued: 1, sent: 42, failed: 0, lastError: null }) };
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const client: TgClient = {
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'getMe') return { id: 1, username: 'Cloud9Bot' } as any;
      return true as any;
    },
    async sendDocument() {},
  };
  const config = { publicUrl: 'https://quiz.test' } as Config;
  const router = createCommandRouter({ cfg, client, sender, repo, registry, config });
  let uid = 1;
  const msg = (text: string, opts: { from?: number; chat?: 'private' | 'group'; thread?: number } = {}) => {
    const from = opts.from ?? ADMIN;
    const isGroup = opts.chat === 'group';
    return router.handleUpdate({
      update_id: uid++,
      message: {
        message_id: uid, text, from: { id: from, first_name: 'X' },
        chat: isGroup ? { id: GROUP, type: 'supergroup' } : { id: from, type: 'private' },
        ...(opts.thread ? { message_thread_id: opts.thread, is_topic_message: true } : {}),
      },
    });
  };
  const cb = (data: string, opts: { from?: number; chat?: 'private' | 'group' } = {}) => {
    const from = opts.from ?? ADMIN;
    return router.handleUpdate({
      update_id: uid++,
      callback_query: {
        id: `cb${uid}`, data, from: { id: from },
        message: { message_id: 5, chat: opts.chat === 'group' ? { id: GROUP, type: 'supergroup' } : { id: from, type: 'private' } },
      },
    });
  };
  const last = () => out[out.length - 1];
  return { repo, registry, router, out, calls, msg, cb, last, s1, s2, ev };
}

test('parseCommand handles /cmd@Bot and args', () => {
  assert.deepEqual(parseCommand('/live@Cloud9Bot'), { cmd: 'live', bot: 'Cloud9Bot', args: '' });
  assert.deepEqual(parseCommand('/export event  CCD Kochi'), { cmd: 'export', bot: null, args: 'event  CCD Kochi' });
  assert.equal(parseCommand('hello'), null);
});

test('non-admin: one polite reply per hour in private, silence in groups', async () => {
  const t = setup();
  await t.msg('/live', { from: STRANGER });
  await t.msg('/events', { from: STRANGER });
  assert.equal(t.out.length, 1);
  assert.equal(t.out[0].text, 'This bot is private.');
  await t.msg('/live', { from: STRANGER, chat: 'group' });
  assert.equal(t.out.length, 1);
  await t.cb(`lb:${t.s1.code}`, { from: STRANGER });
  assert.equal(t.out.length, 1);
  const ans = t.calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(ans.length, 1);
  assert.equal(ans[0].params?.text, 'This bot is private.');
});

test('/help, /start and unknown command list commands', async () => {
  const t = setup();
  await t.msg('/start');
  assert.match(t.last().text!, /\/live/);
  assert.match(t.last().text!, /\/export/);
  await t.msg('/nope');
  assert.match(t.last().text!, /Unknown command \/nope/);
  assert.match(t.last().text!, /\/leaderboard/);
  assert.equal(t.last().priority, 'high');
  assert.ok(t.router.commands().some((c) => c.command === 'live'));
});

test('/live and /live@Cloud9Bot in a forum topic', async () => {
  const t = setup();
  await t.msg('/live@Cloud9Bot', { chat: 'group', thread: 12 });
  const m = t.last();
  assert.equal(m.chatId, String(GROUP));
  assert.equal(m.threadId, 12);
  assert.match(m.text!, /Live sessions \(1\)/);
  assert.match(m.text!, /Hall 1/);
  assert.match(m.text!, /Cloud Basics/);
  assert.match(m.text!, /Q3 of 5/);
  assert.match(m.text!, /3 players/);
  assert.doesNotMatch(m.text!, /Hall 2/); // finished
  assert.equal(m.buttons![0][0].data, `ses:${t.s1.code}`);
  console.log('--- /live ---\n' + m.text);
  // addressed to another bot → ignored
  const n = t.out.length;
  await t.msg('/live@OtherBot', { chat: 'group' });
  assert.equal(t.out.length, n);
});

test('/events, /event, /quizzes', async () => {
  const t = setup();
  await t.msg('/events');
  assert.match(t.last().text!, /CCD Kochi 26<\/b> — 2 quizzes, 2 sessions, 1 live/);
  assert.match(t.last().text!, /Old Meetup/);
  await t.msg('/event');
  const e = t.last().text!;
  assert.match(e, /CCD Kochi 26/);
  assert.match(e, /Cloud Basics — hall1 \(5q\)/);
  assert.match(e, /Kubernetes &lt;Deep&gt; Dive — hall2/); // escaped
  assert.match(e, /Sessions \(2\)/);
  assert.match(e, /Top 5 of 4/);
  assert.match(e, /Anu &lt;anu@x.test&gt;/); // private → emails
  await t.msg('/event old');
  assert.match(t.last().text!, /Old Meetup/);
  await t.msg('/event nothing-like-this');
  assert.match(t.last().text!, /not found/);
  await t.msg('/quizzes CCD Kochi 26');
  assert.match(t.last().text!, /2 quizzes/);
  assert.match(t.last().text!, /Cloud Basics — hall1 · 5 questions/);
});

test('/leaderboard: event board, quiz board, emails only in private', async () => {
  const t = setup();
  await t.msg('/leaderboard');
  const priv = t.last().text!;
  assert.match(priv, /event leaderboard \(4 players\)/);
  assert.match(priv, /🥇 Anu &lt;anu@x.test&gt; — <b>3900<\/b>/);
  console.log('--- /leaderboard (private) ---\n' + priv);
  await t.msg('/leaderboard', { chat: 'group' });
  const grp = t.last().text!;
  assert.match(grp, /🥇 Anu — <b>3900<\/b>/);
  assert.doesNotMatch(grp, /@x\.test/);
  assert.equal(t.last().buttons, undefined); // no CSV button in groups
  await t.msg(`/leaderboard ${t.s1.code.slice(0, 3)} ${t.s1.code.slice(3)}`, { chat: 'group' });
  const qb = t.last().text!;
  assert.match(qb, /Cloud Basics/);
  assert.match(qb, /🥇 Anu — <b>3000<\/b>/);
  assert.match(qb, /🥈 Rahul/);
  assert.doesNotMatch(qb, /@x\.test/);
  console.log('--- /leaderboard <code> (group) ---\n' + qb);
  await t.msg(`/leaderboard ${t.s2.code}`); // finished session
  assert.match(t.last().text!, /Finished/);
  assert.match(t.last().text!, /🥇 Zed &lt;zed@x.test&gt;/);
});

test('/winner private vs group', async () => {
  const t = setup();
  await t.msg('/winner');
  assert.match(t.last().text!, /Anu<\/b> — <b>3900<\/b>/);
  assert.match(t.last().text!, /Email: anu@x.test/);
  assert.match(t.last().text!, /Quizzes played: 2/);
  await t.msg('/winner CCD', { chat: 'group' });
  assert.match(t.last().text!, /Anu/);
  assert.doesNotMatch(t.last().text!, /anu@x\.test|Quizzes played/);
});

test('/session details', async () => {
  const t = setup();
  await t.msg(`/session ${t.s1.code}`);
  const s = t.last().text!;
  assert.match(s, /Cloud Basics/);
  assert.match(s, /Hall: Hall 1/);
  assert.match(s, /Moderator: hall1/);
  assert.match(s, /State: <b>Q3 of 5<\/b>/);
  assert.match(s, /Players: 3/);
  assert.match(s, /Answered Q3: 0\/3/);
  assert.match(s, /Join: open · listed/);
  assert.match(s, /Created:/);
  await t.msg('/session 12');
  assert.match(t.last().text!, /Usage/);
  await t.msg('/session 000000');
  assert.match(t.last().text!, /not found/);
});

test('/export: CSV documents only in private', async () => {
  const t = setup();
  await t.msg(`/export ${t.s1.code}`, { chat: 'group' });
  assert.equal(t.last().kind, 'text');
  assert.equal(t.last().text, 'Ask me in a private chat for the CSV.');
  await t.msg(`/export ${t.s1.code}`);
  let d = t.last();
  assert.equal(d.kind, 'document');
  assert.match(d.document!.filename, /^cloud9-\d{6}-cloud-basics\.csv$/);
  assert.match(d.document!.content, /^﻿rank,name,email,score,correct_count/);
  assert.match(d.document!.content, /1,Anu,anu@x.test,3000/);
  await t.msg('/export event');
  d = t.last();
  assert.equal(d.kind, 'document');
  assert.equal(d.document!.filename, 'cloud9-event-ccd-kochi-26.csv');
  assert.match(d.document!.content, /^﻿rank,name,email,score,quizzes_played\r\n1,Anu,anu@x.test,3900,2/);
  await t.msg('/export');
  assert.match(t.last().text!, /Usage/);
});

test('/stats', async () => {
  const t = setup();
  await t.msg('/stats');
  assert.match(t.last().text!, /Rooms: 2 \(1 live\)/);
  assert.match(t.last().text!, /RSS: \d+ MB/);
  assert.match(t.last().text!, /1 queued · 42 sent · 0 failed/);
});

test('callback buttons produce the same output and answerCallbackQuery is called', async () => {
  const t = setup();
  await t.cb(`ses:${t.s1.code}`);
  assert.match(t.last().text!, /Moderator: hall1/);
  await t.cb(`lb:${t.s1.code}`);
  assert.match(t.last().text!, /🥇 Anu &lt;anu@x.test&gt; — <b>3000<\/b>/);
  await t.cb(`lbe:${t.ev.id}`, { chat: 'group' });
  assert.match(t.last().text!, /🥇 Anu — <b>3900<\/b>/);
  await t.cb(`exp:${t.s1.code}`);
  assert.equal(t.last().kind, 'document');
  await t.cb(`expe:${t.ev.id}`);
  assert.equal(t.last().kind, 'document');
  await t.cb(`expe:${t.ev.id}`, { chat: 'group' });
  assert.equal(t.last().text, 'Ask me in a private chat for the CSV.');
  const answered = t.calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answered.length, 6);
  assert.ok(answered.every((c) => typeof c.params?.callback_query_id === 'string'));
});

test('a throwing repo never escapes handleUpdate', async () => {
  const t = setup();
  t.repo.listEvents = () => { throw new Error('db locked'); };
  await t.msg('/events'); // must not throw
  assert.match(t.last().text!, /something went wrong/);
});

// ───────────── poller against a tiny fake Bot API ─────────────
function httpClient(base: string): TgClient {
  return {
    async call<T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
      const res = await fetch(`${base}/botT/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 15000),
      });
      const j: any = await res.json();
      if (!j.ok) throw new TgError(j.description ?? 'err', j.error_code ?? res.status, null, false);
      return j.result as T;
    },
    async sendDocument() {},
  };
}

test('poller: deleteWebhook, setMyCommands, offset handling, bad update survives, stop()', async () => {
  const seen: { method: string; body: any }[] = [];
  let getUpdatesCount = 0;
  const pending: (() => void)[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url!.split('/').pop()!;
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ method, body });
      const reply = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method !== 'getUpdates') return reply(true);
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        return reply([
          { update_id: 500, message: { text: '/boom', chat: { id: 1, type: 'private' }, from: { id: 1 } } },
          { update_id: 501, message: { text: '/ok', chat: { id: 1, type: 'private' }, from: { id: 1 } } },
        ]);
      }
      if (getUpdatesCount === 2) {
        // simulate 409 once
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }));
      }
      // long poll: hold the request open (empty) until test ends
      pending.push(() => reply([]));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const handled: number[] = [];
  const router: CommandRouter = {
    async handleUpdate(u: any) {
      handled.push(u.update_id);
      if (u.message.text === '/boom') throw new Error('bad update');
    },
    commands: () => [{ command: 'live', description: 'Live sessions' }],
  };
  // speed up: patch setTimeout for the 30s conflict backoff
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...a: any[]) => realSetTimeout(fn, Math.min(ms ?? 0, 20), ...a);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => { warnings.push(m); };
  try {
    const poller = startPoller({ cfg, client: httpClient(base), router });
    const t0 = Date.now();
    while (getUpdatesCount < 3 && Date.now() - t0 < 5000) await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(getUpdatesCount, 3);
    const t1 = Date.now();
    await poller.stop(); // must not wait for the open long poll
    assert.ok(Date.now() - t1 < 1000, 'stop() is prompt');

    assert.equal(seen[0].method, 'deleteWebhook');
    assert.equal(seen[0].body.drop_pending_updates, false);
    assert.equal(seen[1].method, 'setMyCommands');
    assert.equal(seen[1].body.commands[0].command, 'live');
    const gu = seen.filter((s) => s.method === 'getUpdates');
    assert.equal(gu[0].body.offset, 0);
    assert.equal(gu[0].body.timeout, 30);
    assert.deepEqual(gu[0].body.allowed_updates, ['message', 'callback_query']);
    assert.equal(gu[1].body.offset, 502);
    assert.equal(gu[2].body.offset, 502);
    assert.deepEqual(handled, [500, 501]);
    assert.equal(warnings.filter((w) => /409 Conflict/.test(w)).length, 1);
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    console.warn = warn;
    for (const p of pending) p();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
