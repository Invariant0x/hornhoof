import { expect, test } from '@playwright/test';
import { capture, expectNameHover, looks, MESSAGES, PEOPLE, prepare } from './name-links-steps';

/* A person's name in the list of people; name-links-steps.ts says what a name holds. */
for (const { lang, theme, width, look } of looks(['en', 'ru'])) {
  test(`a person's name has color and focus but no hover underline: ${look}`, async ({ page }, info) => {
    const errors = await prepare(page, lang, theme, width);
    await page.route('**/api/people', route => route.fulfill({ json: { people: PEOPLE } }));
    await page.goto('/people');
    const name = page.locator('table.ptable').getByRole('button', { name: /^Dana/ });
    await expect(name).toBeVisible();
    await page.mouse.move(0, 0);
    await name.hover();
    await capture(page, info, `people-${look}`);
    await expectNameHover(name);
    await name.click();
    await expect(page.getByRole('heading', { name: MESSAGES[lang].people.editHeading('Dana') })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
