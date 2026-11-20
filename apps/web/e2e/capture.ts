import type { Locator, Page, TestInfo } from '@playwright/test';

export const captureWith = (phase: string, directory: string | undefined) => async (page: Page | Locator, info: TestInfo, name: string): Promise<void> => {
  const file = `${phase}-${name}.png`;
  const path = directory ? `${directory}/${file}` : info.outputPath(file);
  await page.screenshot({ path });
  await info.attach(file, { path, contentType: 'image/png' });
};
