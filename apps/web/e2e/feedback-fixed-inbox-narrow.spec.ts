import { test } from '@playwright/test';
import { checkScenes } from './feedback-steps';

/* Part of writing to Hornhoof's developers and their findings and inbox, at one width; feedback-steps.ts says what each
   check holds. */
test.describe.configure({ timeout: 0 });

test('a finding a version fixed and the inbox keep their layout in each theme and language, narrow', async ({ page, browserName }, info) => {
  await checkScenes(page, browserName, info, [375], ['fixed-card', 'inbox']);
});
