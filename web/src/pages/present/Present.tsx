// Projector view (read-only). Owned by agent D.
import { useEffect, useState } from 'preact/hooks';
import type { HostSnapshot } from '../../../../shared/protocol';
import type { LeaderEntry } from '../../../../shared/model';
import { useRoom, useTick, type RoomConn } from '../../lib/ws';
import { query } from '../../lib/router';
import { hostFixture } from '../../dev/modFixtures';
import { presentFixture } from '../../dev/presentFixtures';
import { LETTERS, qrSrc, fmtNum } from '../mod/common';
import './present.css';
import { Brand } from '../../lib/brand';

type Conn = RoomConn<HostSnapshot>;

export function Present(props: { code: string }) {
  const [fxSnap] = useState(() => { const f = query('fixture'); return f ? (presentFixture(f) ?? hostFixture(f)) : null; });
  const live = useRoom<HostSnapshot>(fxSnap ? null : { role: 'present', code: props.code });
  const conn: Conn = fxSnap ? { snap: fxSnap, status: 'open', fatal: null, lastError: null, now: () => Date.now(), send: () => true } : live;
  const snap = conn.snap;

  useEffect(() => {
    // ?theme=dark|light forces a theme on the projector
    const t = query('theme');
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t);
    return () => { if (prev === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prev); };
  }, []);
  useEffect(() => { document.title = snap ? `${snap.title} · CCD Kochi Live Quiz` : 'CCD Kochi Live Quiz · Present'; }, [snap?.title]);

  if (conn.fatal === 'not_found') {
    return (
      <div class="c9-pr c9-pr--msg">
        <div class="c9-pr-msg">
          <span class="c9-pr-logo"><Brand size="lg" /></span>
          <h1>No room with code <span class="c9-mono">{props.code}</span></h1>
          <p>Check the code with your moderator. The quiz may have ended.</p>
        </div>
      </div>
    );
  }
  if (!snap) {
    return (
      <div class="c9-pr c9-pr--msg">
        <div class="c9-pr-msg">
          <span class="c9-pr-logo"><Brand size="lg" /></span>
          <p>{conn.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</p>
        </div>
      </div>
    );
  }

  const shortUrl = snap.joinUrl.replace(/^https?:\/\//, '');
  const showQ = snap.question && (snap.state === 'QUESTION' || snap.state === 'CLOSED' || snap.state === 'REVEAL');

  return (
    <div class={`c9-pr c9-pr--${snap.state.toLowerCase()}`}>
      <header class="c9-pr-top">
        <span class="c9-pr-logo"><Brand size="lg" /></span>
        {snap.eventName && <span class="c9-pr-top__event">{snap.eventName}</span>}
        <span class="c9-pr-top__title">{snap.title}{snap.label && <span> · {snap.label}</span>}</span>
        <span class="c9-spacer" />
        {snap.state !== 'LOBBY' && snap.joinOpen && (
          <span class="c9-pr-top__join">Join: <strong>{shortUrl.replace(/\/join\/\d+$/, '')}</strong> · code <strong class="c9-mono">{snap.code}</strong></span>
        )}
        {conn.status !== 'open' && <span class="c9-conn c9-conn--off">Reconnecting…</span>}
      </header>

      {snap.state === 'LOBBY' && <Lobby snap={snap} shortUrl={shortUrl} />}
      {showQ && <QuestionView conn={conn} snap={snap} />}
      {snap.eventBoard && (snap.state === 'LEADERBOARD' || snap.state === 'FINISHED')
        ? <DualBoard snap={snap} ev={snap.eventBoard} />
        : <>
          {snap.state === 'LEADERBOARD' && <Board snap={snap} />}
          {snap.state === 'FINISHED' && <Podium entries={snap.leaderboard} players={snap.playerCount} />}
        </>}
    </div>
  );
}

function Lobby({ snap, shortUrl }: { snap: HostSnapshot; shortUrl: string }) {
  const names = snap.players.slice(-40).reverse();
  return (
    <main class="c9-pr-lobby">
      <div class="c9-pr-lobby__qr"><img src={qrSrc(snap.code)} alt="" /></div>
      <div class="c9-pr-lobby__info">
        <div class="c9-pr-over">Scan the QR or go to</div>
        <div class="c9-pr-lobby__url">{shortUrl.replace(/\/join\/\d+$/, '')}</div>
        <div class="c9-pr-over" style={{ marginTop: '3vh' }}>and enter code</div>
        <div class="c9-pr-lobby__code c9-mono">{snap.code.slice(0, 3)}<span>{snap.code.slice(3)}</span></div>
        <div class="c9-pr-lobby__count">
          <strong>{fmtNum(snap.playerCount)}</strong> {snap.playerCount === 1 ? 'player' : 'players'} joined
          {!snap.joinOpen && <span class="c9-pr-closed">Joining closed</span>}
        </div>
        <ul class="c9-pr-names" aria-label="Players">
          {names.map((p) => <li key={p.id}>{p.name}</li>)}
          {snap.players.length > names.length && <li class="c9-pr-names__more">+{fmtNum(snap.players.length - names.length)} more</li>}
        </ul>
      </div>
    </main>
  );
}

function QuestionView({ conn, snap }: { conn: Conn; snap: HostSnapshot }) {
  const q = snap.question!;
  const active = snap.state === 'QUESTION';
  useTick(250, active);
  const total = q.endsAt - q.startedAt;
  const left = active ? Math.max(0, q.endsAt - conn.now()) : 0;
  const frac = total > 0 ? left / total : 0;
  const secs = Math.ceil(left / 1000);
  const dist = snap.state !== 'QUESTION' ? snap.distribution : null;
  const sum = dist ? dist.reduce((a, b) => a + b, 0) : 0;
  const reveal = snap.state === 'REVEAL' && snap.correctIndex !== null;
  const r = 44, c = 2 * Math.PI * r;

  return (
    <main class="c9-pr-q">
      <div class="c9-pr-q__head">
        <div class="c9-pr-q__meta">
          <span class="c9-pr-pill">Question {q.qIndex + 1} / {q.total}</span>
          {snap.state === 'CLOSED' && <span class="c9-pr-pill c9-pr-pill--muted">Time's up</span>}
          {reveal && <span class="c9-pr-pill c9-pr-pill--ok">Answer</span>}
        </div>
        <div class="c9-pr-q__right">
          <div class="c9-pr-answered"><strong>{fmtNum(snap.answered)}</strong><span>answered</span></div>
          {active && (
            <div class={`c9-pr-ring ${secs <= 5 ? 'is-low' : ''}`} role="timer">
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r={r} class="c9-pr-ring__track" />
                <circle cx="50" cy="50" r={r} class="c9-pr-ring__bar" style={{ strokeDasharray: c, strokeDashoffset: c * (1 - frac) }} />
              </svg>
              <span>{secs}</span>
            </div>
          )}
        </div>
      </div>
      <div class={`c9-pr-q__body ${q.imageUrl ? 'has-img' : ''}`}>
        <h1 class={`c9-pr-q__text ${q.text.length > 120 ? 'is-long' : ''}`}>{q.text}</h1>
        {q.imageUrl && <img class="c9-pr-q__img" src={q.imageUrl} alt="" />}
      </div>
      <ul class={`c9-pr-tiles c9-pr-tiles--n${q.options.length} ${reveal ? 'is-reveal' : ''}`}>
        {q.options.map((o, i) => {
          const n = dist?.[i] ?? 0;
          const pct = sum ? Math.round((n / sum) * 100) : 0;
          const correct = reveal && snap.correctIndex === i;
          return (
            <li class={`c9-pr-tile c9-pr-tile--${i} ${correct ? 'is-correct' : ''}`}>
              <span class="c9-pr-tile__letter">{correct ? '✓' : LETTERS[i]}</span>
              <span class={`c9-pr-tile__text ${o.length > 60 ? 'is-long' : ''}`}>{o}</span>
              {dist && (
                <span class="c9-pr-tile__dist">
                  <span class="c9-pr-tile__bar"><span style={{ width: `${pct}%` }} /></span>
                  <span class="c9-pr-tile__n">{n} <small>{pct}%</small></span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function Board({ snap }: { snap: HostSnapshot }) {
  const e = snap.leaderboard.slice(0, 10);
  return (
    <main class="c9-pr-board">
      <div class="c9-pr-board__head">
        <h1>Leaderboard</h1>
        <span class="c9-pr-pill">After question {snap.qIndex + 1} / {snap.total}</span>
      </div>
      <ol class="c9-pr-lb">
        {e.map((x) => <Row x={x} />)}
      </ol>
    </main>
  );
}

type RowLike = { name: string; score: number; rank: number };

/** Quiz top 10 + event top 10 side by side (LEADERBOARD and FINISHED when the session is in an event). */
function DualBoard({ snap, ev }: { snap: HostSnapshot; ev: NonNullable<HostSnapshot['eventBoard']> }) {
  const fin = snap.state === 'FINISHED';
  const quiz = snap.leaderboard.slice(0, 10);
  const evTop = ev.top.slice(0, 10);
  return (
    <main class="c9-pr-board c9-pr-dual">
      <div class="c9-pr-board__head">
        <h1>{fin ? 'Final results' : 'Leaderboard'}</h1>
        <span class="c9-pr-pill">{fin ? `${fmtNum(snap.playerCount)} players · thanks for playing!` : `After question ${snap.qIndex + 1} / ${snap.total}`}</span>
      </div>
      <div class="c9-pr-dual__cols">
        <section class="c9-pr-dual__col">
          <h2 class="c9-pr-dual__title">This quiz <span>top 10</span></h2>
          {quiz.length ? <ol class="c9-pr-lb c9-pr-lb--one">{quiz.map((x) => <Row key={x.playerId} x={x} />)}</ol>
            : <p class="c9-pr-over">No scores yet.</p>}
        </section>
        <section class="c9-pr-dual__col c9-pr-dual__col--event">
          <h2 class="c9-pr-dual__title">{ev.eventName} leaderboard <span>{fmtNum(ev.total)} players</span></h2>
          {evTop.length ? <ol class="c9-pr-lb c9-pr-lb--one">{evTop.map((x) => <Row key={`${x.rank}-${x.name}`} x={x} />)}</ol>
            : <p class="c9-pr-over">Event scores appear after this quiz.</p>}
        </section>
      </div>
    </main>
  );
}

function Row({ x }: { x: RowLike }) {
  return (
    <li class={`c9-pr-lb__row ${x.rank <= 3 ? `is-r${x.rank}` : ''}`}>
      <span class="c9-pr-lb__rank">{x.rank}</span>
      <span class="c9-pr-lb__name">{x.name}</span>
      <span class="c9-pr-lb__score">{fmtNum(x.score)}</span>
    </li>
  );
}

function Podium({ entries, players }: { entries: LeaderEntry[]; players: number }) {
  const top = entries.slice(0, 3);
  const rest = entries.slice(3, 10);
  const order = [top[1], top[0], top[2]].filter(Boolean) as LeaderEntry[];
  return (
    <main class="c9-pr-final">
      <div class="c9-pr-board__head">
        <h1>Final results</h1>
        <span class="c9-pr-pill">{fmtNum(players)} players · thanks for playing!</span>
      </div>
      {top.length === 0 ? <p class="c9-pr-over">No scores this time.</p> : (
        <div class="c9-pr-podium">
          {order.map((x) => (
            <div class={`c9-pr-podium__col is-r${x.rank}`}>
              <div class="c9-pr-podium__name">{x.name}</div>
              <div class="c9-pr-podium__score">{fmtNum(x.score)}</div>
              <div class="c9-pr-podium__block"><span>{x.rank}</span></div>
            </div>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <ol class="c9-pr-rest">
          {rest.map((x) => <li><span class="c9-pr-rest__rank">{x.rank}</span><span class="c9-pr-rest__name">{x.name}</span><span class="c9-pr-rest__score">{fmtNum(x.score)}</span></li>)}
        </ol>
      )}
    </main>
  );
}
