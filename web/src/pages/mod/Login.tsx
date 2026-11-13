import { useState } from 'preact/hooks';
import type { Me } from '../../../../shared/api';
import { HttpError } from '../../lib/api';
import { fixture, fxMeOr, mutate, errMsg, Logo } from './common';

export function Login(props: { onIn: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    setBusy(true); setError(null);
    try {
      const me = await mutate<Me>('POST', '/api/auth/login', { username: username.trim(), password });
      props.onIn(fixture ? fxMeOr() : me);
    } catch (err) {
      setError(err instanceof HttpError && err.status === 401 ? "That username and password don't match. Check them and try again." : errMsg(err));
    } finally { setBusy(false); }
  };

  return (
    <div class="c9-m-center c9-m-loginpage">
      <form class="c9-m-authcard yy-card yy-card--raised" onSubmit={submit} noValidate>
        <Logo />
        <div class="c9-stack c9-m-authcard__head">
          <h1 class="c9-m-h1">Moderator sign in</h1>
          <p class="c9-muted">Run your quiz rooms. Players don't need an account.</p>
        </div>
        <div class="yy-field">
          <label class="yy-label" for="c9-u">Username</label>
          <input id="c9-u" class="yy-input" autoComplete="username" autoCapitalize="none" spellcheck={false}
            value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} aria-invalid={!!error} />
        </div>
        <div class="yy-field">
          <label class="yy-label" for="c9-p">Password</label>
          <input id="c9-p" class="yy-input" type="password" autoComplete="current-password"
            value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} aria-invalid={!!error}
            aria-describedby={error ? 'c9-login-err' : undefined} />
        </div>
        {error && <p id="c9-login-err" class="yy-help yy-help--error" role="alert">{error}</p>}
        <button class="yy-btn yy-btn--primary yy-btn--lg" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
