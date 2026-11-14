import { useEffect, useRef, useState } from 'preact/hooks';
import type { Me, QuizInput } from '../../../../shared/api';
import type { QuizDef, EmailMode, ScoringMode } from '../../../../shared/model';
import { DEFAULTS } from '../../../../shared/model';
import { navigate, addNavGuard } from '../../lib/router';
import { load, mutate, errMsg, apiErrMsg, ModHeader, LETTERS, fixture, param, useEvents, EventSelect, EmailModeField } from './common';

interface QDraft { key: number; text: string; imageUrl: string; options: string[]; correctIndex: number; timeLimitSec: string; pointsMax: number }
interface Draft { eventId: string | null; title: string; emailMode: EmailMode; scoring: ScoringMode; questions: QDraft[] }

let keySeq = 1;
const blankQ = (): QDraft => ({ key: keySeq++, text: '', imageUrl: '', options: ['', '', '', ''], correctIndex: 0, timeLimitSec: String(DEFAULTS.timeLimitSec), pointsMax: DEFAULTS.pointsMax });
const fromQuiz = (q: QuizDef): Draft => ({
  eventId: q.eventId ?? null, title: q.title, emailMode: q.emailMode, scoring: q.scoring,
  questions: q.questions.map((x) => ({ key: keySeq++, text: x.text, imageUrl: x.imageUrl ?? '', options: [...x.options], correctIndex: x.correctIndex, timeLimitSec: String(x.timeLimitSec), pointsMax: x.pointsMax })),
});

function toInput(d: Draft): QuizInput {
  return {
    eventId: d.eventId, title: d.title.trim(), emailMode: d.emailMode, scoring: d.scoring,
    questions: d.questions.map((q) => {
      // drop empty options but keep the correct one pointing at the same text
      const kept = q.options.map((o, i) => ({ o: o.trim(), i })).filter((x) => x.o !== '');
      const ci = Math.max(0, kept.findIndex((x) => x.i === q.correctIndex));
      return { text: q.text.trim(), imageUrl: q.imageUrl.trim() || null, options: kept.map((x) => x.o), correctIndex: ci, timeLimitSec: Number(q.timeLimitSec) || DEFAULTS.timeLimitSec, pointsMax: q.pointsMax };
    }),
  };
}

function validate(d: Draft): string[] {
  const errs: string[] = [];
  if (!d.title.trim()) errs.push('Give the quiz a title.');
  if (d.questions.length === 0) errs.push('Add at least one question.');
  d.questions.forEach((q, i) => {
    const n = `Question ${i + 1}`;
    if (!q.text.trim()) errs.push(`${n}: write the question text.`);
    const filled = q.options.filter((o) => o.trim()).length;
    if (filled < 2) errs.push(`${n}: needs at least 2 answer options.`);
    if (!q.options[q.correctIndex]?.trim()) errs.push(`${n}: the option marked correct is empty.`);
    const t = Number(q.timeLimitSec);
    if (!Number.isFinite(t) || t < 5 || t > 300) errs.push(`${n}: time limit must be 5–300 seconds.`);
  });
  return errs;
}

export function QuizEditor(props: { id: string | null; me: Me; onLogout: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(props.id ? null : { eventId: param('event'), title: '', emailMode: 'optional', scoring: 'speed', questions: [blankQ()] });
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const { events, error: evErr } = useEvents();
  // where "back" goes: the event page when we came from one (or the quiz belongs to one), else the dashboard
  const [backTo, setBackTo] = useState<string | null>(props.id ? null : param('event'));
  const backHref = backTo ? `/mod/event/${encodeURIComponent(backTo)}` : '/mod';
  const evLocked = !!(draft?.eventId && events?.find((e) => e.id === draft.eventId)?.emailRequired);

  useEffect(() => {
    if (!props.id) return;
    load<QuizDef>(`/api/quizzes/${props.id}`).then((q) => { setDraft(fromQuiz(q)); setBackTo(q.eventId ?? null); }).catch((e) => setLoadErr(errMsg(e)));
  }, [props.id]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // In-app navigation (logo, Log out, any Link, browser Back) asks before discarding edits.
  useEffect(() => addNavGuard(() => {
    if (!dirtyRef.current) return true;
    if (!confirm('You have unsaved changes. Leave without saving?')) return false;
    dirtyRef.current = false; // don't ask twice for the same navigation
    return true;
  }), []);

  const update = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); setSaved(false); };
  const updQ = (i: number, patch: Partial<QDraft>) => update((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  const back = (e: MouseEvent) => {
    e.preventDefault();
    if (dirty && !confirm('You have unsaved changes. Leave without saving?')) return;
    setDirty(false); dirtyRef.current = false;
    navigate(backHref);
  };

  const save = async () => {
    if (!draft) return;
    const v = validate(draft);
    setErrors(v);
    if (v.length) { requestAnimationFrame(() => document.getElementById('c9-editor-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); return; }
    setBusy(true);
    try {
      const body = toInput(draft);
      const q = props.id ? await mutate<QuizDef>('PUT', `/api/quizzes/${props.id}`, body) : await mutate<QuizDef>('POST', '/api/quizzes', body);
      setDirty(false); dirtyRef.current = false; setSaved(true);
      if (!props.id && q?.id && !fixture) navigate(`/mod/quiz/${q.id}`, true);
      else if (q?.questions) setDraft(fromQuiz(q));
    } catch (e) { setErrors([apiErrMsg(e)]); }
    finally { setBusy(false); }
  };

  if (loadErr) {
    return (
      <div class="c9-page">
        <ModHeader me={props.me} onLogout={props.onLogout} />
        <main class="c9-m-main c9-m-form"><div class="yy-callout" role="alert">Couldn't open this quiz: {loadErr} <a href="/mod">Back to dashboard</a></div></main>
      </div>
    );
  }
  if (!draft) return <div class="c9-page"><ModHeader me={props.me} onLogout={props.onLogout} /><main class="c9-m-main c9-m-form c9-muted">Loading quiz…</main></div>;

  return (
    <div class="c9-page">
      <ModHeader me={props.me} onLogout={props.onLogout} />
      <main class="c9-m-main c9-m-form">
        <a href={backHref} class="yy-btn yy-btn--quiet yy-btn--sm c9-m-back" onClick={back as any}>← {backTo ? 'Event' : 'Dashboard'}</a>
        <div class="c9-m-pagehead">
          <h1 class="c9-m-h1">{props.id ? 'Edit quiz' : 'New quiz'}</h1>
          <p class="c9-muted">Changes apply to sessions you start after saving.</p>
        </div>

        <section class="yy-card c9-stack c9-m-settings">
          <div class="yy-field">
            <label class="yy-label" for="qt">Title</label>
            <input id="qt" class="yy-input" maxLength={120} placeholder="e.g. Cloud Basics Warm-up" value={draft.title}
              onInput={(e) => update((d) => ({ ...d, title: (e.target as HTMLInputElement).value }))} />
          </div>
          <EventSelect value={draft.eventId} events={events} error={evErr} onChange={(id) => update((d) => ({ ...d, eventId: id }))} />
          <div class="c9-m-settings__row">
            <EmailModeField labelId="em-l" value={draft.emailMode} locked={evLocked} onChange={(m) => update((d) => ({ ...d, emailMode: m }))} />
            <div class="yy-field">
              <span class="yy-label" id="sc-l">Scoring</span>
              <div class="yy-seg" role="tablist" aria-labelledby="sc-l">
                {(['speed', 'flat'] as ScoringMode[]).map((m) => (
                  <button type="button" role="tab" aria-selected={draft.scoring === m} onClick={() => update((d) => ({ ...d, scoring: m }))}>
                    {m === 'speed' ? 'Speed' : 'Flat'}
                  </button>
                ))}
              </div>
              <span class="yy-help">{draft.scoring === 'speed' ? 'Correct answers earn 500–1000, faster is more.' : 'Every correct answer earns the full 1000.'}</span>
            </div>
          </div>
        </section>

        <div class="c9-m-section__head">
          <h2 class="c9-m-h4">Questions <span class="c9-muted c9-m-count">{draft.questions.length}</span></h2>
        </div>

        <ol class="c9-m-qlist">
          {draft.questions.map((q, i) => (
            <li key={q.key} class="yy-card c9-m-qcard">
              <div class="c9-m-qcard__head">
                <span class="c9-overline">Question {i + 1}</span>
                <span class="c9-spacer" />
                <button type="button" class="c9-m-iconbtn" aria-label={`Move question ${i + 1} up`} disabled={i === 0}
                  onClick={() => update((d) => { const qs = [...d.questions]; [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; return { ...d, questions: qs }; })}>↑</button>
                <button type="button" class="c9-m-iconbtn" aria-label={`Move question ${i + 1} down`} disabled={i === draft.questions.length - 1}
                  onClick={() => update((d) => { const qs = [...d.questions]; [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; return { ...d, questions: qs }; })}>↓</button>
                <button type="button" class="yy-btn yy-btn--danger-quiet yy-btn--sm" disabled={draft.questions.length === 1}
                  onClick={() => { if (!q.text.trim() || confirm(`Remove question ${i + 1}?`)) update((d) => ({ ...d, questions: d.questions.filter((_, j) => j !== i) })); }}>Remove</button>
              </div>
              <textarea class="yy-input c9-m-qtext" rows={2} placeholder="Type the question…" aria-label={`Question ${i + 1} text`} value={q.text}
                onInput={(e) => updQ(i, { text: (e.target as HTMLTextAreaElement).value })} />
              <fieldset class="c9-m-opts">
                <legend class="yy-label">Answers <span class="yy-optional">— select the correct one</span></legend>
                {q.options.map((o, oi) => (
                  <div class={`c9-m-opt ${q.correctIndex === oi ? 'is-correct' : ''}`} key={oi}>
                    <label class="c9-m-opt__radio" title="Mark as correct">
                      <input type="radio" name={`correct-${q.key}`} checked={q.correctIndex === oi} onChange={() => updQ(i, { correctIndex: oi })}
                        aria-label={`Option ${LETTERS[oi]} is correct`} />
                      <span class={`c9-m-letter c9-m-letter--${oi}`}>{LETTERS[oi]}</span>
                    </label>
                    <input class="yy-input" placeholder={oi < 2 ? `Option ${LETTERS[oi]}` : `Option ${LETTERS[oi]} (optional)`} value={o} maxLength={200}
                      onInput={(e) => updQ(i, { options: q.options.map((x, k) => (k === oi ? (e.target as HTMLInputElement).value : x)) })} />
                    {q.correctIndex === oi && <span class="c9-m-opt__tag">Correct</span>}
                    {q.options.length > 2 && (
                      <button type="button" class="c9-m-iconbtn" aria-label={`Remove option ${LETTERS[oi]}`}
                        onClick={() => updQ(i, {
                          options: q.options.filter((_, k) => k !== oi),
                          correctIndex: q.correctIndex === oi ? 0 : q.correctIndex > oi ? q.correctIndex - 1 : q.correctIndex,
                        })}>×</button>
                    )}
                  </div>
                ))}
                {q.options.length < 4 && (
                  <button type="button" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-addopt" onClick={() => updQ(i, { options: [...q.options, ''] })}>+ Add option</button>
                )}
              </fieldset>
              <div class="c9-m-qcard__foot">
                <div class="yy-field c9-m-time">
                  <label class="yy-label" for={`t-${q.key}`}>Time limit (s)</label>
                  <input id={`t-${q.key}`} class="yy-input" type="number" min={5} max={300} inputMode="numeric" value={q.timeLimitSec}
                    onInput={(e) => updQ(i, { timeLimitSec: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="yy-field c9-m-img">
                  <label class="yy-label" for={`im-${q.key}`}>Image URL <span class="yy-optional">Optional</span></label>
                  <input id={`im-${q.key}`} class="yy-input" type="url" placeholder="https://…" value={q.imageUrl}
                    onInput={(e) => updQ(i, { imageUrl: (e.target as HTMLInputElement).value })} />
                </div>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" class="yy-btn yy-btn--secondary c9-m-addq" disabled={draft.questions.length >= 100}
          onClick={() => update((d) => ({ ...d, questions: [...d.questions, blankQ()] }))}>+ Add question</button>

        {errors.length > 0 && (
          <div id="c9-editor-errors" class="c9-m-errors" role="alert">
            <strong>Fix these before saving:</strong>
            <ul>{errors.map((e) => <li>{e}</li>)}</ul>
          </div>
        )}
      </main>
      <div class="c9-m-savebar">
        <div class="c9-m-savebar__in">
          <span class="c9-m-small c9-muted">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'All changes saved' : `${draft.questions.length} question${draft.questions.length === 1 ? '' : 's'}`}</span>
          <span class="c9-spacer" />
          <a href={backHref} class="yy-btn yy-btn--quiet" onClick={back as any}>Cancel</a>
          <button class="yy-btn yy-btn--primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save quiz'}</button>
        </div>
      </div>
    </div>
  );
}
