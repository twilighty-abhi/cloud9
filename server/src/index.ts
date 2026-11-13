// Cloud 9 server entry. Owned by lead.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config';
import { openRepo } from './db/repo';
import { createAuth } from './auth/index';
import { createGame } from './game/index';
import { registerRoutes } from './http/index';

async function main() {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const repo = openRepo(config.dbPath);
  const auth = createAuth(config, repo);
  const game = createGame({ repo, config });
  const restored = game.registry.restore();

  const app = Fastify({ trustProxy: 1, bodyLimit: 2_000_000, logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  app.get('/healthz', async () => {
    const s = game.registry.stats();
    return { ok: true, rooms: s.rooms, sockets: s.sockets, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  });

  await registerRoutes(app, { repo, registry: game.registry, auth, config });

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(res, path) {
        if (path.includes(`${join('assets', '')}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        else res.setHeader('cache-control', 'no-cache');
      },
    });
    // SPA fallback for client routes
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) {
        reply.header('cache-control', 'no-cache');
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'not_found', message: 'Not found' });
    });
  } else {
    console.warn(`[cloud9] web build not found at ${config.webDist} — API only`);
  }

  await app.listen({ port: config.port, host: config.host });
  game.attach(app.server, auth);
  console.log(`[cloud9] listening on ${config.host}:${config.port} · public ${config.publicUrl} · restored ${restored} room(s) · ${config.moderators.length} moderator(s)`);

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return; closing = true;
    console.log(`[cloud9] ${sig} — shutting down`);
    try { game.shutdown(); } catch (e) { console.error(e); }
    try { await app.close(); } catch (e) { console.error(e); }
    try { repo.close(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (e) => console.error('[cloud9] uncaughtException', e));
  process.on('unhandledRejection', (e) => console.error('[cloud9] unhandledRejection', e));
}

main().catch((e) => { console.error(e); process.exit(1); });
