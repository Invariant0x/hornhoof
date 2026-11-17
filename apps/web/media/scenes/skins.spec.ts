import { expect, test } from '@playwright/test';
import { BUILTIN_SKINS } from '../../src/skins/registry';
import { builtinFile, skinText } from '../../src/skins/validate';
import { createSceneRecorder } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage } from '../moonfern/stream';
import { reportUnmocked, smoothScrollTo } from '../moonfern/tracker-scene';

/* A skin of one's own, made from the Cyberpunk sample as the guide says: warm night colors with an amber accent. */
function fernNight(): Buffer {
  const cyberpunk = BUILTIN_SKINS.find(s => s.id === 'cyberpunk')!;
  const file = JSON.parse(skinText(builtinFile(cyberpunk, { en: 'Fern night', ru: 'Ночь папоротника' }))) as { colors: Record<string, string> };
  Object.assign(file.colors, {
    bg: '#1A1512', surface: '#221C18', surface2: '#2A231E', line: '#3A3029', line2: '#7D6B5E', ink: '#F2E9E1', muted: '#B3A396',
    accent: '#FF9E4F', accent_ink: '#FFB97A', button: '#FF9E4F', on_button: '#2A1406', idle: '#3A3129',
    dot: 'rgba(205, 175, 140, .15)', glow: 'rgba(255, 158, 79, .10)', hud: 'rgba(34, 28, 24, .94)', on_attention: '#1A1512',
    scrollbar_thumb: '#7D6B5E', scrollbar_track: '#221C18',
  });
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
}

/* The look changes in one click, from Cyberpunk to Matrix; then a file of one's own joins the catalog and is applied. */
test('skins.gif: from Cyberpunk to Matrix, then a skin of your own from a file', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  await serveMoonfern(page);

  await page.goto('/settings');
  const matrix = page.getByRole('button', { name: 'Apply: Matrix' });
  await expect(matrix).toBeVisible();
  await recorder.markReady();
  await page.waitForTimeout(1300);

  await matrix.click();
  await page.waitForTimeout(2000);

  /* The guide: download a sample, change the colors or ask AI to, add the file. */
  await smoothScrollTo(page, page.getByText('Your own skin in a minute').first(), 80);
  await page.waitForTimeout(1500);
  await page.locator('.skins-add input[type=file]').setInputFiles({ name: 'fern-night.json', mimeType: 'application/json', buffer: fernNight() });
  const own = page.getByRole('button', { name: 'Apply: Fern night' });
  await expect(own).toBeVisible();
  await smoothScrollTo(page, own, 160);
  await page.waitForTimeout(700);
  await own.click();
  await page.waitForTimeout(2300);

  /* Back to Cyberpunk at the top, as the loop began. */
  await page.getByRole('button', { name: 'Apply: Cyberpunk' }).click();
  await smoothScrollTo(page, page.getByRole('button', { name: 'Apply: Matrix' }), 400);
  await page.mouse.move(8, 8);
  await page.waitForTimeout(800);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('skins');
});
