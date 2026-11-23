# Egypt world: art order v1, with v2 (construction from shared modules)

For the art pipeline (Design, #1956). Written on 23.11.2026 from the world art contract, version 2 ([`apps/web/src/world/ARTIST_CONTRACT.md`](../apps/web/src/world/ARTIST_CONTRACT.md)), and the Egypt pack's catalog ([`apps/web/src/world-packs/egypt/ART.md`](../apps/web/src/world-packs/egypt/ART.md)). Where this order and the contract differ, the contract wins.

**The bar:** the delivered district workshop (`egypt-workshop-3x3`), as Design accepted it: stone, a painted cornice, light and shade, a paved yard, and 10 construction stages that read as real building work. Every building and person below is drawn to that level, in the approved style (references 01 to 05, 10 to 12, and `egypt-hd-references`).

**The art never goes into this repository.** It is licensed for Hornhoof only (its `LICENSE.md` lives with the art). Deliver into the art folder outside git, as the workshop was delivered.

**What v2 changes (23.11.2026, Ivan AI by Ivan's word, agreed by the Head of design):**

* Construction is put together from a shared kit and each building's bare stages, no longer from 10 pictures per building. The kit is drawn once per footprint (3.2); a building keeps only `low_walls_open`, `full_walls`, `roof_beams`, `roof` and `complete`.
* Houses are not drawn anew: each comes from a crop of reference 01, on a larger lot (3.4).
* Wave 2 (section 2), items 3.2, 3.4, 3.7 and 3.12, and sections 5 and 6 are rewritten for this. Wave 1 is unchanged.

Contents:

1. Rules for every file
2. Priority: what to deliver first
3. Buildings
4. Residents
5. Checking before delivery
6. What the engine already reads, and what still needs wiring

## 1. Rules for every file

* PNG, RGBA, sRGB, straight (not premultiplied) alpha, transparent background.
* **Master scale (4x):** a ground tile is a 240 x 120 px diamond (2:1). A grown person is 136 px from feet to the top of the head.
* **Camera and light:** the camera is 30 degrees above the ground; residents alone are drawn at 19 degrees (4.4). The sun is at the top left (azimuth -45, elevation 55), 5200 K.
* **Shadows:** no shadow is painted on the ground under a building or a person; the engine draws those. A building's own cast shadow goes in its `shadow.png` layer (3.3).
* **Passports:** every picture or sheet has a passport JSON beside it with the same name: `complete.png` and `complete.json`.
  * Points are in the picture's own pixels, origin at the top left, y going down.
  * Write a point as `[x, y]` or `{ "x": .., "y": .. }`. Keys may be camelCase or snake_case.
  * The check allows 2 px of slack.
* Deliver only master scale. The engine scales down for 100% zoom and below.

## 2. Priority: what to deliver first

Counted in the demo company the engine uses for its shots: 85 buildings and 59 residents.

| | Buildings | Count |
|---|---|---|
| | houses | 56 |
| | granaries | 11 |
| | district workshops | 5 |
| | department temples | 4 |
| | statues | 4 |
| | pyramids | 3 |
| | the residence | 1 |
| | the day labourers' camp | 1 |

Of the 59 residents:

* 23 are Stone Masons (developers);
* 5 Inspectors, 4 Scribes, 3 Overseers, 3 Water Bearers;
* every other look has 1 or 2 people.

**Wave 1: the city stops showing boxes.**

1. House, steps `hut` and `mudbrick`: `complete.png`, then `painted` and `villa` `complete.png` (3.4).
2. People, tier 1, animations `walk`, `idle`, `carry`, `build` and `sleep`, each with its cloak layer. Looks in this order: `egypt-mason`, `egypt-inspector`, `egypt-scribe`, `egypt-overseer`, `egypt-firefighter`, `egypt-pharaoh` (4.4).
3. Granary `fill_0` to `fill_4` (3.8).
4. Department `shrine`, `temple`, `great_temple`: `complete.png` (3.5).
5. Residence, all five steps: `complete.png` (3.6).
6. Flags `district.png` and `department.png` (3.11).

**Wave 2: building work and growth look real.**

1. **The construction kit, once** (3.2): the modules `stakes`, `foundation`, `scaffold_back`, `scaffold_front`, `ramp` and `rubble` for the footprints in this order: 2x2, 3x3, 4x4, 5x5, 6x6 (1x1 only if a 1x1 building is ever built; after v2 none is). With them the loops `crane`, `hoist_block`, `dust` and `smoke`, drawn once for all buildings (3.12).
2. The bare stages (3.2) of the first step of house (`hut`), department (`shrine`), residence (`tent`) and flophouse (`camp`). Then `annex.png` for every larger step.
3. Day labourers' `camp` and `barracks` (3.9).
4. The bare stages of the remaining district workshop steps, `great_workshop` and `workshop_hall` (3.7).
5. Statues (3.10), pyramids with capstones (3.10), the altar (3.11), the loops `water`, `awning` and `celebration` (3.12).
6. People: every other look at tier 1 with the same five animations. Then tiers 2 to 5 of `walk`, `idle`, `carry`, `build` for the Wave 1 looks, so level progression shows.

**Wave 3: the rest.**

1. Every look, every tier, every animation of 4.3.
2. The daily-life animations for #1951 (4.3, last table).
3. Night lights (3.13): **on hold** by Ivan's word, 23.11.2026.
4. The bare stages (3.2) of every larger step, used when a grown building is rebuilt elsewhere.

## 3. Buildings

### 3.1 Canvas and passport for each footprint

Every picture of one step uses the **same canvas**, so nothing moves between stages:

* the canvas is as wide as the footprint diamond, with the plot's bottom corner at the bottom centre (`[W/2, H-1]`);
* the canvas height is the footprint's highest picture, used in full;
* every picture passport repeats the same `groundAnchor` and `corners`;
* the shared construction modules of a footprint (3.2) use exactly this canvas and passport too.

| Footprint | Canvas W x H | Door height | `groundAnchor` | `corners.top` | `corners.right` | `corners.bottom` | `corners.left` |
|---|---|---|---|---|---|---|---|
| 1x1 | 240 x 420 | 148 | [120, 359] | [120, 299] | [240, 359] | [120, 419] | [0, 359] |
| 2x2 | 480 x 680 | 152 | [240, 559] | [240, 439] | [480, 559] | [240, 679] | [0, 559] |
| 3x3 | 720 x 960 | 156 | [360, 779] | [360, 599] | [720, 779] | [360, 959] | [0, 779] |
| 4x4 | 960 x 1200 | 160 | [480, 959] | [480, 719] | [960, 959] | [480, 1199] | [0, 959] |
| 5x5 | 1200 x 1440 | 164 | [600, 1139] | [600, 839] | [1200, 1139] | [600, 1439] | [0, 1139] |
| 6x6 | 1440 x 1680 | 168 | [720, 1319] | [720, 959] | [1440, 1319] | [720, 1679] | [0, 1319] |

Minimal passport of a 3x3 picture:

```json
{
  "groundAnchor": [360, 779],
  "corners": { "top": [360, 599], "right": [720, 779], "bottom": [360, 959], "left": [0, 779] },
  "door": [470, 852],
  "flagAnchor": [300, 410]
}
```

Optional fields:

* `door`: the foot of the door on the ground;
* `flagAnchor`: the foot of the flag pole on the roof. Without it the building has no flag;
* `awningAnchor`: the top edge of a swaying awning;
* `topAnchor`: the top centre, where a capstone or a top loop attaches;
* `wallTopLine`, `roofLine`: the y of the wall tops and of the roof edge;
* `workSlots`: up to 3 points `{ "x", "y", "layer": "front" | "inside" }` where workers stand;
* `layers` (3.3).

### 3.2 Pictures of one step, and the construction kit (v2)

**A step's own pictures.** Folder `buildings/<kind>/<step>/`.

| File | When it shows |
|---|---|
| `complete.png` | The finished building. **Required** for every step. |
| `upgraded.png` | The building at its last growth stage (courtyard, gallery, extra floor). Optional. |
| `annex.png` | The building growing into the next step: the finished look with the extension under work. Optional. |
| `low_walls_open.png` | Bare stage: the first courses of the walls, the rooms open from above. |
| `full_walls.png` | Bare stage: the walls at full height, no roof. |
| `roof_beams.png` | Bare stage: the beams laid across the walls, no roof covering. |
| `roof.png` | Bare stage: the roof closed, before the finish (no paint, cornice or props yet). |

* A bare stage shows the building alone: no scaffolding, ramp, crane, rope, stakes, rubble or dust. Those come from the kit and the loops.
* Same canvas and passport as the step's `complete.png` (`groundAnchor`, `corners`). `door` and `workSlots` are optional.
* A bare stage may carry its own cast shadow as a `shadow.png` layer (3.3).
* A step that already has its own `stage_01.png` to `stage_08.png` and `demol_01.png`, `demol_02.png` (the workshop) keeps them: the engine shows them and no kit. Nothing there is redrawn.

**The construction kit.** Folder `modules/<footprint>/`, one set per footprint, drawn once and used by every building of that footprint. Every module of a footprint has exactly the canvas, `groundAnchor` and `corners` of 3.1:

| Folder | Canvas W x H | `groundAnchor` | `corners` |
|---|---|---|---|
| `modules/1x1/` | 240 x 420 | [120, 359] | as 1x1 in 3.1 |
| `modules/2x2/` | 480 x 680 | [240, 559] | as 2x2 in 3.1 |
| `modules/3x3/` | 720 x 960 | [360, 779] | as 3x3 in 3.1 |
| `modules/4x4/` | 960 x 1200 | [480, 959] | as 4x4 in 3.1 |
| `modules/5x5/` | 1200 x 1440 | [600, 1139] | as 5x5 in 3.1 |
| `modules/6x6/` | 1440 x 1680 | [720, 1319] | as 6x6 in 3.1 |

The files of each set:

| File | What it shows | Required |
|---|---|---|
| `stakes.png` | Stakes at the four corners of the plot, a taut rope between them, a few pegs. No building. | yes |
| `foundation.png` | The plot levelled, the foundation course laid, a few blocks stacked at its side. | yes |
| `scaffold_back.png` | Scaffolding along the two back walls, behind the building. | no |
| `scaffold_front.png` | Scaffolding along the two front walls, open enough that the walls show through. | yes |
| `ramp.png` | The building ramp leaning against a front wall, as on the workshop's stages 4 and 5. | yes |
| `rubble.png` | After demolition: a rubble heap and broken blocks on the plot. | yes (read once #1955 wires it, section 6) |

* Scaffolding reaches the wall top of the tallest step of that footprint (3.4 to 3.9).
* Paint no ground plate under a module: the engine clears every lot to bare ground itself (#1958), and stakes and rubble stand on it.
* Modules take no layers, so leave cast shadows out of them.

**How the 10 steps on screen are put together.** Back to front, as the engine draws them; the loops are added by the engine (3.12):

| Step | Stage | Drawn, back to front | Loops |
|---|---|---|---|
| 1 | stakes and rope | `stakes` | `dust` |
| 2 | foundation | `foundation` | `dust` |
| 3 | low walls, rooms open | `low_walls_open` and its layers | `dust` |
| 4 | walls to the waist | `scaffold_back`, `low_walls_open` and its layers, `ramp`, `scaffold_front` | `crane`, `hoist_block`, `dust` |
| 5 | full walls | `scaffold_back`, `full_walls` and its layers, `ramp`, `scaffold_front` | `crane`, `hoist_block`, `dust` |
| 6 | roof beams | `scaffold_back`, `roof_beams` and its layers, `scaffold_front` | `crane`, `hoist_block`, `dust` |
| 7 | roof | `scaffold_back`, `roof` and its layers, `scaffold_front` | `dust` |
| 8 | finishing | `scaffold_back`, `complete` and its layers, `scaffold_front` | `dust`, `awning` |
| 9 | finished | `complete` and its layers, the flag | `awning`, `smoke` |
| 10 | upgraded | `upgraded` (or `complete`) and its layers, the flag | `awning`, `smoke` |
| demolition | | steps 8 to 1 backwards, then `rubble` | `dust` |

"Its layers" are the picture's passport layers (3.3): its `shadow.png` comes right after it, under the ramp and the front scaffolding.

**Design's condition:** put together, the construction must read at least as well as the workshop's own strip from #1944. Design checks it on live-city shots.

**Door and growth.** A building stands at the front (bottom) corner of its lot and grows backward: a larger step keeps the same front corner, door and scale, and the new rooms go behind. Draw the door on the **front right wall** (from the plot's right corner down to the bottom corner), in the tile row this order names for the kind (counted from the bottom corner, 0 = the front tile). Keep it in that row in every step of the kind.

### 3.3 Layers

A picture's passport may name layers. A layer is a PNG beside the picture, of exactly the same canvas and registration, drawn over it in order:

```json
"layers": [
  { "file": "shadow.png", "blend": "multiply" },
  { "file": "props.png" },
  { "file": "awning.png", "sway": { "pivot": [[210, 542], [426, 650]] } }
]
```

* `shadow.png` with `multiply`: the building's cast shadow, black or tinted with alpha for strength.
* `props.png`: tables, jars, tools in the yard.
* `awning.png` with `sway`: the cloth moves in the wind about the line through the two `pivot` points, where it is fixed. `amplitude` is optional: 0.03 by default, at most 0.2.

Keep to a layer only what moves or must stay separate.

### 3.4 House: an agent's home, the most common building

By Ivan's word (23.11): no new houses are drawn. Each house comes from a crop of reference 01, in `egypt-etalon-house-crops.tar.gz` on #1956 (attachment `c234f111-57df-4c14-8a89-7ba2f9620f84`, folder `etcrop/`).

| Step | Footprint | Shown from | Source |
|---|---|---|---|
| `hut` | 2x2 | level 1 | crop `hut_A_square_pyramid_roof.png` |
| `mudbrick` | 3x3 | level 4 | crop `mud_B_roof_pots.png` |
| `painted` | pending | level 8 | pending: Design names the crop and measures the lot |
| `villa` | pending | level 15 | pending, as `painted` |

* The other crops, `hut_B_gable_reed.png`, `hut_C_gable_big.png`, `hut_D_round_mud.png`, `mud_A_plain.png`, `mud_C_awning.png` and `mud_D_reed_awning.png`, are variants for `painted`, `villa` and variations.
* Why the larger lots: with a person at 136 px the reference huts' walls are about 1.6 x 1.6 cells. Squeezed into 1x1, a hut comes out narrow and tall. As with the workshop, the lot follows from the reference at standard scale.
* Canvas, `groundAnchor` and `corners`: table 3.1 for the step's footprint, unchanged.
* Door: as in the reference at standard scale, never lower than 100 px: a low door is what poor housing looks like. The 148 to 168 px doors of 3.1 stay for stone and public buildings. Door row 0, on the front right wall.
* The house lot equals the lot of its largest step. It is pending until Design measures `villa` (4x4 today).
* `flagAnchor` on every `complete.png`: the district flag flies from homes.

### 3.5 Department: a department's temple in the city centre

| Step | Footprint | Shown from | What |
|---|---|---|---|
| `shrine` | 3x3 | stage 1 | Department shrine |
| `temple` | 4x4 | stage 4 | Department temple |
| `great_temple` | 5x5 | stage 8 | Great temple |

* Lot 5x5. Door row 1.
* `flagAnchor` for the department banner.
* `workSlots` where the department's builders stand.

### 3.6 Residence: the ruler's (orchestrator's) home in the centre

| Step | Footprint | Shown from | What |
|---|---|---|---|
| `tent` | 2x2 | stage 1 | Pharaoh's tent |
| `mudbrick_house` | 3x3 | stage 2 | Mudbrick house |
| `stone_house` | 4x4 | stage 3 | Stone house |
| `column_palace` | 5x5 | stage 4 | Palace with columns |
| `grand_palace` | 6x6 | stage 5 | Grand palace with gardens |

* Lot 6x6. Door row 0.

### 3.7 District workshop: a machine's building in its district

Delivered:

* `workshop` (3x3): the whole line, demolition and layers;
* `great_workshop` (4x4) and `workshop_hall` (5x5): `complete` and `annex` from the growth pictures.

Still to deliver:

* `upgraded.png` where wanted;
* the bare stages (3.2) of `great_workshop` and `workshop_hall` (Wave 2); the workshop keeps its own delivered line.

Lot 5x5. Door: front right wall, row 2, as delivered.

### 3.8 Granary: a subscription's store by the water

* Step `granary`, 3x3, door row 1.
* No `complete.png` and no construction line. Instead, `fill_0.png` (empty) to `fill_4.png` (full), shown by how much of the subscription's limit is left.
* At `fill_0` the store is empty, and residents lie praying beside it (that is the people's `pray` animation, not part of the picture).

### 3.9 Day labourers' flophouse: lodging of one-off helpers at a district's edge

| Step | Footprint | Shown from | What |
|---|---|---|---|
| `camp` | 2x2 | stage 1 | Day labourer camp |
| `barracks` | 3x3 | stage 3 | Day labourer barracks |

* Lot 3x3. Door row 0.

### 3.10 Statues and pyramids

**Statues.** A department's statue, in three size steps along an alley:

* steps `small` (1x1), `medium` (2x2), `colossus` (3x3);
* each step has `stage_01.png` to `stage_20.png`: the statue carved from the block to the finished figure.

**Pyramids.** A top goal's monument:

* steps `pyramid_small` (4x4), `pyramid` (5x5), `great_pyramid` (6x6);
* each step has `tier_01.png` to `tier_10.png`, shown by how much of the goal is done;
* `tier_10.json` needs a `topAnchor`;
* `capstone.png` is the golden pyramidion placed at that point when the goal is reached. Its passport is `{ "anchor": [x, y] }`, the bottom centre.

### 3.11 Altar and flags

**Altar:** the god's altar where agents wait for a person's answer.

* `buildings/altar/complete.png`, 1x1, with a picture passport.

**Flags:**

* `flags/district.png` and `flags/department.png`;
* passport `{ "anchor": [x, y] }` at the foot of the pole;
* paint the cloth white or light grey: the engine tints it with the district or department colour.

### 3.12 Loops

`loops/<name>.png`: one row of frames, with a sheet passport (4.5) and `attach`. Each loop is drawn once and serves every building; `crane`, `hoist_block`, `dust` and `smoke` belong to the construction kit (Wave 2, item 1), and the table in 3.2 says at which step each shows.

| Loop | `attach` |
|---|---|
| `crane` | `top` |
| `hoist_block` | `top` |
| `dust` | `ground` |
| `smoke` | `top` |
| `water` | `ground` |
| `awning` | `awning` |
| `celebration` | `top` |

### 3.13 Night lights (on hold)

**On hold by Ivan's word, 23.11.2026: do not prepare `night.png` until Ivan says otherwise.** The description below stays for when he does.

Design asked for one warm light in a district whose machine is off: a lit window or a torch at the door, with a small warm spot on the ground.

* Deliver it as `night.png` beside `complete.png`, on the same canvas. Leave it **out of the `layers` list**: listed there it would also shine by day.
* Nothing in the engine waits for it: #1955 does not depend on a night layer. A delivered `night.png` only makes the check warn that the file is not declared.

## 4. Residents

### 4.1 Looks

Folder `people/<look>/tier_<n>/`. One look per kind of role. A role without its own look takes its class's look.

| Look | Who (role keys) | Carries | Head | In the demo company |
|---|---|---|---|---|
| `egypt-mason` | developers (DEV-ENG, DEV-FE, DEV-BE, DEV-PERF) | stone | none | 23 |
| `egypt-inspector` | reviewers, testers, editors, auditors (DEV-REV, DEV-TEST, MKT-EDIT, FIN-AUDIT) | scroll | cap | 5 |
| `egypt-scribe` | analysts, product managers, documentation (BIZ-ANALYST, DEV-PM, DEV-DOCS) | scroll | cap | 4 |
| `egypt-overseer` | department heads (DEV-HEAD, MKT-HEAD) | staff | circlet | 3 |
| `egypt-firefighter` | reliability, support (OPS-FIX, SUP-T1, SUP-T2) | water jar | cap | 3 |
| `egypt-royal-master` | members of turnkey teams | banner | circlet | 2 |
| `egypt-gate-guard` | security engineer (DEV-SEC) | spear and shield | helm | 2 |
| `egypt-keykeeper` | bookkeeping, accounts, supplies (FIN-BOOK, OPS-ACCT, HHD-SUPPLY) | key | cap | 2 |
| `egypt-medjay` | task watchdog (OPS-WATCH) | gong | helm | 2 |
| `egypt-scout` | weak point collector (OPS-BUGS) | scroll | hood | 2 |
| `egypt-caravan-messenger` | sales, partnerships, social media, integrations (SAL-AE, BIZ-PARTNER, MKT-SOCIAL, OPS-INTEG) | banner | hood | 2 |
| `egypt-machine-keeper` | program operator, home devices (OPS-PROGRAM, HOM-NET, HOM-SMART) | tool | cap | 2 |
| `egypt-day-laborer` | one-off helpers | stone | none | 2 |
| `egypt-pharaoh` | the orchestrator | staff | crown | 1 |
| `egypt-architect` | architect (DEV-ARCH) | scroll | circlet | 1 |
| `egypt-canal-builder` | DevOps (DEV-OPS) | tool | none | 1 |
| `egypt-skirmisher` | red team (DEV-RED) | spear and shield | hood | 1 |
| `egypt-guard-captain` | head of operations (OPS-HEAD) | staff | helm | 1 |
| `egypt-relief-carver` | designers, video makers (DSN-UI, DSN-SYS, VID-EDIT) | chisel | cap | 0 |

### 4.2 Level outfits and cloaks

Five outfit tiers follow the agent's level:

| Tier | Agent levels | Suggested look from the approved ladder (`egypt-hd-references/hd-levels-row.png`) |
|---|---|---|
| 1 | 1 to 2 | level 1, simple clothes (`hd-char-lvl01.png`). **Required.** |
| 2 | 3 to 5 | level 3 |
| 3 | 6 to 9 | level 5 (`hd-char-lvl05.png`) |
| 4 | 10 to 17 | level 7 |
| 5 | 18 and up | level 10, the richest outfit (`hd-char-lvl10.png`) |

* A missing higher tier falls back to the next lower one.
* The role stays readable in every tier: the same carried item and headgear, with richer cloth, collar, belt and gold as the tier rises.
* **Cloak layer:** `<animation>.cloak.png`, exactly the same size and grid as its sheet, white or light grey where the cloak is and transparent elsewhere. The engine tints it with the colour of the agent's subscription provider, so one drawing serves every provider: Claude `#C96A4B`, Codex `#3FA796`, Antigravity `#4DA167`, Kimi `#4C84D6`, GLM `#766BD6`, API key `#B89B5E`.

### 4.3 Animations

One sheet per animation: `<animation>.png`, plus its `.cloak.png`.

**In the contract today** (the engine draws them as they arrive):

| Animation | Resident state | Suggested frames, fps |
|---|---|---|
| `idle` | standing, resting by the home | 4, 4 |
| `walk` | walking, wandering | 8, 10 |
| `carry` | carrying a stone (its load) to the building site of its goal | 8, 10 |
| `carry_back` | carrying a returned stone back (rework) | 8, 10 |
| `build` | building, also building its own home | 6, 8 |
| `inspect` | checking stones with a scroll | 6, 6 |
| `direct` | a head showing where to carry, urging on | 6, 6 |
| `survey` | surveying | 6, 6 |
| `write` | writing | 6, 6 |
| `carve` | carving | 6, 8 |
| `gong` | ringing the alarm | 6, 8 |
| `extinguish` | putting out a fire | 6, 8 |
| `guard` | standing guard | 4, 4 |
| `hold_scroll` | waiting at the altar for a person's answer | 4, 4 |
| `pray` | lying exhausted and praying by an empty granary | 4, 3 |
| `broken_tool` | sitting with a broken tool (a failed turn) | 4, 3 |
| `sleep` | sleeping (its machine is off, night in the district) | 4, 2 |

* A missing animation falls back to `walk` for moving states and to `idle` for the rest. So `walk`, `idle`, `carry`, `build` and `sleep` cover most of a city.
* Role animations are needed only for the looks that do that work: `inspect` for inspectors, `direct` for overseers, `write` for scribes, and so on.

**New for the daily life of #1951** (Wave 3; the engine draws them after #1951 wires them, and until then the check warns that they are not declared):

| Animation | Resident state | Suggested frames, fps |
|---|---|---|
| `drink` | drinking from a jar at its subscription's granary or well | 6, 6 |
| `sit` | sitting and resting by its home, or waiting by its department | 4, 3 |
| `talk` | chatting with a neighbour, hands moving | 6, 6 |
| `bow` | greeting the pharaoh or a person | 6, 8 |

### 4.4 Sheet layout and passport

* **Rows, top to bottom:** N, NE, E, SE, S. The engine mirrors SE, E and NE for SW, W and NW, so a person walks in 8 directions from 5 drawn rows. A carried item changes hands in the mirrored rows.
* **Frames** run left to right, every frame the same size. The feet sit on the same `anchor` in every frame, so walking does not slide.
* **Suggested frame:** 192 x 256 px with the feet at `[96, 236]`. The person is 136 px tall and stands from y 100 to y 236; the room above holds a stone on the head, a banner or a raised spear.
* Rig and bake as the contract says: parts at the 544 px source baked down to 136 px, the cloak as its own baked layer, no ground shadow.
* **Camera: the one exception to the 30 degrees of section 1.** Residents are drawn with an orthographic camera tilted 19 degrees down (Ivan's word, 23.11.2026): at 30 degrees the shoulders came out 24% wider and a step looked like a hop. Buildings, ground and the construction kit stay at 30 degrees. The sheet format does not change: 5 rows N to S, frame 192 x 256, feet at `[96, 236]`, the person 136 px tall.
* **What Design checks on the city shots:** the feet stand on the 30-degree ground, neither floating nor sinking; the engine's shadow under a resident stays at 30 degrees; in `build` the hands touch the building's wall and do not go into it.

Passport of an 8-frame walk with that frame (sheet 1536 x 1280):

```json
{ "frameW": 192, "frameH": 256, "frames": 8, "fps": 10, "anchor": [96, 236] }
```

### 4.5 Sheet passport of a loop

The same fields with one row of frames, the anchor at the attach point, and `attach` from 3.12:

```json
{ "frameW": 128, "frameH": 128, "frames": 8, "fps": 8, "anchor": [64, 120], "attach": "top" }
```

## 5. Checking before delivery

### 5.1 Run the check

In a checkout of this repository, after `npm ci`, with the art folder laid out as above:

```
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack egypt            check, write nothing
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack egypt --write    check and write art-index.json
npx tsx apps/web/scripts/world-art-index.ts --pack egypt --list                  every slot, required or optional
```

A building delivered like the workshop (`cut/`, `layers/`, `growth/`, `checks.json`, see the header of `apps/web/scripts/world-art-import.ts`) is laid out into the art folder by:

```
npx tsx apps/web/scripts/world-art-import.ts <delivery> --to <art folder> --pack egypt --kind <kind> --steps <first,second,...>
```

Deliver the folder with a fresh `art-index.json` written by the check. The check writes it only when there are no errors.

### 5.2 What the check rejects

A rejected file keeps its placeholder; it never breaks the city.

* A picture passport without `groundAnchor` and all four `corners`.
* A footprint diamond that is not 2:1, not symmetric, or whose `groundAnchor` is not its centre.
* A diamond width that does not match the step's footprint (3.1).
* A picture taller than its footprint allows (3.1).
* A point outside the picture.
* A layer that is missing, or not exactly the size of its picture.
* A sheet passport without `frameW`, `frameH`, `frames`, `fps` and `anchor`.
* A sheet whose width is not `frameW * frames`.
* A person's sheet whose height is not `frameH * 5`.
* An anchor outside one frame.
* A cloak layer without its base sheet, or of another size.
* An index for another pack or another contract version.

It **warns**, without rejecting, about a file no slot names: the #1951 animations until they are wired, and a `night.png` (on hold, 3.13).

### 5.3 What the check cannot see

Look at each delivery for these yourself:

* The plot's bottom corner is at the same canvas point in every picture of a step, and in its growth steps.
* The door is on the front right wall, in the row this order names, in every step.
* A person in the art is 136 px tall, and door heights match the table in 3.1; a house door is as in its reference crop and at least 100 px (3.4).
* A kit module sits on the same canvas point as the buildings of its footprint: stakes at the plot's corners, scaffolding along the walls of the tallest step.
* Light from the top left; no painted ground shadow except in `shadow.png`.
* The style matches the workshop and the references.

## 6. What the engine already reads, and what still needs wiring

**Read today, with no code change:**

* every building file of 3.2 to 3.12: `complete`, `upgraded`, `annex`, the bare stages put together with the kit modules `stakes`, `foundation`, `scaffold_back`, `scaffold_front` and `ramp` as the table in 3.2 says, a step's own `stage_01..08` and `demol_01/02`, layers with multiply and sway, statue stages, pyramid tiers and capstone, granary fills, the altar, flags on `flagAnchor`, and loops by `attach`;
* people sheets of the 17 contract animations in 5 tiers by level, with the provider-tinted cloak and the fallbacks of 4.2 and 4.3;
* the import of a building delivered in the workshop's format, and the check.

**Needs wiring when the art arrives:**

1. **Door rows.** Only the district workshop's door row is set in the engine today. When a kind's art lands, its door row (3.4 to 3.9) goes into the pack's `buildingLayout`, one line per kind. Until then the city may lead the street to another front tile.
2. **The whole construction line on screen.** Today a build spreads the 10 pictures over the building's own number of stages:
   * houses and temples (10 stages) show every picture;
   * the residence (5) and the flophouse (6) skip some;
   * the district workshop (3) shows only stage 1, stage 6 and the finished picture.

   #1947 (item 7) makes every kind walk all 10.
3. **The daily-life animations** `drink`, `sit`, `talk`, `bow`: the contract, the pack catalog and the resident states (#1951).
4. **Night lights** `night.png`: on hold by Ivan's word, 23.11.2026 (3.13). #1955 does not depend on it.
5. **People delivery.** There is no import script for people. Lay sheets out as 4.4 says, or ask for a small import script matched to the delivery's layout.
6. **Retina 2K art** (8x). The engine scales the master up at 200% on Retina today; using the 2K set needs wiring later. It is not ordered here.
7. **The kit at demolition.** The engine runs the steps backwards today; showing `rubble.png` last, and the scaffolds while tearing down, comes with #1955. Until then the check warns that `rubble.png` is not declared.
8. **Residents at 19 degrees (4.4): nothing to wire.** The engine stands a sheet on its `anchor` at the feet's point on the ground and draws the shadow itself, a flat 2:1 ellipse at 30 degrees. If feet float or sink on the shots, the fix is the sheet's `anchor`; if hands go into a wall in `build`, the fix is that building's `workSlots`.
9. **House step sizes.** The pack catalog gives `hut` 1x1 and `mudbrick` 2x2 today. The new sizes (3.4) go into the pack's `buildingLayout` as one line per step with its lot when the art lands, and the house lot once Design has measured `villa`. Not built in #1954.
