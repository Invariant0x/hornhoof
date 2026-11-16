import { expect, test, type Page } from '@playwright/test';
import { LONG, MACHINES, noSideScroll, openMachines, placed, SIZES, within, WORDS } from './machine-priority-steps';

/* The machine the server moved from and one that saves what it led, and the CEO's choice with its refusal. */

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const w = WORDS[language];
  const shot = (name: string) => `${name}-${language}-${theme}-${width}.png`;
  const card = (page: Page, hostname: string) => page.getByRole('article', { name: hostname });
  const open = (page: Page, hostname: string) => page.getByRole('button', { name: `${w.open} ${hostname}`, exact: true }).click();

  test(`notes the machine the server moved from, and one that saves what it led, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    /* The server was taken from the machine with the long name, whose copy is up to date again; the one before it
       still saves what it did. */
    const after = MACHINES.map(m =>
      m.id === 'm3' ? { ...m, data: placed({ number: 3, why: 'pinned', pin: 3, copy: { line: 'ready' }, led: { until: '2026-11-12T14:02:00.000Z' } }) }
        : m.id === 'm2' ? { ...m, data: placed({ number: 2, why: 'always.best_link', copy: { line: 'saving' } }) } : m);
    await openMachines(page, language, theme, undefined, null, after);
    await open(page, LONG);
    const old = card(page, LONG);
    const [note, here] = [old.getByText(w.led(LONG)), old.getByRole('button', { name: w.here, exact: true })];
    await expect(note).toBeVisible();
    await expect(here).toBeVisible();
    for (const one of [note, here]) expect(await within(one, old)).toBe(true);
    await open(page, 'dev-studio');
    const saving = card(page, 'dev-studio').getByText(w.saving, { exact: true });
    await expect(saving).toBeVisible();
    expect(await within(saving, card(page, 'dev-studio'))).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('move-led')), fullPage: true });
  });

  test(`sends the CEO's choice and words a refusal, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const sent = await openMachines(page, language, theme, { status: 409, reason: 'only_copy' });
    await open(page, 'dev-studio');
    const copy = card(page, 'dev-studio');
    await copy.getByRole('radio', { name: w.outChoice }).click();
    const refusal = copy.getByRole('alert');
    await expect(refusal).toHaveText(w.onlyCopy('dev-studio'));
    expect(sent).toEqual([{ path: '/api/machines/m2/priority', body: { pin: 'none' } }]);
    expect(await within(refusal, copy)).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(shot('refused')), fullPage: true });
  });
}
