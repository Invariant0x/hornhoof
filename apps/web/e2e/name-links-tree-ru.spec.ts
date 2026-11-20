import { test } from '@playwright/test';
import { agentNames, looks } from './name-links-steps';

/* The names on the cards of the tree in Russian; name-links-steps.ts says what a name holds. */
for (const { lang, theme, width, look } of looks(['ru'])) {
  test(`agent names have color and focus but no hover underline, task links keep it: ${look}`, async ({ page }, info) => {
    test.setTimeout(0);
    await agentNames(page, info, lang, theme, width, look);
  });
}
