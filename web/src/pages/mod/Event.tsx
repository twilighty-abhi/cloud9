// Moderator: one event — its quizzes (all moderators'), sessions and the cumulative leaderboard. Owned by agent D.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Me, EventDetail, EventInput } from '../../../../shared/api';
import type { EventDef, EventLeaderEntry, QuizListItem } from '../../../../shared/model';
import { navigate } from '../../lib/router';
import { load, mutate, errMsg, apiErrMsg, ModHeader, Chip, Link, Switch, relTime, fmtNum, fixture, copyText } from './common';
import { SessionRow, StartForm } from './Dashboard';

export function EventPage(props: { id: string; me: Me; onLogout: () => void }) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = () =>
    load<EventDetail>(`/api/events/${encodeURIComponent(props.id)}`).then((d) => { setDetail(d); setErr(null); }).catch((e) => setErr(errMsg(e)));

  useEffect(() => {
    reload();
    if (fixture) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 10_000);
    return () => clearInterval(t);
  }, [props.id]);

  useEffect(() => { if (detail) document.title = `${detail.event.name} · CCD Kochi Live Quiz`; }, [detail?.event.name]);

  useEffect(() => {
    if (detail && (fixture?.startsWith('event-leaderboard') || location.hash === '#lb')) requestAnimationFrame(() => document.getElementById('lb')?.scrollIntoView());
  }, [!!detail]);

  if (err && !detail) {
    return (
      <div class="c9-page">
        <ModHeader me={props.me} onLogout={props.onLogout} />
        <main class="c9-m-main">
          <Link href="/mod" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-back">← Dashboard</Link>
          <div class="yy-callout" role="alert">Couldn't open this event: {err}</div>
        </main>
      </div>
    );
  }
  if (!detail) {
    return <div class="c9-page"><ModHeader me={props.me} onLogout={props.onLogout} /><main class="c9-m-main"><div class="c9-m-skel" /><div class="c9-m-skel" /></main></div>;
  }

  const ev = detail.event;
  const canEdit = props.me.isSuper || ev.moderatorId === props.me.id;
  const live = detail.sessions.filter((s) => s.state !== 'FINISHED');
  const past = detail.sessions.filter((s) => s.state === 'FINISHED');
  const ownsSession = (modId: string) => props.me.isSuper || modId === props.me.id;

  return (
    <div class="c9-page">
      <ModHeader me={props.me} onLogout={props.onLogout} />
      <main class="c9-m-main c9-m-event">
        <Link href="/mod" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-back">← Dashboard</Link>
        <EventHead ev={ev} canEdit={canEdit} onSaved={(e) => setDetail((d) => (d ? { ...d, event: e } : d))} liveCount={live.length} />

        <section class="c9-m-section" aria-labelledby="evq-h">
          <div class="c9-m-section__head">
            <h2 id="evq-h" class="c9-m-h4">Quizzes in this event <span class="c9-m-count">{detail.quizzes.length}</span></h2>
            <div class="c9-m-section__btns">
              <Link class="yy-btn yy-btn--secondary yy-btn--sm" href={`/mod/import?event=${encodeURIComponent(ev.id)}`}><span class="c9-m-hide-sm">Import CSV into this event</span><span class="c9-m-show-sm">Import CSV</span></Link>
              <Link class="yy-btn yy-btn--secondary yy-btn--sm" href={`/mod/quiz/new?event=${encodeURIComponent(ev.id)}`}><span class="c9-m-hide-sm">+ New quiz in this event</span><span class="c9-m-show-sm">+ New quiz</span></Link>
            </div>
          </div>
          {detail.quizzes.length === 0 ? (
            <div class="yy-empty">No quizzes yet. Every hall moderator can add their quiz here — scores from all of them add up on the event leaderboard.</div>
          ) : (
            <ul class="c9-m-list">
              {detail.quizzes.map((q) => <QuizRow key={q.id} q={q} me={props.me} />)}
            </ul>
          )}
        </section>

        <section class="c9-m-section" aria-labelledby="evs-h">
          <div class="c9-m-section__head">
            <h2 id="evs-h" class="c9-m-h4">Sessions <span class="c9-m-count">{detail.sessions.length}</span></h2>
            <span class="c9-muted c9-m-small">{live.length} live</span>
          </div>
          {detail.sessions.length === 0 && <div class="yy-empty">No sessions yet. Start one from a quiz above.</div>}
          {live.length > 0 && (
            <ul class="c9-m-list">
              {live.map((s) => <SessionRow key={s.id} s={s} showEvent={false} canOpen={ownsSession(s.moderatorId)} />)}
            </ul>
          )}
          {past.length > 0 && (
            <ul class="c9-m-list c9-m-list--past">
              {past.map((s) => (
                <li key={s.id} class="c9-m-row">
                  <div class="c9-m-row__main">
                    <div class="c9-m-row__title">{s.title}</div>
                    <div class="c9-m-row__meta">
                      {s.label && <span>{s.label}</span>}
                      <span class="c9-mono">{s.code}</span>
                      <span>{fmtNum(s.players)} players</span>
                      <span>Ended {relTime(s.endedAt ?? s.createdAt)}</span>
                    </div>
                  </div>
                  <div class="c9-m-row__chips"><Chip tone="neutral">Finished</Chip></div>
                  <div class="c9-m-row__actions">
                    {ownsSession(s.moderatorId) ? (
                      <>
                        <a class="yy-btn yy-btn--secondary yy-btn--sm" href={`/api/sessions/${s.code}/export.csv`} download>Export CSV</a>
                        <Link class="yy-btn yy-btn--quiet yy-btn--sm" href={`/mod/room/${s.code}`}>View</Link>
                      </>
                    ) : <span class="c9-muted c9-m-small">Another moderator's session</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <EventLeaderboard ev={ev} me={props.me} />
      </main>
    </div>
  );
}

// ───────────────────────── header ─────────────────────────

function EventHead({ ev, canEdit, onSaved, liveCount }: { ev: EventDef; canEdit: boolean; onSaved: (e: EventDef) => void; liveCount: number }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(ev.name);
  const [emailReq, setEmailReq] = useState(ev.emailRequired);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (!renaming) setName(ev.name); setEmailReq(ev.emailRequired); }, [ev.name, ev.emailRequired]);

  const put = async (body: EventInput) => {
    setBusy(true); setErr(null);
    try {
      const saved = await mutate<EventDef>('PUT', `/api/events/${encodeURIComponent(ev.id)}`, body);
      onSaved(saved && saved.id ? saved : { ...ev, ...body, emailRequired: body.emailRequired ?? ev.emailRequired, updatedAt: Date.now() });
      return true;
    } catch (e) { setErr(apiErrMsg(e)); return false; }
    finally { setBusy(false); }
  };

  const saveName = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setErr('The event needs a name.'); return; }
    if (n === ev.name) { setRenaming(false); return; }
    if (await put({ name: n, emailRequired: emailReq })) setRenaming(false);
  };

  const toggleEmail = async (v: boolean) => {
    setEmailReq(v);
    if (!(await put({ name: ev.name, emailRequired: v }))) setEmailReq(!v);
  };

  const remove = async () => {
    if (!confirm(`Delete the event “${ev.name}”?\n\nIts quizzes are kept — they become standalone quizzes of their moderators. Past sessions keep their results, but the combined event leaderboard goes away. Download the leaderboard CSV first if you need it.`)) return;
    try { await mutate('DELETE', `/api/events/${encodeURIComponent(ev.id)}`); navigate('/mod'); }
    catch (e) { setErr(apiErrMsg(e)); }
  };

  return (
    <div class="c9-m-evhead">
      <div class="c9-m-evhead__main">
        <div class="c9-overline">Event</div>
        {renaming ? (
          <form class="c9-m-rename" onSubmit={saveName}>
            <input class="yy-input c9-m-rename__input" aria-label="Event name" maxLength={80} value={name} autoFocus
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setName(ev.name); setRenaming(false); } }} />
            <button type="submit" class="yy-btn yy-btn--primary yy-btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" class="yy-btn yy-btn--quiet yy-btn--sm" onClick={() => { setName(ev.name); setRenaming(false); }}>Cancel</button>
          </form>
        ) : (
          <div class="c9-m-evhead__title">
            <h1 class="c9-m-h1">{ev.name}</h1>
            {canEdit && <button class="yy-btn yy-btn--quiet yy-btn--sm" onClick={() => setRenaming(true)}>Rename</button>}
          </div>
        )}
        <div class="c9-m-row__chips">
          {liveCount > 0 ? <Chip tone="success"><span class="c9-m-dot is-on" /> {liveCount} live</Chip> : <Chip tone="neutral">No live rooms</Chip>}
          {!canEdit && (ev.emailRequired
            ? <Chip tone="accent">Email required</Chip>
            : <Chip tone="neutral">Email per quiz</Chip>)}
          {!canEdit && <Chip tone="neutral" title="Only the creator or a super moderator can change this event">Created by another moderator · view only</Chip>}
          <a href="#lb" class="c9-m-jump" onClick={(e) => { e.preventDefault(); document.getElementById('lb')?.scrollIntoView({ behavior: 'smooth' }); }}>Event leaderboard ↓</a>
        </div>
      </div>
      {canEdit && (
        <div class="yy-card c9-m-evhead__settings">
          <Switch label="Require email" checked={emailReq} disabled={busy} onChange={toggleEmail}
            hint={emailReq ? 'Every quiz in this event asks for email — scores add up per player' : 'Each quiz decides; players without email are ranked per session'} />
          <button class="yy-btn yy-btn--danger-quiet yy-btn--sm c9-m-evhead__del" onClick={remove}>Delete event</button>
        </div>
      )}
      {err && <p class="yy-help yy-help--error c9-m-evhead__err" role="alert">{err}</p>}
    </div>
  );
}

// ───────────────────────── quizzes ─────────────────────────

function QuizRow({ q, me }: { q: QuizListItem; me: Me }) {
  const [start, setStart] = useState(false);
  const mine = q.moderatorId === me.id;
  const canEdit = mine || me.isSuper;
  return (
    <li class="c9-m-row c9-m-row--quiz">
      <div class="c9-m-row__main">
        <div class="c9-m-row__title">{q.title}</div>
        <div class="c9-m-row__meta">
          <span>{q.questionCount} question{q.questionCount === 1 ? '' : 's'}</span>
          <span>Edited {relTime(q.updatedAt)}</span>
        </div>
      </div>
      {!mine && <div class="c9-m-row__chips"><Chip tone="neutral" title="Added by another moderator">Another moderator</Chip></div>}
      <div class="c9-m-row__actions">
        {canEdit && <Link class="yy-btn yy-btn--quiet yy-btn--sm" href={`/mod/quiz/${q.id}`}>Edit</Link>}
        <button class="yy-btn yy-btn--secondary yy-btn--sm" aria-expanded={start} onClick={() => setStart(!start)}>Start session</button>
      </div>
      {start && <StartForm quiz={q} onCancel={() => setStart(false)} />}
    </li>
  );
}

// ───────────────────────── leaderboard ─────────────────────────

function EventLeaderboard({ ev, me }: { ev: EventDef; me: Me }) {
  // Emails + the event CSV are super-moderator only (the server also enforces this).
  const showEmail = me.isSuper;
  const [rows, setRows] = useState<EventLeaderEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    const go = () => load<EventLeaderEntry[]>(`/api/events/${encodeURIComponent(ev.id)}/leaderboard`)
      .then((r) => { if (alive) { setRows(r ?? []); setErr(null); setAt(Date.now()); } })
      .catch((e) => { if (alive) setErr(errMsg(e)); });
    go();
    if (fixture) return () => { alive = false; };
    const t = setInterval(() => { if (document.visibilityState === 'visible') go(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [ev.id]);

  const copy = async (email: string) => {
    await copyText(email);
    setCopied(email); clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1800);
  };

  const f = filter.trim().toLowerCase();
  const list = (rows ?? []).filter((r) => !f || r.name.toLowerCase().includes(f) || (r.email ?? '').includes(f));
  const leader = rows && rows.length ? rows[0] : null;

  return (
    <section class="c9-m-section" aria-labelledby="lb-h" id="lb">
      <div class="c9-m-section__head">
        <h2 id="lb-h" class="c9-m-h4">Event leaderboard {rows && <span class="c9-m-count">{fmtNum(rows.length)} player{rows.length === 1 ? '' : 's'}</span>}</h2>
        <div class="c9-m-section__btns">
          <a class="yy-btn yy-btn--secondary yy-btn--sm" href={`/present/event/${encodeURIComponent(ev.id)}`} target="_blank" rel="noopener">
            <span class="c9-m-hide-sm">Open on projector</span><span class="c9-m-show-sm">Projector</span> ↗
          </a>
          {showEmail && <a class="yy-btn yy-btn--primary yy-btn--sm" href={`/api/events/${encodeURIComponent(ev.id)}/export.csv`} download>Download CSV</a>}
        </div>
      </div>
      <p class="c9-muted c9-m-small c9-m-lbnote">
        Scores add up across every quiz in this event{ev.emailRequired ? ', matched by email' : ' for players who gave the same email; others are ranked per session'}.
        {' '}{showEmail ? 'Click an email to copy it. ' : 'Emails and the CSV download are only available to the super moderator. '}{at && <>Refreshes every 5 s · updated {new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>}
      </p>
      {err && <div class="yy-callout" role="alert">Couldn't load the leaderboard: {err}{rows ? ' — showing the last copy.' : ''}</div>}
      {!rows && !err && <div class="c9-m-skel" />}
      {rows && rows.length === 0 && <div class="yy-empty">No scores yet. Standings appear here as soon as the first session in this event scores points.</div>}

      {leader && (
        <div class="c9-m-winner">
          <span class="c9-m-winner__rank" aria-hidden="true">1</span>
          <div class="c9-m-winner__main">
            <div class="c9-overline">Current overall leader</div>
            <div class="c9-m-winner__name">{leader.name}</div>
            {!showEmail ? null : leader.email
              ? <button class="c9-m-email c9-m-email--lg" onClick={() => copy(leader.email!)} title="Copy email"><EmailText email={leader.email} /><CopyTag on={copied === leader.email} /></button>
              : <span class="c9-muted">No email given</span>}
          </div>
          <div class="c9-m-winner__score"><strong>{fmtNum(leader.score)}</strong><span class="c9-muted c9-m-small">{leader.quizzesPlayed} quiz{leader.quizzesPlayed === 1 ? '' : 'zes'}</span></div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          {rows.length > 10 && (
            <input class="yy-input c9-m-lbfilter" type="search" placeholder={showEmail ? 'Find by name or email…' : 'Find by name…'} aria-label="Find a player" value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          )}
          <div class="c9-m-evlb-wrap">
            <table class="c9-m-evlb">
              <thead>
                <tr>
                  <th class="c9-m-evlb__rank" scope="col">#</th>
                  <th scope="col">Name</th>
                  {showEmail && <th scope="col" class="c9-m-evlb__emailcol">Email</th>}
                  <th scope="col" class="c9-m-evlb__num c9-m-evlb__qcol"><span class="c9-m-hide-sm">Quizzes</span><span class="c9-m-show-sm" title="Quizzes played">Qz</span></th>
                  <th scope="col" class="c9-m-evlb__num">Score</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.key} class={r.rank <= 3 ? `is-top is-r${r.rank}` : ''}>
                    <td class="c9-m-evlb__rank"><span>{r.rank}</span></td>
                    <td class="c9-m-evlb__name">
                      <span class="c9-m-evlb__nm">{r.name}</span>
                      {showEmail && r.email && <button class="c9-m-email c9-m-evlb__emailsm" onClick={() => copy(r.email!)} title="Copy email"><EmailText email={r.email} /><CopyTag on={copied === r.email} /></button>}
                    </td>
                    {showEmail && (
                      <td class="c9-m-evlb__emailcol">
                        {r.email
                          ? <button class="c9-m-email" onClick={() => copy(r.email!)} title="Copy email"><EmailText email={r.email} /><CopyTag on={copied === r.email} /></button>
                          : <span class="c9-muted">—</span>}
                      </td>
                    )}
                    <td class="c9-m-evlb__num">{r.quizzesPlayed}</td>
                    <td class="c9-m-evlb__num c9-m-evlb__score">{fmtNum(r.score)}</td>
                  </tr>
                ))}
                {f && list.length === 0 && <tr><td colSpan={showEmail ? 5 : 4} class="c9-muted">No player matches “{filter}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function CopyTag({ on }: { on: boolean }) {
  return <span class={`c9-m-email__tag ${on ? 'is-on' : ''}`} aria-live="polite">{on ? 'Copied' : 'Copy'}</span>;
}

/** Email with a soft break after "@" so narrow screens wrap at a sensible point. */
function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@');
  if (at < 0) return <span class="c9-m-email__txt">{email}</span>;
  return <span class="c9-m-email__txt">{email.slice(0, at + 1)}<wbr />{email.slice(at + 1)}</span>;
}
