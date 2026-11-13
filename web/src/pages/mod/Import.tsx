import { useState } from 'preact/hooks';
import type { Me, ImportReq } from '../../../../shared/api';
import type { QuizDef, EmailMode, ScoringMode } from '../../../../shared/model';
import { navigate } from '../../lib/router';
import { mutate, errMsg, ModHeader, Link, fixture } from './common';

type Fmt = 'csv' | 'json';
const guessFmt = (name: string, text: string): Fmt =>
  /\.json$/i.test(name) ? 'json' : /\.csv$/i.test(name) ? 'csv' : /^\s*[[{]/.test(text) ? 'json' : 'csv';

export function Import(props: { me: Me; onLogout: () => void }) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileText, setFileText] = useState('');
  const [paste, setPaste] = useState('');
  const [emailMode, setEmailMode] = useState<EmailMode>('optional');
  const [scoring, setScoring] = useState<ScoringMode>('speed');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const content = mode === 'file' ? fileText : paste;
  const fmt = guessFmt(mode === 'file' ? fileName ?? '' : '', content);

  const onFile = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr(null);
    if (f.size > 2_000_000) { setErr('That file is larger than 2 MB. Split it into smaller quizzes.'); return; }
    const text = await f.text();
    setFileName(f.name); setFileText(text);
    if (!title.trim()) setTitle(f.name.replace(/\.(csv|json)$/i, '').replace(/[_-]+/g, ' ').trim());
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!title.trim()) { setErr('Give the quiz a title.'); return; }
    if (!content.trim()) { setErr(mode === 'file' ? 'Choose a .csv or .json file first.' : 'Paste your CSV or JSON first.'); return; }
    setBusy(true); setErr(null);
    try {
      const body: ImportReq = { title: title.trim(), format: fmt, content, emailMode, scoring };
      const q = await mutate<QuizDef>('POST', '/api/quizzes/import', body);
      navigate(`/mod/quiz/${fixture ? 'q1' : q.id}`);
    } catch (e2) { setErr(errMsg(e2)); setBusy(false); }
  };

  const rows = content.trim() ? (fmt === 'csv' ? Math.max(0, content.trim().split(/\r?\n/).length - 1) : null) : null;

  return (
    <div class="c9-page">
      <ModHeader me={props.me} onLogout={props.onLogout} />
      <main class="c9-m-main c9-m-form">
        <Link href="/mod" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-back">← Dashboard</Link>
        <div class="c9-m-pagehead">
          <h1 class="c9-m-h1">Import a quiz</h1>
          <p class="c9-muted">Bring questions in from a spreadsheet (CSV) or JSON. You can review and edit them afterwards.</p>
        </div>

        <form class="yy-card c9-stack c9-m-import" onSubmit={submit} noValidate>
          <div class="yy-field">
            <label class="yy-label" for="it">Quiz title</label>
            <input id="it" class="yy-input" maxLength={120} placeholder="e.g. Cloud Basics Warm-up" value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </div>

          <div class="yy-field">
            <span class="yy-label">Questions</span>
            <div class="yy-seg" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'file'} onClick={() => setMode('file')}>Upload file</button>
              <button type="button" role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>Paste text</button>
            </div>
          </div>

          {mode === 'file' ? (
            <label class={`c9-m-drop ${fileName ? 'has-file' : ''}`}>
              <input type="file" accept=".csv,.json,text/csv,application/json" onChange={onFile} />
              <span class="c9-m-drop__title">{fileName ?? 'Choose a .csv or .json file'}</span>
              <span class="c9-muted c9-m-small">{fileName ? `${fmt.toUpperCase()}${rows !== null ? ` · ${rows} row${rows === 1 ? '' : 's'}` : ''} · click to choose another` : 'The file is read in your browser and sent as text.'}</span>
            </label>
          ) : (
            <textarea class="yy-input c9-m-paste" rows={8} spellcheck={false}
              placeholder={'question,option_a,option_b,option_c,option_d,correct,time_sec,image_url\nWhat is 2+2?,3,4,5,,B,20,'}
              value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
          )}

          <div class="c9-m-hint">
            <strong>CSV columns:</strong> <code>question, option_a, option_b, option_c, option_d, correct, time_sec, image_url</code>.
            {' '}<code>correct</code> is A–D or 1–4. Leave unused options blank (min 2). <a href="/api/quizzes/template.csv" download>Download template</a>
          </div>

          <div class="c9-m-settings__row">
            <div class="yy-field">
              <span class="yy-label">Ask players for email</span>
              <div class="yy-seg" role="tablist">
                {(['off', 'optional', 'required'] as EmailMode[]).map((m) => (
                  <button type="button" role="tab" aria-selected={emailMode === m} onClick={() => setEmailMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </div>
            <div class="yy-field">
              <span class="yy-label">Scoring</span>
              <div class="yy-seg" role="tablist">
                {(['speed', 'flat'] as ScoringMode[]).map((m) => (
                  <button type="button" role="tab" aria-selected={scoring === m} onClick={() => setScoring(m)}>{m === 'speed' ? 'Speed' : 'Flat'}</button>
                ))}
              </div>
            </div>
          </div>

          {err && <div class="c9-m-errors" role="alert"><strong>Import failed.</strong> <span class="c9-m-pre">{err}</span></div>}

          <div class="c9-m-formactions">
            <Link href="/mod" class="yy-btn yy-btn--quiet">Cancel</Link>
            <button type="submit" class="yy-btn yy-btn--primary" disabled={busy}>{busy ? 'Importing…' : 'Import quiz'}</button>
          </div>
        </form>
      </main>
    </div>
  );
}
