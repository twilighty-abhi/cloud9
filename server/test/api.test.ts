import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Papa from 'papaparse';
import { openRepo } from '../src/db/repo';
import { createAuth } from '../src/auth/index';
import { registerRoutes } from '../src/http/index';
import type { Config } from '../src/config';
import { FakeRegistry } from './fakeRegistry';

// Production default is 1000/min (venue NAT); pin a small limit so the rate-limit assertions below stay meaningful.
process.env.JOIN_RATE_PER_MIN = '10';

const config: Config = {
  port: 0, host: '127.0.0.1', publicUrl: 'http://test.local', dbPath: ':memory:', sessionSecret: 'x'.repeat(32),
  moderators: [
    { id: 'mod_alice', username: 'alice', password: 'pw-alice', displayName: 'alice', isSuper: false },
    { id: 'mod_bob', username: 'bob', password: 'pw-bob', displayName: 'bob', isSuper: false },
    { id: 'mod_root', username: 'root', password: 'pw:root', displayName: 'root', isSuper: true },
  ],
  maxPlayersPerRoom: 500, webDist: '/nonexistent', secureCookies: false,
};

async function setup() {
  const repo = openRepo(':memory:');
  const auth = createAuth(config, repo);
  const registry = new FakeRegistry(repo, config.publicUrl);
  const app = Fastify({ trustProxy: true, bodyLimit: 2_000_000 });
  await registerRoutes(app, { repo, registry, auth, config });
  await app.ready();
  const cookies: Record<string, string> = {};
  async function login(u: string, p: string) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p }, remoteAddress: `10.0.0.${u.length}` });
    assert.equal(res.statusCode, 200, res.body);
    const c = res.cookies.find((x) => x.name === 'c9_session')!;
    cookies[u] = `c9_session=${c.value}`;
    return res;
  }
  const req = (method: string, url: string, user?: string, payload?: unknown, remoteAddress = '127.0.0.1') =>
    app.inject({ method: method as any, url, payload: payload as any, headers: user ? { cookie: cookies[user] } : {}, remoteAddress });
  const close = async () => { await app.close(); repo.close(); };
  return { app, repo, auth, registry, login, req, cookies, close };
}

const sampleQuiz = (title = 'My Quiz') => ({
  title, emailMode: 'optional', scoring: 'speed',
  questions: [
    { text: 'What is 2+2?', options: ['3', '4', '5'], correctIndex: 1 },
    { text: 'Sky colour?', options: [' Blue ', 'Green'], correctIndex: 0, timeLimitSec: 30, pointsMax: 2000, imageUrl: 'https://img.test/sky.png' },
  ],
});

test('auth: login, me, logout, tamper, bad creds', async () => {
  const t = await setup();
  try {
    assert.equal((await t.req('GET', '/api/me')).statusCode, 401);
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'nope' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error, 'invalid_credentials');
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'x' } })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 5 } })).statusCode, 400);

    const res = await t.login('ALICE', 'pw-alice');
    const c = res.cookies.find((x) => x.name === 'c9_session')!;
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, 'Lax');
    assert.equal(c.path, '/');
    assert.deepEqual(res.json(), { id: 'mod_alice', username: 'alice', displayName: 'alice', isSuper: false });

    const me = await t.req('GET', '/api/me', 'ALICE');
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().id, 'mod_alice');
    assert.equal(t.auth.moderatorFromCookieHeader(`foo=bar; ${t.cookies.ALICE}`)?.id, 'mod_alice');

    // password containing ':' works
    await t.login('root', 'pw:root');

    // tamper: change payload id, keep signature
    const [payload, sig] = c.value.split('.');
    const forged = Buffer.from(JSON.stringify({ id: 'mod_root', exp: Date.now() + 1e9 })).toString('base64url');
    for (const v of [`${forged}.${sig}`, `${payload}.${sig.slice(0, -2)}AA`, `${payload}`, 'garbage', '']) {
      const r = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `c9_session=${v}` } });
      assert.equal(r.statusCode, 401, v);
    }
    assert.equal(t.auth.moderatorFromCookieHeader(undefined), null);

    const out = await t.req('POST', '/api/auth/logout', 'ALICE');
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.json(), { ok: true });
    assert.ok(String(out.headers['set-cookie']).includes('c9_session=;'));
  } finally { await t.close(); }
});

test('auth: login rate limit 5/min/IP', async () => {
  const t = await setup();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'x' }, remoteAddress: '9.9.9.9' });
      codes.push(r.statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
    const other = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'pw-alice' }, remoteAddress: '9.9.9.8' });
    assert.equal(other.statusCode, 200);
  } finally { await t.close(); }
});

test('quizzes: CRUD, validation, ownership', async () => {
  const t = await setup();
  try {
    await t.login('alice', 'pw-alice');
    await t.login('bob', 'pw-bob');
    await t.login('root', 'pw:root');
    assert.equal((await t.req('GET', '/api/quizzes')).statusCode, 401);
    assert.equal((await t.req('POST', '/api/quizzes', undefined, sampleQuiz())).statusCode, 401);

    const created = await t.req('POST', '/api/quizzes', 'alice', sampleQuiz());
    assert.equal(created.statusCode, 201, created.body);
    const q = created.json();
    assert.equal(q.moderatorId, 'mod_alice');
    assert.equal(q.questions.length, 2);
    assert.equal(q.questions[0].timeLimitSec, 20);
    assert.equal(q.questions[0].pointsMax, 1000);
    assert.equal(q.questions[0].imageUrl, null);
    assert.equal(q.questions[1].options[0], 'Blue');
    assert.equal(q.questions[1].pointsMax, 2000);

    const list = await t.req('GET', '/api/quizzes', 'alice');
    assert.deepEqual(list.json().map((x: any) => [x.id, x.questionCount]), [[q.id, 2]]);
    assert.deepEqual((await t.req('GET', '/api/quizzes', 'bob')).json(), []);
    assert.equal((await t.req('GET', '/api/quizzes', 'root')).json().length, 1);

    assert.equal((await t.req('GET', `/api/quizzes/${q.id}`, 'alice')).json().title, 'My Quiz');
    assert.equal((await t.req('GET', `/api/quizzes/${q.id}`, 'bob')).statusCode, 403);
    assert.equal((await t.req('GET', `/api/quizzes/${q.id}`, 'root')).statusCode, 200);
    assert.equal((await t.req('GET', '/api/quizzes/nope', 'alice')).statusCode, 404);

    const upd = await t.req('PUT', `/api/quizzes/${q.id}`, 'alice', { ...sampleQuiz('Renamed'), questions: [sampleQuiz().questions[0]] });
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.json().title, 'Renamed');
    assert.equal(upd.json().questions.length, 1);
    assert.equal(upd.json().createdAt, q.createdAt);
    assert.equal((await t.req('PUT', `/api/quizzes/${q.id}`, 'bob', sampleQuiz())).statusCode, 403);

    // validation errors
    const bads: [unknown, RegExp][] = [
      [{ ...sampleQuiz(), title: '   ' }, /title/],
      [{ ...sampleQuiz(), title: 'x'.repeat(121) }, /title/],
      [{ ...sampleQuiz(), questions: [] }, /at least 1/],
      [{ ...sampleQuiz(), questions: Array(101).fill(sampleQuiz().questions[0]) }, /100/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x'], correctIndex: 0 }] }, /Question 1: needs at least 2/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', 'y', 'z', 'w', 'v'], correctIndex: 0 }] }, /more than 4/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', '  '], correctIndex: 0 }] }, /Question 1, option 2: option is empty/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', 'y'], correctIndex: 2 }] }, /out of range/],
      [{ ...sampleQuiz(), questions: [{ text: '', options: ['x', 'y'], correctIndex: 0 }] }, /text/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', 'y'], correctIndex: 0, imageUrl: 'javascript:alert(1)' }] }, /http/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', 'y'], correctIndex: 0, timeLimitSec: 4 }] }, /time limit/],
      [{ ...sampleQuiz(), questions: [{ text: 'a', options: ['x', 'y'], correctIndex: 0, pointsMax: 99 }] }, /points/],
      [{ ...sampleQuiz(), emailMode: 'sometimes' }, /emailMode/],
    ];
    for (const [body, re] of bads) {
      const r = await t.req('POST', '/api/quizzes', 'alice', body);
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, 'invalid_input');
      assert.match(r.json().message, re);
    }
    // invalid JSON body → 400 ApiError
    const badJson = await t.app.inject({ method: 'POST', url: '/api/quizzes', headers: { cookie: t.cookies.alice, 'content-type': 'application/json' }, payload: '{nope' });
    assert.equal(badJson.statusCode, 400);
    assert.ok(badJson.json().error);

    assert.equal((await t.req('DELETE', `/api/quizzes/${q.id}`, 'bob')).statusCode, 403);
    assert.equal((await t.req('DELETE', `/api/quizzes/${q.id}`, 'alice')).statusCode, 200);
    assert.equal((await t.req('GET', `/api/quizzes/${q.id}`, 'alice')).statusCode, 404);
  } finally { await t.close(); }
});

test('quizzes: CSV / JSON import + template', async () => {
  const t = await setup();
  try {
    await t.login('alice', 'pw-alice');
    const tpl = await t.req('GET', '/api/quizzes/template.csv');
    assert.equal(tpl.statusCode, 200);
    assert.match(String(tpl.headers['content-type']), /text\/csv/);
    // template must import cleanly with 3 questions
    const fromTpl = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'Tpl', format: 'csv', content: tpl.body });
    assert.equal(fromTpl.statusCode, 201, fromTpl.body);
    assert.equal(fromTpl.json().questions.length, 3);
    assert.equal(fromTpl.json().questions[2].text, 'Which planet is known as the "Red Planet"?');
    assert.equal(fromTpl.json().questions[2].correctIndex, 1);

    const csv = '﻿Question,Option_A,option_b,option_c,option_d,correct,time_sec,image_url\r\n'
      + 'What is 2+2?,3,,4,5,c,25,\r\n'                // blank B dropped; C → index 1
      + '\r\n'
      + '"Comma, inside",x,y,,,1,,https://img.test/a.png\r\n'
      + 'Last?,a,b,c,d,4,,\r\n';
    const r = await t.req('POST', '/api/quizzes/import', 'alice', { title: ' Imported ', format: 'csv', content: csv, scoring: 'flat' });
    assert.equal(r.statusCode, 201, r.body);
    const q = r.json();
    assert.equal(q.title, 'Imported');
    assert.equal(q.scoring, 'flat');
    assert.equal(q.emailMode, 'optional');
    assert.deepEqual(q.questions[0].options, ['3', '4', '5']);
    assert.equal(q.questions[0].correctIndex, 1);
    assert.equal(q.questions[0].timeLimitSec, 25);
    assert.equal(q.questions[1].text, 'Comma, inside');
    assert.deepEqual(q.questions[1].options, ['x', 'y']);
    assert.equal(q.questions[1].correctIndex, 0);
    assert.equal(q.questions[1].timeLimitSec, 20);
    assert.equal(q.questions[1].imageUrl, 'https://img.test/a.png');
    assert.equal(q.questions[2].correctIndex, 3);

    const H = 'question,option_a,option_b,option_c,option_d,correct,time_sec,image_url\n';
    const errs: [string, RegExp][] = [
      [H + 'Q1,a,b,,,A,,\nQ2,a,b,,,E,,\n', /^Row 3: correct answer 'E' is not A–D/],
      [H + 'Q1,a,b,,,C,,\n', /^Row 2: correct answer 'C' points to an empty option/],
      [H + 'Q1,a,,,,A,,\n', /^Row 2: needs at least 2/],
      [H + ',a,b,,,A,,\n', /^Row 2: question text is empty/],
      [H + 'Q1,a,b,,,A,2,\n', /^Row 2: time_sec/],
      [H + 'Q1,a,b,,,A,,ftp://x\n', /^Row 2: image_url/],
      [H + 'Q1,a,b,,,,,\n', /^Row 2: correct answer is empty/],
      ['foo,bar\n1,2\n', /^Row 1: header row/],
      [H, /no question rows/],
      [H + Array.from({ length: 101 }, (_, i) => `Q${i},a,b,,,A,,`).join('\n'), /Row 102: too many/],
    ];
    for (const [content, re] of errs) {
      const e = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'X', format: 'csv', content });
      assert.equal(e.statusCode, 400, content);
      assert.equal(e.json().error, 'invalid_import');
      assert.match(e.json().message, re);
    }

    // JSON: array of questions
    const j1 = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'J', format: 'json', content: JSON.stringify(sampleQuiz().questions) });
    assert.equal(j1.statusCode, 201, j1.body);
    assert.equal(j1.json().questions.length, 2);
    // JSON: full QuizInput, title from file when request title blank
    const j2 = await t.req('POST', '/api/quizzes/import', 'alice', { title: '', format: 'json', content: JSON.stringify({ ...sampleQuiz('From file'), emailMode: 'required' }) });
    assert.equal(j2.statusCode, 201, j2.body);
    assert.equal(j2.json().title, 'From file');
    assert.equal(j2.json().emailMode, 'required');
    const j3 = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'J', format: 'json', content: '{bad' });
    assert.equal(j3.json().error, 'invalid_import');
    const j4 = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'J', format: 'json', content: JSON.stringify([{ text: 'a', options: ['x'], correctIndex: 0 }]) });
    assert.equal(j4.statusCode, 400);
    assert.match(j4.json().message, /Question 1/);
    assert.equal((await t.req('POST', '/api/quizzes/import', undefined, { title: 'J', format: 'json', content: '[]' })).statusCode, 401);
  } finally { await t.close(); }
});

test('sessions: create, list, patch, qr, public list, play + join mapping, export', async () => {
  const t = await setup();
  try {
    await t.login('alice', 'pw-alice');
    await t.login('bob', 'pw-bob');
    await t.login('root', 'pw:root');
    const quiz = (await t.req('POST', '/api/quizzes', 'alice', sampleQuiz('Party, "Quiz"'))).json();

    assert.equal((await t.req('POST', '/api/sessions', undefined, { quizId: quiz.id })).statusCode, 401);
    assert.equal((await t.req('POST', '/api/sessions', 'bob', { quizId: quiz.id })).statusCode, 403);
    assert.equal((await t.req('POST', '/api/sessions', 'alice', { quizId: 'nope' })).statusCode, 404);
    const cr = await t.req('POST', '/api/sessions', 'alice', { quizId: quiz.id, label: '  Hall A ' + 'x'.repeat(100) });
    assert.equal(cr.statusCode, 201, cr.body);
    const s = cr.json();
    assert.equal(s.label.length, 60);
    assert.ok(s.label.startsWith('Hall A'));
    assert.equal(s.listed, true);
    const code: string = s.code;

    const list = await t.req('GET', '/api/sessions', 'alice');
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0].code, code);
    assert.deepEqual((await t.req('GET', '/api/sessions', 'bob')).json(), []);
    assert.equal((await t.req('GET', '/api/sessions', 'root')).json().length, 1);
    // row fallback when room isn't in memory
    t.registry.rooms.delete(code);
    const fb = (await t.req('GET', '/api/sessions', 'alice')).json()[0];
    assert.equal(fb.title, 'Party, "Quiz"');
    assert.equal(fb.total, 2);
    assert.equal(fb.joinUrl, `http://test.local/join/${code}`);
    // recreate a live room
    const s2 = (await t.req('POST', '/api/sessions', 'alice', { quizId: quiz.id, label: 'Live' })).json();
    const live: string = s2.code;

    assert.equal((await t.req('PATCH', `/api/sessions/${live}`, 'bob', { listed: false })).statusCode, 403);
    assert.equal((await t.req('PATCH', `/api/sessions/${live}`, 'alice', { listed: 'no' })).statusCode, 400);
    assert.equal((await t.req('PATCH', `/api/sessions/999999`, 'alice', { listed: false })).statusCode, 404);
    const p = await t.req('PATCH', `/api/sessions/${live}`, 'root', { label: ' New ' });
    assert.equal(p.statusCode, 200);
    assert.equal(p.json().label, 'New');

    // QR
    const qr = await t.req('GET', `/api/sessions/${live}/qr.svg`);
    assert.equal(qr.statusCode, 200);
    assert.match(String(qr.headers['content-type']), /image\/svg\+xml/);
    assert.match(qr.body, /<svg/);
    assert.equal((await t.req('GET', `/api/sessions/${code}/qr.svg`)).statusCode, 200); // via DB row
    assert.equal((await t.req('GET', `/api/sessions/111111/qr.svg`)).statusCode, 404);
    assert.equal((await t.req('GET', `/api/sessions/abc/qr.svg`)).statusCode, 404);

    // public list cached
    const pub1 = await t.req('GET', '/api/public/sessions');
    assert.equal(pub1.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(pub1.json()[0]).sort(), ['code', 'eventName', 'joinOpen', 'label', 'players', 'qIndex', 'state', 'title', 'total']);
    const calls = t.registry.publicListCalls;
    await t.req('GET', '/api/public/sessions');
    assert.equal(t.registry.publicListCalls, calls);

    // play info
    assert.equal((await t.req('GET', `/api/play/${live}`)).json().emailMode, 'optional');
    assert.equal((await t.req('GET', '/api/play/123')).statusCode, 404);
    assert.equal((await t.req('GET', '/api/play/999999')).statusCode, 404);

    // joins
    let ip = 0;
    const join = (c: string, body: unknown) => t.req('POST', `/api/play/${c}/join`, undefined, body, `172.16.0.${++ip}`);
    const j1 = await join(live, { name: 'Anu', email: 'anu@example.com' });
    assert.equal(j1.statusCode, 200, j1.body);
    assert.deepEqual(Object.keys(j1.json()).sort(), ['name', 'playerId', 'rejoined', 'token']);
    assert.equal((await join(live, { name: 'Anu' })).json().name, 'Anu (2)');
    await join(live, { name: '=SUM(A1)', email: '' });
    const expectErr = async (c: string, body: unknown, status: number, error: string) => {
      const r = await join(c, body);
      assert.equal(r.statusCode, status, `${error}: ${r.body}`);
      assert.equal(r.json().error, error);
    };
    await expectErr('999999', { name: 'x' }, 404, 'not_found');
    await expectErr(live, { name: '' }, 400, 'invalid_name');
    await expectErr(live, { name: 42 }, 400, 'invalid_name');
    await expectErr(live, {}, 400, 'invalid_name');
    await expectErr(live, { name: 'x', email: 'bad' }, 400, 'invalid_email');
    await t.req('PATCH', `/api/sessions/${live}`, 'alice', { joinOpen: false });
    await expectErr(live, { name: 'x' }, 403, 'join_closed');
    await t.req('PATCH', `/api/sessions/${live}`, 'alice', { joinOpen: true });
    t.registry.rooms.get(live)!.capacity = 3;
    await expectErr(live, { name: 'x' }, 409, 'room_full');
    t.registry.setState(live, 'FINISHED');
    await expectErr(live, { name: 'x' }, 409, 'finished');
    const reqQuiz = (await t.req('POST', '/api/quizzes', 'alice', { ...sampleQuiz(), emailMode: 'required' })).json();
    const rq = (await t.req('POST', '/api/sessions', 'alice', { quizId: reqQuiz.id })).json();
    await expectErr(rq.code, { name: 'x' }, 400, 'email_required');

    // rate limit 10/min/IP
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await t.req('POST', `/api/play/${rq.code}/join`, undefined, { name: `R${i}`, email: 'r@x.io' }, '8.8.8.8')).statusCode);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.deepEqual(codes.slice(10), [429, 429]);
    const rl = await t.req('POST', `/api/play/${rq.code}/join`, undefined, { name: 'z' }, '8.8.8.8');
    assert.equal(rl.json().error, 'rate_limited');

    // export
    const sid = t.registry.rooms.get(live)!.summary.id;
    const players = t.repo.listPlayers(sid);
    const [anu, anu2, sum] = players;
    const qs = quiz.questions;
    t.repo.updatePlayer(anu.id, { score: 900 });
    t.repo.updatePlayer(anu2.id, { score: 900 });
    t.repo.queueAnswer({ sessionId: sid, playerId: anu.id, questionId: qs[0].id, qIndex: 0, choice: 1, correct: true, responseMs: 3000, points: 900, answeredAt: 1 });
    t.repo.queueAnswer({ sessionId: sid, playerId: anu2.id, questionId: qs[0].id, qIndex: 0, choice: 1, correct: true, responseMs: 2000, points: 900, answeredAt: 1 });
    t.repo.queueAnswer({ sessionId: sid, playerId: anu2.id, questionId: qs[1].id, qIndex: 1, choice: 1, correct: false, responseMs: 500, points: 0, answeredAt: 2 });
    t.repo.queueAnswer({ sessionId: sid, playerId: sum.id, questionId: qs[0].id, qIndex: 0, choice: 0, correct: false, responseMs: 100, points: 0, answeredAt: 1 });
    // a kicked player is excluded
    t.repo.insertPlayer({ id: 'pk', sessionId: sid, name: 'Kicked', email: null, tokenHash: 'h', score: 5000, kicked: true, joinedAt: 1 });

    assert.equal((await t.req('GET', `/api/sessions/${live}/export.csv`)).statusCode, 401);
    assert.equal((await t.req('GET', `/api/sessions/${live}/export.csv`, 'bob')).statusCode, 403);
    assert.equal((await t.req('GET', `/api/sessions/000000/export.csv`, 'alice')).statusCode, 404);
    const ex = await t.req('GET', `/api/sessions/${live}/export.csv`, 'alice');
    assert.equal(ex.statusCode, 200);
    assert.match(String(ex.headers['content-type']), /text\/csv/);
    assert.equal(ex.headers['content-disposition'], `attachment; filename="cloud9-${live}-party-quiz.csv"`);
    const parsed = Papa.parse<string[]>(ex.body.replace(/^﻿/, ''), { skipEmptyLines: true }).data;
    assert.deepEqual(parsed[0], ['rank', 'name', 'email', 'score', 'correct_count', 'answered_count', 'total_response_ms',
      'q1_choice', 'q1_correct', 'q1_points', 'q1_ms', 'q2_choice', 'q2_correct', 'q2_points', 'q2_ms']);
    assert.equal(parsed.length, 4); // header + 3 non-kicked
    assert.deepEqual(parsed[1], ['1', 'Anu (2)', '', '900', '1', '2', '2500', 'B', '1', '900', '2000', 'B', '0', '0', '500']);
    assert.deepEqual(parsed[2], ['2', 'Anu', 'anu@example.com', '900', '1', '1', '3000', 'B', '1', '900', '3000', '', '', '', '']);
    assert.equal(parsed[3][1], "'=SUM(A1)");
    assert.equal((await t.req('GET', `/api/sessions/${live}/export.csv`, 'root')).statusCode, 200);
  } finally { await t.close(); }
});

// ───────────── events ─────────────
test('events: CRUD, ownership, list counts, validation', async () => {
  const t = await setup();
  try {
    await t.login('alice', 'pw-alice');
    await t.login('bob', 'pw-bob');
    await t.login('root', 'pw:root');
    assert.equal((await t.req('GET', '/api/events')).statusCode, 401);
    assert.equal((await t.req('POST', '/api/events', undefined, { name: 'X' })).statusCode, 401);
    assert.equal((await t.req('POST', '/api/events', 'alice', { name: '   ' })).statusCode, 400);
    assert.equal((await t.req('POST', '/api/events', 'alice', { name: 'x'.repeat(81) })).statusCode, 400);
    assert.equal((await t.req('POST', '/api/events', 'alice', { name: 'ok', emailRequired: 'yes' })).statusCode, 400);
    const cr = await t.req('POST', '/api/events', 'alice', { name: '  CCD   Kochi  ' });
    assert.equal(cr.statusCode, 201, cr.body);
    const ev = cr.json();
    assert.equal(ev.name, 'CCD Kochi');
    assert.equal(ev.emailRequired, true);
    assert.equal(ev.moderatorId, 'mod_alice');
    const ev2 = (await t.req('POST', '/api/events', 'bob', { name: 'Side', emailRequired: false })).json();
    assert.equal(ev2.emailRequired, false);

    // shared: bob lists + views alice's event
    const list = (await t.req('GET', '/api/events', 'bob')).json();
    assert.deepEqual(list.map((e: any) => e.id), [ev2.id, ev.id]);
    assert.deepEqual([list[1].quizCount, list[1].sessionCount, list[1].liveSessions], [0, 0, 0]);
    const det = await t.req('GET', `/api/events/${ev.id}`, 'bob');
    assert.equal(det.statusCode, 200);
    assert.deepEqual(det.json(), { event: ev, quizzes: [], sessions: [] });
    assert.equal((await t.req('GET', '/api/events/nope', 'bob')).statusCode, 404);

    // only creator or super may edit/delete
    assert.equal((await t.req('PUT', `/api/events/${ev.id}`, 'bob', { name: 'Hijack' })).statusCode, 403);
    assert.equal((await t.req('DELETE', `/api/events/${ev.id}`, 'bob')).statusCode, 403);
    assert.equal((await t.req('PUT', `/api/events/nope`, 'alice', { name: 'x' })).statusCode, 404);
    const up = await t.req('PUT', `/api/events/${ev.id}`, 'alice', { name: 'CCD Kochi 26' });
    assert.equal(up.statusCode, 200);
    assert.equal(up.json().name, 'CCD Kochi 26');
    assert.equal(up.json().emailRequired, true); // omitted → unchanged
    const up2 = await t.req('PUT', `/api/events/${ev.id}`, 'root', { name: 'CCD Kochi 26', emailRequired: false });
    assert.equal(up2.statusCode, 200);
    assert.equal(up2.json().emailRequired, false);
    assert.equal((await t.req('DELETE', `/api/events/${ev2.id}`, 'root')).statusCode, 200);
    assert.equal(t.repo.getEvent(ev2.id), null);
  } finally {
    await t.close();
  }
});

test('events: quizzes eventId filter + invalid_event, sessions carry event, leaderboard, export, public board, join', async () => {
  const t = await setup();
  try {
    await t.login('alice', 'pw-alice');
    await t.login('bob', 'pw-bob');
    await t.login('root', 'pw:root');
    const ev = (await t.req('POST', '/api/events', 'alice', { name: 'Conf' })).json();

    // quiz eventId validation
    const bad = await t.req('POST', '/api/quizzes', 'alice', { ...sampleQuiz(), eventId: 'ev_missing' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_event');
    const badImp = await t.req('POST', '/api/quizzes/import', 'alice', { title: 'I', format: 'json', content: JSON.stringify(sampleQuiz().questions), eventId: 'nope' });
    assert.equal(badImp.json().error, 'invalid_event');

    const qa = (await t.req('POST', '/api/quizzes', 'alice', { ...sampleQuiz('A in event'), eventId: ev.id })).json();
    assert.equal(qa.eventId, ev.id);
    const qs = (await t.req('POST', '/api/quizzes', 'alice', sampleQuiz('A standalone'))).json();
    assert.equal(qs.eventId, null);
    const imp = await t.req('POST', '/api/quizzes/import', 'bob', { title: 'B in event', format: 'json', content: JSON.stringify(sampleQuiz().questions), eventId: ev.id });
    assert.equal(imp.statusCode, 201, imp.body);
    const qb = imp.json();
    assert.equal(qb.eventId, ev.id);
    const qb2 = (await t.req('POST', '/api/quizzes', 'bob', sampleQuiz('B standalone'))).json();

    const ids = (r: any) => r.json().map((q: any) => q.id).sort();
    assert.deepEqual(ids(await t.req('GET', `/api/quizzes?eventId=${ev.id}`, 'alice')), [qa.id, qb.id].sort());
    assert.deepEqual(ids(await t.req('GET', `/api/quizzes?eventId=${ev.id}`, 'bob')), [qa.id, qb.id].sort());
    assert.deepEqual(ids(await t.req('GET', `/api/quizzes?eventId=none`, 'alice')), [qs.id]);
    assert.deepEqual(ids(await t.req('GET', `/api/quizzes?eventId=none`, 'root')), [qs.id, qb2.id].sort());
    assert.deepEqual(ids(await t.req('GET', `/api/quizzes`, 'alice')), [qa.id, qs.id].sort()); // unchanged: own
    assert.equal((await t.req('GET', `/api/quizzes`, 'alice')).json().find((q: any) => q.id === qa.id).eventId, ev.id);

    // editing someone else's quiz is still forbidden even in a shared event
    assert.equal((await t.req('PUT', `/api/quizzes/${qa.id}`, 'bob', sampleQuiz('x'))).statusCode, 403);
    assert.equal((await t.req('GET', `/api/quizzes/${qa.id}`, 'bob')).statusCode, 403);
    // PUT without eventId keeps it; invalid → 400; null detaches; re-attach
    assert.equal((await t.req('PUT', `/api/quizzes/${qa.id}`, 'alice', sampleQuiz('A2'))).json().eventId, ev.id);
    assert.equal((await t.req('PUT', `/api/quizzes/${qa.id}`, 'alice', { ...sampleQuiz('A2'), eventId: 'zz' })).json().error, 'invalid_event');
    assert.equal((await t.req('PUT', `/api/quizzes/${qs.id}`, 'alice', { ...sampleQuiz('S'), eventId: null })).json().eventId, null);
    assert.equal((await t.req('PUT', `/api/quizzes/${qs.id}`, 'alice', { ...sampleQuiz('S'), eventId: ev.id })).json().eventId, ev.id);
    assert.equal((await t.req('PUT', `/api/quizzes/${qs.id}`, 'alice', { ...sampleQuiz('S'), eventId: null })).json().eventId, null);

    // sessions get the event
    const s1 = (await t.req('POST', '/api/sessions', 'alice', { quizId: qa.id, label: 'Hall A' })).json();
    assert.equal(t.registry.lastCreateEvent?.id, ev.id);
    assert.equal(s1.eventId, ev.id);
    assert.equal(s1.eventName, 'Conf');
    const sStand = (await t.req('POST', '/api/sessions', 'alice', { quizId: qs.id })).json();
    assert.equal(t.registry.lastCreateEvent, null);
    assert.equal(sStand.eventId, null);
    const s2 = (await t.req('POST', '/api/sessions', 'bob', { quizId: qb.id, label: 'Hall B' })).json();
    const evs = (await t.req('GET', '/api/events', 'bob')).json();
    assert.deepEqual([evs[0].quizCount, evs[0].sessionCount, evs[0].liveSessions], [2, 2, 2]);
    t.registry.setState(s2.code, 'FINISHED');
    assert.equal((await t.req('GET', '/api/events', 'bob')).json()[0].liveSessions, 1);
    const det = (await t.req('GET', `/api/events/${ev.id}`, 'bob')).json();
    assert.deepEqual(det.quizzes.map((q: any) => q.id).sort(), [qa.id, qb.id].sort());
    assert.deepEqual(det.sessions.map((s: any) => s.code).sort(), [s1.code, s2.code].sort());
    // persisted-only sessions show up too (room evicted from memory) with eventName
    t.registry.rooms.delete(s2.code);
    const det2 = (await t.req('GET', `/api/events/${ev.id}`, 'alice')).json();
    assert.equal(det2.sessions.length, 2);
    assert.equal(det2.sessions.find((s: any) => s.code === s2.code).eventName, 'Conf');
    assert.equal((await t.req('GET', '/api/sessions', 'bob')).json()[0].eventName, 'Conf');

    // play info: effective email mode
    const pi = (await t.req('GET', `/api/play/${s1.code}`)).json();
    assert.equal(pi.eventName, 'Conf');
    assert.equal(pi.emailMode, 'required');
    // join: rejoined + kicked mapping
    const j1 = await t.req('POST', `/api/play/${s1.code}/join`, undefined, { name: 'Anu', email: 'anu@x.test' }, '10.9.0.1');
    assert.equal(j1.statusCode, 200);
    assert.equal(j1.json().rejoined, false);
    const j2 = await t.req('POST', `/api/play/${s1.code}/join`, undefined, { name: 'Anu', email: 'ANU@x.test' }, '10.9.0.1');
    assert.equal(j2.json().rejoined, true);
    assert.equal(j2.json().playerId, j1.json().playerId);
    const jk = await t.req('POST', `/api/play/${s1.code}/join`, undefined, { name: 'K', email: 'kicked@x.test' }, '10.9.0.1');
    assert.equal(jk.statusCode, 403);
    assert.equal(jk.json().error, 'kicked');

    // leaderboard data: add players directly
    const sid1 = s1.id, sid2 = s2.id;
    const P = (id: string, sid: string, name: string, email: string | null, score: number, joinedAt: number) =>
      t.repo.insertPlayer({ id, sessionId: sid, name, email, tokenHash: 'h' + id, score, kicked: false, joinedAt });
    P('x1', sid1, '=HYPERLINK("evil")', 'bob@x.test', 900, 1);
    P('x2', sid2, 'Bobby', 'bob@x.test', 600, 2);
    P('x3', sid2, 'Zed', 'zed@x.test', 1000, 3);
    for (let i = 0; i < 12; i++) P(`y${i}`, sid2, `Y${i}`, `y${i}@x.test`, 10 + i, 10 + i);
    t.repo.updatePlayer(j1.json().playerId, { score: 50 });

    const lb = await t.req('GET', `/api/events/${ev.id}/leaderboard`, 'bob');
    assert.equal(lb.statusCode, 200);
    const rows = lb.json();
    assert.equal(rows.length, 15); // bob, zed, anu, 12 y's
    assert.deepEqual(rows[0], { key: 'bob@x.test', name: 'Bobby', email: 'bob@x.test', score: 1500, quizzesPlayed: 2, rank: 1 });
    assert.equal(rows[1].key, 'zed@x.test');
    assert.equal((await t.req('GET', `/api/events/${ev.id}/leaderboard`)).statusCode, 401);
    assert.equal((await t.req('GET', `/api/events/nope/leaderboard`, 'bob')).statusCode, 404);

    const csv = await t.req('GET', `/api/events/${ev.id}/export.csv`, 'bob');
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /cloud9-event-conf\.csv/);
    assert.ok(csv.body.startsWith('﻿'));
    const parsed = Papa.parse<string[]>(csv.body.replace(/^﻿/, '').trim()).data;
    assert.deepEqual(parsed[0], ['rank', 'name', 'email', 'score', 'quizzes_played']);
    assert.deepEqual(parsed[1], ['1', 'Bobby', 'bob@x.test', '1500', '2']);
    assert.equal(parsed.length, 16);
    assert.equal((await t.req('GET', `/api/events/${ev.id}/export.csv`)).statusCode, 401);
    // formula guard: rename bob's latest join to a formula
    t.repo.updatePlayer('x2', { name: '=cmd' });
    const csv2 = Papa.parse<string[]>((await t.req('GET', `/api/events/${ev.id}/export.csv`, 'alice')).body.replace(/^﻿/, '').trim()).data;
    assert.equal(csv2[1][1], "'=cmd");

    // public board: no auth, top 10, no emails, cached 2s
    const pub = await t.req('GET', `/api/public/events/${ev.id}/leaderboard`);
    assert.equal(pub.statusCode, 200);
    const pb = pub.json();
    assert.equal(pb.eventName, 'Conf');
    assert.equal(pb.top.length, 10);
    assert.equal(pb.total, 15);
    assert.deepEqual(Object.keys(pb.top[0]).sort(), ['name', 'quizzesPlayed', 'rank', 'score']);
    assert.ok(!pub.body.includes('@'));
    assert.equal(typeof pb.updatedAt, 'number');
    P('late', sid2, 'Late', 'late@x.test', 5, 100);
    assert.equal((await t.req('GET', `/api/public/events/${ev.id}/leaderboard`)).json().total, 15); // cached
    assert.equal((await t.req('GET', `/api/public/events/nope/leaderboard`)).statusCode, 404);

    // delete event: quizzes detached, not deleted; sessions keep history
    assert.equal((await t.req('DELETE', `/api/events/${ev.id}`, 'alice')).statusCode, 200);
    assert.equal((await t.req('GET', `/api/quizzes/${qa.id}`, 'alice')).json().eventId, null);
    assert.equal((await t.req('GET', `/api/quizzes/${qb.id}`, 'bob')).json().eventId, null);
    assert.equal(t.repo.getLatestSessionByCode(s1.code)!.eventId, ev.id);
    assert.equal((await t.req('GET', `/api/public/events/${ev.id}/leaderboard`)).statusCode, 404);
    assert.equal((await t.req('GET', `/api/events/${ev.id}`, 'alice')).statusCode, 404);
  } finally {
    await t.close();
  }
});
