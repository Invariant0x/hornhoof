import { expect, test } from '@playwright/test';
import { createSceneRecorder, smoothScrollBody } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';

test('setup.gif: type Moonfern, pick Startup among the nine templates, go on', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page, { setupNeeded: true });

  await page.goto('/?code=mf9k2x7p');
  await expect(page.getByRole('heading', { name: 'Name your company' })).toBeVisible();
  await expect(page.locator('.template-card')).toHaveCount(10);
  await recorder.markReady();

  await page.waitForTimeout(550);
  const input = page.getByLabel('Company name');
  await input.click();
  await input.pressSequentially('Moonfern', { delay: 95 });

  await expect(page.getByText('moonfern.hornhoof.org is free.')).toBeVisible();
  await page.waitForTimeout(550);

  /* Scroll gently to showcase the nine templates with their mini org charts, then pick Startup. */
  await smoothScrollBody(page, 210, 8, 42);
  await page.waitForTimeout(500);

  const startupCard = page.locator('.template-card', { hasText: 'Startup' });
  await startupCard.scrollIntoViewIfNeeded();
  await startupCard.click();
  await expect(startupCard).toHaveClass(/on/);
  await page.waitForTimeout(1200);

  const nextButton = page.getByRole('button', { name: 'Next', exact: true });
  await nextButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await nextButton.click();

  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByText('You become the CEO of Moonfern and can see and run every department.')).toBeVisible();
  await page.waitForTimeout(1500);

  /* Step back to step 0, clear input and return smoothly to top so first and last frames match. */
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Name your company' })).toBeVisible();
  await page.locator('.template-card').first().click();
  const resetInput = page.getByLabel('Company name');
  await resetInput.fill('');
  await resetInput.focus();
  await page.mouse.move(8, 8);
  await smoothScrollBody(page, 0, 8, 40);
  await page.waitForTimeout(600);

  watcher.assertClean();
  await recorder.finishGif('setup');
});
