import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../src/notify/bus';
import type { NotifyEvent, OutMsg, Sender, TelegramConfig } from '../src/notify/contracts';
import type { GameRegistry } from '../src/contracts';
import type { SessionSummary, QuizDef } from '../../shared/model';
import { attachNotifications, createNotifications, formatEvent, fmtIst, topicKey } from '../src/notify/notifications';
import { FakeRepo } from './fakeRepo';

const cfgBase: TelegramConfig = {
  token: 'SECRET:TOKEN', apiBase: 'http://x', notifyChatIds: ['-100111', '-100222'], adminIds: ['42'],
  topics: { hall1: 12, hall2: 13, hall3: 14, admin: 15, system: 16 }, notifyQuestions: false, digestMinutes: 0, sendCsv: true,
};

const sess = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', code: '482913', quizId: 'q1', moderatorId: 'mod_hall3', eventId: 'ev1', eventName: "CCD Kochi '26",
  title: 'Agentic SRE', label: 'Neel Shah', state: 'LOBBY', qIndex: -1, total: 5, players: 87, listed: true, joinOpen: true,
  joinUrl: 'http://t/join/482913', createdAt: 0, endedAt: null, ...over,
});

const quiz: QuizDef = {
  id: 'q1', moderatorId: 'mod_hall3', eventId: 'ev1', title: 'Agentic SRE', emailMode: 'required', scoring: 'speed', createdAt: 0, updatedAt: 0,
  questions: [{ id: 'qq1', text: 'x', imageUrl: null, options: ['a', 'b'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 }],
};

function setup(over: Partial<TelegramConfig> = {}, live: SessionSummary[] = []) {
  const cfg = { ...cfgBase, ...over };
  const out: OutMsg[] = [];
  const sender: Sender = { enqueue: (m) => { out.push(m); }, stats: () => ({ queued: 0, sent: 0, failed: 0, lastError: null }) };
  const repo = new FakeRepo();
  repo.saveEvent({ id: 'ev1', moderatorId: 'mod_admin', name: "CCD Kochi '26", emailRequired: true, createdAt: 0, updatedAt: 0 });
  repo.insertSession({ id: 's1', code: '482913', quizId: 'q1', moderatorId: 'mod_hall3', eventId: 'ev1', label: 'Neel Shah', listed: true, joinOpen: true,
    state: 'FINISHED', qIndex: 0, qStartedAt: null, qEndsAt: null, quiz, createdAt: 0, endedAt: 1 });
  repo.insertPlayer({ id: 'p1', sessionId: 's1', name: 'Anu', email: 'anu@example.com', tokenHash: 'h', score: 900, kicked: false, joinedAt: 1 });
  repo.insertPlayer({ id: 'p2', sessionId: 's1', name: 'Ravi', email: 'ravi@example.com', tokenHash: 'h', score: 500, kicked: false, joinedAt: 2 });
  const registry = {
    liveSessions: live,
    liveCountByEvent() { const m = new Map<string, number>(); for (const s of this.liveSessions) if (s.eventId && s.state !== 'FINISHED') m.set(s.eventId, (m.get(s.eventId) ?? 0) + 1); return m; },
    listSummaries() { return this.liveSessions; },
  };
  let intervalFn: (() => void) | null = null; let cleared = false;
  const n = createNotifications({ cfg, bus: createBus(), sender, repo, registry: registry as unknown as GameRegistry }, {
    now: () => Date.UTC(2026, 10, 14, 9, 0), log: () => {},
    setInterval: (fn) => { intervalFn = fn; return 1; }, clearInterval: () => { cleared = true; },
  });
  return { cfg, out, repo, registry, n, tick: () => intervalFn?.(), get hasTimer() { return intervalFn !== null; }, get cleared() { return cleared; } };
}

const finished = (eventBoard = true): NotifyEvent => ({
  type: 'session.finished', at: 0, actor: null, session: sess({ state: 'FINISHED', players: 2 }), endedEarly: false,
  leaderboard: [{ name: 'Anu', score: 900, rank: 1 }, { name: 'Ravi', score: 500, rank: 2 }, { name: 'Zed <x>', score: 10, rank: 4 }],
  eventBoard: eventBoard ? { eventName: "CCD Kochi '26", top: [{ name: 'Anu', score: 2400, rank: 1 }], total: 312 } : null,
});

test('formats event.* and quiz.*', () => {
  const t = setup();
  t.n.handle({ type: 'event.created', at: 0, actor: 'admin', event: { id: 'ev1', name: "CCD Kochi '26", emailRequired: true } });
  assert.equal(t.out[0].text, "📅 Event created: <b>CCD Kochi '26</b> · email required · by admin");
  t.n.handle({ type: 'quiz.updated', at: 0, actor: 'hall2', quiz: { id: 'q', title: 'Agentic SRE · Neel Shah', eventId: 'ev1', questionCount: 5, owner: 'mod_hall2' } });
  assert.equal(t.out[2].text, "📝 hall2 updated <b>Agentic SRE · Neel Shah</b> (5 Qs) · in CCD Kochi '26");
  assert.equal(t.out[2].threadId, 13);
  assert.equal(t.out[0].threadId, 15); // admin topic
});

test('session.created: text, buttons, routing to owner topic in every notify chat', () => {
  const t = setup();
  t.n.handle({ type: 'session.created', at: 0, actor: 'hall3', session: sess() });
  assert.equal(t.out.length, 2);
  assert.deepEqual(t.out.map((m) => m.chatId), ['-100111', '-100222']);
  assert.match(t.out[0].text!, /^🆕 <b>Agentic SRE<\/b> — Neel Shah · code <code>482 913<\/code> · by hall3/);
  assert.equal(t.out[0].threadId, 14);
  assert.deepEqual(t.out[0].buttons, [[{ text: 'Details', data: 'ses:482913' }, { text: 'Board', data: 'lb:482913' }]]);
});

test('unknown moderator falls back to admin topic; no mapping → no thread', () => {
  const t = setup();
  t.n.handle({ type: 'session.started', at: 0, actor: null, session: sess({ moderatorId: 'mod_guest' }) });
  assert.equal(t.out[0].threadId, 15);
  assert.equal(t.out[0].text, '▶️ Started <b>Agentic SRE</b> · Neel Shah · 87 players');
  const t2 = setup({ topics: {} });
  t2.n.handle({ type: 'system.started', at: 0, actor: null, restoredRooms: 3, moderators: 4 });
  assert.equal(t2.out[0].threadId, null);
  assert.equal(t2.out[0].text, '✅ Cloud 9 online · 3 rooms restored');
  assert.equal(topicKey({ type: 'system.warning', at: 0, actor: null, message: 'x' }), 'system');
});

test('session.updated lists changes, coalesces and merges bursts', () => {
  const t = setup();
  t.n.handle({ type: 'session.updated', at: 1000, actor: 'hall3', session: sess(), changes: { label: 'Talk 2' } });
  t.n.handle({ type: 'session.updated', at: 2000, actor: 'hall3', session: sess(), changes: { listed: false, joinOpen: false } });
  const last = t.out[t.out.length - 1];
  assert.equal(last.coalesceKey, 'sess-upd:482913');
  assert.match(last.text!, /label → Talk 2/);
  assert.match(last.text!, /home page: hidden/);
  assert.match(last.text!, /joining: closed/);
});

test('question.closed only when notifyQuestions', () => {
  const ev: NotifyEvent = { type: 'question.closed', at: 0, actor: null, session: sess(), qIndex: 2, answered: 71, playerCount: 87, correct: 38 };
  const off = setup();
  off.n.handle(ev);
  assert.equal(off.out.length, 0);
  const on = setup({ notifyQuestions: true });
  on.n.handle(ev);
  assert.match(on.out[0].text!, /^Q3\/5 closed · 71\/87 answered · 54% correct/);
  assert.equal(on.out[0].priority, 'low');
  assert.equal(on.out[0].coalesceKey, 'q:482913');
});

test('session.finished: boards, buttons, CSV only to admin private chats', () => {
  const t = setup();
  t.n.handle(finished());
  const texts = t.out.filter((m) => m.kind === 'text');
  const docs = t.out.filter((m) => m.kind === 'document');
  assert.equal(texts.length, 2);
  const s = texts[0].text!;
  assert.match(s, /^🏁 <b>Agentic SRE<\/b> finished \(2 players\)/);
  assert.match(s, /🥇 Anu — <b>900<\/b>\n🥈 Ravi — <b>500<\/b>\n4\. Zed &lt;x&gt; — <b>10<\/b>/);
  assert.match(s, /<b>CCD Kochi '26<\/b> standings\n🥇 Anu — <b>2400<\/b>/);
  assert.match(s, /312 players in the event/);
  assert.deepEqual(texts[0].buttons, [[{ text: 'Quiz board', data: 'lb:482913' }, { text: 'Event board', data: 'lbe:ev1' }]]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].chatId, '42');
  assert.ok(docs[0].document!.content.includes('anu@example.com'));
  assert.match(docs[0].document!.filename, /^cloud9-482913-.*\.csv$/);
  for (const d of docs) assert.ok(!cfgBase.notifyChatIds.includes(d.chatId));

  const noCsv = setup({ sendCsv: false });
  noCsv.n.handle(finished(false));
  assert.equal(noCsv.out.filter((m) => m.kind === 'document').length, 0);
  assert.doesNotMatch(noCsv.out[0].text!, /standings/);
});

test('player.kicked and system.warning', () => {
  const t = setup();
  t.n.handle({ type: 'player.kicked', at: 0, actor: 'hall2', session: sess({ moderatorId: 'mod_hall2' }), playerName: 'Troll' });
  assert.equal(t.out[0].text, '🚫 hall2 removed <b>Troll</b> from Agentic SRE');
  assert.equal(t.out[0].threadId, 13);
  t.n.handle({ type: 'system.warning', at: 0, actor: null, message: 'DB slow <5s>' });
  assert.equal(t.out[2].text, '⚠️ DB slow &lt;5s&gt;');
  assert.equal(t.out[2].threadId, 16);
});

test("no '@' or token in any non-admin message, even with email-like player names", () => {
  const t = setup({ notifyQuestions: true }, [sess({ state: 'QUESTION', qIndex: 1 })]);
  const evil = 'evil@example.com';
  const evs: NotifyEvent[] = [
    { type: 'event.updated', at: 0, actor: 'admin', event: { id: 'ev1', name: 'E', emailRequired: false } },
    { type: 'quiz.created', at: 0, actor: 'hall1', quiz: { id: 'q', title: 'T', eventId: null, questionCount: 1, owner: 'mod_hall1' } },
    { type: 'session.created', at: 0, actor: 'hall3', session: sess() },
    { type: 'session.updated', at: 0, actor: 'hall3', session: sess(), changes: { label: 'L' } },
    { type: 'session.started', at: 0, actor: null, session: sess() },
    { type: 'question.closed', at: 0, actor: null, session: sess(), qIndex: 0, answered: 1, playerCount: 2, correct: 1 },
    { ...(finished() as any), leaderboard: [{ name: evil, score: 1, rank: 1 }] },
    { type: 'player.kicked', at: 0, actor: 'hall3', session: sess(), playerName: evil },
    { type: 'system.started', at: 0, actor: null, restoredRooms: 0, moderators: 1 },
    { type: 'system.warning', at: 0, actor: null, message: `failed for ${evil}` },
  ];
  for (const e of evs) t.n.handle(e);
  t.n.runDigest();
  const nonAdmin = t.out.filter((m) => !cfgBase.adminIds.includes(m.chatId));
  assert.ok(nonAdmin.length >= evs.length * 2);
  for (const m of nonAdmin) {
    assert.ok(!m.text!.includes('@'), m.text);
    assert.ok(!m.text!.includes('SECRET'), m.text);
    assert.equal(m.kind, 'text');
  }
});

test('digest: per live event, coalesced, skipped when unchanged, timer cleared on stop', () => {
  const t = setup({ digestMinutes: 30 }, [sess({ state: 'QUESTION', qIndex: 1, players: 40 }), sess({ code: '111222', eventId: 'other', state: 'FINISHED' })]);
  assert.ok(t.hasTimer);
  t.tick();
  assert.equal(t.out.length, 2);
  const m = t.out[0];
  assert.equal(m.coalesceKey, 'digest:ev1');
  assert.equal(m.priority, 'low');
  assert.match(m.text!, /^📊 <b>CCD Kochi '26<\/b> · 14:30 IST/);
  assert.match(m.text!, /🥇 Anu — <b>900<\/b>/);
  assert.match(m.text!, /Live \(1\)<\/b>\n• <b>Agentic SRE<\/b> — Neel Shah · <code>482 913<\/code> · Q2\/5 · 40 players/);
  assert.ok(!m.text!.includes('@'));
  t.tick();
  assert.equal(t.out.length, 2, 'unchanged → skipped');
  t.registry.liveSessions[0] = sess({ state: 'QUESTION', qIndex: 2, players: 41 });
  t.tick();
  assert.equal(t.out.length, 4, 'changed → sent');
  t.registry.liveSessions = [];
  t.tick();
  assert.equal(t.out.length, 4, 'no live sessions → nothing');
  t.n.stop();
  assert.ok(t.cleared);
  assert.ok(!setup().hasTimer, 'digestMinutes 0 → no timer');
});

test('listener never throws when sender/repo explode; attachNotifications wires the bus', async () => {
  const bus = createBus();
  const repo = new FakeRepo();
  repo.getLatestSessionByCode = () => { throw new Error('db down'); };
  const sent: OutMsg[] = [];
  const sender: Sender = { enqueue: (m) => { if (m.kind === 'document') throw new Error('boom'); sent.push(m); }, stats: () => ({ queued: 0, sent: 0, failed: 0, lastError: null }) };
  const origErr = console.error; console.error = () => {};
  try {
    const h = attachNotifications({ cfg: cfgBase, bus, sender, repo, registry: {} as GameRegistry, config: {} as any });
    bus.emit(finished());
    bus.emit({ type: 'system.started', at: 0, actor: null, restoredRooms: 1, moderators: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 4);
    h.stop();
    bus.emit({ type: 'system.started', at: 0, actor: null, restoredRooms: 1, moderators: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 4, 'unsubscribed');
  } finally { console.error = origErr; }
});

test('pure helpers', () => {
  assert.equal(fmtIst(Date.UTC(2026, 10, 14, 18, 45)), '00:15');
  assert.equal(formatEvent({ type: 'system.started', at: 0, actor: null, restoredRooms: 1, moderators: 1 }), '✅ Cloud 9 online · 1 room restored');
});
