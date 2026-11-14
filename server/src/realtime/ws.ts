// Cloud 9 — WebSocket endpoint (/ws): auth on upgrade, rate limiting, heartbeats, message dispatch.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { WS_CLOSE } from '../../../shared/protocol';
import type { AuthService } from '../contracts';
import type { Registry } from '../game/registry';
import { sha256Hex } from '../game/registry';
import type { PlayerMem, Room } from '../game/room';
import { parseClientMsg } from './schema';
import { sendError, sendMsg, safeClose } from './send';

const HEARTBEAT_MS = 20_000;
const MAX_MISSED_PONGS = 2;
const RATE_PER_SEC = 20;
const MAX_PAYLOAD = 4096;

interface Ctx {
  ws: WebSocket;
  room: Room;
  role: 'player' | 'mod' | 'present';
  player: PlayerMem | null;
  modName: string | null;   // moderator username (role=mod), for notifications
  tokens: number;
  lastRefill: number;
  missed: number;
  closed: boolean;
}

export interface Realtime { close(): void }

export interface RealtimeOptions {
  heartbeatMs?: number;
  /** PUBLIC_URL; its origin is always allowed for moderator sockets. */
  publicUrl?: string;
  /** Extra allowed Origins for moderator sockets (default: env ALLOWED_ORIGINS, comma-separated). */
  allowedOrigins?: string[];
}

const normOrigin = (o: string): string | null => {
  try {
    const u = new URL(o.trim());
    return u.origin === 'null' ? null : u.origin.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Origin policy for role=mod upgrades (cross-site WebSocket hijacking protection; the cookie is still required).
 * Allowed: PUBLIC_URL's origin, ALLOWED_ORIGINS, or an Origin whose host equals the request's Host header
 * (same-origin page; e.g. the Vite dev proxy). No Origin header (non-browser client) → allowed, logged.
 */
export function makeModOriginCheck(publicUrl: string | undefined, extra: string[]): (req: IncomingMessage) => 'ok' | 'missing' | 'mismatch' {
  const allowed = new Set<string>();
  for (const o of [publicUrl ?? '', ...extra]) {
    const n = o ? normOrigin(o) : null;
    if (n) allowed.add(n);
  }
  return (req) => {
    const raw = req.headers.origin;
    if (raw === undefined || raw === '') return 'missing';
    const origin = normOrigin(raw);
    if (!origin) return 'mismatch';
    if (allowed.has(origin)) return 'ok';
    const host = (req.headers.host ?? '').toLowerCase();
    if (host && new URL(origin).host === host) return 'ok';
    return 'mismatch';
  };
}

export function attachRealtime(server: Server, auth: AuthService, registry: Registry, opts: RealtimeOptions = {}): Realtime {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD, clientTracking: false });
  const live = new Set<Ctx>();
  let shuttingDown = false;
  const modOrigin = makeModOriginCheck(
    opts.publicUrl,
    opts.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  );

  wss.on('error', (e) => console.error('[ws] server error', e));

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      if (server.listenerCount('upgrade') <= 1) socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      // not ours — leave it to another upgrade listener if there is one, otherwise don't leak the socket
      if (server.listenerCount('upgrade') <= 1) socket.destroy();
      return;
    }
    socket.on('error', () => { /* swallow; socket destroyed below or by ws */ });
    if (shuttingDown) { socket.destroy(); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          onConnection(ws, req, url);
        } catch (e) {
          console.error('[ws] connection setup failed', e);
          safeClose(ws, 1011, 'error');
        }
      });
    } catch (e) {
      console.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  };
  server.on('upgrade', onUpgrade);

  function onConnection(ws: WebSocket, req: IncomingMessage, url: URL): void {
    ws.on('error', () => { /* handled by close */ });
    const role = url.searchParams.get('role');
    const code = url.searchParams.get('code') ?? '';
    const room = /^\d{6}$/.test(code) ? registry.get(code) : null;
    if (!room) {
      sendError(ws, 'not_found', 'Room not found');
      safeClose(ws, WS_CLOSE.NOT_FOUND, 'not_found');
      return;
    }
    let player: PlayerMem | null = null;
    let modName: string | null = null;
    if (role === 'player') {
      const token = url.searchParams.get('token') ?? '';
      player = token && token.length <= 200 ? room.findByTokenHash(sha256Hex(token)) : null;
      if (!player) {
        sendError(ws, 'unauthorized', 'Unknown player token');
        safeClose(ws, WS_CLOSE.UNAUTHORIZED, 'unauthorized');
        return;
      }
      if (player.kicked) {
        sendMsg(ws, { t: 'kicked' });
        safeClose(ws, WS_CLOSE.KICKED, 'kicked');
        return;
      }
    } else if (role === 'mod') {
      const originCheck = modOrigin(req);
      if (originCheck === 'mismatch') {
        console.warn(`[ws] moderator socket rejected: Origin ${JSON.stringify(String(req.headers.origin).slice(0, 200))} not allowed (set ALLOWED_ORIGINS)`);
        sendError(ws, 'unauthorized', 'Origin not allowed');
        safeClose(ws, WS_CLOSE.UNAUTHORIZED, 'bad_origin');
        return;
      }
      if (originCheck === 'missing') console.warn('[ws] moderator socket without Origin header (non-browser client); cookie check only');
      const me = auth.moderatorFromCookieHeader(req.headers.cookie);
      if (!me || (me.id !== room.moderatorId && !me.isSuper)) {
        sendError(ws, 'unauthorized', 'Not a moderator of this room');
        safeClose(ws, WS_CLOSE.UNAUTHORIZED, 'unauthorized');
        return;
      }
      modName = me.username;
    } else if (role !== 'present') {
      sendError(ws, 'bad_message', 'Unknown role');
      safeClose(ws, WS_CLOSE.UNAUTHORIZED, 'bad_role');
      return;
    }

    const ctx: Ctx = { ws, room, role, player, modName, tokens: RATE_PER_SEC, lastRefill: Date.now(), missed: 0, closed: false };
    live.add(ctx);

    ws.on('pong', () => { ctx.missed = 0; });
    ws.on('close', () => {
      if (ctx.closed) return;
      ctx.closed = true;
      live.delete(ctx);
      try {
        if (ctx.player) room.detachPlayer(ws, ctx.player);
        else room.detachHost(ws);
      } catch (e) {
        console.error('[ws] detach failed', e);
      }
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        onMessage(ctx, data, isBinary);
      } catch (e) {
        console.error('[ws] message handler failed', e);
      }
    });

    if (player) room.attachPlayer(ws, player);
    else room.attachHost(ws, role as 'mod' | 'present');
  }

  function takeToken(ctx: Ctx): boolean {
    const now = Date.now();
    ctx.tokens = Math.min(RATE_PER_SEC, ctx.tokens + ((now - ctx.lastRefill) / 1000) * RATE_PER_SEC);
    ctx.lastRefill = now;
    if (ctx.tokens < 1) return false;
    ctx.tokens -= 1;
    return true;
  }

  function onMessage(ctx: Ctx, data: RawData, isBinary: boolean): void {
    if (ctx.closed) return;
    const { ws, room } = ctx;
    if (!takeToken(ctx)) {
      sendError(ws, 'rate_limited', 'Too many messages');
      safeClose(ws, WS_CLOSE.RATE_LIMITED, 'rate_limited');
      return;
    }
    if (isBinary) { sendError(ws, 'bad_message', 'Binary frames not supported'); return; }
    const raw = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const msg = parseClientMsg(raw);
    if (!msg) { sendError(ws, 'bad_message', 'Invalid message'); return; }

    switch (msg.t) {
      case 'ping':
        sendMsg(ws, { t: 'pong', serverNow: Date.now() });
        return;
      case 'answer': {
        if (ctx.role !== 'player' || !ctx.player) { sendError(ws, 'bad_message', 'Only players can answer'); return; }
        const r = room.answer(ctx.player, msg.qIndex, msg.choice);
        if (!r.ok) sendError(ws, r.code, r.message);
        return;
      }
      case 'mod': {
        if (ctx.role !== 'mod') { sendError(ws, 'unauthorized', 'Moderator only'); return; }
        const r = room.modAction(msg.action, msg.expectQ, ctx.modName);
        if (!r.ok) sendError(ws, r.code, r.message);
        return;
      }
      case 'kick': {
        if (ctx.role !== 'mod') { sendError(ws, 'unauthorized', 'Moderator only'); return; }
        const r = room.kick(msg.playerId, ctx.modName);
        if (!r.ok) sendError(ws, r.code, r.message);
        return;
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const ctx of live) {
      try {
        if (ctx.missed >= MAX_MISSED_PONGS) {
          ctx.ws.terminate();
          continue;
        }
        ctx.missed++;
        ctx.ws.ping();
      } catch {
        /* ignore; close handler cleans up */
      }
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      shuttingDown = true;
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const ctx of live) safeClose(ctx.ws, 1001, 'shutdown');
      try { wss.close(); } catch { /* ignore */ }
    },
  };
}
