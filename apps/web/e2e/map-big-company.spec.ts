import { expect, test, type Page } from '@playwright/test';
import { serveApi } from './api';
import { bigCompany } from './big-company-api';

/* A large company's server takes its time over the company: every answer after the first waits until the test lets it go.
   The map the person moved stays on the screen meanwhile, wherever they go and come back from; a map that waits for its own
   answer shows only the dotted background, and the person finds no agent on it. */
const COMPANY = bigCompany();
const DEPARTMENTS = COMPANY.departments.length;

const view = (page: Page) => page.locator('.map .world').evaluate((e: HTMLElement) => e.style.transform);
/* Two frames: whatever the last click set going is on the screen. */
const settled = (page: Page) => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
/* What the screen shows now, read at once and not waited for: the slow answer has not come yet. */
const shows = (page: Page) =>
  page.evaluate(() => ({
    departments: document.querySelectorAll('.map .dept').length,
    dotsOnly: !!document.querySelector('.map[aria-busy]'),
    departmentView: !!document.querySelector('.dview'),
  }));

let letGo = () => {};

/* The first answer comes at once; the rest wait for letGo. */
async function slowServer(page: Page) {
  let served = 0;
  const held = new Promise<void>(done => (letGo = done));
  await serveApi(page);
  await page.route('**/api/org', async route => {
    if (served++) await held;
    return route.fulfill({ json: COMPANY });
  });
}

/* The person opens the map and zooms it, so the view is their own and kept. */
async function zoomedMap(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.locator('.map .dept')).toHaveCount(DEPARTMENTS);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await settled(page);
  return view(page);
}

test.describe('the map of a large company while its server is slow', () => {
  test.use({ viewport: { width: 1536, height: 730 } });
  test.afterEach(() => letGo());

  test('comes back from another section with every department where the person left it', async ({ page }) => {
    await slowServer(page);
    const left = await zoomedMap(page);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(page.locator('.map')).toHaveCount(0);
    await nav.getByRole('button', { name: 'Map', exact: true }).click();
    await settled(page);
    expect(await shows(page)).toEqual({ departments: DEPARTMENTS, dotsOnly: false, departmentView: false });
    expect(await view(page)).toBe(left);
  });

  test('opens a department at once and goes back to the map where the person left it', async ({ page }) => {
    await slowServer(page);
    const left = await zoomedMap(page);
    await page.locator('.map .dept').nth(4).click();
    await settled(page);
    expect(await shows(page)).toEqual({ departments: DEPARTMENTS, dotsOnly: false, departmentView: true });
    await page.getByRole('button', { name: 'Back to the map' }).click();
    await settled(page);
    expect(await shows(page)).toEqual({ departments: DEPARTMENTS, dotsOnly: false, departmentView: false });
    expect(await view(page)).toBe(left);
  });
});
