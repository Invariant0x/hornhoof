/* Art check for world pack artists (ARTIST_CONTRACT.md):
     npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <id> [--write]
     npx tsx apps/web/scripts/world-art-index.ts --pack <id> --list
     npx tsx apps/web/scripts/world-art-index.ts --dist <web dist> --pack <id>
   Reads every PNG in the folder with the passport JSON beside it, checks them against the pack
   catalog and the contract, prints what is wrong or missing, and with --write saves
   art-index.json, which the engine reads to know which files to draw.
   With --dist it checks a built web dist instead: it fails unless <dist>/world-art/<id>/art-index.json
   lists art the pack draws and the dist holds every file it lists, so a production build cannot ship
   the placeholder look without anyone noticing.
   Not yet a step of the image build (Dockerfile): the art is licensed for Hornhoof only and may not
   go into the public repository or the public image, so the build has no source for it yet, and the
   check would stop every image from main. It joins the image build in the change that brings the art
   source (#1944). */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ART_CONTRACT_VERSION,
  ART_INDEX_FILE,
  declaredArtFiles,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
  type ArtPassport,
} from '../src/world/art';
import type { WorldPackManifest } from '../src/world/manifest';
import { resolveWorldPack } from '../src/world-packs/registry';

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

export function buildArtIndexFromFolder(folder: string, packId: string): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const rel of walkPngs(folder)) {
    const size = readPngSize(readFileSync(join(folder, rel)));
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
    files[rel] = passport ? { ...size, passport } : size;
  }
  return { contract: ART_CONTRACT_VERSION, pack: packId, files };
}

export type ArtCheckOptions = Readonly<{
  folder: string | null;
  pack: string;
  write: boolean;
  list: boolean;
  print: (line: string) => void;
}>;

export function runArtCheck(opts: ArtCheckOptions): { ok: boolean } {
  const pack = resolveWorldPack(opts.pack);
  if (!pack?.art) {
    opts.print(`Unknown pack "${opts.pack}" or a pack without an art catalog.`);
    return { ok: false };
  }
  if (opts.list) {
    for (const d of declaredArtFiles(pack)) opts.print(`${d.required ? 'required' : 'optional'}  ${d.path}`);
  }
  if (!opts.folder) return { ok: true };

  const index = buildArtIndexFromFolder(opts.folder, pack.id);
  const report = validateArtIndex(pack, index);
  opts.print(`${report.present} files in the folder, ${report.declared} slots in pack "${pack.id}".`);
  for (const e of report.errors) opts.print(`ERROR ${e}`);
  for (const w of report.warnings) opts.print(`WARNING ${w}`);
  opts.print(`still missing ${report.missingRequired.length} required files (run with --list to see every slot).`);
  if (!report.ok) {
    opts.print('Nothing written: fix the errors above first.');
    return { ok: false };
  }
  if (opts.write) {
    writeFileSync(join(opts.folder, ART_INDEX_FILE), `${JSON.stringify(index, null, 1)}\n`);
    opts.print(`Wrote ${ART_INDEX_FILE}.`);
  }
  return { ok: true };
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
  const size = existsSync(full) ? readPngSize(readFileSync(full)) : null;
  if (!size) return `${label}/${path} is listed but not in the build`;
  if (size.w === entry.w && size.h === entry.h) return null;
  return `${label}/${path} is ${size.w} x ${size.h} in the build, the index says ${entry.w} x ${entry.h}`;
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
