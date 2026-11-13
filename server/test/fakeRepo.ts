// In-memory Repo for game engine tests.
import type { Repo, SessionRow, PlayerRow, AnswerRow, ModeratorRow } from '../src/contracts';
import type { QuizDef, QuizListItem } from '../../shared/model';

export class FakeRepo implements Repo {
  moderators = new Map<string, ModeratorRow>();
  quizzes = new Map<string, QuizDef>();
  sessions = new Map<string, SessionRow>();
  players = new Map<string, PlayerRow>();
  answers: AnswerRow[] = [];
  queue: AnswerRow[] = [];
  sessionUpdates = 0;

  upsertModerator(m: ModeratorRow) { this.moderators.set(m.id, { ...m }); }
  listQuizzes(moderatorId: string | null): QuizListItem[] {
    return [...this.quizzes.values()]
      .filter((q) => !moderatorId || q.moderatorId === moderatorId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((q) => ({ id: q.id, moderatorId: q.moderatorId, title: q.title, questionCount: q.questions.length, updatedAt: q.updatedAt }));
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
  listSessions(moderatorId: string | null) {
    return [...this.sessions.values()].filter((s) => !moderatorId || s.moderatorId === moderatorId).sort((a, b) => b.createdAt - a.createdAt).map((s) => structuredClone(s));
  }
  loadUnfinishedSessions() { return [...this.sessions.values()].filter((s) => s.state !== 'FINISHED').map((s) => structuredClone(s)); }
  getLatestSessionByCode(code: string) { return this.listSessions(null).find((s) => s.code === code) ?? null; }

  insertPlayer(p: PlayerRow) { this.players.set(p.id, { ...p }); }
  updatePlayer(id: string, patch: Partial<Pick<PlayerRow, 'score' | 'kicked' | 'name'>>) {
    const p = this.players.get(id);
    if (!p) throw new Error('no player ' + id);
    Object.assign(p, patch);
  }
  listPlayers(sessionId: string) { return [...this.players.values()].filter((p) => p.sessionId === sessionId).sort((a, b) => a.joinedAt - b.joinedAt).map((p) => ({ ...p })); }
  countPlayers(sessionId: string) { return this.listPlayers(sessionId).filter((p) => !p.kicked).length; }

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
