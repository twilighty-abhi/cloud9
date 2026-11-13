// Moderator app: auth gate + routing for /mod/**. Owned by agent D.
import { useEffect, useState } from 'preact/hooks';
import type { Me } from '../../../../shared/api';
import { HttpError } from '../../lib/api';
import { match } from '../../lib/router';
import { fixturePath } from '../../dev/modFixtures';
import { fixture, load, errMsg, Logo } from './common';
import { Login } from './Login';
import { Dashboard } from './Dashboard';
import { QuizEditor } from './QuizEditor';
import { Import } from './Import';
import { Room } from './Room';
import './mod.css';

type AuthState = { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; me: Me } | { kind: 'error'; message: string };

export function ModApp(props: { path: string }) {
  const path = fixture ? fixturePath(fixture) : props.path;
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  const check = () => {
    setAuth({ kind: 'loading' });
    load<Me>('/api/me')
      .then((me) => setAuth({ kind: 'in', me }))
      .catch((e) => setAuth(e instanceof HttpError && e.status === 401 ? { kind: 'out' } : { kind: 'error', message: errMsg(e) }));
  };
  useEffect(check, []);

  useEffect(() => { document.title = 'CCD Kochi Live Quiz · Moderator'; }, []);

  if (auth.kind === 'loading') return <div class="c9-m-center c9-muted">Loading…</div>;
  if (auth.kind === 'error') {
    return (
      <div class="c9-m-center">
        <div class="c9-m-authcard yy-card yy-card--raised c9-stack">
          <Logo />
          <h2>Can't reach the server</h2>
          <p class="c9-muted">{auth.message}</p>
          <button class="yy-btn yy-btn--primary" onClick={check}>Try again</button>
        </div>
      </div>
    );
  }
  if (auth.kind === 'out') return <Login onIn={(me) => setAuth({ kind: 'in', me })} />;

  const me = auth.me;
  const onOut = () => setAuth({ kind: 'out' });
  let m: Record<string, string> | null;
  if ((m = match('/mod/room/:code', path))) return <Room code={m.code} me={me} />;
  if (path === '/mod/quiz/new') return <QuizEditor id={null} me={me} onLogout={onOut} />;
  if ((m = match('/mod/quiz/:id', path))) return <QuizEditor id={m.id} me={me} onLogout={onOut} />;
  if (path === '/mod/import') return <Import me={me} onLogout={onOut} />;
  return <Dashboard me={me} onLogout={onOut} />;
}
