import { defineConfig } from '@playwright/test';
import base from './outbound-setup.config';

export default defineConfig({
  ...base,
  testMatch: 'outbound-contact-fields.spec.ts',
  outputDir: 'results/outbound-contact-fields',
  globalTeardown: undefined,
  workers: 1,
});
