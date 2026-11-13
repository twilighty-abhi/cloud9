// Moderator control panel for one live room. Owned by agent D.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Me, SessionSummary } from '../../../../shared/api';
import type { HostSnapshot, ModAction } from '../../../../shared/protocol';
import type { BoardTop } from '../../../../shared/model';
import { useRoom, useTick, type RoomConn } from '../../lib/ws';
import { hostFixture } from '../../dev/modFixtures';
import { fixture, load, mutate, errMsg, Link, Logo, Chip, Switch, LETTERS, qrSrc, fmtNum } from './common';

type Conn = RoomConn<HostSnapshot>;

function useFixtureConn(): Conn | null {
  const [snap] = useState(() => (fixture ? hostFixture(fixture) : null));
  if (!snap) return null;
  return { snap, status: 'open', fatal: null, lastError: null, now: () => Date.now(), send: (m) => { console.info('[fixture] send', m); return true; } };
}

export function Room(props: { code: string; me: Me }) {
  const fx = useFixtureConn();
  const live = useRoom<HostSnapshot>(fx ? null : { role: 'mod', code: props.code });
  const conn = fx ?? live;
  const snap = conn.snap;

  useEffect(() => { document.title = `Room ${props.code} · CCD Kochi Live Quiz`; }, [props.code]);

  if (conn.fatal === 'unauthorized') {
    return <Notice title="You don't have access to this room" body="It belongs to another moderator, or your sign-in expired. Sign in again from the dashboard." />;
  }
  if (conn.fatal === 'not_found') {
    return <Notice title="This room doesn't exist" body={`There's no live room with code ${props.code}. It may have ended and been cleared.`} />;
  }
  if (!snap) {
    return (
      <div class="c9-m-center">
        <div class="c9-stack" style={{ alignItems: 'center' }}>
          <div class="c9-m-spinner" aria-hidden="true" />
          <p class="c9-muted">{conn.status === 'reconnecting' ? 'Reconnecting to room…' : 'Connecting to room…'}</p>
        </div>
      </div>
    );
  }
  return <Panel conn={conn} snap={snap} />;
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

interface PrimaryDef { label: string; action?: ModAction; href?: string; disabled?: boolean; hint?: string }

function primaryFor(s: HostSnapshot): PrimaryDef {
  const last = s.qIndex >= s.total - 1;
  switch (s.state) {
    case 'LOBBY': return s.playerCount > 0
      ? { label: 'Start quiz', action: 'start' }
      : { label: 'Start quiz', action: 'start', disabled: true, hint: 'Waiting for at least one player to join' };
    case 'QUESTION': return { label: 'Close answers', action: 'close' };
    case 'CLOSED': return { label: 'Reveal answer', action: 'reveal' };
    case 'REVEAL': return { label: 'Show leaderboard', action: 'leaderboard' };
    case 'LEADERBOARD': return last ? { label: 'Finish quiz', action: 'next' } : { label: 'Next question', action: 'next' };
    case 'FINISHED': return { label: 'Download results CSV', href: `/api/sessions/${s.code}/export.csv` };
  }
}

/** HostSnapshot carries the event NAME only; look the event id up from the moderator's session list (once). */
function useEventId(code: string, eventName: string | null): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!eventName || id) return;
    let alive = true;
    load<SessionSummary[]>('/api/sessions')
      .then((l) => { const s = (l ?? []).find((x) => x.code === code); if (alive && s?.eventId) setId(s.eventId); })
      .catch(() => { /* breadcrumb just stays unlinked */ });
    return () => { alive = false; };
  }, [code, eventName]);
  return id;
}

function Panel({ conn, snap }: { conn: Conn; snap: HostSnapshot }) {
  const lookedUp = useEventId(snap.code, snap.eventId ? null : snap.eventName);
  const eventId = snap.eventId ?? lookedUp;
  const [pendingV, setPendingV] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = (t: string) => {
    setToast(t); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  // unlock the action button once a newer state arrives (or after 3 s)
  useEffect(() => { if (pendingV !== null && snap.v > pendingV) setPendingV(null); }, [snap.v]);
  useEffect(() => {
    if (pendingV === null) return;
    const t = setTimeout(() => setPendingV(null), 3000);
    return () => clearTimeout(t);
  }, [pendingV]);
  useEffect(() => {
    const e = conn.lastError;
    if (!e) return;
    setPendingV(null);
    if (e.code === 'stale' || e.code === 'bad_transition') showToast('Already moved on — this screen shows the latest state.');
    else if (e.code !== 'not_found' && e.code !== 'unauthorized') showToast(e.message || 'Something went wrong.');
  }, [conn.lastError]);

  // Cooldown: ignore the primary action for 800 ms after any state change, so a double-press
  // (Space twice) can't open AND immediately close the next question.
  const changedAt = useRef(Date.now());
  useEffect(() => { changedAt.current = Date.now(); }, [snap.state, snap.qIndex]);
  const act = (action: ModAction) => {
    if (pendingV !== null) return;
    if (action !== 'end' && Date.now() - changedAt.current < 800) return;
    const ok = conn.send({ t: 'mod', action, expectQ: snap.qIndex });
    if (!ok) { showToast("Not connected — reconnecting. Try again in a moment."); return; }
    setPendingV(snap.v);
  };

  const primary = primaryFor(snap);
  const pending = pendingV !== null;
  const last = snap.qIndex >= snap.total - 1;

  // keyboard: Space / → triggers the primary action
  const primaryRef = useRef<() => void>(() => {});
  primaryRef.current = () => { if (primary.action && !primary.disabled) act(primary.action); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      primaryRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const end = () => {
    if (confirm('End this quiz now? Players see the final results and the room can\'t be restarted.')) act('end');
  };

  return (
    <div class="c9-page c9-m-roompage">
      <header class="c9-header c9-m-header c9-m-roomhead">
        <Logo />
        <Link href="/mod" class="yy-btn yy-btn--quiet yy-btn--sm c9-m-hide-sm">← Dashboard</Link>
        <div class="c9-m-roomhead__title">
          {snap.eventName && (eventId
            ? <><Link href={`/mod/event/${eventId}`} class="c9-m-crumb" title="Open the event page">{snap.eventName}</Link><span class="c9-muted c9-m-crumbsep"> / </span></>
            : <><span class="c9-m-crumb">{snap.eventName}</span><span class="c9-muted c9-m-crumbsep"> / </span></>)}
          <strong>{snap.title}</strong>
          {snap.label && <span class="c9-muted"> · {snap.label}</span>}
        </div>
        <span class="c9-spacer" />
        {conn.status !== 'open' && <span class="c9-conn c9-conn--off" role="status">Reconnecting…</span>}
        <a class="yy-btn yy-btn--secondary yy-btn--sm" href={`/present/${snap.code}`} target="_blank" rel="noopener">
          <span class="c9-m-hide-sm">Open projector view</span><span class="c9-m-show-sm">Projector</span> ↗
        </a>
      </header>

      <div class="c9-m-room">
        <main class="c9-m-room__main">
          <Stage conn={conn} snap={snap} />
          {snap.eventBoard && (snap.state === 'LEADERBOARD' || snap.state === 'FINISHED') && (
            <EventBoardCard board={snap.eventBoard} eventId={eventId} finished={snap.state === 'FINISHED'} />
          )}
          {snap.nextQuestion && snap.state !== 'FINISHED' && (
            <section class="c9-m-next" aria-label="Up next">
              <div class="c9-overline">Up next · Question {snap.qIndex + 2} of {snap.total}</div>
              <p class="c9-m-next__q">{snap.nextQuestion.text}</p>
              <ul class="c9-m-next__opts">
                {snap.nextQuestion.options.map((o, i) => (
                  <li class={i === snap.nextQuestion!.correctIndex ? 'is-correct' : ''}>
                    <span class={`c9-m-letter c9-m-letter--sm c9-m-letter--${i}`}>{LETTERS[i]}</span>{o}
                    {i === snap.nextQuestion!.correctIndex && <span class="c9-m-tick" aria-label="correct">✓</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!snap.nextQuestion && snap.state !== 'FINISHED' && snap.state !== 'LOBBY' && (
            <section class="c9-m-next c9-m-next--last"><div class="c9-overline">This is the last question</div></section>
          )}
        </main>
        <aside class="c9-m-room__side">
          <JoinCard snap={snap} />
          <SettingsCard snap={snap} onError={showToast} />
          <PlayersCard snap={snap} onKick={(id, name) => {
            if (!confirm(`Remove ${name} from this room? They won't be able to rejoin with the same entry.`)) return;
            if (!conn.send({ t: 'kick', playerId: id })) showToast("Not connected — reconnecting. Try again in a moment.");
          }} />
        </aside>
      </div>

      {toast && <div class="c9-m-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}

      <div class="c9-m-actionbar">
        <div class="c9-m-actionbar__in">
          <div class="c9-m-actionbar__status">
            <ActionStatus conn={conn} snap={snap} hint={primary.hint} />
          </div>
          {snap.state !== 'FINISHED' && (
            <button class="yy-btn yy-btn--danger-quiet c9-m-endbtn" onClick={end} disabled={pending}>End quiz</button>
          )}
          {snap.state === 'REVEAL' && (
            <button class="yy-btn yy-btn--secondary yy-btn--lg" onClick={() => act('next')} disabled={pending}>
              {last ? 'Finish quiz' : 'Next question'}
            </button>
          )}
          {snap.state === 'FINISHED' && eventId && (
            <Link href={`/mod/event/${eventId}#lb`} class="yy-btn yy-btn--quiet yy-btn--lg c9-m-hide-sm">Event leaderboard →</Link>
          )}
          {snap.state === 'FINISHED' && (
            <Link href="/mod" class="yy-btn yy-btn--secondary yy-btn--lg">Dashboard</Link>
          )}
          {primary.href ? (
            <a class="yy-btn yy-btn--primary yy-btn--lg c9-m-primary" href={primary.href} download>{primary.label}</a>
          ) : (
            <button class="yy-btn yy-btn--primary yy-btn--lg c9-m-primary" disabled={primary.disabled || pending}
              onClick={() => primary.action && act(primary.action)} aria-keyshortcuts="Space ArrowRight">
              {pending ? 'Working…' : primary.label}
              {!pending && !primary.disabled && <kbd class="c9-m-kbd" aria-hidden="true">Space</kbd>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionStatus({ conn, snap, hint }: { conn: Conn; snap: HostSnapshot; hint?: string }) {
  if (hint) return <span class="c9-muted">{hint}</span>;
  if (snap.state === 'QUESTION') {
    return <span><strong>{fmtNum(snap.answered)}</strong> / {fmtNum(snap.playerCount)} answered · closes automatically when time runs out</span>;
  }
  if (snap.state === 'LOBBY') return <span><strong>{fmtNum(snap.playerCount)}</strong> player{snap.playerCount === 1 ? '' : 's'} in the lobby</span>;
  if (snap.state === 'FINISHED') return <span class="c9-muted">Quiz finished · {fmtNum(snap.playerCount)} players</span>;
  void conn;
  return <span class="c9-muted">Question {snap.qIndex + 1} of {snap.total}</span>;
}

// ───────────────────────── stage ─────────────────────────

function useCountdown(conn: Conn, snap: HostSnapshot) {
  const active = snap.state === 'QUESTION' && !!snap.question;
  useTick(250, active);
  if (!snap.question) return { left: 0, frac: 0 };
  const total = snap.question.endsAt - snap.question.startedAt;
  const left = active ? Math.max(0, snap.question.endsAt - conn.now()) : 0;
  return { left, frac: total > 0 ? left / total : 0 };
}

function Stage({ conn, snap }: { conn: Conn; snap: HostSnapshot }) {
  const { left, frac } = useCountdown(conn, snap);
  const q = snap.question;
  const qLabel = `Question ${snap.qIndex + 1} of ${snap.total}`;

  let title: string; let chip: { text: string; tone: string } | null = null;
  switch (snap.state) {
    case 'LOBBY': title = 'Lobby'; chip = { text: snap.joinOpen ? 'Joining open' : 'Joining closed', tone: snap.joinOpen ? 'success' : 'warning' }; break;
    case 'QUESTION': title = qLabel; chip = { text: 'Answers open', tone: 'success' }; break;
    case 'CLOSED': title = qLabel; chip = { text: 'Answers closed', tone: 'warning' }; break;
    case 'REVEAL': title = qLabel; chip = { text: 'Revealed', tone: 'accent' }; break;
    case 'LEADERBOARD': title = 'Leaderboard'; chip = { text: `After question ${snap.qIndex + 1} of ${snap.total}`, tone: 'neutral' }; break;
    default: title = 'Finished'; chip = { text: 'Final results', tone: 'neutral' };
  }

  return (
    <section class="yy-card c9-m-stage" aria-live="polite">
      <div class="c9-m-stage__head">
        <div>
          <h2 class="c9-m-stage__title">{title}</h2>
          {chip && <Chip tone={chip.tone}>{chip.text}</Chip>}
        </div>
        <span class="c9-spacer" />
        {snap.state === 'QUESTION' && q && <Ring left={left} frac={frac} />}
      </div>

      {snap.state === 'LOBBY' && (
        <div class="c9-m-lobby">
          <div class="c9-m-bignum">{fmtNum(snap.playerCount)}</div>
          <div class="c9-m-lobby__txt">
            <strong>player{snap.playerCount === 1 ? '' : 's'} joined</strong>
            <span class="c9-muted">Players scan the QR or enter code <span class="c9-mono">{snap.code}</span>. Start when everyone's in — late joiners can still enter while joining is open.</span>
          </div>
        </div>
      )}

      {q && (snap.state === 'QUESTION' || snap.state === 'CLOSED' || snap.state === 'REVEAL') && (
        <>
          <div class="c9-m-q">
            {q.imageUrl && <img class="c9-m-q__img" src={q.imageUrl} alt="" loading="lazy" />}
            <p class="c9-m-q__text">{q.text}</p>
          </div>
          <Options snap={snap} />
          {snap.state === 'QUESTION' && (
            <div class="c9-m-answered">
              <div class="c9-m-answered__row">
                <span><strong class="c9-m-answered__n">{fmtNum(snap.answered)}</strong> / {fmtNum(snap.playerCount)} answered</span>
                <span class="c9-muted">{snap.playerCount ? Math.round((snap.answered / snap.playerCount) * 100) : 0}%</span>
              </div>
              <div class="yy-progress" role="progressbar" aria-valuemin={0} aria-valuemax={snap.playerCount} aria-valuenow={snap.answered}>
                <span style={{ width: `${snap.playerCount ? Math.min(100, (snap.answered / snap.playerCount) * 100) : 0}%` }} />
              </div>
            </div>
          )}
        </>
      )}

      {(snap.state === 'LEADERBOARD' || snap.state === 'FINISHED') && (
        <>
          {snap.eventBoard && <div class="c9-overline">This quiz</div>}
          <Leaderboard entries={snap.leaderboard} podium={snap.state === 'FINISHED'} />
        </>
      )}
      {snap.state === 'FINISHED' && (
        <p class="c9-muted c9-m-small">Download the CSV for every player's name, email, score and per-question answers.</p>
      )}
    </section>
  );
}

function Ring({ left, frac }: { left: number; frac: number }) {
  const r = 26, c = 2 * Math.PI * r;
  const secs = Math.ceil(left / 1000);
  return (
    <div class={`c9-m-ring ${secs <= 5 ? 'is-low' : ''}`} role="timer" aria-label={`${secs} seconds left`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} class="c9-m-ring__track" />
        <circle cx="32" cy="32" r={r} class="c9-m-ring__bar" style={{ strokeDasharray: c, strokeDashoffset: c * (1 - frac) }} />
      </svg>
      <span>{secs}</span>
    </div>
  );
}

function Options({ snap }: { snap: HostSnapshot }) {
  const q = snap.question!;
  const dist = snap.distribution;
  const sum = dist ? dist.reduce((a, b) => a + b, 0) : 0;
  const showDist = !!dist && snap.state !== 'QUESTION';
  return (
    <ul class={`c9-m-opts2 ${snap.state === 'REVEAL' ? 'is-reveal' : ''}`}>
      {q.options.map((o, i) => {
        const correct = snap.correctIndex === i;
        const n = dist?.[i] ?? 0;
        const pct = sum ? Math.round((n / sum) * 100) : 0;
        return (
          <li class={`c9-m-opt2 ${correct ? 'is-correct' : ''}`}>
            <span class={`c9-m-letter c9-m-letter--${i}`}>{LETTERS[i]}</span>
            <div class="c9-m-opt2__body">
              <div class="c9-m-opt2__row">
                <span class="c9-m-opt2__text">{o}</span>
                {correct && <span class="c9-m-opt2__correct">✓ Correct</span>}
                {showDist && <span class="c9-m-opt2__count"><strong>{n}</strong> · {pct}%</span>}
              </div>
              {showDist && <div class="c9-m-bar"><span class={`c9-m-bar--${i}`} style={{ width: `${pct}%` }} /></div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EventBoardCard({ board, eventId, finished }: { board: NonNullable<HostSnapshot['eventBoard']>; eventId: string | null; finished: boolean }) {
  return (
    <section class="yy-card c9-m-evboard" aria-labelledby="evb-h">
      <div class="c9-m-evboard__head">
        <div>
          <div class="c9-overline">Event standings · all quizzes</div>
          <h3 id="evb-h" class="c9-m-h4">{board.eventName}</h3>
        </div>
        <span class="c9-spacer" />
        <span class="c9-muted c9-m-small">{fmtNum(board.total)} player{board.total === 1 ? '' : 's'} in the event</span>
      </div>
      <Leaderboard entries={board.top} podium={false} />
      {eventId && (
        <div class="c9-m-evboard__foot">
          <Link href={`/mod/event/${eventId}#lb`} class={`yy-btn ${finished ? 'yy-btn--secondary' : 'yy-btn--quiet'} yy-btn--sm`}>Event leaderboard →</Link>
        </div>
      )}
    </section>
  );
}

function Leaderboard({ entries, podium }: { entries: BoardTop[]; podium: boolean }) {
  if (!entries.length) return <div class="yy-empty">No scores yet.</div>;
  return (
    <ol class={`c9-m-lb ${podium ? 'is-podium' : ''}`}>
      {entries.slice(0, 10).map((e) => (
        <li class={`c9-m-lb__row ${e.rank <= 3 ? `is-top is-r${e.rank}` : ''}`}>
          <span class="c9-m-lb__rank">{e.rank}</span>
          <span class="c9-m-lb__name">{e.name}</span>
          <span class="c9-m-lb__score">{fmtNum(e.score)}</span>
        </li>
      ))}
    </ol>
  );
}

// ───────────────────────── side ─────────────────────────

function JoinCard({ snap }: { snap: HostSnapshot }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(snap.joinUrl); }
    catch {
      const ta = document.createElement('textarea'); ta.value = snap.joinUrl; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* */ } ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  const shortUrl = snap.joinUrl.replace(/^https?:\/\//, '');
  return (
    <section class="yy-card c9-m-join" aria-label="Join details">
      <div class="c9-m-join__qr"><img src={qrSrc(snap.code)} alt={`QR code for ${snap.joinUrl}`} width={220} height={220} /></div>
      <div class="c9-m-join__info">
        <div class="c9-overline">Join code</div>
        <div class="c9-m-join__code c9-mono" aria-label={`Join code ${snap.code.split('').join(' ')}`}>{snap.code.slice(0, 3)}<span>{snap.code.slice(3)}</span></div>
        <div class="c9-m-join__url">
          <span class="c9-mono" title={snap.joinUrl}>{shortUrl}</span>
          <button class="yy-btn yy-btn--secondary yy-btn--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    </section>
  );
}

function SettingsCard({ snap, onError }: { snap: HostSnapshot; onError: (m: string) => void }) {
  const [label, setLabel] = useState(snap.label);
  const [editing, setEditing] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [ov, setOv] = useState<{ listed?: boolean; joinOpen?: boolean }>({});

  useEffect(() => { if (!editing) setLabel(snap.label); }, [snap.label, editing]);
  useEffect(() => {
    setOv((o) => {
      const n = { ...o };
      if (n.listed === snap.listed) delete n.listed;
      if (n.joinOpen === snap.joinOpen) delete n.joinOpen;
      return n;
    });
  }, [snap.listed, snap.joinOpen]);

  const patchIt = async (body: { label?: string; listed?: boolean; joinOpen?: boolean }) => {
    try {
      const s = await mutate<SessionSummary>('PATCH', `/api/sessions/${snap.code}`, body);
      return s;
    } catch (e) { onError(`Couldn't save: ${errMsg(e)}`); throw e; }
  };

  const saveLabel = async () => {
    setEditing(false);
    const v = label.trim();
    if (v === snap.label) return;
    try { await patchIt({ label: v }); setSavedTick(true); setTimeout(() => setSavedTick(false), 1500); }
    catch { setLabel(snap.label); }
  };

  const toggle = async (key: 'listed' | 'joinOpen', v: boolean) => {
    setOv((o) => ({ ...o, [key]: v }));
    try { await patchIt({ [key]: v }); }
    catch { setOv((o) => { const n = { ...o }; delete n[key]; return n; }); }
  };

  const listed = ov.listed ?? snap.listed;
  const joinOpen = ov.joinOpen ?? snap.joinOpen;

  return (
    <section class="yy-card c9-m-settingscard" aria-label="Session settings">
      <div class="yy-field">
        <label class="yy-label" for="room-label">Label {savedTick && <span class="c9-m-saved">Saved</span>}</label>
        <input id="room-label" class="yy-input" maxLength={60} placeholder="e.g. Hall A · Round 1" value={label}
          onFocus={() => setEditing(true)}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setLabel(snap.label); setEditing(false); (e.target as HTMLInputElement).blur(); }
          }} />
      </div>
      <Switch label="Show on home page" hint={listed ? 'Listed for everyone on the home page' : 'Hidden — join by QR or code only'} checked={listed} onChange={(v) => toggle('listed', v)} />
      <Switch label="Joining open" hint={joinOpen ? 'New players can join' : 'New players are turned away'} checked={joinOpen} onChange={(v) => toggle('joinOpen', v)} />
    </section>
  );
}

function PlayersCard({ snap, onKick }: { snap: HostSnapshot; onKick: (id: string, name: string) => void }) {
  const [filter, setFilter] = useState('');
  const online = snap.players.filter((p) => p.connected).length;
  const started = snap.state !== 'LOBBY';
  let list = started ? [...snap.players].sort((a, b) => b.score - a.score) : [...snap.players].reverse();
  const f = filter.trim().toLowerCase();
  if (f) list = list.filter((p) => p.name.toLowerCase().includes(f));
  return (
    <section class="yy-card c9-m-players" aria-label="Players">
      <div class="c9-m-players__head">
        <h3 class="c9-m-h4">Players <span class="c9-m-count">{fmtNum(snap.players.length)}</span></h3>
        <span class="c9-spacer" />
        <span class="c9-muted c9-m-small"><span class="c9-m-dot is-on" /> {fmtNum(online)} online</span>
      </div>
      {snap.players.length > 8 && (
        <input class="yy-input c9-m-players__filter" type="search" placeholder="Find a player…" value={filter} aria-label="Find a player"
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      )}
      {snap.players.length === 0 ? (
        <div class="yy-empty c9-m-small">No one has joined yet. Show the QR on the projector.</div>
      ) : (
        <ul class="c9-m-players__list">
          {list.map((p) => (
            <li key={p.id} class="c9-m-player">
              <span class={`c9-m-dot ${p.connected ? 'is-on' : ''}`} title={p.connected ? 'Connected' : 'Offline'} />
              <span class="c9-m-player__name">{p.name}</span>
              {started && <span class="c9-m-player__score">{fmtNum(p.score)}</span>}
              <button class="c9-m-iconbtn c9-m-kick" aria-label={`Remove ${p.name}`} title="Remove player" onClick={() => onKick(p.id, p.name)}>×</button>
            </li>
          ))}
          {f && list.length === 0 && <li class="c9-muted c9-m-small c9-m-player">No player matches “{filter}”.</li>}
        </ul>
      )}
    </section>
  );
}
