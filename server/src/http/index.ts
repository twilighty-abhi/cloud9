// Cloud 9 — HTTP API routes (see shared/api.ts). Agent B.
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Me, PublicSession, QuizDef, SessionSummary, EventDef, EventListItem, EventDetail, PublicEventBoard, SessionPatch } from '../../../shared/api';
import type { RegisterRoutes, RouteDeps, SessionRow } from '../contracts';
import { COOKIE_NAME, LoginThrottledError, SESSION_TTL_MS } from '../auth/index';
import { createRateLimiter } from '../util/rateLimit';
import { csvRow, slugify } from '../util/csv';
import { newId } from '../util/id';
import { buildExportCsv } from './exportCsv';
import { bus } from '../notify/bus';
import type { NotifyEvent } from '../notify/contracts';
import {
  ImportError,
  TEMPLATE_CSV,
  buildImport,
  emailModeSchema,
  quizInputSchema,
  scoringSchema,
  toQuestionDefs,
  zodMessage,
} from './quizValidation';

const CODE_RE = /^\d{6}$/;
const PUBLIC_CACHE_MS = 2000;
const QR_CACHE_MAX = 2000;

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const loginSchema = z.object({ username: z.string().max(64), password: z.string().max(512) });
const createSessionSchema = z.object({
  quizId: z.string().min(1).max(100),
  label: z.string().max(500).optional(),
  listed: z.boolean().optional(),
});
const sessionPatchSchema = z
  .object({ label: z.string().max(500).optional(), listed: z.boolean().optional(), joinOpen: z.boolean().optional() })
  .strict();
const eventIdField = z.union([z.string().min(1).max(100), z.null()]).optional();
const quizBodySchema = quizInputSchema.extend({ eventId: eventIdField });
const eventInputSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'name is empty').max(80, 'name is longer than 80 characters')),
  emailRequired: z.boolean().optional(),
});
const importSchema = z.object({
  eventId: eventIdField,
  title: z.string().max(500).optional().default(''),
  format: z.enum(['csv', 'json']),
  content: z.string().min(1, 'file is empty').max(2_000_000),
  emailMode: emailModeSchema.optional(),
  scoring: scoringSchema.optional(),
});
const joinSchema = z.object({ name: z.unknown(), email: z.unknown().optional() });

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown, code = 'invalid_input'): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) fail(400, code, zodMessage(r.error));
  return (r as z.SafeParseSuccess<z.output<T>>).data;
}

const JOIN_ERRORS: Record<string, [number, string]> = {
  not_found: [404, 'Room not found'],
  finished: [409, 'This quiz has already finished'],
  join_closed: [403, 'Joining is closed for this room'],
  room_full: [409, 'This room is full'],
  email_required: [400, 'Email is required for this quiz'],
  invalid_name: [400, 'Please enter a valid name (1–24 characters)'],
  invalid_email: [400, 'Please enter a valid email address'],
  kicked: [403, 'You were removed from this quiz'],
};

export const registerRoutes: RegisterRoutes = async (app: FastifyInstance, deps: RouteDeps) => {
  await app.register(async (api) => {
    await api.register(fastifyCookie);
    buildRoutes(api, deps);
  });
};

function buildRoutes(api: FastifyInstance, deps: RouteDeps) {
  const { repo, registry, auth, config } = deps;
  const joinUrl = (code: string) => `${config.publicUrl}/join/${code}`;
  const joinLimiter = createRateLimiter({ max: envInt('JOIN_RATE_PER_MIN', 1000), windowMs: 60_000 });
  const loginLimiter = createRateLimiter({ max: envInt('LOGIN_RATE_PER_MIN', 5), windowMs: 60_000 });

  api.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: status === 413 ? 'too_large' : 'bad_request', message: String(err.message ?? 'Bad request').slice(0, 200) });
    }
    req.log.error({ err, url: req.routeOptions?.url }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });

  const requireMe = (req: FastifyRequest): Me => auth.moderatorFromRequest(req) ?? fail(401, 'unauthorized', 'Please log in');
  const canAccess = (me: Me, ownerId: string | null | undefined) => me.isSuper || (!!ownerId && ownerId === me.id);
  const codeParam = (req: FastifyRequest): string => {
    const code = String((req.params as { code?: string }).code ?? '');
    if (!CODE_RE.test(code)) fail(404, 'not_found', 'Room not found');
    return code;
  };
  const loadOwnedQuiz = (me: Me, id: string): QuizDef => {
    const quiz = repo.getQuiz(id) ?? fail(404, 'not_found', 'Quiz not found');
    if (!canAccess(me, quiz.moderatorId)) fail(403, 'forbidden', 'You do not own this quiz');
    return quiz;
  };
  /** Per-request memo for event names (summaries of many sessions share few events). */
  const eventNamer = () => {
    const memo = new Map<string, string | null>();
    return (id: string | null): string | null => {
      if (!id) return null;
      if (!memo.has(id)) memo.set(id, repo.getEvent(id)?.name ?? null);
      return memo.get(id)!;
    };
  };
  /** Validates an incoming eventId: undefined → keep `fallback`; null → standalone; string → must exist. */
  const resolveEventId = (v: string | null | undefined, fallback: string | null): string | null => {
    if (v === undefined) return fallback;
    if (v === null) return null;
    if (!repo.getEvent(v)) fail(400, 'invalid_event', 'Event not found');
    return v;
  };
  /** Notify-bus emit: payload built lazily; any failure is logged and swallowed (never affects the response). */
  const notify = (build: () => NotifyEvent | null): void => {
    try { const e = build(); if (e) bus.emit(e); } catch (err) { console.error('[http] notify emit failed', (err as Error)?.message); }
  };
  const modName = (id: string): string => auth.getModerator(id)?.username ?? id;
  const evPayload = (e: EventDef) => ({ id: e.id, name: e.name, emailRequired: e.emailRequired });
  const quizPayload = (q: QuizDef) => ({ id: q.id, title: q.title, eventId: q.eventId ?? null, questionCount: q.questions.length, owner: modName(q.moderatorId) });
  const loadEvent = (id: string): EventDef => repo.getEvent(id) ?? fail(404, 'not_found', 'Event not found');
  const summaryFromRow = (row: SessionRow, nameOf: (id: string | null) => string | null): SessionSummary => ({
    id: row.id,
    code: row.code,
    quizId: row.quizId,
    moderatorId: row.moderatorId,
    eventId: row.eventId,
    eventName: nameOf(row.eventId),
    title: row.quiz.title,
    label: row.label,
    state: row.state,
    qIndex: row.qIndex,
    total: row.quiz.questions.length,
    players: repo.countPlayers(row.id),
    listed: row.listed,
    joinOpen: row.joinOpen,
    joinUrl: joinUrl(row.code),
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  });

  // ───────────── auth ─────────────
  api.post('/api/auth/login', async (req, reply) => {
    if (!loginLimiter.hit(req.ip)) fail(429, 'rate_limited', 'Too many login attempts, try again in a minute');
    const body = parse(loginSchema, req.body);
    const found = await auth.verifyLogin(body.username, body.password).catch((e: unknown): never => {
      if (!(e instanceof LoginThrottledError)) throw e;
      reply.header('retry-after', String(e.retryAfterSec));
      return fail(429, e.reason === 'busy' ? 'login_busy' : 'login_locked', e.message);
    });
    const me = found ?? fail(401, 'invalid_credentials', 'Wrong username or password');
    reply.setCookie(COOKIE_NAME, auth.issueCookieValue(me), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: config.secureCookies,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return me;
  });

  api.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies });
    return { ok: true };
  });

  api.get('/api/me', async (req) => requireMe(req));

  // ───────────── quizzes ─────────────
  api.get('/api/quizzes', async (req) => {
    const me = requireMe(req);
    const q = (req.query ?? {}) as { eventId?: unknown };
    const eventId = typeof q.eventId === 'string' && q.eventId !== '' ? q.eventId.slice(0, 100) : undefined;
    if (eventId === undefined) return repo.listQuizzes(me.isSuper ? null : me.id);
    if (eventId === 'none') return repo.listQuizzes(me.isSuper ? null : me.id, 'none');
    // Events are shared: every moderator sees all quizzes in the event.
    return repo.listQuizzes(null, eventId);
  });

  // must be registered before /api/quizzes/:id (static routes win anyway in find-my-way, but be explicit)
  api.get('/api/quizzes/template.csv', async (_req, reply) => {
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="cloud9-template.csv"')
      .header('cache-control', 'no-cache');
    return TEMPLATE_CSV;
  });

  api.post('/api/quizzes', async (req, reply) => {
    const me = requireMe(req);
    const input = parse(quizBodySchema, req.body);
    const eventId = resolveEventId(input.eventId, null);
    const now = Date.now();
    const quiz: QuizDef = {
      id: newId('qz'),
      moderatorId: me.id,
      eventId,
      title: input.title,
      emailMode: input.emailMode,
      scoring: input.scoring,
      questions: toQuestionDefs(input),
      createdAt: now,
      updatedAt: now,
    };
    repo.saveQuiz(quiz);
    notify(() => ({ type: 'quiz.created', at: Date.now(), actor: me.username, quiz: quizPayload(quiz) }));
    return reply.code(201).send(quiz);
  });

  api.post('/api/quizzes/import', async (req, reply) => {
    const me = requireMe(req);
    const body = parse(importSchema, req.body);
    const eventId = resolveEventId(body.eventId, null);
    let raw;
    try {
      raw = buildImport(body.format, body.content, { title: body.title, emailMode: body.emailMode, scoring: body.scoring });
    } catch (e) {
      if (e instanceof ImportError) fail(400, 'invalid_import', e.message);
      throw e;
    }
    if (!raw.title?.trim()) raw.title = 'Imported quiz';
    const input = parse(quizInputSchema, raw, 'invalid_import');
    const now = Date.now();
    const quiz: QuizDef = {
      id: newId('qz'),
      moderatorId: me.id,
      eventId,
      title: input.title,
      emailMode: input.emailMode,
      scoring: input.scoring,
      questions: toQuestionDefs(input),
      createdAt: now,
      updatedAt: now,
    };
    repo.saveQuiz(quiz);
    notify(() => ({ type: 'quiz.created', at: Date.now(), actor: me.username, quiz: quizPayload(quiz) }));
    return reply.code(201).send(quiz);
  });

  api.get<{ Params: { id: string } }>('/api/quizzes/:id', async (req) => {
    const me = requireMe(req);
    return loadOwnedQuiz(me, req.params.id);
  });

  api.put<{ Params: { id: string } }>('/api/quizzes/:id', async (req) => {
    const me = requireMe(req);
    const existing = loadOwnedQuiz(me, req.params.id);
    const input = parse(quizBodySchema, req.body);
    const eventId = resolveEventId(input.eventId, existing.eventId ?? null);
    const quiz: QuizDef = {
      ...existing,
      eventId,
      title: input.title,
      emailMode: input.emailMode,
      scoring: input.scoring,
      questions: toQuestionDefs(input),
      updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
    };
    repo.saveQuiz(quiz);
    notify(() => ({ type: 'quiz.updated', at: Date.now(), actor: me.username, quiz: quizPayload(quiz) }));
    return quiz;
  });

  api.delete<{ Params: { id: string } }>('/api/quizzes/:id', async (req) => {
    const me = requireMe(req);
    const quiz = loadOwnedQuiz(me, req.params.id);
    repo.deleteQuiz(req.params.id);
    notify(() => ({ type: 'quiz.deleted', at: Date.now(), actor: me.username, quiz: quizPayload(quiz) }));
    return { ok: true };
  });

  // ───────────── sessions (moderator) ─────────────
  api.post('/api/sessions', async (req, reply) => {
    const me = requireMe(req);
    const body = parse(createSessionSchema, req.body);
    const quiz = loadOwnedQuiz(me, body.quizId);
    if (quiz.questions.length < 1) fail(400, 'invalid_input', 'Quiz has no questions');
    const event = quiz.eventId ? repo.getEvent(quiz.eventId) : null;
    const summary = registry.createSession({
      quiz,
      event,
      moderatorId: me.id,
      label: body.label?.trim().slice(0, 60) ?? '',
      listed: body.listed ?? true,
    });
    publicCache = null;
    notify(() => ({ type: 'session.created', at: Date.now(), actor: me.username, session: summary }));
    return reply.code(201).send(summary);
  });

  api.get('/api/sessions', async (req) => {
    const me = requireMe(req);
    const rows = repo.listSessions(me.isSuper ? null : me.id).slice(0, 100);
    const nameOf = eventNamer();
    return rows.map((row) => {
      const live = registry.summary(row.code);
      return live && live.id === row.id ? live : summaryFromRow(row, nameOf);
    });
  });

  // ───────────── events (shared across moderators) ─────────────
  api.get('/api/events', async (req) => {
    requireMe(req);
    const live = registry.liveCountByEvent();
    return repo.listEvents().map((e): EventListItem => ({ ...e, liveSessions: live.get(e.id) ?? 0 }));
  });

  api.post('/api/events', async (req, reply) => {
    const me = requireMe(req);
    const input = parse(eventInputSchema, req.body);
    const now = Date.now();
    const event: EventDef = { id: newId('ev'), moderatorId: me.id, name: input.name, emailRequired: input.emailRequired ?? true, createdAt: now, updatedAt: now };
    repo.saveEvent(event);
    notify(() => ({ type: 'event.created', at: Date.now(), actor: me.username, event: evPayload(event) }));
    return reply.code(201).send(event);
  });

  api.get<{ Params: { id: string } }>('/api/events/:id', async (req): Promise<EventDetail> => {
    requireMe(req);
    const event = loadEvent(req.params.id);
    const quizzes = repo.listQuizzes(null, event.id);
    // Sessions of this event: live/in-memory rooms first-class, plus persisted history (Repo has no by-event query,
    // so we filter the newest persisted sessions; in-memory rooms cover everything from the last 6h regardless).
    const byId = new Map<string, SessionSummary>();
    for (const s of registry.listSummaries()) if (s.eventId === event.id) byId.set(s.id, s);
    const nameOf = eventNamer();
    for (const row of repo.listSessions(null)) {
      if (row.eventId !== event.id || byId.has(row.id)) continue;
      const live = registry.summary(row.code);
      byId.set(row.id, live && live.id === row.id ? live : summaryFromRow(row, nameOf));
    }
    const sessions = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    return { event, quizzes, sessions };
  });

  api.put<{ Params: { id: string } }>('/api/events/:id', async (req) => {
    const me = requireMe(req);
    const existing = loadEvent(req.params.id);
    if (!canAccess(me, existing.moderatorId)) fail(403, 'forbidden', 'Only the event creator can edit this event');
    const input = parse(eventInputSchema, req.body);
    const event: EventDef = {
      ...existing,
      name: input.name,
      emailRequired: input.emailRequired ?? existing.emailRequired,
      updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
    };
    repo.saveEvent(event);
    eventBoardCache.delete(event.id);
    notify(() => ({ type: 'event.updated', at: Date.now(), actor: me.username, event: evPayload(event) }));
    return event;
  });

  api.delete<{ Params: { id: string } }>('/api/events/:id', async (req) => {
    const me = requireMe(req);
    const existing = loadEvent(req.params.id);
    if (!canAccess(me, existing.moderatorId)) fail(403, 'forbidden', 'Only the event creator can delete this event');
    repo.deleteEvent(existing.id);
    eventBoardCache.delete(existing.id);
    notify(() => ({ type: 'event.deleted', at: Date.now(), actor: me.username, event: evPayload(existing) }));
    return { ok: true };
  });

  api.get<{ Params: { id: string } }>('/api/events/:id/leaderboard', async (req, reply) => {
    requireMe(req);
    const event = loadEvent(req.params.id);
    reply.header('cache-control', 'no-store');
    return repo.eventLeaderboard(event.id);
  });

  api.get<{ Params: { id: string } }>('/api/events/:id/export.csv', async (req, reply) => {
    requireMe(req);
    const event = loadEvent(req.params.id);
    const lines = [csvRow(['rank', 'name', 'email', 'score', 'quizzes_played'])];
    for (const e of repo.eventLeaderboard(event.id)) lines.push(csvRow([e.rank, e.name, e.email ?? '', e.score, e.quizzesPlayed]));
    const filename = `cloud9-event-${slugify(event.name)}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store');
    // BOM so Excel opens UTF-8 names correctly
    return reply.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });

  api.patch('/api/sessions/:code', async (req) => {
    const me = requireMe(req);
    const code = codeParam(req);
    const body = parse(sessionPatchSchema, req.body);
    const owner = registry.ownerOf(code) ?? fail(404, 'not_found', 'Room not found (or no longer live)');
    if (!canAccess(me, owner)) fail(403, 'forbidden', 'You do not own this room');
    const patch = { ...body, ...(body.label !== undefined ? { label: body.label.trim().slice(0, 60) } : {}) };
    const before = registry.summary(code);
    const s = registry.patch(code, patch) ?? fail(404, 'not_found', 'Room not found');
    publicCache = null;
    notify(() => {
      if (!before) return null;
      const changes: SessionPatch = {};
      if (s.label !== before.label) changes.label = s.label;
      if (s.listed !== before.listed) changes.listed = s.listed;
      if (s.joinOpen !== before.joinOpen) changes.joinOpen = s.joinOpen;
      if (Object.keys(changes).length === 0) return null;
      return { type: 'session.updated', at: Date.now(), actor: me.username, session: s, changes };
    });
    return s;
  });

  const qrCache = new Map<string, string>();
  api.get('/api/sessions/:code/qr.svg', async (req, reply) => {
    const code = codeParam(req);
    let svg = qrCache.get(code);
    if (!svg) {
      if (!registry.summary(code) && !repo.getLatestSessionByCode(code)) fail(404, 'not_found', 'Room not found');
      svg = await QRCode.toString(joinUrl(code), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      if (qrCache.size >= QR_CACHE_MAX) qrCache.clear();
      qrCache.set(code, svg);
    }
    reply.header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=3600');
    return reply.send(svg);
  });

  api.get('/api/sessions/:code/export.csv', async (req, reply) => {
    const me = requireMe(req);
    const code = codeParam(req);
    const row = repo.getLatestSessionByCode(code) ?? fail(404, 'not_found', 'Room not found');
    if (!canAccess(me, row.moderatorId)) fail(403, 'forbidden', 'You do not own this room');
    const players = repo.listPlayers(row.id);
    const answers = repo.listAnswers(row.id); // flushes queued answers first
    const csv = buildExportCsv(row, players, answers);
    const filename = `cloud9-${code}-${slugify(row.quiz.title)}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store');
    return reply.send(csv);
  });

  // ───────────── public / player ─────────────
  const eventBoardCache = new Map<string, { at: number; data: PublicEventBoard }>();
  api.get<{ Params: { id: string } }>('/api/public/events/:id/leaderboard', async (req, reply) => {
    const id = String(req.params.id ?? '').slice(0, 100);
    const now = Date.now();
    let hit = eventBoardCache.get(id);
    if (!hit || now - hit.at > PUBLIC_CACHE_MS) {
      const event = loadEvent(id);
      const list = repo.eventLeaderboard(event.id);
      const data: PublicEventBoard = {
        eventName: event.name,
        top: list.slice(0, 10).map((e) => ({ name: e.name, score: e.score, rank: e.rank, quizzesPlayed: e.quizzesPlayed })),
        total: list.length,
        updatedAt: now,
      };
      if (eventBoardCache.size >= 500) eventBoardCache.clear();
      hit = { at: now, data };
      eventBoardCache.set(id, hit);
    }
    reply.header('cache-control', 'no-store');
    return hit.data;
  });

  let publicCache: { at: number; data: PublicSession[] } | null = null;
  api.get('/api/public/sessions', async (_req, reply) => {
    const now = Date.now();
    if (!publicCache || now - publicCache.at > PUBLIC_CACHE_MS) {
      publicCache = { at: now, data: registry.publicList() };
    }
    reply.header('cache-control', 'no-store');
    return publicCache.data;
  });

  api.get('/api/play/:code', async (req, reply) => {
    const code = codeParam(req);
    const info = registry.playInfo(code) ?? fail(404, 'not_found', 'Room not found');
    reply.header('cache-control', 'no-store');
    return info;
  });

  api.post('/api/play/:code/join', async (req) => {
    if (!joinLimiter.hit(req.ip)) fail(429, 'rate_limited', 'Too many join attempts, please wait a minute');
    const code = codeParam(req);
    const body = parse(joinSchema, req.body, 'invalid_name');
    const name = typeof body.name === 'string' ? body.name.slice(0, 200) : fail(400, 'invalid_name', JOIN_ERRORS.invalid_name[1]);
    let email: string | undefined;
    if (body.email !== undefined && body.email !== null) {
      email = typeof body.email === 'string' ? body.email.slice(0, 300) : fail(400, 'invalid_email', JOIN_ERRORS.invalid_email[1]);
      if (email.trim() === '') email = undefined;
    }
    const res = registry.join(code, { name, email });
    if (!res.ok) {
      const [status, message] = JOIN_ERRORS[res.error] ?? [400, 'Could not join'];
      fail(status, res.error, message);
    }
    const ok = res as Extract<typeof res, { ok: true }>;
    return { playerId: ok.playerId, token: ok.token, name: ok.name, rejoined: ok.rejoined };
  });
}
