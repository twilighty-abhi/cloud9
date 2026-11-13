// Cloud 9 — HTTP API contract. FROZEN CONTRACT: only the lead changes this file.
// All bodies are JSON. Errors: HTTP 4xx/5xx with body ApiError.
// Moderator routes require the `c9_session` httpOnly cookie set by /api/auth/login.

import type { EmailMode, ScoringMode, QuizDef, QuizListItem, SessionSummary, PublicSession, QuestionDef, RoomState } from './model';

export interface ApiError { error: string; message: string }

// ── auth ──
// POST /api/auth/login   body LoginReq → 200 Me (sets cookie) | 401
// POST /api/auth/logout  → 200 {ok:true}
// GET  /api/me           → 200 Me | 401
export interface LoginReq { username: string; password: string }
export interface Me { id: string; username: string; displayName: string; isSuper: boolean }

// ── quizzes (moderator) ──
// GET    /api/quizzes            → 200 QuizListItem[]   (own; super sees all)
// POST   /api/quizzes            body QuizInput → 201 QuizDef
// GET    /api/quizzes/:id        → 200 QuizDef
// PUT    /api/quizzes/:id        body QuizInput → 200 QuizDef   (full replace)
// DELETE /api/quizzes/:id        → 200 {ok:true}
// POST   /api/quizzes/import     body ImportReq → 201 QuizDef | 400 {error:'invalid_import', message:'Row 3: ...'}
// GET    /api/quizzes/template.csv → text/csv sample
export interface QuestionInput {
  text: string;
  imageUrl?: string | null;
  options: string[];          // 2..4 non-empty
  correctIndex: number;
  timeLimitSec?: number;      // default 20, 5..300
  pointsMax?: number;         // default 1000
}
export interface QuizInput {
  title: string;              // 1..120
  emailMode: EmailMode;
  scoring: ScoringMode;
  questions: QuestionInput[]; // 1..100
}
export interface ImportReq {
  title: string;
  format: 'csv' | 'json';     // csv: see template; json: QuizInput['questions'] array or full QuizInput
  content: string;            // raw file text (client reads the file; no multipart)
  emailMode?: EmailMode;      // default 'optional'
  scoring?: ScoringMode;      // default 'speed'
}
// CSV columns: question,option_a,option_b,option_c,option_d,correct,time_sec,image_url
//   correct: A-D or 1-4 (case-insensitive). Blank options dropped (min 2). time_sec default 20.

// ── sessions (moderator) ──
// POST  /api/sessions                 body CreateSessionReq → 201 SessionSummary
// GET   /api/sessions                 → 200 SessionSummary[] (own; super sees all; newest first; includes finished)
// PATCH /api/sessions/:code           body SessionPatch → 200 SessionSummary
// GET   /api/sessions/:code/qr.svg    → image/svg+xml (QR of joinUrl)   (no auth needed)
// GET   /api/sessions/:code/export.csv → text/csv  (auth; columns below)
//   rank,name,email,score,correct_count,answered_count,total_response_ms,q1_choice,q1_correct,q1_points,q1_ms,...
export interface CreateSessionReq { quizId: string; label?: string; listed?: boolean }
export interface SessionPatch { label?: string; listed?: boolean; joinOpen?: boolean }

// ── public / player ──
// GET  /api/public/sessions     → 200 PublicSession[]  (listed && state !== FINISHED; cached ~2s)
// GET  /api/play/:code          → 200 PlayInfo | 404
// POST /api/play/:code/join     body JoinReq → 200 JoinRes | 400/403/404/409/429 ApiError
//        errors: not_found, finished, join_closed, room_full, email_required, invalid_name, invalid_email, rate_limited
export interface PlayInfo { code: string; title: string; label: string; state: RoomState; emailMode: EmailMode; joinOpen: boolean }
export interface JoinReq { name: string; email?: string }
export interface JoinRes { playerId: string; token: string; name: string }   // name may get a suffix: "Anu (2)"

// GET /healthz → 200 { ok: true, rooms: number, sockets: number, uptimeSec: number, rssMb: number }

export type { QuizDef, QuizListItem, SessionSummary, PublicSession, QuestionDef };
