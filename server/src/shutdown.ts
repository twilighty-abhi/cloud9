// Cloud 9 — graceful shutdown order. Quiz data is made durable first; Telegram (network, slow) goes last and is bounded,
// so everything fits inside the container's stop_grace_period (20 s, docker-compose.yml).

export interface ShutdownDeps {
  /** Fastify close: new requests get 503 immediately, resolves once in-flight requests finish. */
  closeHttp(): Promise<void>;
  /** Closes WebSockets, disposes rooms, flushes the answer queue. */
  shutdownGame(): void;
  /** Final flush + close of the quiz DB. */
  closeRepo(): void;
  /** Telegram poller + outbox sender drain; null when Telegram is off. */
  stopTelegram: (() => Promise<void>) | null;
  log?: (msg: string, err?: unknown) => void;
  /** Upper bound for each awaited step (default 5000 ms). */
  stepTimeoutMs?: number;
}

function bounded(p: Promise<void>, ms: number, what: string, log: (m: string, e?: unknown) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => { log(`[cloud9] shutdown: ${what} still running after ${ms} ms, moving on`); resolve(); }, ms);
    p.then(
      () => { clearTimeout(t); resolve(); },
      (e) => { clearTimeout(t); log(`[cloud9] shutdown: ${what} failed`, e); resolve(); },
    );
  });
}

/**
 * Order: stop accepting HTTP → game shutdown (WS closed, rooms disposed, answers flushed) → Telegram stop (bounded;
 * its handlers may still read the DB) → wait for HTTP close (bounded) → close the DB. Never throws.
 */
export async function runShutdown(d: ShutdownDeps): Promise<void> {
  const log = d.log ?? ((m: string, e?: unknown) => (e === undefined ? console.log(m) : console.error(m, e)));
  const ms = d.stepTimeoutMs ?? 5000;
  let http: Promise<void> = Promise.resolve();
  try { http = d.closeHttp(); } catch (e) { log('[cloud9] shutdown: http close failed', e); }
  try { d.shutdownGame(); } catch (e) { log('[cloud9] shutdown: game shutdown failed', e); }
  if (d.stopTelegram) {
    let tg: Promise<void> = Promise.resolve();
    try { tg = d.stopTelegram(); } catch (e) { log('[cloud9] shutdown: telegram stop failed', e); }
    await bounded(tg, ms, 'telegram stop', log);
  }
  await bounded(http, ms, 'http close', log);
  try { d.closeRepo(); } catch (e) { log('[cloud9] shutdown: repo close failed', e); }
}
