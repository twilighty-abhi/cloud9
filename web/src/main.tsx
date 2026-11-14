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

// Web fonts load non-blocking (#13): a <link rel=stylesheet> in index.html blocks
// first paint until Google answers, which on networks that silently drop Google
// traffic means a blank page for 20 s+. Injected from JS it never blocks render;
// display=swap shows the system fallback stack until the fonts arrive.
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..800&family=JetBrains+Mono:wght@400;500&display=swap';
function loadFonts() {
  try {
    if (document.querySelector('link[data-c9-fonts]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_CSS;
    link.setAttribute('data-c9-fonts', '');
    document.head.appendChild(link);
  } catch { /* fonts are cosmetic */ }
}

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
loadFonts();
