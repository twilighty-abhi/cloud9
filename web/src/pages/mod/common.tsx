// Shared bits for the moderator + present UIs (owned by agent D).
import type { ComponentChildren } from 'preact';
import type { RoomState } from '../../../../shared/model';
import { get, api, HttpError } from '../../lib/api';
import { query, linkClick } from '../../lib/router';
import { fixtureGet, fakeQr, fxMe } from '../../dev/modFixtures';
import { Brand } from '../../lib/brand';

export const fxMeOr = () => fxMe;

/** Active dev fixture name (?fixture=…) or null. */
export const fixture: string | null = (() => { try { return query('fixture'); } catch { return null; } })();

/** GET that serves fixture data in fixture mode. */
export async function load<T>(url: string): Promise<T> {
  if (fixture) {
    try { return fixtureGet(fixture, url) as T; }
    catch (e) { const x = e as { status: number; code: string; message: string }; throw new HttpError(x.status, x.code, x.message); }
  }
  return get<T>(url);
}

/** Mutating call; in fixture mode it resolves without touching the network. */
export async function mutate<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  if (fixture) { console.info('[fixture]', method, url, body); return {} as T; }
  return api<T>(method, url, body ?? (method === 'DELETE' ? undefined : {}));
}

export const qrSrc = (code: string) => (fixture ? fakeQr() : `/api/sessions/${encodeURIComponent(code)}/qr.svg`);

export const LETTERS = ['A', 'B', 'C', 'D'];

export function stateChip(state: RoomState, qIndex: number, total: number): { text: string; tone: string } {
  switch (state) {
    case 'LOBBY': return { text: 'Waiting to start', tone: 'warning' };
    case 'QUESTION': return { text: `Live · Q${qIndex + 1} of ${total}`, tone: 'success' };
    case 'CLOSED': return { text: `Answers closed · Q${qIndex + 1}`, tone: 'success' };
    case 'REVEAL': return { text: `Revealed · Q${qIndex + 1}`, tone: 'success' };
    case 'LEADERBOARD': return { text: `Leaderboard · Q${qIndex + 1}`, tone: 'success' };
    case 'FINISHED': return { text: 'Finished', tone: 'neutral' };
  }
}

export function Chip(props: { tone?: string; children: ComponentChildren; title?: string }) {
  return <span class={`yy-chip yy-chip--${props.tone ?? 'neutral'}`} title={props.title}>{props.children}</span>;
}

export function Link(props: { href: string; class?: string; children: ComponentChildren; title?: string }) {
  return <a href={props.href} class={props.class} title={props.title} onClick={linkClick as any}>{props.children}</a>;
}

export function Logo() {
  return <a href="/mod" class="c9-logo" onClick={linkClick as any}><Brand app="Quiz · Moderator" /></a>;
}

/** Instant-setting switch: whole row clickable, label left, switch right. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={props.checked} class="c9-m-switch" disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}>
      <span class="c9-m-switch__text">
        <span class="c9-m-switch__label">{props.label}</span>
        {props.hint && <span class="c9-m-switch__hint">{props.hint}</span>}
      </span>
      <span class="c9-m-switch__track" aria-hidden="true"><span class="c9-m-switch__thumb" /></span>
    </button>
  );
}

export function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong. Try again.';
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  if (d < 2 * 86400_000) return 'yesterday';
  if (d < 7 * 86400_000) return `${Math.round(d / 86400_000)} days ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const fmtNum = (n: number) => n.toLocaleString('en-IN');

/** Top bar for dashboard/editor/import. */
export function ModHeader(props: { me: { displayName: string }; onLogout: () => void }) {
  const logout = async () => {
    try { await mutate('POST', '/api/auth/logout'); } catch { /* ignore */ }
    props.onLogout();
  };
  return (
    <header class="c9-header c9-m-header">
      <Logo />
      <span class="c9-m-header__who">Moderator · <strong>{props.me.displayName}</strong></span>
      <span class="c9-spacer" />
      <button class="yy-btn yy-btn--quiet yy-btn--sm" onClick={logout}>Log out</button>
    </header>
  );
}
