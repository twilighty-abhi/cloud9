// Shared player chrome: plain shell (logo header), message screen, live top bar.
import type { ComponentChildren } from 'preact';
import { linkClick } from '../../lib/router';
import type { ConnStatus } from '../../lib/ws';
import './player.css';
import { Brand } from '../../lib/brand';

export function Shell(props: { children: ComponentChildren }) {
  return (
    <div class="c9-page c9-p">
      <header class="c9-p-bar">
        <div class="c9-p-bar__inner">
          <a href="/" class="c9-logo" onClick={linkClick}><Brand /></a>
        </div>
      </header>
      <main class="c9-p-main">{props.children}</main>
    </div>
  );
}

export function Message(props: { title: string; body?: string; home?: boolean; tone?: 'neutral' | 'danger'; children?: ComponentChildren }) {
  return (
    <Shell>
      <div class="c9-p-msg">
        <h1 class="c9-p-msg__title">{props.title}</h1>
        {props.body && <p class="c9-p-msg__body">{props.body}</p>}
        {props.children}
        {props.home && <a class="yy-btn yy-btn--secondary yy-btn--lg c9-p-wide" href="/" onClick={linkClick}>Go to home page</a>}
      </div>
    </Shell>
  );
}

export function fmtNum(n: number) {
  return Math.round(n).toLocaleString('en-US');
}

export function LiveShell(props: { title: string; score: number | null; status: ConnStatus; children: ComponentChildren; tone?: string }) {
  const off = props.status !== 'open';
  return (
    <div class={`c9-page c9-p ${props.tone ? `c9-p--${props.tone}` : ''}`}>
      <header class="c9-p-bar c9-p-bar--live">
        <div class="c9-p-bar__inner">
          <span class="c9-logo__mark c9-p-bar__mark" aria-hidden="true">9</span>
          <span class="c9-p-bar__title">{props.title}</span>
          {off && <span class="c9-conn c9-conn--off c9-p-bar__conn" role="status">{props.status === 'closed' ? 'Offline' : 'Reconnecting…'}</span>}
          {props.score !== null && (
            <span class="c9-p-bar__score" aria-label={`Your score: ${props.score}`}>{fmtNum(props.score)}<small>pts</small></span>
          )}
        </div>
      </header>
      <main class="c9-p-main">{props.children}</main>
    </div>
  );
}
