// Unit tests for the player/projector clock offset (web/src/lib/clock.ts, #20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../../web/src/lib/clock';

test('clock: offset compensates half the round trip', () => {
  const c = new ClockSync();
  // server is 10 000 ms ahead; 400 ms RTT, server stamped the pong mid-way
  const sentAt = 1_000_000, receivedAt = sentAt + 400;
  c.addPong(sentAt + 200 + 10_000, sentAt, receivedAt);
  assert.equal(c.offset(), 10_000);
});

test('clock: keeps the lowest-RTT sample, so a latency spike does not move the offset', () => {
  const c = new ClockSync();
  const truth = 5_000;
  const pong = (sentAt: number, upMs: number, downMs: number) => c.addPong(sentAt + upMs + truth, sentAt, sentAt + upMs + downMs);
  pong(0, 40, 40);          // fast, symmetric: exact
  assert.equal(c.offset(), truth);
  pong(20_000, 1500, 100);  // spike, asymmetric: would be off by 700 ms
  assert.equal(c.offset(), truth);
  pong(40_000, 60, 60);
  assert.equal(c.offset(), truth);
});

test('clock: old samples age out of the window', () => {
  const c = new ClockSync(2);
  c.addPong(100 + 10 + 1000, 100, 120);   // rtt 20, offset 1000
  c.addPong(200 + 50 + 2000, 200, 300);   // rtt 100, offset 2000
  c.addPong(300 + 50 + 2000, 300, 400);   // rtt 100 → the rtt-20 sample is gone
  assert.equal(c.offset(), 2000);
});

test('clock: untimed snapshot time is only a fallback until a pong arrives', () => {
  const c = new ClockSync();
  assert.equal(c.offset(), 0);
  c.addUntimed(10_000, 9_000);
  assert.equal(c.offset(), 1000);
  c.addPong(50_000 + 100 + 3000, 50_000, 50_200);
  assert.equal(c.offset(), 3000);
  c.addUntimed(99_999, 0);                // later snapshots don't override the RTT sample
  assert.equal(c.offset(), 3000);
});

test('clock: resetRtt keeps the last estimate until a new pong, and bad samples are ignored', () => {
  const c = new ClockSync();
  c.addPong(1000 + 50 + 700, 1000, 1100);
  c.resetRtt();
  assert.equal(c.offset(), 700);
  c.addPong(NaN, 0, 10);
  c.addPong(5000, 100, 50);               // negative rtt
  c.addPong(5000, 0, 60_000);             // absurd rtt
  assert.equal(c.offset(), 700);
  assert.equal(c.best(), null);
});
