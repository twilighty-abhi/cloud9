import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventLeaderEntry } from '../../shared/model';
import { WS_CLOSE } from '../../shared/protocol';
import { scoreAnswer } from '../../shared/model';
import { csvCell } from '../src/util/csv';
import { trustedProxy } from '../src/config';
import { auditDb, auditServer, password, quizInput } from './auditFixture';

test('server entry point: signed cookie, owner/super enforcement and private export headers', async (t) => {
  const app = await auditServer(t, { env: { PUBLIC_URL: 'https://quiz.example.test' } });
  const response = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password }),
  });
  assert.equal(response.status, 200);
  const header = response.headers.get('set-cookie')!;
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(header.includes(attr), header);
  const owner = header.split(';')[0];
  const other = await app.login('other');
  const root = await app.login('root');
  const room = await app.room(owner, { listed: false });
  assert.equal(room.joinUrl, `https://quiz.example.test/join/${room.code}`);
  await app.json('/api/me', 'GET', 401, undefined, owner + 'x');
  await app.json(`/api/sessions/${room.code}`, 'PATCH', 403, { joinOpen: false }, other);
  await app.json(`/api/sessions/${room.code}/export.csv`, 'GET', 401);
  await app.json(`/api/sessions/${room.code}/export.csv`, 'GET', 403, undefined, other);
  const csv = await app.request(`/api/sessions/${room.code}/export.csv`, { headers: { cookie: root } });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  assert.match(csv.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.deepEqual(await app.json('/api/public/sessions', 'GET', 200), []);
  const qr = await app.request(`/api/sessions/${room.code}/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.match(await qr.text(), /<svg/);
});

test('real WebSockets enforce room and role boundaries and hide answers until reveal', async (t) => {
  const app = await auditServer(t);
  const owner = await app.login();
  const other = await app.login('other');
  const room = await app.room(owner);
  const sibling = await app.room(other);
  const player = await app.joinPlayer(room.code, 'Auditor', 'player@example.test');
  const wrongRoom = await app.connect('player', sibling.code, { token: player.token });
  assert.equal(await wrongRoom.closed(), WS_CLOSE.UNAUTHORIZED);
  const wrongMod = await app.connect('mod', room.code, { cookie: other });
  assert.equal(await wrongMod.closed(), WS_CLOSE.UNAUTHORIZED);
  const anonymous = await app.connect('mod', room.code);
  assert.equal(await anonymous.closed(), WS_CLOSE.UNAUTHORIZED);
  const invalid = await app.connect('unknown', room.code);
  assert.equal(await invalid.closed(), WS_CLOSE.UNAUTHORIZED);
  const missing = await app.connect('present', 'bad');
  assert.equal(await missing.closed(), WS_CLOSE.NOT_FOUND);

  const mod = await app.connect('mod', room.code, { cookie: owner });
  const present = await app.connect('present', room.code);
  const client = await app.connect('player', room.code, { token: player.token });
  await Promise.all([mod.state('LOBBY'), present.state('LOBBY'), client.state('LOBBY')]);
  present.send({ t: 'mod', action: 'start', expectQ: -1 });
  assert.equal((await present.next('error')).code, 'unauthorized');
  client.send({ t: 'kick', playerId: player.playerId });
  assert.equal((await client.next('error')).code, 'unauthorized');
  mod.send({ t: 'mod', action: 'start', expectQ: -1 });
  const [hostQ, projectorQ, playerQ] = await Promise.all([mod.state('QUESTION'), present.state('QUESTION'), client.state('QUESTION')]);
  assert.equal(hostQ.role === 'mod' && hostQ.correctIndex, 1);
  assert.equal(projectorQ.role === 'present' && projectorQ.correctIndex, null);
  assert.equal(projectorQ.role === 'present' && projectorQ.nextQuestion, null);
  assert.equal(playerQ.role === 'player' && playerQ.reveal, null);
  assert.ok(!JSON.stringify(playerQ).includes('player@example.test'));
  assert.ok(!Object.hasOwn(playerQ.question!, 'correctIndex'));

  client.send({ t: 'answer', qIndex: 0, choice: 1 });
  assert.equal((await client.next('ack')).choice, 1);
  const closed = await client.state('CLOSED');
  assert.equal(closed.role === 'player' && closed.me.score, 0);
  mod.send({ t: 'mod', action: 'reveal', expectQ: 0 });
  const revealed = await client.state('REVEAL');
  assert.equal(revealed.role === 'player' && revealed.reveal?.points, 1000);
  mod.send({ t: 'mod', action: 'next', expectQ: 0 });
  await mod.state('QUESTION');
  mod.send({ t: 'mod', action: 'next', expectQ: 0 });
  assert.equal((await mod.next('error')).code, 'stale');
  mod.send({ t: 'kick', playerId: player.playerId });
  assert.equal(await client.closed(), WS_CLOSE.KICKED);
});

test('WebSocket transport rejects malformed, binary, oversized and flooded messages', async (t) => {
  const app = await auditServer(t);
  const room = await app.room(await app.login());
  const malformed = await app.connect('present', room.code);
  await malformed.state('LOBBY');
  malformed.ws.send('{');
  assert.equal((await malformed.next('error')).code, 'bad_message');
  malformed.ws.send(Buffer.from('{"t":"ping"}'));
  assert.equal((await malformed.next('error')).code, 'bad_message');
  malformed.send({ t: 'ping' });
  assert.equal(typeof (await malformed.next('pong')).serverNow, 'number');

  const oversized = await app.connect('present', room.code);
  oversized.ws.send('x'.repeat(4097));
  assert.equal(await oversized.closed(), 1009);
  const flooded = await app.connect('present', room.code);
  for (let i = 0; i < 100; i++) flooded.send({ t: 'ping' });
  assert.equal(await flooded.closed(), WS_CLOSE.RATE_LIMITED);
});

test('real SQLite and graceful restart preserve answer, token and moderator session', async (t) => {
  const dbPath = await auditDb(t);
  let app = await auditServer(t, { dbPath });
  const cookie = await app.login();
  const room = await app.room(cookie);
  const player = await app.joinPlayer(room.code, 'Keep', 'keep@example.test');
  const waiting = await app.joinPlayer(room.code, 'Wait');
  const mod = await app.connect('mod', room.code, { cookie });
  const client = await app.connect('player', room.code, { token: player.token });
  const second = await app.connect('player', room.code, { token: waiting.token });
  await second.state('LOBBY');
  mod.send({ t: 'mod', action: 'start', expectQ: -1 });
  await client.state('QUESTION');
  client.send({ t: 'answer', qIndex: 0, choice: 1 });
  await client.next('ack');
  assert.equal((await app.stop()).code, 0);
  app = await auditServer(t, { dbPath });
  const restored = await app.connect('player', room.code, { token: player.token });
  const state = await restored.state('CLOSED');
  assert.equal(state.role === 'player' && state.myAnswer?.choice, 1);
  const restoredMod = await app.connect('mod', room.code, { cookie });
  await restoredMod.state('CLOSED');
  restoredMod.send({ t: 'mod', action: 'reveal', expectQ: 0 });
  const reveal = await restored.state('REVEAL');
  assert.equal(reveal.role === 'player' && reveal.me.score, 1000);
});

test('event leaderboard privacy: only authenticated results include email fields', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const event = await app.event(cookie);
  const room = await app.room(cookie, { eventId: event.id });
  await app.json(`/api/play/${room.code}/join`, 'POST', 400, { name: 'No email' });
  await app.joinPlayer(room.code, 'Player', 'private@example.test');
  const path = `/api/events/${event.id}/leaderboard`;
  await app.json(path, 'GET', 401);
  const staff = await app.json<EventLeaderEntry[]>(path, 'GET', 200, undefined, cookie);
  assert.equal(staff[0].email, 'private@example.test');
  const board = await app.json(`/api/public/events/${event.id}/leaderboard`, 'GET', 200);
  assert.ok(!JSON.stringify(board).includes('private@example.test'));
  assert.deepEqual(Object.keys((board as { top: object[] }).top[0]).sort(), ['name', 'quizzesPlayed', 'rank', 'score']);
});

test('quiz import rejects dangerous URL schemes and empty correct choices', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const invalidImage = { ...quizInput, questions: [{ ...quizInput.questions[0], imageUrl: 'javascript:alert(1)' }] };
  const fail = await app.json<{ error: string }>('/api/quizzes', 'POST', 400, invalidImage, cookie);
  assert.equal(fail.error, 'invalid_input');
  const invalidCsv = {
    format: 'csv', content: 'question,option_a,option_b,option_c,correct\nQuestion,One,Two,,C\n',
  };
  const missing = await app.json<{ error: string; message: string }>('/api/quizzes/import', 'POST', 400, invalidCsv, cookie);
  assert.equal(missing.error, 'invalid_import');
  assert.match(missing.message, /empty option/);
  assert.deepEqual(await app.json('/api/quizzes', 'GET', 200, undefined, cookie), []);
});

test('scoring clamps time and excludes wrong answers, and CSV escapes quotes and formulas', () => {
  const input = { correct: true, responseMs: 0, timeLimitSec: 20, pointsMax: 1000, scoring: 'speed' } as const;
  for (const [responseMs, points] of [[-1, 1000], [0, 1000], [10_000, 750], [20_000, 500], [30_000, 500]]) {
    assert.equal(scoreAnswer({ ...input, responseMs }), points);
  }
  assert.equal(scoreAnswer({ ...input, correct: false }), 0);
  assert.equal(scoreAnswer({ ...input, responseMs: 20_000, scoring: 'flat' }), 1000);
  for (const value of ['=1+1', '+1', '-1', '@SUM(1)', '\t=1']) assert.equal(csvCell(value), "'" + value);
  assert.equal(csvCell('Hello, "world"'), '"Hello, ""world"""');
  assert.equal(csvCell(-1), '-1');
});

test('signed-out visitors can play and present, while staff routes reject anonymous reads and writes', async (t) => {
  const app = await auditServer(t);
  const owner = await app.login();
  const event = await app.event(owner);
  const room = await app.room(owner, { eventId: event.id });
  const quiz = `/api/quizzes/${room.quizId}`;
  const eventPath = `/api/events/${event.id}`;
  const sessionPath = `/api/sessions/${room.code}`;
  const staffRoutes: [string, string][] = [
    ['/api/me', 'GET'], ['/api/quizzes', 'GET'], ['/api/quizzes', 'POST'], [quiz, 'GET'], [quiz, 'PUT'],
    [quiz, 'DELETE'], ['/api/quizzes/import', 'POST'], ['/api/sessions', 'GET'], ['/api/sessions', 'POST'],
    [sessionPath, 'PATCH'], [sessionPath + '/export.csv', 'GET'], ['/api/events', 'GET'],
    ['/api/events', 'POST'], [eventPath, 'GET'], [eventPath, 'PUT'], [eventPath, 'DELETE'],
    [eventPath + '/leaderboard', 'GET'], [eventPath + '/export.csv', 'GET'],
  ];
  for (const [path, method] of staffRoutes) await app.json(path, method, 401, method === 'GET' ? undefined : {});
  for (const path of ['/api/public/sessions', `/api/play/${room.code}`, `/api/public/events/${event.id}/leaderboard`]) {
    await app.json(path, 'GET', 200);
  }
  const player = await app.joinPlayer(room.code, 'Guest', 'guest@example.test');
  await (await app.connect('player', room.code, { token: player.token })).state('LOBBY');
  await (await app.connect('present', room.code)).state('LOBBY');
});

test('forwarded IP trust applies only to the configured immediate proxy', () => {
  assert.equal(trustedProxy(undefined), false);
  assert.equal(trustedProxy(''), false);
  const trust = trustedProxy('127.0.0.1,10.203.91.2,fd00:7::/64');
  assert.ok(trust);
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('::ffff:127.0.0.1', 0), true);
  assert.equal(trust('10.203.91.2', 0), true);
  assert.equal(trust('10.203.91.3', 0), false);
  assert.equal(trust('fd00:7::1', 0), true);
  assert.equal(trust('127.0.0.1', 1), false);
  assert.throws(() => trustedProxy('anything'), /TRUSTED_PROXY/);
});
