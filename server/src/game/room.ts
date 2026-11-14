// Cloud 9 — one live room: state machine, scoring, snapshots, broadcasting.
import type { WebSocket } from 'ws';
import {
  scoreAnswer, DEFAULTS, type QuizDef, type RoomState, type LeaderEntry, type SessionSummary, type PublicSession,
  type EventDef, type EventLeaderEntry, type BoardTop, type EmailMode,
} from '../../../shared/model';
import type { PlayerSnapshot, HostSnapshot, QuestionPublic, ModAction, ErrorCode, ServerMsg } from '../../../shared/protocol';
import { WS_CLOSE } from '../../../shared/protocol';
import type { Repo, SessionRow, PlayerRow, AnswerRow } from '../contracts';
import { sendRaw, sendMsg, safeClose } from '../realtime/send';
import { bus } from '../notify/bus';

const DELTA_INTERVAL_MS = 250; // max 4 deltas / s / room
const PLAYER_TOP = 3;           // players see only the top 3 of the quiz / event boards
const EVENT_BOARD_REUSE_MS = 2000; // single-socket sends (connect/reconnect) reuse the last event board for this long

/** Event standings computed once per broadcast and shared by every socket. */
interface EventStandings { v: number; at: number; list: EventLeaderEntry[]; byKey: Map<string, EventLeaderEntry> }

export interface PlayerAnswer { choice: number; correct: boolean; points: number; responseMs: number }

export interface PlayerMem {
  id: string;
  name: string;
  email: string | null;
  tokenHash: string;
  score: number;
  kicked: boolean;
  joinedAt: number;
  answers: Map<number, PlayerAnswer>;
  sockets: Set<WebSocket>;
}

export type Result = { ok: true } | { ok: false; code: ErrorCode; message: string };
const fail = (code: ErrorCode, message: string): Result => ({ ok: false, code, message });

interface Ranked { p: PlayerMem; score: number; ms: number }

export class Room {
  readonly id: string;
  readonly code: string;
  readonly quiz: QuizDef;
  readonly moderatorId: string;
  readonly createdAt: number;
  readonly eventId: string | null;
  readonly eventName: string | null;
  readonly eventEmailRequired: boolean;
  label: string;
  listed: boolean;
  joinOpen: boolean;
  state: RoomState;
  qIndex: number;
  qStartedAt: number | null;
  qEndsAt: number | null;
  endedAt: number | null;
  /** Monotonic across restarts: seeded from the clock, +1 per change. */
  v: number;

  readonly players = new Map<string, PlayerMem>(); // insertion order = join order
  private readonly byToken = new Map<string, PlayerMem>();
  readonly nameKeys = new Set<string>();
  readonly mods = new Set<WebSocket>();
  readonly presents = new Set<WebSocket>();

  private answered = 0;
  private distribution: number[] = [];
  private closeTimer: NodeJS.Timeout | null = null;
  private deltaTimer: NodeJS.Timeout | null = null;
  private lastDeltaAt = 0;
  private lobbyDirty = false;
  private progressDirty = false;
  private ranking: Ranked[] | null = null;
  private rankOf: Map<string, number> | null = null;
  private eventCache: EventStandings | null = null;

  constructor(
    private readonly repo: Repo, private readonly joinUrlBase: string, private readonly graceMs: number, row: SessionRow,
    event: EventDef | null = null,
  ) {
    this.id = row.id;
    this.eventId = row.eventId ?? null;
    // eventName is null if the event was deleted (then no event board is shown, but sessions.event_id keeps history)
    this.eventName = event && this.eventId === event.id ? event.name : null;
    this.eventEmailRequired = !!(event && this.eventId === event.id && event.emailRequired);
    this.code = row.code;
    this.quiz = row.quiz;
    this.moderatorId = row.moderatorId;
    this.createdAt = row.createdAt;
    this.label = row.label;
    this.listed = row.listed;
    this.joinOpen = row.joinOpen;
    this.state = row.state;
    this.qIndex = row.qIndex;
    this.qStartedAt = row.qStartedAt;
    this.qEndsAt = row.qEndsAt;
    this.endedAt = row.endedAt;
    this.v = Date.now();
  }

  // ───────────── helpers ─────────────

  get total(): number { return this.quiz.questions.length; }
  get joinUrl(): string { return `${this.joinUrlBase}/join/${this.code}`; }
  /** Effective email mode: an event with emailRequired forces 'required' regardless of the quiz's own mode. */
  get emailMode(): EmailMode { return this.eventEmailRequired ? 'required' : this.quiz.emailMode; }

  activeCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.kicked) n++;
    return n;
  }

  socketCount(): number {
    let n = this.mods.size + this.presents.size;
    for (const p of this.players.values()) n += p.sockets.size;
    return n;
  }

  findByTokenHash(hash: string): PlayerMem | null { return this.byToken.get(hash) ?? null; }

  /** Player with this (lowercase) email: a non-kicked one wins; otherwise a kicked one; else null. */
  findByEmail(email: string): PlayerMem | null {
    let kicked: PlayerMem | null = null;
    for (const p of this.players.values()) {
      if (p.email !== email) continue;
      if (!p.kicked) return p;
      kicked ??= p;
    }
    return kicked;
  }

  /** Rejoin by email: register a fresh token for an existing player (the previous token keeps working in memory). */
  rebindToken(p: PlayerMem, tokenHash: string): void {
    p.tokenHash = tokenHash;
    this.byToken.set(tokenHash, p);
  }

  /** Event identity key for a player (matches repo.eventLeaderboard keys). */
  private eventKey(p: PlayerMem): string { return p.email ? p.email : `p:${p.id}`; }

  private showBoards(): boolean { return this.state === 'LEADERBOARD' || this.state === 'FINISHED'; }

  /**
   * Event standings for the current state, or null (no event / not a leaderboard state / repo failure).
   * fresh=true recomputes (one SQL aggregate) — used once per broadcast; otherwise a recent result for this v is reused.
   */
  private eventStandings(fresh: boolean): EventStandings | null {
    if (!this.eventId || this.eventName === null || !this.showBoards()) return null;
    const now = Date.now();
    const c = this.eventCache;
    if (!fresh && c && c.v === this.v && now - c.at < EVENT_BOARD_REUSE_MS) return c;
    try {
      const list = this.repo.eventLeaderboard(this.eventId);
      const byKey = new Map<string, EventLeaderEntry>();
      for (const e of list) byKey.set(e.key, e);
      this.eventCache = { v: this.v, at: now, list, byKey };
      return this.eventCache;
    } catch (e) {
      console.error(`[game] repo.eventLeaderboard failed (room ${this.code})`, e);
      return null;
    }
  }

  private static boardTop(list: EventLeaderEntry[], n: number): BoardTop[] {
    const out: BoardTop[] = [];
    for (let i = 0; i < list.length && i < n; i++) out.push({ name: list[i].name, score: list[i].score, rank: list[i].rank });
    return out;
  }

  private hostEventBoard(ev: EventStandings | null): HostSnapshot['eventBoard'] {
    if (!ev || this.eventName === null) return null;
    return { eventName: this.eventName, top: Room.boardTop(ev.list, DEFAULTS.leaderboardSize), total: ev.list.length };
  }

  private playerEventBoard(p: PlayerMem, ev: EventStandings | null, top: BoardTop[] | null): PlayerSnapshot['eventBoard'] {
    if (!ev || this.eventName === null) return null;
    const mine = ev.byKey.get(this.eventKey(p));
    return {
      eventName: this.eventName,
      top: top ?? Room.boardTop(ev.list, PLAYER_TOP),
      me: mine ? { rank: mine.rank, score: mine.score } : null,
      total: ev.list.length,
    };
  }

  private safeRepo(what: string, fn: () => void): void {
    try { fn(); } catch (e) { console.error(`[game] repo.${what} failed (room ${this.code})`, e); }
  }

  /** While a question is open/closed-but-not-revealed, its points are hidden from displayed scores (no correctness leak). */
  private hiding(): boolean { return this.state === 'QUESTION' || this.state === 'CLOSED'; }

  private displayScore(p: PlayerMem): number {
    if (!this.hiding()) return p.score;
    return p.score - (p.answers.get(this.qIndex)?.points ?? 0);
  }

  private invalidateRanking(): void { this.ranking = null; this.rankOf = null; }

  private getRanking(): Ranked[] {
    if (this.ranking) return this.ranking;
    const hide = this.hiding();
    const list: Ranked[] = [];
    for (const p of this.players.values()) {
      if (p.kicked) continue;
      let ms = 0;
      for (const [qi, a] of p.answers) if (a.correct && !(hide && qi === this.qIndex)) ms += a.responseMs;
      list.push({ p, score: this.displayScore(p), ms });
    }
    list.sort((a, b) => b.score - a.score || a.ms - b.ms || a.p.joinedAt - b.p.joinedAt);
    this.ranking = list;
    this.rankOf = new Map(list.map((r, i) => [r.p.id, i + 1]));
    return list;
  }

  private leaderboard(): LeaderEntry[] {
    return this.getRanking().slice(0, DEFAULTS.leaderboardSize).map((r, i) => ({ playerId: r.p.id, name: r.p.name, score: r.score, rank: i + 1 }));
  }

  private rankFor(id: string): number | null {
    if (this.state === 'LOBBY') return null;
    this.getRanking();
    return this.rankOf!.get(id) ?? null;
  }

  private currentQuestion(): QuestionPublic | null {
    if (this.state === 'LOBBY' || this.state === 'FINISHED') return null;
    const q = this.quiz.questions[this.qIndex];
    if (!q) return null;
    return {
      qIndex: this.qIndex,
      total: this.total,
      text: q.text,
      imageUrl: q.imageUrl,
      options: q.options,
      timeLimitSec: q.timeLimitSec,
      startedAt: this.qStartedAt ?? 0,
      endsAt: this.qEndsAt ?? 0,
    };
  }

  private recomputeCounts(): void {
    const q = this.quiz.questions[this.qIndex];
    this.answered = 0;
    this.distribution = q ? new Array(q.options.length).fill(0) : [];
    if (!q) return;
    for (const p of this.players.values()) {
      const a = p.answers.get(this.qIndex);
      if (!a) continue;
      this.answered++;
      if (a.choice < this.distribution.length) this.distribution[a.choice]++;
    }
  }

  private hostPlayers(): HostSnapshot['players'] {
    const out: HostSnapshot['players'] = [];
    for (const p of this.players.values()) {
      if (!p.kicked) out.push({ id: p.id, name: p.name, score: this.displayScore(p), connected: p.sockets.size > 0 });
    }
    return out;
  }

  // ───────────── snapshots ─────────────

  hostSnapshot(role: 'mod' | 'present', ev: EventStandings | null = this.eventStandings(false)): HostSnapshot {
    const question = this.currentQuestion();
    const q = question ? this.quiz.questions[this.qIndex] : undefined;
    const showCorrect = role === 'mod' || this.state === 'REVEAL' || this.state === 'LEADERBOARD';
    const showDist = this.state === 'CLOSED' || this.state === 'REVEAL' || this.state === 'LEADERBOARD';
    let nextQuestion: HostSnapshot['nextQuestion'] = null;
    if (role === 'mod' && this.state !== 'FINISHED') {
      const nq = this.quiz.questions[this.qIndex + 1];
      if (nq) nextQuestion = { text: nq.text, options: nq.options, correctIndex: nq.correctIndex };
    }
    const players = this.hostPlayers();
    return {
      role,
      code: this.code,
      title: this.quiz.title,
      label: this.label,
      state: this.state,
      v: this.v,
      serverNow: Date.now(),
      joinUrl: this.joinUrl,
      listed: this.listed,
      joinOpen: this.joinOpen,
      qIndex: this.qIndex,
      total: this.total,
      playerCount: players.length,
      players,
      question,
      correctIndex: q && showCorrect ? q.correctIndex : null,
      answered: question ? this.answered : 0,
      distribution: question && showDist ? [...this.distribution] : null,
      leaderboard: this.state === 'LOBBY' ? [] : this.leaderboard(),
      eventId: this.eventId,
      eventName: this.eventName,
      eventBoard: this.hostEventBoard(ev),
      nextQuestion,
    };
  }

  playerSnapshot(
    p: PlayerMem, playerCount = this.activeCount(), lb?: LeaderEntry[] | null,
    ev: EventStandings | null = this.eventStandings(false), evTop: BoardTop[] | null = null,
  ): PlayerSnapshot {
    const question = this.currentQuestion();
    const q = question ? this.quiz.questions[this.qIndex] : undefined;
    const a = question ? p.answers.get(this.qIndex) : undefined;
    const revealed = this.state === 'REVEAL' || this.state === 'LEADERBOARD';
    const showLb = this.state === 'LEADERBOARD' || this.state === 'FINISHED';
    return {
      role: 'player',
      code: this.code,
      eventName: this.eventName,
      title: this.quiz.title,
      label: this.label,
      state: this.state,
      v: this.v,
      serverNow: Date.now(),
      playerCount,
      me: { id: p.id, name: p.name, score: this.displayScore(p), rank: this.rankFor(p.id) },
      question,
      myAnswer: a ? { choice: a.choice } : null,
      reveal: revealed && q ? { correctIndex: q.correctIndex, correct: !!a?.correct, points: a?.points ?? 0 } : null,
      leaderboard: showLb ? (lb !== undefined ? lb : this.leaderboard().slice(0, PLAYER_TOP)) : null,
      eventBoard: showLb ? this.playerEventBoard(p, ev, evTop) : null,
    };
  }

  sendStateTo(ws: WebSocket, role: 'mod' | 'present' | 'player', p?: PlayerMem): void {
    if (role === 'player') {
      if (p) sendMsg(ws, { t: 'state', ...this.playerSnapshot(p) });
    } else {
      sendMsg(ws, { t: 'state', ...this.hostSnapshot(role) });
    }
  }

  /** Full snapshot to every socket: hosts serialized once per role, players once per player. */
  broadcastState(): void {
    // A full state supersedes pending deltas.
    this.lobbyDirty = false;
    this.progressDirty = false;
    // Event standings: ONE aggregate query per broadcast, shared by every socket below.
    const ev = this.eventStandings(true);
    if (this.mods.size) {
      const s = JSON.stringify({ t: 'state', ...this.hostSnapshot('mod', ev) });
      for (const ws of this.mods) sendRaw(ws, s);
    }
    if (this.presents.size) {
      const s = JSON.stringify({ t: 'state', ...this.hostSnapshot('present', ev) });
      for (const ws of this.presents) sendRaw(ws, s);
    }
    const count = this.activeCount();
    const showLb = this.showBoards();
    const lb = showLb ? this.leaderboard().slice(0, PLAYER_TOP) : null;
    const evTop = ev ? Room.boardTop(ev.list, PLAYER_TOP) : null;
    for (const p of this.players.values()) {
      if (p.kicked || p.sockets.size === 0) continue;
      const s = JSON.stringify({ t: 'state', ...this.playerSnapshot(p, count, lb, ev, evTop) });
      for (const ws of p.sockets) sendRaw(ws, s);
    }
  }

  // ───────────── deltas (throttled, trailing edge) ─────────────

  private markDelta(kind: 'lobby' | 'progress'): void {
    if (kind === 'lobby') this.lobbyDirty = true; else this.progressDirty = true;
    if (this.deltaTimer) return;
    const wait = this.lastDeltaAt + DELTA_INTERVAL_MS - Date.now();
    if (wait <= 0) this.flushDeltas();
    else {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), wait);
      this.deltaTimer.unref();
    }
  }

  private flushDeltas(): void {
    this.deltaTimer = null;
    try {
      if (!this.lobbyDirty && !this.progressDirty) return;
      this.lastDeltaAt = Date.now();
      const hasHosts = this.mods.size + this.presents.size > 0;
      const msgs: string[] = [];
      if (hasHosts && this.lobbyDirty) {
        const players = this.hostPlayers();
        msgs.push(JSON.stringify({ t: 'lobby', v: this.v, playerCount: players.length, players } satisfies ServerMsg));
      }
      if (hasHosts && this.progressDirty && this.state === 'QUESTION') {
        msgs.push(JSON.stringify({ t: 'progress', v: this.v, answered: this.answered, playerCount: this.activeCount() } satisfies ServerMsg));
      }
      this.lobbyDirty = false;
      this.progressDirty = false;
      for (const m of msgs) {
        for (const ws of this.mods) sendRaw(ws, m);
        for (const ws of this.presents) sendRaw(ws, m);
      }
    } catch (e) {
      console.error(`[game] delta flush failed (room ${this.code})`, e);
    }
  }

  // ───────────── state machine ─────────────

  private persistState(): void {
    this.safeRepo('updateSession', () =>
      this.repo.updateSession(this.id, { state: this.state, qIndex: this.qIndex, qStartedAt: this.qStartedAt, qEndsAt: this.qEndsAt, endedAt: this.endedAt }),
    );
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  private commit(): void {
    this.v++;
    this.invalidateRanking();
    this.persistState();
    this.broadcastState();
  }

  /** Notify-bus emit: payload built lazily, failures logged and swallowed (never affects the game). */
  private notify(build: () => Parameters<typeof bus.emit>[0]): void {
    try { bus.emit(build()); } catch (e) { console.error(`[game] notify emit failed (room ${this.code})`, (e as Error)?.message); }
  }

  private openQuestion(i: number, actor: string | null = null): void {
    const q = this.quiz.questions[i];
    if (!q) { this.finish(actor, false); return; }
    const starting = this.state === 'LOBBY';
    const now = Date.now();
    this.clearCloseTimer();
    this.state = 'QUESTION';
    this.qIndex = i;
    this.qStartedAt = now;
    this.qEndsAt = now + q.timeLimitSec * 1000;
    this.recomputeCounts();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      try { if (this.state === 'QUESTION' && this.qIndex === i) this.closeQuestion(); } catch (e) { console.error('[game] auto-close failed', e); }
    }, this.qEndsAt + this.graceMs - now);
    this.closeTimer.unref();
    this.commit();
    if (starting && i === 0) this.notify(() => ({ type: 'session.started', at: Date.now(), actor, session: this.summary() }));
    this.checkAllAnswered();
  }

  private closeQuestion(actor: string | null = null): void {
    this.clearCloseTimer();
    this.state = 'CLOSED';
    this.recomputeCounts();
    this.commit();
    this.notify(() => {
      let correct = 0;
      for (const p of this.players.values()) if (p.answers.get(this.qIndex)?.correct) correct++;
      return {
        type: 'question.closed', at: Date.now(), actor, session: this.summary(), qIndex: this.qIndex,
        answered: this.answered, playerCount: this.activeCount(), correct,
      };
    });
  }

  private finish(actor: string | null = null, endedEarly = false): void {
    this.clearCloseTimer();
    this.state = 'FINISHED';
    this.endedAt = Date.now();
    this.commit();
    this.notify(() => {
      // FINISHED: nothing is hidden, so leaderboard() carries all points. commit() → broadcastState() just computed
      // the event standings for this v; eventStandings(false) reuses that result (no extra query).
      const leaderboard: BoardTop[] = this.leaderboard().map((e) => ({ name: e.name, score: e.score, rank: e.rank }));
      const ev = this.eventStandings(false);
      const eventBoard = ev && this.eventName !== null
        ? { eventName: this.eventName, top: Room.boardTop(ev.list, DEFAULTS.leaderboardSize), total: ev.list.length }
        : null;
      return { type: 'session.finished', at: Date.now(), actor, session: this.summary(), endedEarly, leaderboard, eventBoard };
    });
  }

  /** actor = username of the moderator who sent the action (for notifications); optional for compatibility. */
  modAction(action: ModAction, expectQ: number, actor: string | null = null): Result {
    if (expectQ !== this.qIndex) return fail('stale', `Room is at question ${this.qIndex}, not ${expectQ}`);
    const s = this.state;
    switch (action) {
      case 'start':
        if (s !== 'LOBBY') return fail('bad_transition', `Cannot start from ${s}`);
        if (this.total === 0) this.finish(actor, false); else this.openQuestion(0, actor);
        return { ok: true };
      case 'close':
        if (s !== 'QUESTION') return fail('bad_transition', `Cannot close from ${s}`);
        this.closeQuestion(actor);
        return { ok: true };
      case 'reveal':
        if (s !== 'CLOSED') return fail('bad_transition', `Cannot reveal from ${s}`);
        this.state = 'REVEAL';
        this.commit();
        return { ok: true };
      case 'leaderboard':
        if (s !== 'REVEAL') return fail('bad_transition', `Cannot show leaderboard from ${s}`);
        this.state = 'LEADERBOARD';
        this.commit();
        return { ok: true };
      case 'next':
        if (s !== 'REVEAL' && s !== 'LEADERBOARD') return fail('bad_transition', `Cannot go next from ${s}`);
        if (this.qIndex + 1 >= this.total) this.finish(actor, false); else this.openQuestion(this.qIndex + 1, actor);
        return { ok: true };
      case 'end':
        if (s === 'FINISHED') return fail('bad_transition', 'Already finished');
        this.finish(actor, this.qIndex < this.total - 1);
        return { ok: true };
      default:
        return fail('bad_message', 'Unknown action');
    }
  }

  /** Auto-close when every connected, non-kicked player has answered (requires ≥1 such player). */
  private checkAllAnswered(): void {
    if (this.state !== 'QUESTION') return;
    let connected = 0;
    for (const p of this.players.values()) {
      if (p.kicked || p.sockets.size === 0) continue;
      connected++;
      if (!p.answers.has(this.qIndex)) return;
    }
    if (connected > 0) this.closeQuestion();
  }

  answer(p: PlayerMem, qIndex: number, choice: number, now = Date.now()): Result {
    if (p.kicked) return fail('unauthorized', 'Kicked');
    if (qIndex !== this.qIndex) return fail('stale', 'Not the current question');
    if (this.state !== 'QUESTION') return fail('too_late', 'Question is closed');
    const q = this.quiz.questions[qIndex];
    if (!q || !Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return fail('bad_message', 'Invalid choice');
    if (p.answers.has(qIndex)) return fail('already_answered', 'Already answered');
    if (this.qEndsAt === null || this.qStartedAt === null || now > this.qEndsAt + this.graceMs) return fail('too_late', 'Time is up');

    const responseMs = Math.max(0, now - this.qStartedAt);
    const correct = choice === q.correctIndex;
    const points = scoreAnswer({ correct, responseMs, timeLimitSec: q.timeLimitSec, pointsMax: q.pointsMax, scoring: this.quiz.scoring });
    p.answers.set(qIndex, { choice, correct, points, responseMs });
    p.score += points;
    this.answered++;
    if (choice < this.distribution.length) this.distribution[choice]++;

    const row: AnswerRow = { sessionId: this.id, playerId: p.id, questionId: q.id, qIndex, choice, correct, responseMs, points, answeredAt: now };
    // Answer row + score in one synchronous transaction (crash-consistent). If that fails, fall back to the old path
    // (score update + buffered row, retried by the queue) so a transient DB error never loses the answer.
    try {
      this.repo.recordAnswer(row, p.id, points ? p.score : null);
    } catch (e) {
      console.error(`[game] repo.recordAnswer failed (room ${this.code}); falling back to queue`, e);
      if (points) this.safeRepo('updatePlayer', () => this.repo.updatePlayer(p.id, { score: p.score }));
      this.safeRepo('queueAnswer', () => this.repo.queueAnswer(row));
    }

    const ack = JSON.stringify({ t: 'ack', v: this.v, qIndex, choice } satisfies ServerMsg);
    for (const ws of p.sockets) sendRaw(ws, ack);
    this.markDelta('progress');
    this.checkAllAnswered();
    return { ok: true };
  }

  // ───────────── players & sockets ─────────────

  /** Add a player to memory (from join or restore). */
  addPlayer(row: PlayerRow): PlayerMem {
    const p: PlayerMem = {
      id: row.id, name: row.name, email: row.email, tokenHash: row.tokenHash, score: row.score,
      kicked: row.kicked, joinedAt: row.joinedAt, answers: new Map(), sockets: new Set(),
    };
    this.players.set(p.id, p);
    this.byToken.set(p.tokenHash, p);
    this.nameKeys.add(p.name.toLowerCase());
    this.invalidateRanking();
    return p;
  }

  onJoined(): void { this.markDelta('lobby'); }

  kick(playerId: string, actor: string | null = null): Result {
    const p = this.players.get(playerId);
    if (!p) return fail('not_found', 'Player not found');
    if (p.kicked) return { ok: true };
    p.kicked = true;
    this.invalidateRanking();
    this.safeRepo('updatePlayer', () => this.repo.updatePlayer(p.id, { kicked: true }));
    const sockets = [...p.sockets];
    p.sockets.clear();
    for (const ws of sockets) {
      sendMsg(ws, { t: 'kicked' });
      safeClose(ws, WS_CLOSE.KICKED, 'kicked');
    }
    this.checkAllAnswered();
    if (this.state === 'REVEAL' || this.state === 'LEADERBOARD' || this.state === 'FINISHED') {
      // Leaderboards are only rebuilt on full snapshots — push one so the kicked name disappears now.
      this.broadcastState();
    } else {
      this.markDelta('lobby');
    }
    if (actor !== null) this.notify(() => ({ type: 'player.kicked', at: Date.now(), actor, session: this.summary(), playerName: p.name }));
    return { ok: true };
  }

  attachHost(ws: WebSocket, role: 'mod' | 'present'): void {
    (role === 'mod' ? this.mods : this.presents).add(ws);
    this.sendStateTo(ws, role);
  }

  detachHost(ws: WebSocket): void {
    this.mods.delete(ws);
    this.presents.delete(ws);
  }

  attachPlayer(ws: WebSocket, p: PlayerMem): void {
    const wasConnected = p.sockets.size > 0;
    p.sockets.add(ws);
    this.sendStateTo(ws, 'player', p);
    if (!wasConnected) this.markDelta('lobby');
  }

  detachPlayer(ws: WebSocket, p: PlayerMem): void {
    if (!p.sockets.delete(ws)) return;
    if (p.sockets.size === 0) {
      this.markDelta('lobby');
      this.checkAllAnswered();
    }
  }

  // ───────────── settings / summaries ─────────────

  applyPatch(patch: { label?: string; listed?: boolean; joinOpen?: boolean }): void {
    const upd: { label?: string; listed?: boolean; joinOpen?: boolean } = {};
    if (typeof patch.label === 'string') this.label = upd.label = patch.label.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (typeof patch.listed === 'boolean') this.listed = upd.listed = patch.listed;
    if (typeof patch.joinOpen === 'boolean') this.joinOpen = upd.joinOpen = patch.joinOpen;
    if (Object.keys(upd).length === 0) return;
    this.safeRepo('updateSession', () => this.repo.updateSession(this.id, upd));
    this.v++;
    this.broadcastState();
  }

  summary(): SessionSummary {
    return {
      id: this.id, code: this.code, quizId: this.quiz.id, moderatorId: this.moderatorId, eventId: this.eventId, eventName: this.eventName,
      title: this.quiz.title, label: this.label,
      state: this.state, qIndex: this.qIndex, total: this.total, players: this.activeCount(), listed: this.listed, joinOpen: this.joinOpen,
      joinUrl: this.joinUrl, createdAt: this.createdAt, endedAt: this.endedAt,
    };
  }

  publicInfo(): PublicSession {
    return {
      code: this.code, eventName: this.eventName, title: this.quiz.title, label: this.label, state: this.state, qIndex: this.qIndex,
      total: this.total, players: this.activeCount(), joinOpen: this.joinOpen,
    };
  }

  /** Restore helper: load past answers; an open QUESTION becomes CLOSED (persisted). */
  restoreAnswers(rows: AnswerRow[]): void {
    for (const a of rows) {
      const p = this.players.get(a.playerId);
      if (!p || p.answers.has(a.qIndex)) continue;
      p.answers.set(a.qIndex, { choice: a.choice, correct: a.correct, points: a.points, responseMs: a.responseMs });
    }
    if (this.state === 'QUESTION') {
      this.state = 'CLOSED';
      this.persistState();
    }
    this.recomputeCounts();
    this.invalidateRanking();
  }

  dispose(code = 1001): void {
    this.clearCloseTimer();
    if (this.deltaTimer) { clearTimeout(this.deltaTimer); this.deltaTimer = null; }
    for (const ws of this.mods) safeClose(ws, code, 'shutdown');
    for (const ws of this.presents) safeClose(ws, code, 'shutdown');
    for (const p of this.players.values()) for (const ws of p.sockets) safeClose(ws, code, 'shutdown');
    this.mods.clear();
    this.presents.clear();
    for (const p of this.players.values()) p.sockets.clear();
  }
}
