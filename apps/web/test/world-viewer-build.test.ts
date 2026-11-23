import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyArt, missingArt, packFolder, prepareOutDir } from '../scripts/build-world-viewer';
import { ART_CONTRACT_VERSION } from '../src/world/art';

/* The build of the static map viewer: which art goes beside the page, and the one archive it ships as. */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'world-viewer-build-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function put(root: string, path: string, text = path): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('the art beside the page', () => {
  it('names the files the art folder lacks', () => {
    const art = join(scratch, 'art');
    put(art, 'ground/plain.png');
    expect(missingArt(art, ['ground/plain.png', 'veg/reed_01.png', 'veg/reed_01.json'])).toEqual(['veg/reed_01.png', 'veg/reed_01.json']);
  });

  it('copies only the named files into their folders and an art index that asks for no building art', () => {
    const art = join(scratch, 'art');
    put(art, 'ground/plain.png', 'sand');
    put(art, 'ground/edges/river_bank.png', 'edge');
    put(art, 'ground/README.md');
    put(art, 'SOURCES.md');
    const out = join(scratch, 'out', 'world-art', 'egypt');
    copyArt(art, out, ['ground/plain.png', 'ground/edges/river_bank.png'], 'egypt');
    expect(readFileSync(join(out, 'ground/plain.png'), 'utf8')).toBe('sand');
    expect(readFileSync(join(out, 'ground/edges/river_bank.png'), 'utf8')).toBe('edge');
    expect(existsSync(join(out, 'ground/README.md'))).toBe(false);
    expect(existsSync(join(out, 'SOURCES.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'art-index.json'), 'utf8'))).toEqual({ contract: ART_CONTRACT_VERSION, pack: 'egypt', files: {} });
  });
});

describe('the build folder', () => {
  it('takes a new or empty folder', () => {
    const fresh = join(scratch, 'fresh');
    prepareOutDir(fresh);
    expect(existsSync(fresh)).toBe(true);
    prepareOutDir(fresh);
  });

  it('never writes into a folder that holds anything', () => {
    const used = join(scratch, 'used');
    put(used, 'notes.txt');
    expect(() => prepareOutDir(used)).toThrow(/not empty/);
    expect(readFileSync(join(used, 'notes.txt'), 'utf8')).toBe('notes.txt');
  });
});

describe('the archive', () => {
  it('packs the folder under its own name into one .tar.gz', () => {
    const folder = join(scratch, 'egypt-map');
    put(folder, 'index.html');
    put(folder, 'assets/viewer.js');
    put(folder, 'world-art/egypt/ground/plain.png');
    const archive = join(scratch, 'egypt-map.tar.gz');
    packFolder(folder, archive);
    const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line && !line.endsWith('/'))
      .sort();
    expect(listed).toEqual(['egypt-map/assets/viewer.js', 'egypt-map/index.html', 'egypt-map/world-art/egypt/ground/plain.png']);
  });
});
