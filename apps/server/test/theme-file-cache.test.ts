import { describe, expect, it } from 'vitest';
import type { Files } from '../src/modules/files/files.js';
import { themeFileBytes } from '../src/modules/themes/store.js';

/* The theme files the app keeps opened (docs/theme-archive.md, 10): about 64 MB of them, the ones asked for last. This
   file of its own holds no other theme file opened, so what the app keeps is what these tests opened. */

const MB = 1024 ** 2;
const db = {} as Parameters<typeof themeFileBytes>[1];

/* A store that gives each content as 8 MB of its own first letter, a moment after it is asked, and counts each time. */
function slowStore() {
  const asked: string[] = [];
  const files: Pick<Files, 'bytes'> = {
    bytes: async (_db, sha256) => {
      asked.push(sha256);
      await new Promise(resolve => setTimeout(resolve, 5));
      return Buffer.alloc(8 * MB, sha256.charCodeAt(0));
    },
  };
  return { files, asked };
}

describe('the theme files the app keeps opened', () => {
  it('counts a file asked for twice at once as one, and so keeps 64 MB of them, the file it kept first too', async () => {
    const { files, asked } = slowStore();
    const [one, again] = await Promise.all([themeFileBytes(files, db, 'a'), themeFileBytes(files, db, 'a')]);
    expect(one.equals(again)).toBe(true);
    for (const sha256 of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) await themeFileBytes(files, db, sha256);
    asked.length = 0;
    expect((await themeFileBytes(files, db, 'a'))[0]).toBe('a'.charCodeAt(0));
    expect(asked).toEqual([]);
  });
});
