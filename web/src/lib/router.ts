// Tiny pushState router. Owned by lead.
import { useEffect, useState } from 'preact/hooks';

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  window.dispatchEvent(new Event('c9:navigate'));
  window.scrollTo(0, 0);
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
