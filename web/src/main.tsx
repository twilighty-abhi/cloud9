// Cloud 9 web entry + routes. Owned by lead.
import { render } from 'preact';
import './styles/tokens.css';
import './styles/yuyu.css';
import './styles/base.css';
import { usePath, match } from './lib/router';
import { Home } from './pages/home/Home';
import { Play } from './pages/player/Play';
import { ModApp } from './pages/mod/ModApp';
import { Present } from './pages/present/Present';
import { PresentEvent } from './pages/present/PresentEvent';

function App() {
  const path = usePath();
  let m: Record<string, string> | null;
  if (path === '/' || path === '') return <Home />;
  if ((m = match('/join/:code', path))) return <Play code={m.code} />;
  if ((m = match('/play/:code', path))) return <Play code={m.code} />;
  if ((m = match('/present/event/:id', path))) return <PresentEvent id={m.id} />;
  if ((m = match('/present/:code', path))) return <Present code={m.code} />;
  if (path === '/mod' || path.startsWith('/mod/')) return <ModApp path={path} />;
  return <Home />;
}

render(<App />, document.getElementById('app')!);
