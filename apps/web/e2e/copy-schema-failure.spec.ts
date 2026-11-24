import { expect, test } from '@playwright/test';
import { LANGUAGES } from '../src/i18n';
import { DICTIONARIES } from '../src/i18n/dictionaries';
import { serveApi } from './api';
import { watchProblems } from './look-steps';

const HOST = 'replica-workstation-' + 'a'.repeat(58);
const SINCE = '2026-11-20T12:00:00.000Z';
const ATTEMPT = 7;
const CARD = { id: 'copy-1', hostname: HOST, since: SINCE, attempt: ATTEMPT };
const local = LANGUAGES.toSorted((a, b) => words(a.id).join('').length - words(b.id).join('').length);
type Language = (typeof LANGUAGES)[number]['id'];

function words(lang: Language) {
  const t = DICTIONARIES[lang];
  const at = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(SINCE));
  return [t.tracker.side.failures, t.tasks.copySchemaFailure(HOST), t.tasks.copySchemaFailureSince(ATTEMPT, at), t.tasks.copySchemaFailureDo] as const;
}

const looks = [
  ...[...new Set([local[0]!.id, local.at(-1)!.id])].flatMap(lang => (['light', 'dark'] as const).map(theme => ({ lang, theme, rtl: false }))),
  { lang: local.at(-1)!.id, theme: 'light', rtl: true } as const,
];

for (const { lang, theme, rtl } of looks) for (const width of [1440, 375]) {
  const name = `${lang}-${theme}-${rtl ? 'rtl-' : ''}${width}px`;
  test(`shows and clears the replica schema failure in ${name}`, async ({ page, browserName }, info) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme);
    }, { lang, theme });
    await serveApi(page);
    let active = true;
    let notify!: () => void;
    const changed = new Promise<void>(resolve => { notify = resolve; });
    await page.route('**/api/stream', async route => {
      await changed;
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"requests"}\n\n' });
    });
    await page.route('**/api/requests', route => route.fulfill({ json: {
      requests: [], proposals: [], counts: { byPerson: {}, byAgent: {}, total: 0 },
      copySchemaFailures: active ? [CARD] : [],
    } }));
    await page.goto('/tasks?show=failures');
    if (rtl) await page.locator('html').evaluate(element => { element.setAttribute('dir', 'rtl'); });
    const [, title, attempt, advice] = words(lang);
    const card = page.getByRole('region', { name: title, exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(attempt);
    await expect(card).toContainText(advice);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (rtl) expect(await card.evaluate(element => getComputedStyle(element).borderRightWidth)).toBe('2px');
    if (browserName === 'chromium') await page.screenshot({ path: info.outputPath(`copy-schema-${name}.png`), fullPage: true });
    active = false;
    notify();
    await expect(card).toHaveCount(0);
    expect(problems).toEqual([]);
  });
}
