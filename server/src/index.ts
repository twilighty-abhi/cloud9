// Cloud 9 server entry. Owned by lead.
import Fastify from 'fastify';
import { registerStatic } from './http/static';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { openRepo } from './db/repo';
import { createAuth } from './auth/index';
import { createGame } from './game/index';
import { registerRoutes } from './http/index';
import { startTelegram } from './notify/index';

async function main() {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const repo = openRepo(config.dbPath);
  const auth = createAuth(config, repo);
  const game = createGame({ repo, config });
  const restored = game.registry.restore();

  const app = Fastify({ trustProxy: (_addr: string, hop: number) => hop < 1, bodyLimit: 2_000_000, logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  app.get('/healthz', async () => {
    const s = game.registry.stats();
    return { ok: true, rooms: s.rooms, sockets: s.sockets, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  });

  await registerRoutes(app, { repo, registry: game.registry, auth, config });

  if (existsSync(config.webDist)) {
    await registerStatic(app, config.webDist);
  } else {
    console.warn(`[cloud9] web build not found at ${config.webDist} — API only`);
  }

  await app.listen({ port: config.port, host: config.host });
  game.attach(app.server, auth);
  const telegram = startTelegram({ config, repo, registry: game.registry, restoredRooms: restored });
  console.log(`[cloud9] listening on ${config.host}:${config.port} · public ${config.publicUrl} · restored ${restored} room(s) · ${config.moderators.length} moderator(s)`);

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return; closing = true;
    console.log(`[cloud9] ${sig} — shutting down`);
    try { await telegram?.stop(); } catch (e) { console.error(e); }
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
