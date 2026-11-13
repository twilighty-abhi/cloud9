// Dev-only projector fixtures for EVENT cases (owned by the player/present agent; base snapshots come from modFixtures).
// /present/482913?fixture=present-leaderboard-event | present-finished-event
// /present/event/ev1?fixture=event-board | event-empty | event-404
import type { HostSnapshot } from '../../../shared/protocol';
import type { PublicEventBoard } from '../../../shared/api';
import type { BoardTop } from '../../../shared/model';
import { hostFixture } from './modFixtures';

const EVENT = 'CCD Kochi 2026';
const EV_NAMES = ['Meera', 'Rahul K', 'Fathima Nasrin Abdul Rahiman', 'Arjun', 'Sneha', 'Vishnu Prasad', 'Aditi', 'Nikhil', 'Sana', 'Kiran'];

const evTop = (n: number): BoardTop[] => EV_NAMES.slice(0, n).map((name, i) => ({ name, score: 9640 - i * 610 - ((i * 37) % 90), rank: i + 1 }));

/** HostSnapshot for present event fixtures, or null to fall back to modFixtures.hostFixture. */
export function presentFixture(name: string): HostSnapshot | null {
  const m = /^present-(leaderboard|finished)-event$/.exec(name);
  if (!m) return null;
  const base = hostFixture(`present-${m[1]}`);
  if (!base) return null;
  return { ...base, eventName: EVENT, eventBoard: { eventName: EVENT, top: evTop(10), total: 186 } };
}

/** Fake GET /api/public/events/:id/leaderboard. 'event-404' → throws 404. */
export function eventBoardFixture(name: string): PublicEventBoard | 'not_found' | null {
  if (name === 'event-404') return 'not_found';
  if (name === 'event-empty') return { eventName: EVENT, top: [], total: 0, updatedAt: Date.now() - 3000 };
  if (name !== 'event-board') return null;
  return {
    eventName: EVENT, total: 186, updatedAt: Date.now() - 3000,
    top: evTop(10).map((e, i) => ({ ...e, quizzesPlayed: 4 - (i % 3) })),
  };
}
