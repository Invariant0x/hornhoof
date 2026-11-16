import { test } from '@playwright/test';
import { checkForms } from './stage1-forms-steps';

/* Part of the forms of stage 1 as Design drew them, at one width; stage1-forms-steps.ts says what each check holds. */
test.describe.configure({ timeout: 0 });

test('the forms to connect plans and to paste a key keep their layout in each theme, on the longest and the shortest language, wide', async ({ page, browserName }, info) => {
  await checkForms(page, browserName, info, [1440], ['connect-plans', 'key-form']);
});
