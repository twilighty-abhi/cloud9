// Cloud 9 — WebSocket endpoint (/ws): auth on upgrade, rate limiting, heartbeats, message dispatch.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { WS_CLOSE } from '../../../shared/protocol';
import type { AuthService } from '../contracts';
import type { Registry } from '../game/registry';
import { sha256Hex } from '../game/registry';
import type { PlayerMem, Room } from '../game/room';
import { clientIpFromRaw } from '../util/clientIp';
import { createFailureLimiter } from '../util/failureLimiter';
import { parseClientMsg } from './schema';
import { sendError, sendMsg, safeClose } from './send';

const HEARTBEAT_MS = 20_000;
const MAX_MISSED_PONGS = 2;
const RATE_PER_SEC = 20;
const MAX_PAYLOAD = 4096;
// Connection caps. A whole venue shares ONE public IP (NAT), so the per-IP cap must stay far above the
// largest expected audience; it exists to stop a single client opening thousands of sockets.
const DEFAULT_MAX_PER_IP = 1500;
const DEFAULT_MAX_TOTAL = 20_000;
// Failed room lookups (unknown code) per IP per minute before that IP gets 4429 for a minute.
const DEFAULT_LOOKUP_FAILS_PER_MIN = 600;

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export interface RealtimeOptions {
  heartbeatMs?: number;
  /** Max concurrent sockets per client IP (env WS_MAX_PER_IP, default 1500). */
  maxPerIp?: number;
  /** Max concurrent sockets in total (env WS_MAX_TOTAL, default 20000). */
  maxTotal?: number;
  /** Failed room lookups per IP per minute (env PLAY_LOOKUP_RATE_PER_MIN, default 600). */
  lookupFailsPerMin?: number;
}

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

export function attachRealtime(server: Server, auth: AuthService, registry: Registry, opts: RealtimeOptions = {}): Realtime {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD, clientTracking: false });
  const live = new Set<Ctx>();
  let shuttingDown = false;
  const maxPerIp = opts.maxPerIp ?? envInt('WS_MAX_PER_IP', DEFAULT_MAX_PER_IP);
  const maxTotal = opts.maxTotal ?? envInt('WS_MAX_TOTAL', DEFAULT_MAX_TOTAL);
  const lookupFails = createFailureLimiter({ max: opts.lookupFailsPerMin ?? envInt('PLAY_LOOKUP_RATE_PER_MIN', DEFAULT_LOOKUP_FAILS_PER_MIN), windowMs: 60_000 });
  const perIp = new Map<string, number>();
  let total = 0;

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
    const ip = clientIpFromRaw(req);
    const overCap = total >= maxTotal || (perIp.get(ip) ?? 0) >= maxPerIp;
    if (!overCap) {
      // Counted from upgrade until the underlying TCP socket closes (covers half-finished handshakes too).
      total++;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      let released = false;
      socket.once('close', () => {
        if (released) return;
        released = true;
        total--;
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      });
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          if (overCap) {
            ws.on('error', () => { /* handled by close */ });
            sendError(ws, 'rate_limited', 'Too many connections');
            safeClose(ws, WS_CLOSE.RATE_LIMITED, 'too_many_connections');
            return;
          }
          onConnection(ws, req, url, ip);
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

  function onConnection(ws: WebSocket, req: IncomingMessage, url: URL, ip: string): void {
    ws.on('error', () => { /* handled by close */ });
    const role = url.searchParams.get('role');
    const code = url.searchParams.get('code') ?? '';
    if (lookupFails.blocked(ip)) {
      sendError(ws, 'rate_limited', 'Too many unknown room codes, please wait a minute');
      safeClose(ws, WS_CLOSE.RATE_LIMITED, 'rate_limited');
      return;
    }
    const room = /^\d{6}$/.test(code) ? registry.get(code) : null;
    if (!room) {
      lookupFails.fail(ip);
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
