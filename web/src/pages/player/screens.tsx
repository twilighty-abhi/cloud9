// Participant room screens, rendered from the server PlayerSnapshot. One action per screen.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PlayerSnapshot, ClientMsg } from '../../../../shared/protocol';
import { useTick } from '../../lib/ws';
import type { ConnStatus } from '../../lib/ws';
import { linkClick } from '../../lib/router';
import { LiveShell, Message, fmtNum } from './parts';
import { IconCheck, IconX, IconMinus, IconLock, IconClock, IconUsers } from './icons';

export interface ConnLike { status: ConnStatus; now: () => number; send: (m: ClientMsg) => boolean }
type Picked = { qIndex: number; choice: number } | null;

const LETTERS = ['A', 'B', 'C', 'D'];

export function RoomView({ snap, conn }: { snap: PlayerSnapshot; conn: ConnLike }) {
  const [picked, setPicked] = useState<Picked>(null);
  const q = snap.question;

  // If the tap happened while offline (or the socket dropped before the ack), resend once we're back.
  useEffect(() => {
    if (conn.status !== 'open' || !picked || snap.myAnswer || snap.state !== 'QUESTION' || !q || q.qIndex !== picked.qIndex) return;
    conn.send({ t: 'answer', qIndex: picked.qIndex, choice: picked.choice });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.status]);

  const answer = (choice: number) => {
    if (!q) return;
    setPicked({ qIndex: q.qIndex, choice });
    try { navigator.vibrate?.(30); } catch { /* not supported */ }
    conn.send({ t: 'answer', qIndex: q.qIndex, choice });
  };

  const myChoice = snap.myAnswer ? snap.myAnswer.choice : picked && q && picked.qIndex === q.qIndex ? picked.choice : null;

  let body;
  let tone: string | undefined;
  switch (snap.state) {
    case 'LOBBY': body = <Lobby snap={snap} />; break;
    case 'QUESTION': body = q ? <Question snap={snap} conn={conn} myChoice={myChoice} onAnswer={answer} /> : <Lobby snap={snap} />; break;
    case 'CLOSED': body = <Closed snap={snap} myChoice={myChoice} />; break;
    case 'REVEAL': {
      const r = snap.reveal;
      tone = !r ? undefined : r.correct ? 'success' : snap.myAnswer ? 'danger' : undefined;
      body = <Reveal snap={snap} />; break;
    }
    case 'LEADERBOARD': body = <Leaderboard snap={snap} />; break;
    case 'FINISHED': body = <Finished snap={snap} />; break;
  }
  return (
    <LiveShell title={snap.title} score={snap.me.score} status={conn.status} tone={tone}>
      <div class="c9-p-screen" key={`${snap.state}-${q ? q.qIndex : -1}`}>{body}</div>
    </LiveShell>
  );
}

function Lobby({ snap }: { snap: PlayerSnapshot }) {
  return (
    <div class="c9-p-lobby">
      <div class="c9-p-breathe" aria-hidden="true">
        <span class="c9-p-breathe__ring" />
        <span class="c9-p-breathe__ring c9-p-breathe__ring--2" />
        <span class="c9-logo__mark c9-p-breathe__mark">9</span>
      </div>
      <h1 class="c9-p-display">You're in, {snap.me.name}!</h1>
      <p class="c9-p-lead">Waiting for the host to start</p>
      {snap.label && <p class="c9-muted c9-p-small">{snap.label}</p>}
      <p class="c9-muted c9-p-small c9-p-tip">Keep this page open. Questions appear here on their own.</p>
    </div>
  );
}

function Question({ snap, conn, myChoice, onAnswer }: { snap: PlayerSnapshot; conn: ConnLike; myChoice: number | null; onAnswer: (c: number) => void }) {
  const q = snap.question!;
  const limit = Math.max(1000, q.timeLimitSec * 1000);
  const remaining = Math.max(0, q.endsAt - conn.now());
  useTick(200, remaining > 0);
  const frac = Math.min(1, remaining / limit);
  const secs = Math.ceil(remaining / 1000);
  const locked = myChoice !== null;
  const timeUp = remaining <= 0 && !locked;
  const urgent = secs <= 5;
  // Long questions get a smaller (clamped) font so the answers stay on screen on small phones (#16).
  const len = q.text.length;
  const textSize = len > 200 ? 'c9-p-q__text--xlong' : len > 110 ? 'c9-p-q__text--long' : '';

  return (
    <div class={`c9-p-q ${q.imageUrl ? 'c9-p-q--img' : ''}`}>
      <div class="c9-p-q__head">
      <div class="c9-p-q__meta">
        <span class="c9-overline">Question {q.qIndex + 1} of {q.total}</span>
        <span class={`c9-p-timer ${urgent ? 'c9-p-timer--urgent' : ''}`} aria-label={`${secs} seconds left`}>
          <IconClock size={16} />{secs}s
        </span>
      </div>
      <div class={`yy-progress c9-p-q__bar ${urgent ? 'c9-p-q__bar--urgent' : ''}`} role="presentation">
        <span style={{ transform: `scaleX(${frac})` }} />
      </div>
      </div>
      <h1 class={`c9-p-q__text ${textSize}`}>{q.text}</h1>
      {q.imageUrl && <QImage src={q.imageUrl} />}

      {timeUp ? (
        <div class="c9-p-panel">
          <span class="c9-p-badge c9-p-badge--neutral"><IconClock size={28} /></span>
          <h2 class="c9-p-panel__title">Time's up</h2>
          <p class="c9-muted">You didn't answer this one. Get ready for the next question.</p>
        </div>
      ) : (
        <>
          <div class={`c9-p-opts ${locked ? 'c9-p-opts--locked' : ''}`} role="group" aria-label="Answers">
            {q.options.map((opt, i) => {
              const mine = myChoice === i;
              return (
                <button key={i} type="button" class={`c9-p-opt c9-p-opt--${i} ${mine ? 'is-mine' : ''}`}
                  disabled={locked} aria-pressed={mine} onClick={() => onAnswer(i)}>
                  <span class="c9-p-opt__key" aria-hidden="true">{mine ? <IconCheck size={20} stroke={3} /> : LETTERS[i]}</span>
                  <span class="c9-p-opt__text"><span class="c9-sr">{LETTERS[i]}: </span>{opt}</span>
                </button>
              );
            })}
          </div>
          {locked && (
            <p class="c9-p-locked" role="status">
              <IconLock size={18} />
              <span><strong>Locked in.</strong> {snap.myAnswer ? 'Waiting for the others…' : 'Sending…'}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function QImage({ src }: { src: string }) {
  const [bad, setBad] = useState(false);
  if (bad) return null;
  return <img class="c9-p-q__img" src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />;
}

function OptionTile({ i, text, mark }: { i: number; text: string; mark?: 'check' | 'x' }) {
  return (
    <div class={`c9-p-opt c9-p-opt--${i} c9-p-opt--static`}>
      <span class="c9-p-opt__key" aria-hidden="true">
        {mark === 'check' ? <IconCheck size={20} stroke={3} /> : mark === 'x' ? <IconX size={20} stroke={3} /> : LETTERS[i]}
      </span>
      <span class="c9-p-opt__text"><span class="c9-sr">{LETTERS[i]}: </span>{text}</span>
    </div>
  );
}

function Closed({ snap, myChoice }: { snap: PlayerSnapshot; myChoice: number | null }) {
  const q = snap.question;
  if (myChoice !== null && q) {
    return (
      <div class="c9-p-center c9-p-result">
        <span class="c9-p-badge c9-p-badge--ink"><IconLock size={28} /></span>
        <h1 class="c9-p-display c9-p-display--m">Answer locked</h1>
        <p class="c9-p-lead">Waiting for the reveal</p>
        {q.options[myChoice] !== undefined && (
          <div class="c9-p-result__card">
            <span class="c9-overline">Your answer</span>
            <OptionTile i={myChoice} text={q.options[myChoice]} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div class="c9-p-center c9-p-result">
      <span class="c9-p-badge c9-p-badge--neutral"><IconClock size={28} /></span>
      <h1 class="c9-p-display c9-p-display--m">Time's up</h1>
      <p class="c9-p-lead">You didn't answer this one. The reveal is coming.</p>
    </div>
  );
}

function rankLine(rank: number | null, count: number) {
  if (!rank) return null;
  return <p class="c9-p-rank">You're <strong>#{rank}</strong> <span class="c9-muted">of {count}</span></p>;
}

function Reveal({ snap }: { snap: PlayerSnapshot }) {
  const q = snap.question;
  const r = snap.reveal;
  const answered = snap.myAnswer !== null;
  const correct = !!r?.correct;
  const kind = !answered ? 'none' : correct ? 'correct' : 'wrong';
  const ci = r ? r.correctIndex : -1;
  return (
    <div class="c9-p-center c9-p-result">
      <span class={`c9-p-badge c9-p-badge--xl c9-p-badge--${kind === 'correct' ? 'success' : kind === 'wrong' ? 'danger' : 'neutral'} c9-p-pop`}>
        {kind === 'correct' ? <IconCheck size={44} stroke={3} /> : kind === 'wrong' ? <IconX size={44} stroke={3} /> : <IconMinus size={44} stroke={3} />}
      </span>
      <h1 class="c9-p-display">{kind === 'correct' ? 'Correct!' : kind === 'wrong' ? 'Not quite' : 'No answer'}</h1>
      <p class={`c9-p-points ${kind === 'correct' ? 'c9-p-points--win' : ''}`}>+{fmtNum(r?.points ?? 0)} <small>points</small></p>
      {rankLine(snap.me.rank, snap.playerCount)}
      {q && ci >= 0 && q.options[ci] !== undefined && (
        <div class="c9-p-result__card">
          <span class="c9-overline">Correct answer</span>
          <OptionTile i={ci} text={q.options[ci]} mark="check" />
          {kind === 'wrong' && snap.myAnswer && q.options[snap.myAnswer.choice] !== undefined && (
            <p class="c9-p-small c9-muted">You picked {LETTERS[snap.myAnswer.choice]}: {q.options[snap.myAnswer.choice]}</p>
          )}
        </div>
      )}
    </div>
  );
}

type TopRow = { key: string; name: string; score: number; rank: number; me: boolean };

/** Compact top-3 board: medal rows + a "You're #N" footer when I'm not in the top 3. */
function TopBoard({ title, rows, footer, emptyText }: { title: string; rows: TopRow[]; footer: ComponentChildren | null; emptyText: string }) {
  return (
    <section class="c9-p-top" aria-label={title}>
      <h2 class="c9-p-top__title">{title}</h2>
      {rows.length > 0 ? (
        <ol class="c9-p-top__list">
          {rows.map((r) => (
            <li key={r.key} class={`c9-p-top__row ${r.me ? 'is-me' : ''}`}>
              <span class={`c9-p-medal c9-p-medal--${r.rank}`} aria-label={`Rank ${r.rank}`}>{r.rank}</span>
              <span class="c9-p-top__name">{r.name}{r.me && <span class="c9-p-you">You</span>}</span>
              <span class="c9-p-top__score">{fmtNum(r.score)}</span>
            </li>
          ))}
        </ol>
      ) : <p class="c9-p-top__empty">{emptyText}</p>}
      {footer && <p class="c9-p-top__me">{footer}</p>}
    </section>
  );
}

function QuizTop({ snap }: { snap: PlayerSnapshot }) {
  const top = (snap.leaderboard ?? []).slice(0, 3);
  const rows: TopRow[] = top.map((e) => ({ key: e.playerId, name: e.name, score: e.score, rank: e.rank, me: e.playerId === snap.me.id }));
  const inTop = rows.some((r) => r.me);
  const rank = snap.me.rank;
  const footer = !inTop && rank !== null
    ? <>You're <strong>#{rank}</strong> <span class="c9-nw">· {fmtNum(snap.me.score)} pts</span></>
    : null;
  return <TopBoard title="This quiz" rows={rows} footer={footer} emptyText="No scores yet." />;
}

function EventTop({ snap }: { snap: PlayerSnapshot }) {
  const ev = snap.eventBoard;
  if (!ev) return null;
  const me = ev.me;
  const rows: TopRow[] = ev.top.slice(0, 3).map((e) => ({ key: `${e.rank}-${e.name}`, name: e.name, score: e.score, rank: e.rank, me: !!me && me.rank === e.rank }));
  const footer = me
    ? <>You're <strong>#{me.rank}</strong> of {fmtNum(ev.total)} in {ev.eventName} <span class="c9-nw">· {fmtNum(me.score)} pts</span></>
    : null;
  return <TopBoard title={ev.eventName} rows={rows} footer={footer} emptyText="Event scores appear after this quiz." />;
}

function Leaderboard({ snap }: { snap: PlayerSnapshot }) {
  const q = snap.question;
  return (
    <div class="c9-p-lb">
      <div class="c9-p-lb__head">
        {q && <span class="c9-overline">After question {q.qIndex + 1} of {q.total}</span>}
        <h1 class="c9-p-display c9-p-display--m">Leaderboard</h1>
      </div>
      <QuizTop snap={snap} />
      <EventTop snap={snap} />
    </div>
  );
}

function Finished({ snap }: { snap: PlayerSnapshot }) {
  const rank = snap.me.rank;
  return (
    <div class="c9-p-fin">
      <div class="c9-p-fin__me">
        <span class="c9-overline">Final results</span>
        {rank !== null ? (
          <>
            <p class="c9-p-fin__rank">#{rank}</p>
            <p class="c9-p-lead">of {snap.playerCount} {snap.playerCount === 1 ? 'player' : 'players'} · <strong>{fmtNum(snap.me.score)}</strong> points</p>
          </>
        ) : (
          <p class="c9-p-lead"><strong>{fmtNum(snap.me.score)}</strong> points</p>
        )}
      </div>
      <QuizTop snap={snap} />
      <EventTop snap={snap} />
      <div class="c9-p-fin__end">
        <h2 class="c9-p-fin__thanks">Thanks for playing</h2>
        <a class="yy-btn yy-btn--secondary yy-btn--lg c9-p-wide" href="/" onClick={linkClick}>Back to home</a>
      </div>
    </div>
  );
}

export function Kicked() {
  return <Message title="You were removed from this quiz" body="The host removed you from this quiz. If you think this was a mistake, talk to the host." home />;
}
