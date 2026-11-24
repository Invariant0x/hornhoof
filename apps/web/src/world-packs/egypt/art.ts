/* Ancient Egypt art catalog: the slots the artists fill by ARTIST_CONTRACT.md.
   Each growth step names its folder under buildings/<kind>/; every file missing from the
   art folder keeps its geometric placeholder. The art itself is licensed separately and
   never lives in this repository. */

import type { WorldArtCatalog } from '../../world/art';
import type { PackRoleLookSpec } from '../../world/manifest';
import { text } from '../../world/pack-text';

export function egyptArtCatalog(roleLooks: Readonly<Record<string, PackRoleLookSpec>>): WorldArtCatalog {
  return {
    baseUrl: '/world-art/egypt/',
    buildings: {
      house: [
        /* Variants per step from the art order v3, 3.4 (#1975). */
        { id: 'hut', footprint: '2x2', fromLevel: 1, variants: 15, label: text('Reed hut') },
        { id: 'mudbrick', footprint: '3x3', fromLevel: 4, variants: 20, label: text('Mudbrick house') },
        { id: 'painted', footprint: '3x3', fromLevel: 8, variants: 15, label: text('Painted house') },
        { id: 'villa', footprint: '4x4', fromLevel: 15, variants: 10, label: text('Villa with a pool') },
      ],
      department: [
        { id: 'shrine', footprint: '3x3', fromStage: 1, label: text('Department shrine') },
        { id: 'temple', footprint: '4x4', fromStage: 4, label: text('Department temple') },
        { id: 'great_temple', footprint: '5x5', fromStage: 8, label: text('Great temple') },
      ],
      residence: [
        { id: 'tent', footprint: '2x2', fromStage: 1, label: text('Tent') },
        { id: 'mudbrick_house', footprint: '3x3', fromStage: 2, label: text('Mudbrick house') },
        { id: 'stone_house', footprint: '4x4', fromStage: 3, label: text('Stone house') },
        { id: 'column_palace', footprint: '5x5', fromStage: 4, label: text('Palace with columns') },
        { id: 'grand_palace', footprint: '6x6', fromStage: 5, label: text('Grand palace with gardens') },
      ],
      district_hub: [
        { id: 'workshop', footprint: '3x3', fromStage: 1, label: text('District workshop') },
        { id: 'great_workshop', footprint: '4x4', fromStage: 2, label: text('Large district workshop') },
        { id: 'workshop_hall', footprint: '5x5', fromStage: 3, label: text('District workshop with a hall') },
      ],
      supply: [{ id: 'granary', footprint: '3x3', label: text('Granary by the water') }],
      flophouse: [
        { id: 'camp', footprint: '2x2', fromStage: 1, label: text('Day laborer camp') },
        { id: 'barracks', footprint: '3x3', fromStage: 3, label: text('Day laborer barracks') },
      ],
      statue: [
        { id: 'small', footprint: '1x1', label: text('Small statue') },
        { id: 'medium', footprint: '2x2', label: text('Statue') },
        { id: 'colossus', footprint: '3x3', label: text('Colossus') },
      ],
      monument: [
        { id: 'pyramid_small', footprint: '4x4', label: text('Goal pyramid') },
        { id: 'pyramid', footprint: '5x5', label: text('Large goal pyramid') },
        { id: 'great_pyramid', footprint: '6x6', label: text('Great pyramid of the main goal') },
      ],
    },
    altar: true,
    flags: { district: true, department: true },
    people: {
      looks: [...new Set(Object.values(roleLooks).map(look => look.id))],
      tiers: 5,
      largeItemLooks: [...new Set(Object.values(roleLooks).filter(look => look.largeItem).map(look => look.id))],
      /* Accepted on #1983 under the earlier rule (carry in 5 rows and a mirror); its export in NE, SE, SW and NW replaces it. */
      acceptedSheets: { 'people/egypt-mason/tier_1/carry.png': 'egypt-mason-t1-r1' },
    },
    loops: ['crane', 'hoist_block', 'dust', 'smoke', 'water', 'awning', 'celebration'],
    /* Statues and pyramids carry their scaffolds and ramps in their own stages (order v3, 3.10). */
    ownConstruction: ['statue', 'monument'],
    bridge: true,
  };
}
