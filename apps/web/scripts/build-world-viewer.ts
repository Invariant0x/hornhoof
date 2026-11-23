/* Builds the static map viewer (world-viewer.html) into one folder that opens from a plain static host under any
   sub-path: index.html, its scripts and the pack's ground, water and plant art beside it, every address relative.
     npx tsx apps/web/scripts/build-world-viewer.ts --out <new folder> [--art <art folder> | --no-art] [--archive <file.tar.gz>]
   Without --art it takes apps/web/public/world-art/egypt, where the licensed art lives outside the repository, and
   builds without art when that folder is absent. The folder must be new or empty: the build never deletes anything. */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ART_CONTRACT_VERSION, ART_INDEX_FILE, type ArtIndex } from '../src/world/art';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import { packArtFiles } from '../src/world-packs/viewer-core';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'world-viewer.html';
const PACK = EGYPT_WORLD_PACK;
const DEFAULT_ART = join(WEB, 'public', 'world-art', PACK.id);

export function missingArt(artDir: string, files: readonly string[]): string[] {
  return files.filter(path => !existsSync(join(artDir, path)));
}

/* The named files into their folders, and an index naming no building or people art, so the engine asks for none. */
export function copyArt(artDir: string, outArtDir: string, files: readonly string[], packId: string): void {
  for (const path of files) {
    const to = join(outArtDir, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(artDir, path), to);
  }
  const index: ArtIndex = { contract: ART_CONTRACT_VERSION, pack: packId, files: {} };
  mkdirSync(outArtDir, { recursive: true });
  writeFileSync(join(outArtDir, ART_INDEX_FILE), `${JSON.stringify(index)}\n`);
}

export function prepareOutDir(outDir: string): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty: give a new or empty folder`);
  }
  mkdirSync(outDir, { recursive: true });
}

export function packFolder(folder: string, archive: string): void {
  execFileSync('tar', ['-czf', resolve(archive), '-C', dirname(resolve(folder)), basename(resolve(folder))]);
}

export type ViewerBuild = Readonly<{ outDir: string; artFiles: readonly string[] }>;

/* artDir null builds a viewer that asks for no art at all. */
export async function buildWorldViewer(options: Readonly<{ outDir: string; artDir: string | null }>): Promise<ViewerBuild> {
  const outDir = resolve(options.outDir);
  const files = options.artDir ? packArtFiles(PACK) : [];
  if (options.artDir) {
    const missing = missingArt(options.artDir, files);
    if (missing.length > 0) throw new Error(`the art folder ${options.artDir} lacks ${missing.length} files: ${missing.join(', ')}`);
  }
  prepareOutDir(outDir);
  const { build } = await import('vite');
  await build({
    configFile: false,
    root: WEB,
    /* Every address relative to the page, so any folder of any host serves it. */
    base: './',
    publicDir: false,
    mode: 'production',
    logLevel: 'warn',
    define: { 'import.meta.env.VITE_WORLD_VIEWER_ART': JSON.stringify(options.artDir ? 'relative' : 'none') },
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: { input: join(WEB, PAGE) },
      chunkSizeWarningLimit: 4096,
    },
  });
  renameSync(join(outDir, PAGE), join(outDir, 'index.html'));
  if (options.artDir) copyArt(options.artDir, join(outDir, 'world-art', PACK.id), files, PACK.id);
  return { outDir, artFiles: files };
}

function argValue(args: readonly string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1]! : null;
}

async function main(args: readonly string[]): Promise<void> {
  const out = argValue(args, '--out');
  if (!out) throw new Error('usage: build-world-viewer.ts --out <new folder> [--art <art folder> | --no-art] [--archive <file.tar.gz>]');
  const artDir = args.includes('--no-art') ? null : (argValue(args, '--art') ?? (existsSync(DEFAULT_ART) ? DEFAULT_ART : null));
  if (!artDir) console.warn('No art folder: the viewer draws the procedural ground and plants.');
  const result = await buildWorldViewer({ outDir: out, artDir });
  console.log(`Built ${result.outDir} with ${result.artFiles.length} art files.`);
  const archive = argValue(args, '--archive');
  if (archive) {
    packFolder(result.outDir, archive);
    console.log(`Packed ${resolve(archive)}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
