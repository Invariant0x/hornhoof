import { test } from '@playwright/test';
import { checkScenes } from './feedback-steps';

/* Part of writing to Hornhoof's developers and their findings and inbox, at one width; feedback-steps.ts says what each
   check holds. */
test.describe.configure({ timeout: 0 });

test('a finding a version fixed and the inbox keep their layout in each theme and language, wide', async ({ page, browserName }, info) => {
  await checkScenes(page, browserName, info, [1440], ['fixed-card', 'inbox']);
});
