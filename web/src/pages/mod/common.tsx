// Shared bits for the moderator + present UIs (owned by agent D).
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { RoomState, EventListItem, EmailMode } from '../../../../shared/model';
import { get, api, HttpError } from '../../lib/api';
import { query, linkClick, confirmLeave } from '../../lib/router';
import { fixtureGet, fakeQr, fxMe, fixtureParam } from '../../dev/modFixtures';
import { Brand } from '../../lib/brand';

export const fxMeOr = () => fxMe;

/** Active dev fixture name (?fixture=…) or null. */
export const fixture: string | null = (() => { try { return query('fixture'); } catch { return null; } })();

/** Read a query param (fixture mode can fake some). */
export function param(name: string): string | null {
  if (fixture) return fixtureParam(fixture, name);
  try { return query(name); } catch { return null; }
}

/** Copy text to the clipboard, with a textarea fallback for older/insecure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* */ }
    ta.remove();
    return ok;
  }
}

/** Map API error codes that need friendlier wording. */
export function apiErrMsg(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.code === 'invalid_event') return 'That event no longer exists. Pick another event (or None) and save again.';
    if (e.status === 403) return "You don't have permission to do that — only the event's creator or a super moderator can.";
  }
  return errMsg(e);
}

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
    if (!confirmLeave()) return; // e.g. unsaved quiz edits
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

/** All events (for pickers). null while loading. */
export function useEvents(): { events: EventListItem[] | null; error: string | null } {
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { load<EventListItem[]>('/api/events').then((e) => setEvents(e ?? [])).catch((e) => { setEvents([]); setError(errMsg(e)); }); }, []);
  return { events, error };
}

/** "Event" select used by the quiz editor and import. */
export function EventSelect(props: { value: string | null; onChange: (id: string | null) => void; events: EventListItem[] | null; error?: string | null }) {
  const { value, events } = props;
  const missing = !!value && !!events && !events.some((e) => e.id === value);
  const ev = value && events ? events.find((e) => e.id === value) : undefined;
  return (
    <div class="yy-field c9-m-evselect">
      <label class="yy-label" for="ev-sel">Event</label>
      <select id="ev-sel" class="yy-input" value={value ?? ''} disabled={!events}
        onChange={(e) => props.onChange((e.target as HTMLSelectElement).value || null)}>
        <option value="">{events ? 'None — standalone quiz' : 'Loading events…'}</option>
        {missing && <option value={value!}>Unknown event (deleted?) — pick another</option>}
        {(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <span class={`yy-help ${missing || props.error ? 'yy-help--error' : ''}`}>
        {props.error ? `Couldn't load events: ${props.error}`
          : missing ? "This event wasn't found. Choose another one or None."
          : ev ? `Scores count toward the “${ev.name}” leaderboard. Other moderators in the event can see and run this quiz.`
          : 'Attach the quiz to an event to add its scores to that event\'s overall leaderboard.'}
      </span>
    </div>
  );
}

/** Email-mode segmented control; locked to "Required" when the chosen event requires email. */
export function EmailModeField(props: { value: EmailMode; onChange: (m: EmailMode) => void; locked: boolean; labelId: string }) {
  const shown = props.locked ? 'required' : props.value;
  return (
    <div class="yy-field">
      <span class="yy-label" id={props.labelId}>Ask players for email</span>
      <div class={`yy-seg ${props.locked ? 'c9-m-seg--locked' : ''}`} role="tablist" aria-labelledby={props.labelId} aria-disabled={props.locked}>
        {(['off', 'optional', 'required'] as EmailMode[]).map((m) => (
          <button type="button" role="tab" aria-selected={shown === m} disabled={props.locked} onClick={() => props.onChange(m)}>
            {m === 'off' ? 'Off' : m === 'optional' ? 'Optional' : 'Required'}
          </button>
        ))}
      </div>
      {props.locked && <span class="yy-help c9-m-locknote">Email is required for all quizzes in this event</span>}
    </div>
  );
}
