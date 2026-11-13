import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRepo } from '../src/db/repo';
import type { QuizDef } from '../../shared/model';
import type { AnswerRow, SessionRow } from '../src/contracts';

const quiz = (id: string, n: number, mod = 'mod_a', updatedAt = 1000): QuizDef => ({
  id, moderatorId: mod, title: `Quiz ${id}`, emailMode: 'optional', scoring: 'speed', createdAt: 1000, updatedAt,
  questions: Array.from({ length: n }, (_, i) => ({
    id: `${id}_q${i}`, text: `Q${i}?`, imageUrl: i === 0 ? 'https://x.test/a.png' : null, options: ['a', 'b', 'c'], correctIndex: i % 3, timeLimitSec: 20, pointsMax: 1000,
  })),
});

const session = (id: string, code: string, q: QuizDef, createdAt = 2000): SessionRow => ({
  id, code, quizId: q.id, moderatorId: q.moderatorId, label: 'L', listed: true, joinOpen: true, state: 'LOBBY', qIndex: -1,
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
