/* Ancient Egypt art catalog: the slots the artists fill by ARTIST_CONTRACT.md.
   Each growth step names its folder under buildings/<kind>/; every file missing from the
   art folder keeps its geometric placeholder. The art itself is licensed separately and
   never lives in this repository. */

import type { WorldArtCatalog } from '../../world/art';
import type { PackRoleLookSpec } from '../../world/manifest';

export function egyptArtCatalog(roleLooks: Readonly<Record<string, PackRoleLookSpec>>): WorldArtCatalog {
  return {
    baseUrl: '/world-art/egypt/',
    buildings: {
      house: [
        /* Variants per step from the art order v3, 3.4 (#1975). */
        { id: 'hut', footprint: '2x2', fromLevel: 1, variants: 15, label: { en: 'Reed hut', ru: 'Хижина' } },
        { id: 'mudbrick', footprint: '3x3', fromLevel: 4, variants: 20, label: { en: 'Mudbrick house', ru: 'Глинобитный дом' } },
        { id: 'painted', footprint: '3x3', fromLevel: 8, variants: 15, label: { en: 'Painted house', ru: 'Расписной дом' } },
        { id: 'villa', footprint: '4x4', fromLevel: 15, variants: 10, label: { en: 'Villa with a pool', ru: 'Вилла с бассейном' } },
      ],
      department: [
        { id: 'shrine', footprint: '3x3', fromStage: 1, label: { en: 'Department shrine', ru: 'Святилище отдела' } },
        { id: 'temple', footprint: '4x4', fromStage: 4, label: { en: 'Department temple', ru: 'Храм отдела' } },
        { id: 'great_temple', footprint: '5x5', fromStage: 8, label: { en: 'Great temple', ru: 'Большой храм' } },
      ],
      residence: [
        { id: 'tent', footprint: '2x2', fromStage: 1, label: { en: 'Tent', ru: 'Шатер' } },
        { id: 'mudbrick_house', footprint: '3x3', fromStage: 2, label: { en: 'Mudbrick house', ru: 'Глинобитный дом' } },
        { id: 'stone_house', footprint: '4x4', fromStage: 3, label: { en: 'Stone house', ru: 'Каменный дом' } },
        { id: 'column_palace', footprint: '5x5', fromStage: 4, label: { en: 'Palace with columns', ru: 'Дворец с колоннами' } },
        { id: 'grand_palace', footprint: '6x6', fromStage: 5, label: { en: 'Grand palace with gardens', ru: 'Большой дворец с садами' } },
      ],
      district_hub: [
        { id: 'workshop', footprint: '3x3', fromStage: 1, label: { en: 'District workshop', ru: 'Мастерская района' } },
        { id: 'great_workshop', footprint: '4x4', fromStage: 2, label: { en: 'Large district workshop', ru: 'Большая мастерская района' } },
        { id: 'workshop_hall', footprint: '5x5', fromStage: 3, label: { en: 'District workshop with a hall', ru: 'Мастерская района с залом' } },
      ],
      supply: [{ id: 'granary', footprint: '3x3', label: { en: 'Granary by the water', ru: 'Амбар у воды' } }],
      flophouse: [
        { id: 'camp', footprint: '2x2', fromStage: 1, label: { en: 'Day laborer camp', ru: 'Лагерь поденщиков' } },
        { id: 'barracks', footprint: '3x3', fromStage: 3, label: { en: 'Day laborer barracks', ru: 'Ночлежка поденщиков' } },
      ],
      statue: [
        { id: 'small', footprint: '1x1', label: { en: 'Small statue', ru: 'Малая статуя' } },
        { id: 'medium', footprint: '2x2', label: { en: 'Statue', ru: 'Статуя' } },
        { id: 'colossus', footprint: '3x3', label: { en: 'Colossus', ru: 'Колосс' } },
      ],
      monument: [
        { id: 'pyramid_small', footprint: '4x4', label: { en: 'Goal pyramid', ru: 'Пирамида цели' } },
        { id: 'pyramid', footprint: '5x5', label: { en: 'Large goal pyramid', ru: 'Большая пирамида цели' } },
        { id: 'great_pyramid', footprint: '6x6', label: { en: 'Great pyramid of the main goal', ru: 'Великая пирамида главной цели' } },
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
    /* The Nile harbour (#2006, checklist H1 to H6); the land gate is for worlds without a river. */
    harbour: { yards: ['2x2', '3x3', '4x4'] },
  };
}
