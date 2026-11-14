// Game engine + realtime tests. Run: npx tsx --test server/test/game.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createGame } from '../src/game/index';
import type { Registry } from '../src/game/registry';
import { cleanName, checkEmail, dedupeName } from '../src/game/validate';
import type { AuthService, Game } from '../src/contracts';
import type { Config } from '../src/config';
import type { QuizDef } from '../../shared/model';
import { FakeRepo } from './fakeRepo';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://quiz.test', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [], maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};

const fakeAuth: AuthService = {
  verifyLogin: () => null,
  issueCookieValue: () => '',
  moderatorFromRequest: () => null,
  getModerator: () => null,
  moderatorFromCookieHeader(h) {
    const m = /c9_session=([a-z0-9]+)/.exec(h ?? '');
    if (!m) return null;
    return { id: m[1], username: m[1], displayName: m[1], isSuper: m[1] === 'root' };
  },
};

function makeQuiz(lastLimitSec = 1): QuizDef {
  const q = (id: string, correctIndex: number, timeLimitSec = 20) => ({
    id, text: `Question ${id}`, imageUrl: null, options: ['A', 'B', 'C', 'D'], correctIndex, timeLimitSec, pointsMax: 1000,
  });
  return {
    id: 'quiz1', moderatorId: 'mod1', eventId: null, title: 'Test Quiz', emailMode: 'optional', scoring: 'speed',
    questions: [q('q1', 1), q('q2', 2), q('q3', 0, lastLimitSec)], createdAt: 1, updatedAt: 1,
  };
}

// ───────────── tiny ws client ─────────────
class Client {
  msgs: any[] = [];
  cursor = 0;
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => { this.msgs.push(JSON.parse(d.toString())); this.wake(); });
    ws.on('close', (code) => { this.closeCode = code; this.wake(); });
    ws.on('error', () => {});
  }
  private wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  /** Wait for the next message (after cursor) matching pred; consumes up to and including it. */
  async next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.msgs.length; i++) {
        if (pred(this.msgs[i])) { this.cursor = i + 1; return this.msgs[i]; }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for message; got ${JSON.stringify(this.msgs.slice(this.cursor))}`);
      await new Promise<void>((res) => { const t = setTimeout(res, left); this.waiters.push(() => { clearTimeout(t); res(); }); });
    }
  }
  state(s: string) { return this.next((m) => m.t === 'state' && m.state === s); }
  error(code: string) { return this.next((m) => m.t === 'error' && m.code === code); }
  async closed(timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('socket not closed');
      await new Promise<void>((res) => { const t = setTimeout(res, 50); this.waiters.push(() => { clearTimeout(t); res(); }); });
    }
    return this.closeCode;
  }
  close() { this.ws.close(); }
}

function connect(port: number, qs: string, cookie?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`, { headers: cookie ? { cookie } : {} });
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

async function setup(repo = new FakeRepo()) {
  const game: Game = createGame({ repo, config });
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  game.attach(server, fakeAuth);
  const port = (server.address() as AddressInfo).port;
  const teardown = async () => {
    game.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { repo, game, server, port, teardown, registry: game.registry as Registry };
}

// ───────────── unit tests ─────────────

test('name validation and dedupe', () => {
  assert.equal(cleanName('  Anu   K  '), 'Anu K');
  assert.equal(cleanName('A\u0000n​u\n'), 'Anu');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('x'.repeat(25)), null);
  assert.equal(cleanName('x'.repeat(24)), 'x'.repeat(24));
  assert.equal(cleanName(42), null);

  const taken = new Set(['anu', 'anu (2)']);
  assert.equal(dedupeName('Bob', taken), 'Bob');
  assert.equal(dedupeName('ANU', taken), 'ANU (3)');
  const long = 'y'.repeat(24);
  const d = dedupeName(long, new Set([long]));
  assert.ok([...d].length <= 24 && d.endsWith(' (2)'));

  assert.deepEqual(checkEmail('x@y.z', 'off'), { ok: true, email: null });
  assert.deepEqual(checkEmail('', 'optional'), { ok: true, email: null });
  assert.deepEqual(checkEmail(' A@B.Co ', 'optional'), { ok: true, email: 'a@b.co' });
  assert.deepEqual(checkEmail('nope', 'optional'), { ok: false, error: 'invalid_email' });
  assert.deepEqual(checkEmail('', 'required'), { ok: false, error: 'email_required' });
  assert.deepEqual(checkEmail(`${'a'.repeat(120)}@b.co`, 'required'), { ok: false, error: 'invalid_email' });
});

test('registry join rules', async () => {
  const { registry, teardown } = await setup();
  try {
    const quiz = { ...makeQuiz(), emailMode: 'required' as const };
    const s = registry.createSession({ quiz, moderatorId: 'mod1', event: null, label: '  Hall   A ', listed: true });
    assert.match(s.code, /^\d{6}$/);
    assert.equal(s.label, 'Hall A');
    assert.equal(s.joinUrl, `http://quiz.test/join/${s.code}`);
    assert.deepEqual(registry.join(s.code, { name: 'Anu' }), { ok: false, error: 'email_required' });
    assert.deepEqual(registry.join(s.code, { name: '', email: 'a@b.co' }), { ok: false, error: 'invalid_name' });
    assert.deepEqual(registry.join('000000x', { name: 'A' }), { ok: false, error: 'not_found' });
    const a = registry.join(s.code, { name: 'Anu', email: 'a@b.co' });
    const b = registry.join(s.code, { name: 'anu', email: 'b@b.co' });
    assert.ok(a.ok && b.ok);
    assert.equal(b.ok && b.name, 'anu (2)');
    registry.patch(s.code, { joinOpen: false });
    assert.deepEqual(registry.join(s.code, { name: 'C', email: 'c@b.co' }), { ok: false, error: 'join_closed' });
    assert.equal(registry.publicList().length, 1);
    assert.equal(registry.ownerOf(s.code), 'mod1');
    assert.equal(registry.playInfo(s.code)?.emailMode, 'required');
    assert.equal(registry.summary(s.code)?.players, 2);
  } finally {
    await teardown();
  }
});

// ───────────── end-to-end ─────────────

test('full game over websockets', async () => {
  const { repo, registry, port, teardown } = await setup();
  const clients: Client[] = [];
  try {
    const s = registry.createSession({ quiz: makeQuiz(1), moderatorId: 'mod1', event: null, label: 'Room', listed: true });
    const code = s.code;
    const j1 = registry.join(code, { name: 'Anu' });
    const j2 = registry.join(code, { name: 'Bob' });
    const j3 = registry.join(code, { name: 'anu' });
    assert.ok(j1.ok && j2.ok && j3.ok);
    assert.equal(j3.ok && j3.name, 'anu (2)');

    // auth failures
    const bad = await connect(port, `role=player&code=${code}&token=nope`);
    await bad.error('unauthorized');
    assert.equal(await bad.closed(), 4401);
    const notMine = await connect(port, `role=mod&code=${code}`, 'c9_session=other');
    assert.equal(await notMine.closed(), 4401);
    const noRoom = await connect(port, `role=present&code=999999`);
    if (registry.get('999999') === null) assert.equal(await noRoom.closed(), 4404);
    const superMod = await connect(port, `role=mod&code=${code}`, 'c9_session=root');
    await superMod.state('LOBBY');
    superMod.close();

    const mod = await connect(port, `role=mod&code=${code}`, 'c9_session=mod1');
    const present = await connect(port, `role=present&code=${code}`);
    clients.push(mod, present);
    const lobbyMod = await mod.state('LOBBY');
    assert.equal(lobbyMod.playerCount, 3);
    assert.equal(lobbyMod.nextQuestion.correctIndex, 1);
    assert.equal(lobbyMod.correctIndex, null);
    const lobbyPresent = await present.state('LOBBY');
    assert.equal(lobbyPresent.nextQuestion, null);

    const p1 = await connect(port, `role=player&code=${code}&token=${j1.ok && j1.token}`);
    const p2 = await connect(port, `role=player&code=${code}&token=${j2.ok && j2.token}`);
    let p3 = await connect(port, `role=player&code=${code}&token=${j3.ok && j3.token}`);
    clients.push(p1, p2, p3);
    const ls = await p1.state('LOBBY');
    assert.equal(ls.me.rank, null);
    assert.equal(ls.me.name, 'Anu');
    await p2.state('LOBBY');
    await p3.state('LOBBY');
    // lobby delta shows players connected
    await mod.next((m) => m.t === 'lobby' && m.players.length === 3 && m.players.every((p: any) => p.connected));

    // ping
    p1.send({ t: 'ping' });
    const pong = await p1.next((m) => m.t === 'pong');
    assert.equal(typeof pong.serverNow, 'number');

    // stale + invalid
    mod.send({ t: 'mod', action: 'start', expectQ: 0 });
    await mod.error('stale');
    mod.send({ t: 'mod', action: 'reveal', expectQ: -1 });
    await mod.error('bad_transition');
    p1.send({ t: 'mod', action: 'start', expectQ: -1 });
    await p1.error('unauthorized');
    p1.send({ hello: 1 });
    await p1.error('bad_message');

    // ── Q1 (correct = 1)
    mod.send({ t: 'mod', action: 'start', expectQ: -1 });
    const q1mod = await mod.state('QUESTION');
    assert.equal(q1mod.qIndex, 0);
    assert.equal(q1mod.correctIndex, 1);
    assert.equal(q1mod.nextQuestion.correctIndex, 2);
    const q1pres = await present.state('QUESTION');
    assert.equal(q1pres.correctIndex, null);
    const q1p = await p1.state('QUESTION');
    assert.equal(q1p.question.qIndex, 0);
    assert.ok(!('correctIndex' in q1p.question));
    assert.equal(q1p.me.rank, 1);
    await p2.state('QUESTION');
    await p3.state('QUESTION');
    // double-click start is stale now
    mod.send({ t: 'mod', action: 'start', expectQ: -1 });
    await mod.error('stale');

    p1.send({ t: 'answer', qIndex: 0, choice: 1 });
    const ack = await p1.next((m) => m.t === 'ack');
    assert.deepEqual([ack.qIndex, ack.choice], [0, 1]);
    p1.send({ t: 'answer', qIndex: 0, choice: 2 });
    await p1.error('already_answered');
    p2.send({ t: 'answer', qIndex: 0, choice: 7 });
    await p2.error('bad_message');
    p2.send({ t: 'answer', qIndex: 1, choice: 0 });
    await p2.error('stale');
    p2.send({ t: 'answer', qIndex: 0, choice: 0 }); // wrong
    await p2.next((m) => m.t === 'ack');
    await mod.next((m) => m.t === 'progress' && m.answered === 2);
    // not closed yet: p3 still to answer
    assert.equal(registry.get(code)!.state, 'QUESTION');
    // scores hidden while question open
    const hidden = registry.get(code)!.hostSnapshot('present');
    assert.ok(hidden.players.every((p) => p.score === 0));
    p3.send({ t: 'answer', qIndex: 0, choice: 1 });
    // auto-close when all answered
    const closedMod = await mod.state('CLOSED');
    assert.deepEqual(closedMod.distribution, [1, 2, 0, 0]);
    assert.equal(closedMod.answered, 3);
    const closedP1 = await p1.state('CLOSED');
    assert.equal(closedP1.reveal, null);
    assert.equal(closedP1.myAnswer.choice, 1);
    assert.equal(closedP1.me.score, 0); // hidden until reveal
    await p2.state('CLOSED');
    await p3.state('CLOSED');

    mod.send({ t: 'mod', action: 'reveal', expectQ: 0 });
    const r1 = await p1.state('REVEAL');
    assert.equal(r1.reveal.correct, true);
    assert.equal(r1.reveal.correctIndex, 1);
    assert.ok(r1.reveal.points > 500 && r1.reveal.points <= 1000);
    assert.equal(r1.me.score, r1.reveal.points);
    const r2 = await p2.state('REVEAL');
    assert.deepEqual(r2.reveal, { correctIndex: 1, correct: false, points: 0 });
    assert.equal(r2.me.rank, 3);
    const r3 = await p3.state('REVEAL');
    assert.equal(r3.reveal.correct, true);
    const presReveal = await present.state('REVEAL');
    assert.equal(presReveal.correctIndex, 1);
    // p1 answered first → faster → higher score → rank 1
    assert.ok(r1.reveal.points >= r3.reveal.points);
    if (r1.reveal.points > r3.reveal.points) { assert.equal(r1.me.rank, 1); assert.equal(r3.me.rank, 2); }
    mod.send({ t: 'mod', action: 'reveal', expectQ: 0 });
    await mod.error('bad_transition');

    mod.send({ t: 'mod', action: 'leaderboard', expectQ: 0 });
    const lb1 = await p2.state('LEADERBOARD');
    assert.equal(lb1.leaderboard.length, 3);
    assert.deepEqual(lb1.leaderboard.map((e: any) => e.rank), [1, 2, 3]);
    assert.equal(lb1.leaderboard[2].name, 'Bob');
    assert.ok(lb1.reveal);
    await p1.state('LEADERBOARD');
    await p3.state('LEADERBOARD');

    // ── Q2 (correct = 2)
    mod.send({ t: 'mod', action: 'next', expectQ: 0 });
    await mod.state('QUESTION');
    await p1.state('QUESTION');
    await p3.state('QUESTION');
    await p2.state('QUESTION');

    // kick Bob
    mod.send({ t: 'kick', playerId: j2.ok && j2.playerId });
    await p2.next((m) => m.t === 'kicked');
    assert.equal(await p2.closed(), 4403);
    assert.equal(repo.players.get(j2.ok ? j2.playerId : '')!.kicked, true);
    await mod.next((m) => m.t === 'lobby' && m.playerCount === 2);
    const p2again = await connect(port, `role=player&code=${code}&token=${j2.ok && j2.token}`);
    assert.equal(await p2again.closed(), 4403);

    // p3 reconnects with same token, keeps score
    const scoreBefore = r3.me.score;
    p3.close();
    await p3.closed();
    p3 = await connect(port, `role=player&code=${code}&token=${j3.ok && j3.token}`);
    clients.push(p3);
    const re = await p3.state('QUESTION');
    assert.equal(re.me.score, scoreBefore);
    assert.equal(re.question.qIndex, 1);
    assert.equal(re.myAnswer, null);

    p1.send({ t: 'answer', qIndex: 1, choice: 2 });
    await p1.next((m) => m.t === 'ack');
    p3.send({ t: 'answer', qIndex: 1, choice: 2 });
    await mod.state('CLOSED'); // kicked Bob doesn't block auto-close
    mod.send({ t: 'mod', action: 'next', expectQ: 1 });
    await mod.error('bad_transition');
    mod.send({ t: 'mod', action: 'reveal', expectQ: 1 });
    await mod.state('REVEAL');
    // skip leaderboard: REVEAL → next
    mod.send({ t: 'mod', action: 'next', expectQ: 1 });
    const q3mod = await mod.state('QUESTION');
    assert.equal(q3mod.qIndex, 2);
    assert.equal(q3mod.nextQuestion, null);

    // ── Q3 (1s limit, correct = 0): only p1 answers; timer closes it
    await p1.state('QUESTION');
    await p3.state('QUESTION');
    p1.send({ t: 'answer', qIndex: 2, choice: 0 });
    await p1.next((m) => m.t === 'ack');
    await p3.state('CLOSED');
    p3.send({ t: 'answer', qIndex: 2, choice: 0 });
    await p3.error('too_late');
    mod.send({ t: 'mod', action: 'reveal', expectQ: 2 });
    await mod.state('REVEAL');
    mod.send({ t: 'mod', action: 'next', expectQ: 2 });
    const fin = await p1.state('FINISHED');
    assert.equal(fin.me.rank, 1);
    assert.equal(fin.leaderboard.length, 2); // kicked Bob excluded
    assert.equal(fin.question, null);
    const finMod = await mod.state('FINISHED');
    assert.equal(finMod.leaderboard[0].playerId, j1.ok && j1.playerId);

    // persisted
    const row = repo.sessions.get(s.id)!;
    assert.equal(row.state, 'FINISHED');
    assert.ok(row.endedAt);
    repo.flush();
    const p1row = repo.players.get(j1.ok ? j1.playerId : '')!;
    const p1answers = repo.answers.filter((a) => a.playerId === p1row.id);
    assert.equal(p1answers.length, 3);
    assert.equal(p1row.score, p1answers.reduce((n, a) => n + a.points, 0));
    assert.equal(p1row.score, fin.me.score);
    assert.equal(repo.answers.length, 6);

    // public list hides finished
    assert.equal(registry.publicList().length, 0);
    assert.equal(registry.stats().rooms, 0);

    // rate limit
    for (let i = 0; i < 40; i++) p1.send({ t: 'ping' });
    await p1.error('rate_limited');
    assert.equal(await p1.closed(), 4429);
  } finally {
    clients.forEach((c) => c.close());
    await teardown();
  }
});

test('restore turns open QUESTION into CLOSED with scores intact', async () => {
  const repo = new FakeRepo();
  const a = await setup(repo);
  const s = a.registry.createSession({ quiz: makeQuiz(), moderatorId: 'mod1', event: null, label: '', listed: false });
  const j = a.registry.join(s.code, { name: 'Zed' });
  const j2 = a.registry.join(s.code, { name: 'Yan' });
  assert.ok(j.ok && j2.ok);
  const room = a.registry.get(s.code)!;
  assert.deepEqual(room.modAction('start', -1), { ok: true });
  const pm = room.players.get(j.playerId)!;
  assert.deepEqual(room.answer(pm, 0, 1), { ok: true });
  const score = pm.score;
  assert.ok(score > 0);
  assert.equal(repo.sessions.get(s.id)!.state, 'QUESTION');
  await a.teardown(); // flushes

  const b = await setup(repo);
  try {
    assert.equal(b.registry.restore(), 1);
    const r = b.registry.get(s.code)!;
    assert.equal(r.state, 'CLOSED');
    assert.equal(r.qIndex, 0);
    assert.equal(repo.sessions.get(s.id)!.state, 'CLOSED');
    const p = r.players.get(j.playerId)!;
    assert.equal(p.score, score);
    assert.ok(p.answers.has(0));
    const snap = r.hostSnapshot('mod');
    assert.equal(snap.answered, 1);
    assert.deepEqual(snap.distribution, [0, 1, 0, 0]);
    // reconnecting player sees CLOSED with its answer
    const c = await connect(b.port, `role=player&code=${s.code}&token=${j.token}`);
    const st = await c.state('CLOSED');
    assert.equal(st.myAnswer.choice, 1);
    assert.equal(r.answer(p, 0, 1).ok, false);
    assert.deepEqual(r.modAction('reveal', 0), { ok: true });
    const rv = await c.state('REVEAL');
    assert.equal(rv.me.score, score);
    assert.equal(rv.me.rank, 1);
    c.close();
  } finally {
    await b.teardown();
  }
});

// ───────────── events ─────────────
import { openRepo } from '../src/db/repo';
import { Registry as RegistryClass } from '../src/game/registry';
import type { EventDef } from '../../shared/model';

function eventQuiz(id: string, eventId: string): QuizDef {
  return {
    id, moderatorId: 'mod1', eventId, title: `Quiz ${id}`, emailMode: 'off', scoring: 'flat',
    questions: [{ id: `${id}_q1`, text: 'Q?', imageUrl: null, options: ['A', 'B'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 }],
    createdAt: 1, updatedAt: 1,
  };
}

test('events: cumulative board across sessions, top-3 for players, rebind by email, kicked email, forced email', async () => {
  const repo = openRepo(':memory:');
  const { registry, port, teardown } = await setup(repo as any);
  const clients: Client[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const ev: EventDef = { id: 'ev1', moderatorId: 'mod1', name: 'CCD Kochi', emailRequired: true, createdAt: 1, updatedAt: 1 };
    repo.saveEvent(ev);
    const qa = eventQuiz('qa', ev.id);
    const qb = eventQuiz('qb', ev.id);
    repo.saveQuiz(qa);
    repo.saveQuiz(qb);
    const s1 = registry.createSession({ quiz: qa, event: ev, moderatorId: 'mod1', label: 'Hall A', listed: true });
    const s2 = registry.createSession({ quiz: qb, event: ev, moderatorId: 'mod1', label: 'Hall B', listed: true });
    assert.equal(s1.eventId, 'ev1');
    assert.equal(s1.eventName, 'CCD Kochi');
    assert.equal(registry.publicList().find((p) => p.code === s1.code)!.eventName, 'CCD Kochi');
    assert.deepEqual(registry.liveCountByEvent().get('ev1'), 2);

    // event.emailRequired forces email even though quiz.emailMode is 'off'
    const info = registry.playInfo(s1.code)!;
    assert.equal(info.emailMode, 'required');
    assert.equal(info.eventName, 'CCD Kochi');
    assert.deepEqual(registry.join(s1.code, { name: 'NoMail' }), { ok: false, error: 'email_required' });

    const join = (code: string, name: string, email: string) => {
      const r = registry.join(code, { name, email });
      assert.ok(r.ok, JSON.stringify(r));
      return r as Extract<typeof r, { ok: true }>;
    };
    const alice = join(s1.code, 'Alice', 'alice@x.test');
    const bob = join(s1.code, 'Bob', 'bob@x.test');
    const carol = join(s1.code, 'Carol', 'carol@x.test');
    const frank = join(s1.code, 'Frank', 'frank@x.test');
    const dave = join(s1.code, 'Dave', 'dave@x.test');
    assert.equal(alice.rejoined, false);
    const room1 = registry.get(s1.code)!;
    assert.equal(room1.activeCount(), 5);

    // rebind by email (case-insensitive): same player, fresh token, no duplicate
    const again = join(s1.code, 'Someone else', '  ALICE@x.test ');
    assert.equal(again.rejoined, true);
    assert.equal(again.playerId, alice.playerId);
    assert.equal(again.name, 'Alice');
    assert.notEqual(again.token, alice.token);
    assert.equal(room1.activeCount(), 5);
    assert.equal(repo.listPlayers(s1.id).length, 5);
    // rebind works even when joining is closed
    registry.patch(s1.code, { joinOpen: false });
    assert.equal(join(s1.code, 'Bob', 'bob@x.test').rejoined, true);
    assert.deepEqual(registry.join(s1.code, { name: 'New', email: 'new@x.test' }), { ok: false, error: 'join_closed' });
    registry.patch(s1.code, { joinOpen: true });

    // kicked email stays kicked
    assert.deepEqual(room1.kick(dave.playerId), { ok: true });
    assert.deepEqual(registry.join(s1.code, { name: 'Dave', email: 'dave@x.test' }), { ok: false, error: 'kicked' });

    // sockets: the rebound token works
    const pa = await connect(port, `role=player&code=${s1.code}&token=${again.token}`);
    const pb = await connect(port, `role=player&code=${s1.code}&token=${bob.token}`);
    const pres1 = await connect(port, `role=present&code=${s1.code}`);
    const mod1 = await connect(port, `role=mod&code=${s1.code}`, 'c9_session=mod1');
    clients.push(pa, pb, pres1, mod1);
    const lobby = await pa.state('LOBBY');
    assert.equal(lobby.eventName, 'CCD Kochi');
    assert.equal(lobby.eventBoard, null);
    assert.equal(lobby.me.id, alice.playerId);

    // s1: alice, bob, frank correct; carol wrong
    assert.deepEqual(room1.modAction('start', -1), { ok: true });
    const pm = (id: string) => room1.players.get(id)!;
    // (unconnected players first: auto-close fires once every CONNECTED player answered)
    assert.ok(room1.answer(pm(frank.playerId), 0, 0).ok);
    assert.ok(room1.answer(pm(carol.playerId), 0, 1).ok);
    assert.ok(room1.answer(pm(alice.playerId), 0, 0).ok);
    assert.ok(room1.answer(pm(bob.playerId), 0, 0).ok);
    // persisted immediately (not deferred): the event board already counts it
    assert.equal(repo.eventLeaderboard('ev1').find((e) => e.key === 'alice@x.test')!.score, 1000);
    if (room1.state === 'QUESTION') room1.modAction('close', 0);
    assert.deepEqual(room1.modAction('reveal', 0), { ok: true });
    assert.deepEqual(room1.modAction('leaderboard', 0), { ok: true });
    const lbA = await pa.state('LEADERBOARD');
    assert.equal(lbA.leaderboard.length, 3); // top 3 only for players
    assert.equal(lbA.eventBoard.eventName, 'CCD Kochi');
    assert.equal(lbA.eventBoard.top.length, 3);
    assert.equal(lbA.eventBoard.total, 4); // alice, bob, frank, carol (dave kicked)
    assert.equal(lbA.eventBoard.me.score, 1000);
    const lbMod = await mod1.state('LEADERBOARD');
    assert.equal(lbMod.leaderboard.length, 4);
    assert.equal(lbMod.eventBoard.top.length, 4);
    assert.equal(lbMod.eventName, 'CCD Kochi');
    await pres1.state('LEADERBOARD');
    assert.deepEqual(room1.modAction('next', 0), { ok: true });
    await pa.state('FINISHED');
    await pres1.state('FINISHED');

    // s2: alice (again) + eve
    const alice2 = join(s2.code, 'Ali', 'Alice@X.test');
    assert.equal(alice2.rejoined, false);
    const eve = join(s2.code, 'Eve', 'eve@x.test');
    const room2 = registry.get(s2.code)!;
    const qa2 = await connect(port, `role=player&code=${s2.code}&token=${alice2.token}`);
    const qe = await connect(port, `role=player&code=${s2.code}&token=${eve.token}`);
    const pres2 = await connect(port, `role=present&code=${s2.code}`);
    clients.push(qa2, qe, pres2);
    await qa2.state('LOBBY');
    await pres2.state('LOBBY');
    await sleep(5);
    room2.modAction('start', -1);
    assert.ok(room2.answer(room2.players.get(eve.playerId)!, 0, 1).ok);
    assert.ok(room2.answer(room2.players.get(alice2.playerId)!, 0, 0).ok);
    if (room2.state === 'QUESTION') room2.modAction('close', 0);
    room2.modAction('reveal', 0);
    room2.modAction('leaderboard', 0);
    const lb2 = await qa2.state('LEADERBOARD');
    assert.deepEqual(lb2.eventBoard.me, { rank: 1, score: 2000 });
    assert.equal(lb2.eventBoard.total, 5);
    assert.equal(lb2.eventBoard.top[0].name, 'Ali'); // most recent join's name
    assert.equal(lb2.eventBoard.top[0].score, 2000);
    const lbe = await qe.state('LEADERBOARD');
    assert.equal(lbe.eventBoard.me.rank, 4); // 0 points, tied with carol (competition ranking)
    const p2 = await pres2.state('LEADERBOARD');
    assert.equal(p2.eventBoard.top.length, 5);
    assert.equal(p2.eventBoard.total, 5);

    const board = repo.eventLeaderboard('ev1');
    assert.deepEqual(board.map((e) => [e.key, e.score, e.quizzesPlayed, e.rank]), [
      ['alice@x.test', 2000, 2, 1], ['bob@x.test', 1000, 1, 2], ['frank@x.test', 1000, 1, 2], ['carol@x.test', 0, 1, 4], ['eve@x.test', 0, 1, 4],
    ]);

    // emails never reach players or the projector
    for (const c of [pa, pb, pres1, qa2, qe, pres2]) {
      for (const m of c.msgs) assert.ok(!JSON.stringify(m).includes('@'), `email leaked: ${JSON.stringify(m)}`);
    }
    for (const m of mod1.msgs) assert.ok(!JSON.stringify(m).includes('@x.test'), 'host payload must not carry emails');

    // restore: a fresh registry picks up event name + forced email for unfinished sessions
    const s3 = registry.createSession({ quiz: qa, event: ev, moderatorId: 'mod1', label: 'Hall C', listed: true });
    const fresh = new RegistryClass(repo, config);
    try {
      fresh.restore();
      const info3 = fresh.playInfo(s3.code)!;
      assert.equal(info3.eventName, 'CCD Kochi');
      assert.equal(info3.emailMode, 'required');
      assert.equal(fresh.summary(s3.code)!.eventId, 'ev1');
      // rebind-by-email works after restore too
      const room2r = fresh.get(s2.code)!;
      assert.ok(room2r);
      const rj = fresh.join(s2.code, { name: 'x', email: 'eve@x.test' });
      assert.ok(rj.ok && rj.rejoined && rj.playerId === eve.playerId);
      assert.equal(repo.listPlayers(s2.id).find((p) => p.id === eve.playerId)!.tokenHash, sha(rj.ok ? rj.token : ''));
    } finally {
      fresh.shutdown();
    }
  } finally {
    clients.forEach((c) => c.close());
    await teardown();
    repo.close();
  }
});

test('ties: competition ranking (1,2,2,4) for quiz leaderboard and me.rank; join order only orders rows', async () => {
  const { registry, teardown } = await setup();
  try {
    const s = registry.createSession({ quiz: makeQuiz(), moderatorId: 'mod1', event: null, label: '', listed: false });
    const room = registry.get(s.code)!;
    const ids = ['A', 'B', 'C', 'D', 'E'].map((n) => { const r = registry.join(s.code, { name: n }); assert.ok(r.ok); return r.ok ? r.playerId : ''; });
    const [a, b, c, d, e] = ids.map((id) => room.players.get(id)!);
    // lobby: no ranks
    assert.equal(room.playerSnapshot(a).me.rank, null);
    room.modAction('start', -1);
    const t0 = room.qStartedAt!;
    assert.ok(room.answer(a, 0, 1, t0 + 1000).ok);  // fastest correct
    assert.ok(room.answer(b, 0, 1, t0 + 3000).ok);  // B and C: same score, same time → shared rank
    assert.ok(room.answer(c, 0, 1, t0 + 3000).ok);
    assert.ok(room.answer(d, 0, 0, t0 + 2000).ok);  // wrong → 0
    // E does not answer → 0 (same tie-break time 0 as D)
    if (room.state === 'QUESTION') room.modAction('close', 0);
    room.modAction('reveal', 0);
    room.modAction('leaderboard', 0);
    const lb = room.hostSnapshot('mod').leaderboard;
    assert.deepEqual(lb.map((x) => [x.name, x.rank]), [['A', 1], ['B', 2], ['C', 2], ['D', 4], ['E', 4]]);
    assert.deepEqual([a, b, c, d, e].map((p) => room.playerSnapshot(p).me.rank), [1, 2, 2, 4, 4]);
    // second question: B and C stay tied (identical score and time); A drops behind them
    room.modAction('next', 0);
    const t1 = room.qStartedAt!;
    assert.ok(room.answer(b, 1, 2, t1 + 500).ok);
    assert.ok(room.answer(c, 1, 2, t1 + 500).ok);
    if (room.state === 'QUESTION') room.modAction('close', 1);
    room.modAction('reveal', 1);
    const lb2 = room.hostSnapshot('mod').leaderboard;
    const ranks = new Map(lb2.map((x) => [x.name, x.rank]));
    assert.equal(ranks.get('B'), ranks.get('C')); // still identical score + time
    assert.equal(ranks.get('D'), 4);
    assert.equal(ranks.get('E'), 4);
    // flat scoring: equal score but different tie-break time → different ranks (faster first)
    const s3 = registry.createSession({ quiz: { ...makeQuiz(), scoring: 'flat' }, moderatorId: 'mod1', event: null, label: '', listed: false });
    const r3 = registry.get(s3.code)!;
    const [f1, f2, f3] = ['F1', 'F2', 'F3'].map((n) => { const r = registry.join(s3.code, { name: n }); return r3.players.get(r.ok ? r.playerId : '')!; });
    r3.modAction('start', -1);
    const t3 = r3.qStartedAt!;
    assert.ok(r3.answer(f2, 0, 1, t3 + 4000).ok);
    assert.ok(r3.answer(f1, 0, 1, t3 + 2000).ok);
    assert.ok(r3.answer(f3, 0, 1, t3 + 4000).ok);
    r3.modAction('end', 0);
    assert.deepEqual(r3.hostSnapshot('mod').leaderboard.map((x) => [x.name, x.score, x.rank]), [['F1', 1000, 1], ['F2', 1000, 2], ['F3', 1000, 2]]);
    // all-zero room: everyone shares rank 1
    const s2 = registry.createSession({ quiz: makeQuiz(), moderatorId: 'mod1', event: null, label: '', listed: false });
    const r2 = registry.get(s2.code)!;
    ['X', 'Y', 'Z'].forEach((n) => registry.join(s2.code, { name: n }));
    r2.modAction('end', -1);
    assert.deepEqual(r2.hostSnapshot('mod').leaderboard.map((x) => x.rank), [1, 1, 1]);
  } finally {
    await teardown();
  }
});

test('events: no event → eventName/eventBoard null; quiz emailMode honoured', async () => {
  const { registry, teardown } = await setup();
  try {
    const s = registry.createSession({ quiz: makeQuiz(), moderatorId: 'mod1', event: null, label: '', listed: true });
    assert.equal(registry.playInfo(s.code)!.emailMode, 'optional');
    assert.equal(registry.playInfo(s.code)!.eventName, null);
    const j = registry.join(s.code, { name: 'A' });
    assert.ok(j.ok && !j.rejoined);
    const room = registry.get(s.code)!;
    room.modAction('end', -1);
    const snap = room.playerSnapshot(room.players.get(j.ok ? j.playerId : '')!);
    assert.equal(snap.eventBoard, null);
    assert.equal(snap.eventName, null);
    assert.equal(room.hostSnapshot('mod').eventBoard, null);
    assert.equal(registry.liveCountByEvent().size, 0);
  } finally {
    await teardown();
  }
});

import { createHash as _createHash } from 'node:crypto';
function sha(s: string) { return _createHash('sha256').update(s).digest('hex'); }
