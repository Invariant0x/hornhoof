import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_SECRET } from './helpers.js';

describe('loadConfig', () => {
  it('refuses a PORT that is not a port number', () => {
    for (const PORT of ['abc', '0', '65536', '80.5']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT })).toThrow('PORT must be a number between 1 and 65535.');
    }
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT: '3000' }).port).toBe(3000);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).port).toBe(8080);
  });
});
