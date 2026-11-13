import { useEffect, useState } from 'preact/hooks';
import type { Me, CreateSessionReq } from '../../../../shared/api';
import type { QuizListItem, SessionSummary } from '../../../../shared/model';
import { navigate } from '../../lib/router';
import { load, mutate, errMsg, ModHeader, Chip, Link, stateChip, relTime, fmtNum, fixture } from './common';

export function Dashboard(props: { me: Me; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessErr, setSessErr] = useState<string | null>(null);
  const [quizzes, setQuizzes] = useState<QuizListItem[] | null>(null);
  const [quizErr, setQuizErr] = useState<string | null>(null);
  const [startFor, setStartFor] = useState<string | null>(null);

  const loadSessions = () =>
    load<SessionSummary[]>('/api/sessions').then((s) => { setSessions(s); setSessErr(null); }).catch((e) => setSessErr(errMsg(e)));
  const loadQuizzes = () =>
    load<QuizListItem[]>('/api/quizzes').then((q) => { setQuizzes(q); setQuizErr(null); }).catch((e) => setQuizErr(errMsg(e)));

  useEffect(() => {
    loadSessions(); loadQuizzes();
    if (fixture) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') loadSessions(); }, 5000);
    return () => clearInterval(id);
  }, []);

  const live = (sessions ?? []).filter((s) => s.state !== 'FINISHED');
  const past = (sessions ?? []).filter((s) => s.state === 'FINISHED');

  const remove = async (q: QuizListItem) => {
    if (!confirm(`Delete “${q.title}”? This can't be undone. Results of past sessions stay downloadable.`)) return;
    try { await mutate('DELETE', `/api/quizzes/${q.id}`); setQuizzes((l) => (l ?? []).filter((x) => x.id !== q.id)); }
    catch (e) { alert(errMsg(e)); }
  };

  return (
    <div class="c9-page">
      <ModHeader me={props.me} onLogout={props.onLogout} />
      <main class="c9-m-main c9-m-dash">
        <div class="c9-m-pagehead">
          <h1 class="c9-m-h1">Your rooms</h1>
          <p class="c9-muted">Start a session from a quiz, then open its control panel to run the game.</p>
        </div>

        <section class="c9-m-section" aria-labelledby="live-h">
          <div class="c9-m-section__head">
            <h2 id="live-h" class="c9-m-h4">Live sessions</h2>
            {sessions && <span class="c9-muted c9-m-small">{live.length} active · refreshes every 5 s</span>}
          </div>
          {sessErr && <div class="yy-callout" role="alert">Couldn't load sessions: {sessErr}</div>}
          {!sessions && !sessErr && <div class="c9-m-skel" />}
          {sessions && live.length === 0 && (
            <div class="yy-empty">No live sessions. Pick a quiz below and press <strong>Start session</strong>.</div>
          )}
          {live.length > 0 && (
            <ul class="c9-m-list">
              {live.map((s) => <SessionRow key={s.id} s={s} />)}
            </ul>
          )}
          {past.length > 0 && (
            <details class="c9-m-past">
              <summary>Past sessions ({past.length})</summary>
              <ul class="c9-m-list c9-m-list--past">
                {past.map((s) => (
                  <li key={s.id} class="c9-m-row">
                    <div class="c9-m-row__main">
                      <div class="c9-m-row__title">{s.title}</div>
                      <div class="c9-m-row__meta">
                        {s.label && <span>{s.label}</span>}
                        <span class="c9-mono">{s.code}</span>
                        <span>{fmtNum(s.players)} players</span>
                        <span>{relTime(s.endedAt ?? s.createdAt)}</span>
                      </div>
                    </div>
                    <div class="c9-m-row__actions">
                      <a class="yy-btn yy-btn--secondary yy-btn--sm" href={`/api/sessions/${s.code}/export.csv`} download>Export CSV</a>
                      <Link class="yy-btn yy-btn--quiet yy-btn--sm" href={`/mod/room/${s.code}`}>View</Link>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section class="c9-m-section" aria-labelledby="quiz-h">
          <div class="c9-m-section__head">
            <h2 id="quiz-h" class="c9-m-h4">Your quizzes</h2>
            <div class="c9-m-section__btns">
              <Link class="yy-btn yy-btn--secondary yy-btn--sm" href="/mod/import">Import CSV</Link>
              <Link class="yy-btn yy-btn--secondary yy-btn--sm" href="/mod/quiz/new">+ New quiz</Link>
            </div>
          </div>
          {quizErr && <div class="yy-callout" role="alert">Couldn't load quizzes: {quizErr}</div>}
          {!quizzes && !quizErr && <div class="c9-m-skel" />}
          {quizzes && quizzes.length === 0 && (
            <div class="yy-empty">No quizzes yet. Create one with <strong>New quiz</strong> or bring a spreadsheet in with <strong>Import CSV</strong>.</div>
          )}
          {quizzes && quizzes.length > 0 && (
            <ul class="c9-m-list">
              {quizzes.map((q) => (
                <li key={q.id} class="c9-m-row c9-m-row--quiz">
                  <div class="c9-m-row__main">
                    <div class="c9-m-row__title">{q.title}</div>
                    <div class="c9-m-row__meta">
                      <span>{q.questionCount} question{q.questionCount === 1 ? '' : 's'}</span>
                      <span>Edited {relTime(q.updatedAt)}</span>
                    </div>
                  </div>
                  <div class="c9-m-row__actions">
                    <button class="yy-btn yy-btn--danger-quiet yy-btn--sm" onClick={() => remove(q)}>Delete</button>
                    <Link class="yy-btn yy-btn--quiet yy-btn--sm" href={`/mod/quiz/${q.id}`}>Edit</Link>
                    <button class="yy-btn yy-btn--secondary yy-btn--sm" aria-expanded={startFor === q.id}
                      onClick={() => setStartFor(startFor === q.id ? null : q.id)}>Start session</button>
                  </div>
                  {startFor === q.id && <StartForm quiz={q} onCancel={() => setStartFor(null)} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function SessionRow({ s }: { s: SessionSummary }) {
  const chip = stateChip(s.state, s.qIndex, s.total);
  return (
    <li class="c9-m-row c9-m-row--live">
      <div class="c9-m-row__code c9-mono" aria-label={`Code ${s.code}`}>{s.code}</div>
      <div class="c9-m-row__main">
        <div class="c9-m-row__title">{s.title}</div>
        <div class="c9-m-row__meta">
          {s.label && <span>{s.label}</span>}
          <span><strong>{fmtNum(s.players)}</strong> players</span>
        </div>
      </div>
      <div class="c9-m-row__chips">
        <Chip tone={chip.tone}>{chip.text}</Chip>
        <Chip tone={s.listed ? 'accent' : 'neutral'} title={s.listed ? 'Shown on the public home page' : 'Join by code or QR only'}>
          {s.listed ? 'Listed' : 'Hidden'}
        </Chip>
        {!s.joinOpen && <Chip tone="neutral">Joining closed</Chip>}
      </div>
      <div class="c9-m-row__actions">
        <Link class="yy-btn yy-btn--primary yy-btn--sm" href={`/mod/room/${s.code}`}>Open</Link>
      </div>
    </li>
  );
}

function StartForm({ quiz, onCancel }: { quiz: QuizListItem; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [listed, setListed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body: CreateSessionReq = { quizId: quiz.id, label: label.trim(), listed };
      const s = await mutate<SessionSummary>('POST', '/api/sessions', body);
      navigate(`/mod/room/${s.code ?? '482913'}`);
    } catch (e2) { setErr(errMsg(e2)); setBusy(false); }
  };

  return (
    <form class="c9-m-startform" onSubmit={submit}>
      <div class="yy-field c9-m-startform__label">
        <label class="yy-label" for={`lbl-${quiz.id}`}>Label <span class="yy-optional">Optional</span></label>
        <input id={`lbl-${quiz.id}`} class="yy-input" placeholder="e.g. Hall A · Round 1" maxLength={60} value={label}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)} autoFocus />
      </div>
      <label class="c9-m-check">
        <input type="checkbox" checked={listed} onChange={(e) => setListed((e.target as HTMLInputElement).checked)} />
        <span>Show on home page</span>
      </label>
      <div class="c9-m-startform__actions">
        <button type="button" class="yy-btn yy-btn--quiet" onClick={onCancel}>Cancel</button>
        <button type="submit" class="yy-btn yy-btn--primary" disabled={busy}>{busy ? 'Starting…' : 'Start session'}</button>
      </div>
      {err && <p class="yy-help yy-help--error" role="alert">{err}</p>}
    </form>
  );
}
