import { expect, test } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import { detail, serveApi, TASKS } from './api';

const messages: Record<Language, Messages> = { en, ru };
const lengths = LANGUAGES.map(({ id }) => ({ id, size: Object.values(messages[id].tasks.hideSecret).join('').length }));
lengths.sort((a, b) => a.size - b.size);
const locales = [...new Set([lengths[0]!.id, lengths.at(-1)!.id])];
const marker = 'OldBrowserMarker1077!';

for (const language of locales) for (const skin of BUILTIN_SKINS) for (const width of [375, 1440]) {
  test(`hides a selected secret, ${language}, ${skin.id}, ${width}px`, async ({ page }, info) => {
    const words = messages[language].tasks.hideSecret;
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
    await panel.getByRole('button', { name: words.action, exact: true }).click();
    const input = panel.getByLabel(words.value);
    await expect(input).toHaveValue(marker);
    const form = panel.getByRole('form', { name: words.action });
    for (const direction of ['ltr', 'rtl']) {
      await form.evaluate((element, direction) => { element.dir = direction; }, direction);
      const geometry = await form.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, controls: [...element.querySelectorAll('button')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      for (const control of geometry.controls) {
        expect(control.width).toBeGreaterThanOrEqual(44);
        expect(control.height).toBeGreaterThanOrEqual(44);
      }
    }
    if (info.project.name === 'chromium' && width === 375) await page.screenshot({ path: `../../docs/tasks/1077-${language}-${skin.id}.png` });
    await form.getByRole('button', { name: words.confirm }).click();
    await expect(input).toHaveCount(0);
    await expect(panel.getByText(marker, { exact: true })).toHaveCount(0);
    await expect(panel.getByText('[hidden]', { exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });
}
