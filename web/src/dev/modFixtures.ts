// Dev-only fake data so the moderator + present screens can be rendered without a backend.
// Usage: /mod?fixture=dashboard, /mod?fixture=room-question, /present/123456?fixture=present-lobby …
import type { Me, EventDetail } from '../../../shared/api';
import type { QuizDef, QuizListItem, SessionSummary, LeaderEntry, RoomState, EventListItem, EventLeaderEntry, BoardTop } from '../../../shared/model';
import type { HostSnapshot, QuestionPublic } from '../../../shared/protocol';

export const FIXTURE_NAMES = [
  'login', 'dashboard', 'editor', 'import',
  'room-lobby', 'room-question', 'room-closed', 'room-reveal', 'room-leaderboard', 'room-finished',
  'dashboard-events', 'event-mine', 'event-other', 'event-leaderboard', 'event-leaderboard-super', 'editor-event', 'import-event',
  'room-leaderboard-event', 'room-finished-event',
  'present-lobby', 'present-question', 'present-closed', 'present-reveal', 'present-leaderboard', 'present-finished',
] as const;

export const fxMe: Me = { id: 'm1', username: 'anu', displayName: 'Anu Mathew', isSuper: false };

const t0 = Date.parse('2026-11-14T09:30:00+05:30');
const CODE = '482913';
const JOIN = 'https://cloud9.t4gc.in/join/482913';

const EV = "CCD Kochi '26";

export const fxQuizzes: QuizListItem[] = [
  { id: 'q1', moderatorId: 'm1', eventId: 'ev1', title: 'Cloud Basics Warm-up', questionCount: 10, updatedAt: t0 - 3600_000 },
  { id: 'q2', moderatorId: 'm1', eventId: null, title: 'Kubernetes Lightning Round', questionCount: 15, updatedAt: t0 - 86400_000 },
  { id: 'q3', moderatorId: 'm1', eventId: 'ev1', title: 'Serverless & Functions — finals', questionCount: 8, updatedAt: t0 - 5 * 86400_000 },
];
const fxStandalone: QuizListItem[] = [
  fxQuizzes[1],
  { id: 'q4', moderatorId: 'm1', eventId: null, title: 'Team offsite icebreaker', questionCount: 6, updatedAt: t0 - 9 * 86400_000 },
];

export const fxSessions: SessionSummary[] = [
  { id: 's1', code: CODE, quizId: 'q1', moderatorId: 'm1', eventId: 'ev1', eventName: EV, title: 'Cloud Basics Warm-up', label: 'Hall A · Round 1', state: 'QUESTION', qIndex: 2, total: 10, players: 143, listed: true, joinOpen: true, joinUrl: JOIN, createdAt: t0, endedAt: null },
  { id: 's2', code: '190245', quizId: 'q2', moderatorId: 'm1', eventId: null, eventName: null, title: 'Kubernetes Lightning Round', label: 'Workshop room', state: 'LOBBY', qIndex: -1, total: 15, players: 12, listed: false, joinOpen: true, joinUrl: 'https://cloud9.t4gc.in/join/190245', createdAt: t0 + 60_000, endedAt: null },
  { id: 's3', code: '773104', quizId: 'q3', moderatorId: 'm1', eventId: 'ev1', eventName: EV, title: 'Serverless & Functions — finals', label: 'Main stage', state: 'FINISHED', qIndex: 7, total: 8, players: 188, listed: true, joinOpen: false, joinUrl: 'https://cloud9.t4gc.in/join/773104', createdAt: t0 - 7200_000, endedAt: t0 - 5400_000 },
];

export const fxEvents: EventListItem[] = [
  { id: 'ev1', moderatorId: 'm1', name: EV, emailRequired: true, createdAt: t0 - 2 * 86400_000, updatedAt: t0 - 3600_000, quizCount: 5, sessionCount: 6, liveSessions: 2 },
  { id: 'ev2', moderatorId: 'm2', name: 'GDG Kochi DevFest Warm-up', emailRequired: false, createdAt: t0 - 6 * 86400_000, updatedAt: t0 - 4 * 86400_000, quizCount: 2, sessionCount: 3, liveSessions: 0 },
  { id: 'ev3', moderatorId: 'm3', name: 'Women Techmakers Kochi', emailRequired: true, createdAt: t0 - 9 * 86400_000, updatedAt: t0 - 9 * 86400_000, quizCount: 0, sessionCount: 0, liveSessions: 0 },
];

function eventDetail(id: string): EventDetail {
  const ev = fxEvents.find((e) => e.id === id) ?? fxEvents[0];
  const { quizCount: _a, sessionCount: _b, liveSessions: _c, ...event } = ev;
  if (ev.id === 'ev2') {
    return {
      event,
      quizzes: [
        { id: 'q20', moderatorId: 'm2', eventId: 'ev2', title: 'Android & Flutter trivia', questionCount: 12, updatedAt: t0 - 4 * 86400_000 },
        { id: 'q21', moderatorId: 'm1', eventId: 'ev2', title: 'Firebase quickfire', questionCount: 7, updatedAt: t0 - 5 * 86400_000 },
      ],
      sessions: [
        { id: 's20', code: '551208', quizId: 'q20', moderatorId: 'm2', eventId: 'ev2', eventName: ev.name, title: 'Android & Flutter trivia', label: 'Auditorium', state: 'FINISHED', qIndex: 11, total: 12, players: 96, listed: true, joinOpen: false, joinUrl: 'https://cloud9.t4gc.in/join/551208', createdAt: t0 - 4 * 86400_000, endedAt: t0 - 4 * 86400_000 + 1800_000 },
      ],
    };
  }
  return {
    event,
    quizzes: [
      fxQuizzes[0],
      { id: 'q10', moderatorId: 'm2', eventId: 'ev1', title: 'Hall B · Security & IAM', questionCount: 12, updatedAt: t0 - 7200_000 },
      fxQuizzes[2],
      { id: 'q11', moderatorId: 'm3', eventId: 'ev1', title: 'Hall C · Data & BigQuery', questionCount: 10, updatedAt: t0 - 3 * 3600_000 },
      { id: 'q12', moderatorId: 'm2', eventId: 'ev1', title: 'Closing ceremony mega quiz', questionCount: 20, updatedAt: t0 - 86400_000 },
    ],
    sessions: [
      fxSessions[0],
      { id: 's10', code: '305577', quizId: 'q10', moderatorId: 'm2', eventId: 'ev1', eventName: EV, title: 'Hall B · Security & IAM', label: 'Hall B', state: 'LOBBY', qIndex: -1, total: 12, players: 37, listed: true, joinOpen: true, joinUrl: 'https://cloud9.t4gc.in/join/305577', createdAt: t0 + 120_000, endedAt: null },
      fxSessions[2],
      { id: 's11', code: '640021', quizId: 'q11', moderatorId: 'm3', eventId: 'ev1', eventName: EV, title: 'Hall C · Data & BigQuery', label: 'Hall C · Morning', state: 'FINISHED', qIndex: 9, total: 10, players: 121, listed: true, joinOpen: false, joinUrl: 'https://cloud9.t4gc.in/join/640021', createdAt: t0 - 3 * 3600_000, endedAt: t0 - 2 * 3600_000 },
    ],
  };
}

function eventBoard(): EventLeaderEntry[] {
  return NAMES.slice(0, 25).map((name, i) => {
    const handle = name.toLowerCase().replace(/[^a-z]+/g, '.') + (i % 3 === 0 ? '' : String(90 + i));
    const domain = ['gmail.com', 'outlook.com', 'cusat.ac.in', 'yahoo.co.in'][i % 4];
    return {
      key: `${handle}@${domain}`, name, email: `${handle}@${domain}`,
      score: Math.max(400, 8640 - i * 291 - ((i * 53) % 170)), quizzesPlayed: Math.max(1, 4 - Math.floor(i / 7)), rank: i + 1,
    };
  });
}

function eventTop(): BoardTop[] {
  return eventBoard().slice(0, 10).map((e) => ({ name: e.name, score: e.score, rank: e.rank }));
}

export const fxQuiz: QuizDef = {
  id: 'q1', moderatorId: 'm1', eventId: 'ev1', title: 'Cloud Basics Warm-up', emailMode: 'optional', scoring: 'speed', createdAt: t0 - 86400_000, updatedAt: t0 - 3600_000,
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
  const m = /^(room|present)-(lobby|question|closed|reveal|leaderboard|finished)(-event)?$/.exec(name);
  if (!m) return null;
  const withEvent = !!m[3];
  const role = m[1] === 'room' ? 'mod' : 'present';
  const state = m[2].toUpperCase() as RoomState;
  const now = Date.now();
  const inGame = state !== 'LOBBY';
  const qIndex = state === 'LOBBY' ? -1 : state === 'FINISHED' ? 9 : 2;
  const ps = players(inGame && state !== 'QUESTION');
  const showCorrect = role === 'mod' ? inGame && state !== 'FINISHED' : state === 'REVEAL' || state === 'LEADERBOARD';
  return {
    role, code: CODE, eventId: null, title: 'Cloud Basics Warm-up', label: 'Hall A · Round 1', state, v: 12, serverNow: now, joinUrl: JOIN,
    listed: true, joinOpen: state === 'LOBBY', qIndex, total: 10, playerCount: ps.length, players: ps,
    question: inGame && state !== 'FINISHED' ? question(qIndex, now, state) : null,
    correctIndex: showCorrect ? 0 : null,
    answered: state === 'QUESTION' ? 31 : inGame ? 44 : 0,
    distribution: state === 'CLOSED' || state === 'REVEAL' || state === 'LEADERBOARD' ? [27, 9, 5, 3] : null,
    leaderboard: inGame ? leaderboard() : [],
    eventName: withEvent ? EV : null,
    eventBoard: withEvent && (state === 'LEADERBOARD' || state === 'FINISHED') ? { eventName: EV, top: eventTop(), total: 412 } : null,
    nextQuestion: role === 'mod' && state !== 'FINISHED'
      ? { text: state === 'LOBBY' ? fxQuiz.questions[0].text : fxQuiz.questions[1].text, options: state === 'LOBBY' ? fxQuiz.questions[0].options : fxQuiz.questions[1].options, correctIndex: state === 'LOBBY' ? 0 : 1 }
      : null,
  };
}

/** Fake GET responses for the moderator API in fixture mode. Throws {status:401} for the login fixture. */
export function fixtureGet(fixture: string, url: string): unknown {
  if (url === '/api/me') {
    if (fixture === 'login') throw Object.assign(new Error('Not signed in'), { status: 401, code: 'unauthorized' });
    return fixture === 'event-leaderboard-super' ? { ...fxMe, isSuper: true } : fxMe;
  }
  if (url === '/api/quizzes') return fxQuizzes;
  if (url === '/api/quizzes?eventId=none') return fxStandalone;
  if (url === '/api/sessions') return fxSessions;
  if (url.startsWith('/api/quizzes/')) {
    if (fixture === 'editor') return { ...fxQuiz, eventId: null };
    return fxQuiz;
  }
  if (url === '/api/events') return fxEvents;
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/events\/([^/]+)\/leaderboard$/.exec(url))) {
    if (m[1] === 'ev3') return [];
    // Like the server: emails only for super moderators.
    return fixture === 'event-leaderboard-super' ? eventBoard() : eventBoard().map((e) => ({ ...e, email: null }));
  }
  if ((m = /^\/api\/events\/([^/]+)$/.exec(url))) return eventDetail(m[1]);
  return null;
}

/** Path a fixture should render (ModApp ignores the real path in fixture mode). */
export function fixturePath(fixture: string): string {
  if (fixture === 'login' || fixture === 'dashboard') return '/mod';
  if (fixture === 'dashboard-events') return '/mod';
  if (fixture === 'editor' || fixture === 'editor-event') return '/mod/quiz/q1';
  if (fixture === 'import' || fixture === 'import-event') return '/mod/import';
  if (fixture === 'event-mine' || fixture.startsWith('event-leaderboard')) return '/mod/event/ev1';
  if (fixture === 'event-other') return '/mod/event/ev2';
  if (fixture.startsWith('room-')) return `/mod/room/${CODE}`;
  return '/mod';
}

/** Query params a fixture pretends to have (e.g. ?event= for import-event). */
export function fixtureParam(fixture: string, name: string): string | null {
  if (name === 'event' && fixture === 'import-event') return 'ev1';
  return null;
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
