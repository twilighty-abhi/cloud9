// Cloud 9 — Telegram long polling (getUpdates). Agent BOT.
// Never affects the quiz: every call is wrapped; errors back off; one bad update never stops the loop.
import type { StartPoller } from './contracts';
import { TgError } from './contracts';

const POLL_TIMEOUT_SEC = 30;
const CLIENT_TIMEOUT_MS = 40_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CONFLICT_BACKOFF_MS = 30_000;

const errMsg = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200);

export const startPoller: StartPoller = ({ client, router }) => {
  let stopped = false;
  let offset = 0; // memory only — Telegram keeps unconfirmed updates for 24h
  let wake: (() => void) | null = null;
  let stopSignal!: () => void;
  const stopPromise = new Promise<'stop'>((res) => { stopSignal = () => res('stop'); });

  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      if (stopped) return res();
      const t = setTimeout(() => { wake = null; res(); }, ms);
      wake = () => { clearTimeout(t); wake = null; res(); };
    });

  const loop = async () => {
    try {
      await client.call('deleteWebhook', { drop_pending_updates: false });
    } catch (err) {
      console.warn(`[telegram/poller] deleteWebhook failed — ${errMsg(err)}`);
    }
    if (stopped) return;
    try {
      await client.call('setMyCommands', { commands: router.commands() });
    } catch (err) {
      console.warn(`[telegram/poller] setMyCommands failed — ${errMsg(err)}`);
    }

    let backoff = BACKOFF_MIN_MS;
    let conflictLogged = false;
    while (!stopped) {
      let updates: any[];
      try {
        const req = client.call<any[]>(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: CLIENT_TIMEOUT_MS },
        );
        req.catch(() => {}); // if we stop mid-request, the late rejection must not be unhandled
        const res = await Promise.race([req, stopPromise]);
        if (res === 'stop') break;
        updates = Array.isArray(res) ? res : [];
        backoff = BACKOFF_MIN_MS;
        conflictLogged = false;
      } catch (err) {
        if (stopped) break;
        if (err instanceof TgError && err.code === 409) {
          if (!conflictLogged) {
            console.warn('[telegram/poller] 409 Conflict — another poller or a webhook is active; backing off 30s');
            conflictLogged = true;
          }
          await sleep(CONFLICT_BACKOFF_MS);
          continue;
        }
        const retryAfter = err instanceof TgError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0;
        const wait = Math.min(BACKOFF_MAX_MS, Math.max(backoff, retryAfter));
        console.warn(`[telegram/poller] getUpdates failed (retry in ${Math.round(wait / 1000)}s) — ${errMsg(err)}`);
        await sleep(wait);
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        continue;
      }

      for (const u of updates) {
        if (stopped) break;
        const id = typeof u?.update_id === 'number' ? u.update_id : null;
        if (id !== null && id < offset) continue; // already processed
        try {
          await router.handleUpdate(u);
        } catch (err) {
          console.warn(`[telegram/poller] update handler threw — ${errMsg(err)}`);
        }
        if (id !== null) offset = Math.max(offset, id + 1);
      }
    }
  };

  const done = loop().catch((err) => console.warn(`[telegram/poller] loop crashed — ${errMsg(err)}`));

  return {
    async stop() {
      if (stopped) return done;
      stopped = true;
      stopSignal();
      wake?.();
      await done;
    },
  };
};
