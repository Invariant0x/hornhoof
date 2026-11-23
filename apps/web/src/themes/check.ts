/// <reference types="node" />
/* The checks of a theme archive's look and world that the screens' own code holds (docs/theme-archive.md, 3.1, 4.1 and
   4.2), as one module the server loads: the web build bundles it for node (theme-check.config.ts), and the server's
   tests read it from here. An uploaded theme is so held to exactly what Hornhoof's own themes are. */

import type { ThemeArtFile, ThemeWebCheck, ThemeWorldInput } from '@hornhoof/protocol/themes';
import { WORLD_BUILDING_KINDS } from '@hornhoof/protocol/world';
import { normalizePassport, readPngSize } from '../../scripts/world-art-index';
import { parseLook } from '../skins/validate';
import { ART_CONTRACT_VERSION, validateArtIndex, type ArtIndex, type ArtIndexEntry, type ArtIndexReport, type ArtPassport } from '../world/art';
import type { WorldPackManifest } from '../world/manifest';
import { worldPackOfData } from '../world-packs/data-pack';

const SHOWN = 3;

/* The art index of a theme's pictures, built as the art check builds it from a folder: a cloak has no passport. */
function artIndexOf(art: readonly ThemeArtFile[], pack: string): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const file of art) {
    const size = readPngSize(Buffer.from(file.head));
    if (!size) continue;
    const passport = !file.path.endsWith('.cloak.png') && file.passport !== undefined ? (normalizePassport(file.passport) as ArtPassport) : undefined;
    files[file.path] = passport ? { ...size, passport } : size;
  }
  return { contract: ART_CONTRACT_VERSION, pack, files };
}

export const checkLook: ThemeWebCheck['checkLook'] = (raw, families) => {
  const parsed = parseLook(raw, families);
  return parsed.ok ? { ok: true, value: parsed.look } : { ok: false, detail: JSON.stringify([parsed.error.code, parsed.error.key ?? '', parsed.error.value ?? '']) };
};

/* Whether a world brings its own art whole: its catalog has pictures for every kind of building the city grows and for
   its residents, and the archive holds every picture the catalog requires. Anything less leaves the engine drawing its
   placeholders, which a person never gets from a theme they pick (#1960, #1972). */
function artWhole(pack: WorldPackManifest, report: ArtIndexReport): boolean {
  const art = pack.art;
  if (!art || !art.people?.looks.length || report.missingRequired.length) return false;
  return WORLD_BUILDING_KINDS.every(kind => (art.buildings[kind]?.length ?? 0) > 0);
}

export const checkWorld: ThemeWebCheck['checkWorld'] = (input: ThemeWorldInput) => {
  const built = worldPackOfData(input.id, input.world, input.baseUrl);
  if (!built.ok) return { ok: false, code: 'world_bad', detail: built.errors.slice(0, SHOWN).join(' ') };
  const index = artIndexOf(input.art, input.id);
  const report = validateArtIndex(built.pack, index);
  if (!report.ok) return { ok: false, code: 'art_bad', detail: report.errors.slice(0, SHOWN).join(' ') };
  return { ok: true, world: input.world, artIndex: index, complete: artWhole(built.pack, report), missing: report.missingRequired.length };
};
