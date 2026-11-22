# World art contract

This is the agreement between the artists of a world pack and the world engine. A pack declares slots for pictures and sheets (its art catalog in `world-packs/<pack>/art.ts`); artists fill the slots with PNG files and a small passport JSON beside each; the engine draws a file as soon as it is in the pack's art folder and keeps its geometric placeholder for every slot still empty. Art can arrive one file at a time; nothing in the engine changes when it does.

Contract version: **1** (`ART_CONTRACT_VERSION` in `art.ts`).

What is specific to one world (which buildings, which looks, its colours and style) lives in that pack's own notes, for example `world-packs/<pack>/ART.md`. This file holds only what is the same for every world.

## 1. Where the art lives

* Art is licensed per pack and **never goes into this repository**.
* A pack's art folder is served at the pack's `art.baseUrl`, for example `/world-art/<pack>/`.
  * Local work and builds: put the folder at `apps/web/public/world-art/<pack>/`. The path is ignored by git; Vite serves it and copies it into the build.
  * A running server: put the folder at `<WEB_DIST>/world-art/<pack>/`.
* The folder holds `art-index.json` at its root. The engine reads only that file at start and then downloads each picture the first time it is on screen. Without `art-index.json` the whole world draws on placeholders.
* Build and check the index with the art check command (section 10). A file the check rejects is left out of the index and keeps its placeholder; one broken file never breaks the city.

## 2. Standard sizes

All art is drawn at the **master 4x tier**.

| What | Size |
|---|---|
| Ground tile | diamond 240 x 120 px, 2:1, edges at 26.565 degrees |
| Person | 136 px from feet to top of head |
| Rig source for people | 544 px tall (8x), baked down to 136 px |
| Camera | 30 degrees above the ground, looking down the diamond's vertical axis |
| Sun | top left (azimuth -45 degrees, elevation 55 degrees), 5200 K |
| Directions | 5 drawn (N, NE, E, SE, S); SW, W and NW are mirrors of SE, E and NE |

The engine shows the master art at four tiers: 1x (tile 60 x 30, person 34 px), 2x (120 x 60, 68 px, the default 100% zoom), 4x (240 x 120, 136 px, 200% zoom) and 8x (480 x 240, 272 px, Retina at 200%). Do not deliver separate small versions; the engine scales down.

Building footprints, square, in master pixels:

| Footprint | Diamond width x height | Door height | Highest picture |
|---|---|---|---|
| 1x1 | 240 x 120 | 148 | 420 |
| 2x2 | 480 x 240 | 152 | 680 |
| 3x3 | 720 x 360 | 156 | 960 |
| 4x4 | 960 x 480 | 160 | 1200 |
| 5x5 | 1200 x 600 | 164 | 1440 |
| 6x6 | 1440 x 720 | 168 | 1680 |

## 3. Files and passports

* PNG, RGBA, sRGB, straight (not premultiplied) alpha, transparent background, no drop shadow under buildings or people (the engine draws ground shadows).
* Every PNG that needs a passport has one beside it with the same name and `.json`: `complete.png` and `complete.json`.
* Passport points are in the picture's own pixels, origin at the top left corner, y going down. A point may be written `{ "x": 368, "y": 712 }` or `[368, 712]`; keys may be camelCase (`groundAnchor`) or snake_case (`ground_anchor`).
* Geometry is checked with 2 px of slack.

### Picture passport (buildings, shared modules, the altar)

| Field | Required | Meaning |
|---|---|---|
| `groundAnchor` | yes | Centre of the footprint diamond on the ground. This point lands on the centre of the lot. Must be the centre of `corners`. |
| `corners` | yes | `top`, `right`, `bottom`, `left` of the footprint diamond on the ground. Width must match the footprint (section 2), 2:1. |
| `door` | no | Foot of the door on the ground. |
| `wallTopLine` | no | y of the top of the walls. |
| `roofLine` | no | y of the roof edge. |
| `wallCutY` | no | y where a full-height wall picture may be cut to stand in for waist-high walls (section 4). |
| `flagAnchor` | no | Foot of the flag pole on the roof. Without it the building has no flag. |
| `awningAnchor` | no | Top edge of a swaying awning. |
| `topAnchor` | no | Top centre (apex, spire, chimney): where a capstone or a top loop attaches. |
| `workSlots` | no | Up to 3 points `{ x, y, layer }` with `layer` `front` (on scaffolding, in front of walls) or `inside` (in open rooms) where workers stand. |

Every point must lie inside the picture; the picture must not be taller than its footprint allows.

### Anchor passport (flags, capstones)

`{ "anchor": [x, y] }`: the point that touches the parent (the foot of a flag pole, the bottom centre of a capstone).

### Sheet passport (people, loops)

| Field | Meaning |
|---|---|
| `frameW`, `frameH` | Size of one frame. |
| `frames` | Frames from left to right; picture width = `frameW * frames`. |
| `fps` | Playback speed. |
| `anchor` | In one frame: the feet of a person, or the attach point of a loop. |
| `attach` | Loops only: `top`, `awning`, `door` or `ground` (section 8). |

## 4. Buildings

Folder: `buildings/<kind>/<step>/`. The pack's catalog names the steps of each kind, each with its own footprint, for example a small first home on 1x1 and a large one on 4x4. The engine picks the step that matches the building's current size and stage, or the nearest larger one scaled down. Run the art check with `--list` to see every slot of a pack.

| Kind | What it is in the company |
|---|---|
| `house` | An agent's home; grows with the agent's level (1x1 to 4x4). |
| `department` | A department's hall in the centre (3x3 to 5x5). |
| `residence` | The ruler's (orchestrator's) residence, 5 growth stages (2x2 to 6x6). |
| `district_hub` | A machine's building in its district (3x3 to 4x4). |
| `supply` | A subscription's store by the water; shows how much of its limit is left. |
| `flophouse` | Lodging of one-off helpers at the edge of a district (2x2 to 3x3). |
| `statue` | A department's statue, 20 stages; an alley of them grows larger (1x1, 2x2, 3x3). |
| `monument` | A top goal's monument in tiers with a capstone (4x4 to 6x6). |
| altar | The god's altar where agents wait for a person's answer: `buildings/altar/complete.png`, 1x1. |

### Pictures of one step

| File | Shown when |
|---|---|
| `complete.png` | The finished building, outside construction. Required. |
| `upgraded.png` | The building at its last growth stage (courtyard, gallery, extra floor). Optional; without it `complete.png` stays. |
| `annex.png` | The building growing in place: the finished look with the extension under work. Optional. |
| `low_walls_open.png` | Construction stage 3: first wall courses, rooms open from above, room for workers inside. |
| `full_walls.png` | Construction stage 5: walls at full height, no roof. |
| `roof_beams.png` | Construction stage 6: roof beams laid. |
| `roof.png` | Construction stage 7: roof closed, no finishing. |

Draw construction pictures **without scaffolding or ramps**; those are shared modules the engine adds (section 5).

### Construction stages

A building goes through 10 stages when it is built from scratch or rebuilt elsewhere by the god's word; demolition runs the same pictures backwards. Growing in place never starts over: the building switches to the next step's `complete.png`, and a home its agent is extending shows `annex.png` meanwhile.

| Stage | Id | Drawn from |
|---|---|---|
| 1 | stakes_and_rope | module `stakes` |
| 2 | foundation | module `foundation` |
| 3 | low_walls_open | `low_walls_open.png` |
| 4 | waist_walls_scaffold | `low_walls_open.png` + `scaffold_back`, `ramp`, `scaffold_front` |
| 5 | full_walls | `full_walls.png` + scaffolding and ramp |
| 6 | roof_beams | `roof_beams.png` + scaffolding |
| 7 | roof | `roof.png` + scaffolding |
| 8 | finishing | `complete.png` + scaffolding |
| 9 | complete | `complete.png` |
| 10 | upgraded | `upgraded.png`, or `complete.png` without it |

A pack may draw stage 4 from `full_walls.png` cut at its `wallCutY` instead (`stagePictures` in the pack catalog). The default keeps the open rooms of stage 3, because a straight cut through an isometric wall shows no wall thickness.

Kinds without construction pictures:

* `statue`: `stage_01.png` to `stage_20.png` (the pack's statue stage count), one set per size step.
* `monument`: `tier_01.png` to `tier_10.png` (the pack's monument stage count), shown by how much of the goal is done, plus `capstone.png` (anchor passport) placed at the last tier's `topAnchor` when the goal is reached.
* `supply`: `fill_0.png` (empty) to `fill_4.png` (full) in place of `complete.png`, by the share of the limit left; empty while the subscription is used up.

## 5. Shared construction modules

Folder: `modules/<footprint>/`, one set per footprint that any building with construction pictures uses. Picture passports, same footprint geometry as the buildings.

| File | Use |
|---|---|
| `stakes.png` | Stage 1: stakes and rope on the empty lot. |
| `foundation.png` | Stage 2: levelled site and foundation. |
| `scaffold_back.png` | Scaffolding behind the walls. Optional. |
| `scaffold_front.png` | Scaffolding in front of the walls. |
| `ramp.png` | The building ramp. |

Drawing order: `scaffold_back`, the building picture, `ramp`, `scaffold_front`.

## 6. Flags

`flags/district.png` and `flags/department.png`, anchor passports (anchor at the pole foot). Paint the cloth white or light grey: the engine tints it with the district colour (houses, district buildings) or the department banner colour. A flag appears on a finished building whose picture has a `flagAnchor`.

## 7. People

Folder: `people/<look>/tier_<n>/`.

* **Looks** are the pack's role looks (one per kind of role, plus one per role class for roles without their own); `--list` names them.
* **Tiers** 1 to 5 are outfits by agent level: tier 1 from level 1, tier 2 from 3, tier 3 from 6, tier 4 from 10, tier 5 from 18. Tier 1 is required; a missing higher tier falls back to the next lower one.
* **Animations**, one sheet each, `<animation>.png`:

| Animation | Resident state |
|---|---|
| `idle` | Standing, resting by the home |
| `walk` | Walking, wandering |
| `carry` | Carrying a stone to the building site of its goal |
| `carry_back` | Carrying a returned stone back (rework) |
| `build` | Building, also building its own home |
| `inspect` | Checking stones with a scroll (reviewers, testers) |
| `direct` | A department head showing where to carry, urging on |
| `survey`, `write`, `carve`, `gong`, `extinguish`, `guard` | Role work: surveying, writing, carving, ringing the alarm, putting out fires, standing guard |
| `hold_scroll` | Waiting at the altar for a person's answer |
| `pray` | Lying exhausted and praying by an empty store (limit used up) |
| `broken_tool` | Sitting with a broken tool (a failed turn) |
| `sleep` | Sleeping (its machine is offline, night in the district) |

A missing animation falls back to `walk` for moving states and to `idle` for the rest.

* **Sheet layout:** 5 rows top to bottom N, NE, E, SE, S; frames left to right; every frame the same size; the feet at the same `anchor` in every frame.
* **Cloak layer:** `<animation>.cloak.png`, exactly the same size and grid as its sheet, white or light grey where the cloak is and transparent elsewhere. The engine tints it with the subscription provider's colour from the pack palette, so one drawing serves every provider.
* **Rig and baking:** characters may be rigged by parts (body, head, arms, legs, outfit, cloak, prop) at the 544 px source and baked to sheets at 136 px. Keep the cloak as its own baked layer, keep the light at 5200 K from the top left, bake no ground shadow, and keep the feet on the anchor so walking does not slide.

## 8. Animation loops

`loops/<loop>.png` with a sheet passport, one row of frames: `crane`, `hoist_block`, `dust`, `smoke`, `water`, `awning`, `celebration`. On a building drawn from its picture, a loop is placed at the point named by its `attach`: `top` (the picture's `topAnchor`, or its roof line), `awning` (`awningAnchor`), `door` (`door`) or `ground` (the lot centre). Loops of buildings still on placeholders stay placeholders.

## 9. Ground, roads, decals and plants

Ground art uses the formats agreed with the terrain and plant layers:

* `ground/<material>.png`: 1024 x 1024 px, seamless, seen from straight above (the engine projects it onto the 2:1 ground), 4 x 4 tiles per texture; one per material id of the pack's terrain recipe.
* `ground/edges/`: transition masks between materials.
* `roads/<tier>.png`: road strips for `trail`, `dirt`, `brick` and `stone`.
* `decals/`: small ground details.
* Liquid: a bed texture and a ripple texture, with the base colours in `colors.json`.
* Plants: `veg/<name>.png`, a sway weight map `veg/<name>_w.png` (0 at the root, 1 at the tips) and a passport `veg/<name>.json` with `root_point`, `crown_center`, `crown_hub`, `height` and `crown_width`.

## 10. Checking and delivering

```
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <pack>          check, write nothing
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <pack> --write  check and write art-index.json
npx tsx apps/web/scripts/world-art-index.ts --pack <pack> --list                every slot, required or optional
```

The check prints every error with the file it is about, every file the pack has no slot for, and how many required files are still missing. It writes `art-index.json` only when there are no errors. Deliver the folder with its fresh `art-index.json`; the engine needs nothing else.
