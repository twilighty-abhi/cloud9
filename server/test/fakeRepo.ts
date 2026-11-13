// In-memory Repo for game engine tests.
import type { Repo, SessionRow, PlayerRow, AnswerRow, ModeratorRow } from '../src/contracts';
import type { QuizDef, QuizListItem, EventDef, EventLeaderEntry } from '../../shared/model';

export class FakeRepo implements Repo {
  moderators = new Map<string, ModeratorRow>();
  quizzes = new Map<string, QuizDef>();
  sessions = new Map<string, SessionRow>();
  players = new Map<string, PlayerRow>();
  answers: AnswerRow[] = [];
  queue: AnswerRow[] = [];
  sessionUpdates = 0;

  moderatorSessions = new Map<string, number>();
  saveModeratorSession(id: string, expires: number) { this.moderatorSessions.set(id, expires); }
  hasModeratorSession(id: string, now: number) { return (this.moderatorSessions.get(id) ?? 0) > now; }
  deleteModeratorSession(id: string) { this.moderatorSessions.delete(id); }

  upsertModerator(m: ModeratorRow) { this.moderators.set(m.id, { ...m }); }
  events = new Map<string, EventDef>();
  listQuizzes(moderatorId: string | null, eventId?: string | 'none'): QuizListItem[] {
    return [...this.quizzes.values()]
      .filter((q) => !moderatorId || q.moderatorId === moderatorId)
      .filter((q) => eventId === undefined || (eventId === 'none' ? !q.eventId : q.eventId === eventId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((q) => ({ id: q.id, moderatorId: q.moderatorId, eventId: q.eventId ?? null, title: q.title, questionCount: q.questions.length, updatedAt: q.updatedAt }));
  }
  saveEvent(e: EventDef) { this.events.set(e.id, { ...e }); }
  getEvent(id: string) { const e = this.events.get(id); return e ? { ...e } : null; }
  listEvents() {
    return [...this.events.values()].sort((a, b) => b.createdAt - a.createdAt).map((e) => ({
      ...e,
      quizCount: [...this.quizzes.values()].filter((q) => q.eventId === e.id).length,
      sessionCount: [...this.sessions.values()].filter((s) => s.eventId === e.id).length,
    }));
  }
  deleteEvent(id: string) {
    for (const q of this.quizzes.values()) if (q.eventId === id) q.eventId = null;
    this.events.delete(id);
  }
  eventLeaderboard(eventId: string, hidePending = false): EventLeaderEntry[] {
    const agg = new Map<string, { key: string; name: string; email: string | null; score: number; sessions: Set<string>; first: number; last: number }>();
    for (const p of this.players.values()) {
      const s = this.sessions.get(p.sessionId);
      if (!s || s.eventId !== eventId || p.kicked) continue;
      const key = p.email ? p.email.toLowerCase() : `p:${p.id}`;
      let a = agg.get(key);
      if (!a) { a = { key, name: p.name, email: p.email ? key : null, score: 0, sessions: new Set(), first: p.joinedAt, last: p.joinedAt }; agg.set(key, a); }
      a.score += p.score;
      if (hidePending && (s.state === 'QUESTION' || s.state === 'CLOSED')) {
        a.score -= this.answers.find((answer) => answer.playerId === p.id && answer.sessionId === s.id && answer.qIndex === s.qIndex)?.points ?? 0;
      }
      a.sessions.add(p.sessionId);
      if (p.joinedAt < a.first) a.first = p.joinedAt;
      if (p.joinedAt >= a.last) { a.last = p.joinedAt; a.name = p.name; }
    }
    return [...agg.values()]
      .sort((x, y) => y.score - x.score || x.first - y.first || (x.key < y.key ? -1 : 1))
      .map((a, i) => ({ key: a.key, name: a.name, email: a.email, score: a.score, quizzesPlayed: a.sessions.size, rank: i + 1 }));
  }
  getQuiz(id: string) { return this.quizzes.get(id) ?? null; }
  saveQuiz(q: QuizDef) { this.quizzes.set(q.id, structuredClone(q)); }
  deleteQuiz(id: string) { this.quizzes.delete(id); }

  insertSession(s: SessionRow) { this.sessions.set(s.id, structuredClone(s)); }
  updateSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'quiz'>>) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('no session ' + id);
    Object.assign(s, patch);
    this.sessionUpdates++;
  }
  listSessions(moderatorId: string | null, eventId?: string) {
    return [...this.sessions.values()].filter((s) => (!moderatorId || s.moderatorId === moderatorId) && (!eventId || s.eventId === eventId)).sort((a, b) => b.createdAt - a.createdAt).map((s) => structuredClone(s));
  }
  loadUnfinishedSessions() { return [...this.sessions.values()].filter((s) => s.state !== 'FINISHED').map((s) => structuredClone(s)); }
  loadRecentFinishedSessions(since: number) {
    return [...this.sessions.values()].filter((s) => s.state === 'FINISHED' && (s.endedAt ?? 0) >= since).map((s) => structuredClone(s));
  }
  getLatestSessionByCode(code: string) { return this.listSessions(null).find((s) => s.code === code) ?? null; }

  insertPlayer(p: PlayerRow) { this.players.set(p.id, { ...p }); }
  updatePlayer(id: string, patch: Partial<Pick<PlayerRow, 'score' | 'kicked' | 'name' | 'tokenHash'>>) {
    const p = this.players.get(id);
    if (!p) throw new Error('no player ' + id);
    Object.assign(p, patch);
  }
  listPlayers(sessionId: string) { return [...this.players.values()].filter((p) => p.sessionId === sessionId).sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ ...p })); }
  countPlayers(sessionId: string) { return this.listPlayers(sessionId).filter((p) => !p.kicked).length; }

  recordAnswer(a: AnswerRow) {
    if (this.answers.some((row) => row.sessionId === a.sessionId && row.playerId === a.playerId && row.questionId === a.questionId)) return false;
    const p = this.players.get(a.playerId);
    if (!p || p.sessionId !== a.sessionId || p.kicked) throw new Error('Answer player is missing or kicked');
    this.answers.push({ ...a });
    p.score += a.points;
    return true;
  }
  queueAnswer(a: AnswerRow) { this.queue.push({ ...a }); }
  listAnswers(sessionId: string) { this.flush(); return this.answers.filter((a) => a.sessionId === sessionId).map((a) => ({ ...a })); }
  flush() {
    for (const a of this.queue) {
      if (!this.answers.some((x) => x.sessionId === a.sessionId && x.playerId === a.playerId && x.qIndex === a.qIndex)) this.answers.push(a);
    }
    this.queue = [];
  }
  close() { this.flush(); }
}
