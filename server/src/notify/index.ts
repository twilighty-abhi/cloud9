// Cloud 9 — Telegram wiring. Owned by lead. Off unless config.telegram is set; any failure here never stops the quiz server.
import type { Config } from '../config';
import type { Repo, GameRegistry } from '../contracts';
import { bus } from './bus';
import { createTgClient } from './client';
import { createSender } from './sender';
import { attachNotifications } from './notifications';
import { createCommandRouter } from './commands';
import { startPoller } from './poller';

export function startTelegram(deps: { config: Config; repo: Repo; registry: GameRegistry; restoredRooms: number }): { stop(): Promise<void> } | null {
  const cfg = deps.config.telegram;
  if (!cfg) return null;
  try {
    const client = createTgClient(cfg);
    const sender = createSender({ cfg, dbPath: deps.config.dbPath, client });
    sender.start();
    const notes = attachNotifications({ cfg, bus, sender, repo: deps.repo, registry: deps.registry, config: deps.config });
    const router = createCommandRouter({ cfg, client, sender, repo: deps.repo, registry: deps.registry, config: deps.config });
    const poller = startPoller({ cfg, client, router });   // also calls deleteWebhook + setMyCommands
    bus.emit({ type: 'system.started', at: Date.now(), actor: null, restoredRooms: deps.restoredRooms, moderators: deps.config.moderators.length });
    console.log(`[cloud9] telegram on · ${cfg.notifyChatIds.length} notify chat(s) · ${cfg.adminIds.length} admin(s)`);
    return {
      async stop() {
        try { notes.stop(); } catch { /* */ }
        try { await poller.stop(); } catch { /* */ }
        try { await sender.stop(); } catch { /* */ }
      },
    };
  } catch (e) {
    console.error('[cloud9] telegram failed to start — continuing without it:', (e as Error)?.message);
    return null;
  }
}
