// Playwright check for the quiz-editor unsaved-changes guard (#18).
// Run against a dev server:  npx vite --config web/vite.config.ts --port 5281
//   PLAYWRIGHT=/path/to/playwright node web/e2e/nav-guard.e2e.cjs http://localhost:5281 [screenshot-dir]
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const base = process.argv[2]; const out = process.argv[3] || '';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  let dialogs = []; let answer = false;
  p.on('dialog', (d) => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
  await p.goto(base + '/mod/import?fixture=editor');
  await p.waitForSelector('#qt');
  // in-app navigation (clean editor -> no prompt) so there is a history entry to go Back to.
  // Fixture mode always renders the editor, whatever the path.
  await p.click('.c9-m-savebar >> text=Cancel'); await p.waitForTimeout(100);
  const editorPath = new URL(p.url()).pathname;
  ok(dialogs.length === 0 && editorPath === '/mod', 'clean editor navigates without prompt');
  await p.fill('#qt', 'EDITED TITLE');
  await p.waitForSelector('text=Unsaved changes');
  // 1. logo, cancel
  await p.click('a.c9-logo'); await p.waitForTimeout(200);
  ok(dialogs.length === 1, `logo click shows confirm (dialogs=${dialogs.length})`);
  ok(new URL(p.url()).pathname === editorPath, 'logo cancel keeps URL ' + p.url());
  ok(await p.inputValue('#qt') === 'EDITED TITLE', 'logo cancel keeps edits');
  if (out) await p.screenshot({ path: out + '/18-logo-cancel.png' });
  // 2. Log out, cancel
  let logoutReq = 0; p.on('request', (r) => { if (r.url().includes('/api/auth/logout')) logoutReq++; });
  await p.click('text=Log out'); await p.waitForTimeout(200);
  ok(dialogs.length === 2, 'Log out shows confirm');
  ok(await p.inputValue('#qt') === 'EDITED TITLE', 'Log out cancel keeps edits');
  // 3. browser Back, cancel
  await p.goBack({ waitUntil: 'commit' }).catch(() => {}); await p.waitForTimeout(300);
  ok(dialogs.length === 3, 'Back shows confirm');
  ok(new URL(p.url()).pathname === editorPath, 'Back cancel restores URL ' + p.url());
  ok(await p.inputValue('#qt') === 'EDITED TITLE', 'Back cancel keeps edits');
  // 4. Back, accept -> leaves, single dialog
  answer = true;
  await p.goBack({ waitUntil: 'commit' }).catch(() => {}); await p.waitForTimeout(300);
  ok(dialogs.length === 4, 'Back accept asks once');
  ok(new URL(p.url()).pathname === '/mod/import', 'Back accept leaves ' + p.url());
  await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
