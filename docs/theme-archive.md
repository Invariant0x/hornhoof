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
ui/kit/*.png|*.webp                                                       optional
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

A kit is pictures of interface parts (frames, panels, buttons with their states, fields, chips, counters, rows, dividers) that replace the look of each part without moving it, as the theme UI kit 1.0 (`THEME-UI-KIT.md`) describes them. Hornhoof does not draw kits from an archive yet: that comes with the step that puts a kit on the page (`applyKit` and `kit.css`). An archive may already carry its kit. Hornhoof checks it, stores it and serves it, and a theme with a kit looks like the same theme without one until kits are drawn.

A kit's pack folder goes into the archive as it is, but for two files: its `kit.json` is `ui/kit.json`, and its `LICENSE.md` stands at the archive's root as the theme's licence (section 7). Its pictures are in `ui/kit/`.

```json
{
  "pack": "night-shift",
  "licence": "LICENSE.md",
  "slots": {
    "dialog": { "file": "dialog.face@2x.webp", "slice": "63 62 56 62 fill", "width": "31.5px 31px 28px 31px", "outset": "12.9px 11.2px 11.2px 11.2px", "repeat": "round" },
    "btn": { "file": "btn@2x.webp", "slice": "18 fill", "width": "9px" },
    "panel": { "file": "panel.fill@2x.webp", "size": "96px 96px" },
    "tab-on": { "file": "tab-on@2x.webp", "size": "calc(100% - 20px) 5px" }
  },
  "colors": { "tab-ink": "#502704", "danger-ink": "#6A1030" }
}
```

* A slot's name is one of the 45 parts of the theme UI kit 1.0, section 4.2, as `THEME_KIT_SLOTS` in `packages/protocol/src/themes.ts` lists them, each at most once:
  * frames and faces of big surfaces: `dialog`, `window`, `drawer`, `menu`, `card`, `table`, `plaque-frame`, `tile`;
  * fills, tiled: `ground`, `panel`, `dialog-fill`, `plaque`, `band`;
  * controls, a plate for each state: `btn`, `btn-hover`, `btn-pressed`, `btn-disabled`, `ghost`, `ghost-hover`, `ghost-pressed`, `ghost-disabled`, `danger`, `danger-hover`, `chip`, `chip-on`, `field`, `field-focus`, `iconbtn`, `iconbtn-hover`, `iconbtn-pressed`;
  * small parts: `counter`, `badge`, `check`, `corner`, `tab-on`, `tab`, `tab-sel`, `pill-ok`, `pill-bad`;
  * strips: `thead`, `row-hover`, `row-selected`, `track`, `fill`, `divider`.

  A kit names at least one of them and paints only the ones it names.
* Each value has the form of the kit's section 6.2, the same forms the kit's `kitcheck.py` and the screens take (`THEME_KIT_VALUES`), with single spaces between its parts and at most 120 characters:

  | Key | Accepted |
  |---|---|
  | `file` | a picture in `ui/kit/`: lowercase letters, digits, `.`, `@` and `-`, ending in `.webp` or `.png`; WebP or PNG by its bytes, up to 2 MB |
  | `slice` | 1 to 4 numbers, each optionally with `%`, then optionally ` fill`: `36`, `0 24 fill`, `63 62 56 62 fill` |
  | `width` | 1 to 4 of: a number with `px` or `%`, a plain number, `auto`: `9px`, `0 12px`, `31.5px 31px 28px 31px` |
  | `outset` | 1 to 4 numbers, each optionally with `px`: `1.5px`, `12.9px 11.2px 11.2px 11.2px` |
  | `repeat` | one or two of `stretch`, `repeat`, `round`, `space` |
  | `size` | one or two of: a number with `px` or `%`, `auto`, `calc(100% - Npx)`: `96px 96px`, `100% 100%`, `calc(100% - 20px) 5px` |

* `pack` and `licence` are text for people, up to 80 characters each; Hornhoof keeps them and reads neither.
* A kit colour is `#RRGGBB`, under one of the 8 names the screens read (`THEME_KIT_COLORS`): `tab-ink`, `tab-on-ink`, `chip-on-ink`, `danger-ink`, `danger-on-ink` (the light label on the danger plates), `badge-ink`, `scroll-thumb`, `scroll-track`.

Anything else is refused, with the value's place and the form it should have: a slot, colour or key the kit does not have, a value of another form, a picture no slot names, or a slot whose picture is not there. So a kit can never carry CSS, a script or a link. A vector picture (`.svg`, `.svgz`) is refused in the kit as anywhere else (section 9). The rules the kit's guide gives for the pictures themselves (a state of the same size and slice as its normal picture, a slice that leaves a middle, the 1.5 MB budget of a pack) are for its author and `kitcheck.py`; Hornhoof holds a kit to its forms and to the limits of section 8.

The screens get the kit as stored from `GET /api/themes/:id/look`, beside `base`: a slot's picture is served at `base` + `ui/kit/` + its `file`.

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

Hornhoof runs the same art check as `world-art-index.ts` on it and writes `art-index.json` itself. An `art-index.json` in the archive is ignored. A file the check rejects refuses the archive, with the check's own words.

**A world comes with all its own art, or the theme is its interface alone.** A person never gets a world the engine fills with its placeholders. So a world is kept only when its art catalog (`art` in `world.json`) has pictures for every kind of building the city grows (`residence`, `monument`, `department`, `district_hub`, `supply`, `house`, `statue`, `flophouse`) and for its residents, and the archive holds every picture the catalog marks as required. A theme whose world falls short is still installed: as its interface alone, without its world, its art or its voice and era names (section 5), and the company keeps the schematic map. Its card in the store says so (`worldLeftOut: "art_missing"` in `GET /api/themes`). The world is still checked whole, so a world that is wrong, not only short of art, refuses the archive.

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

Plain UTF-8 text, up to 64 KB, required. It covers everything in the archive. A theme's art may be under a licence other than Hornhoof's MIT, and may forbid commercial use; that is the author's choice, and the store shows `license` from `theme.json` beside the theme. Hornhoof keeps the file word for word with the theme and serves it to the company at the card's `licenseFile` (`GET /api/themes`), so whoever installs or uses the theme can read it.

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
| A string in a JSON file | 1 000 characters, one line |
| A world's map | 512 tiles a side, in chunks of 2 to 64 tiles, at most 128 chunks a side; zoom 0.25 to 4; a tile picture at most 1024 px wide; any number at most 10 000 |
| A picture | PNG or WebP, up to 8192 px a side and 50 million pixels |
| A picture of the kit | PNG or WebP, up to 2 MB |
| A font | WOFF2, up to 2 MB, at most 24 |

## 9. What refuses an archive

Each of these refuses the whole archive. The store names the reason and the file:
* A zip that is not a plain zip: encrypted, split, ZIP64, or packed in a way other than stored or deflate.
* A path that leaves the archive or hides what it is: an absolute path, `..`, a backslash, a drive letter, an empty part, a control character, a link, or two names that differ only in upper and lower case.
* A file of a kind the archive has no place for, in particular any script, style sheet or page (`.js`, `.mjs`, `.css`, `.html`, `.svg` and the like), wherever it stands, or a file whose bytes are not what its name says.
* A file over its limit, or one that unpacks to more than its header says.
* JSON that is not of the shape this document gives, a key no part knows, or a value that reads as code (3.1).
* Text a person cannot see whole: a control or format character, an invisible or private one, a variation selector, a line or paragraph separator. A text file (`LICENSE`, `ui/NOTES.md`, a font's licence) keeps its tabs and line breaks; a string in a JSON file is one line.
* A link to anything outside the archive, in any string of a JSON file. A text file may name an address, as a licence does: it is served as plain text only, and nothing opens it.
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

Without `--art` a world has no pictures, so the theme installs as its interface alone (4.2). Packing writes no dates, so the same theme from the same commit always gives the same archive.

The Egypt art never goes into this repository (#105). Its archive is built where the art is and installed on the server by upload, as any theme is.
