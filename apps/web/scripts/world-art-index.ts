/* Art check for world pack artists (ARTIST_CONTRACT.md):
     npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <id> [--write]
     npx tsx apps/web/scripts/world-art-index.ts --pack <id> --list
   Reads every PNG in the folder with the passport JSON beside it, checks them against the pack
   catalog and the contract, prints what is wrong or missing, and with --write saves
   art-index.json, which the engine reads to know which files to draw. */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

function main(argv: readonly string[]): number {
  const packAt = argv.indexOf('--pack');
  const pack = packAt >= 0 ? argv[packAt + 1] : undefined;
  const folder = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--pack') ?? null;
  if (!pack) {
    console.error('Usage: world-art-index.ts <art folder> --pack <id> [--write] | --pack <id> --list');
    return 2;
  }
  const result = runArtCheck({ folder, pack, write: argv.includes('--write'), list: argv.includes('--list'), print: l => console.log(l) });
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
