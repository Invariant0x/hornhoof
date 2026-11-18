import type { Page, TestInfo } from '@playwright/test';
import { expect, it } from 'vitest';
import { captureWith } from '../e2e/capture';

it('keeps a capture in the test output and attaches that same image', async () => {
  const images: string[] = [];
  const attachments: { name: string; path: string; contentType: string }[] = [];
  const page = { screenshot: async ({ path }: { path: string }) => { images.push(path); } } as unknown as Page;
  const info = {
    outputPath: (file: string) => `/test-output/project-case/${file}`,
    attach: async (name: string, options: { path: string; contentType: string }) => { attachments.push({ name, ...options }); },
  } as unknown as TestInfo;

  await captureWith('hide-secret', undefined)(page, info, 'en-light');

  expect(images).toEqual(['/test-output/project-case/hide-secret-en-light.png']);
  expect(attachments).toEqual([{ name: 'hide-secret-en-light.png', path: images[0], contentType: 'image/png' }]);
});
