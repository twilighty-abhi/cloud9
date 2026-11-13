// Public home page: "Have a code?" box + live list of listed sessions (polled every 5s while visible).
import { useEffect, useState } from 'preact/hooks';
import type { PublicSession } from '../../../../shared/model';
import { get } from '../../lib/api';
import { navigate, linkClick } from '../../lib/router';
import { getPlayer } from '../../lib/storage';
import { fixtureName, homeFixture } from '../../dev/playerFixtures';
import { IconArrowRight, IconUsers } from '../player/icons';
import './home.css';
import { Brand, CcdSymbols } from '../../lib/brand';

const POLL_MS = 5000;

export function Home() {
  const fx = fixtureName();
  const fxData = fx ? homeFixture(fx) : null;
  const [sessions, setSessions] = useState<PublicSession[] | null>(Array.isArray(fxData) ? fxData : null);
  const [failed, setFailed] = useState(fxData === 'error');

  useEffect(() => {
    if (fxData) return;
    let alive = true;
    let inflight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const list = await get<PublicSession[]>('/api/public/sessions');
        if (alive) { setSessions(Array.isArray(list) ? list.filter((s) => s.state !== 'FINISHED') : []); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      } finally { inflight = false; }
    };
    const start = () => { clearInterval(timer); timer = setInterval(load, POLL_MS); };
    const onVis = () => {
      if (document.visibilityState === 'visible') { load(); start(); } else clearInterval(timer);
    };
    load(); start();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="c9-page c9-h">
      <header class="c9-h-header">
        <div class="c9-h-inner">
          <a href="/" class="c9-logo" onClick={linkClick}><Brand /></a>
        </div>
      </header>
      <main class="c9-h-inner c9-h-main">
        <div class="c9-ccd-hero">
          <CcdSymbols size={18} />
          <p class="c9-ccd-hero__line">At the speed of <span>thought.</span></p>
          <p class="c9-ccd-hero__meta">Google Cloud Community Day Kochi · 14 Nov 2026 · Holiday Inn, Kochi</p>
        </div>
        <CodeBox />
        <section class="c9-h-live" aria-labelledby="c9-h-live-title">
          <div class="c9-h-live__head">
            <h2 id="c9-h-live-title" class="c9-h-live__title"><span class="c9-h-dot" aria-hidden="true" />Live now</h2>
            {failed && sessions && <span class="c9-conn c9-conn--off" role="status">Reconnecting…</span>}
          </div>
          {sessions === null && !failed && <Skeleton />}
          {sessions === null && failed && (
            <div class="yy-empty c9-h-state" role="status">
              <p class="c9-h-state__title">Can't reach Cloud 9 — retrying</p>
              <p class="c9-muted">Check your Wi-Fi or mobile data. This page keeps trying on its own.</p>
            </div>
          )}
          {sessions && sessions.length === 0 && (
            <div class="yy-empty c9-h-state">
              <p class="c9-h-state__title">No quizzes are live right now. Hang tight.</p>
              <p class="c9-muted">This list updates by itself when a quiz starts.</p>
            </div>
          )}
          {sessions && sessions.length > 0 && (
            <ul class="c9-h-list">
              {sessions.map((s) => <SessionCard key={s.code} s={s} />)}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function CodeBox() {
  const [code, setCode] = useState('');
  const ok = code.length === 6;
  const submit = (e: Event) => {
    e.preventDefault();
    if (ok) navigate(`/join/${code}`);
  };
  return (
    <form class="c9-h-code" onSubmit={submit}>
      <label class="c9-h-code__label" for="c9-h-code-input">Have a code?</label>
      <p class="c9-muted c9-h-code__help">Type the 6-digit code from the screen.</p>
      <div class="c9-h-code__row">
        <input
          id="c9-h-code-input"
          class="yy-input c9-h-code__input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="000000"
          value={code}
          onInput={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const v = el.value.replace(/\D/g, '').slice(0, 6);
            if (el.value !== v) el.value = v;
            setCode(v);
          }}
        />
        <button class="yy-btn yy-btn--primary c9-h-code__btn" type="submit" disabled={!ok}>
          Join<IconArrowRight size={18} />
        </button>
      </div>
    </form>
  );
}

function statusChip(s: PublicSession) {
  if (s.state === 'LOBBY') return <span class="yy-chip yy-chip--success">Waiting to start</span>;
  const q = Math.min(Math.max(s.qIndex + 1, 1), s.total);
  return <span class="yy-chip yy-chip--accent">In progress · Q{q} of {s.total}</span>;
}

function SessionCard({ s }: { s: PublicSession }) {
  const mine = getPlayer(s.code);
  return (
    <li class="yy-card c9-h-card">
      <div class="c9-h-card__text">
        <h3 class="c9-h-card__title">{s.title}</h3>
        {s.label && <p class="c9-h-card__label">{s.label}</p>}
      </div>
      <div class="c9-h-card__meta">
        {statusChip(s)}
        <span class="c9-h-card__players"><IconUsers size={16} />{s.players} {s.players === 1 ? 'player' : 'players'}</span>
      </div>
      <div class="c9-h-card__action">
        {mine ? (
          <a class="yy-btn yy-btn--accent c9-h-card__btn" href={`/play/${s.code}`} onClick={linkClick}>Rejoin<IconArrowRight size={18} /></a>
        ) : s.joinOpen ? (
          <a class="yy-btn yy-btn--primary c9-h-card__btn" href={`/join/${s.code}`} onClick={linkClick}>Join<IconArrowRight size={18} /></a>
        ) : (
          <button class="yy-btn c9-h-card__btn" disabled>Joining closed</button>
        )}
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul class="c9-h-list" aria-busy="true" aria-label="Loading live quizzes">
      {[0, 1].map((i) => (
        <li key={i} class="yy-card c9-h-card c9-h-skel">
          <span class="c9-h-skel__bar" style={{ width: '62%', height: '22px' }} />
          <span class="c9-h-skel__bar" style={{ width: '38%' }} />
          <span class="c9-h-skel__bar" style={{ width: '50%' }} />
        </li>
      ))}
    </ul>
  );
}
