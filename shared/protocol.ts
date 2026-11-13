// Cloud 9 — realtime WebSocket protocol. FROZEN CONTRACT: only the lead changes this file.
//
// Endpoint:  GET /ws?role=player&code=123456&token=<playerToken>
//            GET /ws?role=mod&code=123456            (auth via moderator session cookie on the upgrade request)
//            GET /ws?role=present&code=123456        (read-only, no auth)
// Players obtain {playerId, token} from POST /api/play/:code/join BEFORE opening the socket.
//
// Model: the server pushes a FULL role-specific snapshot (`state`) on connect and on every room state change.
// Between state changes it pushes small deltas: `lobby` and `progress` (to mod/present, throttled to 4/s) and `ack` (to the answering player).
// Clients render from the latest snapshot; deltas just patch counters. Every server message carries `v` (room version, increments on each state change);
// clients ignore a `state` with v lower than the one they hold.

import type { RoomState, LeaderEntry, BoardTop } from './model';

// ───────────────────────────── client → server ─────────────────────────────

export type ModAction = 'start' | 'next' | 'close' | 'reveal' | 'leaderboard' | 'end';

export type ClientMsg =
  | { t: 'answer'; qIndex: number; choice: number }                 // player
  | { t: 'ping' }                                                   // any
  | { t: 'mod'; action: ModAction; expectQ: number }                // mod; expectQ = the qIndex the mod's UI currently shows (-1 in lobby)
  | { t: 'kick'; playerId: string };                                // mod

// Mod action semantics (server validates; invalid → `error` with code 'bad_transition', state unchanged):
//   start       LOBBY → QUESTION(q0)
//   close       QUESTION → CLOSED        (also happens automatically on timer end or when all connected+joined players answered)
//   reveal      CLOSED → REVEAL
//   leaderboard REVEAL → LEADERBOARD
//   next        REVEAL|LEADERBOARD → QUESTION(q+1); if no more questions → FINISHED
//   end         any non-FINISHED → FINISHED
// expectQ must equal the room's current qIndex, else `error` code 'stale' (prevents double-click skipping).

// ───────────────────────────── server → client ─────────────────────────────

export interface QuestionPublic {
  qIndex: number;
  total: number;
  text: string;
  imageUrl: string | null;
  options: string[];
  timeLimitSec: number;
  startedAt: number;        // server epoch ms
  endsAt: number;           // server epoch ms
}

export interface PlayerSnapshot {
  role: 'player';
  code: string;
  eventName: string | null;
  title: string;
  label: string;
  state: RoomState;
  v: number;
  serverNow: number;        // server epoch ms at send; client offset = serverNow - Date.now()
  playerCount: number;
  me: { id: string; name: string; score: number; rank: number | null };
  question: QuestionPublic | null;           // set in QUESTION, CLOSED, REVEAL, LEADERBOARD (current question)
  myAnswer: { choice: number } | null;       // my answer to the current question, if any
  reveal: { correctIndex: number; correct: boolean; points: number } | null;   // set in REVEAL and LEADERBOARD
  leaderboard: LeaderEntry[] | null;         // THIS QUIZ: TOP 3 ONLY for players; set in LEADERBOARD and FINISHED (me.rank/me.score give "You're #N")
  /** EVENT standings; set in LEADERBOARD and FINISHED when the session belongs to an event, else null. */
  eventBoard: { eventName: string; top: BoardTop[] /* top 3 */; me: { rank: number; score: number } | null; total: number } | null;
}

export interface HostSnapshot {
  role: 'mod' | 'present';
  code: string;
  title: string;
  label: string;
  state: RoomState;
  v: number;
  serverNow: number;
  joinUrl: string;
  listed: boolean;
  joinOpen: boolean;
  qIndex: number;           // -1 in lobby
  total: number;
  playerCount: number;
  players: { id: string; name: string; score: number; connected: boolean }[];  // all non-kicked, join order
  question: QuestionPublic | null;
  correctIndex: number | null;   // mod: always for the current question; present: only in REVEAL/LEADERBOARD
  answered: number;              // answers received for the current question
  distribution: number[] | null; // per-option counts; set in CLOSED, REVEAL, LEADERBOARD
  leaderboard: LeaderEntry[];    // top 10 (always present; empty in lobby)
  eventId: string | null;
  eventName: string | null;
  /** EVENT standings top 10; set in LEADERBOARD and FINISHED when the session belongs to an event, else null. */
  eventBoard: { eventName: string; top: BoardTop[]; total: number } | null;
  nextQuestion: { text: string; options: string[]; correctIndex: number } | null;  // mod only: preview of the next question; null for present
}

export type ServerMsg =
  | ({ t: 'state' } & PlayerSnapshot)
  | ({ t: 'state' } & HostSnapshot)
  | { t: 'lobby'; v: number; playerCount: number; players: HostSnapshot['players'] }   // mod/present, throttled
  | { t: 'progress'; v: number; answered: number; playerCount: number }               // mod/present, throttled
  | { t: 'ack'; v: number; qIndex: number; choice: number }                           // player
  | { t: 'kicked' }                                                                   // player; server closes socket after
  | { t: 'pong'; serverNow: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'not_found'       // room code unknown/finished-and-evicted
  | 'unauthorized'    // bad token / not a moderator of this room
  | 'bad_message'     // failed validation
  | 'bad_transition'
  | 'stale'
  | 'too_late'        // answer after endsAt + grace
  | 'already_answered'
  | 'rate_limited';

// WebSocket close codes used by the server
export const WS_CLOSE = {
  NOT_FOUND: 4404,
  UNAUTHORIZED: 4401,
  KICKED: 4403,
  RATE_LIMITED: 4429,
} as const;
