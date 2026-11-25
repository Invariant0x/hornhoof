/* A world art folder of the browser tests' own (#1947): ground pictures painted in one colour each, served to every
   page of a context with art-index.json written from them, so a test needs no artist files. */

import type { BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { ART_CONTRACT_VERSION, type ArtIndex } from '../src/world/art';

const ART = '/world-art/egypt/';

/* A PNG of one colour: signature, IHDR, the deflated rows, IEND. */
export function solidPng(size: number, rgba: readonly [number, number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgba).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type Folder = Map<string, Buffer>;

function indexOf(folder: Folder): ArtIndex {
  const files: Record<string, { w: number; h: number; bytes: number; hash: string }> = {};
  for (const [path, data] of folder) {
    files[path] = { w: data.readUInt32BE(16), h: data.readUInt32BE(20), bytes: data.length, hash: createHash('sha256').update(data).digest('hex').slice(0, 16) };
  }
  return { contract: ART_CONTRACT_VERSION, pack: 'egypt', files };
}

/* The ground pictures the Egypt pack names, each its own colour. */
export function groundFolder(): Folder {
  return new Map([
    ['ground/plain.png', solidPng(256, [214, 190, 140, 255])],
    ['ground/bank.png', solidPng(256, [150, 128, 92, 255])],
    ['ground/fertile.png', solidPng(256, [96, 128, 64, 255])],
    ['ground/cleared.png', solidPng(256, [190, 170, 130, 255])],
  ]);
}

/* Serves the folder to every page of the context and counts the requests for its pictures. */
export async function serveArt(context: BrowserContext, folder: { current: Folder }) {
  const pictures: string[] = [];
  await context.route(`**${ART}**`, route => {
    const path = new URL(route.request().url()).pathname.slice(ART.length);
    if (path === 'art-index.json') return route.fulfill({ json: indexOf(folder.current), headers: { 'cache-control': 'no-cache' } });
    const data = folder.current.get(path);
    if (!data) return route.fulfill({ status: 404, body: 'not found' });
    pictures.push(path);
    return route.fulfill({ body: data, contentType: 'image/png', headers: { 'cache-control': 'no-cache' } });
  });
  return pictures;
}
