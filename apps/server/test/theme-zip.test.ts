import { THEME_LIMITS, type ThemeProblem } from '@hornhoof/protocol/themes';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ArchiveRefused, bufferSource, fileSource, openZip } from '../src/modules/themes/zip.js';
import { zipOf, type ZipFixtureEntry } from './zip-fixture.js';

/* The zip reader of theme archives (docs/theme-archive.md, sections 8 and 9): it takes a plain zip and refuses one that
   hides more than it says, before it unpacks a byte of it. */

const read = async (zip: Buffer, limits = THEME_LIMITS) => {
  const files = await openZip(bufferSource(zip), limits);
  return Promise.all(files.map(async file => [file.path, (await file.read()).toString('utf8')]));
};
const refusal = async (zip: Buffer, limits = THEME_LIMITS): Promise<ThemeProblem> => {
  try {
    const files = await openZip(bufferSource(zip), limits);
    for (const file of files) await file.read();
  } catch (error) {
    if (error instanceof ArchiveRefused) return error.problem;
    throw error;
  }
  throw new Error('The archive was taken.');
};
const one = (over: Partial<ZipFixtureEntry>) => zipOf([{ name: 'theme.json', data: '{}', ...over }]);

describe('a plain zip', () => {
  it('gives every file, stored or deflated, by its path', async () => {
    const zip = zipOf([{ name: 'theme.json', data: '{"format":1}' }, { name: 'ui/', data: '' }, { name: 'ui/look.json', data: '{"scheme":"dark"}', method: 0 }]);
    expect(await read(zip)).toEqual([['theme.json', '{"format":1}'], ['ui/look.json', '{"scheme":"dark"}']]);
  });

  it('reads the same from a file on disk, without holding the archive in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hh-theme-zip-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'theme.zip');
    await writeFile(path, zipOf([{ name: 'theme.json', data: '{"format":1}' }], { comment: 'made by hand' }));
    const handle = await open(path, 'r');
    onTestFinished(() => handle.close());
    const [file] = await openZip(await fileSource(handle), THEME_LIMITS);
    expect([file!.path, (await file!.read()).toString()]).toEqual(['theme.json', '{"format":1}']);
  });

  it('leaves out what a Mac adds when it packs a folder', async () => {
    const zip = zipOf([{ name: 'theme.json', data: '{}' }, { name: '__MACOSX/._theme.json', data: 'x' }, { name: 'ui/.DS_Store', data: 'x' }, { name: 'ui/._look.json', data: 'x' }]);
    expect((await read(zip)).map(([path]) => path)).toEqual(['theme.json']);
  });
});

describe('a zip that is not plain', () => {
  it.each([
    ['not a zip at all', Buffer.from('PK\u0003\u0004 but nothing after'), 'not_zip'],
    ['bytes after its end', zipOf([{ name: 'a.json', data: '{}' }], { after: Buffer.from('more') }), 'not_zip'],
    ['split over disks', zipOf([{ name: 'a.json', data: '{}' }], { disk: 1 }), 'zip_split'],
    ['ZIP64', zipOf([{ name: 'a.json', data: '{}' }], { zip64Locator: true }), 'zip64'],
    ['ZIP64 sizes', one({ size: 0xffffffff }), 'zip64'],
    ['encrypted', one({ flags: 0x0801 }), 'zip_encrypted'],
    ['packed another way', one({ method: 12 }), 'zip_method'],
    ['a count that is not its directory', zipOf([{ name: 'a.json', data: '{}' }], { count: 2 }), 'zip_corrupt'],
  ] as const)('refuses one %s', async (_what, zip, code) => {
    expect((await refusal(zip)).code).toBe(code);
  });

  it('refuses a file whose bytes are not what its checksum says', async () => {
    expect(await refusal(one({ crc: 1 }))).toEqual({ code: 'zip_corrupt', path: 'theme.json' });
  });

  it('refuses a file whose local name is not the name the directory gives it', async () => {
    expect(await refusal(one({ localName: '../../etc/passwd' }))).toEqual({ code: 'zip_corrupt', path: 'theme.json' });
  });

  it('refuses two files that share their bytes, the way a small zip unpacks to many times its size', async () => {
    const zip = zipOf([{ name: 'a.json', data: '{"a":1}' }, { name: 'b.json', data: '{"a":1}', offset: 0 }]);
    expect(await refusal(zip)).toEqual({ code: 'zip_corrupt', path: 'b.json' });
  });
});

describe('its paths', () => {
  it.each([
    ['../escape.json'], ['ui/../../escape.json'], ['/etc/passwd'], ['C:/theme.json'], ['ui\\look.json'], ['ui//look.json'], ['./theme.json'],
    ['ui/look\u0000.json'], ['ui/look\u202e.json'], ['ui/лук.json'], ['ui/look json'], [`ui/${'a'.repeat(THEME_LIMITS.pathLength)}.json`],
  ])('refuses %j', async name => {
    expect(await refusal(zipOf([{ name, data: '{}' }]))).toMatchObject({ code: 'path_unsafe' });
  });

  it('refuses a link, whatever it points at', async () => {
    expect(await refusal(one({ name: 'ui/look.json', data: '/etc/passwd', externalAttrs: (0o120777 << 16) >>> 0 }))).toEqual({ code: 'path_link', path: 'ui/look.json' });
  });

  it('refuses a name twice, or two names that differ only in case', async () => {
    expect(await refusal(zipOf([{ name: 'ui/look.json', data: '{}' }, { name: 'ui/look.json', data: '{}' }]))).toEqual({ code: 'path_twice', path: 'ui/look.json' });
    expect(await refusal(zipOf([{ name: 'ui/Look.json', data: '{}' }, { name: 'ui/look.json', data: '{}' }]))).toEqual({ code: 'path_twice', path: 'ui/look.json' });
  });
});

describe('its size', () => {
  const small = { ...THEME_LIMITS, archiveBytes: 4096, unpackedBytes: 4096, files: 3, fileBytes: 2048, ratioFrom: 1024 };

  it('refuses an archive over its limit before it reads it', async () => {
    expect(await refusal(zipOf([{ name: 'a.json', data: Buffer.alloc(8192, 7), method: 0 }]), small)).toEqual({ code: 'archive_too_large' });
  });

  it('refuses more files than the limit', async () => {
    expect(await refusal(zipOf(['a', 'b', 'c', 'd'].map(n => ({ name: `${n}.json`, data: '{}' }))), small)).toEqual({ code: 'too_many_files' });
  });

  it('refuses a file over its limit, and files that together unpack to more than the archive may', async () => {
    expect(await refusal(zipOf([{ name: 'a.json', data: Buffer.alloc(2049, 32) }]), small)).toEqual({ code: 'file_too_large', path: 'a.json' });
    const four = zipOf(['a', 'b', 'c'].map(n => ({ name: `${n}.json`, data: Buffer.alloc(1500, 32) })));
    expect(await refusal(four, { ...small, ratio: 1000 })).toEqual({ code: 'unpacked_too_large' });
  });

  it('refuses a file packed far tighter than pictures, fonts and words pack', async () => {
    expect(await refusal(zipOf([{ name: 'a.json', data: Buffer.alloc(2000, 32) }]), small)).toEqual({ code: 'packed_too_tightly', path: 'a.json' });
  });

  it('refuses a file that unpacks to more than its header says, and stops unpacking it there', async () => {
    const bomb = Buffer.alloc(THEME_LIMITS.fileBytes * 4, 0);
    expect(await refusal(one({ data: bomb, size: 10 }))).toEqual({ code: 'zip_corrupt', path: 'theme.json' });
  });
});
