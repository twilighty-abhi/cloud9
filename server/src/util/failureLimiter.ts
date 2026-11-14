// Per-key failure budget (e.g. failed room-code lookups per IP). Fixed window: once a key records `max`
// failures inside `windowMs`, `blocked()` is true until that window ends. Successes are never counted,
// so normal play (valid codes) does not use up the budget.

export interface FailureLimiter {
  blocked(key: string, now?: number): boolean;
  fail(key: string, now?: number): void;
  reset(): void;
}

export function createFailureLimiter(opts: { max: number; windowMs: number; maxKeys?: number }): FailureLimiter {
  const { max, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 50_000;
  const m = new Map<string, { start: number; count: number }>();

  const sweep = (now: number) => {
    for (const [k, e] of m) if (now - e.start >= windowMs) m.delete(k);
    if (m.size >= maxKeys) m.clear(); // memory safety valve
  };

  return {
    blocked(key, now = Date.now()) {
      const e = m.get(key);
      if (!e) return false;
      if (now - e.start >= windowMs) { m.delete(key); return false; }
      return e.count >= max;
    },
    fail(key, now = Date.now()) {
      let e = m.get(key);
      if (!e || now - e.start >= windowMs) {
        if (!e && m.size >= maxKeys) sweep(now);
        e = { start: now, count: 0 };
        m.set(key, e);
      }
      e.count++;
    },
    reset() { m.clear(); },
  };
}
