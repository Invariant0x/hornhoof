import { expect, test } from '@playwright/test';
import { messagesFor, openScene, prepare, SCENES, shoot, whole, WIDTHS } from './feedback-steps';

/* Writing to Hornhoof's developers in About and their inbox, mirrored for a language written right to left. */
test.describe.configure({ timeout: 0 });

test('mirrors writing to the developers in About and the inbox for a language written right to left', async ({ page, browserName }, info) => {
  /* No shipped language is written right to left yet; this checks the rule on English with the page turned. */
  const words = await messagesFor('en');
  const inbox = { value: false };
  await prepare(page, inbox);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    inbox.value = false;
    const box = await openScene(page, SCENES[0]!, words);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    /* About is narrow, so each label stands over its field, its words from the right edge. */
    const label = await box.locator('.field > label').first().evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const words = range.getBoundingClientRect();
      return element.getBoundingClientRect().right - words.right;
    });
    expect(label, 'the label starts on the right').toBeLessThan(1);
    const kinds = box.locator('.fb-kinds button');
    expect((await kinds.nth(0).boundingBox())!.x, 'Bug, the first kind, is on the right').toBeGreaterThan((await kinds.nth(2).boundingBox())!.x);
    const frame = (await box.boundingBox())!;
    const main = (await box.getByRole('button', { name: words.common.next, exact: true }).boundingBox())!;
    await expect(box.getByRole('button', { name: words.common.cancel, exact: true }), 'About has its own close, so no Cancel').toHaveCount(0);
    expect(main.x - frame.x, 'Next stands at the end, the left edge').toBeLessThan(frame.width / 2);
    expect(await whole(page, box)).toEqual([]);
    await box.screenshot({ path: info.outputPath(`${browserName}/rtl-${width}-feedback-write.png`), animations: 'disabled' });

    const fixed = await openScene(page, SCENES.find(s => s.name === 'fixed-card')!, words);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    expect(await fixed.locator('.imp-fixed').evaluate(e => [getComputedStyle(e).borderRightWidth, getComputedStyle(e).borderLeftWidth]), 'the line of the fix is on the start side, the right').toEqual(['3px', '0px']);
    expect(await whole(page, fixed)).toEqual([]);
    await shoot(page, fixed, info.outputPath(`${browserName}/rtl-${width}-fixed-card.png`));

    const sent = await openScene(page, SCENES.find(s => s.name === 'sent-card')!, words);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const press = (await sent.getByRole('button', { name: words.improvements.reportRepeats(3), exact: true }).boundingBox())!;
    const sentBox = (await sent.boundingBox())!;
    expect(press.x + press.width - sentBox.x, 'the press starts on the right').toBeGreaterThan(sentBox.width / 2);
    expect(await whole(page, sent)).toEqual([]);
    await shoot(page, sent, info.outputPath(`${browserName}/rtl-${width}-sent-card.png`));

    inbox.value = true;
    const list = await openScene(page, SCENES.find(s => s.name === 'inbox')!, words);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const first = list.locator('.fb-card').first();
    expect(await first.evaluate(e => [getComputedStyle(e).borderRightWidth, getComputedStyle(e).borderLeftWidth]), 'the priority line is on the start side, the right').toEqual(['3px', '1px']);
    const issue = (await first.getByRole('button', { name: words.inbox.issue, exact: true }).boundingBox())!;
    const cardBox = (await first.boundingBox())!;
    expect(issue.x - cardBox.x, 'the button stands at the end, the left edge').toBeLessThan(cardBox.width / 2);
    expect(await whole(page, list)).toEqual([]);
    await shoot(page, list, info.outputPath(`${browserName}/rtl-${width}-inbox.png`));
  }
});
