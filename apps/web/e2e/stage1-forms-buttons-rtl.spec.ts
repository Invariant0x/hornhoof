import { expect, test, type Locator } from '@playwright/test';
import { FORMS, INVITE, messagesFor, noSideScroll, openForm, PEOPLE, prepare, WIDTHS } from './stage1-forms-steps';

/* A main button of a stage 1 form while it works, and a form mirrored for a language written right to left. */
test.describe.configure({ timeout: 0 });

test('a main button keeps its width while it says what it does', async ({ page }) => {
  const words = await messagesFor('ru');
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'ru'));
  await prepare(page);
  let release: () => void = () => {};
  await page.route('**/api/people/invite', async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ status: 201, json: { person: PEOPLE[2], inviteUrl: INVITE } }); });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const form = await openForm(page, FORMS[0]!, words);
    await form.getByLabel(words.common.name, { exact: true }).fill('Oleg');
    await form.getByLabel(words.common.email, { exact: true }).fill('oleg@acme.com');
    const main = form.getByRole('button', { name: words.people.createInvite, exact: true });
    const foot = form.locator('.form-foot');
    /* Measured from the card, so a scroll the click makes to reach the button moves nothing. */
    const inCard = async (inner: Locator) => {
      const [box, card] = [(await inner.boundingBox())!, (await form.boundingBox())!];
      return { x: box.x - card.x, y: box.y - card.y, width: box.width, height: box.height };
    };
    const before = { main: await inCard(main), foot: await inCard(foot) };
    await main.click();
    const busy = form.getByRole('button', { name: words.common.creating, exact: true });
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    expect({ main: await inCard(busy), foot: await inCard(foot) }).toEqual(before);
    release();
    await expect(page.getByText(INVITE, { exact: true })).toBeVisible();
  }
});

test('mirrors a form for a language written right to left: labels at the start, buttons at the end, codes left to right', async ({ page }, info) => {
  /* No shipped language is written right to left yet; this checks the rule on English with the page turned. */
  const words = await messagesFor('en');
  await prepare(page);
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const form = await openForm(page, FORMS[3]!, words);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const label = await form.locator('.field > label').first().boundingBox();
    const input = await form.locator('.field input').first().boundingBox();
    if (width === 1440) expect(label!.x, 'the label column is on the right').toBeGreaterThan(input!.x + input!.width - 1);
    const card = (await form.boundingBox())!;
    const main = (await form.getByRole('button', { name: words.common.save, exact: true }).boundingBox())!;
    const cancel = (await form.getByRole('button', { name: words.common.cancel, exact: true }).boundingBox())!;
    expect(main.x, 'Save is first from the right').toBeGreaterThan(cancel.x);
    expect(cancel.x - card.x, 'the group stands at the end, the left edge').toBeLessThan(card.width / 2);
    expect(await form.getByLabel('Telegram', { exact: true }).evaluate(e => getComputedStyle(e).direction)).toBe('ltr');
    expect(await noSideScroll(page)).toBe(true);
    await form.screenshot({ path: info.outputPath(`rtl-${width}-edit-person.png`), animations: 'disabled' });
  }
});
