// Reconnecting WebSocket client + clock offset + snapshot store. Owned by lead. Used by player, mod and present UIs.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ClientMsg, ServerMsg, PlayerSnapshot, HostSnapshot } from '../../../shared/protocol';
import { WS_CLOSE } from '../../../shared/protocol';

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
  const offsetRef = useRef(0);
  const snapRef = useRef<S | null>(null);
  const key = params ? JSON.stringify(params) : '';

  useEffect(() => {
    if (!params) return;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    snapRef.current = null;
    setSnap(null); setFatal(null); setStatus('connecting');

    const apply = (next: S | null) => { snapRef.current = next; setSnap(next); };

    const connect = () => {
      if (stopped) return;
      clearTimeout(timer);
      let ws: WebSocket;
      try { ws = new WebSocket(wsUrl(params)); } catch { schedule(); return; }
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0; setStatus('open');
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20000);
      };
      ws.onmessage = (ev) => {
        let m: ServerMsg;
        try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
        const cur = snapRef.current as any;
        switch (m.t) {
          case 'state': {
            if (cur && typeof (m as any).v === 'number' && (m as any).v < cur.v) return;
            offsetRef.current = (m as any).serverNow - Date.now();
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
          case 'pong':
            offsetRef.current = m.serverNow - Date.now();
            break;
          case 'kicked':
            setFatal('kicked'); stopped = true;
            break;
          case 'error':
            setLastError({ code: m.code, message: m.message });
            if (m.code === 'not_found') { setFatal('not_found'); stopped = true; }
            if (m.code === 'unauthorized') { setFatal('unauthorized'); stopped = true; }
            break;
        }
      };
      ws.onclose = (ev) => {
        clearInterval(pingTimer);
        if (wsRef.current === ws) wsRef.current = null;
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
      if (stopped) return;
      if (document.visibilityState === 'visible' && (!wsRef.current || wsRef.current.readyState > 1)) { attempt = 0; connect(); }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer); clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      const ws = wsRef.current; wsRef.current = null;
      if (ws) { ws.onclose = null; try { ws.close(1000); } catch { /* */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    snap, status, fatal, lastError,
    now: () => Date.now() + offsetRef.current,
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
