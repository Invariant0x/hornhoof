# Ancient Egypt pack: art list

The general rules, sizes and file formats are in [`../../world/ARTIST_CONTRACT.md`](../../world/ARTIST_CONTRACT.md). This page names what the Egypt pack asks for. The art is licensed separately and never goes into this repository; its folder is served at `/world-art/egypt/`.

Style: the approved reference pictures (01 ETALON for the final look, 02 to 05 for the city at different sizes and the "no subscription" state, 10 and 11 for the size standard). Warm sun from the top left, limestone, mudbrick, painted plaster, palm wood, linen.

Every slot of the pack, required and optional:

```
npx tsx apps/web/scripts/world-art-index.ts --pack egypt --list
```

## Buildings

| Kind | Step folder | Footprint | From | What |
|---|---|---|---|---|
| house | `hut` | 1x1 | level 1 | Reed hut |
| house | `mudbrick` | 2x2 | level 4 | Mudbrick house |
| house | `painted` | 3x3 | level 8 | Painted house |
| house | `villa` | 4x4 | level 15 | Villa with a pool |
| department | `shrine` | 3x3 | stage 1 | Department shrine |
| department | `temple` | 4x4 | stage 4 | Department temple |
| department | `great_temple` | 5x5 | stage 8 | Great temple |
| residence | `tent` | 2x2 | stage 1 | Pharaoh's tent |
| residence | `mudbrick_house` | 3x3 | stage 2 | Mudbrick house |
| residence | `stone_house` | 4x4 | stage 3 | Stone house |
| residence | `column_palace` | 5x5 | stage 4 | Palace with columns |
| residence | `grand_palace` | 6x6 | stage 5 | Grand palace with gardens |
| district_hub | `workshop` | 3x3 | stage 1 | Machine workshop of a district |
| district_hub | `great_workshop` | 4x4 | stage 2 | Large district workshop: a storeroom wing behind the workshop |
| district_hub | `workshop_hall` | 5x5 | stage 3 | The workshop with its wing and a tall hall at the back |
| supply | `granary` | 3x3 | | Granary by the water, `fill_0` (empty, workers lie praying by it) to `fill_4` (full) |
| flophouse | `camp` | 2x2 | stage 1 | Day laborer camp |
| flophouse | `barracks` | 3x3 | stage 3 | Day laborer barracks |
| statue | `small`, `medium`, `colossus` | 1x1, 2x2, 3x3 | | Department statues, 20 stages each, the alley grows larger |
| monument | `pyramid_small`, `pyramid`, `great_pyramid` | 4x4, 5x5, 6x6 | | Goal pyramids in 10 tiers, golden pyramidion as `capstone.png` |
| altar | | 1x1 | | Small shrine of the god by the palace |

Construction stage 4 is drawn from the open rooms of stage 3 with scaffolding and ramp. If the artists prefer full-height walls cut at a line, the pack sets `stagePictures.waist_walls_scaffold` to `{ picture: 'full_walls', cutToWallLine: true }` and each `full_walls.json` gets a `wallCutY`.

## People

One look per kind of role, each in 5 outfit tiers and with every animation of the contract.

| Roles (examples of role keys) | Look folder | Name | Carries | Head |
|---|---|---|---|---|
| orchestrator | `egypt-pharaoh` | Pharaoh | staff | crown |
| department heads (DEV-HEAD, MKT-HEAD) | `egypt-overseer` | Overseer | staff | circlet |
| head of operations (OPS-HEAD) | `egypt-guard-captain` | Captain of the Guard | staff | helm |
| architect (DEV-ARCH) | `egypt-architect` | Master Architect | scroll | circlet |
| reviewers, testers, editors, auditors (DEV-REV, DEV-TEST, MKT-EDIT, FIN-AUDIT) | `egypt-inspector` | Stone Inspector | scroll | cap |
| developers (DEV-ENG, DEV-FE, DEV-BE, DEV-PERF) | `egypt-mason` | Stone Mason | stone | none |
| analysts, product managers, documentation (BIZ-ANALYST, DEV-PM, DEV-DOCS) | `egypt-scribe` | Papyrus Scribe | scroll | cap |
| designers, video makers (DSN-UI, DSN-SYS, VID-EDIT) | `egypt-relief-carver` | Relief Carver | chisel | cap |
| task watchdog (OPS-WATCH) | `egypt-medjay` | Medjay Patrol | gong | helm |
| weak point collector (OPS-BUGS) | `egypt-scout` | Wall Scout | scroll | hood |
| reliability, support (OPS-FIX, SUP-T1, SUP-T2) | `egypt-firefighter` | Water Bearer and Repairer | water jar | cap |
| sales, partnerships, social media, integrations (SAL-AE, BIZ-PARTNER, MKT-SOCIAL, OPS-INTEG) | `egypt-caravan-messenger` | Caravan Messenger | banner | hood |
| bookkeeping, accounts, supplies (FIN-BOOK, OPS-ACCT, HHD-SUPPLY) | `egypt-keykeeper` | Granary Keykeeper | key | cap |
| program operator, home devices (OPS-PROGRAM, HOM-NET, HOM-SMART) | `egypt-machine-keeper` | Workshop Keeper | tool | cap |
| security engineer (DEV-SEC) | `egypt-gate-guard` | Gate Sentinel | spear and shield | helm |
| red team (DEV-RED) | `egypt-skirmisher` | Wall Tester | spear and shield | hood |
| DevOps (DEV-OPS) | `egypt-canal-builder` | Canal and Ramp Builder | tool | none |
| members of turnkey teams | `egypt-royal-master` | Royal Master Builder | banner | circlet |
| one-off helpers | `egypt-day-laborer` | Day Laborer | stone | none |

Roles not listed take the look of their class (head, checker, executor, turnkey, one-off), as `resolvePackRoleLook` does.

Cloak colours by subscription provider (the engine tints the cloak layer): Claude `#C96A4B`, Codex `#3FA796`, Antigravity `#4DA167`, Kimi `#4C84D6`, GLM `#766BD6`, API key `#B89B5E`.

## Ground and plants

Delivered by the ground and plant artists; the terrain and plant layers load them through the pack's `terrainArt` and plant kinds (contract section 9).

* Ground materials: `plain` (golden building sand with wind ripples), `dune`, `bank` (sandy silt bank), `fertile` (green strip and its meadows), `ridge` (rock), `quarry` (limestone), `oasis_grove` (grass under palms), and two liquids, `river` and `oasis_water`, each as surface, `_bed` and `_ripples`.
* Transitions: `plain_bank`, `bank_fertile`, `plain_dune`, `plain_ridge`, `river_bank`.
* Roads: `trail` (0.4 tile), `dirt` (0.8), `brick` (1), `stone` (1), `avenue` (2).
* Decals: grass tufts, pebbles, cracks, tracks, sherds, shore bushes.
* Plants (29): date palms (4 adult, 1 young), doum palms (2), acacias (2), sycamores (2), tamarisks (2), bushes (4), papyrus clumps (3), reeds (3), dry grass tufts (4), desert thorns (2).

### Sown fields are not landscape

On Ivan's word (23.11.2026) sown fields are a game object people work on and that is placed where it is needed, not part of the landscape, and the map does not need them now. The recipe grows none: where they stood, the fertile land's grass grows. The delivered `field` ground (irrigated rows, 3 per tile) and the `fertile_field` edge stay in the art folder, but nothing draws them.

An idea for later, not built: fields as a subscription object, like the granary. They would show how much of the limit is left: in a drought, as the limit runs out, the crops darken and dry, and after the reset they turn green again.

## Loops and flags

All seven loops of the contract: crane, hoist block, dust, smoke, water, awning, celebration. District flags on homes and workshops, department banners on temples, both painted light for tinting.
