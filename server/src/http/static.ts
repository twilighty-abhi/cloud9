// Static web build + SPA fallback.
// Cache policy: Vite's content-hashed /assets/* are immutable for a year; index.html (and the SPA fallback) is
// no-cache so a deploy is picked up on the next load. `cacheControl: false` stops @fastify/send from writing its own
// `public, max-age=0` over the header set in setHeaders. `preCompressed` serves the .br/.gz files that
// scripts/precompress.mjs writes next to each asset at build time (falls back to the plain file when absent).
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { sep } from 'node:path';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';

export async function registerStatic(app: FastifyInstance, webDist: string) {
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    cacheControl: false,
    preCompressed: true,
    setHeaders(res, path) {
      res.setHeader('cache-control', path.includes(`${sep}assets${sep}`) ? IMMUTABLE : NO_CACHE);
      res.setHeader('vary', 'accept-encoding');
    },
  });
  // SPA fallback for client routes
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });
}
