import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { serveRoutes } from './routes-api';

/* A tab left open while its session ended (#1592): the next request of the open page is refused, and the page goes to
   log in at once. A tab nobody is signed in on reloads itself once the server runs another build, and only then. */

const SIGNED_OUT = { error: { code: 'unauthorized', message: 'Sign in to continue.', reason: 'signed_out' } };
/* The page looks at the build every five minutes while it is seen. */
const LOOK_MS = 5 * 60_000;

/* From now on the server knows no session of this page: every request but the build and the stream is refused. */
async function endSession(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/build' || path === '/api/stream') return route.fallback();
    return route.fulfill({ status: 401, json: SIGNED_OUT });
  });
}

/* The build the server names on each look, as the test sets it, or a failed look. */
async function serveBuilds(page: Page) {
  const server = { build: 'build-one', failing: false, asked: 0 };
  await page.route('**/api/build', route => {
    server.asked++;
    if (server.failing) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } } });
    return route.fulfill({ json: { build: server.build }, headers: { 'cache-control': 'no-store' } });
  });
  return server;
}

/* How many times the document loaded, counted across reloads. */
function loads(page: Page) {
  const count = { n: 0 };
  page.on('load', () => count.n++);
  return count;
}

test('an open tab whose session ended goes to log in at once', async ({ page }) => {
  await serveRoutes(page);
  await serveBuilds(page);
  await page.goto('/tasks');
  const tab = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });
  await expect(tab(en.shell.tabs.tasks)).toBeVisible();
  await endSession(page);
  await tab(en.shell.tabs.people).click();
  await expect(page.getByRole('heading', { name: en.login.heading, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByText(en.errors.signed_out)).toHaveCount(0);
  await expect(page.getByLabel(en.common.email)).toBeEditable();
});

test('a signed-out tab reloads itself once on a new build, and not for the same build or a failed look', async ({ page }) => {
  await page.clock.install();
  await serveRoutes(page, { signedOut: true });
  const server = await serveBuilds(page);
  const loaded = loads(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: en.login.heading, exact: true })).toBeVisible();
  await expect.poll(() => server.asked).toBeGreaterThan(0);

  /* The next look at the build, on the page's clock, after which nothing is on its way. */
  const look = async (times = 1) => {
    const before = server.asked;
    await page.clock.runFor(LOOK_MS * times);
    await expect.poll(() => server.asked).toBeGreaterThanOrEqual(before + times);
  };

  /* The same build again, then a look that fails: the page stays. */
  await look();
  server.failing = true;
  await look();
  server.failing = false;
  await look();
  expect(loaded.n).toBe(1);

  /* Another build: the page reloads, once, and the new page takes that build as its own. */
  server.build = 'build-two';
  await page.clock.runFor(LOOK_MS);
  await expect.poll(() => loaded.n).toBe(2);
  await expect(page.getByRole('heading', { name: en.login.heading, exact: true })).toBeVisible();
  await look(2);
  expect(loaded.n).toBe(2);
});
