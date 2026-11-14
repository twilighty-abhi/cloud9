// Tiny pushState router. Owned by lead.
import { useEffect, useState } from 'preact/hooks';

/**
 * Navigation guards: a guard returns false to block leaving the current page
 * (e.g. the quiz editor with unsaved changes asks the user to confirm).
 * Consulted by navigate()/linkClick(), confirmLeave() and browser Back/Forward.
 */
type NavGuard = () => boolean;
const guards = new Set<NavGuard>();

/** Register a guard; returns the unregister function (handy as a useEffect cleanup). */
export function addNavGuard(g: NavGuard): () => void {
  guards.add(g);
  return () => { guards.delete(g); };
}

/** True when every guard allows leaving the current page. */
export function confirmLeave(): boolean {
  for (const g of [...guards]) if (!g()) return false;
  return true;
}

const here = () => location.pathname + location.search + location.hash;
let current = typeof location !== 'undefined' ? here() : '/';

// Browser Back/Forward: if a guard blocks, put the URL back and hide the event from usePath().
// Registered at module load, so it runs before any component's popstate listener.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (guards.size && !confirmLeave()) {
      e.stopImmediatePropagation();
      history.pushState(null, '', current);
      return;
    }
    current = here();
  });
}

/** Navigate in-app. Returns false if a navigation guard blocked it. */
export function navigate(to: string, replace = false): boolean {
  if (!confirmLeave()) return false;
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  current = here();
  window.dispatchEvent(new Event('c9:navigate'));
  window.scrollTo(0, 0);
  return true;
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    window.addEventListener('c9:navigate', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('c9:navigate', on); };
  }, []);
  return path;
}

/** match('/mod/room/:code', '/mod/room/123456') → { code: '123456' } | null */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

/** Use in onClick of <a href> to navigate without reload. */
export function linkClick(e: MouseEvent) {
  const a = (e.currentTarget as HTMLAnchorElement);
  if (e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  navigate(a.getAttribute('href') || '/');
}

export function query(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}
