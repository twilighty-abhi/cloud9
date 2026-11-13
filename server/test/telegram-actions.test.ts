// Telegram admin actions (v2): /newsession, /joining, /hide, /show, /end with confirm taps. Agent ACTIONS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRepo } from './fakeRepo';
import { FakeRegistry } from './fakeRegistry';
import { createCommandRouter } from '../src/notify/commands';
import { createActions, parseLabel } from '../src/notify/actions';
import { createBus } from '../src/notify/bus';
import type { OutMsg, Sender, TgClient, TelegramConfig, NotifyEvent, Button } from '../src/notify/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';

const ADMIN = 111;
const STRANGER = 999;

const cfg: TelegramConfig = {
  token: 'T', apiBase: 'http://x', notifyChatIds: [], adminIds: [String(ADMIN)], topics: {},
  notifyQuestions: false, digestMinutes: 0, sendCsv: true,
};

function quiz(id: string, title: string, mod: string, eventId: string | null, n: number): QuizDef {
  return {
    id, moderatorId: mod, eventId, title, emailMode: 'required', scoring: 'speed', createdAt: 1, updatedAt: 1,
    questions: Array.from({ length: n }, (_, k) => ({ id: `${id}_q${k}`, text: `Q${k}`, imageUrl: null, options: ['a', 'b'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 })),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(opts: { photoFails?: boolean; editFails?: boolean } = {}) {
  const repo = new FakeRepo();
  const registry = new FakeRegistry(repo, 'https://quiz.test');
  const ev = { id: 'ev_ccd', moderatorId: 'mod_super', name: 'CCD Kochi 26', emailRequired: true, createdAt: 10, updatedAt: 10 };
  repo.saveEvent(ev);
  repo.saveQuiz(quiz('qz1', 'Hall 3 · 2:00–2:30 PM · Serverless', 'mod_hall3', ev.id, 5));
  repo.saveQuiz(quiz('qz2', 'Main Hall · 11:55 AM–12:25 PM · Keynote Quiz', 'mod_hall1', ev.id, 3));
  repo.saveQuiz(quiz('qz3', 'Empty draft', 'mod_hall2', ev.id, 0));
  repo.saveQuiz(quiz('qz9', 'Other thing', 'mod_hall2', null, 2));

  const out: OutMsg[] = [];
  const sender: Sender = { enqueue: (m) => { out.push(m); }, stats: () => ({ queued: 0, sent: 0, failed: 0, lastError: null }) };
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const photos: { chatId: string; filename: string; bytes: number; caption?: string; threadId?: number | null }[] = [];
  const client: TgClient = {
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'editMessageText' && opts.editFails) throw new Error('message is not modified');
      if (method === 'getMe') return { id: 1, username: 'ccdquizbot' } as any;
      return true as any;
    },
    async sendDocument() {},
    async sendPhoto(chatId, photo, o) {
      if (opts.photoFails) throw new Error('boom');
      photos.push({ chatId, filename: photo.filename, bytes: photo.content.length, caption: o?.caption, threadId: o?.threadId });
    },
  };
  const bus = createBus();
  const events: NotifyEvent[] = [];
  bus.on((e) => events.push(e));
  const config = { publicUrl: 'https://quiz.test' } as Config;
  const actions = createActions({ cfg, client, sender, repo, registry, config, bus });
  const router = createCommandRouter({ cfg, client, sender, repo, registry, config, actions });

  let uid = 1;
  const msg = (text: string, from = ADMIN) =>
    router.handleUpdate({ update_id: uid++, message: { message_id: uid, text, from: { id: from }, chat: { id: from, type: 'private' } } });
  const cb = (data: string, from = ADMIN, messageId = 77) =>
    router.handleUpdate({ update_id: uid++, callback_query: { id: `cb${uid}`, data, from: { id: from }, message: { message_id: messageId, chat: { id: from, type: 'private' } } } });
  const edits = () => calls.filter((c) => c.method === 'editMessageText');
  const lastEdit = () => edits()[edits().length - 1]?.params as any;
  const last = () => out[out.length - 1];
  const btnData = (rows?: Button[][]) => (rows ?? []).flat().map((x) => x.data);
  const kbData = (p: any) => (p?.reply_markup?.inline_keyboard ?? []).flat().map((x: any) => x.callback_data);
  return { repo, registry, router, actions, out, calls, photos, events, msg, cb, edits, lastEdit, last, btnData, kbData, ev };
}

test('parseLabel', () => {
  assert.equal(parseLabel('Hall 3 · 2:00–2:30 PM · X'), 'Hall 3 · 2:00 PM');
  assert.equal(parseLabel('Main Hall · 11:55 AM–12:25 PM · X'), 'Main Hall · 11:55 AM');
  assert.equal(parseLabel('Cloud Basics'), '');
  assert.equal(parseLabel('Hall 2 · Kubernetes'), '');
  assert.equal(parseLabel('Hall 1 · 10:00 - 10:30 am · Y'), 'Hall 1 · 10:00 AM');
});

test('/newsession lists quizzes of the default event as buttons; filter; one match → preview', async () => {
  const t = setup();
  await t.msg('/newsession');
  const m = t.last();
  assert.match(m.text!, /CCD Kochi 26/);
  assert.deepEqual(t.btnData(m.buttons).sort(), ['nsq:qz1', 'nsq:qz2', 'nsq:qz3']);
  assert.equal(m.buttons!.length, 3);
  assert.ok(m.buttons!.every((r) => r.length === 1));
  assert.ok(!t.btnData(m.buttons).includes('nsq:qz9')); // other event
  await t.msg('/newsession KEYNOTE');
  assert.match(t.last().text!, /Create a lobby for <b>Main Hall · 11:55 AM–12:25 PM · Keynote Quiz<\/b>\?/);
  assert.deepEqual(t.btnData(t.last().buttons), ['nsy:qz2', 'cxl']);
  await t.msg('/newsession zzz');
  assert.match(t.last().text!, /No quizzes match/);
  assert.ok(t.router.commands().some((c) => c.command === 'newsession'));
  await t.msg('/help');
  assert.match(t.last().text!, /\/joining/);
});

test('nsq → preview (edited) → nsy creates lobby owned by the quiz moderator, emits, sends QR', async () => {
  const t = setup();
  await t.cb('nsq:qz1');
  const p = t.lastEdit();
  assert.equal(p.message_id, 77);
  assert.equal(p.text, "Create a lobby for <b>Hall 3 · 2:00–2:30 PM · Serverless</b>?\nOwner: hall3 · Label: Hall 3 · 2:00 PM · Players can join as soon as it's created.");
  assert.deepEqual(t.kbData(p), ['nsy:qz1', 'cxl']);
  await t.cb('nsy:qz1');
  await tick();
  const rooms = [...t.registry.rooms.values()];
  assert.equal(rooms.length, 1);
  const s = rooms[0].summary;
  assert.equal(s.moderatorId, 'mod_hall3');
  assert.equal(s.label, 'Hall 3 · 2:00 PM');
  assert.equal(s.listed, true);
  assert.equal(t.registry.lastCreateEvent?.id, 'ev_ccd');
  const created = t.events.find((e) => e.type === 'session.created');
  assert.ok(created && created.actor === `telegram:${ADMIN}`);
  const r = t.lastEdit();
  assert.match(r.text, /Done ✓/);
  assert.match(r.text, new RegExp(`https://quiz.test/join/${s.code}`));
  assert.match(r.text, new RegExp(`https://quiz.test/present/${s.code}`));
  assert.match(r.text, new RegExp(`https://quiz.test/mod/room/${s.code}`));
  assert.deepEqual(t.kbData(r), [`ses:${s.code}`, `act:joff:${s.code}`, `act:end:${s.code}`]);
  assert.equal(t.photos.length, 1);
  assert.ok(t.photos[0].bytes > 100);
  assert.equal(t.photos[0].caption, `Scan to join · ${s.code.slice(0, 3)} ${s.code.slice(3)}`);
  // replaying the confirm is refused (one use)
  await t.cb('nsy:qz1');
  assert.match(t.lastEdit().text, /expired/);
  assert.equal(t.registry.rooms.size, 1);
});

test('duplicate live session refused; empty quiz refused; QR failure only logs; edit failure falls back to send', async () => {
  const t = setup({ photoFails: true, editFails: true });
  await t.cb('nsq:qz1');
  assert.match(t.last().text!, /Create a lobby/); // fallback message
  await t.cb('nsy:qz1');
  assert.equal(t.registry.rooms.size, 1);
  assert.match(t.last().text!, /Done ✓/);
  const code = [...t.registry.rooms.keys()][0];
  await t.cb('nsq:qz1');
  assert.match(t.last().text!, /Already live/);
  await t.cb('nsy:qz1');
  assert.match(t.last().text!, new RegExp(`Already live: code <code>${code.slice(0, 3)} ${code.slice(3)}</code>`));
  assert.deepEqual(t.btnData(t.last().buttons), [`ses:${code}`]);
  assert.equal(t.registry.rooms.size, 1);
  await t.cb('nsq:qz3');
  await t.cb('nsy:qz3');
  assert.match(t.last().text!, /no questions/);
  assert.equal(t.registry.rooms.size, 1);
});

function withRoom() {
  const t = setup();
  const q = t.repo.getQuiz('qz1')!;
  const s = t.registry.createSession({ quiz: q, event: t.ev, moderatorId: 'mod_hall3', label: 'Hall 3', listed: true });
  for (const n of ['A', 'B', 'C']) t.registry.join(s.code, { name: n, email: `${n}@x.test` });
  return { ...t, code: s.code };
}

test('/joining off → confirm → patch + session.updated', async () => {
  const t = withRoom();
  await t.msg(`/joining ${t.code} off`);
  assert.equal(t.last().text, `Close joining for <b>Hall 3 · 2:00–2:30 PM · Serverless</b> (Hall 3)? 3 players are in.\nCode: <code>${t.code.slice(0, 3)} ${t.code.slice(3)}</code>`);
  assert.deepEqual(t.btnData(t.last().buttons), [`acy:joff:${t.code}`, 'cxl']);
  assert.equal(t.registry.summary(t.code)!.joinOpen, true); // nothing yet
  await t.cb(`acy:joff:${t.code}`);
  await tick();
  assert.equal(t.registry.summary(t.code)!.joinOpen, false);
  const u = t.events.find((e) => e.type === 'session.updated') as any;
  assert.deepEqual(u.changes, { joinOpen: false });
  assert.equal(u.actor, `telegram:${ADMIN}`);
  assert.match(t.lastEdit().text, /^Done ✓ Joining closed/);
  assert.deepEqual(t.kbData(t.lastEdit()), [`ses:${t.code}`]);
  await t.msg(`/joining ${t.code} off`);
  assert.match(t.last().text!, /already closed/);
  await t.msg(`/joining ${t.code} on`);
  await t.cb(`acy:jon:${t.code}`);
  assert.equal(t.registry.summary(t.code)!.joinOpen, true);
  await t.msg('/joining 12 off');
  assert.match(t.last().text!, /Usage/);
});

test('/hide and /show', async () => {
  const t = withRoom();
  await t.msg(`/hide ${t.code}`);
  assert.match(t.last().text!, /^Hide <b>/);
  await t.cb(`acy:hide:${t.code}`);
  await tick();
  assert.equal(t.registry.summary(t.code)!.listed, false);
  assert.deepEqual((t.events.at(-1) as any).changes, { listed: false });
  await t.msg(`/show ${t.code.slice(0, 3)} ${t.code.slice(3)}`);
  assert.match(t.last().text!, /^Show <b>/);
  await t.cb(`acy:show:${t.code}`);
  await tick();
  assert.equal(t.registry.summary(t.code)!.listed, true);
  assert.deepEqual((t.events.at(-1) as any).changes, { listed: true });
});

test('/end → confirm → endSession; finished/unknown rooms get a friendly error; act: buttons arm a confirm', async () => {
  const t = withRoom();
  await t.cb(`act:end:${t.code}`);
  assert.match(t.last().text!, /^End <b>.*now\? 3 players are in/);
  await t.cb(`acy:end:${t.code}`);
  assert.deepEqual(t.registry.endSessionCalls, [{ code: t.code, actor: `telegram:${ADMIN}` }]);
  assert.equal(t.registry.summary(t.code)!.state, 'FINISHED');
  assert.match(t.lastEdit().text, /^Done ✓ Ended/);
  await t.msg(`/end ${t.code}`);
  assert.match(t.last().text!, /already finished/);
  await t.msg('/end 000000');
  assert.match(t.last().text!, /not found/);
  await t.msg('/hide 000000');
  assert.match(t.last().text!, /not found/);
});

test('expired / unknown confirms refused; cxl cancels', async () => {
  const t = withRoom();
  await t.cb(`acy:end:${t.code}`); // never shown
  assert.match(t.lastEdit().text, /This button expired — run the command again\./);
  assert.equal(t.registry.endSessionCalls.length, 0);
  await t.cb('nsy:qz2');
  assert.match(t.lastEdit().text, /expired/);
  assert.equal(t.registry.rooms.size, 1);

  await t.msg(`/end ${t.code}`);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60 * 1000;
    await t.cb(`acy:end:${t.code}`);
  } finally { Date.now = realNow; }
  assert.match(t.lastEdit().text, /expired/);
  assert.equal(t.registry.endSessionCalls.length, 0);

  await t.cb('nsq:qz2', ADMIN, 90);
  await t.cb('cxl', ADMIN, 90);
  assert.equal(t.lastEdit().text, 'Cancelled.');
  assert.deepEqual(t.kbData(t.lastEdit()), []);
  await t.cb('nsy:qz2', ADMIN, 90); // cancel disarmed it
  assert.match(t.lastEdit().text, /expired/);
  assert.equal(t.registry.rooms.size, 1);
});

test('non-admins are ignored (router and actions directly)', async () => {
  const t = withRoom();
  await t.msg(`/end ${t.code}`, STRANGER);
  await t.msg('/newsession', STRANGER);
  await t.cb('nsq:qz1', STRANGER);
  await t.cb(`acy:end:${t.code}`, STRANGER);
  assert.equal(t.registry.endSessionCalls.length, 0);
  assert.equal(t.registry.rooms.size, 1);
  assert.equal(t.edits().length, 0);
  assert.ok(t.out.every((m) => m.text === 'This bot is private.'));
  const ctx = { chatId: String(STRANGER), threadId: null, isPrivate: true };
  assert.equal(await t.actions.command(ctx, 'end', t.code, String(STRANGER)), false);
  assert.equal(await t.actions.callback(ctx, `acy:end:${t.code}`, String(STRANGER), 1), true);
  assert.equal(t.registry.endSessionCalls.length, 0);
  // existing callbacks are not swallowed by actions
  assert.equal(await t.actions.callback(ctx, `ses:${t.code}`, String(ADMIN), 1), false);
});
