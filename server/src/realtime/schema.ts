// Cloud 9 — inbound WebSocket message validation (zod).
import { z } from 'zod';
import type { ClientMsg } from '../../../shared/protocol';

const clientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('answer'), qIndex: z.number().int().min(0).max(100_000), choice: z.number().int().min(0).max(100) }),
  z.object({ t: z.literal('ping') }),
  z.object({
    t: z.literal('mod'),
    action: z.enum(['start', 'next', 'close', 'reveal', 'leaderboard', 'end']),
    expectQ: z.number().int().min(-1).max(100_000),
  }),
  z.object({ t: z.literal('kick'), playerId: z.string().min(1).max(100) }),
]);

/** Parses a raw frame into a ClientMsg, or null if invalid. Never throws. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = clientMsgSchema.safeParse(data);
  return r.success ? (r.data as ClientMsg) : null;
}
