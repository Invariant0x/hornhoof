/* The files of a built dist's art folder that its pack's art check accepts (Design, 24.11: one bad file never
   switches the whole index off). The web build's index writer loads this through Vite when the build ends, so the Vite
   config itself imports no engine code. A folder of no known pack keeps every file. */

import { acceptedArtIndex, type ArtIndex, type HeldArtFile } from '../src/world/art';
import { resolveWorldPack } from '../src/world-packs/registry';

export function acceptPackArt(packId: string, index: ArtIndex): { index: ArtIndex; held: HeldArtFile[] } {
  const pack = resolveWorldPack(packId);
  if (!pack?.art) return { index, held: [] };
  const accepted = acceptedArtIndex(pack, index);
  return { index: accepted.index, held: accepted.held };
}
