# Theme archive

**Format 1.** One zip file holds a whole Hornhoof theme: how the interface looks, the world map with its art, the voice and names agents take in that world, the pictures the theme store shows, and the licence. Anyone who makes a theme writes this archive. The CEO uploads it in Settings, Themes, Upload theme, and the interface and the world change with no change to Hornhoof's code. Hornhoof's own themes (Cyberpunk, Light, Matrix, Egypt) are built as archives of the same format.

An archive is **data, never code**. Hornhoof reads every file in it as a picture, a font, plain text or JSON of a known shape, checks it, and stores only what passed. A file of any other kind, a value that reads as code, a link out of Hornhoof or a size over the limits refuses the whole archive, and the store says what is wrong and where (section 9).

## 1. What the archive holds

```
theme.json              the theme's card: name, version, author, licence, engine, languages
LICENSE                 the licence of everything in the archive (LICENSE.md and LICENSE.txt work too)
ui/look.json            colours, fonts and corners of the interface
ui/fonts.json           the font files and the faces they draw            optional
ui/fonts/*.woff2                                                          optional
ui/kit.json             painted interface parts                           optional, carried and checked, not drawn yet
ui/kit/*.png|*.webp|*.svg                                                 optional
ui/NOTES.md             notes on the skin for whoever changes it          optional
world/world.json        the world map: ground, plants, buildings, residents, stages   only with an engine
world/art/...           the world's art, as the world art contract asks              only with an engine
skills/world.json       the voice and era names agents take in this world            optional, only with an engine
preview/cover.png|webp  the store card's picture                          optional
preview/shot-1.png ...  up to six more pictures for the store             optional
```

A theme with no engine, like Cyberpunk, is `theme.json`, `LICENSE` and `ui/` only. `world/` or `skills/` in such a theme is refused.

The archive's files may stand at its root, or all inside one folder (as a zip tool makes when you pack a folder); nothing else may stand beside that folder.

## 2. theme.json

```json
{
  "format": 1,
  "id": "night-harbour",
  "name": { "en": "Night Harbour", "ru": "Ночная гавань" },
  "description": { "en": "A port city at night, with a lighthouse for every goal.", "ru": "Портовый город ночью, маяк на каждую цель." },
  "version": "1.2.0",
  "author": "Example Studio",
  "license": "CC-BY-4.0",
  "contract": { "ui": 1, "world": 2 },
  "engine": "iso2d",
  "languages": ["en", "ru"]
}
```

| Field | What it is | Rule |
|---|---|---|
| `format` | The version of this format | `1` |
| `id` | The theme's name for Hornhoof | 2 to 40 characters: lower case Latin letters, digits and `-`, starting with a letter. A theme with the id of one Hornhoof ships stands in its place for the company; deleting it brings the shipped one back |
| `name` | The theme's name in the store | `en` and `ru`, each 1 to 60 characters; other languages Hornhoof speaks may follow |
| `description` | One or two sentences for the store | optional; `en` and `ru`, each up to 280 characters |
| `version` | The theme's own version | `MAJOR.MINOR.PATCH`. Uploading a theme that is installed already replaces it when the version differs, and is refused when it is the same |
| `author` | Who made it | 1 to 80 characters |
| `license` | The licence, as an SPDX id (`CC-BY-4.0`, `MIT`, `OFL-1.1`) or `see LICENSE` | 1 to 60 characters; the full text is in `LICENSE` |
| `contract` | The versions of the parts it was made for | `ui`: `1`. `world`: the world art contract version, `2` today; only with an engine |
| `engine` | How the world map is drawn | `none` (the schematic map, as in Cyberpunk), `iso2d` (the isometric world). `3d` is a known word but is refused: Hornhoof has no 3D world yet |
| `languages` | The languages the theme's words are written in | at least `en` and `ru` |

Text in any field is plain: no control characters, no characters that turn the direction of text, no `<`, `>` or links.

## 3. ui/: the interface

### 3.1 look.json

The interface's colours, fonts and corners. It is the skin of Hornhoof's theme sheet (`docs/hornhoof-themes.md`), the same values a built-in theme has in `apps/web/src/skins/registry.ts`, written as JSON. It changes the look and nothing else: no size, gap, padding, border width or position can be named, and no screen moves (theme sheet, section 2).

```json
{
  "scheme": "dark",
  "cut": 0.5,
  "shape": "bevel",
  "surface": "plain",
  "fonts": { "display": ["Harbour Sans", "sans-serif"], "body": ["Golos Text", "sans-serif"], "mono": ["ui-monospace", "monospace"] },
  "colors": { "bg": "#0E1620", "surface": "#15202C", "ink": "#E4ECF3", "accent": "#5FC4E8" },
  "worldColors": { "ground": "#1F2C38", "path": "#3B4B5A", "field": "#2E5A45", "water": "#16405E", "structure": "#4A5866", "shade": "rgba(0, 0, 0, .3)" },
  "terminal": { "bg": "#0A1017", "ink": "#DCE6EE" }
}
```

* `scheme` is `dark` or `light`.
* `colors` names every colour role of the theme sheet. The example above is shortened; the full list of 35 roles is `COLOR_TOKENS` in `apps/web/src/skins/roles.ts`, and the store's sample skin file names them all.
  * A colour is `#RRGGBB`, `#RGB` or `rgb()` / `rgba()`. Only the roles drawn over something else may be see-through: `dot`, `glow`, `hud`, `shadow` and `scrim`.
  * Text must stand out from what it stands on: 4.5:1 for text and 3:1 for lines. The upload is checked as an own skin file is checked.
* `fonts` gives the three stacks, `display`, `body` and `mono`. Each may name the fonts Hornhoof ships, a family of `ui/fonts.json`, and the generic families (`sans-serif`, `serif`, `monospace`, `system-ui`). A stack ends with a generic family.
* `cut` is how far the corners are cut, from 0 to 1.5. `shape` is `bevel` or `steps`.
* `surface` is how panels are drawn: `plain`, or a surface style Hornhoof ships (`papyrus`).
* `worldColors` (optional) gives the colours of the world map's ground, paths, fields, water, buildings and shade.
* `terminal` (optional) gives the agents' terminal: `bg`, `ink`, and optionally `cursor`, `cursorAccent`, `selection`, `selectionInk`, `idle` and the 16 `ansi` colours.

Every value is checked by pattern before it is used. Anything that reads as code is refused: `url(`, `var(`, `expression(`, `image(`, `@import`, `;`, braces, `<`, `>`, a backslash, a comment, or a control character.

### 3.2 fonts.json and fonts/

```json
{
  "faces": [
    { "family": "Harbour Sans", "file": "harbour-sans-latin-400.woff2", "weight": 400, "style": "normal", "unicodeRange": "U+0000-00FF,U+0131,U+0152-0153" },
    { "family": "Harbour Sans", "file": "harbour-sans-cyrillic-400.woff2", "weight": 400, "style": "normal", "unicodeRange": "U+0400-045F,U+0490-0491" }
  ]
}
```

* Fonts are WOFF2 files only, checked by their bytes, each up to 2 MB, at most 24 faces.
* A face names its `family` (1 to 40 letters, digits, spaces and `-`), its `file` in `ui/fonts/`, its `weight` (100 to 900), its `style` (`normal` or `italic`) and an optional `unicodeRange`.
* Hornhoof writes the `@font-face` rules itself; a font never comes as CSS.
* A font's licence (OFL for most) goes into `LICENSE` or beside the font as `ui/fonts/<family>-OFL.txt`.

### 3.3 kit.json and kit/: painted parts, carried and checked, not drawn yet

A kit is pictures of interface parts (frames, panels, buttons with their states, fields, chips, counters, rows, dividers) that would replace the look of each part without moving it. Hornhoof does not draw kits yet: drawing them is a separate step with the head of Design, after the kit guide leaves its draft. An archive may already carry its kit. Hornhoof checks it, stores it and serves it, and a theme with a kit looks like the same theme without one until kits are drawn.

```json
{
  "slots": {
    "dialog": { "file": "dialog.frame@2x.webp", "slice": "34", "width": "17px" },
    "btn": { "file": "btn@2x.webp", "slice": "10 fill", "width": "5px" },
    "panel": { "file": "panel.fill@2x.webp", "size": "128px 128px" }
  },
  "colors": { "tab-ink": "#502704", "danger-ink": "#6A1030" }
}
```

* A slot's name is 1 to 40 lower case letters, digits and `-`.
* Its `file` is a PNG, WebP or SVG in `ui/kit/`, of at most 2 MB.
* `slice` is up to four whole numbers of picture pixels, with an optional `fill`.
* `width`, `outset` and `size` are up to four lengths in `px` or `%`.
* A kit colour is `#RRGGBB`.

Anything else is refused, so a kit can never carry CSS. The screens get the kit as stored from `GET /api/themes/:id/look`, beside `base`: a slot's picture is served at `base` + `ui/kit/` + its `file`.

An SVG of the kit is taken as a drawing only, and it is the one SVG a theme may hold (`.svg` anywhere else is refused as a page, and `.svgz` everywhere). It is one `<svg>` element of shapes (`path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`), groups and reuse (`g`, `defs`, `symbol`, `use`, `title`, `desc`), paint (`linearGradient`, `radialGradient`, `stop`, `pattern`), `clipPath`, `mask`, and `filter` with its `fe` primitives, with their geometry and presentation attributes. Refused, with `svg_unsafe` or `link_outside` and the element or attribute it is about:
* any other element, among them `script`, `foreignObject`, `style`, `image`, `a` and the animation elements;
* an event attribute (`on...`), a `style` attribute, or an attribute not named above, such as an editor's own;
* an `href`, `xlink:href` or `url()` that is not `#id` of an element of the same drawing, also when written with character references;
* a namespace other than SVG's and XLink's, a document type, an entity of its own, character data, a processing instruction other than the XML declaration, or text outside the drawing.

## 4. world/: the world map (engine iso2d)

### 4.1 world.json

The world pack of the isometric engine, as data: the world pack manifest of `apps/web/src/world/manifest.ts` (`WorldPackManifest`) in JSON, every field but the two functions. It holds:
* the map size, projection and camera;
* tiles, ground materials, the liquid layer, paths and ground art;
* plants, wind and light;
* the buildings and how they are laid out;
* the residents' looks per role and their fallbacks;
* the construction stages and their palette;
* the stage counts, the palette of the map, and the altar;
* the art catalog: which pictures the art folder has slots for (`apps/web/src/world/art.ts`, `WorldArtCatalog`).

Hornhoof sets two fields itself: `id` (the theme's id) and `art.baseUrl` (where it serves `world/art/`).

**The map recipe stays Hornhoof's.** A recipe is code that shapes the ground, so an archive cannot bring one. Instead, `world.json` names one of the recipes Hornhoof ships, and may rename and recolour its tile kinds:

```json
{
  "recipe": {
    "use": "space-station",
    "tiles": { "deck": { "label": { "en": "Quay", "ru": "Причал" }, "color": "#3B4B5A" } }
  }
}
```

| Recipe | Its map |
|---|---|
| `egypt-river-valley` | A river valley: the water through the middle, fields along it, dry land beyond |
| `space-station` | One large station in open space: an outer hull with docking arms, ring corridors and spokes, garden and cargo bays, and open frame the city builds into |
| `dungeon-subterranean` | Bedrock the city digs into, natural caverns, glowing pockets and ore veins, a winding underground river of fire and a carved starting hall |

The pack's `materials` must give every material id the recipe uses, and its tiles must cover the recipe's tile kinds; a tile kind or material the recipe does not have is refused. A new map shape is a new recipe in Hornhoof's code, not part of an archive.

The world pack check of `validateWorldPack` runs on the manifest Hornhoof rebuilds, as it does for the packs Hornhoof ships.

### 4.2 art/

The art folder as the world art contract asks (`apps/web/src/world/ARTIST_CONTRACT.md`, contract version 2):
* buildings, people, loops and flags, each picture with its passport JSON beside it;
* ground textures, transitions, liquid, roads, decals and plants, at the paths `world.json` names.

Hornhoof runs the same art check as `world-art-index.ts` on it and writes `art-index.json` itself. An `art-index.json` in the archive is ignored. A file the check rejects refuses the archive, with the check's own words. A slot with no file keeps its placeholder, as everywhere.

Art is PNG, RGBA, sRGB, with straight alpha. The size standard (master 4x tier):

| What | Size |
|---|---|
| Ground tile | diamond 240 x 120 px, 2:1 |
| Person | 136 px from feet to the top of the head |
| Ground texture | 1024 x 1024 px, seamless on both axes; one tile is 256 x 256 px of it |
| Transition | 1024 x 256 px, 8-bit grey |
| Road | 256 px of height per tile of road width, 1024 px long |

Buildings, square footprints:

| Footprint | Diamond | Door height | Highest picture |
|---|---|---|---|
| 1x1 | 240 x 120 | 148 | 420 |
| 2x2 | 480 x 240 | 152 | 680 |
| 3x3 | 720 x 360 | 156 | 960 |
| 4x4 | 960 x 480 | 160 | 1200 |
| 5x5 | 1200 x 600 | 164 | 1440 |
| 6x6 | 1440 x 720 | 168 | 1680 |

## 5. skills/world.json: the world's voice and names

```json
{
  "label": { "en": "Night Harbour", "ru": "Ночная гавань" },
  "address": { "en": "Aye, captain", "ru": "Есть, капитан" },
  "salutations": ["Aye, captain", "Right away, captain", "Есть, капитан", "Будет сделано, капитан"],
  "names": {
    "ruler": { "en": "Harbour Master", "ru": "Начальник порта" },
    "employees": { "en": ["Ada", "Brann", "Corin"], "ru": ["Ада", "Бранн", "Корин"] }
  }
}
```

* `address` is how an agent greets a person in this world, and `salutations` are up to 12 more such lines, each up to 60 characters.
* `names` holds the CEO's title and the names agents take when the theme is on, at most 120 per language, each up to 40 letters, spaces, `-` or `'`.

What an archive can never do with its skills:
* An archive gives words, not instructions. Hornhoof writes the voice skill itself, from its own fixed text, and quotes the archive's lines in it as examples of tone.
* The voice is used only when an agent answers a person directly. It never reaches agents' messages to each other, the orchestrator, tasks, commits, code, documents or posts.
* It never changes a fact or softens bad news.
* An archive gives an agent no right, tool or step of work, and cannot turn any of these rules off.

Turning the theme off gives every agent its own name back.

## 6. preview/

`cover.png` or `cover.webp` is the store card's picture, and `shot-1` to `shot-6` (PNG or WebP) are more pictures shown when the card is opened. Each is up to 2 MB and up to 2560 px a side. Without a cover the card shows the theme's colours.

## 7. LICENSE

Plain UTF-8 text, up to 64 KB, required. It covers everything in the archive. A theme's art may be under a licence other than Hornhoof's MIT, and may forbid commercial use; that is the author's choice, and the store shows `license` from `theme.json` beside the theme.

## 8. Limits

| What | Limit |
|---|---|
| The archive | 200 MB |
| Everything in it unpacked | 400 MB |
| Files | 5 000 |
| One file | 16 MB |
| How much one file grows when unpacked | 100 times its packed size |
| A path | 200 characters, folders and names of Latin letters, digits, `.`, `_`, `-` and `@` |
| A JSON file | 1 MB (`world/world.json` 2 MB, a passport 64 KB) |
| A picture | PNG or WebP, up to 8192 px a side and 50 million pixels |
| A picture of the kit | PNG, WebP or SVG, up to 2 MB |
| A font | WOFF2, up to 2 MB, at most 24 |

## 9. What refuses an archive

Each of these refuses the whole archive. The store names the reason and the file:
* A zip that is not a plain zip: encrypted, split, ZIP64, or packed in a way other than stored or deflate.
* A path that leaves the archive or hides what it is: an absolute path, `..`, a backslash, a drive letter, an empty part, a control character, a link, or two names that differ only in upper and lower case.
* A file of a kind the archive has no place for, in particular any script or page (`.js`, `.mjs`, `.html`, `.svg` outside the kit, `.css` and the like), a drawing of the kit with more than a drawing in it (3.3), or a file whose bytes are not what its name says.
* A file over its limit, or one that unpacks to more than its header says.
* JSON that is not of the shape this document gives, a key no part knows, or a value that reads as code (3.1).
* A link to anything outside the archive.
* A world that the world pack check or the art check refuses (4.1, 4.2), or skills that the world skill check refuses (5).

## 10. Turning a theme on, off and deleting it

* Uploading installs the theme for the company. It does not turn it on.
* The CEO turns a theme on for the whole company in Settings, Themes. Hornhoof applies the look, loads the fonts, draws the world, and gives agents the world's names.
* Turning it off means choosing another theme. The look goes back to that theme, the map goes back to that theme's map, and agents get their own names back. Nothing of the theme stays in the interface.
* Deleting a theme that is on turns it off first, back to Cyberpunk, and then removes all its files.

Without the screen, whoever runs the server installs an archive for one company with the same check and the same install, in the name of that company's owner:

```
node apps/server/dist/cli.js theme-install egypt.zip --company <company id> [--log <file>]
```

It refuses what an upload refuses, the same version twice among it, and a company that is not there. Each attempt is one JSON line appended to the log (`theme-installs.log` in the folder it runs in unless `--log` names another): when, which company, the archive's SHA-256, and whether it was installed or why not. It turns nothing on.

## 11. Building Hornhoof's own themes as archives

`apps/web/scripts/theme-pack.ts` writes the archive of a theme Hornhoof ships, from `skins/registry.ts`, its world pack and its world voice, in this same format. A world whose art is licensed apart from the repository takes that art, and the licence that goes with it, from outside it:

```
npx tsx apps/web/scripts/theme-pack.ts cyberpunk --out cyberpunk.zip
npx tsx apps/web/scripts/theme-pack.ts egypt --art <the Egypt art folder> --licence <its licence> --out egypt.zip
```

Without `--art` a world has no pictures, and the engine draws its placeholders. Packing writes no dates, so the same theme from the same commit always gives the same archive.

The Egypt art never goes into this repository (#105). Its archive is built where the art is and installed on the server by upload, as any theme is.
