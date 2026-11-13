// Projector: cumulative EVENT leaderboard at /present/event/:id. Polls the public board every 5s (paused when hidden).
import { useEffect, useState } from 'preact/hooks';
import type { PublicEventBoard } from '../../../../shared/api';
import { get, HttpError } from '../../lib/api';
import { query } from '../../lib/router';
import { useTick } from '../../lib/ws';
import { Brand, Sparkle, HalfCircle, Flower } from '../../lib/brand';
import { eventBoardFixture } from '../../dev/presentFixtures';
import './present.css';

const POLL_MS = 5000;
type Entry = PublicEventBoard['top'][number];

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function PresentEvent(props: { id: string }) {
  const fx = (() => { const f = query('fixture'); return f ? eventBoardFixture(f) : null; })();
  const [board, setBoard] = useState<PublicEventBoard | null>(fx && fx !== 'not_found' ? fx : null);
  const [gotAt, setGotAt] = useState<number>(fx && fx !== 'not_found' ? Date.now() - 3000 : 0);
  const [notFound, setNotFound] = useState(fx === 'not_found');
  const [failing, setFailing] = useState(false);

  useEffect(() => {
    const t = query('theme');
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t);
    return () => { if (prev === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prev); };
  }, []);

  useEffect(() => {
    if (fx) return;
    let alive = true;
    let inflight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const b = await get<PublicEventBoard>(`/api/public/events/${encodeURIComponent(props.id)}/leaderboard`);
        if (!alive) return;
        setBoard(b); setGotAt(Date.now()); setFailing(false); setNotFound(false);
      } catch (e) {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 404) setNotFound(true);
        else setFailing(true);
      } finally { inflight = false; }
    };
    const start = () => { clearInterval(timer); timer = setInterval(load, POLL_MS); };
    const onVis = () => { if (document.visibilityState === 'visible') { load(); start(); } else clearInterval(timer); };
    load(); start();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  useEffect(() => {
    document.title = board ? `${board.eventName} · Leaderboard` : 'CCD Kochi Live Quiz · Event leaderboard';
  }, [board?.eventName]);

  useTick(1000, !!board);

  if (notFound && !board) {
    return (
      <div class="c9-pr c9-pr--msg">
        <div class="c9-pr-msg">
          <span class="c9-pr-logo"><Brand size="lg" /></span>
          <h1>Event not found</h1>
          <p>Check the link with your moderator.</p>
        </div>
      </div>
    );
  }
  if (!board) {
    return (
      <div class="c9-pr c9-pr--msg">
        <div class="c9-pr-msg">
          <span class="c9-pr-logo"><Brand size="lg" /></span>
          <p>{failing ? 'Reconnecting…' : 'Loading leaderboard…'}</p>
        </div>
      </div>
    );
  }

  const top = board.top.slice(0, 10);
  const podium = top.slice(0, 3);
  const rest = top.slice(3);
  const ago = Math.max(0, Math.round((Date.now() - gotAt) / 1000));

  return (
    <div class="c9-pr c9-pe">
      <header class="c9-pr-top">
        <span class="c9-pr-logo"><Brand size="lg" /></span>
        <span class="c9-spacer" />
        {failing && <span class="c9-conn c9-conn--off">Reconnecting…</span>}
        <span class="c9-pe-updated">updated {ago < 2 ? 'just now' : `${ago}s ago`}</span>
      </header>
      <main class="c9-pe-main">
        <div class="c9-pr-board__head c9-pe-head">
          <h1>{board.eventName} <span>· Leaderboard</span></h1>
          {board.total > 0 && <span class="c9-pr-pill">{fmt(board.total)} {board.total === 1 ? 'player' : 'players'}</span>}
        </div>
        {top.length === 0 ? (
          <div class="c9-pe-empty">
            <span class="c9-pe-empty__icons"><Sparkle size={56} /><HalfCircle size={56} /><Flower size={56} /></span>
            <p>Scores appear here after the first quiz</p>
          </div>
        ) : (
          <div class={`c9-pe-body ${rest.length ? '' : 'is-solo'}`}>
            <div class="c9-pe-podium">
              {[podium[1], podium[0], podium[2]].map((x, i) => x ? <PodiumCol key={x.rank} x={x} /> : <div key={`e${i}`} class="c9-pe-col" />)}
            </div>
            {rest.length > 0 && (
              <div class="c9-pe-list">
                <div class="c9-pe-list__head"><span>#</span><span>Name</span><span>Quizzes</span><span>Score</span></div>
                <ol class="c9-pe-rows">
                  {rest.map((x) => (
                    <li key={`${x.rank}-${x.name}`} class="c9-pe-row">
                      <span class="c9-pe-row__rank">{x.rank}</span>
                      <span class="c9-pe-row__name">{x.name}</span>
                      <span class="c9-pe-row__played">{x.quizzesPlayed}</span>
                      <span class="c9-pe-row__score">{fmt(x.score)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function PodiumCol({ x }: { x: Entry }) {
  const Sym = x.rank === 1 ? Sparkle : x.rank === 2 ? HalfCircle : Flower;
  return (
    <div class={`c9-pe-col is-r${x.rank}`}>
      <span class="c9-pe-col__sym"><Sym size={x.rank === 1 ? 72 : 56} /></span>
      <div class="c9-pe-col__name">{x.name}</div>
      <div class="c9-pe-col__score">{fmt(x.score)}</div>
      <div class="c9-pe-col__played">{x.quizzesPlayed} {x.quizzesPlayed === 1 ? 'quiz' : 'quizzes'}</div>
      <div class="c9-pe-col__block"><span>{x.rank}</span></div>
    </div>
  );
}
