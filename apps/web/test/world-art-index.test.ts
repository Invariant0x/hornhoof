import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArtIndexFromFolder, normalizePassport, readPngSize, runArtCheck } from '../scripts/world-art-index';
import { ART_CONTRACT_VERSION, type BuildingPicturePassport } from '../src/world/art';

/* PNG signature and IHDR chunk are all the size reader needs. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const dirs: string[] = [];
function tempArt(): string {
  const dir = mkdtempSync(join(tmpdir(), 'world-art-'));
  dirs.push(dir);
  return dir;
}

function put(root: string, rel: string, data: Buffer | string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, data);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Stage 9 art check command: builds art-index.json from an artist folder and checks it', () => {
  it('reads PNG sizes from the header and refuses files that are not PNG', () => {
    expect(readPngSize(pngHeader(736, 900))).toEqual({ w: 736, h: 900 });
    expect(readPngSize(Buffer.from('not a png at all, just text here'))).toBeNull();
  });

  it('accepts passports with snake_case keys and [x, y] points as well as the camelCase form', () => {
    const p = normalizePassport({
      ground_anchor: [368, 712],
      corners: { top: [368, 532], right: [728, 712], bottom: [368, 892], left: [8, 712] },
      flag_anchor: { x: 300, y: 120 },
      work_slots: [{ x: 300, y: 600, layer: 'front' }],
    }) as BuildingPicturePassport;
    expect(p.groundAnchor).toEqual({ x: 368, y: 712 });
    expect(p.corners.right).toEqual({ x: 728, y: 712 });
    expect(p.flagAnchor).toEqual({ x: 300, y: 120 });
    expect(p.workSlots).toEqual([{ x: 300, y: 600, layer: 'front' }]);
  });

  it('indexes every PNG with its size and the passport beside it, and reports what is still missing', () => {
    const root = tempArt();
    put(root, 'buildings/department/shrine/complete.png', pngHeader(736, 900));
    put(
      root,
      'buildings/department/shrine/complete.json',
      JSON.stringify({
        groundAnchor: { x: 368, y: 712 },
        corners: { top: { x: 368, y: 532 }, right: { x: 728, y: 712 }, bottom: { x: 368, y: 892 }, left: { x: 8, y: 712 } },
      }),
    );
    put(root, 'people/egypt-mason/tier_1/walk.png', pngHeader(1088, 1000));
    put(root, 'people/egypt-mason/tier_1/walk.json', JSON.stringify({ frameW: 136, frameH: 200, frames: 8, fps: 10, anchor: [68, 190] }));
    put(root, 'people/egypt-mason/tier_1/walk.cloak.png', pngHeader(1088, 1000));
    put(root, 'notes.txt', 'ignored');

    const index = buildArtIndexFromFolder(root, 'egypt');
    expect(index.contract).toBe(ART_CONTRACT_VERSION);
    expect(index.pack).toBe('egypt');
    expect(Object.keys(index.files).sort()).toEqual([
      'buildings/department/shrine/complete.png',
      'people/egypt-mason/tier_1/walk.cloak.png',
      'people/egypt-mason/tier_1/walk.png',
    ]);
    expect(index.files['people/egypt-mason/tier_1/walk.png']?.passport).toMatchObject({ anchor: { x: 68, y: 190 } });
    expect(index.files['people/egypt-mason/tier_1/walk.cloak.png']?.passport).toBeUndefined();

    const lines: string[] = [];
    const result = runArtCheck({ folder: root, pack: 'egypt', write: true, list: false, print: l => lines.push(l) });
    expect(result.ok).toBe(true);
    const out = lines.join('\n');
    expect(out).toMatch(/3 files in the folder/);
    expect(out).toMatch(/still missing \d+ required files/);
    const written = JSON.parse(readFileSync(join(root, 'art-index.json'), 'utf8'));
    expect(written.files['buildings/department/shrine/complete.png'].w).toBe(736);
  });

  it('fails with the file named when a passport breaks the contract, and writes nothing', () => {
    const root = tempArt();
    put(root, 'buildings/department/shrine/complete.png', pngHeader(736, 900));
    put(root, 'buildings/department/shrine/complete.json', JSON.stringify({ groundAnchor: [100, 100], corners: { top: [368, 532], right: [728, 712], bottom: [368, 892], left: [8, 712] } }));
    const lines: string[] = [];
    const result = runArtCheck({ folder: root, pack: 'egypt', write: true, list: false, print: l => lines.push(l) });
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toMatch(/shrine\/complete\.png: groundAnchor/);
    expect(() => readFileSync(join(root, 'art-index.json'))).toThrow();
  });

  it('lists every file the pack has a slot for, required ones marked, for the artists', () => {
    const lines: string[] = [];
    const result = runArtCheck({ folder: null, pack: 'egypt', write: false, list: true, print: l => lines.push(l) });
    expect(result.ok).toBe(true);
    expect(lines).toContain('required  buildings/house/hut/complete.png');
    expect(lines).toContain('optional  buildings/house/villa/annex.png');
    expect(lines).toContain('required  modules/6x6/stakes.png');
    expect(lines.some(l => l.endsWith('people/egypt-pharaoh/tier_5/pray.png'))).toBe(true);
  });

  it('refuses an unknown pack', () => {
    const lines: string[] = [];
    expect(runArtCheck({ folder: null, pack: 'nope', write: false, list: true, print: l => lines.push(l) }).ok).toBe(false);
    expect(lines.join('\n')).toMatch(/Unknown pack "nope"/);
  });
});
