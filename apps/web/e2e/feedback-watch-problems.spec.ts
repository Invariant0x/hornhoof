import { expect, test, type Page } from '@playwright/test';
import { watchProblems } from './look-steps';

/* What WebKit says of a request that the page's own navigation cuts off, set apart from the errors of the page (#1090).
   WebKit reports a request a page starts as it leaves as "Fetch API cannot load <origin>/... due to access control
   checks.", whether the page caught its failure or not. A request on its way that nobody caught comes as "TypeError: Load
   failed". */
test.skip(({ browserName }) => browserName !== 'webkit', 'only WebKit reports a request cut by a navigation as an error of the page');

const PAGE = (script: string) => `<!doctype html><html><body><p>page</p><script>${script}</script></body></html>`;

/* The problems watchProblems keeps when a page runs `script` and is left, once WebKit has said the `said` errors it
   says of it: every error of the page as it came, and the problems kept of them. /api/hold is never answered. */
async function leaving(page: Page, script: string, said: number): Promise<{ seen: string[]; problems: string[] }> {
  await page.route('**/watch-one', route => route.fulfill({ contentType: 'text/html', body: PAGE(script) }));
  await page.route('**/watch-two', route => route.fulfill({ contentType: 'text/html', body: PAGE('') }));
  await page.route('**/api/watch', route => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/hold', () => {});
  await page.route('**/watch-file', route => route.fulfill({ body: 'ok' }));
  const seen: string[] = [];
  page.on('pageerror', error => seen.push(error.message));
  const problems = watchProblems(page);
  await page.goto('/watch-one');
  await page.goto('/watch-two');
  await expect.poll(() => seen.length).toBeGreaterThanOrEqual(said);
  expect(seen).toHaveLength(said);
  return { seen, problems };
}

test('lets go what WebKit says of a request to the API the page caught as it left', async ({ page }) => {
  const { seen, problems } = await leaving(page, `addEventListener('pagehide', () => { fetch('/api/watch').catch(() => {}); });`, 1);
  expect(seen[0]).toMatch(/\/api\/watch due to access control checks\.$/);
  expect(problems).toEqual([]);
});

test('still counts a request to the API on its way that nobody caught', async ({ page }) => {
  const asked = page.waitForRequest('**/api/hold');
  const { problems } = await leaving(page, `fetch('/api/hold').then(answer => answer.text());`, 1);
  await asked;
  expect(problems).toEqual(['TypeError: Load failed']);
});

test('still counts a request cut off anywhere but the API', async ({ page }) => {
  const { problems } = await leaving(page, `addEventListener('pagehide', () => { fetch('/watch-file').catch(() => {}); });`, 1);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/\/watch-file due to access control checks\.$/);
});
