// Join form for /join/:code — loads PlayInfo, asks for name (+ email), POSTs join, stores the token.
import { useEffect, useState } from 'preact/hooks';
import type { PlayInfo, JoinReq, JoinRes } from '../../../../shared/api';
import { DEFAULTS } from '../../../../shared/model';
import { get, post, HttpError } from '../../lib/api';
import { setPlayer, getLastName, getLastEmail, setLastName, setLastEmail, forgetIdentity } from '../../lib/storage';
import type { StoredPlayer } from '../../lib/storage';
import { Message, Shell } from './parts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Fatal = 'not_found' | 'finished' | 'closed' | 'kicked';

function friendly(e: unknown): { field?: 'name' | 'email'; msg: string; fatal?: Fatal } {
  if (e instanceof HttpError) {
    switch (e.code) {
      case 'not_found': return { msg: "We couldn't find this quiz.", fatal: 'not_found' };
      case 'finished': return { msg: 'This quiz has ended.', fatal: 'finished' };
      case 'join_closed': return { msg: 'Joining is closed for this quiz.', fatal: 'closed' };
      case 'room_full': return { msg: 'This quiz is full right now. Ask the host for help.' };
      case 'email_required': return { field: 'email', msg: 'Add your email to join this quiz.' };
      case 'invalid_email': return { field: 'email', msg: "That email doesn't look right. Check it and try again." };
      case 'invalid_name': return { field: 'name', msg: `Enter a name, up to ${DEFAULTS.nameMax} characters.` };
      case 'kicked': return { msg: 'You were removed from this quiz.', fatal: 'kicked' };
      case 'rate_limited': return { msg: 'Too many tries from this network. Wait a minute and try again.' };
    }
    if (e.status === 404) return { msg: "We couldn't find this quiz.", fatal: 'not_found' };
    if (e.status >= 500) return { msg: 'Cloud 9 hit a snag. Try again in a moment.' };
    return { msg: e.message || 'Something went wrong. Try again.' };
  }
  return { msg: "Can't reach Cloud 9. Check your connection and try again." };
}

export function JoinForm(props: { code: string; fixtureInfo?: PlayInfo; onJoined: (p: StoredPlayer) => void }) {
  const { code } = props;
  const [info, setInfo] = useState<PlayInfo | null>(props.fixtureInfo ?? null);
  const [infoErr, setInfoErr] = useState<'not_found' | 'network' | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const [name, setName] = useState(() => getLastName().slice(0, DEFAULTS.nameMax));
  const [email, setEmail] = useState(() => getLastEmail());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: 'name' | 'email'; msg: string } | null>(null);
  const [retry, setRetry] = useState(0);
  // Name/email remembered from an earlier join on this device (#20): offer a one-tap reset for shared devices.
  const [remembered, setRemembered] = useState(() => getLastName().slice(0, DEFAULTS.nameMax));

  useEffect(() => {
    if (props.fixtureInfo) return;
    if (!/^\d{6}$/.test(code)) { setInfoErr('not_found'); return; }
    let alive = true;
    setInfoErr(null);
    get<PlayInfo>(`/api/play/${code}`)
      .then((i) => { if (alive) setInfo(i); })
      .catch((e) => { if (alive) setInfoErr(e instanceof HttpError && e.status === 404 ? 'not_found' : 'network'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, retry]);

  if (infoErr === 'not_found' || fatal === 'not_found') {
    return <Message title="Quiz not found" body={`There's no live quiz with the code ${fmtCode(code)}. Check the code on the screen and try again.`} home />;
  }
  if (infoErr === 'network') {
    return (
      <Message title="Can't reach Cloud 9" body="Check your Wi-Fi or mobile data, then try again.">
        <button class="yy-btn yy-btn--primary yy-btn--lg c9-p-wide" onClick={() => setRetry((r) => r + 1)}>Try again</button>
      </Message>
    );
  }
  if (!info) return <Shell><div class="c9-p-center"><div class="c9-p-spinner" aria-label="Loading" /></div></Shell>;
  if (fatal === 'kicked') {
    return <Message title="You were removed from this quiz" body="The host removed you from this quiz. If you think this was a mistake, talk to the host." home />;
  }
  if (info.state === 'FINISHED' || fatal === 'finished') {
    return <Message title="This quiz has ended" body="Thanks for stopping by. Look for another live quiz on the home page." home />;
  }
  if (!info.joinOpen || fatal === 'closed') {
    return <Message title="Joining is closed" body="The host has closed joining for this quiz. Ask them if you think this is a mistake." home />;
  }

  const emailShown = info.emailMode !== 'off';
  const emailRequired = info.emailMode === 'required';

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    const m = email.trim();
    if (!n) { setErr({ field: 'name', msg: 'Enter your name so the host knows who you are.' }); return; }
    if (emailShown && emailRequired && !m) { setErr({ field: 'email', msg: 'Add your email to join this quiz.' }); return; }
    if (emailShown && m && !EMAIL_RE.test(m)) { setErr({ field: 'email', msg: "That email doesn't look right. Check it and try again." }); return; }
    setErr(null); setBusy(true);
    if (props.fixtureInfo) { setBusy(false); return; }
    try {
      const body: JoinReq = emailShown && m ? { name: n, email: m } : { name: n };
      const res = await post<JoinRes>(`/api/play/${code}/join`, body);
      const p: StoredPlayer = { playerId: res.playerId, token: res.token, name: res.name, joinedAt: Date.now() };
      setPlayer(code, p);
      setLastName(n);
      if (emailShown && m) setLastEmail(m);
      props.onJoined(p);
    } catch (ex) {
      const f = friendly(ex);
      if (f.fatal) setFatal(f.fatal);
      setErr(f);
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form class="c9-p-join" onSubmit={submit} noValidate>
        <div class="c9-p-join__head">
          {info.eventName && <span class="c9-overline c9-p-join__event">{info.eventName}</span>}
          <span class="c9-overline">Code {fmtCode(code)}</span>
          <h1 class="c9-p-join__title">{info.title}</h1>
          {info.label && <p class="c9-p-join__label">{info.label}</p>}
        </div>
        {remembered && name === remembered && (
          <p class="c9-muted c9-p-small c9-p-notme--join">
            Filled in from <strong>{remembered}</strong> on this device · <button type="button" class="c9-p-link"
              onClick={() => { forgetIdentity(); setName(''); setEmail(''); setRemembered(''); document.getElementById('c9-p-name')?.focus(); }}>Not you?</button>
          </p>
        )}
        <div class="yy-field">
          <label class="yy-label" for="c9-p-name">Your name</label>
          <input id="c9-p-name" class="yy-input c9-p-input" type="text" autoComplete="nickname" autoFocus
            maxLength={DEFAULTS.nameMax} value={name} placeholder="Shown on the leaderboard"
            aria-invalid={err?.field === 'name' ? 'true' : undefined}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          {err?.field === 'name' && <p class="yy-help yy-help--error" role="alert">{err.msg}</p>}
        </div>
        {emailShown && (
          <div class="yy-field">
            <label class="yy-label" for="c9-p-email">
              Email {emailRequired
                ? <span class="c9-p-req">(required{info.eventName ? ' — used for the event leaderboard' : ''})</span>
                : <span class="yy-optional">(optional)</span>}
            </label>
            <input id="c9-p-email" class="yy-input c9-p-input" type="email" inputMode="email" autoComplete="email"
              required={emailRequired} aria-required={emailRequired ? 'true' : undefined}
              maxLength={DEFAULTS.emailMax} value={email} placeholder="you@example.com"
              aria-invalid={err?.field === 'email' ? 'true' : undefined}
              onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)} />
            {err?.field === 'email'
              ? <p class="yy-help yy-help--error" role="alert">{err.msg}</p>
              : <p class="yy-help">{info.eventName ? 'Use the same email in every quiz so your points add up. Only the hosts see it.' : 'Only the host can see this.'}</p>}
          </div>
        )}
        {err && !err.field && <p class="yy-help yy-help--error c9-p-join__err" role="alert">{err.msg}</p>}
        <button class="yy-btn yy-btn--primary yy-btn--lg c9-p-wide c9-p-join__btn" type="submit" disabled={busy}>
          {busy ? 'Joining…' : 'Join quiz'}
        </button>
      </form>
    </Shell>
  );
}

export function fmtCode(code: string) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
