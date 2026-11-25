/* The world map with its pack, in a chunk of its own (#1973): Map.tsx loads this module only for a theme with a world, so
   a plain theme never downloads the engine, the packs or PixiJS. */
import type { WorldKind } from '../skins/roles';
import { resolveWorldPack } from '../world-packs/registry';
import { WorldMapView, type WorldMapViewProps } from './WorldMapView';

export type WorldMapScreenProps = Omit<WorldMapViewProps, 'pack'> & Readonly<{ world: WorldKind }>;

export default function WorldMapScreen({ world, ...view }: WorldMapScreenProps) {
  const pack = resolveWorldPack(world);
  return pack ? <WorldMapView {...view} pack={pack} /> : null;
}
