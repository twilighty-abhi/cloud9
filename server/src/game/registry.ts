// Cloud 9 — in-memory registry of live rooms.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DEFAULTS, type QuizDef, type SessionSummary, type PublicSession } from '../../../shared/model';
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

  private newRoom(row: SessionRow): Room {
    return new Room(this.repo, this.config.publicUrl, this.graceMs, row);
  }

  private freshCode(): string {
    for (let i = 0; i < 1000; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  createSession(input: { quiz: QuizDef; moderatorId: string; label: string; listed: boolean }): SessionSummary {
    const row: SessionRow = {
      id: randomUUID(),
      code: this.freshCode(),
      quizId: input.quiz.id,
      moderatorId: input.moderatorId,
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
    const room = this.newRoom(row);
    this.rooms.set(room.code, room);
    return room.summary();
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
    return { code: r.code, title: r.quiz.title, label: r.label, state: r.state, emailMode: r.quiz.emailMode, joinOpen: r.joinOpen };
  }

  join(code: string, req: JoinReq): JoinResult {
    const r = this.rooms.get(code);
    if (!r) return { ok: false, error: 'not_found' };
    if (r.state === 'FINISHED') return { ok: false, error: 'finished' };
    if (!r.joinOpen) return { ok: false, error: 'join_closed' };
    const name = cleanName(req?.name);
    if (!name) return { ok: false, error: 'invalid_name' };
    const em = checkEmail(req?.email, r.quiz.emailMode);
    if (!em.ok) return { ok: false, error: em.error };
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
    return { ok: true, playerId: row.id, token, name: display };
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
    for (const s of this.repo.loadUnfinishedSessions()) {
      try {
        if (this.rooms.has(s.code)) continue;
        const room = this.newRoom(s);
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
