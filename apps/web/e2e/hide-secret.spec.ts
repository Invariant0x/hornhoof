import { expect, test } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import { openTaskAction, detail, serveApi, TASKS } from './api';
import { captureWith } from './capture';

const capture = captureWith('hide-secret', undefined);
const messages: Record<Language, Messages> = { en, ru };
const lengths = LANGUAGES.map(({ id }) => ({ id, size: Object.values(messages[id].tasks.hideSecret).join('').length }));
lengths.sort((a, b) => a.size - b.size);
const locales = [...new Set([lengths[0]!.id, lengths.at(-1)!.id])];
const marker = 'OldBrowserMarker1077!';

for (const language of locales) for (const skin of BUILTIN_SKINS) for (const width of [375, 1440]) {
  test(`hides a selected secret, ${language}, ${skin.id}, ${width}px`, async ({ page }, info) => {
    const t = messages[language];
    const words = t.tasks.hideSecret;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ language, skin }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', skin);
    }, { language, skin: skin.id });
    await serveApi(page);
    let hidden = false;
    await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...detail(TASKS[0]!), body: hidden ? '[hidden]' : marker, mayHideSecret: true } } }));
    await page.route('**/api/tasks/t1/hide-secret', route => {
      expect(route.request().postDataJSON()).toEqual({ value: marker });
      hidden = true;
      return route.fulfill({ json: { ok: true } });
    });
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.goto('/tasks/t1');
    const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
    await expect(panel).toBeVisible();
    await panel.getByText(marker, { exact: true }).evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await openTaskAction(panel, t, words.action);
    const input = panel.getByLabel(words.value);
    await expect(input).toHaveValue(marker);
    const form = panel.getByRole('form', { name: words.action });
    const layouts = await form.evaluate((element, hint) => ['ltr', 'rtl'].map(direction => {
      element.setAttribute('dir', direction);
      const text = [...element.querySelectorAll('p')].find(p => p.textContent === hint);
      if (!text) throw new Error('The secret hint is missing.');
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      let last: Node | null = null;
      while ((node = walker.nextNode())) last = node;
      const range = document.createRange();
      const length = last!.textContent!.length;
      range.setStart(last!, length - 1);
      range.setEnd(last!, length);
      const period = range.getBoundingClientRect().x;
      range.setStart(last!, length - 2);
      range.setEnd(last!, length - 1);
      return {
        direction, punctuation: period - range.getBoundingClientRect().x,
        width: element.clientWidth, scroll: element.scrollWidth,
        controls: [...element.querySelectorAll('button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      };
    }), words.hint);
    for (const layout of layouts) {
      expect(layout.punctuation, `The final period follows the hint in ${layout.direction}.`).toBeGreaterThan(0);
      expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
      for (const control of layout.controls) {
        expect(control.width).toBeGreaterThanOrEqual(44);
        expect(control.height).toBeGreaterThanOrEqual(44);
      }
    }
    if (info.project.name === 'chromium' && width === 375) await capture(page, info, `${language}-${skin.id}`);
    await form.getByRole('button', { name: words.confirm }).click();
    await Promise.all([
      expect(input).toHaveCount(0),
      expect(panel.getByText(marker, { exact: true })).toHaveCount(0),
      expect(panel.getByText('[hidden]', { exact: true })).toBeVisible(),
    ]);
    await openTaskAction(panel, t, t.tasks.details);
    await expect(panel.getByRole('link', { name: words.vault, exact: true })).toHaveAttribute('href', '/settings/passwords');
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(failures).toEqual([]);
  });
}
