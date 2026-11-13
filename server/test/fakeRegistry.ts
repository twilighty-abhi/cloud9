// Minimal in-memory GameRegistry for HTTP tests. Agent B.
import { randomBytes, createHash } from 'node:crypto';
import type { GameRegistry, JoinResult, Repo } from '../src/contracts';
import type { QuizDef, SessionSummary, PublicSession, EventDef } from '../../shared/model';
import type { JoinReq, PlayInfo, SessionPatch } from '../../shared/api';

interface FakeRoom { summary: SessionSummary; quiz: QuizDef; event: EventDef | null; names: string[]; emails: Map<string, string>; capacity: number }

export class FakeRegistry implements GameRegistry {
  rooms = new Map<string, FakeRoom>();
  publicListCalls = 0;
  private seq = 100000;
  constructor(private repo: Repo, private publicUrl = 'http://test.local') {}

  lastCreateEvent: EventDef | null | undefined = undefined;
  createSession(input: { quiz: QuizDef; event: EventDef | null; moderatorId: string; label: string; listed: boolean }): SessionSummary {
    this.lastCreateEvent = input.event;
    const code = String(this.seq++);
    const now = Date.now();
    const summary: SessionSummary = {
      id: `s_${code}_${randomBytes(3).toString('hex')}`, code, quizId: input.quiz.id, moderatorId: input.moderatorId,
      eventId: input.event?.id ?? null, eventName: input.event?.name ?? null,
      title: input.quiz.title, label: input.label, state: 'LOBBY', qIndex: -1, total: input.quiz.questions.length,
      players: 0, listed: input.listed, joinOpen: true, joinUrl: `${this.publicUrl}/join/${code}`, createdAt: now, endedAt: null,
    };
    this.repo.insertSession({
      id: summary.id, code, quizId: input.quiz.id, moderatorId: input.moderatorId, eventId: summary.eventId, label: input.label, listed: input.listed,
      joinOpen: true, state: 'LOBBY', qIndex: -1, qStartedAt: null, qEndsAt: null, quiz: input.quiz, createdAt: now, endedAt: null,
    });
    this.rooms.set(code, { summary, quiz: input.quiz, event: input.event, names: [], emails: new Map(), capacity: 500 });
    return { ...summary };
  }
  liveCountByEvent() {
    const m = new Map<string, number>();
    for (const r of this.rooms.values()) if (r.summary.eventId && r.summary.state !== 'FINISHED') m.set(r.summary.eventId, (m.get(r.summary.eventId) ?? 0) + 1);
    return m;
  }
  summary(code: string) { const r = this.rooms.get(code); return r ? { ...r.summary } : null; }
  listSummaries(moderatorId?: string) {
    return [...this.rooms.values()].map((r) => r.summary).filter((s) => !moderatorId || s.moderatorId === moderatorId);
  }
  publicList(): PublicSession[] {
    this.publicListCalls++;
    return [...this.rooms.values()]
      .filter((r) => r.summary.listed && r.summary.state !== 'FINISHED')
      .map(({ summary: s }) => ({ code: s.code, eventName: s.eventName, title: s.title, label: s.label, state: s.state, qIndex: s.qIndex, total: s.total, players: s.players, joinOpen: s.joinOpen }));
  }
  playInfo(code: string): PlayInfo | null {
    const r = this.rooms.get(code);
    if (!r) return null;
    const s = r.summary;
    return { code, eventName: s.eventName, title: s.title, label: s.label, state: s.state, emailMode: r.event?.emailRequired ? 'required' : r.quiz.emailMode, joinOpen: s.joinOpen };
  }
  join(code: string, req: JoinReq): JoinResult {
    const r = this.rooms.get(code);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.summary.state === 'FINISHED') return { ok: false, error: 'finished' };
    if (req.email === 'kicked@x.test') return { ok: false, error: 'kicked' };
    const prev = req.email ? r.emails.get(req.email.toLowerCase()) : undefined;
    if (prev) return { ok: true, playerId: prev, token: randomBytes(16).toString('base64url'), name: req.name, rejoined: true };
    if (!r.summary.joinOpen) return { ok: false, error: 'join_closed' };
    if (r.names.length >= r.capacity) return { ok: false, error: 'room_full' };
    const name = (req.name ?? '').trim();
    if (!name || name.length > 24) return { ok: false, error: 'invalid_name' };
    if (r.quiz.emailMode === 'required' && !req.email) return { ok: false, error: 'email_required' };
    if (req.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.email)) return { ok: false, error: 'invalid_email' };
    const n = r.names.filter((x) => x === name || x.startsWith(`${name} (`)).length;
    const finalName = n ? `${name} (${n + 1})` : name;
    r.names.push(finalName);
    const token = randomBytes(16).toString('base64url');
    const playerId = `p_${randomBytes(6).toString('hex')}`;
    this.repo.insertPlayer({
      id: playerId, sessionId: r.summary.id, name: finalName, email: req.email ?? null,
      tokenHash: createHash('sha256').update(token).digest('hex'), score: 0, kicked: false, joinedAt: Date.now() + r.names.length,
    });
    r.summary.players++;
    if (req.email) r.emails.set(req.email.toLowerCase(), playerId);
    return { ok: true, playerId, token, name: finalName, rejoined: false };
  }
  patch(code: string, patch: SessionPatch) {
    const r = this.rooms.get(code);
    if (!r) return null;
    Object.assign(r.summary, patch);
    this.repo.updateSession(r.summary.id, patch);
    return { ...r.summary };
  }
  endSessionCalls: { code: string; actor: string | null }[] = [];
  endSession(code: string, actor: string | null): { ok: true } | { ok: false; error: 'not_found' | 'finished' } {
    this.endSessionCalls.push({ code, actor });
    const r = this.rooms.get(code);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.summary.state === 'FINISHED') return { ok: false, error: 'finished' };
    r.summary.state = 'FINISHED';
    r.summary.endedAt = Date.now();
    this.repo.updateSession(r.summary.id, { state: 'FINISHED', endedAt: r.summary.endedAt });
    return { ok: true };
  }
  ownerOf(code: string) { return this.rooms.get(code)?.summary.moderatorId ?? null; }
  restore() { return 0; }
  stats() { return { rooms: this.rooms.size, sockets: 0 }; }
  /** test helper */
  setState(code: string, state: SessionSummary['state']) { const r = this.rooms.get(code); if (r) r.summary.state = state; }
}
