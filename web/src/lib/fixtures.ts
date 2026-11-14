// Dev-only fixture gate (#14). `?fixture=<name>` renders fake screens for design review,
// but only under the `vite` dev server: `import.meta.env.DEV` is the constant `false` in
// `vite build`, so the dynamic import below is dropped and no fixture code or data ships.
import type * as DevModule from '../dev';
import { query } from './router';

type DevFixtures = typeof DevModule;

let mod: DevFixtures | null = null;

const wanted: boolean = import.meta.env.DEV ? (() => { try { return !!query('fixture'); } catch { return false; } })() : false;

/** Resolves once the fixture module is loaded (at once when no fixture is requested, or in production). */
export const fixturesReady: Promise<void> = import.meta.env.DEV && wanted
  ? import('../dev').then((m) => { mod = m; }, (e) => { console.error('[fixture] failed to load', e); })
  : Promise.resolve();

/** True while a requested dev fixture module is still loading (never in production). */
export const fixturesPending = (): boolean => import.meta.env.DEV && wanted && !mod;

/** The fixture module in dev when ?fixture= is set and loaded; always null in production. */
export function devFx(): DevFixtures | null {
  return import.meta.env.DEV ? mod : null;
}

/** Active ?fixture= name in dev (once loaded); always null in production. */
export function fixtureName(): string | null {
  if (!import.meta.env.DEV || !mod) return null;
  try { return query('fixture'); } catch { return null; }
}
