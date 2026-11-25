import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { filesDirRefusal } from '../src/files-dir.js';
import { wordLanguages } from '../src/locales/index.js';
import { TEST_SECRET } from './helpers-basic.js';

/* A server in production, or behind a keeper, keeps its files in FILES_DIR; with none it would keep them in a folder of
   one run, which a restart loses, so it does not start (#2036). Development and tests keep that folder. */

describe('a server in production with no FILES_DIR', () => {
  it('says why it does not start, a line in each language the server has, English first, each naming FILES_DIR', () => {
    const said = filesDirRefusal({ NODE_ENV: 'production' }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET }));
    const lines = (said ?? '').split('\n');
    expect(lines).toHaveLength(wordLanguages().length);
    expect(lines[0]).toMatch(/^FILES_DIR is not set: /);
    for (const line of lines) expect(line).toMatch(/^FILES_DIR /);
    expect(new Set(lines).size).toBe(lines.length);
    expect(said).not.toMatch(/\u0451/);
  });

  it('starts with FILES_DIR set, and in development and tests without it', () => {
    expect(filesDirRefusal({ NODE_ENV: 'production' }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FILES_DIR: '/files' }))).toBeNull();
    for (const NODE_ENV of [undefined, 'development', 'test']) expect(filesDirRefusal({ NODE_ENV }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET }))).toBeNull();
  });

  it('does not start behind a keeper without FILES_DIR, whatever NODE_ENV says, as its files go to the other machines from there', () => {
    for (const NODE_ENV of [undefined, 'development', 'production']) {
      expect(filesDirRefusal({ NODE_ENV }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_KEEPER: 'on' })), `NODE_ENV ${NODE_ENV}`).toContain('FILES_DIR');
      expect(filesDirRefusal({ NODE_ENV }, loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_KEEPER: 'on', FILES_DIR: '/files' }))).toBeNull();
    }
  });

  it('stops before it opens the database, with that line and a failed exit', async () => {
    const started = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', HORNHOOF_SECRET: TEST_SECRET },
    });
    await expect(started).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('FILES_DIR is not set: ') });
    const failed: { stderr: string } = await started.catch((err: { stderr: string }) => err);
    expect(failed.stderr).not.toContain('DATABASE_URL');
  });
});
