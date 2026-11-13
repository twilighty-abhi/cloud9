// Cloud 9 — in-memory registry of live rooms.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DEFAULTS, type QuizDef, type SessionSummary, type PublicSession, type EventDef } from '../../../shared/model';
import type { PlayInfo, JoinReq, SessionPatch } from '../../../shared/api';
import type { GameRegistry, JoinResult, Repo, SessionRow, PlayerRow } from '../contracts';
import type { Config } from '../config';
import { Room } from './room';
import { cleanName, checkEmail, dedupeName } from './validate';

export const EVICT_AFTER_MS = 6 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 10 * 60 * 1000;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class Registry implements GameRegistry {
  readonly rooms = new Map<string, Room>();
  private sweepTimer: NodeJS.Timeout;

  constructor(private readonly repo: Repo, private readonly config: Config, private readonly graceMs = DEFAULTS.graceMs) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.sweepTimer.unref();
  }

  get(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  private newRoom(row: SessionRow, event: EventDef | null): Room {
    return new Room(this.repo, this.config.publicUrl, this.graceMs, row, event);
  }

  private freshCode(): string {
    for (let i = 0; i < 1000; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!this.rooms.has(code) && !this.repo.getLatestSessionByCode(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  createSession(input: { quiz: QuizDef; event: EventDef | null; moderatorId: string; label: string; listed: boolean }): SessionSummary {
    const event = input.event ?? null;
    const row: SessionRow = {
      id: randomUUID(),
      code: this.freshCode(),
      quizId: input.quiz.id,
      moderatorId: input.moderatorId,
      eventId: event ? event.id : null,
      label: (input.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      listed: !!input.listed,
      joinOpen: true,
      state: 'LOBBY',
      qIndex: -1,
      qStartedAt: null,
      qEndsAt: null,
      quiz: structuredClone(input.quiz),
      createdAt: Date.now(),
      endedAt: null,
    };
    this.repo.insertSession(row);
    const room = this.newRoom(row, event);
    this.rooms.set(room.code, room);
    return room.summary();
  }

  refreshEvent(id: string, event: EventDef | null): void {
    for (const room of this.rooms.values()) {
      if (room.eventId === id) room.refreshEvent(event);
    }
  }

  liveCountByEvent(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.rooms.values()) {
      if (r.eventId && r.state !== 'FINISHED') out.set(r.eventId, (out.get(r.eventId) ?? 0) + 1);
    }
    return out;
  }

  summary(code: string): SessionSummary | null {
    return this.rooms.get(code)?.summary() ?? null;
  }

  listSummaries(moderatorId?: string): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const r of this.rooms.values()) if (!moderatorId || r.moderatorId === moderatorId) out.push(r.summary());
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  publicList(): PublicSession[] {
    const out: PublicSession[] = [];
    for (const r of this.rooms.values()) if (r.listed && r.state !== 'FINISHED') out.push(r.publicInfo());
    return out;
  }

  playInfo(code: string): PlayInfo | null {
    const r = this.rooms.get(code);
    if (!r) return null;
    return { code: r.code, eventName: r.eventName, title: r.quiz.title, label: r.label, state: r.state, emailMode: r.emailMode, joinOpen: r.joinOpen };
  }

  join(code: string, req: JoinReq): JoinResult {
    const r = this.rooms.get(code);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.state === 'FINISHED') return { ok: false, error: 'finished' };
    const tokenToResume = req?.token;
    if (tokenToResume && tokenToResume.length <= 200) {
      const existing = r.findByTokenHash(sha256Hex(tokenToResume));
      if (existing) {
        if (existing.kicked) return { ok: false, error: 'kicked' };
        return { ok: true, playerId: existing.id, token: tokenToResume, name: existing.name, rejoined: true };
      }
    }
    const name = cleanName(req?.name);
    const em = checkEmail(req?.email, r.emailMode);
    if (!r.joinOpen) return { ok: false, error: 'join_closed' };
    if (!name) return { ok: false, error: 'invalid_name' };
    if (!em.ok) return { ok: false, error: em.error };
    const existingEmail = em.email ? r.findByEmail(em.email) : null;
    if (existingEmail) return { ok: false, error: existingEmail.kicked ? 'kicked' : 'email_in_use' };
    if (r.activeCount() >= this.config.maxPlayersPerRoom) return { ok: false, error: 'room_full' };

    const display = dedupeName(name, r.nameKeys);
    const token = randomBytes(24).toString('base64url');
    const row: PlayerRow = {
      id: randomUUID(),
      sessionId: r.id,
      name: display,
      email: em.email,
      tokenHash: sha256Hex(token),
      score: 0,
      kicked: false,
      joinedAt: Date.now(),
    };
    this.repo.insertPlayer(row);
    r.addPlayer(row);
    r.onJoined();
    return { ok: true, playerId: row.id, token, name: display, rejoined: false };
  }

  patch(code: string, patch: SessionPatch): SessionSummary | null {
    const r = this.rooms.get(code);
    if (!r) return null;
    r.applyPatch(patch ?? {});
    return r.summary();
  }

  ownerOf(code: string): string | null {
    return this.rooms.get(code)?.moderatorId ?? null;
  }

  restore(): number {
    let n = 0;
    const recent = this.repo.loadRecentFinishedSessions(Date.now() - EVICT_AFTER_MS);
    for (const s of [...this.repo.loadUnfinishedSessions(), ...recent]) {
      try {
        if (this.rooms.has(s.code)) continue;
        let event: EventDef | null = null;
        if (s.eventId) {
          try { event = this.repo.getEvent(s.eventId); } catch (e) { console.error(`[game] getEvent failed for session ${s.id}`, e); }
        }
        const room = this.newRoom(s, event);
        for (const p of this.repo.listPlayers(s.id)) room.addPlayer(p);
        room.restoreAnswers(this.repo.listAnswers(s.id));
        this.rooms.set(room.code, room);
        n++;
      } catch (e) {
        console.error(`[game] failed to restore session ${s.id}`, e);
      }
    }
    return n;
  }

  stats(): { rooms: number; sockets: number } {
    let rooms = 0;
    let sockets = 0;
    for (const r of this.rooms.values()) {
      if (r.state !== 'FINISHED') rooms++;
      sockets += r.socketCount();
    }
    return { rooms, sockets };
  }

  sweep(now = Date.now()): void {
    for (const [code, r] of this.rooms) {
      if (r.state === 'FINISHED' && r.endedAt !== null && now - r.endedAt > EVICT_AFTER_MS) {
        r.dispose(1001);
        this.rooms.delete(code);
      }
    }
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const r of this.rooms.values()) r.dispose(1001);
  }
}
