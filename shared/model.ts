// Cloud 9 — shared domain model. FROZEN CONTRACT: only the lead changes this file.
// Imported by server (server/src/**) and web (web/src/**). Types + tiny pure helpers only, no deps.

export type RoomState = 'LOBBY' | 'QUESTION' | 'CLOSED' | 'REVEAL' | 'LEADERBOARD' | 'FINISHED';
export const ROOM_STATES: RoomState[] = ['LOBBY', 'QUESTION', 'CLOSED', 'REVEAL', 'LEADERBOARD', 'FINISHED'];

export type EmailMode = 'off' | 'optional' | 'required';
export type ScoringMode = 'speed' | 'flat';
export type Role = 'player' | 'mod' | 'present';

export interface QuestionDef {
  id: string;
  text: string;
  imageUrl: string | null;
  options: string[];        // 2..4 entries
  correctIndex: number;     // 0-based index into options
  timeLimitSec: number;     // 5..300, default 20
  pointsMax: number;        // default 1000
}

export interface QuizDef {
  id: string;
  moderatorId: string;
  eventId: string | null;   // event this quiz belongs to (null = standalone)
  title: string;
  emailMode: EmailMode;
  scoring: ScoringMode;
  questions: QuestionDef[];
  createdAt: number;        // epoch ms
  updatedAt: number;
}

export interface QuizListItem {
  id: string;
  moderatorId: string;
  eventId: string | null;
  title: string;
  questionCount: number;
  updatedAt: number;
}

/** Summary of one live/past session — used by moderator dashboard. */
export interface SessionSummary {
  id: string;
  code: string;             // 6 digits
  quizId: string;
  moderatorId: string;
  eventId: string | null;
  eventName: string | null;
  title: string;
  label: string;
  state: RoomState;
  qIndex: number;           // -1 before first question
  total: number;            // question count
  players: number;          // non-kicked players
  listed: boolean;          // shown on public home page
  joinOpen: boolean;
  joinUrl: string;
  createdAt: number;
  endedAt: number | null;
}

/** What the PUBLIC home page sees. No PII. */
export interface PublicSession {
  code: string;
  eventName: string | null;
  title: string;
  label: string;
  state: RoomState;
  qIndex: number;
  total: number;
  players: number;
  joinOpen: boolean;
}

export interface LeaderEntry {
  playerId: string;
  name: string;
  score: number;
  rank: number;             // 1-based competition rank (1,2,2,4): equal score AND equal tie-break time share a rank; join order only orders rows
}

// ───────────────────────────── events ─────────────────────────────
// An EVENT groups quizzes (and their sessions) and has its own cumulative leaderboard.
// Events are SHARED: every moderator can see them and add quizzes to them; only the creator or a super moderator can edit/delete.
// Player identity across an event = lowercase email. When event.emailRequired is true (default), every session of a quiz
// in that event requires email at join, regardless of the quiz's own emailMode. Players without email (only possible when
// emailRequired=false) are ranked individually per session (key "p:<playerId>").

export interface EventDef {
  id: string;
  moderatorId: string;      // creator
  name: string;             // 1..80
  emailRequired: boolean;   // default true
  createdAt: number;
  updatedAt: number;
}

export interface EventListItem extends EventDef {
  quizCount: number;
  sessionCount: number;
  liveSessions: number;     // non-FINISHED sessions in memory
}

/** Cumulative event ranking. Scores = SUM of player.score over all non-kicked players with that key in sessions of the event. */
export interface EventLeaderEntry {
  key: string;              // lowercase email, or "p:<playerId>" when no email
  name: string;             // display name from the player's most recent join
  email: string | null;     // ONLY in moderator responses; null/omitted in public + player views
  score: number;
  quizzesPlayed: number;    // distinct sessions
  rank: number;             // 1-based competition rank (1,2,2,4): equal score share a rank; rows ordered score desc, then first join asc
}

/** Compact leaderboard shown inside rooms. */
export interface BoardTop { name: string; score: number; rank: number }

export const DEFAULTS = {
  timeLimitSec: 20,
  pointsMax: 1000,
  graceMs: 300,             // answers accepted until endsAt + graceMs
  leaderboardSize: 10,
  maxPlayersPerRoom: 500,
  nameMax: 24,
  emailMax: 120,
} as const;

/**
 * Scoring (server authoritative). speed: correct → round(pointsMax * (1 - ratio/2)), ratio = clamp(responseMs/limitMs,0,1)
 * so 1000 (instant) .. 500 (at buzzer). flat: correct → pointsMax. Wrong/no answer → 0.
 */
export function scoreAnswer(opts: {
  correct: boolean;
  responseMs: number;
  timeLimitSec: number;
  pointsMax: number;
  scoring: ScoringMode;
}): number {
  if (!opts.correct) return 0;
  if (opts.scoring === 'flat') return opts.pointsMax;
  const limit = Math.max(1, opts.timeLimitSec * 1000);
  const ratio = Math.min(1, Math.max(0, opts.responseMs / limit));
  return Math.round(opts.pointsMax * (1 - ratio / 2));
}
