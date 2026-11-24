/* Art check for world pack artists (ARTIST_CONTRACT.md):
     npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <id> [--write]
     npx tsx apps/web/scripts/world-art-index.ts --pack <id> --list
     npx tsx apps/web/scripts/world-art-index.ts --dist <web dist> --pack <id>
   Reads every PNG in the folder with the passport JSON beside it, checks them against the pack
   catalog and the contract, prints what is wrong or missing, and with --write saves
   art-index.json, which the engine reads to know which files to draw.
   With --dist it checks a built web dist instead: it fails unless <dist>/world-art/<id>/art-index.json
   lists art the pack draws and the dist holds every file it lists at the size and content hash the index
   gives, so a production build cannot ship the placeholder look, or art the browser cannot keep, without
   anyone noticing. The web build writes that index itself (world-art-index.config.ts).
   Not yet a step of the image build (Dockerfile): the art is licensed for Hornhoof only and may not
   go into the public repository or the public image, so the build has no source for it yet, and the
   check would stop every image from main. It joins the image build in the change that brings the art
   source (#1944). */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptedArtIndex, ART_INDEX_FILE, declaredArtFiles, validateArtIndex, type ArtIndex, type ArtIndexEntry } from '../src/world/art';
import type { WorldPackManifest } from '../src/world/manifest';
import { resolveWorldPack } from '../src/world-packs/registry';
import { buildArtIndexFromFolder, contentHash, readPngSize } from '../world-art-index.config';

export { buildArtIndexFromFolder, contentHash, normalizePassport, readPngSize, worldArtIndexPlugin, writeDistArtIndexes } from '../world-art-index.config';

export type ArtCheckOptions = Readonly<{
  folder: string | null;
  pack: string;
  write: boolean;
  list: boolean;
  print: (line: string) => void;
}>;

/* ok: every file of the folder passes; held: the files left out of the index, which the engine draws without (the
   index of the rest is still written, so ok is false but written true); written: whether art-index.json was written. */
export function runArtCheck(opts: ArtCheckOptions): { ok: boolean; held: string[]; written: boolean } {
  const pack = resolveWorldPack(opts.pack);
  if (!pack?.art) {
    opts.print(`Unknown pack "${opts.pack}" or a pack without an art catalog.`);
    return { ok: false, held: [], written: false };
  }
  if (opts.list) {
    for (const d of declaredArtFiles(pack)) opts.print(`${d.required ? 'required' : 'optional'}  ${d.path}`);
  }
  if (!opts.folder) return { ok: true, held: [], written: false };

  const folderIndex = buildArtIndexFromFolder(opts.folder, pack.id);
  const { index, held, report } = acceptedArtIndex(pack, folderIndex);
  opts.print(`${Object.keys(folderIndex.files).length} files in the folder, ${report.declared} slots in pack "${pack.id}".`);
  if (!report.ok) {
    for (const e of report.errors) opts.print(`ERROR ${e}`);
    opts.print('Nothing written: fix the errors above first.');
    return { ok: false, held: [], written: false };
  }
  /* A rejected file is held out, not fatal: the engine draws its slot from the nearest drawn picture, or its placeholder. */
  for (const h of held) opts.print(`HELD OUT ${h.path}: ${h.reasons.join('; ')}`);
  for (const w of report.warnings) opts.print(`WARNING ${w}`);
  opts.print(`still missing ${report.missingRequired.length} required files (run with --list to see every slot).`);
  if (held.length > 0) opts.print(`${held.length} files held out of ${ART_INDEX_FILE}: fix them and check again, and list them in the pack's notes meanwhile.`);
  if (opts.write) {
    writeFileSync(join(opts.folder, ART_INDEX_FILE), `${JSON.stringify(index, null, 1)}\n`);
    opts.print(`Wrote ${ART_INDEX_FILE} with ${Object.keys(index.files).length} files.`);
  }
  return { ok: held.length === 0, held: held.map(h => h.path), written: opts.write };
}

export type DistArtCheckOptions = Readonly<{
  dist: string;
  pack: string;
  print: (line: string) => void;
}>;

/* The dist's art index, or in words why the build has none. */
function readDistIndex(folder: string, label: string): ArtIndex | string {
  const indexPath = join(folder, ART_INDEX_FILE);
  if (!existsSync(indexPath)) return `${label}/${ART_INDEX_FILE} is missing`;
  let index: Partial<ArtIndex> | null;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<ArtIndex> | null;
  } catch (err) {
    return `${label}/${ART_INDEX_FILE} is not readable JSON: ${(err as Error).message}`;
  }
  return typeof index?.files === 'object' && index.files ? (index as ArtIndex) : `${label}/${ART_INDEX_FILE} has no files list`;
}

function distFileProblem(folder: string, label: string, path: string, entry: ArtIndexEntry): string | null {
  const full = join(folder, path);
  const data = existsSync(full) ? readFileSync(full) : null;
  const size = data ? readPngSize(data) : null;
  if (!data || !size) return `${label}/${path} is listed but not in the build`;
  if (size.w !== entry.w || size.h !== entry.h) return `${label}/${path} is ${size.w} x ${size.h} in the build, the index says ${entry.w} x ${entry.h}`;
  /* The browser keeps each file by its hash (#1947): without one it downloads the file on every visit, and with a wrong
     one it keeps a copy that never updates. The build writes the index (worldArtIndexPlugin), so this means a dist not
     built by it. */
  if (!entry.hash || entry.bytes === undefined) return `${label}/${path} has no content hash: the web build writes the index, rebuild the dist`;
  const hash = contentHash(data);
  if (entry.hash !== hash || entry.bytes !== data.length) return `${label}/${path} has hash ${entry.hash} in the index, its bytes ${hash}`;
  return null;
}

function drawnFiles(pack: WorldPackManifest, index: ArtIndex): string[] {
  const declared = new Set(declaredArtFiles(pack).map(d => d.path));
  return Object.keys(index.files).filter(path => declared.has(path));
}

function distIndexProblem(pack: WorldPackManifest, folder: string, label: string, index: ArtIndex): string | null {
  const { errors } = validateArtIndex(pack, index);
  if (errors.length > 0) return `${label}/${ART_INDEX_FILE}: ${errors.join('; ')}`;
  if (drawnFiles(pack, index).length === 0) return `${label}/${ART_INDEX_FILE} lists no art the pack draws`;
  for (const [path, entry] of Object.entries(index.files)) {
    const problem = distFileProblem(folder, label, path, entry);
    if (problem) return problem;
  }
  return null;
}

function distFailed(opts: DistArtCheckOptions, problem: string): { ok: false } {
  opts.print(`ERROR ${problem} (web dist ${opts.dist}).`);
  opts.print(`The build would show the placeholder look of pack "${opts.pack}" instead of its art.`);
  return { ok: false };
}

/* The production check: the built web dist must hold the pack's art index, with art the pack draws, and every file it lists. */
export function checkDistArt(opts: DistArtCheckOptions): { ok: boolean } {
  const pack = resolveWorldPack(opts.pack);
  if (!pack?.art) {
    opts.print(`Unknown pack "${opts.pack}" or a pack without an art catalog.`);
    return { ok: false };
  }
  const label = `world-art/${pack.id}`;
  const folder = join(opts.dist, 'world-art', pack.id);
  const index = readDistIndex(folder, label);
  if (typeof index === 'string') return distFailed(opts, index);
  const problem = distIndexProblem(pack, folder, label, index);
  if (problem) return distFailed(opts, problem);
  opts.print(`${drawnFiles(pack, index).length} art files of pack "${pack.id}" in the build (${Object.keys(index.files).length} files listed in all).`);
  return { ok: true };
}

const USAGE = 'Usage: world-art-index.ts <art folder> --pack <id> [--write] | --pack <id> --list | --dist <web dist> --pack <id>';

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const value = argv[argv.indexOf(flag) + 1];
  return argv.includes(flag) && value && !value.startsWith('--') ? value : undefined;
}

export function main(argv: readonly string[], print: (line: string) => void = l => console.log(l)): number {
  const pack = flagValue(argv, '--pack');
  const dist = flagValue(argv, '--dist');
  if (!pack || (argv.includes('--dist') && !dist)) {
    print(USAGE);
    return 2;
  }
  const folder = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--pack') ?? null;
  const result = dist
    ? checkDistArt({ dist, pack, print })
    : runArtCheck({ folder, pack, write: argv.includes('--write'), list: argv.includes('--list'), print });
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
