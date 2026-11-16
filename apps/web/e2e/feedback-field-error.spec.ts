import { expect, test } from '@playwright/test';
import { dialog, heights, lowestContrast, messagesFor, prepare, setLook, shoot, watchProblems, whole } from './feedback-steps';

/* A field of the feedback form with an error: its pink frame, its focus ring, and the error gone once a title is typed (#1028). */
test.describe.configure({ timeout: 0 });

test('frames an empty title in pink, keeps its focus ring visible, and clears the error as soon as a title is typed', async ({ page, browserName }, info) => {
  const problems = watchProblems(page);
  const inbox = { value: false };
  const words = await messagesFor('ru');
  const shots = process.env.SHOTS;
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, inbox);
  await page.goto('/');

  for (const choice of ['cyberpunk', 'light'] as const) {
    await setLook(page, choice, 'ru');
    const box = await dialog(page, words);
    await page.evaluate(async () => { await document.fonts.ready; });
    const about = page.getByRole('dialog', { name: words.about.title, exact: true });
    const title = box.getByLabel(words.feedback.titleLabel, { exact: true });
    const text = box.getByLabel(words.feedback.text, { exact: true });
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.display = 'none';
      document.body.append(probe);
      const read = (token: string) => {
        probe.style.borderTopColor = `var(${token})`;
        return getComputedStyle(probe).borderTopColor;
      };
      const out = { pink: read('--pink'), cyan: read('--cyan'), cyanInk: read('--cyan-ink'), line2: read('--line2') };
      probe.remove();
      return out;
    });

    await text.fill('После обновления окно терминала перестало отвечать.');
    await box.getByRole('button', { name: words.common.next, exact: true }).click();
    const bad = box.getByText(words.feedback.titleRequired, { exact: true });
    await expect(bad).toBeVisible();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveAttribute('aria-describedby', (await bad.getAttribute('id'))!);
    expect(await title.evaluate(e => {
      const s = getComputedStyle(e);
      return [s.borderTopWidth, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor];
    }), `${choice} in ${browserName}: pink frame on invalid input`).toEqual(['1px', tokens.pink, tokens.pink, tokens.pink, tokens.pink]);
    expect((await lowestContrast(about)).ratio, `${choice} in ${browserName}: contrast with error`).toBeGreaterThanOrEqual(4.5);
    expect(await heights(box), `${choice} in ${browserName}: heights with error`).toEqual([]);
    expect(await whole(page, about), `${choice} in ${browserName}: whole with error`).toEqual([]);

    const errorShot = `field-error-${choice}-${browserName}.png`;
    await shoot(page, about, shots ? `${shots}/${errorShot}` : info.outputPath(`${browserName}/${errorShot}`));

    await title.focus();
    expect(await title.evaluate(e => {
      const s = getComputedStyle(e);
      return [s.borderTopColor, s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor];
    }), `${choice} in ${browserName}: visible focus ring on invalid input`).toEqual([tokens.pink, 'solid', '2px', '2px', tokens.cyanInk]);

    /* Select and textarea inside .field share the same rule and focus ring. */
    expect(await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.className = 'field new-task';
      const select = document.createElement('select');
      select.setAttribute('aria-invalid', 'true');
      const area = document.createElement('textarea');
      area.setAttribute('aria-invalid', 'true');
      wrap.append(select, area);
      document.body.append(wrap);
      const rest = [getComputedStyle(select).borderTopColor, getComputedStyle(area).borderTopColor];
      select.focus();
      const selectFocus = [getComputedStyle(select).borderTopColor, getComputedStyle(select).outlineStyle, getComputedStyle(select).outlineWidth];
      area.focus();
      const areaFocus = [getComputedStyle(area).borderTopColor, getComputedStyle(area).outlineStyle, getComputedStyle(area).outlineWidth];
      wrap.remove();
      return { rest, selectFocus, areaFocus };
    }), `${choice} in ${browserName}: shared rule on select and textarea`).toEqual({
      rest: [tokens.pink, tokens.pink],
      selectFocus: [tokens.pink, 'solid', '2px'],
      areaFocus: [tokens.pink, 'solid', '2px'],
    });

    await title.fill('Терминал завис после обновления');
    await expect(bad).toBeHidden();
    await expect(title).not.toHaveAttribute('aria-invalid');
    await title.focus();
    expect(await title.evaluate(e => getComputedStyle(e).borderTopColor), `${choice} in ${browserName}: cyan frame when focused after typing`).toBe(tokens.cyan);
    await title.evaluate((e: HTMLElement) => e.blur());
    expect(await title.evaluate(e => getComputedStyle(e).borderTopColor), `${choice} in ${browserName}: resting frame after typing`).toBe(tokens.line2);

    const typedShot = `field-after-input-${choice}-${browserName}.png`;
    await shoot(page, about, shots ? `${shots}/${typedShot}` : info.outputPath(`${browserName}/${typedShot}`));
  }
  expect(problems).toEqual([]);
});
