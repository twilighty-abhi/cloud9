// Cloud 9 — in-process notification bus. Owned by lead. Emitting never throws or blocks the game.
import type { Bus, NotifyEvent } from './contracts';

function createBus(): Bus {
  const listeners = new Set<(e: NotifyEvent) => void>();
  return {
    emit(e) {
      if (listeners.size === 0) return;
      queueMicrotask(() => {
        for (const l of listeners) {
          try { l(e); } catch (err) { console.error('[notify] listener error', (err as Error)?.message); }
        }
      });
    },
    on(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

/** Process-wide singleton. Game/HTTP code: `import { bus } from '../notify/bus'` then `bus.emit({...})`. */
export const bus: Bus = createBus();
export { createBus };
