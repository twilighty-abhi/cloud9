// Cloud 9 — Telegram end-to-end test. Owned by QA.
//
// Spawns the REAL server (`tsx server/src/index.ts`) against the fake Bot API (fakeTelegram.ts), plays a real game over
// HTTP + WebSocket, and checks what reached "Telegram": routing (chats + forum topics), privacy (no emails in groups,
// CSV only to admin private chats), commands, inline buttons, OFF-by-default, and outbox delivery after an outage.
//
// Telegram assertions are collected as named checks and reported as separate subtests, so a run shows exactly which
// behaviours are working and which are still pending. Quiz-flow assertions are hard failures: Telegram must never
// break the game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { startFakeTelegram, chatOf, threadOf, textOf, visibleOf, type FakeTelegram, type TgCall } from './fakeTelegram';

const ROOT = resolve(import.meta.dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const GROUP = '-1001';
const ADMIN = '555';
const HALL1_TOPIC = 11;
const SYSTEM_TOPIC = 99;
// TG_E2E_ENTRY: run a different server entry (e.g. a locally wired copy of index.ts) — default is the real one.
const ENTRY = process.env.TG_E2E_ENTRY ?? 'server/src/index.ts';
const WAIT = Number(process.env.TG_E2E_WAIT_MS ?? 12_000);   // per Telegram expectation

// ───────────────────────────── harness ─────────────────────────────
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
  });
}

interface ServerProc { url: string; proc: ChildProcess; logs: string[]; dir: string; stop(): Promise<void> }

async function startServer(extraEnv: Record<string, string | undefined>): Promise<ServerProc> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'cloud9-tg-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TELEGRAM_')) env[k] = v;
  Object.assign(env, {
    PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}`,
    DB_PATH: join(dir, 'cloud9.db'), WEB_DIST: join(dir, 'no-web'),
    MODERATORS: 'admin:pw:super,hall1:a', SESSION_SECRET: 's'.repeat(40),
    LOG_LEVEL: 'warn', LOGIN_RATE_PER_MIN: '100', JOIN_RATE_PER_MIN: '1000',
  });
  for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) env[k] = v; else delete env[k];
  const proc = spawn(TSX, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  const onData = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) logs.push(l); };
  proc.stdout!.on('data', onData);
  proc.stderr!.on('data', onData);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode}:\n${logs.join('\n')}`);
    try { if ((await fetch(`${url}/healthz`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) { proc.kill('SIGKILL'); throw new Error(`server did not become healthy:\n${logs.join('\n')}`); }
    await sleep(150);
  }
  return {
    url, proc, logs, dir,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        const exited = await Promise.race([new Promise((r) => proc.once('exit', () => r(true))), sleep(4000).then(() => false)]);
        if (!exited) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function api(base: string) {
  return async function call(method: string, path: string, body?: unknown, cookie?: string): Promise<any> {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* csv etc */ }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return { json, headers: r.headers };
  };
}

async function login(base: string, username: string, password: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, `login ${username}: ${await r.text()}`);
  const c = r.headers.getSetCookie().map((s) => s.split(';')[0].trim()).find((s) => s.startsWith('c9_session='));
  assert.ok(c, 'c9_session cookie');
  return c!;
}

class Sock {
  msgs: any[] = [];
  private waiters = new Set<() => void>();
  closed = false;
  private constructor(public ws: WebSocket) {
    ws.on('message', (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } for (const w of [...this.waiters]) w(); });
    ws.on('close', () => { this.closed = true; });
    ws.on('error', () => { /* close follows */ });
  }
  static open(url: string, headers: Record<string, string> = {}): Promise<Sock> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url, { headers });
      const s = new Sock(ws);
      ws.once('open', () => res(s));
      ws.once('error', rej);
    });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  wait(pred: (m: any) => boolean, ms = 8000, what = 'message'): Promise<any> {
    return new Promise((res, rej) => {
      const check = () => {
        const hit = this.msgs.find(pred);
        if (hit) { this.waiters.delete(check); clearTimeout(t); res(hit); return true; }
        return false;
      };
      const t = setTimeout(() => { this.waiters.delete(check); rej(new Error(`ws: timed out waiting for ${what}; got ${this.msgs.map((m) => m.t + (m.state ? ':' + m.state : '')).join(',')}`)); }, ms);
      if (!check()) this.waiters.add(check);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

interface Game {
  code: string; eventId: string; eventName: string; title: string;
  mod: Sock; players: { name: string; email: string; sock: Sock }[];
  play(qIndex: number, choices: number[]): Promise<void>;   // start/next → answer → (auto close) → reveal
  finish(lastQ: number): Promise<void>;
  closeAll(): void;
}

const PLAYERS = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'carol@example.com' },
];

/** Event (admin) → quiz + session (hall1) → 3 players join with emails → sockets open. Does not start. */
async function setupGame(srv: ServerProc, tag: string, onStep?: (step: string, g: Partial<Game>) => Promise<void>): Promise<Game> {
  const call = api(srv.url);
  const adminCookie = await login(srv.url, 'admin', 'pw');
  const hallCookie = await login(srv.url, 'hall1', 'a');
  const eventName = `QA Conf ${tag}`;
  const ev = (await call('POST', '/api/events', { name: eventName, emailRequired: true }, adminCookie)).json;
  const title = `QA Quiz ${tag}`;
  const quiz = (await call('POST', '/api/quizzes', {
    eventId: ev.id, title, emailMode: 'required', scoring: 'flat',
    questions: [
      { text: 'What is 2+2?', options: ['3', '4', '5'], correctIndex: 1, timeLimitSec: 60 },
      { text: 'Sky colour?', options: ['Blue', 'Green'], correctIndex: 0, timeLimitSec: 60 },
    ],
  }, hallCookie)).json;
  const ses = (await call('POST', '/api/sessions', { quizId: quiz.id, label: 'Hall 1' }, hallCookie)).json;
  const code: string = ses.code;
  assert.match(code, /^\d{6}$/);
  await onStep?.('session.created', { code, eventId: ev.id, eventName, title });

  const wsBase = srv.url.replace(/^http/, 'ws');
  const mod = await Sock.open(`${wsBase}/ws?role=mod&code=${code}`, { cookie: hallCookie, origin: srv.url });
  await mod.wait((m) => m.t === 'state' && m.state === 'LOBBY', 8000, 'mod lobby');
  const players: Game['players'] = [];
  for (const p of PLAYERS) {
    const j = (await call('POST', `/api/play/${code}/join`, { name: p.name, email: p.email })).json;
    const sock = await Sock.open(`${wsBase}/ws?role=player&code=${code}&token=${encodeURIComponent(j.token)}`, { origin: srv.url });
    await sock.wait((m) => m.t === 'state', 8000, `${p.name} snapshot`);
    players.push({ ...p, sock });
  }

  const g: Game = {
    code, eventId: ev.id, eventName, title, mod, players,
    async play(qIndex, choices) {
      mod.send({ t: 'mod', action: qIndex === 0 ? 'start' : 'next', expectQ: qIndex - 1 });
      for (const p of players) await p.sock.wait((m) => m.t === 'state' && m.state === 'QUESTION' && m.question?.qIndex === qIndex, 8000, `${p.name} Q${qIndex}`);
      players.forEach((p, i) => p.sock.send({ t: 'answer', qIndex, choice: choices[i] }));
      for (const p of players) {
        const ack = await p.sock.wait((m) => (m.t === 'ack' && m.qIndex === qIndex) || m.t === 'error', 8000, `${p.name} ack Q${qIndex}`);
        assert.equal(ack.t, 'ack', `${p.name} answer acked (got ${JSON.stringify(ack)})`);
      }
      // everyone answered → auto-close
      await mod.wait((m) => m.t === 'state' && m.state === 'CLOSED' && m.qIndex === qIndex, 8000, `mod CLOSED Q${qIndex}`);
      mod.send({ t: 'mod', action: 'reveal', expectQ: qIndex });
      await mod.wait((m) => m.t === 'state' && m.state === 'REVEAL' && m.qIndex === qIndex, 8000, `mod REVEAL Q${qIndex}`);
    },
    async finish(lastQ) {
      mod.send({ t: 'mod', action: 'next', expectQ: lastQ });
      await mod.wait((m) => m.t === 'state' && m.state === 'FINISHED', 8000, 'mod FINISHED');
      for (const p of players) await p.sock.wait((m) => m.t === 'state' && m.state === 'FINISHED', 8000, `${p.name} FINISHED`);
    },
    closeAll() { mod.close(); for (const p of players) p.sock.close(); },
  };
  return g;
}

// ───────────────────────────── soft checks ─────────────────────────────
type Check = { name: string; ok: boolean; detail: string };
function checker() {
  const checks: Check[] = [];
  return {
    checks,
    check(name: string, ok: boolean, detail = '') { checks.push({ name, ok, detail }); return ok; },
    async report(t: import('node:test').TestContext, extra: () => string) {
      for (const c of checks) {
        await t.test(c.name, () => { assert.ok(c.ok, `${c.detail}\n${extra()}`); });
      }
    },
  };
}

const mentionsCode = (s: string, code: string) => s.includes(code) || s.includes(`${code.slice(0, 3)} ${code.slice(3)}`);
const isSend = (c: TgCall) => c.method === 'sendMessage' || c.method === 'sendDocument' || c.method === 'editMessageText';
const dump = (tg: FakeTelegram, srv?: ServerProc) => () =>
  `--- telegram calls (${tg.calls.length}) ---\n` +
  tg.calls.map((c) => `#${c.seq} ${c.status} ${c.method} chat=${chatOf(c)} thread=${threadOf(c)} ${JSON.stringify(textOf(c).slice(0, 160))}${c.document ? ` doc=${c.document.filename}` : ''}`).join('\n') +
  (srv ? `\n--- server log (tail) ---\n${srv.logs.slice(-40).join('\n')}` : '');

const tgEnv = (tg: FakeTelegram) => ({
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_API_BASE: tg.url,
  TELEGRAM_NOTIFY_CHAT_IDS: `${GROUP},${ADMIN}`,
  TELEGRAM_ADMIN_IDS: ADMIN,
  TELEGRAM_TOPICS: `hall1=${HALL1_TOPIC},system=${SYSTEM_TOPIC}`,
  TELEGRAM_DIGEST_MINUTES: '0',
});

if (!existsSync(TSX)) throw new Error(`tsx not found at ${TSX} — run npm install`);

// ───────────────────────────── 1. full flow ─────────────────────────────
test('telegram e2e: notifications, routing, privacy, commands, buttons', { timeout: 600_000 }, async (t) => {
  const tg = await startFakeTelegram({ token: '123:abc' });
  const srv = await startServer(tgEnv(tg)).catch(async (e) => { await tg.close(); throw e; });
  const { check, report } = checker();
  let game: Game | null = null;
  try {
    // ── boot ──
    const anyCall = await tg.tryWaitFor(() => true, WAIT);
    const wired = check('bot talks to the API at boot (index.ts wired)', !!anyCall, 'no call reached the fake Telegram after boot');
    const W = wired ? WAIT : 1500;   // if nothing is wired, don't wait the full time for every expectation

    const sys = await tg.tryWaitFor((c) => c.method === 'sendMessage' && chatOf(c) === GROUP, W);
    check('system.started → group, system topic 99', !!sys && threadOf(sys) === SYSTEM_TOPIC, sys ? `thread=${threadOf(sys)} text=${textOf(sys)}` : 'no message to the group after boot');
    const hooks = await tg.tryWaitFor((c) => c.method === 'deleteWebhook', W);
    check('poller calls deleteWebhook', !!hooks);
    const cmds = await tg.tryWaitFor((c) => c.method === 'setMyCommands', W);
    check('setMyCommands registered', !!cmds && Array.isArray(cmds.params.commands) && cmds.params.commands.length > 0, cmds ? JSON.stringify(cmds.params.commands) : 'not called');
    const poll = await tg.tryWaitFor((c) => c.method === 'getUpdates', W);
    check('poller long-polls getUpdates', !!poll && Number(poll.params.timeout) > 0, poll ? JSON.stringify(poll.params) : 'not called');

    // ── game ──
    let createdSeq = 0;
    game = await setupGame(srv, 'A', async (_step, g) => {
      const has = (chat: string) => (c: TgCall) => c.method === 'sendMessage' && chatOf(c) === chat && mentionsCode(textOf(c), g.code!);
      const [cg, ca] = await Promise.all([tg.tryWaitFor(has(GROUP), W), tg.tryWaitFor(has(ADMIN), W)]);
      check('session.created → group in hall1 topic 11', !!cg && threadOf(cg) === HALL1_TOPIC, cg ? `thread=${threadOf(cg)}` : 'no group message with the session code');
      check('session.created → admin chat 555', !!ca, 'no admin message with the session code');
      createdSeq = Math.max(cg?.seq ?? 0, ca?.seq ?? 0, tg.mark());
    });
    const g = game;
    const about = (c: TgCall) => mentionsCode(visibleOf(c), g.code) || textOf(c).includes(g.title);

    // start (Q0): Alice ✓, Bob ✓, Carol ✗ ; Q1: Alice ✓, Bob ✗, Carol ✗   (flat scoring → 2000 / 1000 / 0)
    const startMark = Math.max(createdSeq, tg.mark());
    await g.play(0, [1, 1, 0]);
    const [sg, sa] = await Promise.all([
      tg.tryWaitFor((c) => c.method === 'sendMessage' && chatOf(c) === GROUP && about(c), W, startMark),
      tg.tryWaitFor((c) => c.method === 'sendMessage' && chatOf(c) === ADMIN && about(c), W, startMark),
    ]);
    check('session.started → group in hall1 topic 11', !!sg && threadOf(sg) === HALL1_TOPIC, sg ? `thread=${threadOf(sg)}` : 'no group message after start');
    check('session.started → admin chat 555', !!sa);

    await g.play(1, [0, 1, 1]);
    const finMark = tg.mark();
    await g.finish(1);

    const isFinished = (chat: string) => (c: TgCall) =>
      c.method === 'sendMessage' && chatOf(c) === chat && about(c) && textOf(c).includes('Alice') && textOf(c).includes(g.eventName);
    const [fg, fa] = await Promise.all([tg.tryWaitFor(isFinished(GROUP), W, finMark), tg.tryWaitFor(isFinished(ADMIN), W, finMark)]);
    check('session.finished → group in hall1 topic 11, quiz top + event standings', !!fg && threadOf(fg) === HALL1_TOPIC && /Bob/.test(textOf(fg)),
      fg ? `thread=${threadOf(fg)} text=${textOf(fg)}` : 'no group message naming Alice + the event after finish');
    check('session.finished → admin chat 555 with quiz top + event standings', !!fa);
    if (fg) {
      const txt = textOf(fg);
      check('finished: winner listed before runner-up', txt.indexOf('Alice') < txt.indexOf('Bob'), txt);
    }

    const csv = await tg.tryWaitFor((c) => c.method === 'sendDocument' && /\.csv$/i.test(c.document?.filename ?? ''), W, finMark);
    check('session CSV sent as a document to admin 555', !!csv && chatOf(csv) === ADMIN && /alice@example\.com/.test(csv.document?.content ?? ''),
      csv ? `chat=${chatOf(csv)} file=${csv.document?.filename}` : 'no CSV document after finish');

    // ── commands (admin, private) ──
    const ask = async (from: number, chat: string, text: string, pred: (c: TgCall) => boolean = (c) => isSend(c) && chatOf(c) === chat) => {
      const m = tg.mark();
      tg.userMessage(from, chat, text);
      return tg.tryWaitFor(pred, W, m);
    };
    const live = await ask(555, ADMIN, '/live');
    check('/live (admin, private) replies', !!live);
    const lb = await ask(555, ADMIN, '/leaderboard');
    check('/leaderboard (admin, private) replies', !!lb, lb ? textOf(lb) : '');
    const win = await ask(555, ADMIN, '/winner');
    check('/winner (admin, private) names the winner WITH email', !!win && /Alice/.test(textOf(win)) && textOf(win).includes('@'), win ? textOf(win) : 'no reply');
    const exp = await ask(555, ADMIN, `/export ${g.code}`, (c) => c.method === 'sendDocument' && chatOf(c) === ADMIN);
    check('/export <code> sends the CSV document', !!exp && /alice@example\.com/.test(exp.document?.content ?? ''), exp ? `file=${exp.document?.filename}` : 'no document');

    // ── commands (group) ──
    const gw = await ask(555, GROUP, '/winner');
    check('/winner in the group names the winner WITHOUT email', !!gw && /Alice/.test(textOf(gw)) && !textOf(gw).includes('@'), gw ? textOf(gw) : 'no reply');

    // ── non-admin ──
    const na = await ask(777, '777', '/live');
    check('non-admin /live → "private" refusal', !!na && /private/i.test(textOf(na)), na ? textOf(na) : 'no reply');
    check('non-admin reply leaks no data', !!na && !textOf(na).includes(g.code) && !textOf(na).includes('Alice'), na ? textOf(na) : '');

    // ── inline button ──
    const bm = tg.mark();
    const upd = tg.clickButton(555, ADMIN, `lb:${g.code}`);
    const ans = await tg.tryWaitFor((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === upd.callback_query.id, W, bm);
    check('button lb:<code> → answerCallbackQuery', !!ans);
    const board = await tg.tryWaitFor((c) => isSend(c) && chatOf(c) === ADMIN && /Alice/.test(textOf(c)), W, bm);
    check('button lb:<code> → leaderboard shown', !!board, board ? textOf(board) : 'no board');

    // ── global privacy invariants ──
    const toGroup = tg.calls.filter((c) => isSend(c) && chatOf(c) === GROUP);
    const leaks = toGroup.filter((c) => visibleOf(c).includes('@'));
    check('nothing sent to the group contains "@" (no emails)', leaks.length === 0, leaks.map((c) => `#${c.seq}: ${visibleOf(c)}`).join('\n'));
    const docsElsewhere = tg.calls.filter((c) => c.method === 'sendDocument' && chatOf(c) !== ADMIN);
    check('documents (CSV) only ever go to admin 555', docsElsewhere.length === 0, docsElsewhere.map((c) => `#${c.seq} chat=${chatOf(c)}`).join('\n'));
    const unknownMethods = tg.calls.filter((c) => c.status === 404);
    check('no unknown Bot API methods called', unknownMethods.length === 0, unknownMethods.map((c) => c.method).join(','));
    const badRequests = tg.calls.filter((c) => c.status === 400);
    check('no 400 Bad Request from the API', badRequests.length === 0, badRequests.map((c) => `#${c.seq} ${c.method} ${JSON.stringify(c.params).slice(0, 200)}`).join('\n'));
    check('server never logs player emails', !srv.logs.some((l) => /@example\.com/.test(l)), srv.logs.filter((l) => /@example\.com/.test(l)).join('\n'));

    // ── quiz still healthy ──
    const h = await (await fetch(`${srv.url}/healthz`)).json();
    assert.equal(h.ok, true);
  } finally {
    game?.closeAll();
    await srv.stop();
    await tg.close();
  }
  await report(t, dump(tg, srv));
});

// ───────────────────────────── 2. OFF by default ─────────────────────────────
test('telegram e2e: TELEGRAM_BOT_TOKEN unset → zero calls, quiz works', { timeout: 120_000 }, async () => {
  const tg = await startFakeTelegram({ token: '123:abc' });
  const env = { ...tgEnv(tg), TELEGRAM_BOT_TOKEN: undefined };
  const srv = await startServer(env).catch(async (e) => { await tg.close(); throw e; });
  let game: Game | null = null;
  try {
    game = await setupGame(srv, 'OFF');
    await game.play(0, [1, 1, 0]);
    await game.play(1, [0, 0, 0]);
    await game.finish(1);
    await sleep(2000);
    assert.equal(tg.calls.length, 0, `expected zero Telegram calls, got:\n${dump(tg)()}`);
  } finally {
    game?.closeAll();
    await srv.stop();
    await tg.close();
  }
});

// ───────────────────────────── 3. outage → quiz unaffected → outbox delivers ─────────────────────────────
test('telegram e2e: Telegram down mid-game → answers still acked, messages delivered after recovery', { timeout: 300_000 }, async (t) => {
  const tg = await startFakeTelegram({ token: '123:abc' });
  const srv = await startServer(tgEnv(tg)).catch(async (e) => { await tg.close(); throw e; });
  const { check, report } = checker();
  let game: Game | null = null;
  try {
    const booted = await tg.tryWaitFor((c) => c.method === 'sendMessage', WAIT);
    check('bot sends at boot (index.ts wired)', !!booted);
    game = await setupGame(srv, 'OUT');
    const g = game;
    await g.play(0, [1, 1, 0]);

    // ── outage ──
    await tg.stop();
    const t0 = Date.now();
    await g.play(1, [0, 1, 1]);           // hard asserts: every answer acked while Telegram is unreachable
    await g.finish(1);
    const gameMs = Date.now() - t0;
    assert.ok(gameMs < 15_000, `game steps took ${gameMs} ms with Telegram down`);
    const h = await (await fetch(`${srv.url}/healthz`)).json();
    assert.equal(h.ok, true, 'healthz ok during outage');
    await sleep(1500);
    const midMark = tg.mark();

    // ── recovery ──
    await tg.start();
    const fin = await tg.tryWaitFor((c) => c.method === 'sendMessage' && chatOf(c) === GROUP && textOf(c).includes('Alice') && textOf(c).includes(g.eventName), booted ? 75_000 : 2000, midMark);
    check('finished message delivered to the group after Telegram comes back (outbox)', !!fin, 'not delivered within 75 s');
    const csv = await tg.tryWaitFor((c) => c.method === 'sendDocument' && chatOf(c) === ADMIN, booted ? 30_000 : 1000, midMark);
    check('CSV delivered to admin after recovery', !!csv);
    const leaks = tg.calls.filter((c) => isSend(c) && chatOf(c) === GROUP && visibleOf(c).includes('@'));
    check('no "@" to the group after recovery either', leaks.length === 0, leaks.map((c) => visibleOf(c)).join('\n'));
  } finally {
    game?.closeAll();
    await srv.stop();
    await tg.close();
  }
  await report(t, dump(tg, srv));
});

// ───────────────────────────── 4. fake self-test (always runs, no server) ─────────────────────────────
test('fakeTelegram: token check, long-poll, multipart, failNext, stop/start', async () => {
  const tg = await startFakeTelegram({ token: '9:xyz' });
  try {
    const bad = await fetch(`${tg.url}/bot1:nope/getMe`);
    assert.equal(bad.status, 401);
    const me = await (await fetch(`${tg.url}/bot9:xyz/getMe`)).json();
    assert.equal(me.ok, true);
    assert.equal(me.result.is_bot, true);

    // long poll is held until an update arrives
    const t0 = Date.now();
    const p = fetch(`${tg.url}/bot9:xyz/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 5, offset: 0 }) }).then((r) => r.json());
    await sleep(300);
    const u = tg.userMessage(555, 555, '/live');
    const got = await p;
    assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 4000);
    assert.equal(got.result[0].update_id, u.update_id);
    assert.equal(got.result[0].message.entities[0].type, 'bot_command');
    // confirming with offset drops it
    const after = await (await fetch(`${tg.url}/bot9:xyz/getUpdates?offset=${u.update_id + 1}&timeout=0`)).json();
    assert.deepEqual(after.result, []);

    // multipart sendDocument
    const fd = new FormData();
    fd.set('chat_id', '555');
    fd.set('caption', 'Results');
    fd.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: 'x', callback_data: 'lb:123456' }]] }));
    fd.set('document', new Blob(['rank,name,email\n1,Alice,alice@example.com\n'], { type: 'text/csv' }), 'results-123456.csv');
    const doc = await (await fetch(`${tg.url}/bot9:xyz/sendDocument`, { method: 'POST', body: fd })).json();
    assert.equal(doc.ok, true);
    const rec = tg.callsOf('sendDocument')[0];
    assert.equal(rec.document?.filename, 'results-123456.csv');
    assert.match(rec.document!.content, /alice@example\.com/);
    assert.equal(rec.params.reply_markup.inline_keyboard[0][0].callback_data, 'lb:123456');

    // failNext 429
    tg.failNext('sendMessage', { code: 429, retry_after: 3 });
    const r429 = await fetch(`${tg.url}/bot9:xyz/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: -1001, text: 'hi', message_thread_id: 11 }) });
    assert.equal(r429.status, 429);
    assert.equal((await r429.json()).parameters.retry_after, 3);
    const r200 = await (await fetch(`${tg.url}/bot9:xyz/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: -1001, text: 'hi', message_thread_id: 11 }) })).json();
    assert.equal(r200.ok, true);
    assert.equal(r200.result.message_thread_id, 11);
    const okCall = await tg.waitFor((c) => c.method === 'sendMessage' && chatOf(c) === '-1001', 1000);
    assert.equal(threadOf(okCall), 11);

    // button click targets the last bot message in that chat
    const cb = tg.clickButton(555, 555, 'lb:123456');
    assert.equal(cb.callback_query.message.message_id, doc.result.message_id);

    // outage
    const port = tg.port;
    await tg.stop();
    await assert.rejects(fetch(`${tg.url}/bot9:xyz/getMe`));
    await tg.start();
    assert.equal(tg.port, port);
    assert.equal((await fetch(`${tg.url}/bot9:xyz/getMe`)).status, 200);
  } finally {
    await tg.close();
  }
});
