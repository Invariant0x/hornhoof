import { describe, expect, it } from 'vitest';
import { drawnArtPaths, type ArtIndex, type ArtIndexEntry } from '../src/world/art';
import { memoryArtFileStore, WorldArtFiles, type ArtFilesProgress } from '../src/world/art-files';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* #1947 item 2, cache by content hash: art-index.json names each file with its size and the hash of its bytes; the
   browser downloads a file once per hash and keeps it, so reopening downloads nothing and an art version change
   downloads only the files whose hash changed. */

const BASE = '/world-art/test/';

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/* A server for one art folder: answers each file's bytes and counts every request. */
function server(files: Record<string, string>) {
  const requests: string[] = [];
  let failing = new Set<string>();
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    const path = url.slice(BASE.length);
    if (path === 'art-index.json') return new Response(JSON.stringify(indexOf(files)), { status: 200 });
    const body = files[path];
    if (body === undefined || failing.has(path)) return new Response('missing', { status: 404 });
    return new Response(bytesOf(body), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return {
    fetch,
    requests,
    pictures: () => requests.filter(u => !u.endsWith('art-index.json')),
    fail: (paths: string[]) => {
      failing = new Set(paths);
    },
  };
}

/* The hash only has to change with the bytes for these tests. */
function indexOf(files: Record<string, string>, unhashed: readonly string[] = []): ArtIndex {
  const entries: Record<string, ArtIndexEntry> = {};
  for (const [path, body] of Object.entries(files)) {
    entries[path] = unhashed.includes(path) ? { w: 1, h: 1 } : { w: 1, h: 1, bytes: bytesOf(body).length, hash: `h${body.length}-${body.charCodeAt(0)}` };
  }
  return { contract: 2, pack: 'test', files: entries };
}

const textOf = async (blob: Blob | null) => (blob ? new TextDecoder().decode(await blob.arrayBuffer()) : null);

describe('World art files are kept in the browser by content hash (#1947)', () => {
  it('downloads every file once on the first visit, with progress by real bytes, and nothing on the next one', async () => {
    const files = { 'ground/plain.png': 'PLAIN-PIXELS', 'buildings/a/complete.png': 'A-PICTURE-BYTES', 'people/m/walk.png': 'WALK' };
    const site = server(files);
    const store = memoryArtFileStore();

    const first = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: site.fetch });
    const missing = await first.missing();
    expect(missing.paths.sort()).toEqual(Object.keys(files).sort());
    expect(missing.bytes).toBe(Object.values(files).reduce((n, b) => n + b.length, 0));

    const seen: ArtFilesProgress[] = [];
    await first.fill(p => seen.push(p));
    expect(site.pictures().sort()).toEqual(Object.keys(files).map(p => BASE + p).sort());
    const last = seen[seen.length - 1]!;
    expect(last).toEqual({ loadedBytes: missing.bytes, totalBytes: missing.bytes, loadedFiles: 3, totalFiles: 3 });
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.loadedBytes).toBeGreaterThanOrEqual(seen[i - 1]!.loadedBytes);
    expect(await textOf(await first.blob('buildings/a/complete.png'))).toBe('A-PICTURE-BYTES');
    expect(site.pictures().length, 'a filled file is read from what was kept').toBe(3);

    /* A reopen: a new page with the same browser storage. */
    const again = server(files);
    const reopened = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: again.fetch });
    expect((await reopened.missing()).paths).toEqual([]);
    await reopened.fill();
    expect(await textOf(await reopened.blob('ground/plain.png'))).toBe('PLAIN-PIXELS');
    expect(again.pictures(), 'nothing but the index on a reopen').toEqual([]);
  });

  it('after an art version change downloads only the changed and the new files, and drops copies nobody lists', async () => {
    const store = memoryArtFileStore();
    const v1 = { 'ground/plain.png': 'PLAIN-1', 'ground/bank.png': 'BANK', 'veg/palm.png': 'PALM' };
    await new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: server(v1).fetch }).fill();

    const v2 = { 'ground/plain.png': 'PLAIN-TWO', 'ground/bank.png': 'BANK', 'veg/reed.png': 'REED' };
    const site = server(v2);
    const next = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: site.fetch });
    expect((await next.missing()).paths.sort()).toEqual(['ground/plain.png', 'veg/reed.png']);
    await next.fill();
    expect(site.pictures().sort()).toEqual([`${BASE}ground/plain.png`, `${BASE}veg/reed.png`]);
    expect(await textOf(await next.blob('ground/plain.png'))).toBe('PLAIN-TWO');
    expect([...(await store.keys())].sort()).toEqual(['test/ground/bank.png', 'test/ground/plain.png', 'test/veg/reed.png']);
  });

  it('keeps nothing of a file the index gives no hash, and reads it from the network each page', async () => {
    const files = { 'ground/plain.png': 'PLAIN', 'veg/palm.png': 'PALM' };
    const store = memoryArtFileStore();
    const indexFetch = (site: ReturnType<typeof server>) => async (url: string) =>
      url.endsWith('art-index.json') ? new Response(JSON.stringify(indexOf(files, ['veg/palm.png']))) : site.fetch(url);
    for (let page = 0; page < 2; page++) {
      const site = server(files);
      const art = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: indexFetch(site) });
      expect((await art.missing()).paths).toEqual(page === 0 ? ['ground/plain.png'] : []);
      await art.fill();
      expect(await textOf(await art.blob('veg/palm.png'))).toBe('PALM');
      expect(site.pictures()).toEqual(page === 0 ? [`${BASE}ground/plain.png`, `${BASE}veg/palm.png`] : [`${BASE}veg/palm.png`]);
    }
  });

  it('keeps no copy of a file that failed to download, counts it done, and tries it again on the next page', async () => {
    const files = { 'ground/plain.png': 'PLAIN', 'ground/bank.png': 'BANK' };
    const store = memoryArtFileStore();
    const site = server(files);
    site.fail(['ground/bank.png']);
    const seen: ArtFilesProgress[] = [];
    const art = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: site.fetch });
    await art.fill(p => seen.push(p));
    expect(seen[seen.length - 1]).toMatchObject({ loadedFiles: 2, totalFiles: 2 });
    expect(await art.blob('ground/bank.png')).toBeNull();
    expect((await new WorldArtFiles({ packId: 'test', baseUrl: BASE, store, fetch: server(files).fetch }).missing()).paths).toEqual(['ground/bank.png']);
  });

  it('shares one download between readers of the same file, and works without any browser storage', async () => {
    const files = { 'ground/plain.png': 'PLAIN' };
    const site = server(files);
    const art = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store: null, fetch: site.fetch });
    const [a, b] = await Promise.all([art.blob('ground/plain.png'), art.blob('ground/plain.png')]);
    expect(await textOf(a)).toBe('PLAIN');
    expect(await textOf(b)).toBe('PLAIN');
    expect(site.pictures()).toEqual([`${BASE}ground/plain.png`]);
    expect(site.requests.filter(u => u.endsWith('art-index.json')), 'the index is read once per page').toHaveLength(1);
  });

  it('downloads only the files the engine draws, and leaves the rest of the folder to the network', async () => {
    const files = { 'ground/plain.png': 'PLAIN', 'veg/veg_sheet.png': 'A-SHEET-NOBODY-DRAWS' };
    const site = server(files);
    const art = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store: memoryArtFileStore(), fetch: site.fetch, wanted: () => new Set(['ground/plain.png']) });
    expect(await art.missing()).toEqual({ paths: ['ground/plain.png'], bytes: 5 });
    await art.fill();
    expect(site.pictures()).toEqual([`${BASE}ground/plain.png`]);
  });

  it('runs one fill per page: a second caller joins it and hears the same progress, and a reader waits for its file', async () => {
    const files = { 'ground/plain.png': 'PLAIN', 'ground/bank.png': 'BANK-BYTES' };
    const site = server(files);
    const art = new WorldArtFiles({ packId: 'test', baseUrl: BASE, store: memoryArtFileStore(), fetch: site.fetch });
    const first: ArtFilesProgress[] = [];
    const second: ArtFilesProgress[] = [];
    const a = art.fill(p => first.push(p));
    const b = art.fill(p => second.push(p));
    const read = art.blob('ground/bank.png');
    await Promise.all([a, b]);
    expect(await textOf(await read)).toBe('BANK-BYTES');
    expect(site.pictures().sort()).toEqual([`${BASE}ground/bank.png`, `${BASE}ground/plain.png`]);
    expect(first[first.length - 1]).toEqual({ loadedBytes: 15, totalBytes: 15, loadedFiles: 2, totalFiles: 2 });
    expect(second[second.length - 1]).toEqual(first[first.length - 1]);
  });
});

describe('The files of an art folder the engine draws (#1947)', () => {
  it('are the catalog slots with the layers and masks their passports name, and the ground, street and plant files the pack names', () => {
    const step = 'buildings/department/shrine/complete.png';
    const picture = { w: 8, h: 8, passport: { groundAnchor: { x: 4, y: 6 }, corners: { top: { x: 4, y: 4 }, right: { x: 8, y: 6 }, bottom: { x: 4, y: 8 }, left: { x: 0, y: 6 } }, layers: [{ file: 'awning.png' }] } };
    const index: ArtIndex = {
      contract: 2,
      pack: 'egypt',
      files: {
        [step]: picture,
        'buildings/department/shrine/awning.png': { w: 8, h: 8 },
        'buildings/department/shrine/awning_w.png': { w: 8, h: 8 },
        [EGYPT_WORLD_PACK.terrainArt!.ground.sand!]: { w: 8, h: 8 },
        [EGYPT_WORLD_PACK.terrainArt!.roads!.dirt!]: { w: 8, h: 8 },
        [EGYPT_WORLD_PACK.plants!.find(k => k.art?.length)!.art![0]!.image]: { w: 8, h: 8 },
        'veg/veg_sheet.png': { w: 8, h: 8 },
        'notes/sketch.png': { w: 8, h: 8 },
      },
    };
    const drawn = drawnArtPaths(EGYPT_WORLD_PACK, index);
    const inFolder = Object.keys(index.files).filter(p => drawn.has(p));
    expect(inFolder.sort()).toEqual(Object.keys(index.files).filter(p => !['veg/veg_sheet.png', 'notes/sketch.png'].includes(p)).sort());
  });
});
