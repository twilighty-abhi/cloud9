// Cloud 9 load test — simulates moderators + players over the real HTTP API and WebSocket protocol.
//
//   npx tsx loadtest/bots.ts --url http://localhost:3000 --scenario B --user admin --pass admin
//   npx tsx loadtest/bots.ts --url http://localhost:3000 --rooms 5 --players 50 --questions 10 --churn 0.2 --time 8
//
// Scenarios (PLAN §18): A = 1 room × 250, B = 5 rooms × 50, C = B + 20% churn. Explicit flags override the preset.
// --event (default ON for C, --no-event to disable): one event holds every room's quiz; bots join with unique emails
// (bot-<n>@load.test) and ~10% reuse an email from the previous room, so the event leaderboard has to aggregate them.
// Joins send a distinct X-Forwarded-For per bot (join is rate-limited per IP; server trusts proxy headers),
// so point --url straight at the app (127.0.0.1:3000 or an SSH tunnel), not through Caddy, which rewrites XFF.
// Exit code 0 = PASS, 1 = FAIL. JSON report: loadtest/last-report.json

import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { ServerMsg, ClientMsg, HostSnapshot, PlayerSnapshot, ModAction } from '../shared/protocol';
import type { JoinRes, QuizInput, QuestionInput, PublicEventBoard } from '../shared/api';
import type { QuizDef, SessionSummary, RoomState, EventDef, EventLeaderEntry } from '../shared/model';

// ───────────────────────────── options ─────────────────────────────

const HELP = `Cloud 9 load test
  --url <base>         server base URL (default http://localhost:3000)
  --scenario A|B|C     preset: A 1×250, B 5×50, C 5×50 + churn 0.2
  --rooms <n>          rooms (default 5)
  --players <n>        players per room (default 50)
  --questions <n>      questions per quiz (default 10)
  --time <sec>         question time limit (default 8, min 5)
  --churn <0..1>       fraction of bots that drop + reconnect per question (default 0)
  --user / --pass      moderator credentials (default admin / admin)
  --ramp <sec>         join ramp per room (default 10)
  --stagger <sec>      max random room start offset (default 3)
  --pause <ms>         moderator pause between reveal/leaderboard/next (default 400)
  --deadline <sec>     hard stop (default: computed)
  --event / --no-event put all rooms in one event, bots join with emails (default: on for C)
  --no-xff             don't send X-Forwarded-For on joins
  --quiet              less progress output`;

type Args = Record<string, string | true>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) { console.log(HELP); process.exit(0); }

const PRESETS: Record<string, { rooms: number; players: number; churn: number }> = {
  A: { rooms: 1, players: 250, churn: 0 },
  B: { rooms: 5, players: 50, churn: 0 },
  C: { rooms: 5, players: 50, churn: 0.2 },
};
const scenario = typeof args.scenario === 'string' ? args.scenario.toUpperCase() : null;
if (scenario && !PRESETS[scenario]) { console.error(`Unknown --scenario ${scenario} (use A, B or C)`); process.exit(2); }
const preset = scenario ? PRESETS[scenario] : { rooms: 5, players: 50, churn: 0 };

function num(key: string, def: number): number {
  const v = args[key];
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) { console.error(`--${key} must be a number`); process.exit(2); }
  return n;
}
function str(key: string, def: string): string { const v = args[key]; return typeof v === 'string' ? v : def; }

const opts = {
  url: str('url', 'http://localhost:3000').replace(/\/+$/, ''),
  rooms: Math.max(1, Math.floor(num('rooms', preset.rooms))),
  players: Math.max(1, Math.floor(num('players', preset.players))),
  questions: Math.max(1, Math.min(100, Math.floor(num('questions', 10)))),
  time: Math.max(5, Math.min(300, Math.floor(num('time', 8)))),
  churn: Math.max(0, Math.min(1, num('churn', preset.churn))),
  user: str('user', 'admin'),
  pass: str('pass', 'admin'),
  rampMs: Math.max(0, num('ramp', 10)) * 1000,
  staggerMs: Math.max(0, num('stagger', 3)) * 1000,
  pauseMs: Math.max(0, num('pause', 400)),
  answerMinMs: 300,
  answerMaxMs: 3000,
  xff: !args['no-xff'],
  event: args['no-event'] ? false : args.event ? true : scenario === 'C',
  quiet: !!args.quiet,
  deadlineMs: 0,
};
opts.deadlineMs = num('deadline', 90 + opts.staggerMs / 1000 + opts.rampMs / 1000 + opts.questions * (opts.time + 8)) * 1000;
const WS_BASE = opts.url.replace(/^http/, 'ws');

// Pass criteria (PLAN §18)
const CRITERIA = { ackP95Ms: 150, fanoutP95Ms: 100, rssMb: 250, eventBoardP95Ms: 100 };

// ───────────────────────────── metrics ─────────────────────────────

const M = {
  joinsOk: 0,
  joinsFailed: 0,
  joinFailReasons: {} as Record<string, number>,
  joinLatMs: [] as number[],
  wsErrors: 0,
  wsErrorSamples: [] as string[],
  unexpectedCloses: 0,
  closeCodes: {} as Record<string, number>,
  answersSent: 0,
  answersAcked: 0,
  answerErrors: 0,
  answerErrorCodes: {} as Record<string, number>,
  ackLatMs: [] as number[],
  fanoutMs: [] as number[],
  modErrors: 0,
  modErrorSamples: [] as string[],
  benignModErrors: 0,
  churnDisconnects: 0,
  churnReconnects: 0,
  churnNoSnapshot: 0,
  scoreDrift: 0,
  driftSamples: [] as string[],
  finalScoreMismatch: 0,
  peakRssMb: 0,
  baselineRssMb: 0,
  peakSockets: 0,
  peakRooms: 0,
  healthFails: 0,
  roomsFinished: 0,
  roomErrors: [] as string[],
  deadlineHit: false,
  // event mode
  eventId: '' as string,
  emailLeaks: 0,
  eventBoardMissing: 0,
  eventBoardSeen: 0,
  playerTopOver3: 0,
  rejoinedUnexpected: 0,
  eventGetLatMs: [] as number[],
  publicBoardLatMs: [] as number[],
  publicBoardFails: 0,
  eventCheck: null as null | { ok: boolean; total: number; distinctEmails: number; boardSum: number; finalSum: number; reusedEmails: number; detail: string },
};

function bump(map: Record<string, number>, key: string) { map[key] = (map[key] ?? 0) + 1; }
function sample(arr: string[], s: string) { if (arr.length < 20) arr.push(s); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const now = () => performance.now();
function log(...a: unknown[]) { if (!opts.quiet) console.log(`[${((now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a); }
const T0 = now();

let shuttingDown = false;
const allSockets = new Set<WebSocket>();

// ───────────────────────────── HTTP ─────────────────────────────

interface HttpRes { status: number; data: any; headers: Headers }
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<HttpRes> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(opts.url + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data, headers: res.headers };
}

async function login(): Promise<string> {
  const r = await http('POST', '/api/auth/login', { username: opts.user, password: opts.pass });
  if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  const cookie = r.headers.getSetCookie().map((s) => s.split(';')[0].trim()).find((s) => s.startsWith('c9_session='));
  if (!cookie) throw new Error('login succeeded but no c9_session cookie was set');
  return cookie;
}

// ───────────────────────────── bot IPs ─────────────────────────────

const runOctet = 1 + Math.floor(Math.random() * 254); // differs per run so re-runs don't hit the per-IP join limit
let ipSeq = 0;
function nextIp(): string { const g = ++ipSeq; return `10.${runOctet}.${(g >> 8) & 255}.${g & 255}`; }

// ───────────────────────────── room / moderator ─────────────────────────────

interface FanAction { id: number; sentAt: number; v0: number; targets: RoomState[] }
let actionSeq = 0;

class Room {
  code = '';
  snap: HostSnapshot | null = null;
  offset = 0; // serverNow - Date.now()
  mod: WebSocket | null = null;
  bots: Bot[] = [];
  currentAction: FanAction | null = null;
  lastErr: { code: string; message: string } | null = null;
  private waiters = new Set<{ check: () => boolean; done: (ok: boolean) => void }>();
  private modReconnects = 0;

  constructor(public idx: number, private cookie: string) {}

  tag() { return `room ${this.idx + 1}${this.code ? ` (${this.code})` : ''}`; }

  waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = {
        check,
        done: (ok: boolean) => { clearTimeout(t); this.waiters.delete(w); resolve(ok); },
      };
      const t = setTimeout(() => w.done(false), Math.max(0, timeoutMs));
      this.waiters.add(w);
    });
  }
  private notify() { for (const w of [...this.waiters]) if (w.check()) w.done(true); }

  connectMod(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/ws?role=mod&code=${this.code}`, {
        headers: { Cookie: this.cookie, Origin: opts.url },
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
      allSockets.add(ws);
      this.mod = ws;
      let settled = false;
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const t = setTimeout(() => settle(false), 10_000);
      ws.on('message', (data) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(data.toString()) as ServerMsg; } catch { M.modErrors++; return; }
        this.onModMsg(msg);
        if (msg.t === 'state') { clearTimeout(t); settle(true); }
      });
      ws.on('error', (e) => {
        if (shuttingDown) return;
        M.wsErrors++; sample(M.wsErrorSamples, `mod ${this.tag()}: ${e.message}`);
        clearTimeout(t); settle(false);
      });
      ws.on('close', (code) => {
        allSockets.delete(ws);
        if (shuttingDown) return;
        M.unexpectedCloses++; bump(M.closeCodes, `mod:${code}`);
        clearTimeout(t); settle(false);
        if (this.mod === ws && this.modReconnects < 3 && this.snap?.state !== 'FINISHED') {
          this.modReconnects++;
          log(`${this.tag()}: moderator socket closed (${code}), reconnecting`);
          setTimeout(() => { if (!shuttingDown) void this.connectMod(); }, 500);
        }
      });
    });
  }

  private onModMsg(msg: ServerMsg) {
    switch (msg.t) {
      case 'state':
        if (msg.role === 'player') break;
        if (!this.snap || msg.v >= this.snap.v) {
          this.snap = msg;
          this.offset = msg.serverNow - Date.now();
        }
        break;
      case 'lobby':
        if (this.snap && msg.v === this.snap.v) { this.snap.playerCount = msg.playerCount; this.snap.players = msg.players; }
        break;
      case 'progress':
        if (this.snap && msg.v === this.snap.v) { this.snap.answered = msg.answered; this.snap.playerCount = msg.playerCount; }
        break;
      case 'error':
        this.lastErr = { code: msg.code, message: msg.message };
        break;
      default:
        break;
    }
    this.notify();
  }

  /** Send a mod action and wait for the resulting snapshot. Records fan-out against this action. */
  async act(action: ModAction, targets: RoomState[]): Promise<boolean> {
    const s = this.snap;
    if (!s || !this.mod || this.mod.readyState !== WebSocket.OPEN) { await sleep(500); return false; }
    const a: FanAction = { id: ++actionSeq, sentAt: now(), v0: s.v, targets };
    this.currentAction = a;
    this.lastErr = null;
    const m: ClientMsg = { t: 'mod', action, expectQ: s.qIndex };
    this.mod.send(JSON.stringify(m));
    const ok = await this.waitUntil(() => this.lastErr !== null || (!!this.snap && this.snap.v > a.v0 && targets.includes(this.snap.state)), 5000);
    const e = this.lastErr as { code: string; message: string } | null; // (assigned asynchronously by onModMsg)
    if (e) {
      // close racing the server's own auto-close (timer / all answered) is expected
      if (action === 'close' && (e.code === 'bad_transition' || e.code === 'stale')) M.benignModErrors++;
      else { M.modErrors++; sample(M.modErrorSamples, `${this.tag()} ${action}: ${e.code} ${e.message}`); }
      await sleep(200);
      return false;
    }
    if (!ok) { M.modErrors++; sample(M.modErrorSamples, `${this.tag()} ${action}: timeout waiting for ${targets.join('/')}`); return false; }
    return true;
  }

  async setup() {
    const questions: QuestionInput[] = Array.from({ length: opts.questions }, (_, i) => ({
      text: `Load test question ${i + 1}: pick the right one`,
      options: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      correctIndex: Math.floor(Math.random() * 4),
      timeLimitSec: opts.time,
      pointsMax: 1000,
    }));
    const quiz: QuizInput = {
      title: `Load test ${new Date().toISOString().slice(11, 19)} r${this.idx + 1}`, emailMode: 'off', scoring: 'speed', questions,
      ...(M.eventId ? { eventId: M.eventId } : {}),
    };
    const q = await http('POST', '/api/quizzes', quiz, { Cookie: this.cookie });
    if (q.status !== 201 && q.status !== 200) throw new Error(`create quiz: HTTP ${q.status} ${JSON.stringify(q.data)}`);
    const quizId = (q.data as QuizDef).id;
    const s = await http('POST', '/api/sessions', { quizId, label: `loadtest ${this.idx + 1}`, listed: false }, { Cookie: this.cookie });
    if (s.status !== 201 && s.status !== 200) throw new Error(`create session: HTTP ${s.status} ${JSON.stringify(s.data)}`);
    this.code = (s.data as SessionSummary).code;
    if (!(await this.connectMod())) throw new Error('moderator WebSocket did not receive a snapshot');
    log(`${this.tag()}: session ready`);
  }

  async run() {
    await sleep(rand(0, opts.staggerMs));
    await this.setup();

    // players join, spread over the ramp
    const n = opts.players;
    for (let i = 0; i < n; i++) this.bots.push(new Bot(this, i));
    await Promise.all(this.bots.map((b, i) => sleep((i / n) * opts.rampMs).then(() => b.start())));
    const live = this.bots.filter((b) => b.connected).length;
    log(`${this.tag()}: ${live}/${n} players connected`);
    await this.waitUntil(() => (this.snap?.playerCount ?? 0) >= live, 3000);
    await sleep(500);

    // drive the game from the latest snapshot (robust to auto-close and retries)
    const maxSteps = opts.questions * 10 + 20;
    for (let step = 0; step < maxSteps && !shuttingDown; step++) {
      const s = this.snap!;
      if (s.state === 'FINISHED') break;
      switch (s.state) {
        case 'LOBBY':
          if (!(await this.act('start', ['QUESTION']))) await sleep(500);
          break;
        case 'QUESTION': {
          const qi = s.qIndex;
          const localEnd = (s.question?.endsAt ?? Date.now() + opts.time * 1000) - this.offset;
          await this.waitUntil(() => this.snap!.state !== 'QUESTION' || this.snap!.qIndex !== qi, localEnd - Date.now() + 1500);
          if (this.snap!.state === 'QUESTION' && this.snap!.qIndex === qi) await this.act('close', ['CLOSED']);
          break;
        }
        case 'CLOSED':
          await sleep(opts.pauseMs);
          if (!(await this.act('reveal', ['REVEAL']))) await sleep(500);
          break;
        case 'REVEAL':
          await sleep(opts.pauseMs);
          if (!(await this.act('leaderboard', ['LEADERBOARD']))) await sleep(500);
          break;
        case 'LEADERBOARD': {
          await sleep(opts.pauseMs);
          const last = s.qIndex >= s.total - 1;
          if (!(await this.act('next', last ? ['FINISHED'] : ['QUESTION']))) await sleep(500);
          if (!last && this.snap!.state === 'QUESTION') log(`${this.tag()}: question ${this.snap!.qIndex + 1}/${this.snap!.total}`);
          break;
        }
      }
    }
    if (this.snap?.state !== 'FINISHED') throw new Error(`game did not finish (state ${this.snap?.state})`);
    M.roomsFinished++;

    // final consistency: every connected bot's own score must match the moderator's view
    await sleep(1000);
    const modScores = new Map(this.snap.players.map((p) => [p.id, p.score]));
    for (const b of this.bots) {
      if (!b.snap || !b.playerId || !b.connected) continue;
      const ms = modScores.get(b.playerId);
      if (ms === undefined || ms !== b.snap.me.score) {
        M.finalScoreMismatch++;
        sample(M.driftSamples, `${this.tag()} ${b.name}: final bot=${b.snap.me.score} mod=${ms}`);
      }
    }
    log(`${this.tag()}: finished`);
  }
}

// ───────────────────────────── player bot ─────────────────────────────

class Bot {
  name: string;
  ip: string;
  token = '';
  playerId = '';
  ws: WebSocket | null = null;
  connected = false;
  connectedAt = Infinity;
  lastV = -1;
  snap: PlayerSnapshot | null = null;
  lastFanId = 0;
  answerTimer: NodeJS.Timeout | null = null;
  answerQ = -1;
  answeredQ = new Set<number>();
  decidedQ = new Set<number>();
  pendingAck = new Map<number, number>();
  awaitingFresh = false;
  freshTimer: NodeJS.Timeout | null = null;
  scoreBefore: number | null = null;
  away = false;
  reconnects = 0;
  private intentional = new WeakSet<WebSocket>();

  email: string | null = null;

  constructor(private room: Room, i: number) {
    this.name = `bot${room.idx + 1}-${i + 1}`;
    this.ip = nextIp();
    if (opts.event) {
      // unique per bot; the first `reusePerRoom` bots of every room after the first reuse the email of one of the LAST
      // bots of the previous room (those are never reusers themselves, so every reuse really spans two rooms)
      const reuse = room.idx > 0 && i < reusePerRoom;
      const g = reuse ? (room.idx - 1) * opts.players + (opts.players - 1 - i) : room.idx * opts.players + i;
      this.email = `bot-${g}@load.test`;
    }
  }

  async start() {
    if (shuttingDown) return;
    const t = now();
    try {
      const body = this.email ? { name: this.name, email: this.email } : { name: this.name };
      const r = await http('POST', `/api/play/${this.room.code}/join`, body, opts.xff ? { 'X-Forwarded-For': this.ip } : {});
      if (r.status !== 200) {
        M.joinsFailed++; bump(M.joinFailReasons, `${r.status} ${r.data?.error ?? ''}`.trim());
        return;
      }
      const jr = r.data as JoinRes;
      this.token = jr.token; this.playerId = jr.playerId;
      if (jr.rejoined) M.rejoinedUnexpected++; // every bot's email is unique within its room
      M.joinsOk++; M.joinLatMs.push(now() - t);
    } catch (e) {
      M.joinsFailed++; bump(M.joinFailReasons, `network ${(e as Error).name}`);
      return;
    }
    await this.open();
  }

  /** Opens the socket; resolves on the first snapshot (or false on failure/timeout). */
  open(): Promise<boolean> {
    if (shuttingDown) return Promise.resolve(false);
    return new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/ws?role=player&code=${this.room.code}&token=${encodeURIComponent(this.token)}`, {
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
      });
      allSockets.add(ws);
      this.ws = ws;
      let settled = false;
      const settle = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(t); resolve(ok); } };
      const t = setTimeout(() => settle(false), 10_000);
      ws.on('open', () => { this.connected = true; this.connectedAt = now(); });
      ws.on('message', (data) => {
        let msg: ServerMsg;
        const raw = data.toString();
        if (opts.event && raw.includes('@')) M.emailLeaks++; // players must never receive emails
        try { msg = JSON.parse(raw) as ServerMsg; } catch { M.wsErrors++; return; }
        this.onMsg(msg);
        if (msg.t === 'state') settle(true);
      });
      ws.on('error', (e) => {
        if (shuttingDown || this.intentional.has(ws)) return;
        M.wsErrors++; sample(M.wsErrorSamples, `${this.name}: ${e.message}`);
        settle(false);
      });
      ws.on('close', (code) => {
        allSockets.delete(ws);
        if (this.ws === ws) { this.connected = false; this.connectedAt = Infinity; }
        settle(false);
        if (shuttingDown || this.intentional.has(ws)) return;
        M.unexpectedCloses++; bump(M.closeCodes, String(code));
        // behave like the real client: reconnect (bounded) unless kicked/unauthorized
        if (this.ws === ws && code !== 4403 && code !== 4401 && code !== 4404 && this.reconnects < 3) {
          this.reconnects++;
          setTimeout(() => void this.open(), 1000);
        }
      });
    });
  }

  private onMsg(msg: ServerMsg) {
    switch (msg.t) {
      case 'state': {
        if (msg.role !== 'player') return;
        if (msg.v < this.lastV) return;
        this.lastV = msg.v;
        this.snap = msg;
        if (this.awaitingFresh) {
          this.awaitingFresh = false;
          if (this.freshTimer) clearTimeout(this.freshTimer);
          M.churnReconnects++;
          if (this.scoreBefore !== null && msg.me.score !== this.scoreBefore) {
            M.scoreDrift++;
            sample(M.driftSamples, `${this.room.tag()} ${this.name}: before=${this.scoreBefore} after=${msg.me.score}`);
          }
          this.scoreBefore = null;
        } else {
          const a = this.room.currentAction;
          if (a && a.id > this.lastFanId && msg.v > a.v0 && a.targets.includes(msg.state) && this.connectedAt <= a.sentAt) {
            this.lastFanId = a.id;
            M.fanoutMs.push(now() - a.sentAt);
          }
        }
        if (msg.state === 'QUESTION' && msg.question) this.onQuestion(msg);
        if (msg.state === 'LEADERBOARD' || msg.state === 'FINISHED') {
          if ((msg.leaderboard?.length ?? 0) > 3) M.playerTopOver3++;
          if (opts.event) {
            if (!msg.eventBoard || !msg.eventBoard.me) M.eventBoardMissing++;
            else { M.eventBoardSeen++; if (msg.eventBoard.top.length > 3) M.playerTopOver3++; }
          }
        }
        break;
      }
      case 'ack': {
        const t0 = this.pendingAck.get(msg.qIndex);
        if (t0 !== undefined) { this.pendingAck.delete(msg.qIndex); M.answersAcked++; M.ackLatMs.push(now() - t0); }
        break;
      }
      case 'error':
        M.answerErrors++; bump(M.answerErrorCodes, msg.code);
        this.pendingAck.clear();
        break;
      case 'kicked':
        bump(M.closeCodes, 'kicked');
        break;
      default:
        break;
    }
  }

  private onQuestion(s: PlayerSnapshot) {
    const q = s.question!;
    const qi = q.qIndex;
    if (s.myAnswer || this.answeredQ.has(qi) || this.away) return;
    if (this.answerTimer && this.answerQ === qi) return;
    const msLeft = q.endsAt - (Date.now() + (s.serverNow - Date.now()));

    // churn: decided once per question, only for bots that haven't answered yet (so their score can't legitimately change while away)
    if (!this.decidedQ.has(qi)) {
      this.decidedQ.add(qi);
      if (opts.churn > 0 && Math.random() < opts.churn && msLeft > 3500) {
        setTimeout(() => this.churn(), rand(150, 700));
        return;
      }
    }

    const maxDelay = Math.min(opts.answerMaxMs, msLeft - 600);
    if (maxDelay < 50) return;
    const delay = rand(Math.min(opts.answerMinMs, maxDelay), maxDelay);
    this.answerQ = qi;
    this.answerTimer = setTimeout(() => this.answer(qi), delay);
  }

  private answer(qi: number) {
    this.answerTimer = null;
    const s = this.snap;
    if (shuttingDown || !this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!s || s.state !== 'QUESTION' || !s.question || s.question.qIndex !== qi || s.myAnswer || this.answeredQ.has(qi)) return;
    const m: ClientMsg = { t: 'answer', qIndex: qi, choice: Math.floor(Math.random() * s.question.options.length) };
    this.answeredQ.add(qi);
    this.pendingAck.set(qi, now());
    M.answersSent++;
    this.ws.send(JSON.stringify(m));
  }

  private churn() {
    if (shuttingDown || !this.connected || !this.ws || !this.snap) return;
    if (this.answerTimer) { clearTimeout(this.answerTimer); this.answerTimer = null; }
    this.scoreBefore = this.snap.me.score;
    this.away = true;
    M.churnDisconnects++;
    const ws = this.ws;
    this.intentional.add(ws);
    ws.close(1000, 'churn');
    setTimeout(() => {
      if (shuttingDown) return;
      this.away = false;
      this.awaitingFresh = true;
      this.freshTimer = setTimeout(() => {
        if (this.awaitingFresh) { this.awaitingFresh = false; M.churnNoSnapshot++; }
      }, 5000);
      void this.open();
    }, rand(1000, 3000));
  }
}

// ───────────────────────────── event mode ─────────────────────────────

const reusePerRoom = opts.rooms > 1 ? Math.min(Math.floor(opts.players / 2), Math.round((opts.players * 0.1 * opts.rooms) / (opts.rooms - 1))) : 0;

async function createEvent(cookie: string): Promise<string> {
  const r = await http('POST', '/api/events', { name: `Load test event ${new Date().toISOString().slice(11, 19)}`, emailRequired: true }, { Cookie: cookie });
  if (r.status !== 201) throw new Error(`create event: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return (r.data as EventDef).id;
}

/** Projector-style poller for the public event board while the games run. */
function startPublicBoardPoller(): () => void {
  let stop = false;
  void (async () => {
    while (!stop && !shuttingDown) {
      const t = now();
      try {
        const r = await http('GET', `/api/public/events/${M.eventId}/leaderboard`, undefined, {}, 5000);
        if (r.status !== 200 || JSON.stringify(r.data).includes('@')) M.publicBoardFails++;
        else M.publicBoardLatMs.push(now() - t);
      } catch { M.publicBoardFails++; }
      await sleep(1000);
    }
  })();
  return () => { stop = true; };
}

async function checkEventBoard(cookie: string, rooms: Room[]) {
  // latency of the moderator leaderboard (full list, one SQL aggregate)
  let board: EventLeaderEntry[] = [];
  for (let i = 0; i < 20; i++) {
    const t = now();
    const r = await http('GET', `/api/events/${M.eventId}/leaderboard`, undefined, { Cookie: cookie });
    if (r.status !== 200) throw new Error(`event leaderboard: HTTP ${r.status}`);
    M.eventGetLatMs.push(now() - t);
    board = r.data as EventLeaderEntry[];
  }
  const joined = rooms.flatMap((r) => r.bots.filter((b) => b.playerId && b.email));
  const distinct = new Set(joined.map((b) => b.email!));
  const finalSum = rooms.reduce((acc, r) => acc + (r.snap?.players.reduce((a, p) => a + p.score, 0) ?? 0), 0);
  const boardSum = board.reduce((a, e) => a + e.score, 0);
  const pub = await http('GET', `/api/public/events/${M.eventId}/leaderboard`);
  const pubOk = pub.status === 200 && !JSON.stringify(pub.data).includes('@') && (pub.data as PublicEventBoard).top.length <= 10;
  const multi = board.filter((e) => e.quizzesPlayed > 1).length;
  M.eventCheck = {
    ok: board.length === distinct.size && boardSum === finalSum && pubOk,
    total: board.length,
    distinctEmails: distinct.size,
    boardSum,
    finalSum,
    reusedEmails: joined.length - distinct.size,
    detail: `${multi} entries played >1 quiz; public board ${pubOk ? 'ok' : 'BAD'}`,
  };
}

// ───────────────────────────── health sampling ─────────────────────────────

async function sampleHealth(): Promise<{ rssMb: number; sockets: number; rooms: number } | null> {
  try {
    const r = await http('GET', '/healthz', undefined, {}, 3000);
    if (r.status !== 200 || !r.data) { M.healthFails++; return null; }
    const d = r.data as { rssMb: number; sockets: number; rooms: number };
    M.peakRssMb = Math.max(M.peakRssMb, d.rssMb ?? 0);
    M.peakSockets = Math.max(M.peakSockets, d.sockets ?? 0);
    M.peakRooms = Math.max(M.peakRooms, d.rooms ?? 0);
    return d;
  } catch {
    M.healthFails++;
    return null;
  }
}

// ───────────────────────────── report ─────────────────────────────

function pct(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const fmt = (n: number | null) => (n === null ? 'n/a' : `${n.toFixed(1)} ms`);

let finished = false;
function finish(reason: string): never | void {
  if (finished) return;
  finished = true;
  shuttingDown = true;
  for (const ws of allSockets) { try { ws.terminate(); } catch { /* ignore */ } }

  const expectedJoins = opts.rooms * opts.players;
  const unacked = Math.max(0, M.answersSent - M.answersAcked - M.answerErrors);
  const ack = { p50: pct(M.ackLatMs, 50), p95: pct(M.ackLatMs, 95), p99: pct(M.ackLatMs, 99), max: pct(M.ackLatMs, 100) };
  const fan = { p50: pct(M.fanoutMs, 50), p95: pct(M.fanoutMs, 95), max: pct(M.fanoutMs, 100) };

  const evLat = { p50: pct(M.eventGetLatMs, 50), p95: pct(M.eventGetLatMs, 95) };
  const pubLat = { p50: pct(M.publicBoardLatMs, 50), p95: pct(M.publicBoardLatMs, 95) };
  const checks: { name: string; value: string; target: string; ok: boolean }[] = [
    { name: 'joins ok', value: `${M.joinsOk}/${expectedJoins}`, target: 'all', ok: M.joinsOk === expectedJoins && M.joinsFailed === 0 },
    { name: 'ws errors', value: String(M.wsErrors), target: '0', ok: M.wsErrors === 0 },
    { name: 'unexpected closes', value: String(M.unexpectedCloses), target: '0', ok: M.unexpectedCloses === 0 },
    { name: 'answers sent / acked', value: `${M.answersSent} / ${M.answersAcked}`, target: 'all acked', ok: M.answersSent > 0 && unacked === 0 },
    { name: 'answer errors', value: String(M.answerErrors), target: '0', ok: M.answerErrors === 0 },
    { name: 'mod errors', value: `${M.modErrors} (+${M.benignModErrors} benign)`, target: '0', ok: M.modErrors === 0 },
    { name: 'ack latency p95', value: fmt(ack.p95), target: `< ${CRITERIA.ackP95Ms} ms`, ok: ack.p95 !== null && ack.p95 < CRITERIA.ackP95Ms },
    { name: 'fan-out p95', value: fmt(fan.p95), target: `< ${CRITERIA.fanoutP95Ms} ms`, ok: fan.p95 !== null && fan.p95 < CRITERIA.fanoutP95Ms },
    { name: 'peak RSS', value: `${M.peakRssMb} MB`, target: `< ${CRITERIA.rssMb} MB`, ok: M.peakRssMb > 0 && M.peakRssMb < CRITERIA.rssMb },
    { name: 'healthz failures', value: String(M.healthFails), target: '0', ok: M.healthFails === 0 },
    { name: 'score drift (reconnect)', value: String(M.scoreDrift), target: '0', ok: M.scoreDrift === 0 },
    { name: 'churn w/o fresh snapshot', value: String(M.churnNoSnapshot), target: '0', ok: M.churnNoSnapshot === 0 },
    { name: 'final score mismatch', value: String(M.finalScoreMismatch), target: '0', ok: M.finalScoreMismatch === 0 },
    { name: 'rooms finished', value: `${M.roomsFinished}/${opts.rooms}`, target: 'all', ok: M.roomsFinished === opts.rooms },
    { name: 'deadline', value: M.deadlineHit ? 'HIT' : 'ok', target: 'not hit', ok: !M.deadlineHit },
    { name: 'player top-3 only', value: String(M.playerTopOver3), target: '0', ok: M.playerTopOver3 === 0 },
  ];
  if (opts.event) {
    const ec = M.eventCheck;
    checks.push(
      { name: 'event board entries', value: ec ? `${ec.total} / ${ec.distinctEmails} emails` : 'n/a', target: '= distinct emails', ok: !!ec && ec.total === ec.distinctEmails },
      { name: 'event board score sum', value: ec ? `${ec.boardSum} / ${ec.finalSum}` : 'n/a', target: '= Σ final scores', ok: !!ec && ec.boardSum === ec.finalSum },
      { name: 'event board (moderator) p95', value: fmt(evLat.p95), target: `< ${CRITERIA.eventBoardP95Ms} ms`, ok: evLat.p95 !== null && evLat.p95 < CRITERIA.eventBoardP95Ms },
      { name: 'public event board', value: `${M.publicBoardLatMs.length} ok, ${M.publicBoardFails} bad`, target: '0 bad', ok: M.publicBoardFails === 0 && !!ec?.ok },
      { name: 'player eventBoard present', value: `${M.eventBoardSeen} seen, ${M.eventBoardMissing} missing`, target: '0 missing', ok: M.eventBoardMissing === 0 && M.eventBoardSeen > 0 },
      { name: 'emails in player msgs', value: String(M.emailLeaks), target: '0', ok: M.emailLeaks === 0 },
      { name: 'unexpected rejoins', value: String(M.rejoinedUnexpected), target: '0', ok: M.rejoinedUnexpected === 0 },
    );
  }
  const pass = checks.every((c) => c.ok);

  const info: [string, string][] = [
    ['scenario', `${scenario ?? 'custom'}: ${opts.rooms} room(s) × ${opts.players} players, ${opts.questions} q × ${opts.time}s, churn ${opts.churn}`],
    ['target', opts.url],
    ['duration', `${((now() - T0) / 1000).toFixed(1)} s (${reason})`],
    ['join latency p50/p95', `${fmt(pct(M.joinLatMs, 50))} / ${fmt(pct(M.joinLatMs, 95))}`],
    ['ack latency p50/p95/p99/max', `${fmt(ack.p50)} / ${fmt(ack.p95)} / ${fmt(ack.p99)} / ${fmt(ack.max)}  (n=${M.ackLatMs.length})`],
    ['fan-out p50/p95/max', `${fmt(fan.p50)} / ${fmt(fan.p95)} / ${fmt(fan.max)}  (n=${M.fanoutMs.length})`],
    ['RSS baseline → peak', `${M.baselineRssMb} → ${M.peakRssMb} MB`],
    ['peak sockets / rooms', `${M.peakSockets} / ${M.peakRooms}`],
    ['churn disconnects / reconnects', `${M.churnDisconnects} / ${M.churnReconnects}`],
  ];
  if (opts.event) {
    info.push(
      ['event', `${M.eventId} (${M.eventCheck ? `${M.eventCheck.reusedEmails} reused emails; ${M.eventCheck.detail}` : 'not checked'})`],
      ['event board GET p50/p95', `${fmt(evLat.p50)} / ${fmt(evLat.p95)}  (n=${M.eventGetLatMs.length})`],
      ['public board GET p50/p95', `${fmt(pubLat.p50)} / ${fmt(pubLat.p95)}  (n=${M.publicBoardLatMs.length})`],
    );
  }

  const w = Math.max(...checks.map((c) => c.name.length), ...info.map((i) => i[0].length)) + 2;
  console.log('\n════════════════════ Cloud 9 load test ════════════════════');
  for (const [k, v] of info) console.log(`  ${k.padEnd(w)}${v}`);
  console.log('───────────────────────────────────────────────────────────');
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(w)}${c.value.padEnd(24)}(${c.target})`);
  if (Object.keys(M.joinFailReasons).length) console.log('  join failures:', M.joinFailReasons);
  if (Object.keys(M.closeCodes).length) console.log('  close codes:', M.closeCodes);
  if (Object.keys(M.answerErrorCodes).length) console.log('  answer error codes:', M.answerErrorCodes);
  for (const s of [...M.wsErrorSamples, ...M.modErrorSamples, ...M.driftSamples, ...M.roomErrors]) console.log('  · ' + s);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`  RESULT: ${pass ? 'PASS' : 'FAIL'}   (CPU is not measured here — watch \`docker stats\` during the run: target < 70% of one core)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const report = {
    at: new Date().toISOString(),
    pass,
    reason,
    options: { ...opts, scenario },
    criteria: CRITERIA,
    checks,
    latency: { ackMs: ack, fanoutMs: fan, joinMs: { p50: pct(M.joinLatMs, 50), p95: pct(M.joinLatMs, 95) }, eventBoardMs: evLat, publicEventBoardMs: pubLat },
    metrics: { ...M, joinLatMs: undefined, ackLatMs: undefined, fanoutMs: undefined, eventGetLatMs: undefined, publicBoardLatMs: undefined, unacked },
  };
  try {
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'last-report.json'), JSON.stringify(report, null, 2));
  } catch (e) {
    console.error('could not write last-report.json:', (e as Error).message);
  }
  setTimeout(() => process.exit(pass ? 0 : 1), 100);
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  console.log(`Cloud 9 load test → ${opts.url}: ${opts.rooms} room(s) × ${opts.players} players, ${opts.questions} questions × ${opts.time}s, churn ${opts.churn}, event ${opts.event ? 'on' : 'off'}, deadline ${Math.round(opts.deadlineMs / 1000)}s`);
  const deadline = setTimeout(() => { M.deadlineHit = true; console.error('!! global deadline reached'); finish('deadline'); }, opts.deadlineMs);
  deadline.unref();

  const base = await sampleHealth();
  if (!base) throw new Error(`GET ${opts.url}/healthz failed — is the server running?`);
  M.baselineRssMb = base.rssMb;
  const sampler = setInterval(() => {
    void sampleHealth().then((h) => { if (h) log(`healthz rss=${h.rssMb}MB sockets=${h.sockets} rooms=${h.rooms}`); });
  }, 2000);

  const cookie = await login();
  let stopPoller = () => {};
  if (opts.event) {
    M.eventId = await createEvent(cookie);
    log(`event ${M.eventId} created; ${reusePerRoom} bots per room (after the first) reuse an email`);
    stopPoller = startPublicBoardPoller();
  }
  const rooms = Array.from({ length: opts.rooms }, (_, i) => new Room(i, cookie));
  await Promise.all(rooms.map((r) => r.run().catch((e: Error) => { M.roomErrors.push(`${r.tag()}: ${e.message}`); log(`${r.tag()} ERROR: ${e.message}`); })));
  stopPoller();
  if (opts.event) {
    try { await checkEventBoard(cookie, rooms); } catch (e) { M.roomErrors.push(`event check: ${(e as Error).message}`); }
  }
  await sampleHealth();
  clearInterval(sampler);
  finish('completed');
}

process.on('SIGINT', () => { M.roomErrors.push('interrupted (SIGINT)'); finish('interrupted'); });
process.on('unhandledRejection', (e) => { M.roomErrors.push(`unhandledRejection: ${String(e)}`); });
main().catch((e: Error) => { M.roomErrors.push(`fatal: ${e.message}`); finish('fatal error'); });
