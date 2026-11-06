/// <reference types="node" />
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, loadavg, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { geometryServer } from './geometry-fixture';
import { geometryMeasurement } from './geometry-measurement';

test.describe.configure({ timeout: 120_000 });
const harnessRoot = fileURLToPath(new URL('../../../', import.meta.url));
const harnessSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).trim();
const expectedIcons = ['window.close', 'window.minimize', 'window.full', 'notebook.toggle', 'notebook.close'];

async function record(page: Page, info: TestInfo, name: string, notebookLabel: string, metadata: Record<string, unknown>) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const geometry = await page.evaluate(({ notebookLabel }) => {
    const panel = document.querySelector('.side-panel .acard:has(.notebook)');
    if (!panel) throw new Error('The real notebook panel was not opened');
    const box = (element: Element) => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
    };
    const icons = [...document.querySelectorAll('.orch .t-bar button:not(.btn)')].map(button => {
      const svg = button.querySelector('svg');
      const b = box(button), s = svg ? box(svg) : null;
      const control = ['close', 'minimize', 'full'].find(id => button.classList.contains('window-' + id));
      const id = control ? 'window.' + control : panel.contains(button) ? 'notebook.close'
        : button.getAttribute('aria-label') === notebookLabel ? 'notebook.toggle' : 'unclassified-title-control';
      const style = getComputedStyle(button);
      return { id, name: button.getAttribute('aria-label'), className: button.className, button: b, svg: s,
        dx: s ? (s.x + s.width / 2) - (b.x + b.width / 2) : null, dy: s ? (s.y + s.height / 2) - (b.y + b.height / 2) : null,
        padding: style.padding, font: style.font, outline: style.outline, outlineOffset: style.outlineOffset };
    });
    const clips: { text: string; owner: string; left: number; right: number; availableLeft: number; availableRight: number }[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!node.textContent?.trim() || !parent || parent.closest('[hidden], [aria-hidden="true"]')) continue;
      if (!parent.getClientRects().length) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        let element: Element | null = parent;
        while (element && panel.contains(element)) {
          const style = getComputedStyle(element);
          if (element === panel || style.overflowX !== 'visible') {
            const outer = element.getBoundingClientRect();
            const availableLeft = outer.left + element.clientLeft;
            const availableRight = availableLeft + element.clientWidth;
            if (rect.left < availableLeft - 0.5 || rect.right > availableRight + 0.5) {
              clips.push({ text: node.textContent, owner: element.className, left: rect.left, right: rect.right, availableLeft, availableRight });
            }
          }
          element = element.parentElement;
        }
      }
    }
    const scroll = [...panel.querySelectorAll('*'), panel].flatMap(element => {
      if (!element.getClientRects().length || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return [];
      const e = element as HTMLElement;
      return e.scrollWidth > e.clientWidth + 1 ? [{ className: e.className, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, scrollLeft: e.scrollLeft }] : [];
    });
    const body = panel.querySelector('.ac-body');
    return { panel: box(panel), body: body ? box(body) : null, icons, clips, horizontalOverflow: scroll,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      fonts: [...document.fonts].map(f => ({ family: f.family, status: f.status, weight: f.weight, style: f.style })),
      bodyFont: getComputedStyle(document.body).font, direction: getComputedStyle(document.documentElement).direction,
      pageHorizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      intentionalNavigation: [...document.querySelectorAll('.side-panels, .orch > .t-bar')].map(e => ({ className: e.className, width: e.clientWidth, scrollWidth: e.scrollWidth, scrollLeft: e.scrollLeft })),
    };
  }, { notebookLabel });
  const picture = info.outputPath(name + '.png');
  const json = info.outputPath(name + '.json');
  await page.screenshot({ path: picture });
  const row = { ...metadata, engine: info.project.name, status: 'measured', screenshotSha256: createHash('sha256').update(readFileSync(picture)).digest('hex'), geometry };
  writeFileSync(json, JSON.stringify(row, null, 2) + '\n');
  await info.attach(name + '.png', { path: picture, contentType: 'image/png' });
  await info.attach(name + '.json', { path: json, contentType: 'application/json' });
  /* Keep raw artifacts even when strict normalization rejects missing controls or invalid geometry. */
  const measurement = geometryMeasurement(row), normalized = info.outputPath(name + '.measurement.json');
  writeFileSync(normalized, JSON.stringify(measurement, null, 2) + '\n');
  await info.attach(name + '.measurement.json', { path: normalized, contentType: 'application/json' });
  console.log('HH_GEOMETRY_CASE ' + JSON.stringify({ ...metadata, engine: info.project.name, panel: geometry.panel, iconCount: geometry.icons.length, clippedTextBoxes: geometry.clips.length, overflowingElements: geometry.horizontalOverflow.length }));
  return { ...geometry, icons: measurement.icons };
}

async function actionIsAvailable(button: Locator): Promise<boolean> {
  try { await button.click({ trial: true }); return true; }
  catch { return false; }
}

for (const theme of ['light', 'dark'] as const) for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
  test(`real window controls and complete notebook text/actions: ${theme}-${viewport.width}`, async ({ browser, browserName }, info) => {
    expect(platform(), 'Only the approved Linux Docker route may execute this harness').toBe('linux');
    expect(info.project.name).toBe(browserName);
    const fixture = await geometryServer();
    const identities = {
      sourceSha: fixture.sourceSha, harnessSha, harnessPhase: process.env.HH_GEOMETRY_PHASE ?? 'unclassified',
      browserName, browserVersion: browser.version(), node: process.version, os: platform(), arch: arch(), load: loadavg(),
      dataSha256: fixture.dataSha256, fontsSha256: fixture.fontsSha256, fontAssets: fixture.fontAssets,
      localeRankings: fixture.locales.map(x => ({ id: x.id, direction: x.direction, score: x.score })), selectedLocales: fixture.selected,
      dictionaryKeys: fixture.dictionaryKeys, scoreUnit: fixture.scoreUnit, shippedRtl: fixture.shippedRtl,
      theme, viewport, dpr: 1,
    };
    console.log('HH_GEOMETRY_INPUT ' + JSON.stringify(identities));
    try {
      const selected = fixture.locales.filter(x => fixture.selected.includes(x.id));
      for (const locale of selected) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: locale.id, timezoneId: 'UTC', reducedMotion: 'reduce' });
        await context.addCookies([{ name: 'hh_session', value: fixture.session, url: fixture.origin }]);
        await context.addInitScript(({ language, theme }) => {
          localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', theme);
        }, { language: locale.id, theme });
        const page = await context.newPage(), errors: string[] = [], failedRequests: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
        const key = `${browserName}-${locale.id}-${theme}-${viewport.width}`;
        try {
          await page.goto(fixture.origin);
          await page.getByRole('button', { name: locale.labels.openOrchestrator, exact: true }).click();
          const window = page.locator('.orch:not([hidden])');
          await expect(window).toBeVisible();
          await window.locator(':scope > .t-bar').getByRole('button', { name: locale.labels.notebook, exact: true }).click();
          const notebook = page.locator('.side-panel .acard').filter({ has: page.locator('.notebook') });
          await expect(notebook.locator('.notebook li')).toContainText(fixture.note);
          await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('14px Onest'); await document.fonts.load('14px Tektur'); });
          const measured = await record(page, info, key + '-notebook', locale.labels.notebook,
            { ...identities, locale: locale.id, expectedDirection: locale.direction, caseId: `notebook/${theme}/${locale.id}/${viewport.width}/open` });
          expect.soft(measured.viewport.dpr).toBe(1);
          expect.soft(measured.direction).toBe(locale.direction);
          expect.soft(measured.icons.map(icon => icon.id).sort(), 'All declared title controls are captured exactly once').toEqual([...expectedIcons].sort());
          for (const icon of measured.icons) {
            expect.soft(Math.abs(icon.dx), `${icon.id}: horizontal SVG/button center`).toBeLessThanOrEqual(0.5);
            expect.soft(Math.abs(icon.dy), `${icon.id}: vertical SVG/button center`).toBeLessThanOrEqual(0.5);
          }
          expect.soft(measured.clips, 'Every notebook text line fits each clipping ancestor, including scrollbar space').toEqual([]);
          expect.soft(measured.horizontalOverflow, 'Notebook prose/actions are not an intentional horizontal scroll area').toEqual([]);
          expect.soft(measured.pageHorizontalOverflow).toBe(false);

          /* Exercise the real notebook route, not just the existence of mock buttons. */
          const change = notebook.getByRole('button', { name: locale.labels.changeNote, exact: true });
          const available = await actionIsAvailable(change);
          expect.soft(available, 'The complete Change action is reachable').toBe(true);
          if (available) {
            await change.click();
            const field = notebook.getByRole('textbox', { name: locale.labels.note, exact: true });
            await expect(field).toHaveValue(fixture.note);
            await field.fill(fixture.note + '/saved');
            await notebook.getByRole('button', { name: locale.labels.save, exact: true }).click();
            const saved = await context.request.get(fixture.origin + '/api/notebook');
            expect(saved.status()).toBe(200);
            const notes = (await saved.json() as { notes: { number: number; text: string }[] }).notes;
            expect(notes.find(n => n.number === fixture.number)?.text).toBe(fixture.note + '/saved');
            await notebook.getByRole('button', { name: locale.labels.changeNote, exact: true }).click();
            await notebook.getByRole('textbox', { name: locale.labels.note, exact: true }).fill('Unsaved draft');
            await notebook.getByRole('button', { name: locale.labels.cancel, exact: true }).click();
            await expect(notebook.locator('.notebook li')).toContainText(fixture.note + '/saved');
            const restored = await context.request.patch(`${fixture.origin}/api/notebook/${fixture.number}`, { data: { text: fixture.note } });
            expect(restored.status()).toBe(200);
          }

          const remove = notebook.getByRole('button', { name: locale.labels.removeNote, exact: true });
          const removeAvailable = await actionIsAvailable(remove);
          expect.soft(removeAvailable, 'The complete Remove action is reachable').toBe(true);
          if (removeAvailable && locale.id === selected.at(-1)?.id) {
            await remove.click();
            await expect(notebook.locator('.notebook li')).toHaveCount(0);
            const removed = await context.request.get(fixture.origin + '/api/notebook');
            expect(removed.status()).toBe(200);
            expect((await removed.json() as { notes: unknown[] }).notes).toEqual([]);
            await expect(notebook).toContainText(locale.labels.empty);
          }

          const close = notebook.locator(':scope > .t-bar').getByRole('button', { name: locale.labels.close, exact: true });
          await close.focus();
          await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
          await expect(close).toBeFocused();
          expect.soft(await close.evaluate(e => getComputedStyle(e).outlineOffset), 'Approved inward close-button focus offset').toBe('-2px');
          const focusPicture = info.outputPath(key + '-panel-close-focus.png');
          await page.screenshot({ path: focusPicture });
          await info.attach(key + '-panel-close-focus.png', { path: focusPicture, contentType: 'image/png' });
          await close.click();
          await expect(notebook).toHaveCount(0);
          await window.locator('.window-full').click();
          await expect(window).toHaveClass(/fullscreen/);
          await window.locator('.window-full').click();
          await expect(window).not.toHaveClass(/fullscreen/);
          await window.locator('.window-minimize').click();
          await expect(window).toBeHidden();
          await page.locator('.agent-strip-open').click();
          await expect(window).toBeVisible();
          await window.locator('.window-close').click();
          await expect(window).toHaveCount(0);
          expect.soft(errors, 'Actual page/console errors').toEqual([]);
          expect.soft(failedRequests, 'Actual failed HTTP requests').toEqual([]);
        } finally {
          const log = info.outputPath(key + '-errors.json');
          writeFileSync(log, JSON.stringify({ errors, failedRequests }) + '\n');
          await info.attach(key + '-errors.json', { path: log, contentType: 'application/json' });
          await context.close();
        }
      }
    } finally { await fixture.stop(); }
  });
}
