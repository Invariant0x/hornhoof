import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestDb, testApp, TEST_SECRET } from './helpers.js';

describe('error logging', () => {
  it('keeps ordinary application logging off unless a logger is supplied', async () => {
    /* A child captures Pino's actual stdout writes without intercepting Vitest's own output. */
    const script = `
      import { buildApp } from ${JSON.stringify(new URL('../src/app.ts', import.meta.url).href)};
      import { loadConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
      const app = await buildApp({ db: null, config: loadConfig({ HORNHOOF_SECRET: ${JSON.stringify(TEST_SECRET)}, UPDATE_CHECK_MS: '0' }) });
      app.log.info('Application log marker.');
      await app.close();
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
    expect(stdout).not.toContain('Application log marker.');
  });

  it('creates the application without a deprecated request logging warning', async () => {
    const warnings: string[] = [];
    const collect = (warning: Error & { code?: string }) => {
      if (warning.code === 'FSTDEP023') warnings.push(warning.message);
    };
    process.on('warning', collect);
    onTestFinished(() => { process.off('warning', collect); });
    const { app } = await testApp();
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(warnings).toEqual([]);
  });

  it('keeps request logs off while ordinary application logs still work', async () => {
    const lines: string[] = [];
    const { app } = await testApp({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lines.join('\n')).not.toMatch(/incoming request|request completed/);
    app.log.info('Manual application log.');
    expect(lines.join('\n')).toContain('Manual application log.');
  });

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
