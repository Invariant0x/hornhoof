# World art contract

This is the agreement between the artists of a world pack and the world engine. A pack declares slots for pictures and sheets (its art catalog in `world-packs/<pack>/art.ts`); artists fill the slots with PNG files and a small passport JSON beside each; the engine draws a file as soon as it is in the pack's art folder. A slot still empty in a step that has other pictures shows the nearest drawn picture of the same line (a fill level, tier or stage next to it; at the same distance the later one), so a half-delivered step never shows a placeholder; only a step with no picture at all keeps its geometric placeholder. Art can arrive one file at a time; nothing in the engine changes when it does.

Contract version: **2** (`ART_CONTRACT_VERSION` in `art.ts`). Version 2 adds a building's own construction line (`stage_01.png` to `stage_10.png`, scaffolding drawn in) and demolition (`demol_01.png`, `demol_02.png`), and layers over a picture (a shadow that darkens what is under it, props, an awning that sways); the version 1 construction pictures stay valid. Rebuild `art-index.json` with the version 2 check.

What is specific to one world (which buildings, which looks, its colours and style) lives in that pack's own notes, for example `world-packs/<pack>/ART.md`. This file holds only what is the same for every world.

## 1. Where the art lives

* Art is licensed per pack and **never goes into this repository**. Put the pack's license note next to its art (for example `LICENSE.md` in the art folder).
* A pack's art folder is served at the pack's `art.baseUrl`, for example `/world-art/<pack>/`.
  * Local work and builds: put the folder at `apps/web/public/world-art/<pack>/`. The path is ignored by git; Vite serves it and copies it into the build.
  * A running server: put the folder at `<WEB_DIST>/world-art/<pack>/`.
* Buildings, people, loops and flags (sections 4 to 8): the folder holds `art-index.json` at its root. Without `art-index.json` they all draw on placeholders. Build and check the index with the art check command (section 10). A file the check rejects is held out of the index, and its slot shows the nearest drawn picture as if it were still empty; one broken file never breaks the city.
* Ground and plants (section 9) are named by the pack's manifest. The index lists them too.
* The index gives every file its byte size and a hash of its bytes. On the first visit the map downloads every file the engine draws behind its loading screen and keeps it in the browser. Later visits read the kept copies and download only the files whose hash changed. The web build writes the index of the art folders it ships from their files, so the index in a release always has the hashes; the `--dist` check fails a dist whose index lacks a hash or gives one its file does not have.

## 2. Standard sizes

All art is drawn at the **master 4x tier**.

| What | Size |
|---|---|
| Ground tile | diamond 240 x 120 px, 2:1, edges at 26.565 degrees |
| Person | 136 px from feet to top of head |
| Rig source for people | 544 px tall (8x), baked down to 136 px |
| Camera | 30 degrees above the ground, looking down the diamond's vertical axis; people alone at 19 degrees (section 7) |
| Sun | top left (azimuth -45 degrees, elevation 55 degrees), 5200 K |
| Directions | As the animation needs, any of the 8 (N, NE, E, SE, S, SW, W, NW); a direction not drawn shows the nearest drawn one or its mirror (SE, E and NE mirror to SW, W and NW) |

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
| `groundAnchor` | yes | Centre of the footprint diamond on the ground. This point lands on the centre of the building's footprint (its lot can be larger, behind it). Must be the centre of `corners`. |
| `corners` | yes | `top`, `right`, `bottom`, `left` of the footprint diamond on the ground. Width must match the footprint (section 2), 2:1. |
| `door` | no | Foot of the door on the ground. |
| `wallTopLine` | no | y of the top of the walls. |
| `roofLine` | no | y of the roof edge. |
| `wallCutY` | no | y where a full-height wall picture may be cut to stand in for waist-high walls (section 4). |
| `flagAnchor` | no | Foot of the flag pole on the roof. Without it the building has no flag. Top loops attach here when the picture has no `topAnchor`. |
| `awningAnchor` | no | Top edge of a swaying awning. |
| `awningLoop` | no | `true`: the building takes the `awning` loop sheet at its `awningAnchor` (section 8), which it then must name. Leave it out on a building whose awning is painted in or comes as a layer. |
| `topAnchor` | no | Top centre (apex, spire, chimney): where a capstone or a top loop attaches. |
| `workSlots` | no | Up to 3 points `{ x, y, layer }` with `layer` `front` (on scaffolding, in front of walls) or `inside` (in open rooms) where workers stand. |
| `layers` | no | Pictures drawn over this one, in order (section 4, layers). |
| `empty` | no | Shared modules only: why this module is an empty canvas (section 5). |

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
| `attach` | Loops only: `top`, `awning`, `door`, `ground` or `head` (section 8). |
| `directions` | People only, optional: the drawn directions among N, NE, E, SE, S, SW, W, NW, one row each in this order (section 7). |
| `headAnchor` | People, `sleep` only, optional: in one frame, where the sleeper's Z loop stands (section 7). |
| `stride` | People, `walk` and `carry`, optional: px the figure moves on in one cycle, as the E row draws it; 92 without it (section 7). |

## 4. Buildings

Folder: `buildings/<kind>/<step>/`. The pack's catalog names the steps of each kind, each with its own footprint, for example a small first home on 1x1 and a large one on 4x4. The engine picks the step that matches the building's current size and stage, or the nearest larger one scaled down. Run the art check with `--list` to see every slot of a pack.

| Kind | What it is in the company |
|---|---|
| `house` | An agent's home; grows with the agent's level (sizes from the pack's layout, 1x1 to 4x4). |
| `department` | A department's hall in the centre (3x3 to 5x5). |
| `residence` | The ruler's (orchestrator's) residence, 5 growth stages (2x2 to 6x6). |
| `district_hub` | A machine's building in its district (3x3 to 4x4, or the sizes its pack names). |
| `supply` | A subscription's store by the water; shows how much of its limit is left. |
| `flophouse` | Lodging of one-off helpers at the edge of a district (2x2 to 3x3). |
| `statue` | A department's statue, 20 stages; an alley of them grows larger (1x1, 2x2, 3x3). |
| `monument` | A top goal's monument in tiers with a capstone (4x4 to 6x6). |
| altar | The god's altar where agents wait for a person's answer: `buildings/altar/complete.png`, 1x1. |

### Door and growth

A building stands at the front (bottom) corner of its lot and grows backward: a bigger step keeps the same front corner, the old building stays in front and the new rooms go behind it. So the plot's bottom corner, the door and the scale of a person never move between the steps of one kind, and every step's picture puts the plot's bottom corner at the bottom centre of its canvas.

The door is on one of the two front walls, the walls that face the viewer: `front_right` (from the plot's right corner down to the bottom corner) or `front_left` (from the bottom corner up to the left corner). Draw it where the street can reach it, never on a back wall. When the pack names a door for a kind (`buildingLayout` in its manifest: the wall, the tile row of the door counted from the bottom corner, and the sizes the kind grows through), the city puts the street in front of exactly that row, so draw the door there in every step. Kinds the pack does not name get their door on whichever front wall the street reaches best.

### Pictures of one step

A step may come in drawn **variants** (`variants` in the pack catalog): each a full set of the step's pictures in its own folder, `<step>/v01/`, `<step>/v02/`, and so on, with the step's canvas, anchor, door row and lot. `v01` is required, the others optional. The engine gives each building one variant from its id, the same in every session; next-door buildings of the same step do not repeat one while another is free, and a variant not delivered yet gives way to the next delivered one. A variant whose stages are not all drawn yet stands only as a finished building: a building under construction takes the next variant, from its own, that has every stage drawn (as its own picture or its `stage_NN`) and keeps it once built, while one torn down keeps the look it stood in. When no variant has every stage, construction shows the building's own variant with the nearest drawn picture. A step delivered with no variant folders, its pictures directly in `<step>/`, counts as its `v01`; a `v01/` folder of its own wins over it.

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

A step may instead carry its whole construction line on its own canvas, scaffolding, ramps and ropes drawn in:

| File | Shown when |
|---|---|
| `stage_01.png` to `stage_10.png` | Construction stage N (the table below) before the building is finished. With these the version 1 construction pictures are not needed. |
| `demol_01.png` | Demolition, first half: the building half torn down. |
| `demol_02.png` | Demolition, second half: rubble. |

Every one of them has a picture passport with the same footprint diamond as `complete.png`, so the building does not move between stages.

### Layers over a picture

A picture passport may name layers: PNG files beside the picture, of exactly the same size and registration (the same canvas, the plot's bottom corner at the same point), drawn over it in the order given.

```json
"layers": [
  { "file": "shadow.png", "blend": "multiply" },
  { "file": "props.png" },
  { "file": "awning.png" }
]
```

* `blend: "multiply"` multiplies what is under the layer by the layer's colour: a shadow keeps the colour of the ground and walls it falls on. Black with alpha for its strength works, and so does a tinted shadow.
* A layer sways in the wind only by its cloth mask, `<layer>_w.png` beside it (for example `awning_w.png`), in the plants' format (section 9): 8-bit grey, the same size, 0 still (the line where the cloth is fastened, posts and frame), 255 moves the most (the free edge). The engine lifts and drops the cloth by the mask, a little; a pixel at 0 never moves, and a layer without a mask never moves. The layer's own passport (`awning.json`) may carry `amplitude`: how many px the free edge lifts at the strongest wind, 3 by default, at most 8. Neighbouring buildings sway with different phases. Wooden posts and frames go into the picture or `props.png`, never into a swaying layer.
* Keep a layer to what moves or must stay separate; whatever never moves belongs in the picture itself.

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

With a step's own `stage_NN.png`, stages 1 to 8 show that picture and no shared modules; demolition shows `demol_01.png`, then `demol_02.png`, when both are there.

A pack may draw stage 4 from `full_walls.png` cut at its `wallCutY` instead (`stagePictures` in the pack catalog). The default keeps the open rooms of stage 3, because a straight cut through an isometric wall shows no wall thickness.

Kinds without construction pictures:

* `statue`: `stage_01.png` to `stage_20.png` (the pack's statue stage count), one set per size step.
* `monument`: `tier_01.png` to `tier_10.png` (the pack's monument stage count), shown by how much of the goal is done, plus `capstone.png` (anchor passport) placed at the last tier's `topAnchor` when the goal is reached.
* Kinds the pack lists in `ownConstruction` carry their scaffolds and ramps in their own stage pictures: the engine lays no module, crane or hoist over them.
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

When nothing of `scaffold_front` or `ramp` fits inside the lot in front of the footprint's walls, deliver it as an empty transparent canvas of the footprint with `empty` in its passport saying why. It counts as delivered, and the engine lays nothing for it.

## 6. Flags

`flags/district.png` and `flags/department.png`, anchor passports (anchor at the pole foot). Paint the cloth white or light grey: the engine tints it with the district colour (houses, district buildings) or the department banner colour. A flag appears on a finished building whose picture has a `flagAnchor`.

## 7. People

Folder: `people/<look>/tier_<n>/` for the `male_slim` body, `people/<look>/tier_<n>/<body>/` for the others: `female_slim`, `male_heavy`, `female_full`. The engine gives each resident a body from its agent's id, the same in every session, and uses the `male_slim` sheet where that body's is missing.

People are drawn with an orthographic camera tilted 19 degrees down, not the 30 degrees of buildings and ground: at 30 degrees shoulders come out too wide and a step looks like a hop. The sheet stands on the 30-degree ground by its `anchor`, and the engine draws the shadow.

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
| `pray` | Facing the camera, hands raised: the limit used up, and by an empty store |
| `sad_sit` | Sitting on the ground, sad: the limit used up |
| `broken_tool` | Sitting with a broken tool (a failed turn) |
| `sleep` | Lying asleep (its machine is offline, night in the district, or the limit used up), with the `sleep_z` loop over the head |

A missing animation falls back to `walk` for moving states and to `idle` for the rest.

* **Sheet layout:** one row per drawn direction, in the order of the passport's `directions`; without the field 5 rows top to bottom N, NE, E, SE, S. Frames left to right; every frame the same size; the feet at the same `anchor` in every frame.
* **Directions:** draw an animation only in the directions its meaning needs. For each facing the engine shows the drawn row when there is one; a direction not drawn shows the nearest drawn direction or its mirror (SE, E and NE mirror to SW, W and NW), a drawn row winning at the same distance. A mirror moves a carried item to the other hand, so an animation with an item in one hand or on one shoulder draws every way a resident walks on screen (NE, SE, SW, NW): `carry` of every look, and the `walk` of a look whose prop is a large item (the pack's `largeItem`: a staff, banner, jar and the like), whose `idle` draws SE and SW; the check rejects them otherwise. `pray` and `sad_sit` face the camera: drawn S only and shown as drawn whatever way the resident faces, never mirrored.
* **Stride:** a walking sheet's `stride` is how far the figure moves on in one cycle, as the E row draws it: twice the distance a planted foot travels back in half a cycle. The engine walks a resident exactly one stride per cycle (`frames` / `fps` seconds), the same ground in every direction, so the feet do not slide. Without the field it takes 92 px, measured on the pilot walk sheets.
* **The sleeper's Z:** `loops/sleep_z.png`, a loop sheet with `attach` `head`, its `anchor` at the bottom centre of the letters. The engine stands it at the `sleep` sheet's `headAnchor`, or 146 px above the feet without one, and never mirrors the letters.
* **Cloak layer:** `<animation>.cloak.png`, exactly the same size and grid as its sheet, white or light grey where the cloak is and transparent elsewhere. The engine tints it with the subscription provider's colour from the pack palette, so one drawing serves every provider.
* **Rig and baking:** characters may be rigged by parts (body, head, arms, legs, outfit, cloak, prop) at the 544 px source and baked to sheets at 136 px. Keep the cloak as its own baked layer, keep the light at 5200 K from the top left, bake no ground shadow, and keep the feet on the anchor so walking does not slide.

## 8. Animation loops

`loops/<loop>.png` with a sheet passport, one row of frames: `crane`, `hoist_block`, `dust`, `smoke`, `water`, `awning`, `celebration`, and for people `sleep_z` (section 7). On a building drawn from its picture, a loop is placed at the point named by its `attach`: `top` (the picture's `topAnchor`; without it the foot of its flag pole, `flagAnchor`; then its roof line, its wall top, or the back corner of its lot), `awning` (`awningAnchor`), `door` (`door`) or `ground` (the lot centre). Loops of buildings still on placeholders stay placeholders.

The `awning` loop is drawn only on a picture whose passport says `awningLoop: true`, at its `awningAnchor`; without the flag a building gets no awning loop, so a house with its own awning never shows two.

A building site shows one lift, never both: `crane` on a lot of 3 x 3 tiles or more, its sheet drawing its own hanging block, and `hoist_block` alone on a smaller lot.

## 8a. The harbour

Where the work comes from (#2006): a task created comes down the river as a stone on a cargo boat, waits in the harbour's stone yard (the open queue) and is carried from there to its building. A pack declares the harbour in its catalog with the footprint its yard is drawn for (`harbour: { yard: '2x2' }`). There is no placeholder: until the art folder holds every file a harbour needs, the engine shows no harbour at all, and the stones come from the residents' homes as before. Every file below is optional to the check. Points in a passport are [x, y] on the picture's canvas.

* **Quay and jetty pieces:** `harbour/quay_<axis>_<piece>.png` and `harbour/jetty_<axis>_<piece>.png` for axis `u` (down right on screen) and `v` (down left) and piece `start`, `span` and `end`: one tile each, a picture passport of footprint 1x1. A quay runs along the bank, `u` where the water lies on its `+v` side and `v` where it lies on its `+u` side; its jetties run out into the water at a right angle, along the other axis. The first tile of a line is its `start`, the last its `end`, any between are `span`s. A jetty's end may name `mooring` [x, y], the water-line point where a boat lies.
* **Cargo boat:** still pictures, no sheet and no shadow layer: `boats/cargo/sail_<ne|se|sw|nw>.png` under sail in each screen heading, `boats/cargo/moored_<axis>.png` at a jetty along that jetty's axis with blocks still aboard, and `boats/cargo/empty_<axis>.png` there once the last block is off, before it casts off. Each has a boat passport: `anchor` (the middle of the hull at the water line), `heading` (the way the bow points), `bow`, `lengthTiles`, and `cargoPoints`, the top middle of each stack of blocks on deck; the check rejects a boat without a cargo point. The hull is drawn without cargo: the engine lays `boats/cargo/block.png` on the cargo points in turn, one stack per point, at most the pack's `harbour.boatCargoMax` blocks (4 when unset). The block's passport gives `anchor` (where it sits) and `stackTop` (where the block on it sits); without `stackTop` no block goes on another, so a boat shows no more blocks than it has cargo points.
* **Stone yard:** `harbour/stone_yard/fill_0.png` to `fill_4.png`, one canvas for every stage, the picture passport of the catalog's yard footprint, with its shadow as a `multiply` layer (`fill_<n>_shadow.png`, section 4) and optional `workSlots` and `stackTops`. `fill_0` is the empty yard; the engine steps up a picture at 1, 4, 8 and 15 stones waiting.
* **No river:** with `harbour.gate`, `harbour/gate_<a|b>.png` (2x2) and the caravan sheet `harbour/caravan_walk.png` with rows `NE`, `SE`, `SW` and `NW`; the yard is the same.

What a harbour needs before it is shown: every quay and jetty piece its lines use, the four sailing boats, `moored_` and `empty_` along its jetties' axis, the block, and the five fill pictures of the yard; by land, the gate of its orientation, the caravan sheet and the yard.

## 9. Ground, roads, decals and plants

The terrain and plant layers load the files the pack names in its manifest; the index lists them with their hash like every other file. The pack names every file in its manifest: `terrainArt` for ground, transitions, roads and liquid, and the `art` list of each plant kind (one entry per drawn variant). A slot whose file is missing keeps its procedural look. The paths below are the usual layout; the manifest is what counts.

* **Ground:** one texture per ground material id of the pack's terrain recipe, `ground/<material>.png`, 1024 x 1024 px, seamless on both axes, seen from straight above, with no objects and no cast shadows. One map tile is 256 x 256 px of the texture, so one texture covers 4 x 4 tiles: tile (x, y) starts at ((x * 256) mod 1024, (y * 256) mod 1024). The engine projects it onto the 2:1 ground.
* **Transitions:** `ground/edges/<first>_<second>.png`, 1024 x 256 px, 8-bit grey, one file per pair of material ids the pack declares. Rows run across the border, one tile deep: 255 is the first material, 0 the second. Columns wrap, so the border has no seam along its length.
* **Liquid:** a surface texture, a bed texture (the relief of the bottom without the liquid's tint) and a ripple map (8-bit grey, mean 128), each 1024 x 1024 and seamless, plus the base colour in the manifest. The engine mixes them every frame, so the surface moves without a sheet of frames.
* **Roads:** `roads/<tier>.png`, seamless along the length (1024 px = 4 tiles), alpha 0 on the first and last row, as tall as the road is wide (256 px per tile of width: a 0.4 tile path is 102 px, a 2 tile avenue 512 px). With a strip for each of the four city street tiers (`terrainArt.roads`: `trail`, `dirt`, `brick`, `stone`), the engine bakes the city's streets into the ground: each tier is one strip along the tile centres with one soft edge, so a crossing, a T-join and a bend show a single outline, and where two tiers meet the higher lies over the lower. Rows across the strip follow the distance from the street's middle, columns run along it, so paint the edge rows as the street's edge and the middle as its trodden core. Road joins need no pictures of their own.
* **Bridge:** the map's one bridge (`bridge-site.ts`) is drawn from six pictures the pack catalog declares with `bridge: true`: `bridge/<axis>_<piece>.png` for axis `u` (down right on screen) and `v` (down left) and piece `start`, `span` and `end`, one water tile of the deck each. Unlike the ground they go through `art-index.json`, each with a picture passport of footprint 1x1 (canvas up to 420 px high, 320 x 400 px in the order); the engine puts `groundAnchor` on the centre of the water tile. The deck meets the street at ground level on both banks. Until every piece is in the folder, the city lays no street across water and no resident crosses it, and nothing stands in for the bridge.
* **Decals:** `decals/<name>.png`, small RGBA details laid on the ground at master scale.
* **Plants:** three files per plant, all at master scale next to the 136 px person:
  * `veg/<name>.png`: RGBA, transparent background, no ground shadow;
  * `veg/<name>_w.png`: 8-bit grey sway weights, the same size: 0 stays still, 255 moves the most;
    a building layer's cloth mask, `<layer>_w.png`, has the same format (section 4, layers);
  * `veg/<name>.json`: `root_point` [x, y] (the pivot on the ground), `crown_center` [x, y], `height_px`, `crown_width_px` (older passports say `height` and `crown_width`), optional `crown_hub` [x, y] (where a palm's leaves meet the trunk, the pivot of their flutter; `crown_center` without it) and optional `recommended_sway` (frequency range in Hz, largest tip excursion in percent of the height, secondary flutter in px).

  Every plant sways with its own phase, so a grove never moves as one.

## 10. Checking and delivering

```
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <pack>          check, write nothing
npx tsx apps/web/scripts/world-art-index.ts <art folder> --pack <pack> --write  check and write art-index.json
npx tsx apps/web/scripts/world-art-index.ts --pack <pack> --list                every slot, required or optional
npx tsx apps/web/scripts/world-art-index.ts --dist <web dist> --pack <pack>     a production build holds the pack's art
npx tsx apps/web/scripts/world-art-import.ts <delivery> --to <art folder> --pack <pack> --kind <kind> --steps <a,b,c>
```

The import command takes one building as the art pipeline delivers it (its construction line, demolition, layers and the larger steps it grows into, on plot canvases) and lays it out in the art folder with passports, as this contract asks; its header lists the delivery's layout.

The check prints every file it holds out with what is wrong with it (`HELD OUT <file>: ...`), every file the pack has no slot for, and how many required files are still missing. A file it rejects is held out, with any file that needs it (a cloak whose sheet is held out), and `art-index.json` is written for the rest; the command then ends with exit code 1 so the rejection is not missed. Only an error of the whole folder (another pack or contract) writes nothing. The web build holds out the same files from the index it writes. Deliver the folder with its fresh `art-index.json`; the engine needs nothing else.

The `--dist` check reads a built web dist. It fails unless `<web dist>/world-art/<pack>/art-index.json` lists art the pack draws and the dist holds every file it lists with the size and the content hash the index gives, so a production build can't ship the placeholder look without anyone noticing. It isn't a step of the image build yet: the first pack's painted art is licensed for Hornhoof only and may not go into the public repository or the public image, so the build has no source for it yet, and the check would stop every image from main. It joins the image build in the change that brings the art source (#1944).
