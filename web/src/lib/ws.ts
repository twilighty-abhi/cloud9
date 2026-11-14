// Reconnecting WebSocket client + clock offset + snapshot store. Owned by lead. Used by player, mod and present UIs.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClientMsg, ServerMsg, PlayerSnapshot, HostSnapshot } from '../../../shared/protocol';
import { WS_CLOSE } from '../../../shared/protocol';
import { ClockSync } from './clock';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type Fatal = null | 'not_found' | 'unauthorized' | 'kicked';

export interface RoomConn<S> {
  snap: S | null;
  status: ConnStatus;
  fatal: Fatal;
  /** server time estimate (ms) — use for countdowns */
  now: () => number;
  send: (m: ClientMsg) => boolean;
  lastError: { code: string; message: string } | null;
}

type Snap = PlayerSnapshot | HostSnapshot;

export function wsUrl(params: Record<string, string>): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?${new URLSearchParams(params).toString()}`;
}

/**
 * useRoom — connects to /ws with the given params, keeps the latest snapshot (applying lobby/progress/ack deltas),
 * reconnects with backoff (0.5s→5s + jitter), reconnects immediately on visibilitychange/online.
 * Pass params = null to stay disconnected.
 */
export function useRoom<S extends Snap>(params: Record<string, string> | null): RoomConn<S> {
  const [snap, setSnap] = useState<S | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [fatal, setFatal] = useState<Fatal>(null);
  const [lastError, setLastError] = useState<RoomConn<S>['lastError']>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const clockRef = useRef<ClockSync>(new ClockSync());
  const snapRef = useRef<S | null>(null);
  const key = params ? JSON.stringify(params) : '';

  useEffect(() => {
    if (!params) return;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    // Half-open sockets (phone slept / switched network) can look OPEN for a long time; track liveness ourselves.
    let lastMsgAt = Date.now();
    const STALE_MS = 50_000;
    // Round-trip timing for the clock offset (#20): one ping in flight at a time.
    let pingSentAt: number | null = null;
    const sendPing = (ws: WebSocket) => { pingSentAt = Date.now(); ws.send('{"t":"ping"}'); };
    snapRef.current = null;
    setSnap(null); setFatal(null); setStatus('connecting');

    const apply = (next: S | null) => { snapRef.current = next; setSnap(next); };

    const connect = () => {
      if (stopped) return;
      clearTimeout(timer);
      const prev = wsRef.current;
      if (prev) { prev.onclose = null; prev.onmessage = null; try { prev.close(); } catch { /* */ } }
      let ws: WebSocket;
      try { ws = new WebSocket(wsUrl(params)); } catch { schedule(); return; }
      wsRef.current = ws;
      let firstState = true; // a new socket's first snapshot is authoritative even if its v is lower (server clock moved back across a restart)
      ws.onopen = () => {
        attempt = 0; lastMsgAt = Date.now(); setStatus('open');
        clockRef.current.resetRtt();
        try { sendPing(ws); } catch { /* */ } // RTT-compensated offset right away
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (wsRef.current !== ws || ws.readyState !== 1) return;
          if (Date.now() - lastMsgAt > STALE_MS) { setStatus('reconnecting'); connect(); return; } // no pong for 2+ pings
          sendPing(ws);
        }, 20000);
      };
      ws.onmessage = (ev) => {
        lastMsgAt = Date.now();
        let m: ServerMsg;
        try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
        const cur = snapRef.current as any;
        switch (m.t) {
          case 'state': {
            if (!firstState && cur && typeof (m as any).v === 'number' && (m as any).v < cur.v) return;
            firstState = false;
            clockRef.current.addUntimed((m as any).serverNow, Date.now()); // used only until the first pong
            const { t, ...rest } = m as any;
            apply(rest as S);
            break;
          }
          case 'lobby':
            if (cur && cur.role !== 'player' && m.v >= cur.v) apply({ ...cur, playerCount: m.playerCount, players: m.players });
            break;
          case 'progress':
            if (cur && cur.role !== 'player' && m.v >= cur.v) apply({ ...cur, answered: m.answered, playerCount: m.playerCount });
            break;
          case 'ack':
            if (cur && cur.role === 'player' && cur.question && cur.question.qIndex === m.qIndex) apply({ ...cur, myAnswer: { choice: m.choice } });
            break;
          case 'pong': {
            const at = Date.now();
            if (pingSentAt !== null) clockRef.current.addPong(m.serverNow, pingSentAt, at);
            else clockRef.current.addUntimed(m.serverNow, at);
            pingSentAt = null;
            break;
          }
          case 'kicked':
            setFatal('kicked'); stopped = true;
            break;
          case 'error':
            setLastError({ code: m.code, message: m.message });
            // Only connect-time errors (sent before the first snapshot, followed by a 44xx close) are fatal.
            // In-session errors such as a mod's kick → 'not_found' must not kill a live screen.
            if (!cur && m.code === 'not_found') { setFatal('not_found'); stopped = true; }
            if (!cur && m.code === 'unauthorized') { setFatal('unauthorized'); stopped = true; }
            break;
        }
      };
      ws.onclose = (ev) => {
        // A socket superseded by wake() must not clear state or schedule a second reconnect (duplicate sockets).
        if (wsRef.current !== ws) return;
        clearInterval(pingTimer);
        wsRef.current = null;
        if (ev.code === WS_CLOSE.NOT_FOUND) { setFatal('not_found'); stopped = true; }
        else if (ev.code === WS_CLOSE.UNAUTHORIZED) { setFatal('unauthorized'); stopped = true; }
        else if (ev.code === WS_CLOSE.KICKED) { setFatal('kicked'); stopped = true; }
        if (stopped) { setStatus('closed'); return; }
        setStatus('reconnecting');
        schedule();
      };
      ws.onerror = () => { /* onclose follows */ };
    };

    const schedule = () => {
      if (stopped) return;
      const base = Math.min(5000, 500 * 2 ** attempt);
      attempt++;
      timer = setTimeout(connect, base / 2 + Math.random() * base / 2);
    };

    const wake = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const cur = wsRef.current;
      const dead = !cur || cur.readyState > 1;
      // OPEN but silent for a while after sleeping → probably half-open; replace it rather than wait for TCP to notice.
      const silent = !!cur && cur.readyState === 1 && Date.now() - lastMsgAt > 25_000;
      if (dead || silent) { attempt = 0; if (silent) setStatus('reconnecting'); connect(); }
    };
    const onOnline = () => {
      // network changed: an OPEN socket from the old network is almost certainly dead
      if (stopped) return;
      const cur = wsRef.current;
      if (cur && cur.readyState === 0) return;
      attempt = 0; setStatus('reconnecting'); connect();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', onOnline);
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer); clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', onOnline);
      const ws = wsRef.current; wsRef.current = null;
      if (ws) { ws.onclose = null; try { ws.close(1000); } catch { /* */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    snap, status, fatal, lastError,
    now: () => Date.now() + clockRef.current.offset(),
    send: (m) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(m)); return true;
    },
  };
}

/** Re-render every `ms` (for countdowns). */
export function useTick(ms = 200, active = true) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
