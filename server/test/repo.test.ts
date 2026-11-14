import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRepo } from '../src/db/repo';
import type { QuizDef } from '../../shared/model';
import type { AnswerRow, SessionRow } from '../src/contracts';

const quiz = (id: string, n: number, mod = 'mod_a', updatedAt = 1000): QuizDef => ({
  id, moderatorId: mod, eventId: null, title: `Quiz ${id}`, emailMode: 'optional', scoring: 'speed', createdAt: 1000, updatedAt,
  questions: Array.from({ length: n }, (_, i) => ({
    id: `${id}_q${i}`, text: `Q${i}?`, imageUrl: i === 0 ? 'https://x.test/a.png' : null, options: ['a', 'b', 'c'], correctIndex: i % 3, timeLimitSec: 20, pointsMax: 1000,
  })),
});

const session = (id: string, code: string, q: QuizDef, createdAt = 2000): SessionRow => ({
  id, code, quizId: q.id, moderatorId: q.moderatorId, eventId: null, label: 'L', listed: true, joinOpen: true, state: 'LOBBY', qIndex: -1,
  qStartedAt: null, qEndsAt: null, quiz: q, createdAt, endedAt: null,
});

const ans = (pid: string, qid: string, extra: Partial<AnswerRow> = {}): AnswerRow => ({
  sessionId: 's1', playerId: pid, questionId: qid, qIndex: 0, choice: 1, correct: true, responseMs: 1234, points: 900, answeredAt: 5000, ...extra,
});

test('moderators upsert idempotently (also when username moves to new id)', () => {
  const repo = openRepo(':memory:');
  repo.upsertModerator({ id: 'mod_a', username: 'a', displayName: 'A', isSuper: false });
  repo.upsertModerator({ id: 'mod_a', username: 'a', displayName: 'A2', isSuper: true });
  repo.upsertModerator({ id: 'mod_a2', username: 'a', displayName: 'A3', isSuper: false });
  repo.close();
});

test('quiz save / replace / list / delete', () => {
  const repo = openRepo(':memory:');
  repo.saveQuiz(quiz('z1', 3));
  repo.saveQuiz(quiz('z2', 1, 'mod_b', 3000));
  let got = repo.getQuiz('z1')!;
  assert.equal(got.questions.length, 3);
  assert.deepEqual(got.questions[0].options, ['a', 'b', 'c']);
  assert.equal(got.questions[0].imageUrl, 'https://x.test/a.png');
  assert.equal(got.questions[1].imageUrl, null);
  assert.equal(got.scoring, 'speed');

  repo.saveQuiz({ ...quiz('z1', 2), title: 'Renamed', updatedAt: 5000 });
  got = repo.getQuiz('z1')!;
  assert.equal(got.title, 'Renamed');
  assert.equal(got.questions.length, 2);
  assert.deepEqual(got.questions.map((q) => q.id), ['z1_q0', 'z1_q1']);

  const all = repo.listQuizzes(null);
  assert.deepEqual(all.map((q) => q.id), ['z1', 'z2']); // newest updated first
  assert.equal(all[0].questionCount, 2);
  assert.deepEqual(repo.listQuizzes('mod_b').map((q) => q.id), ['z2']);

  repo.deleteQuiz('z1');
  assert.equal(repo.getQuiz('z1'), null);
  assert.equal(repo.getQuiz('nope'), null);
  repo.close();
});

test('sessions: insert, update, list, latest by code, unfinished', () => {
  const repo = openRepo(':memory:');
  const q = quiz('z1', 2);
  repo.insertSession(session('s1', '123456', q, 1000));
  repo.insertSession(session('s2', '123456', q, 2000));
  repo.insertSession({ ...session('s3', '654321', q, 3000), moderatorId: 'mod_b' });
  repo.updateSession('s1', { state: 'FINISHED', endedAt: 9999, listed: false, qIndex: 1, qStartedAt: 5, qEndsAt: 6 });
  repo.updateSession('s2', {}); // no-op must not throw

  const latest = repo.getLatestSessionByCode('123456')!;
  assert.equal(latest.id, 's2');
  assert.equal(latest.quiz.questions.length, 2);
  assert.equal(latest.listed, true);
  assert.equal(repo.getLatestSessionByCode('000000'), null);

  const s1 = repo.listSessions(null).find((s) => s.id === 's1')!;
  assert.equal(s1.state, 'FINISHED');
  assert.equal(s1.listed, false);
  assert.equal(s1.endedAt, 9999);
  assert.equal(s1.qIndex, 1);
  assert.deepEqual(repo.listSessions(null).map((s) => s.id), ['s3', 's2', 's1']);
  assert.deepEqual(repo.listSessions('mod_a').map((s) => s.id), ['s2', 's1']);
  assert.deepEqual(repo.loadUnfinishedSessions().map((s) => s.id).sort(), ['s2', 's3']);
  repo.close();
});

test('players: insert, update, list order, count excludes kicked', () => {
  const repo = openRepo(':memory:');
  repo.insertSession(session('s1', '123456', quiz('z1', 1)));
  const p = (id: string, joinedAt: number) => ({ id, sessionId: 's1', name: id, email: null, tokenHash: 'h', score: 0, kicked: false, joinedAt });
  repo.insertPlayer(p('p2', 20));
  repo.insertPlayer(p('p1', 10));
  repo.insertPlayer(p('p3', 30));
  repo.insertPlayer(p('p3', 30)); // duplicate ignored
  repo.updatePlayer('p3', { kicked: true });
  repo.updatePlayer('p1', { score: 1500, name: 'Renamed' });
  const list = repo.listPlayers('s1');
  assert.deepEqual(list.map((x) => x.id), ['p1', 'p2', 'p3']);
  assert.equal(list[0].score, 1500);
  assert.equal(list[0].name, 'Renamed');
  assert.equal(list[2].kicked, true);
  assert.equal(repo.countPlayers('s1'), 2);
  repo.close();
});

test('answers: buffered, deduped, flushed by timer/flush/listAnswers/close', async () => {
  const repo = openRepo(':memory:');
  repo.queueAnswer(ans('p1', 'q1'));
  repo.queueAnswer(ans('p1', 'q1', { choice: 3 })); // duplicate PK → ignored, first wins
  repo.queueAnswer(ans('p2', 'q1', { correct: false, points: 0 }));
  const rows = repo.listAnswers('s1');
  assert.equal(rows.length, 2);
  const a1 = rows.find((r) => r.playerId === 'p1')!;
  assert.equal(a1.choice, 1);
  assert.equal(a1.correct, true);
  assert.equal(rows.find((r) => r.playerId === 'p2')!.correct, false);

  // duplicates across flushes never throw
  repo.queueAnswer(ans('p1', 'q1'));
  repo.flush();
  assert.equal(repo.listAnswers('s1').length, 2);

  // timer flush (100ms)
  repo.queueAnswer(ans('p3', 'q1'));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(repo.listAnswers('s1').length, 3);

  // burst
  for (let i = 0; i < 500; i++) repo.queueAnswer(ans(`b${i}`, 'q2', { qIndex: 1 }));
  repo.flush();
  assert.equal(repo.listAnswers('s1').length, 503);
  repo.close();
  repo.close(); // idempotent
  repo.queueAnswer(ans('late', 'q1')); // after close: silently dropped
});

test('recordAnswer: answer row + score in one transaction; dedupe; score untouched when newScore is null', () => {
  const repo = openRepo(':memory:');
  const q = quiz('rq', 1);
  repo.saveQuiz(q);
  repo.insertSession(session('s1', '510001', q));
  repo.insertPlayer({ id: 'p1', sessionId: 's1', name: 'A', email: null, tokenHash: 'h1', score: 0, kicked: false, joinedAt: 1 });
  repo.insertPlayer({ id: 'p2', sessionId: 's1', name: 'B', email: null, tokenHash: 'h2', score: 7, kicked: false, joinedAt: 2 });
  repo.recordAnswer(ans('p1', 'q1', { points: 900 }), 'p1', 900);
  repo.recordAnswer(ans('p2', 'q1', { correct: false, points: 0 }), 'p2', null);
  // visible immediately, no flush needed
  assert.equal(repo.listAnswers('s1').length, 2);
  assert.equal(repo.listPlayers('s1').find((p) => p.id === 'p1')!.score, 900);
  assert.equal(repo.listPlayers('s1').find((p) => p.id === 'p2')!.score, 7);
  repo.recordAnswer(ans('p1', 'q1', { choice: 3 }), 'p1', 900); // duplicate PK → ignored, never throws
  assert.equal(repo.listAnswers('s1').find((a) => a.playerId === 'p1')!.choice, 1);
  repo.close();
  assert.throws(() => repo.recordAnswer(ans('p3', 'q1'), 'p3', 1)); // closed → throws (caller falls back)
});

test('recordAnswer perf: 2000 answers (200/s burst x10) stay < 1 ms each on a file db', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'c9perf-'));
  try {
    const repo = openRepo(join(dir, 'p.db'));
    const q = quiz('pq', 1);
    repo.saveQuiz(q);
    repo.insertSession(session('s1', '510002', q));
    const N = 2000;
    for (let i = 0; i < N; i++) repo.insertPlayer({ id: `pp${i}`, sessionId: 's1', name: `N${i}`, email: null, tokenHash: `h${i}`, score: 0, kicked: false, joinedAt: i });
    const t0 = performance.now();
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      repo.recordAnswer(ans(`pp${i}`, 'q1', { points: 100 + i }), `pp${i}`, 100 + i);
      worst = Math.max(worst, performance.now() - t);
    }
    const avg = (performance.now() - t0) / N;
    console.log(`# recordAnswer: avg ${avg.toFixed(3)}ms, worst ${worst.toFixed(2)}ms over ${N}`);
    assert.ok(avg < 1, `recordAnswer avg ${avg.toFixed(3)}ms`);
    assert.equal(repo.listAnswers('s1').length, N);
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hard crash (SIGKILL, no flush/close): recordAnswer keeps answers and scores consistent', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = fileURLToPath(new URL('./repoCrashChild.ts', import.meta.url));
  const { pathToFileURL } = await import('node:url');
  const tsxLoader = pathToFileURL(fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;
  const dir = mkdtempSync(join(tmpdir(), 'c9crash-'));
  const N = 50;
  const prepare = (path: string) => {
    const r = openRepo(path);
    const q = quiz('cq', 1);
    r.saveQuiz(q);
    r.insertSession(session('s1', '510003', q));
    for (let i = 0; i < N; i++) r.insertPlayer({ id: `p${i}`, sessionId: 's1', name: `N${i}`, email: null, tokenHash: `h${i}`, score: 0, kicked: false, joinedAt: i });
    r.close();
  };
  const crashAndCheck = (mode: 'record' | 'legacy') => {
    const path = join(dir, `${mode}.db`);
    prepare(path);
    const res = spawnSync(process.execPath, ['--import', tsxLoader, child, path, mode, String(N)], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.signal, 'SIGKILL', `child should die by SIGKILL: ${res.stderr}`);
    assert.match(res.stdout, /written/);
    const r = openRepo(path);
    const answers = r.listAnswers('s1');
    const players = r.listPlayers('s1');
    r.close();
    const scored = players.filter((p) => p.score > 0);
    const byPlayer = new Map(answers.map((a) => [a.playerId, a.points]));
    const consistent = players.every((p) => p.score === (byPlayer.get(p.id) ?? 0));
    return { answers: answers.length, scored: scored.length, consistent };
  };
  try {
    const rec = crashAndCheck('record');
    assert.deepEqual(rec, { answers: N, scored: N, consistent: true });
    // the pre-fix path (score now, row in the 100 ms buffer) loses rows on the same crash — shows what this guards against
    const legacy = crashAndCheck('legacy');
    assert.equal(legacy.scored, N);
    assert.equal(legacy.answers, 0);
    assert.equal(legacy.consistent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close flushes pending answers to file db', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'c9repo-'));
  const path = join(dir, 'x.db');
  try {
    const r1 = openRepo(path);
    r1.queueAnswer(ans('p1', 'q1'));
    r1.close();
    const r2 = openRepo(path);
    assert.equal(r2.listAnswers('s1').length, 1);
    r2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── events (v2) ─────────────
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import type { EventDef } from '../../shared/model';

/** Verbatim schema.sql from before events (HEAD~1 of the events change) — what production DBs look like today. */
const OLD_SCHEMA_V1 = `
-- Cloud 9 schema. Applied idempotently at boot by db/repo.ts (Agent B).
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS moderators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_super INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  moderator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  email_mode TEXT NOT NULL CHECK (email_mode IN ('off','optional','required')),
  scoring TEXT NOT NULL DEFAULT 'speed' CHECK (scoring IN ('speed','flat')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  image_url TEXT,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  time_limit_sec INTEGER NOT NULL DEFAULT 20,
  points_max INTEGER NOT NULL DEFAULT 1000
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  listed INTEGER NOT NULL DEFAULT 1,
  join_open INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  current_q INTEGER NOT NULL DEFAULT -1,
  q_started_at INTEGER,
  q_ends_at INTEGER,
  quiz_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  token_hash TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  kicked INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id, joined_at);

CREATE TABLE IF NOT EXISTS answers (
  session_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  q_index INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  points INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, player_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_session_q ON answers(session_id, question_id);
`;

const ev = (id: string, mod = 'mod_a', createdAt = 1000, emailRequired = true): EventDef =>
  ({ id, moderatorId: mod, name: `Event ${id}`, emailRequired, createdAt, updatedAt: createdAt });

test('migration: DB created by the old (v1) schema keeps data and gains event columns; idempotent', () => {
  const dir = mkdtempSync(pjoin(tmpdir(), 'c9mig-'));
  const file = pjoin(dir, 'old.db');
  try {
    const old = new Database(file);
    old.exec(OLD_SCHEMA_V1);
    old.prepare(`INSERT INTO moderators (id, username, display_name, is_super, created_at) VALUES ('mod_a','a','A',0,1)`).run();
    old.prepare(`INSERT INTO quizzes (id, moderator_id, title, email_mode, scoring, created_at, updated_at) VALUES ('z1','mod_a','Old quiz','optional','speed',1,2)`).run();
    old.prepare(`INSERT INTO questions (id, quiz_id, position, text, image_url, options_json, correct_index, time_limit_sec, points_max)
                 VALUES ('z1_q0','z1',0,'Q?',NULL,'["a","b"]',1,20,1000)`).run();
    const snap = JSON.stringify({ id: 'z1', moderatorId: 'mod_a', title: 'Old quiz', emailMode: 'optional', scoring: 'speed', questions: [], createdAt: 1, updatedAt: 2 });
    old.prepare(`INSERT INTO sessions (id, code, quiz_id, moderator_id, label, listed, join_open, state, current_q, quiz_json, created_at)
                 VALUES ('s1','123456','z1','mod_a','L',1,1,'LOBBY',-1,?,5)`).run(snap);
    old.prepare(`INSERT INTO players (id, session_id, name, email, token_hash, score, kicked, joined_at) VALUES ('p1','s1','Anu','anu@x.test','h',700,0,6)`).run();
    old.prepare(`INSERT INTO answers (session_id, player_id, question_id, q_index, choice, correct, response_ms, points, answered_at)
                 VALUES ('s1','p1','z1_q0',0,1,1,100,700,7)`).run();
    old.close();

    for (let round = 0; round < 2; round++) { // second open must be a no-op
      const repo = openRepo(file);
      const q = repo.getQuiz('z1')!;
      assert.equal(q.title, 'Old quiz');
      assert.equal(q.eventId, null);
      assert.equal(q.questions.length, 1);
      assert.equal(repo.listQuizzes('mod_a')[0].eventId, null);
      assert.equal(repo.listQuizzes('mod_a', 'none').length, 1);
      const s = repo.getLatestSessionByCode('123456')!;
      assert.equal(s.eventId, null);
      assert.equal(s.quiz.eventId, null);
      assert.equal(repo.loadUnfinishedSessions().length, 1);
      assert.equal(repo.listPlayers('s1')[0].score, 700);
      assert.equal(repo.listAnswers('s1').length, 1);
      // new features work on the migrated DB
      if (round === 0) {
        repo.saveEvent(ev('e1'));
        repo.saveQuiz({ ...q, id: 'z2', eventId: 'e1', questions: q.questions.map((x) => ({ ...x, id: 'z2_' + x.id })) });
      }
      assert.equal(repo.listQuizzes(null, 'e1').length, 1);
      repo.close();
    }
    const raw = new Database(file, { readonly: true });
    const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('quizzes').includes('event_id'));
    assert.ok(cols('sessions').includes('event_id'));
    const idx = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((r) => r.name);
    for (const n of ['idx_quizzes_event', 'idx_sessions_event', 'idx_players_email']) assert.ok(idx.includes(n), n);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events: save / get / list counts / delete detaches quizzes, keeps session history', () => {
  const repo = openRepo(':memory:');
  repo.saveEvent(ev('e1', 'mod_a', 1000));
  repo.saveEvent(ev('e2', 'mod_b', 2000, false));
  assert.deepEqual(repo.getEvent('e2'), ev('e2', 'mod_b', 2000, false));
  assert.equal(repo.getEvent('nope'), null);
  repo.saveEvent({ ...ev('e1'), name: 'Renamed', updatedAt: 3000 });
  assert.equal(repo.getEvent('e1')!.name, 'Renamed');

  const qa = { ...quiz('za', 2, 'mod_a', 1000), eventId: 'e1' };
  const qb = { ...quiz('zb', 1, 'mod_b', 2000), eventId: 'e1' };
  const qc = quiz('zc', 1, 'mod_a', 3000);
  [qa, qb, qc].forEach((q) => repo.saveQuiz(q));
  assert.equal(repo.getQuiz('za')!.eventId, 'e1');
  repo.insertSession({ ...session('s1', '111111', qa), eventId: 'e1' });
  repo.insertSession(session('s2', '222222', qc));
  assert.equal(repo.getLatestSessionByCode('111111')!.eventId, 'e1');
  assert.equal(repo.getLatestSessionByCode('222222')!.eventId, null);

  const list = repo.listEvents();
  assert.deepEqual(list.map((e) => [e.id, e.quizCount, e.sessionCount]), [['e2', 0, 0], ['e1', 2, 1]]);

  // listQuizzes filters
  assert.deepEqual(repo.listQuizzes(null, 'e1').map((q) => q.id), ['zb', 'za']);
  assert.deepEqual(repo.listQuizzes('mod_a', 'e1').map((q) => q.id), ['za']);
  assert.deepEqual(repo.listQuizzes('mod_a', 'none').map((q) => q.id), ['zc']);
  assert.deepEqual(repo.listQuizzes(null, 'none').map((q) => q.id), ['zc']);
  assert.deepEqual(repo.listQuizzes('mod_a').map((q) => [q.id, q.eventId]), [['zc', null], ['za', 'e1']]);

  repo.deleteEvent('e1');
  assert.equal(repo.getEvent('e1'), null);
  assert.equal(repo.getQuiz('za')!.eventId, null);
  assert.equal(repo.getQuiz('za')!.questions.length, 2);
  assert.equal(repo.getLatestSessionByCode('111111')!.eventId, 'e1'); // history kept
  repo.close();
});

test('events: leaderboard aggregates by lowercase email, excludes kicked, names from latest join, fast', () => {
  const repo = openRepo(':memory:');
  repo.saveEvent(ev('e1'));
  const q = { ...quiz('za', 1), eventId: 'e1' };
  repo.saveQuiz(q);
  repo.insertSession({ ...session('s1', '111111', q, 1), eventId: 'e1' });
  repo.insertSession({ ...session('s2', '222222', q, 2), eventId: 'e1' });
  repo.insertSession({ ...session('s3', '333333', q, 3), eventId: null }); // not in event
  const P = (id: string, sid: string, name: string, email: string | null, score: number, joinedAt: number, kicked = false) =>
    repo.insertPlayer({ id, sessionId: sid, name, email, tokenHash: 'h' + id, score, kicked, joinedAt });
  P('a1', 's1', 'Anu', 'anu@x.test', 500, 10);
  P('a2', 's2', 'Anu K', 'ANU@x.test', 700, 20);
  P('b1', 's1', 'Bob', 'bob@x.test', 1200, 11);
  P('c1', 's1', 'NoMail', null, 1200, 12);
  P('d1', 's2', 'EmptyMail', '', 50, 13);
  P('k1', 's1', 'Kicked', 'k@x.test', 5000, 14, true);
  P('o1', 's3', 'Other', 'anu@x.test', 9999, 15);
  repo.updatePlayer('a2', { score: 800, tokenHash: 'newhash' });
  assert.equal(repo.listPlayers('s2').find((p) => p.id === 'a2')!.tokenHash, 'newhash');

  const board = repo.eventLeaderboard('e1');
  assert.deepEqual(board, [
    { key: 'anu@x.test', name: 'Anu K', email: 'anu@x.test', score: 1300, quizzesPlayed: 2, rank: 1 },
    { key: 'bob@x.test', name: 'Bob', email: 'bob@x.test', score: 1200, quizzesPlayed: 1, rank: 2 },
    { key: 'p:c1', name: 'NoMail', email: null, score: 1200, quizzesPlayed: 1, rank: 3 },
    { key: 'p:d1', name: 'EmptyMail', email: null, score: 50, quizzesPlayed: 1, rank: 4 },
  ]);
  assert.deepEqual(repo.eventLeaderboard('nope'), []);

  // perf: 5k players across 10 sessions
  for (let s = 0; s < 10; s++) repo.insertSession({ ...session(`ps${s}`, String(400000 + s), q, 100 + s), eventId: 'e1' });
  for (let i = 0; i < 5000; i++) P(`pp${i}`, `ps${i % 10}`, `N${i}`, `u${i % 3000}@load.test`, (i * 37) % 5000, 1000 + i);
  repo.eventLeaderboard('e1');
  const t0 = performance.now();
  const big = repo.eventLeaderboard('e1');
  const ms = performance.now() - t0;
  assert.equal(big.length, 4 + 3000);
  assert.ok(ms < 50, `eventLeaderboard took ${ms.toFixed(1)}ms`);
  console.log(`# eventLeaderboard @5k players: ${ms.toFixed(2)}ms`);
  repo.close();
});
