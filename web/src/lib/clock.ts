// Server clock estimate from ping/pong round trips (#20). Pure, so it can be unit-tested.
// offset = serverNow + rtt/2 - receivedAt, taken from the lowest-RTT sample of the last few pongs:
// the fastest round trip has the least queueing delay, so it is the most accurate, and a single
// latency spike can no longer shift the countdown.

export interface ClockSample { offset: number; rtt: number }

export class ClockSync {
  private samples: ClockSample[] = [];
  private fallback: number | null = null;

  constructor(private readonly window = 5) {}

  /** A pong for a ping sent at `sentAt` (local ms), received at `receivedAt` (local ms). */
  addPong(serverNow: number, sentAt: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt;
    if (!Number.isFinite(serverNow) || !(rtt >= 0) || rtt > 30_000) return;
    this.samples.push({ offset: serverNow + rtt / 2 - receivedAt, rtt });
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** A server timestamp with unknown latency (e.g. a state snapshot); only used until a pong arrives. */
  addUntimed(serverNow: number, receivedAt: number): void {
    if (Number.isFinite(serverNow)) this.fallback = serverNow - receivedAt;
  }

  /** Forget round-trip samples (new socket / network) but keep the last offset until a new pong. */
  resetRtt(): void {
    const best = this.best();
    if (best) this.fallback = best.offset;
    this.samples = [];
  }

  best(): ClockSample | null {
    let b: ClockSample | null = null;
    for (const s of this.samples) if (!b || s.rtt < b.rtt) b = s;
    return b;
  }

  /** Estimated serverTime - localTime, in ms. */
  offset(): number {
    const b = this.best();
    return b ? b.offset : this.fallback ?? 0;
  }
}
