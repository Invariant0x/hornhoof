import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { filesDirRefusal, loadConfig } from '../src/config.js';
import { TEST_SECRET } from './helpers-basic.js';

/* A server in production keeps its files in FILES_DIR; with none it would keep them in a folder of one run, which a
   restart loses, so it does not start (#2036). Development and tests keep that folder. */

describe('a server in production with no FILES_DIR', () => {
  it('says why it does not start, in English and in Russian, naming FILES_DIR', () => {
    const said = filesDirRefusal({ NODE_ENV: 'production' }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET }));
    const [english, russian, ...more] = (said ?? '').split('\n');
    expect(more).toEqual([]);
    expect(english).toMatch(/^FILES_DIR is not set: /);
    expect(russian).toMatch(/^FILES_DIR не задан: /);
    expect(said).not.toMatch(/\u0451/);
  });

  it('starts with FILES_DIR set, and in development and tests without it', () => {
    expect(filesDirRefusal({ NODE_ENV: 'production' }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FILES_DIR: '/files' }))).toBeNull();
    for (const NODE_ENV of [undefined, 'development', 'test']) expect(filesDirRefusal({ NODE_ENV }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET }))).toBeNull();
  });

  it('stops before it opens the database, with that line and a failed exit', async () => {
    const started = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', HORNHOOF_SECRET: TEST_SECRET },
    });
    await expect(started).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('FILES_DIR is not set: ') });
    const failed: { stderr: string } = await started.catch((err: { stderr: string }) => err);
    expect(failed.stderr).toContain('FILES_DIR не задан: ');
    expect(failed.stderr).not.toContain('DATABASE_URL');
  });
});
