import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import type { JoinRes, QuizInput } from '../../shared/api';
import type { EventDef, QuizDef, SessionSummary } from '../../shared/model';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';

export const password = 'local-audit-password';
export const quizInput: QuizInput = {
  title: 'Audit quiz', scoring: 'flat', emailMode: 'optional',
  questions: [
    { text: 'What is two plus two?', options: ['Three', 'Four'], correctIndex: 1, timeLimitSec: 20, pointsMax: 1000 },
    { text: 'What is two plus three?', options: ['Five', 'Six'], correctIndex: 0, timeLimitSec: 20, pointsMax: 1000 },
  ],
};

type State = Extract<ServerMsg, { t: 'state' }>;
type Message<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

export class AuditSocket {
  private readonly messages: ServerMsg[] = [];
  private cursor = 0;
  closeCode: number | undefined;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.messages.push(JSON.parse(data.toString()) as ServerMsg));
    ws.on('close', (code) => { this.closeCode = code; });
    ws.on('error', () => {});
  }
  send(message: ClientMsg) { this.ws.send(JSON.stringify(message)); }
  async next<T extends ServerMsg['t']>(type: T, predicate: (message: Message<T>) => boolean = () => true) {
    for (let attempt = 0; attempt < 400; attempt++) {
      while (this.cursor < this.messages.length) {
        const message = this.messages[this.cursor++];
        if (message.t === type && predicate(message as Message<T>)) return message as Message<T>;
      }
      if (this.closeCode !== undefined) break;
      await delay(10);
    }
    throw new Error(`Missing WebSocket message ${type}; received ${this.messages.map((m) => m.t).join(', ')}; close ${this.closeCode}`);
  }
  state(state: State['state']) { return this.next('state', (message) => message.state === state); }
  async closed() {
    for (let attempt = 0; attempt < 400 && this.closeCode === undefined; attempt++) await delay(10);
    assert.notEqual(this.closeCode, undefined, 'WebSocket did not close');
    return this.closeCode;
  }
}

async function localPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function auditServer(t: TestContext, options: {
  dbPath?: string;
  built?: boolean;
  staticFixture?: boolean;
  env?: NodeJS.ProcessEnv;
  startupFailure?: boolean;
} = {}) {
  const port = await localPort();
  const origin = `http://127.0.0.1:${port}`;
  const args = options.built ? ['dist/server.mjs'] : ['--import', 'tsx', 'server/src/index.ts'];
  let webDist = options.built ? resolve('dist/web') : '/nonexistent/cloud9-audit';
  if (options.staticFixture) {
    webDist = await temporaryDirectory(t);
    await mkdir(join(webDist, 'assets'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html><script src="/assets/index-test.js"></script>');
    await writeFile(join(webDist, 'assets/index-test.js'), 'console.log("static asset test");');
  }
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: origin,
      DB_PATH: options.dbPath ?? ':memory:', MODERATORS: `owner:${password},other:${password},root:${password}:super`,
      SESSION_SECRET: 'cloud9-audit-local-only-session-secret-fixture', JOIN_RATE_PER_MIN: '1000', LOGIN_RATE_PER_MIN: '5',
      LOG_LEVEL: 'silent', WEB_DIST: webDist, ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data.toString(); });
  child.stderr.on('data', (data) => { logs += data.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const sockets = new Set<WebSocket>();
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    for (const ws of sockets) ws.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { return await exit; } finally { clearTimeout(kill); }
  };
  t.after(() => stop());

  for (let attempt = 0; attempt < 240; attempt++) {
    if (logs.includes('listening on')) break;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (options.startupFailure) break;
      throw new Error(`Server exited during startup:\n${logs}`);
    }
    await delay(25);
  }
  assert.ok(logs.includes('listening on') || (options.startupFailure && child.exitCode !== null), logs);

  function request(path: string, init?: RequestInit) {
    return fetch(origin + path, { ...init, signal: AbortSignal.timeout(5000) });
  }
  async function json<T>(path: string, method: string, status: number, body?: unknown, cookie?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const response = await request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: unknown = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data as T;
  }
  async function login(username = 'owner', candidate = password) {
    const response = await request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: candidate }),
    });
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie');
    assert.ok(header);
    return header.split(';')[0];
  }
  async function room(cookie: string, options: { eventId?: string; listed?: boolean; title?: string } = {}) {
    const quiz = await json<QuizDef>('/api/quizzes', 'POST', 201, {
      ...quizInput, title: options.title ?? quizInput.title, eventId: options.eventId,
    }, cookie);
    return json<SessionSummary>('/api/sessions', 'POST', 201, { quizId: quiz.id, listed: options.listed }, cookie);
  }
  function event(cookie: string) {
    return json<EventDef>('/api/events', 'POST', 201, { name: 'Audit event' }, cookie);
  }
  function joinPlayer(code: string, name: string, email?: string) {
    return json<JoinRes>(`/api/play/${code}/join`, 'POST', 200, { name, email });
  }
  async function connect(role: string, code: string, opts: { token?: string; cookie?: string; origin?: string } = {}) {
    const query = new URLSearchParams({ role, code });
    if (opts.token) query.set('token', opts.token);
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws?${query}`, {
      headers: opts.cookie ? { cookie: opts.cookie } : undefined, origin: opts.origin, handshakeTimeout: 3000,
    });
    sockets.add(ws);
    ws.once('close', () => sockets.delete(ws));
    const client = new AuditSocket(ws);
    await once(ws, 'open');
    return client;
  }
  return { origin, request, json, login, room, event, joinPlayer, connect, stop, exit, logs: () => logs };
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cloud9-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function auditDb(t: TestContext) {
  return join(await temporaryDirectory(t), 'audit.db');
}
