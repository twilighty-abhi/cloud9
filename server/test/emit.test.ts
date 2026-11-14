// Notify-bus emit points (game + http). Run: npx tsx --test server/test/emit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { bus } from '../src/notify/bus';
import type { NotifyEvent } from '../src/notify/contracts';
import { openRepo } from '../src/db/repo';
import { createAuth } from '../src/auth/index';
import { registerRoutes } from '../src/http/index';
import { createGame } from '../src/game/index';
import type { Registry } from '../src/game/registry';
import type { AuthService } from '../src/contracts';
import type { Config } from '../src/config';
import type { QuizDef, EventDef } from '../../shared/model';
import { FakeRegistry } from './fakeRegistry';
import { FakeRepo } from './fakeRepo';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://test.local', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [
    { id: 'mod_alice', username: 'alice', password: 'pw-alice', displayName: 'Alice A', isSuper: false },
    { id: 'mod_root', username: 'root', password: 'pw-root', displayName: 'root', isSuper: true },
  ],
  maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false, telegram: null,
};

/** Narrow NotifyEvent by type (works for members whose `type` is a union of literals). */
type EventOf<T extends NotifyEvent['type'], E = NotifyEvent> = E extends { type: infer U } ? (T extends U ? E & { type: T } : never) : never;

/** Collect bus events; flush() waits for the bus microtasks. */
function collect() {
  const events: NotifyEvent[] = [];
  const off = bus.on((e) => events.push(e));
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const of = <T extends NotifyEvent['type']>(t: T) => events.filter((e) => e.type === t) as EventOf<T>[];
  return { events, off, flush, of };
}

function assertNoEmails(events: NotifyEvent[]) {
  for (const e of events) assert.ok(!JSON.stringify(e).includes('@'), `event ${e.type} contains '@': ${JSON.stringify(e)}`);
}

// ───────────────────────────── HTTP ─────────────────────────────

test('http: event/quiz/session events with actor, owner, questionCount and changes diff', async () => {
  const repo = openRepo(':memory:');
  const auth = createAuth(config, repo);
  const registry = new FakeRegistry(repo, config.publicUrl);
  const app = Fastify();
  await registerRoutes(app, { repo, registry, auth, config });
  await app.ready();
  const c = collect();
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw-alice' } });
    assert.equal(login.statusCode, 200);
    const cookie = `c9_session=${login.cookies.find((x) => x.name === 'c9_session')!.value}`;
    const req = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });

    // events
    const ev = (await req('POST', '/api/events', { name: 'DevFest', emailRequired: true })).json();
    assert.equal((await req('PUT', `/api/events/${ev.id}`, { name: 'DevFest 26', emailRequired: false })).statusCode, 200);
    const ev2 = (await req('POST', '/api/events', { name: 'Tmp' })).json();
    assert.equal((await req('DELETE', `/api/events/${ev2.id}`)).statusCode, 200);

    // quizzes
    const quizBody = {
      eventId: ev.id, title: 'Cloud Basics', emailMode: 'optional', scoring: 'speed',
      questions: [{ text: 'Q1', options: ['a', 'b'], correctIndex: 0 }, { text: 'Q2', options: ['a', 'b'], correctIndex: 1 }],
    };
    const quiz = (await req('POST', '/api/quizzes', quizBody)).json();
    assert.equal((await req('PUT', `/api/quizzes/${quiz.id}`, { ...quizBody, title: 'Cloud Basics 2', questions: quizBody.questions.slice(0, 1) })).statusCode, 200);
    const imp = await req('POST', '/api/quizzes/import', {
      title: 'Imported', format: 'csv',
      content: 'question,option_a,option_b,option_c,option_d,correct,time_sec,image_url\nWhat?,x,y,,,A,20,\nWho?,x,y,z,,C,20,\nWhy?,x,y,,,B,,\n',
    });
    assert.equal(imp.statusCode, 201, imp.body);
    const tmpQuiz = (await req('POST', '/api/quizzes', { ...quizBody, eventId: null, title: 'Doomed' })).json();
    assert.equal((await req('DELETE', `/api/quizzes/${tmpQuiz.id}`)).statusCode, 200);

    // sessions
    const ses = await req('POST', '/api/sessions', { quizId: quiz.id, label: 'Hall 1' });
    assert.equal(ses.statusCode, 201);
    const code = ses.json().code;
    assert.equal((await req('PATCH', `/api/sessions/${code}`, { label: 'Hall 1', listed: false })).statusCode, 200); // only listed changed
    assert.equal((await req('PATCH', `/api/sessions/${code}`, { label: '  Main hall ' })).statusCode, 200);         // label changed
    assert.equal((await req('PATCH', `/api/sessions/${code}`, { label: 'Main hall', listed: false })).statusCode, 200); // nothing changed
    assert.equal((await req('PATCH', `/api/sessions/${code}`, {})).statusCode, 200);                                  // nothing
    // failures emit nothing
    assert.equal((await req('PATCH', `/api/sessions/999999`, { listed: true })).statusCode, 404);
    assert.equal((await req('POST', '/api/events', { name: '' })).statusCode, 400);

    await c.flush();
    for (const e of c.events) {
      assert.equal(e.actor, 'alice');
      assert.equal(typeof e.at, 'number');
    }

    assert.deepEqual(c.of('event.created').map((e) => e.event), [
      { id: ev.id, name: 'DevFest', emailRequired: true },
      { id: ev2.id, name: 'Tmp', emailRequired: true },
    ]);
    assert.deepEqual(c.of('event.updated').map((e) => e.event), [{ id: ev.id, name: 'DevFest 26', emailRequired: false }]);
    assert.deepEqual(c.of('event.deleted').map((e) => e.event), [{ id: ev2.id, name: 'Tmp', emailRequired: true }]);

    const qc = c.of('quiz.created').map((e) => e.quiz);
    assert.deepEqual(qc, [
      { id: quiz.id, title: 'Cloud Basics', eventId: ev.id, questionCount: 2, owner: 'alice' },
      { id: imp.json().id, title: 'Imported', eventId: null, questionCount: 3, owner: 'alice' },
      { id: tmpQuiz.id, title: 'Doomed', eventId: null, questionCount: 2, owner: 'alice' },
    ]);
    assert.deepEqual(c.of('quiz.updated').map((e) => e.quiz), [{ id: quiz.id, title: 'Cloud Basics 2', eventId: ev.id, questionCount: 1, owner: 'alice' }]);
    assert.deepEqual(c.of('quiz.deleted').map((e) => e.quiz), [{ id: tmpQuiz.id, title: 'Doomed', eventId: null, questionCount: 2, owner: 'alice' }]);

    const sc = c.of('session.created');
    assert.equal(sc.length, 1);
    assert.equal(sc[0].session.code, code);
    assert.equal(sc[0].session.label, 'Hall 1');

    const su = c.of('session.updated');
    assert.deepEqual(su.map((e) => e.changes), [{ listed: false }, { label: 'Main hall' }]);
    assert.equal(su[1].session.label, 'Main hall');
    assert.equal(su[1].session.listed, false);

    assert.equal(c.events.length, 2 + 1 + 1 + 3 + 1 + 1 + 1 + 2);
    assertNoEmails(c.events);
  } finally {
    c.off();
    await app.close();
    repo.close();
  }
});

test('http: quiz owner is the quiz owner username when a super moderator edits it', async () => {
  const repo = openRepo(':memory:');
  const auth = createAuth(config, repo);
  const app = Fastify();
  await registerRoutes(app, { repo, registry: new FakeRegistry(repo, config.publicUrl), auth, config });
  await app.ready();
  const c = collect();
  try {
    const cookieOf = async (u: string, p: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p }, remoteAddress: `10.1.0.${u.length}` });
      return `c9_session=${r.cookies.find((x) => x.name === 'c9_session')!.value}`;
    };
    const alice = await cookieOf('alice', 'pw-alice');
    const root = await cookieOf('root', 'pw-root');
    const body = { title: 'A', emailMode: 'off', scoring: 'flat', questions: [{ text: 'Q', options: ['a', 'b'], correctIndex: 0 }] };
    const q = (await app.inject({ method: 'POST', url: '/api/quizzes', payload: body, headers: { cookie: alice } })).json();
    assert.equal((await app.inject({ method: 'PUT', url: `/api/quizzes/${q.id}`, payload: { ...body, title: 'B' }, headers: { cookie: root } })).statusCode, 200);
    await c.flush();
    const up = c.of('quiz.updated');
    assert.equal(up.length, 1);
    assert.equal(up[0].actor, 'root');
    assert.equal(up[0].quiz.owner, 'alice');
  } finally {
    c.off();
    await app.close();
    repo.close();
  }
});

// ───────────────────────────── game ─────────────────────────────

const gameConfig: Config = { ...config, publicUrl: 'http://quiz.test', moderators: [] };

function makeQuiz(id: string, eventId: string | null, n = 3): QuizDef {
  return {
    id, moderatorId: 'hall1', eventId, title: `Quiz ${id}`, emailMode: 'optional', scoring: 'flat', createdAt: 1, updatedAt: 1,
    questions: Array.from({ length: n }, (_, i) => ({
      id: `${id}_q${i}`, text: `Q${i}`, imageUrl: null, options: ['A', 'B', 'C', 'D'], correctIndex: i % 4, timeLimitSec: 20, pointsMax: 1000,
    })),
  };
}

test('game: started / question.closed / player.kicked / finished (event session, natural end)', async () => {
  const repo = new FakeRepo();
  const event: EventDef = { id: 'ev1', moderatorId: 'hall1', name: 'DevFest', emailRequired: true, createdAt: 1, updatedAt: 1 };
  repo.saveEvent(event);
  const game = createGame({ repo, config: gameConfig });
  const registry = game.registry as Registry;
  const c = collect();
  try {
    // a finished earlier session of the same event, so the event board differs from the quiz board
    const prev = registry.createSession({ quiz: makeQuiz('qa', 'ev1', 1), event, moderatorId: 'hall1', label: '', listed: true });
    const old = registry.join(prev.code, { name: 'Veteran', email: 'vet@x.test' });
    assert.ok(old.ok);
    const prevRoom = registry.get(prev.code)!;
    assert.ok(prevRoom.modAction('start', -1, 'hall1').ok);
    prevRoom.answer(prevRoom.players.get(old.playerId)!, 0, 0);
    assert.ok(prevRoom.modAction('close', 0, 'hall1').ok);
    assert.ok(prevRoom.modAction('reveal', 0, 'hall1').ok);
    assert.ok(prevRoom.modAction('next', 0, 'hall1').ok);
    await new Promise((r) => setTimeout(r, 5)); // Veteran joined strictly earlier (event tie-break)
    await c.flush();
    c.events.length = 0;

    const quiz = makeQuiz('qb', 'ev1', 2);
    const s = registry.createSession({ quiz, event, moderatorId: 'hall1', label: 'Hall 1', listed: true });
    const room = registry.get(s.code)!;
    const ids: Record<string, string> = {};
    for (const [name, email] of [['Anu', 'anu@x.test'], ['Bala', 'bala@x.test'], ['Chitra', 'chitra@x.test'], ['Dev', 'dev@x.test']]) {
      const r = registry.join(s.code, { name, email });
      assert.ok(r.ok);
      ids[name] = r.playerId;
    }
    const P = (n: string) => room.players.get(ids[n])!;

    assert.ok(room.kick(ids.Dev, 'hall1').ok);
    assert.ok(room.kick(ids.Dev, 'hall1').ok); // already kicked → no second event
    assert.ok(room.modAction('start', -1, 'hall1').ok);
    // q0 correct = 0: Anu + Bala correct, Chitra wrong
    assert.ok(room.answer(P('Anu'), 0, 0).ok);
    assert.ok(room.answer(P('Bala'), 0, 0).ok);
    assert.ok(room.answer(P('Chitra'), 0, 2).ok);
    assert.ok(room.modAction('close', 0, 'hall1').ok);
    assert.ok(room.modAction('reveal', 0, 'hall1').ok);
    assert.ok(room.modAction('leaderboard', 0, 'hall1').ok);
    assert.ok(room.modAction('next', 0, 'hall1').ok);
    // q1 correct = 1: only Anu answers (correct)
    assert.ok(room.answer(P('Anu'), 1, 1).ok);
    assert.ok(room.modAction('close', 1, null).ok);
    assert.ok(room.modAction('reveal', 1, null).ok);
    assert.ok(room.modAction('next', 1, 'hall1').ok); // past last question → FINISHED
    await c.flush();

    const types = c.events.map((e) => e.type);
    assert.deepEqual(types, ['player.kicked', 'session.started', 'question.closed', 'question.closed', 'session.finished']);

    const [kicked] = c.of('player.kicked');
    assert.equal(kicked.actor, 'hall1');
    assert.equal(kicked.playerName, 'Dev');
    assert.equal(kicked.session.code, s.code);

    const [started] = c.of('session.started');
    assert.equal(started.actor, 'hall1');
    assert.equal(started.session.state, 'QUESTION');
    assert.equal(started.session.qIndex, 0);
    assert.equal(started.session.players, 3);

    const closed = c.of('question.closed');
    assert.deepEqual(closed.map((e) => ({ actor: e.actor, qIndex: e.qIndex, answered: e.answered, playerCount: e.playerCount, correct: e.correct })), [
      { actor: 'hall1', qIndex: 0, answered: 3, playerCount: 3, correct: 2 },
      { actor: null, qIndex: 1, answered: 1, playerCount: 3, correct: 1 },
    ]);
    assert.equal(closed[0].session.state, 'CLOSED');

    const [fin] = c.of('session.finished');
    assert.equal(fin.actor, 'hall1');
    assert.equal(fin.endedEarly, false);
    assert.equal(fin.session.state, 'FINISHED');
    assert.ok(fin.session.endedAt);
    assert.deepEqual(fin.leaderboard, [
      { name: 'Anu', score: 2000, rank: 1 },
      { name: 'Bala', score: 1000, rank: 2 },
      { name: 'Chitra', score: 0, rank: 3 },
    ]);
    assert.ok(fin.eventBoard);
    assert.equal(fin.eventBoard!.eventName, 'DevFest');
    assert.equal(fin.eventBoard!.total, 4); // Veteran + 3 non-kicked
    assert.deepEqual(fin.eventBoard!.top, [
      { name: 'Anu', score: 2000, rank: 1 },
      { name: 'Veteran', score: 1000, rank: 2 },
      { name: 'Bala', score: 1000, rank: 2 }, // tied with Veteran → shared rank
      { name: 'Chitra', score: 0, rank: 4 },
    ]);
    assertNoEmails(c.events);
  } finally {
    c.off();
    game.shutdown();
  }
});

test('game: mod end before last question → endedEarly, no event → eventBoard null; leaderboard capped at 10', async () => {
  const repo = new FakeRepo();
  const game = createGame({ repo, config: gameConfig });
  const registry = game.registry as Registry;
  const c = collect();
  try {
    const s = registry.createSession({ quiz: makeQuiz('qc', null, 3), event: null, moderatorId: 'hall1', label: '', listed: false });
    const room = registry.get(s.code)!;
    const pids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = registry.join(s.code, { name: `P${i}` });
      assert.ok(r.ok);
      pids.push(r.playerId);
    }
    assert.ok(room.modAction('start', -1, 'root').ok);
    for (let i = 0; i < 5; i++) assert.ok(room.answer(room.players.get(pids[i])!, 0, 0).ok);
    // ends while q0 is still open: the open question is not "closed" (QUESTION → FINISHED)
    assert.ok(room.modAction('end', 0, 'root').ok);
    await c.flush();

    assert.deepEqual(c.events.map((e) => e.type), ['session.started', 'session.finished']);
    const [fin] = c.of('session.finished');
    assert.equal(fin.actor, 'root');
    assert.equal(fin.endedEarly, true);
    assert.equal(fin.eventBoard, null);
    assert.equal(fin.leaderboard.length, 10);
    // all points included even though the last question was never revealed
    assert.deepEqual(fin.leaderboard.slice(0, 5).map((e) => e.score), [1000, 1000, 1000, 1000, 1000]);
    // competition ranking: a row either shares the previous row's rank (equal score) or takes its position
    assert.equal(fin.leaderboard[0].rank, 1);
    for (let i = 1; i < fin.leaderboard.length; i++) {
      const [prev, cur] = [fin.leaderboard[i - 1], fin.leaderboard[i]];
      if (cur.score !== prev.score) assert.equal(cur.rank, i + 1);
      else assert.ok(cur.rank === prev.rank || cur.rank === i + 1);
    }
    // the 7 players who did not answer are all tied (0 points, no time) → rank 6
    assert.deepEqual(fin.leaderboard.slice(5).map((e) => e.rank), [6, 6, 6, 6, 6]);
    for (let i = 1; i < fin.leaderboard.length; i++) assert.ok(fin.leaderboard[i - 1].score >= fin.leaderboard[i].score);

    // 'end' at the last question is not early
    c.events.length = 0;
    const s2 = registry.createSession({ quiz: makeQuiz('qd', null, 2), event: null, moderatorId: 'hall1', label: '', listed: false });
    const r2 = registry.get(s2.code)!;
    assert.ok(r2.modAction('start', -1, 'hall1').ok);
    assert.ok(r2.modAction('close', 0, 'hall1').ok);
    assert.ok(r2.modAction('reveal', 0, 'hall1').ok);
    assert.ok(r2.modAction('next', 0, 'hall1').ok);
    assert.ok(r2.modAction('close', 1, 'hall1').ok);
    assert.ok(r2.modAction('end', 1, 'hall1').ok);
    await c.flush();
    const fin2 = c.of('session.finished');
    assert.equal(fin2.length, 1);
    assert.equal(fin2[0].endedEarly, false);
    assert.equal(fin2[0].leaderboard.length, 0);
    assert.equal(c.of('session.started').length, 1);
    assert.equal(c.of('question.closed').length, 2);

    // failed actions emit nothing
    c.events.length = 0;
    assert.equal(r2.modAction('end', 1, 'hall1').ok, false);
    assert.equal(room.modAction('start', 0, 'root').ok, false);
    await c.flush();
    assert.equal(c.events.length, 0);
  } finally {
    c.off();
    game.shutdown();
  }
});

test('game: timer auto-close emits question.closed with actor null', async () => {
  const repo = new FakeRepo();
  const game = createGame({ repo, config: gameConfig });
  const registry = game.registry as Registry;
  const c = collect();
  try {
    const quiz = makeQuiz('qe', null, 1);
    quiz.questions[0].timeLimitSec = 0.05 as number; // short timer for the test
    const s = registry.createSession({ quiz, event: null, moderatorId: 'hall1', label: '', listed: false });
    const room = registry.get(s.code)!;
    assert.ok(registry.join(s.code, { name: 'Solo' }).ok);
    assert.ok(room.modAction('start', -1).ok); // no actor given → null (compat)
    await new Promise((r) => setTimeout(r, 600));
    await c.flush();
    assert.equal(room.state, 'CLOSED');
    const [started] = c.of('session.started');
    assert.equal(started.actor, null);
    const closed = c.of('question.closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].actor, null);
    assert.deepEqual([closed[0].answered, closed[0].playerCount, closed[0].correct], [0, 1, 0]);
  } finally {
    c.off();
    game.shutdown();
  }
});

test('ws: moderator username from the WS auth is the actor for start / kick', async () => {
  const fakeAuth: AuthService = {
    verifyLogin: () => null, issueCookieValue: () => '', moderatorFromRequest: () => null, getModerator: () => null,
    moderatorFromCookieHeader(h) {
      const m = /c9_session=([a-z0-9]+)/.exec(h ?? '');
      return m ? { id: m[1], username: m[1], displayName: m[1], isSuper: m[1] === 'root' } : null;
    },
  };
  const repo = new FakeRepo();
  const game = createGame({ repo, config: gameConfig });
  const registry = game.registry as Registry;
  const server = http.createServer((_q, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  game.attach(server, fakeAuth);
  const port = (server.address() as AddressInfo).port;
  const c = collect();
  let ws: WebSocket | null = null;
  try {
    const s = registry.createSession({ quiz: makeQuiz('qf', null, 2), event: null, moderatorId: 'hall1', label: '', listed: false });
    const j = registry.join(s.code, { name: 'Kickme' });
    assert.ok(j.ok);
    assert.ok(registry.join(s.code, { name: 'Stay' }).ok);
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=mod&code=${s.code}`, { headers: { cookie: 'c9_session=root' } });
    await new Promise<void>((res, rej) => { ws!.once('open', () => res()); ws!.once('error', rej); });
    ws.send(JSON.stringify({ t: 'kick', playerId: j.playerId }));
    ws.send(JSON.stringify({ t: 'mod', action: 'start', expectQ: -1 }));
    const deadline = Date.now() + 3000;
    while (c.of('session.started').length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await c.flush();
    const [k] = c.of('player.kicked');
    assert.equal(k.actor, 'root');
    assert.equal(k.playerName, 'Kickme');
    const [st] = c.of('session.started');
    assert.equal(st.actor, 'root');
    assert.equal(st.session.players, 1);
  } finally {
    c.off();
    ws?.close();
    game.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
