import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestDb, TEST_SECRET } from './helpers.js';

describe('error logging', () => {
  it('logs an unexpected failure while the client gets a generic 500', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      db: await createTestDb(),
      config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET }),
      logger: { level: 'error', stream: { write: (line: string) => void lines.push(line) } },
    });
    app.get('/api/boom', async () => {
      throw new Error('database went away');
    });
    const res = await app.inject({ url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
    expect(res.body).not.toContain('database went away');
    expect(lines.join('\n')).toContain('database went away');
  });
});
