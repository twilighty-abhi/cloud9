// Cloud 9 — game engine entry point.
import type { Server } from 'node:http';
import type { AuthService, CreateGame, Game } from '../contracts';
import { Registry } from './registry';
import { attachRealtime, type Realtime } from '../realtime/ws';

export const createGame: CreateGame = ({ repo, config }): Game => {
  const registry = new Registry(repo, config);
  let realtime: Realtime | null = null;
  return {
    registry,
    attach(server: Server, auth: AuthService) {
      if (realtime) return;
      realtime = attachRealtime(server, auth, registry);
    },
    shutdown() {
      try { realtime?.close(); } catch (e) { console.error('[game] realtime close failed', e); }
      realtime = null;
      try { registry.shutdown(); } catch (e) { console.error('[game] registry shutdown failed', e); }
      try { repo.flush(); } catch (e) { console.error('[game] repo flush failed', e); }
    },
  };
};
