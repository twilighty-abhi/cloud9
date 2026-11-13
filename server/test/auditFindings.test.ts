import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { EventDef, EventLeaderEntry, QuizDef } from '../../shared/model';
import { WS_CLOSE } from '../../shared/protocol';
import { auditDb, auditServer, password } from './auditFixture';


test('C9-01: a typed email cannot mint a token for an existing player', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const event = await app.event(cookie);
  const room = await app.room(cookie, { eventId: event.id });
  const original = await app.joinPlayer(room.code, 'Original', 'victim@example.test');
  await app.json(`/api/sessions/${room.code}`, 'PATCH', 200, { joinOpen: false }, cookie);
  const response = await app.request(`/api/play/${room.code}/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Impersonator', email: 'VICTIM@example.test' }),
  });
  const data = await response.json() as { token?: string; playerId?: string };
  if (response.ok && data.playerId === original.playerId && data.token) {
    const impersonator = await app.connect('player', room.code, { token: data.token });
    const snapshot = await impersonator.state('LOBBY');
    assert.notEqual(snapshot.role === 'player' && snapshot.me.id, original.playerId,
      'An unauthenticated caller minted a working token for the original player after joining closed');
  }
  assert.equal(response.status, 403);
  const resumed = await app.json<{ token: string; playerId: string; rejoined: boolean }>(
    `/api/play/${room.code}/join`, 'POST', 200, { name: 'Original', token: original.token },
  );
  assert.equal(resumed.token, original.token);
  assert.equal(resumed.playerId, original.playerId);
  assert.equal(resumed.rejoined, true);
});

test('C9-02: production refuses to boot without moderator credentials', async (t) => {
  const app = await auditServer(t, { startupFailure: true, env: { NODE_ENV: 'production', MODERATORS: '' } });
  assert.doesNotMatch(app.logs(), /listening on/, 'Production accepted an empty moderator configuration');
  assert.notEqual((await app.exit).code, 0);
});

test('C9-02: production refuses the documented default admin account when MODERATORS is absent', async (t) => {
  const app = await auditServer(t, { startupFailure: true, env: { NODE_ENV: 'production', MODERATORS: undefined } });
  if (app.logs().includes('listening on')) {
    const cookie = await app.login('admin', 'admin');
    assert.fail(`Default credentials issued a moderator cookie: ${Boolean(cookie)}`);
  }
  assert.notEqual((await app.exit).code, 0);
});

test('C9-03: public event totals do not reveal correctness during an open question', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const event = await app.event(cookie);
  const room = await app.room(cookie, { eventId: event.id });
  const guess = await app.joinPlayer(room.code, 'Guess', 'guess@example.test');
  const waiting = await app.joinPlayer(room.code, 'Wait', 'wait@example.test');
  const mod = await app.connect('mod', room.code, { cookie });
  const guesser = await app.connect('player', room.code, { token: guess.token });
  const waiter = await app.connect('player', room.code, { token: waiting.token });
  await waiter.state('LOBBY');
  mod.send({ t: 'mod', action: 'start', expectQ: -1 });
  await guesser.state('QUESTION');
  guesser.send({ t: 'answer', qIndex: 0, choice: 1 });
  await guesser.next('ack');
  const path = `/api/public/events/${event.id}/leaderboard`;
  const board = await app.json<{ top: { name: string; score: number }[] }>(path, 'GET', 200);
  assert.equal(board.top.find((p) => p.name === 'Guess')?.score ?? 0, 0, 'Correct guess exposed 1000 points before reveal');
  mod.send({ t: 'mod', action: 'close', expectQ: 0 });
  await guesser.state('CLOSED');
  mod.send({ t: 'mod', action: 'reveal', expectQ: 0 });
  await guesser.state('REVEAL');
  mod.send({ t: 'mod', action: 'leaderboard', expectQ: 0 });
  const revealed = await guesser.state('LEADERBOARD');
  assert.equal(revealed.role === 'player' && revealed.eventBoard?.me?.score, 1000);
});

test('C9-04: a rejected answer write cannot leave points without an answer after restart', async (t) => {
  const dbPath = await auditDb(t);
  let app = await auditServer(t, { dbPath });
  const cookie = await app.login();
  const event = await app.event(cookie);
  const room = await app.room(cookie, { eventId: event.id });
  const player = await app.joinPlayer(room.code, 'Affected', 'affected@example.test');
  const fault = new Database(dbPath);
  t.after(() => fault.close());
  fault.exec(`CREATE TRIGGER fail_answer BEFORE INSERT ON answers BEGIN SELECT RAISE(ABORT, 'injected answer write fault'); END;`);
  const mod = await app.connect('mod', room.code, { cookie });
  const client = await app.connect('player', room.code, { token: player.token });
  await client.state('LOBBY');
  mod.send({ t: 'mod', action: 'start', expectQ: -1 });
  await client.state('QUESTION');
  client.send({ t: 'answer', qIndex: 0, choice: 1 });
  assert.equal((await client.next('error')).code, 'storage_unavailable');
  assert.equal((await app.stop('SIGKILL')).signal, 'SIGKILL');
  fault.exec('DROP TRIGGER fail_answer');
  app = await auditServer(t, { dbPath });
  const staff = await app.json<EventLeaderEntry[]>(`/api/events/${event.id}/leaderboard`, 'GET', 200, undefined, cookie);
  const stored = fault.prepare('SELECT COALESCE(SUM(points), 0) AS points FROM answers WHERE player_id = ?')
    .get(player.playerId) as { points: number };
  assert.equal(staff[0].score, stored.points, 'SQLite retained points for an answer it never committed');
});

test('C9-05: direct callers cannot rotate X-Forwarded-For to evade moderator login limits', async (t) => {
  const app = await auditServer(t);
  const statuses = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${attempt}` },
      body: JSON.stringify({ username: 'owner', password: password + '-wrong' }),
    });
    statuses.push(response.status);
    await response.text();
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});

test('C9-06: malformed CSV quoting is rejected before saving a quiz', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const response = await app.request('/api/quizzes/import', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      format: 'csv',
      content: 'question,option_a,option_b,correct,image_url\nPrompt,A,B,A,"https://example.test/image.png',
    }),
  });
  const data = await response.json() as Partial<QuizDef>;
  assert.equal(response.status, 400, `Malformed CSV was persisted as a quiz: ${Boolean(data.id)}`);
  assert.deepEqual(await app.json('/api/quizzes', 'GET', 200, undefined, cookie), []);
});

test('C9-07: event detail includes older event sessions even after 100 unrelated sessions', async (t) => {
  const dbPath = await auditDb(t);
  let app = await auditServer(t, { dbPath });
  const cookie = await app.login();
  const event = await app.event(cookie);
  const eventRoom = await app.room(cookie, { eventId: event.id });
  const mod = await app.connect('mod', eventRoom.code, { cookie });
  await mod.state('LOBBY');
  mod.send({ t: 'mod', action: 'end', expectQ: -1 });
  await mod.state('FINISHED');
  await app.stop();

  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE sessions SET ended_at = ended_at - ? WHERE id = ?').run(7 * 60 * 60 * 1000, eventRoom.id);
    db.exec(`
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
      INSERT INTO sessions (id, code, quiz_id, moderator_id, state, quiz_json, created_at, ended_at)
      SELECT 'unrelated-' || n, printf('%06d', n), quiz_id, moderator_id, 'FINISHED',
        quiz_json, created_at + n, ended_at + n
      FROM seq CROSS JOIN sessions WHERE sessions.event_id IS NOT NULL
    `);
  } finally { db.close(); }

  app = await auditServer(t, { dbPath });
  const detail = await app.json<{ event: EventDef; sessions: { id: string }[] }>(`/api/events/${event.id}`, 'GET', 200, undefined, cookie);
  assert.ok(detail.sessions.some((row) => row.id === eventRoom.id), 'Older event history disappeared after restart');
});

test('C9-08: a revoked moderator cookie cannot still perform privileged operations', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const room = await app.room(cookie);
  const existing = await app.connect('mod', room.code, { cookie });
  await existing.state('LOBBY');
  await app.json('/api/auth/logout', 'POST', 200, {}, cookie);
  const replay = await app.request('/api/me', { headers: { cookie } });
  if (existing.closeCode === undefined && existing.ws.readyState === existing.ws.OPEN) {
    existing.send({ t: 'mod', action: 'start', expectQ: -1 });
    existing.send({ t: 'ping' });
    await existing.next('pong').catch((error: unknown) => {
      if (existing.closeCode === undefined) throw error;
    });
  }
  const roomInfo = await app.json<{ state: string }>(`/api/play/${room.code}`, 'GET', 200);
  assert.deepEqual({ status: replay.status, state: roomInfo.state }, { status: 401, state: 'LOBBY' },
    'Logout left the copied cookie and an existing moderator socket authorized');
});

test('C9-09: a moderator cookie is refused on a foreign-origin WebSocket upgrade', async (t) => {
  const app = await auditServer(t, { env: { PUBLIC_URL: 'https://quiz.example.test' } });
  const cookie = await app.login();
  const room = await app.room(cookie);
  const foreign = await app.connect('mod', room.code, { cookie, origin: 'https://other.example.test' })
    .catch((error: unknown) => {
      if (error instanceof Error && /Unexpected server response: 40[13]/.test(error.message)) return null;
      throw error;
    });
  if (!foreign) return;
  const first = await foreign.next('state').catch((error: unknown) => {
    if (foreign.closeCode !== undefined) return foreign.closeCode;
    throw error;
  });
  if (typeof first !== 'number') {
    foreign.send({ t: 'mod', action: 'start', expectQ: -1 });
    await foreign.state('QUESTION');
  }
  assert.equal(first, WS_CLOSE.UNAUTHORIZED, 'Foreign origin received a moderator snapshot and was able to start the room');
});

test('C9-10: finished room results remain accessible to the player after a restart', async (t) => {
  const dbPath = await auditDb(t);
  let app = await auditServer(t, { dbPath });
  const cookie = await app.login();
  const room = await app.room(cookie);
  const player = await app.joinPlayer(room.code, 'Results');
  const mod = await app.connect('mod', room.code, { cookie });
  const client = await app.connect('player', room.code, { token: player.token });
  await client.state('LOBBY');
  mod.send({ t: 'mod', action: 'end', expectQ: -1 });
  await client.state('FINISHED');
  await app.stop();
  app = await auditServer(t, { dbPath });
  const restored = await app.connect('player', room.code, { token: player.token });
  await restored.state('FINISHED');
});

test('C9-13: changing an event email requirement takes effect for existing live rooms', async (t) => {
  const app = await auditServer(t);
  const cookie = await app.login();
  const event = await app.json<EventDef>('/api/events', 'POST', 201, { name: 'Flexible event', emailRequired: false }, cookie);
  const room = await app.room(cookie, { eventId: event.id });
  const updated = await app.json<EventDef>(`/api/events/${event.id}`, 'PUT', 200, { name: event.name, emailRequired: true }, cookie);
  assert.equal(updated.emailRequired, true);
  await app.json(`/api/play/${room.code}/join`, 'POST', 400, { name: 'No email' });
});

test('C9-14: unknown asset and API requests are not served the SPA document', async (t) => {
  const app = await auditServer(t, { staticFixture: true });
  const paths = ['/api', '/assets/removed.js'];
  const responses = await Promise.all(paths.map((path) => app.request(path)));
  assert.deepEqual(responses.map((response) => response.status), [404, 404]);
});

test('C9-16: built assets are cached immutably and HTML is revalidated', async (t) => {
  const app = await auditServer(t, { staticFixture: true });
  const home = await app.request('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const assetPath = (await home.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(assetPath);
  const asset = await app.request(assetPath);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await app.request('/mod')).headers.get('cache-control'), 'no-cache');
});
