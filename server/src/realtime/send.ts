// Cloud 9 — safe socket send helpers.
import { WebSocket } from 'ws';
import type { ServerMsg, ErrorCode } from '../../../shared/protocol';

/** Slow consumers holding more than this many queued bytes are terminated (protects server memory). */
const MAX_BUFFERED = 1_000_000;

export function sendRaw(ws: WebSocket, data: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) {
    try { ws.terminate(); } catch { /* ignore */ }
    return;
  }
  try {
    ws.send(data);
  } catch {
    /* socket died mid-send; close handler cleans up */
  }
}

export function sendMsg(ws: WebSocket, msg: ServerMsg): void {
  sendRaw(ws, JSON.stringify(msg));
}

export function sendError(ws: WebSocket, code: ErrorCode, message: string): void {
  sendMsg(ws, { t: 'error', code, message });
}

export function safeClose(ws: WebSocket, code: number, reason = ''): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
  } catch {
    try { ws.terminate(); } catch { /* ignore */ }
  }
}
