// Cloud 9 — server-internal contracts between modules. FROZEN CONTRACT: only the lead changes this file.
//
// Ownership:
//   Agent A (game engine)  implements: server/src/game/**, server/src/realtime/**   → createGame()
//   Agent B (API & data)   implements: server/src/db/**, server/src/auth/**, server/src/http/**, server/src/util/**
//                                     → openRepo(), createAuth(), registerRoutes()
//   Lead                   owns: server/src/index.ts, server/src/config.ts, this file, shared/**
//
// Wiring (server/src/index.ts, written by lead):
//   const config = loadConfig();
//   const repo = openRepo(config.dbPath);                          // from './db/repo'
//   const auth = createAuth(config, repo);                         // from './auth/index'
//   const game = createGame({ repo, config });                     // from './game/index'
//   game.registry.restore();
//   const app = Fastify({ trustProxy: true, bodyLimit: 2_000_000 });
//   await registerRoutes(app, { repo, registry: game.registry, auth, config });   // from './http/index'
//   (lead registers static files + SPA fallback)
//   await app.listen(...); game.attach(app.server, auth);
//   on SIGTERM: game.shutdown(); repo.close();

import type { Server } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { QuizDef, QuizListItem, SessionSummary, PublicSession, RoomState, EventDef, EventLeaderEntry } from '../../shared/model';
import type { Me, PlayInfo, JoinReq, SessionPatch } from '../../shared/api';
import type { Config } from './config';

// ───────────────────────────── persistence rows ─────────────────────────────

export interface SessionRow {
  id: string;
  code: string;
  quizId: string;
  moderatorId: string;
  eventId: string | null;  // copied from the quiz at session creation (column sessions.event_id)
  label: string;
  listed: boolean;
  joinOpen: boolean;
  state: RoomState;
  qIndex: number;          // -1 = lobby
  qStartedAt: number | null;
  qEndsAt: number | null;
  quiz: QuizDef;           // SNAPSHOT of the quiz at session creation (stored as JSON). Editing the quiz later doesn't affect the session.
  createdAt: number;
  endedAt: number | null;
}

export interface PlayerRow {
  id: string;
  sessionId: string;
  name: string;
  email: string | null;
  tokenHash: string;       // sha256 hex of the player token
  score: number;
  kicked: boolean;
  joinedAt: number;
}

export interface AnswerRow {
  sessionId: string;
  playerId: string;
  questionId: string;
  qIndex: number;
  choice: number;
  correct: boolean;
  responseMs: number;
  points: number;
  answeredAt: number;
}

export interface ModeratorRow { id: string; username: string; displayName: string; isSuper: boolean }

// ───────────────────────────── Repo (Agent B) ─────────────────────────────
// Synchronous (better-sqlite3). All methods must be safe to call at high frequency.
// Writes that happen on the hot path (insertPlayer, updatePlayerScore, queueAnswer, updateSession) are cheap single statements
// or queued; queueAnswer is buffered and flushed in ONE transaction every 100 ms (and on flush()/close()).

export interface Repo {
  upsertModerator(m: ModeratorRow): void;

  listQuizzes(moderatorId: string | null, eventId?: string | 'none'): QuizListItem[];
  //   moderatorId null → all moderators. eventId: string → only that event's quizzes (ignores moderatorId filter when caller passes null);
  //   'none' → only quizzes without an event; undefined → no event filter. Newest updated first.

  // ── events ──
  saveEvent(e: EventDef): void;                              // insert or update
  getEvent(id: string): EventDef | null;
  listEvents(): (EventDef & { quizCount: number; sessionCount: number })[];   // newest first
  deleteEvent(id: string): void;                             // sets quizzes.event_id = NULL for its quizzes, keeps sessions.event_id (history)
  /** Cumulative ranking for an event (see shared/model.ts EventLeaderEntry). Includes emails. One SQL aggregate; must be fast (<5ms @ 5k players). */
  eventLeaderboard(eventId: string): EventLeaderEntry[];
  getQuiz(id: string): QuizDef | null;
  saveQuiz(q: QuizDef): void;                                // insert or full replace (questions too) in one transaction
  deleteQuiz(id: string): void;

  insertSession(s: SessionRow): void;
  updateSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'quiz'>>): void;
  listSessions(moderatorId: string | null): SessionRow[];    // newest first
  loadUnfinishedSessions(): SessionRow[];                    // state !== 'FINISHED'
  getLatestSessionByCode(code: string): SessionRow | null;

  insertPlayer(p: PlayerRow): void;
  updatePlayer(id: string, patch: Partial<Pick<PlayerRow, 'score' | 'kicked' | 'name' | 'tokenHash'>>): void;
  listPlayers(sessionId: string): PlayerRow[];               // join order
  countPlayers(sessionId: string): number;                   // non-kicked

  queueAnswer(a: AnswerRow): void;                           // buffered
  listAnswers(sessionId: string): AnswerRow[];               // flushes the queue first
  flush(): void;
  close(): void;                                             // flush + close db
}

// ───────────────────────────── Auth (Agent B) ─────────────────────────────
// Moderators come from config.moderators (env). Passwords compared with scrypt hashes computed at boot (timingSafeEqual).
// Session cookie `c9_session` = stateless signed token (HMAC-SHA256 with config.sessionSecret) containing {id, exp}; 7-day expiry.
// Survives server restarts.

export interface AuthService {
  verifyLogin(username: string, password: string): Me | null;
  issueCookieValue(me: Me): string;
  moderatorFromCookieHeader(cookieHeader: string | undefined): Me | null;  // used by the WS upgrade (Agent A)
  moderatorFromRequest(req: FastifyRequest): Me | null;
  getModerator(id: string): Me | null;
}

// ───────────────────────────── Game (Agent A) ─────────────────────────────

export type JoinResult =
  | { ok: true; playerId: string; token: string; name: string; rejoined: boolean }
  | { ok: false; error: 'not_found' | 'finished' | 'join_closed' | 'room_full' | 'email_required' | 'invalid_name' | 'invalid_email' | 'kicked' | 'email_in_use' };

export interface GameRegistry {
  /** Creates a room in LOBBY with a fresh unique 6-digit code; persists via repo.insertSession. */
  createSession(input: { quiz: QuizDef; event: EventDef | null; moderatorId: string; label: string; listed: boolean }): SessionSummary;
  /** Live non-FINISHED room count per eventId (for /api/events liveSessions). */
  liveCountByEvent(): Map<string, number>;
  /** End a session from outside the moderator screen (Telegram). Same as the mod 'end' action: → FINISHED, emits session.finished with actor. */
  endSession(code: string, actor: string | null): { ok: true } | { ok: false; error: 'not_found' | 'finished' };
  /** Live summary from memory (includes FINISHED rooms still held in memory); null if not in memory. */
  summary(code: string): SessionSummary | null;
  /** All rooms in memory, optionally filtered by moderator. Newest first. */
  listSummaries(moderatorId?: string): SessionSummary[];
  /** Listed rooms not FINISHED, for the home page. Cheap (called often; HTTP layer caches 2s). */
  publicList(): PublicSession[];
  playInfo(code: string): PlayInfo | null;
  /** Validates name (trimmed, 1..24 chars, control chars stripped) and email per quiz.emailMode; dedupes display names ("Anu (2)"). */
  join(code: string, req: JoinReq): JoinResult;
  patch(code: string, patch: SessionPatch): SessionSummary | null;
  /** moderatorId owning the room, or null. */
  ownerOf(code: string): string | null;
  /** Rebuild unfinished rooms from repo at boot. An open QUESTION becomes CLOSED. Returns count restored. */
  restore(): number;
  stats(): { rooms: number; sockets: number };
}

export interface Game {
  registry: GameRegistry;
  /** Attach the WebSocket server to the HTTP server at path /ws (noServer + 'upgrade' handler). */
  attach(server: Server, auth: AuthService): void;
  /** Stop timers, close sockets, flush. */
  shutdown(): void;
}

export type CreateGame = (deps: { repo: Repo; config: Config }) => Game;

// ───────────────────────────── HTTP (Agent B) ─────────────────────────────

export interface RouteDeps { repo: Repo; registry: GameRegistry; auth: AuthService; config: Config }
export type RegisterRoutes = (app: FastifyInstance, deps: RouteDeps) => Promise<void>;
