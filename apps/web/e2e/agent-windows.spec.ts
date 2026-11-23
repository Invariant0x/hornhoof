import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box, openTaskAction, openTaskCard } from './api';
import { expectStripsApart, openCompany, overlaps, pastePicture } from './agent-windows-api';
import { SETTINGS } from './computer-strip-api';

for (const settings of SETTINGS) {
  const { lang, theme, width } = settings;
  const named = `${lang}, ${theme}, ${width}`;

  test.describe(named, () => {
    test('a minimized orchestrator stays on every screen and beside another agent', async ({ page }, info) => {
      const { words, errors, tab, windowOf, stripOf, openOrchestrator, openEmployee, minimize } = await openCompany(page, settings);
      const orchestrator = words.orchestrator;
      await openOrchestrator();
      await minimize(orchestrator);
      const strip = stripOf(orchestrator);
      await expect(strip).toBeVisible();
      for (const name of [...words.tabs.slice(1), words.tabs[0]!]) {
        await tab(name).click();
        await expect(strip).toBeVisible();
      }
      await openEmployee('Bruno');
      await expect(strip).toBeVisible();
      await expect(windowOf(orchestrator)).toBeHidden();
      expect(overlaps(await box(strip), await box(windowOf('Bruno')))).toBe(false);
      await page.screenshot({ path: info.outputPath(`orchestrator-strip-beside-bruno-${lang}-${theme}-${width}.png`) });
      expect(errors).toEqual([]);
    });

    test('the open window minimizes itself when another agent opens', async ({ page }, info) => {
      const { words, errors, windowOf, stripOf, anyStrip, barButton, openEmployee } = await openCompany(page, settings);
      const t = lang === 'en' ? en : ru;
      await openEmployee('Clara');
      await expect(anyStrip).toHaveCount(0);
      await barButton('Clara', words.task).click();
      const task = windowOf('Clara').getByRole('complementary', { name: '#2 Work of Clara', exact: true });
      await openTaskAction(task, t, t.tasks.details);
      await task.getByRole('region', { name: t.tasks.questions, exact: true }).getByRole('button', { name: words.openTerminalOf('Dana'), exact: true }).click();
      await expect(windowOf('Dana')).toBeVisible();
      await expect(windowOf('Clara')).toBeHidden();
      await expect(stripOf('Clara')).toBeVisible();
      await expect(stripOf('Dana')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`another-agent-opened-${lang}-${theme}-${width}.png`) });
      expect(errors).toEqual([]);
    });

    test('three minimized windows are three strips, each brings back its own window as it was', async ({ page }, info) => {
      const { words, errors, live, windowOf, stripOf, anyStrip, barButton, openEmployee, minimize } = await openCompany(page, settings);
      await openEmployee('Bruno');
      await expect(windowOf('Bruno').locator('.xterm-screen')).toBeVisible();
      const brunoConnections = live.connections['bruno'];
      await barButton('Bruno', words.card).click();
      const card = windowOf('Bruno').getByRole('complementary', { name: words.cardOf('Bruno'), exact: true });
      await expect(card).toBeVisible();
      await minimize('Bruno');
      await openEmployee('Clara');
      await barButton('Clara', words.log).click();
      await expect(windowOf('Clara').getByRole('log')).toBeVisible();
      await minimize('Clara');
      /* Dana's window opens with the chat, the last choice made in Clara's; the terminal is one click away. */
      await openEmployee('Dana');
      await expect(windowOf('Dana').getByRole('log')).toBeVisible();
      await barButton('Dana', words.terminal).click();
      await expect(windowOf('Dana').locator('.xterm-screen')).toBeVisible();
      const danaConnections = live.connections['dana'];
      await barButton('Dana', words.task).click();
      const task = windowOf('Dana').getByRole('complementary', { name: '#3 Work of Dana', exact: true });
      await expect(task).toBeVisible();
      await minimize('Dana');

      const strips = [stripOf('Bruno'), stripOf('Clara'), stripOf('Dana')];
      await expect(anyStrip).toHaveCount(3);
      const places = await expectStripsApart(page, strips);
      if (width === 1440) expect(places.map(p => p.y)).toEqual([...places.map(p => p.y)].sort((a, b) => a - b));
      await expect(strips[0]!).toContainText('Bruno');
      await expect(strips[0]!).toContainText(words.working);
      await expect(strips[1]!).toContainText(words.sleeping);
      await page.screenshot({ path: info.outputPath(`three-strips-${lang}-${theme}-${width}.png`) });

      await strips[1]!.click();
      await expect(windowOf('Clara')).toBeVisible();
      await expect(windowOf('Clara').getByRole('log')).toBeVisible();
      await expect(windowOf('Bruno')).toBeHidden();
      await expect(windowOf('Dana')).toBeHidden();
      await expect(anyStrip).toHaveCount(2);
      await page.screenshot({ path: info.outputPath(`clara-restored-${lang}-${theme}-${width}.png`) });
      await minimize('Clara');

      await strips[0]!.click();
      await expect(card).toBeVisible();
      await minimize('Bruno');
      await strips[2]!.click();
      await expect(task).toBeVisible();
      expect(live.connections['bruno']).toBe(brunoConnections);
      expect(live.connections['dana']).toBe(danaConnections);
      expect(errors).toEqual([]);
    });

    test('the cross takes a strip away, and the same agent never gets a second one', async ({ page }) => {
      const { words, errors, live, windowOf, stripOf, anyStrip, barButton, closeStrip, openEmployee, minimize } = await openCompany(page, settings);
      await openEmployee('Bruno');
      await expect(windowOf('Bruno').locator('.xterm-screen')).toBeVisible();
      const connected = live.connections['bruno'];
      await minimize('Bruno');
      await openEmployee('Bruno');
      await expect(anyStrip).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: /^Bruno,/ })).toHaveCount(1);
      await minimize('Bruno');
      await expect(anyStrip).toHaveCount(1);
      expect(live.connections['bruno']).toBe(connected);

      await stripOf('Bruno').click();
      await barButton('Bruno', words.close).click();
      await expect(windowOf('Bruno')).toHaveCount(0);
      await expect(anyStrip).toHaveCount(0);

      await openEmployee('Bruno');
      await minimize('Bruno');
      await closeStrip('Bruno').click();
      await expect(anyStrip).toHaveCount(0);
      await expect(windowOf('Bruno')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}

for (const width of [1440, 375]) {
  test(`strips the edge cannot hold do not run into each other and stay in reach at ${width}`, async ({ page }, info) => {
    const { errors, windowOf, stripOf, anyStrip, openEmployee, minimize } = await openCompany(page, { lang: 'ru', theme: 'dark', width });
    const names = ['Bruno', 'Clara', 'Dana', 'Egor'];
    for (const name of names) {
      await openEmployee(name);
      await minimize(name);
    }
    await expect(anyStrip).toHaveCount(4);
    await page.setViewportSize({ width, height: 420 });
    for (const name of names) {
      await stripOf(name).scrollIntoViewIfNeeded();
      await expect(stripOf(name)).toBeInViewport();
    }
    await expectStripsApart(page, names.map(stripOf));
    await page.screenshot({ path: info.outputPath(`many-strips-ru-dark-${width}.png`) });
    await stripOf('Egor').click();
    await expect(windowOf('Egor')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('Escape stops only the agent on the screen', async ({ page }) => {
  const { errors, live, windowOf, openEmployee, minimize } = await openCompany(page, { lang: 'en', theme: 'dark', width: 1440 }, { busy: ['bruno', 'clara'] });
  await openEmployee('Bruno');
  await minimize('Bruno');
  await openEmployee('Clara');
  await windowOf('Clara').focus();
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('alertdialog', { name: en.window.confirm.stop.title });
  await expect(dialog).toHaveAccessibleDescription(en.window.confirm.stop.effect('Clara'));
  expect(live.stops).toEqual([]);
  await dialog.getByRole('button', { name: en.window.confirm.stop.yes, exact: true }).click();
  await expect.poll(() => live.stops).toEqual(['clara']);
  expect(errors).toEqual([]);
});

for (const width of [1440, 375]) {
  test(`strips stay in reach beside a window on the whole screen at ${width}`, async ({ page }, info) => {
    const { words, errors, windowOf, stripOf, barButton, openEmployee, minimize } = await openCompany(page, { lang: 'en', theme: 'light', width });
    await openEmployee('Bruno');
    await minimize('Bruno');
    await openEmployee('Clara');
    await barButton('Clara', words.full).click();
    await expect(barButton('Clara', words.size)).toBeVisible();
    expect(overlaps(await box(stripOf('Bruno')), await box(windowOf('Clara')))).toBe(false);
    await page.screenshot({ path: info.outputPath(`strip-beside-full-screen-${width}.png`) });
    await stripOf('Bruno').click();
    await expect(windowOf('Bruno')).toBeVisible();
    await stripOf('Clara').click();
    await expect(barButton('Clara', words.size)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('a picture pasted beside a strip goes into the terminal on the screen only', async ({ page }) => {
  const { errors, live, windowOf, stripOf, openEmployee, minimize } = await openCompany(page, { lang: 'en', theme: 'dark', width: 1440 });
  const line = { clara: ['screen.png: hh-fetch message pic1'] };
  await openEmployee('Bruno');
  await minimize('Bruno');
  await openEmployee('Clara');
  await expect(windowOf('Clara').locator('.xterm-rows')).toContainText('clara is at work');
  await pastePicture(page, 'screen.png');
  await expect.poll(() => live.keys).toEqual(line);
  expect(live.pictures).toEqual(['clara']);
  await stripOf('Bruno').click();
  await expect(windowOf('Bruno')).toBeVisible();
  await stripOf('Clara').click();
  await expect(windowOf('Clara')).toBeVisible();
  expect(live.keys).toEqual(line);
  expect(live.pictures).toEqual(['clara']);
  expect(errors).toEqual([]);
});

test('a picture pasted beside a strip goes to the log on the screen only, and waits there through its own strip', async ({ page }) => {
  const { words, errors, windowOf, stripOf, openEmployee, minimize, barButton } = await openCompany(page, { lang: 'en', theme: 'dark', width: 1440 });
  await openEmployee('Bruno');
  await barButton('Bruno', words.log).click();
  await minimize('Bruno');
  /* Clara's window opens with the chat, the last choice made in Bruno's. */
  await openEmployee('Clara');
  await expect(windowOf('Clara').getByRole('log')).toBeVisible();
  await pastePicture(page, 'screen.png');
  const pasted = (name: string) => windowOf(name).getByRole('img', { name: 'screen.png', exact: true });
  await expect(pasted('Clara')).toBeVisible();
  await stripOf('Bruno').click();
  await expect(windowOf('Bruno')).toBeVisible();
  await expect(pasted('Bruno')).toHaveCount(0);
  await stripOf('Clara').click();
  await expect(pasted('Clara')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a task opened from a screen takes the window aside and leaves its strip', async ({ page }) => {
  const { words, errors, tab, windowOf, stripOf, openOrchestrator } = await openCompany(page, { lang: 'en', theme: 'dark', width: 1440 });
  const orchestrator = words.orchestrator;
  await openOrchestrator();
  await tab(words.tasks).click();
  await openTaskCard(page, 2);
  const task = page.getByRole('complementary', { name: '#2 Checkout step 2', exact: true });
  await expect(task).toBeVisible();
  await expect(windowOf(orchestrator)).toBeHidden();
  await expect(stripOf(orchestrator)).toBeVisible();
  await stripOf(orchestrator).click();
  await expect(windowOf(orchestrator)).toBeVisible();
  await expect(task).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a window minimized before its card came is named on its strip, and its terminal opens to its full size', async ({ page }) => {
  const { words, errors, release, windowOf, stripOf, openEmployee, barButton } = await openCompany(page, { lang: 'en', theme: 'dark', width: 1440 }, { held: ['bruno'] });
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const hiddenTitle = page.getByRole('complementary', { name: 'Bruno', exact: true });
  await expect(hiddenTitle).toBeVisible();
  await hiddenTitle.getByRole('button', { name: words.minimize, exact: true }).click();
  const named = page.getByRole('button', { name: 'Restore Bruno', exact: true });
  await expect(named).toBeVisible();
  await expect(named).toContainText('Bruno');
  release('bruno');
  await expect(stripOf('Bruno')).toBeVisible();
  await stripOf('Bruno').click();
  await expect(windowOf('Bruno').locator('.xterm-screen')).toBeVisible();
  await expect.poll(async () => (await box(windowOf('Bruno').locator('.xterm-screen'))).width).toBeGreaterThan(800);
  await openEmployee('Clara');
  await expect(barButton('Clara', words.minimize)).toBeVisible();
  expect(errors).toEqual([]);
});
