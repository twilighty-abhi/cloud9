// Read-only results for a room that is no longer held in memory (finished > 6 h ago, or the server restarted).
// Shown by Room when the live connection says "not_found"; data comes from GET /api/sessions/:code/summary.
import { useEffect, useState } from 'preact/hooks';
import type { SessionResult } from '../../../../shared/api';
import { HttpError } from '../../lib/api';
import { load, errMsg, Link, Logo, Chip, fmtNum, relTime } from './common';

type St = { kind: 'loading' } | { kind: 'ok'; r: SessionResult } | { kind: 'missing' } | { kind: 'denied' } | { kind: 'error'; message: string };

export function RoomSaved(props: { code: string }) {
  const [st, setSt] = useState<St>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    load<SessionResult>(`/api/sessions/${props.code}/summary`)
      .then((r) => { if (alive) setSt(r && r.code ? { kind: 'ok', r } : { kind: 'missing' }); })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 404) setSt({ kind: 'missing' });
        else if (e instanceof HttpError && (e.status === 401 || e.status === 403)) setSt({ kind: 'denied' });
        else setSt({ kind: 'error', message: errMsg(e) });
      });
    return () => { alive = false; };
  }, [props.code]);

  if (st.kind === 'loading') {
    return (
      <div class="c9-m-center">
        <div class="c9-stack" style={{ alignItems: 'center' }}>
          <div class="c9-m-spinner" aria-hidden="true" />
          <p class="c9-muted">Loading saved results…</p>
        </div>
      </div>
    );
  }
  if (st.kind === 'missing') return <Notice title="This room doesn't exist" body={`There's no room with code ${props.code}.`} />;
  if (st.kind === 'denied') return <Notice title="You don't have access to this room" body="It belongs to another moderator, or your sign-in expired. Sign in again from the dashboard." />;
  if (st.kind === 'error') return <Notice title="Couldn't load this room" body={st.message} />;

  const r = st.r;
  const finished = r.state === 'FINISHED';
  const csv = `/api/sessions/${r.code}/export.csv`;
  return (
    <div class="c9-page c9-m-roompage">
      <header class="c9-header c9-m-header c9-m-roomhead">
        <Logo />
        <Link href="/mod" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-hide-sm">← Dashboard</Link>
        <div class="c9-m-roomhead__title">
          {r.eventName && (r.eventId
            ? <><Link href={`/mod/event/${r.eventId}`} class="c9-m-crumb" title="Open the event page">{r.eventName}</Link><span class="c9-muted c9-m-crumbsep"> / </span></>
            : <><span class="c9-m-crumb">{r.eventName}</span><span class="c9-muted c9-m-crumbsep"> / </span></>)}
          <strong>{r.title}</strong>
          {r.label && <span class="c9-muted"> · {r.label}</span>}
        </div>
        <span class="c9-spacer" />
      </header>

      <div class="c9-m-room">
        <main class="c9-m-room__main">
          <section class="yy-card c9-m-stage" aria-labelledby="saved-h">
            <div class="c9-m-stage__head">
              <div>
                <h2 id="saved-h" class="c9-m-stage__title">{finished ? 'Finished' : 'No longer live'}</h2>
                <Chip tone="neutral">{finished ? 'Final results · read-only' : 'Saved results · read-only'}</Chip>
              </div>
            </div>
            {r.leaderboard.length ? (
              <ol class={`c9-m-lb ${finished ? 'is-podium' : ''}`}>
                {r.leaderboard.map((e) => (
                  <li key={e.rank} class={`c9-m-lb__row ${e.rank <= 3 ? `is-top is-r${e.rank}` : ''}`}>
                    <span class="c9-m-lb__rank">{e.rank}</span>
                    <span class="c9-m-lb__name">{e.name}</span>
                    <span class="c9-m-lb__score">{fmtNum(e.score)}</span>
                  </li>
                ))}
              </ol>
            ) : <div class="yy-empty">No scores were recorded in this room.</div>}
            <p class="c9-muted c9-m-small">
              {finished
                ? 'This room has been cleared from the live server, so it can no longer be controlled. '
                : 'This room stopped before the quiz finished (for example after a server restart) and can no longer be controlled. '}
              {r.players > r.leaderboard.length && r.leaderboard.length > 0 ? `Showing the top ${r.leaderboard.length}. ` : ''}Download the CSV for every player's name, email, score and per-question answers.
            </p>
          </section>
        </main>
        <aside class="c9-m-room__side">
          <section class="yy-card c9-stack" aria-label="Session details">
            <div><div class="c9-overline">Code</div><div class="c9-mono">{r.code}</div></div>
            <div><div class="c9-overline">Players</div><div>{fmtNum(r.players)}</div></div>
            <div><div class="c9-overline">Questions</div><div>{r.total}</div></div>
            <div><div class="c9-overline">{r.endedAt ? 'Ended' : 'Started'}</div><div>{relTime(r.endedAt ?? r.createdAt)}</div></div>
            {r.eventId && <Link href={`/mod/event/${r.eventId}#lb`} class="yy-btn yy-btn--quiet yy-btn--sm">Event leaderboard →</Link>}
          </section>
        </aside>
      </div>

      <div class="c9-m-actionbar">
        <div class="c9-m-actionbar__in">
          <div class="c9-m-actionbar__status">
            <span class="c9-muted">{finished ? 'Quiz finished' : 'Not live'} · {fmtNum(r.players)} player{r.players === 1 ? '' : 's'}</span>
          </div>
          <Link href="/mod" class="yy-btn yy-btn--secondary yy-btn--lg">Dashboard</Link>
          <a class="yy-btn yy-btn--primary yy-btn--lg c9-m-primary" href={csv} download>Download results CSV</a>
        </div>
      </div>
    </div>
  );
}

function Notice(props: { title: string; body: string }) {
  return (
    <div class="c9-m-center">
      <div class="c9-m-authcard yy-card yy-card--raised c9-stack">
        <Logo />
        <h1 class="c9-m-h1">{props.title}</h1>
        <p class="c9-muted">{props.body}</p>
        <Link href="/mod" class="yy-btn yy-btn--primary">Back to dashboard</Link>
      </div>
    </div>
  );
}
