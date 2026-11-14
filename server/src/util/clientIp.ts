// Client IP resolution shared by the HTTP layer (Fastify trustProxy) and raw WebSocket upgrades.
import type { IncomingMessage } from 'node:http';

/**
 * Number of reverse-proxy hops we trust (Caddy/Nginx in front of the app). Fastify is configured with
 * `trustProxy: (_addr, hop) => hop < TRUSTED_PROXY_HOPS`, so `req.ip` is the X-Forwarded-For entry
 * that many hops from the right (or the socket address when there is no XFF).
 */
export const TRUSTED_PROXY_HOPS = 1;

export const trustProxy = (_addr: string, hop: number): boolean => hop < TRUSTED_PROXY_HOPS;

/**
 * Same result as Fastify's `req.ip` with the trustProxy above, for raw `IncomingMessage`s (WS upgrades).
 * Mirrors proxy-addr: addresses = [socket, ...XFF right-to-left]; walk while trusted, return the first untrusted.
 */
export function clientIpFromRaw(req: IncomingMessage): string {
  const socketAddr = req.socket?.remoteAddress ?? '';
  const addrs = [socketAddr];
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (raw) {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) addrs.push(parts[i]);
  }
  let i = 0;
  while (i < addrs.length - 1 && trustProxy(addrs[i], i)) i++;
  return addrs[i] || 'unknown';
}
