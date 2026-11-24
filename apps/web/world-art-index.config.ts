/* The art index of a world art folder, written from the files it holds (#1947): each PNG with its size, the passport
   JSON beside it, its byte size and a hash of its bytes. The artists' check (scripts/world-art-index.ts) writes it into
   their folder; the web build writes it into every art folder of its dist as its last step, so a release never ships
   an index the build did not write. The build holds out what the art check rejects, as the check does
   (scripts/world-art-accept.ts, loaded through Vite when the build ends). Node only, and only the art contract's
   constants from the app, so the Vite config can load it without the engine. */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ART_CONTRACT_VERSION, ART_INDEX_FILE } from './src/world/art-contract.js';
import type { ArtIndex, ArtIndexEntry, ArtPassport, HeldArtFile } from './src/world/art.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngSize(data: Buffer): { w: number; h: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

const camel = (key: string): string => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/* Passports may use snake_case keys and [x, y] pairs; the engine reads camelCase and { x, y }. */
export function normalizePassport(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every(v => typeof v === 'number') && key !== 'workSlots') {
      return { x: value[0], y: value[1] };
    }
    return value.map(v => normalizePassport(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const ck = camel(k);
      out[ck] = normalizePassport(v, ck);
    }
    return out;
  }
  return value;
}

function walkPngs(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkPngs(root, full, out);
    else if (name.toLowerCase().endsWith('.png')) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/* The version of a file's bytes in art-index.json: the browser keeps one copy per hash (art-files.ts, #1947). */
export function contentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function buildArtIndexFromFolder(folder: string, packId: string): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const rel of walkPngs(folder)) {
    const data = readFileSync(join(folder, rel));
    const size = readPngSize(data);
    if (!size) continue;
    let passport: ArtPassport | undefined;
    if (!rel.endsWith('.cloak.png')) {
      const jsonPath = join(folder, rel.replace(/\.png$/i, '.json'));
      try {
        passport = normalizePassport(JSON.parse(readFileSync(jsonPath, 'utf8'))) as ArtPassport;
      } catch {
        passport = undefined;
      }
    }
    const file = { ...size, bytes: data.length, hash: contentHash(data) };
    files[rel] = passport ? { ...file, passport } : file;
  }
  return { contract: ART_CONTRACT_VERSION, pack: packId, files };
}

/* The art check's verdict on one pack's folder: the files it accepts, and those it holds out with why. */
export type AcceptArt = (packId: string, index: ArtIndex) => { index: ArtIndex; held: readonly HeldArtFile[] };

/* Writes art-index.json into every art folder of a built web dist from the files the dist holds, with their sizes and
   content hashes, over whatever index the art folder brought. The packs written; none for a build without art. */
export function writeDistArtIndexes(dist: string, print: (line: string) => void, accept?: AcceptArt): string[] {
  const root = join(dist, 'world-art');
  if (!existsSync(root)) return [];
  const written: string[] = [];
  for (const pack of readdirSync(root).sort()) {
    const folder = join(root, pack);
    if (!statSync(folder).isDirectory()) continue;
    const built = buildArtIndexFromFolder(folder, pack);
    const verdict = accept ? accept(pack, built) : { index: built, held: [] };
    for (const h of verdict.held) print(`world-art/${pack}: held out ${h.path}: ${h.reasons.join('; ')}`);
    const index = verdict.index;
    writeFileSync(join(folder, ART_INDEX_FILE), `${JSON.stringify(index, null, 1)}\n`);
    print(`world-art/${pack}/${ART_INDEX_FILE}: ${Object.keys(index.files).length} files with their hashes.`);
    written.push(pack);
  }
  return written;
}

/* The art check's verdict, from the web app at root (apps/web); a missing checker fails the build, never skips it. */
const ART_CHECKER = 'scripts/world-art-accept.ts';

/* The web build's last step: the art index of the dist comes out of the build itself, never from a hand-made file. */
export function worldArtIndexPlugin(): { name: string; apply: 'build'; configResolved: (config: { root: string; build: { outDir: string } }) => void; closeBundle: () => Promise<void> } {
  let outDir = '';
  let root = '';
  return {
    name: 'hornhoof-world-art-index',
    apply: 'build',
    configResolved: config => {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: async () => {
      const { runnerImport } = await import('vite');
      const { module } = await runnerImport<{ acceptPackArt: AcceptArt }>(resolve(root, ART_CHECKER));
      writeDistArtIndexes(outDir, line => console.log(line), module.acceptPackArt);
    },
  };
}
