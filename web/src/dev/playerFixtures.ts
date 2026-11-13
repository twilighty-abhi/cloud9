// Dev-only fake data so the home page and player screens can be screenshotted without a backend.
// Activated by `?fixture=<name>` in the URL (see Home.tsx / Play.tsx). Small on purpose.
import type { PublicSession, LeaderEntry } from '../../../shared/model';
import type { PlayerSnapshot } from '../../../shared/protocol';
import type { PlayInfo } from '../../../shared/api';
import { query } from '../lib/router';

export function fixtureName(): string | null {
  try { return query('fixture'); } catch { return null; }
}

export function homeFixture(name: string): PublicSession[] | 'loading' | 'error' | null {
  if (name === 'home-empty') return [];
  if (name === 'home-loading') return 'loading';
  if (name === 'home-error') return 'error';
  if (name !== 'home-list') return null;
  return [
    { code: '482913', title: 'Tech Trivia', label: 'Hall A · Round 1', state: 'LOBBY', qIndex: -1, total: 10, players: 42, joinOpen: true },
    { code: '120044', title: 'Cloud Quiz: Serverless, Containers and Everything In Between', label: 'Hall B', state: 'QUESTION', qIndex: 2, total: 10, players: 37, joinOpen: true },
    { code: '777001', title: 'Open Source Pop Quiz', label: 'Main stage', state: 'REVEAL', qIndex: 6, total: 12, players: 118, joinOpen: false },
  ];
}

export const joinFixture: PlayInfo = {
  code: '482913', title: 'Tech Trivia', label: 'Hall A · Round 1', state: 'LOBBY', emailMode: 'optional', joinOpen: true,
};

const names = ['Anu', 'Rahul K', 'Meera', 'Farhan', 'Divya S', 'Joel', 'Priya', 'Nikhil', 'Sana', 'Arjun Menon'];
const board = (meRank: number | null): LeaderEntry[] =>
  names.map((n, i) => ({ playerId: i + 1 === meRank ? 'me' : `p${i}`, name: i + 1 === meRank ? 'Abhi' : n, score: 4820 - i * 370 - (i % 3) * 40, rank: i + 1 }));

function base(): PlayerSnapshot {
  return {
    role: 'player', code: '482913', title: 'Tech Trivia', label: 'Hall A · Round 1', state: 'LOBBY', v: 1,
    serverNow: Date.now(), playerCount: 42,
    me: { id: 'me', name: 'Abhi', score: 0, rank: null },
    question: null, myAnswer: null, reveal: null, leaderboard: null,
  };
}

function question(remainingMs: number) {
  const now = Date.now();
  return {
    qIndex: 2, total: 10,
    text: 'Which company created the Kubernetes container orchestration system before donating it to the CNCF?',
    imageUrl: null,
    options: ['Google', 'Amazon Web Services', 'Docker Inc.', 'Red Hat'],
    timeLimitSec: 20, startedAt: now - (20000 - remainingMs), endsAt: now + remainingMs,
  };
}

export function playerFixture(name: string): PlayerSnapshot | null {
  const b = base();
  switch (name) {
    case 'lobby': return b;
    case 'question': return { ...b, state: 'QUESTION', me: { ...b.me, score: 1730, rank: 6 }, question: question(12400) };
    case 'question-locked': return { ...b, state: 'QUESTION', me: { ...b.me, score: 1730, rank: 6 }, question: question(8200), myAnswer: { choice: 0 } };
    case 'question-timeup': return { ...b, state: 'QUESTION', me: { ...b.me, score: 1730, rank: 6 }, question: question(-50) };
    case 'closed': return { ...b, state: 'CLOSED', me: { ...b.me, score: 1730, rank: 6 }, question: question(-2000), myAnswer: { choice: 0 } };
    case 'reveal-correct': return { ...b, state: 'REVEAL', me: { ...b.me, score: 2580, rank: 4 }, question: question(-5000), myAnswer: { choice: 0 }, reveal: { correctIndex: 0, correct: true, points: 850 } };
    case 'reveal-wrong': return { ...b, state: 'REVEAL', me: { ...b.me, score: 1730, rank: 9 }, question: question(-5000), myAnswer: { choice: 2 }, reveal: { correctIndex: 0, correct: false, points: 0 } };
    case 'reveal-none': return { ...b, state: 'REVEAL', me: { ...b.me, score: 1730, rank: 11 }, question: question(-5000), myAnswer: null, reveal: { correctIndex: 0, correct: false, points: 0 } };
    case 'leaderboard': return { ...b, state: 'LEADERBOARD', me: { ...b.me, score: 1730, rank: 14 }, question: question(-9000), reveal: { correctIndex: 0, correct: false, points: 0 }, leaderboard: board(null) };
    case 'leaderboard-top': return { ...b, state: 'LEADERBOARD', me: { ...b.me, score: 3710, rank: 4 }, question: question(-9000), reveal: { correctIndex: 0, correct: true, points: 900 }, leaderboard: board(4) };
    case 'finished': return { ...b, state: 'FINISHED', me: { ...b.me, score: 4410, rank: 2 }, leaderboard: board(2) };
    case 'finished-low': return { ...b, state: 'FINISHED', me: { ...b.me, score: 1730, rank: 23 }, leaderboard: board(null) };
    default: return null;
  }
}
