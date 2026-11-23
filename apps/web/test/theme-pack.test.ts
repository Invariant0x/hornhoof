/* Hornhoof's own themes packed as archives (docs/theme-archive.md, 11): a theme with no world is its manifest, look and
   licence; a world brings its data, the art given from outside the repository and its voice; the same theme always packs
   to the same bytes. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, packTheme, shippedVoice, themeArchiveFiles, zipOf, type ThemeVoice } from '../scripts/theme-pack';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

const REPO_LICENSE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'LICENSE'));
const VOICE: ThemeVoice = {
  label: { en: 'Night shift', ru: 'Ночная смена' },
  address: { en: 'Good night', ru: 'Доброй ночи' },
  salutations: ['Evening.'],
  names: { ruler: { en: 'Warden', ru: 'Смотритель' }, employees: { en: ['Ada'], ru: ['Ада'] } },
};
const jsonOf = (bytes: Buffer | undefined) => JSON.parse(String(bytes)) as Record<string, unknown>;

/* The files of a plain zip, read back through its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < zip.readUInt16LE(end + 10); n++) {
    const [packed, nameLength, local] = [zip.readUInt32LE(at + 20), zip.readUInt16LE(at + 28), zip.readUInt32LE(at + 42)];
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'), inflateRawSync(zip.subarray(start, start + packed)));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

describe('packing a theme Hornhoof ships', () => {
  let folder = '';
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'theme-pack-'));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /* An art folder as an artist hands it over: pictures and passports in folders, with the index, notes and loose data Hornhoof
     leaves out. */
  const artFolder = () => {
    const art = join(folder, 'art');
    mkdirSync(join(art, 'buildings', 'house'), { recursive: true });
    writeFileSync(join(art, 'buildings', 'house', 'step-1.png'), 'png');
    writeFileSync(join(art, 'buildings', 'house', 'step-1.json'), '{}');
    writeFileSync(join(art, 'ground.png'), 'ground');
    writeFileSync(join(art, 'art-index.json'), '{}');
    writeFileSync(join(art, 'NOTES.txt'), 'notes');
    /* An artist's measurements beside the pictures: data of no picture, which an installed theme may not carry. */
    writeFileSync(join(art, 'colors.json'), '{}');
    return art;
  };

  it("packs a theme with no world as its manifest, its look and Hornhoof's licence", () => {
    const files = themeArchiveFiles('cyberpunk');
    expect([...files.keys()]).toEqual(['theme.json', 'LICENSE', 'ui/look.json']);
    expect(jsonOf(files.get('theme.json'))).toEqual({
      format: 1,
      id: 'cyberpunk',
      name: { en: en.skins.names.cyberpunk, ru: ru.skins.names.cyberpunk },
      description: { en: en.skins.descs.cyberpunk, ru: ru.skins.descs.cyberpunk },
      version: '1.0.0',
      author: 'Hornhoof',
      license: 'MIT',
      contract: { ui: 1 },
      engine: 'none',
      languages: ['en', 'ru'],
    });
    expect(files.get('LICENSE')).toEqual(REPO_LICENSE);
    expect(Object.keys(jsonOf(files.get('ui/look.json')))).not.toContain('id');
    expect(Object.keys(jsonOf(files.get('ui/look.json')))).not.toContain('world');
  });

  it('packs a world with its data, the art and licence given from outside the repository, and its voice', () => {
    const licence = join(folder, 'ART-LICENSE');
    writeFileSync(licence, 'Art: all rights reserved.\n');
    const files = themeArchiveFiles('egypt', { version: '2.1.0', art: artFolder(), licence, voice: VOICE });
    expect([...files.keys()]).toEqual(['theme.json', 'LICENSE', 'ui/look.json', 'world/world.json', 'world/art/buildings/house/step-1.json', 'world/art/buildings/house/step-1.png', 'world/art/ground.png', 'skills/world.json']);
    expect(jsonOf(files.get('theme.json'))).toMatchObject({ id: 'egypt', version: '2.1.0', license: 'see LICENSE', contract: { ui: 1, world: 2 }, engine: 'iso2d' });
    expect(String(files.get('LICENSE'))).toBe('Art: all rights reserved.\n');
    expect(jsonOf(files.get('world/world.json'))).not.toHaveProperty('id');
    expect(jsonOf(files.get('skills/world.json'))).toEqual(VOICE);

    const bare = themeArchiveFiles('egypt');
    expect([...bare.keys()]).toEqual(['theme.json', 'LICENSE', 'ui/look.json', 'world/world.json']);
  });

  it('refuses a theme Hornhoof does not ship', () => {
    expect(() => themeArchiveFiles('nope' as 'cyberpunk')).toThrow('Hornhoof ships no theme "nope".');
  });

  it('writes a plain zip that reads back whole, the same bytes every time', () => {
    const files = themeArchiveFiles('egypt', { voice: VOICE });
    const zip = zipOf(files);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(unzip(zip)).toEqual(files);
    expect(zipOf(themeArchiveFiles('egypt', { voice: VOICE }))).toEqual(zip);
  });

  it("takes a world's voice from the server's own pack, and a theme without a world has none", async () => {
    const voice = await shippedVoice('egypt');
    expect(voice).toMatchObject({ label: { en: expect.any(String), ru: expect.any(String) }, salutations: expect.any(Array) });
    expect(await shippedVoice('cyberpunk')).toBeNull();
    expect(jsonOf(unzip(await packTheme('egypt')).get('skills/world.json'))).toEqual(voice);
    expect(unzip(await packTheme('cyberpunk')).has('skills/world.json')).toBe(false);
    expect(unzip(await packTheme('egypt', { voice: null })).has('skills/world.json')).toBe(false);
  });

  it('runs as a command: it names its use when a theme or the output is missing, and writes the archive', async () => {
    const said = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(folder, 'theme.zip');
    for (const argv of [[], ['cyberpunk'], ['nope', '--out', out]]) expect(await main(argv)).toBe(2);
    expect(said.mock.calls[0]?.[0]).toMatch(/^Usage: theme-pack\.ts <cyberpunk \| .*egypt.*> --out <file\.zip>/);

    expect(await main(['cyberpunk', '--out', out])).toBe(0);
    expect(jsonOf(unzip(readFileSync(out)).get('theme.json'))).toMatchObject({ id: 'cyberpunk', version: '1.0.0', license: 'MIT' });

    const licence = join(folder, 'ART-LICENSE');
    writeFileSync(licence, 'Art licence.\n');
    expect(await main(['egypt', '--out', out, '--art', artFolder(), '--licence', licence, '--version', '3.0.0'])).toBe(0);
    const packed = unzip(readFileSync(out));
    expect(jsonOf(packed.get('theme.json'))).toMatchObject({ id: 'egypt', version: '3.0.0', license: 'see LICENSE' });
    expect(packed.has('world/art/ground.png')).toBe(true);
    expect(said.mock.calls.at(-1)?.[0]).toBe(`${out}: ${readFileSync(out).length} bytes`);
  });
});
