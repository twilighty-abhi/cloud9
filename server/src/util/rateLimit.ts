// In-memory sliding-window rate limiter (per key, e.g. IP). Agent B.

export interface RateLimiter {
  /** Records a hit; returns true if allowed, false if over the limit. */
  hit(key: string, now?: number): boolean;
  reset(): void;
  size(): number;
}

export function createRateLimiter(opts: { max: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const { max, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 50_000;
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function sweep(now: number) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, arr] of hits) {
      if (arr.length === 0 || arr[arr.length - 1] <= now - windowMs) hits.delete(k);
    }
  }

  return {
    hit(key, now = Date.now()) {
      sweep(now);
      let arr = hits.get(key);
      if (!arr) {
        if (hits.size >= maxKeys) hits.clear(); // memory safety valve
        arr = [];
        hits.set(key, arr);
      }
      const cutoff = now - windowMs;
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length >= max) return false;
      arr.push(now);
      return true;
    },
    reset() { hits.clear(); },
    size() { return hits.size; },
  };
}
