// Dev-only fake data so the moderator + present screens can be rendered without a backend.
// Usage: /mod?fixture=dashboard, /mod?fixture=room-question, /present/123456?fixture=present-lobby …
import type { Me } from '../../../shared/api';
import type { QuizDef, QuizListItem, SessionSummary, LeaderEntry, RoomState } from '../../../shared/model';
import type { HostSnapshot, QuestionPublic } from '../../../shared/protocol';

export const FIXTURE_NAMES = [
  'login', 'dashboard', 'editor', 'import',
  'room-lobby', 'room-question', 'room-closed', 'room-reveal', 'room-leaderboard', 'room-finished',
  'present-lobby', 'present-question', 'present-closed', 'present-reveal', 'present-leaderboard', 'present-finished',
] as const;

export const fxMe: Me = { id: 'm1', username: 'anu', displayName: 'Anu Mathew', isSuper: false };

const t0 = Date.parse('2026-11-14T09:30:00+05:30');
const CODE = '482913';
const JOIN = 'https://cloud9.t4gc.in/join/482913';

export const fxQuizzes: QuizListItem[] = [
  { id: 'q1', moderatorId: 'm1', title: 'Cloud Basics Warm-up', questionCount: 10, updatedAt: t0 - 3600_000 },
  { id: 'q2', moderatorId: 'm1', title: 'Kubernetes Lightning Round', questionCount: 15, updatedAt: t0 - 86400_000 },
  { id: 'q3', moderatorId: 'm1', title: 'Serverless & Functions — finals', questionCount: 8, updatedAt: t0 - 5 * 86400_000 },
];

export const fxSessions: SessionSummary[] = [
  { id: 's1', code: CODE, quizId: 'q1', moderatorId: 'm1', title: 'Cloud Basics Warm-up', label: 'Hall A · Round 1', state: 'QUESTION', qIndex: 2, total: 10, players: 143, listed: true, joinOpen: true, joinUrl: JOIN, createdAt: t0, endedAt: null },
  { id: 's2', code: '190245', quizId: 'q2', moderatorId: 'm1', title: 'Kubernetes Lightning Round', label: 'Workshop room', state: 'LOBBY', qIndex: -1, total: 15, players: 12, listed: false, joinOpen: true, joinUrl: 'https://cloud9.t4gc.in/join/190245', createdAt: t0 + 60_000, endedAt: null },
  { id: 's3', code: '773104', quizId: 'q3', moderatorId: 'm1', title: 'Serverless & Functions — finals', label: 'Main stage', state: 'FINISHED', qIndex: 7, total: 8, players: 188, listed: true, joinOpen: false, joinUrl: 'https://cloud9.t4gc.in/join/773104', createdAt: t0 - 7200_000, endedAt: t0 - 5400_000 },
];

export const fxQuiz: QuizDef = {
  id: 'q1', moderatorId: 'm1', title: 'Cloud Basics Warm-up', emailMode: 'optional', scoring: 'speed', createdAt: t0 - 86400_000, updatedAt: t0 - 3600_000,
  questions: [
    { id: 'a', text: 'Which Google Cloud service runs containers without you managing any servers?', imageUrl: null, options: ['Cloud Run', 'Compute Engine', 'Cloud Storage', 'BigQuery'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 },
    { id: 'b', text: 'What does “IAM” stand for?', imageUrl: null, options: ['Internet Access Manager', 'Identity and Access Management', 'Instance Allocation Model'], correctIndex: 1, timeLimitSec: 15, pointsMax: 1000 },
    { id: 'c', text: 'True or false: a region contains multiple zones.', imageUrl: 'https://example.com/regions.png', options: ['True', 'False'], correctIndex: 0, timeLimitSec: 10, pointsMax: 1000 },
  ],
};

const NAMES = ['Anu', 'Rahul K', 'Meera', 'Dev', 'Fathima', 'Arjun', 'Sneha', 'Vishnu', 'Aditi', 'Nikhil', 'Sana', 'Kiran', 'Joel', 'Divya',
  'Rohan', 'Ishaan', 'Lakshmi', 'Gautham', 'Ananya', 'Varun', 'Hari', 'Neha', 'Akash', 'Riya', 'Siddharth', 'Pooja', 'Tom', 'Aisha',
  'Manu', 'Keerthana', 'Abhijith', 'Shruti', 'Yusuf', 'Nandana', 'Amal', 'Gopika', 'Jasim', 'Parvathy', 'Sreeram', 'Diya', 'Ajmal',
  'Theertha', 'Basil', 'Malavika', 'Nived', 'Ann Maria', 'Rizwan', 'Devika'];

const players = (scored: boolean) => NAMES.map((name, i) => ({
  id: `p${i}`, name, connected: i % 11 !== 5,
  score: scored ? Math.max(0, 2900 - i * 57 - ((i * 37) % 200)) : 0,
}));

const leaderboard = (): LeaderEntry[] =>
  players(true).slice().sort((a, b) => b.score - a.score).slice(0, 10).map((p, i) => ({ playerId: p.id, name: p.name, score: p.score, rank: i + 1 }));

function question(qIndex: number, now: number, state: RoomState): QuestionPublic {
  const q = fxQuiz.questions[0];
  const started = state === 'QUESTION' ? now - 7_400 : now - 40_000;
  return { qIndex, total: 10, text: q.text, imageUrl: null, options: q.options, timeLimitSec: 20, startedAt: started, endsAt: started + 20_000 };
}

/** Build a HostSnapshot for a fixture name like 'room-question' / 'present-reveal'. */
export function hostFixture(name: string): HostSnapshot | null {
  const m = /^(room|present)-(lobby|question|closed|reveal|leaderboard|finished)$/.exec(name);
  if (!m) return null;
  const role = m[1] === 'room' ? 'mod' : 'present';
  const state = m[2].toUpperCase() as RoomState;
  const now = Date.now();
  const inGame = state !== 'LOBBY';
  const qIndex = state === 'LOBBY' ? -1 : state === 'FINISHED' ? 9 : 2;
  const ps = players(inGame && state !== 'QUESTION');
  const showCorrect = role === 'mod' ? inGame && state !== 'FINISHED' : state === 'REVEAL' || state === 'LEADERBOARD';
  return {
    role, code: CODE, title: 'Cloud Basics Warm-up', label: 'Hall A · Round 1', state, v: 12, serverNow: now, joinUrl: JOIN,
    listed: true, joinOpen: state === 'LOBBY', qIndex, total: 10, playerCount: ps.length, players: ps,
    question: inGame && state !== 'FINISHED' ? question(qIndex, now, state) : null,
    correctIndex: showCorrect ? 0 : null,
    answered: state === 'QUESTION' ? 31 : inGame ? 44 : 0,
    distribution: state === 'CLOSED' || state === 'REVEAL' || state === 'LEADERBOARD' ? [27, 9, 5, 3] : null,
    leaderboard: inGame ? leaderboard() : [],
    nextQuestion: role === 'mod' && state !== 'FINISHED'
      ? { text: state === 'LOBBY' ? fxQuiz.questions[0].text : fxQuiz.questions[1].text, options: state === 'LOBBY' ? fxQuiz.questions[0].options : fxQuiz.questions[1].options, correctIndex: state === 'LOBBY' ? 0 : 1 }
      : null,
  };
}

/** Fake GET responses for the moderator API in fixture mode. Throws {status:401} for the login fixture. */
export function fixtureGet(fixture: string, url: string): unknown {
  if (url === '/api/me') {
    if (fixture === 'login') throw Object.assign(new Error('Not signed in'), { status: 401, code: 'unauthorized' });
    return fxMe;
  }
  if (url === '/api/quizzes') return fxQuizzes;
  if (url === '/api/sessions') return fxSessions;
  if (url.startsWith('/api/quizzes/')) return fxQuiz;
  return null;
}

/** Path a fixture should render (ModApp ignores the real path in fixture mode). */
export function fixturePath(fixture: string): string {
  if (fixture === 'login' || fixture === 'dashboard') return '/mod';
  if (fixture === 'editor') return '/mod/quiz/q1';
  if (fixture === 'import') return '/mod/import';
  if (fixture.startsWith('room-')) return `/mod/room/${CODE}`;
  return '/mod';
}

/** A fake QR-looking SVG (data URL) so fixture screenshots have something in the QR slot. */
export function fakeQr(): string {
  const n = 29; let rects = '';
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const finder = (x: number, y: number) => `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
    if (!inFinder && rnd() > 0.52) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#18181B">${rects}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
