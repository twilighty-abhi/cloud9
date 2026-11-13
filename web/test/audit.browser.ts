import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, devices, webkit, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { auditServer, password } from '../../server/test/auditFixture';

const timeout = 6000;
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { name, exact: typeof name === 'string' });
const visible = (page: Page, name: string | RegExp) => heading(page, name).first().waitFor({ state: 'visible', timeout });
const externalFonts = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//;
const browsers: { label: string; engine: typeof chromium; player: BrowserContextOptions }[] = [
  { label: 'Chromium / Pixel 7 viewport', engine: chromium, player: devices['Pixel 7'] },
  { label: 'WebKit / iPhone 13 viewport', engine: webkit, player: devices['iPhone 13'] },
];

async function newPage(browser: Browser, options?: BrowserContextOptions) {
  const page = await browser.newPage({ ...options, acceptDownloads: true });
  page.setDefaultTimeout(timeout);
  await page.route(externalFonts, (route) => route.abort());
  return page;
}

async function signIn(page: Page, base: string, roomCode: string) {
  await page.goto(`${base}/mod/room/${roomCode}`);
  await visible(page, 'Moderator sign in');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill(password);
  await button(page, 'Sign in').click();
  await button(page, 'Start quiz').waitFor({ timeout });
}

async function join(page: Page, base: string, code: string, name: string) {
  await page.goto(`${base}/join/${code}`);
  await page.getByLabel('Your name').fill(name);
  if (await page.getByLabel(/email/i).isVisible()) await page.getByLabel(/email/i).fill(`${name.toLowerCase()}@example.test`);
  await button(page, 'Join quiz').click();
  await page.waitForURL(`**/play/${code}`, { timeout });
  await page.getByText('Keep this page open.', { exact: false }).waitFor({ timeout });
}

async function transition(page: Page, from: string, to: string, scope: 'button' | 'heading' = 'button') {
  // The moderator deliberately ignores input briefly after each transition.
  const target = scope === 'heading' ? heading(page, to) : button(page, to);
  const until = Date.now() + timeout;
  do {
    if (await target.isVisible()) return;
    if (await button(page, from).isEnabled({ timeout })) await button(page, from).click();
    await page.waitForTimeout(120);
  } while (Date.now() < until);
  await target.waitFor({ timeout: 100 });
}

for (const { label, engine, player: mobile } of browsers) {
  test(`${label}: moderator, mobile player and projector play a quiz on the production build`, async (t) => {
    const app = await auditServer(t, { built: true });
    const event = await app.event(await app.login());
    const room = await app.room(await app.login(), { eventId: event.id });
    const unlisted = await app.room(await app.login(), { listed: false, title: 'Hidden audit room' });
    const browser = await engine.launch();
    t.after(() => browser.close());
    const [mod, player, project, eventBoard] = await Promise.all([
      newPage(browser), newPage(browser, mobile), newPage(browser), newPage(browser),
    ]);
    const errors: string[] = [];
    for (const page of [mod, player, project, eventBoard]) page.on('pageerror', (error) => errors.push(error.message));

    await player.goto(app.origin);
    await player.getByText('Audit quiz', { exact: true }).first().waitFor({ timeout });
    assert.equal(await player.getByText(unlisted.title, { exact: true }).count(), 0);
    await Promise.all([
      signIn(mod, app.origin, room.code),
      join(player, app.origin, room.code, 'Auditor'),
      project.goto(`${app.origin}/present/${room.code}`),
    ]);
    await transition(mod, 'Start quiz', 'Close answers');
    const prompt = 'What is two plus two?';
    await Promise.all([visible(player, prompt), visible(project, prompt)]);
    await player.reload();
    await visible(player, prompt);
    await button(player, /Four/).click();
    await visible(player, 'Answer locked');
    await transition(mod, 'Reveal answer', 'Show leaderboard');
    await player.getByText('+1,000', { exact: false }).first().waitFor({ timeout });
    await transition(mod, 'Show leaderboard', 'Leaderboard', 'heading');
    await visible(player, 'Leaderboard');

    await eventBoard.goto(`${app.origin}/present/event/${event.id}`);
    await eventBoard.getByText('Auditor', { exact: true }).first().waitFor({ timeout });
    await transition(mod, 'Next question', 'Close answers');
    await visible(player, 'What is two plus three?');
    await button(player, /Five/).click();
    await visible(player, 'Answer locked');
    await transition(mod, 'Reveal answer', 'Show leaderboard');
    await transition(mod, 'Show leaderboard', 'Leaderboard', 'heading');
    const deadline = Date.now() + timeout;
    const exportLink = mod.getByRole('link', { name: 'Download results CSV', exact: true });
    do {
      if (await exportLink.isVisible()) break;
      if (await button(mod, 'Finish quiz').isEnabled({ timeout })) await button(mod, 'Finish quiz').click();
      await mod.waitForTimeout(120);
    } while (Date.now() < deadline);
    await visible(player, 'Thanks for playing');
    await visible(project, 'Final results');
    const downloadEvent = mod.waitForEvent('download', { timeout });
    await exportLink.click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /^cloud9-\d{6}-audit-quiz\.csv$/);
    assert.equal(await download.failure(), null);
    assert.deepEqual(errors, []);
  });
}

test('C9-11: malformed encoded client-side navigation does not crash the SPA', async (t) => {
  const app = await auditServer(t, { built: true });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await newPage(browser);
  await page.goto(app.origin);
  await page.locator('main').first().waitFor({ timeout });
  const error = page.waitForEvent('pageerror', { timeout }).then((e) => e.message, () => null);
  await page.evaluate(() => {
    history.pushState(null, '', '/join/%ZZ');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const outcome = await Promise.race([visible(page, 'Quiz not found').then(() => null), error]);
  assert.equal(outcome, null, 'Malformed percent encoding triggered an uncaught router error');
});

test('C9-12: a production moderator URL cannot switch the UI into demo authentication', async (t) => {
  const app = await auditServer(t, { built: true });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await newPage(browser);
  await page.goto(`${app.origin}/mod?fixture=dashboard`);
  const outcome = await Promise.race([
    visible(page, 'Moderator sign in').then(() => 'login'),
    page.getByText('Kubernetes Lightning Round', { exact: true }).first().waitFor({ timeout }).then(() => 'demo'),
  ]);
  assert.equal(outcome, 'login', 'Production opened a synthetic moderator dashboard without real authentication');
});
