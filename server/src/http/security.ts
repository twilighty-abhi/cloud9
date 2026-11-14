// Security response headers (CSP, clickjacking, sniffing, referrer, HSTS). Applied to every HTTP response via onSend.
import type { FastifyInstance } from 'fastify';

/**
 * CSP for the built SPA: own scripts only; Google Fonts (CSS + woff2); inline style attributes (Preact `style={...}`);
 * question images may be any http(s) URL (moderator-supplied) or data:; WebSocket to the same host.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(opts: { publicUrl: string }): Record<string, string> {
  const h: Record<string, string> = {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (opts.publicUrl.startsWith('https://')) h['strict-transport-security'] = 'max-age=15552000';
  return h;
}

export function registerSecurityHeaders(app: FastifyInstance, opts: { publicUrl: string }) {
  const headers = securityHeaders(opts);
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(headers)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}
