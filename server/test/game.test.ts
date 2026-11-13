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
  moderators: [], maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false,
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
    id: 'quiz1', moderatorId: 'mod1', title: 'Test Quiz', emailMode: 'optional', scoring: 'speed',
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
    const s = registry.createSession({ quiz, moderatorId: 'mod1', label: '  Hall   A ', listed: true });
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
    const s = registry.createSession({ quiz: makeQuiz(1), moderatorId: 'mod1', label: 'Room', listed: true });
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
  const s = a.registry.createSession({ quiz: makeQuiz(), moderatorId: 'mod1', label: '', listed: false });
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
