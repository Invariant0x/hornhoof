# Hornhoof themes

**Version 1.0, approved by the head of Design on 2026-11-07.** Built from the facts of the code (#655) and proved by a swap to another theme (#656). Only the head of Design approves a change; the version grows as in style book section 8.

The CEO decided that the look of Hornhoof changes by theme. Today's theme is Cyberpunk. Others will follow, for example Matrix. This one file holds everything about themes: what a theme is, the sheet every theme fills in, the current theme, an example, the checks, and what stands in the way today.

**Base of the facts.**

| What | Source | State |
|---|---|---|
| Colours, type, shape, motion, TSX, SVG, terminal, how the mode is stored | Code at `a354cc276d6f92792e4e602627d7300dfc04f251`, branch `turn-8`, read in #655 | Read, not run. By the orchestrator, the top of the branch differs only in 2 test files |
| Screens | 6 screens of inventory #469 at `5c67fb00`, 41 snapshots of #591 at `a60131fb` | Chromium only. Older than the code above |
| Swap proof | Matrix on the prototype of the etalon, #656 | Panels only, Chromium only. See section 5 |
| What stays the same in every theme | `hornhoof-style-book.md`, version 1.2 | Read with this file |

Marks as in the style book: **RULE**, **PROPOSAL**, **GAP**, **NOT_AVAILABLE**. Everything else is a fact read from the sources above.

## 1. Words

| Word | Meaning | Examples |
|---|---|---|
| Theme | The whole look, one sheet in this file | Cyberpunk, Matrix |
| Mode | Light or dark inside a theme | Light, dark |
| Role | A named job of a value, independent of its colour | Accent, danger, surface |

**GAP.** In the code, `data-theme` means the mode, so the word "theme" means two things. Do not use it for a mode in new work.

## 2. What a theme may change

**RULE.** A theme changes the look and nothing else. Two people on different themes see the same screens, the same words, the same order and the same behaviour.

| A theme may change | A theme may not change |
|---|---|
| Values of every colour role | What a role means: danger stays alarming, success stays calm, a status always carries its word |
| Fonts | Sizes of controls: 44 px buttons, gaps, panel widths (style book sections 3 and 6) |
| Corner cuts and radii | Wrapping, order of buttons, the end edge (style book section 6) |
| Grid, halo, glass, corner mark | Labels, languages and their rules (style book section 5) |
| Speed and kind of motion | Respect for reduced motion, visible focus |
| Palette of the terminal | How the terminal fits its window (#335) |
| Colours of the mark | Shape of the mark (style book section 7) |
| An extra decor layer | Readability: decor never runs behind text a person is reading |

**RULE.** Provider marks (`--p-*`) stay recognisable. A theme may change their lightness for contrast, not their hue.

**RULE, for all new work from today.** A mockup or a screen uses roles only. No literal colour, font or cut, and nothing that works only because of today's theme: a theme with another font, no cut corners and no light mode must still work.

**RULE.** Fonts of other writing systems come through `unicode-range`. No block overrides `--f-*` for itself.

**RULE, an extra decor layer.**

1. It lives only on the background of the map, under the grid, lines and frames. Never under a panel, card, dialog, table, terminal or glass.
2. With the layer at its brightest, map lines keep 3:1 and text on glass keeps 4.5:1.
3. Under reduced motion it is off and hidden. It does not slow down, and it leaves no frozen picture.
4. It uses nothing while the tab is hidden or a window covers the map (#335, #411).
5. It is hidden from screen readers and takes no clicks, wheel or focus.
6. It draws open technical characters only, in the theme's mono font.
7. A person can turn it off without changing the theme.

## 3. The theme sheet

Every theme is one filled-in sheet in this format. A slot left empty fails the checks of section 6, and `hornhoof-theme-check.py` proves it. Colour values use `#RRGGBB` or `rgba()`.

| Slot | Meaning | Today in the code |
|---|---|---|
| `id` | Lower-case Latin, never shown to people | Nothing yet |
| `name` | Shown to people, in every shipped language | Nothing yet |
| `version`, `status`, `owner` | `status`: `draft`, `active` or `retired` | Nothing yet |
| `character` | Three to five plain words: how it should feel | Nothing yet |
| `modes` | `light`, `dark` or both. A theme with one mode hides the mode choice | Both |
| `default_mode` | `system`, `light` or `dark` | `system` |
| `colors.<mode>.*` | One value per role, see the table below | `:root` of `theme.css` |
| `fonts.*` | Family stack, faces, licence, writing systems | `--f-*`, `main.tsx` |
| `shape.*` | Corner cuts by step, where the cut stands, corner mark, radius of fields, other radii | `--cut` set on each element, and inline by `Edge` |
| `decor.*` | Grid, halo, glass, map art, extra layer: `kind` is `none` or a supported layer, with its roles, opacity, speed and frame limit | Rules in `theme.css` |
| `motion.*` | Each moving thing: `time` and `kind` | `@keyframes` in `theme.css` |
| `terminal.all_modes.*` | Background, text, cursor, selection, loading mark, 16 colours, font. `terminal.<mode>.*` instead, if the modes differ | Raw values, see section 8 |
| `mark.*` | Roles of the mark and its file, values of the favicon | `.mk-*`, `logo.svg`, favicon |

Colour roles:

| Role | Token today | Job |
|---|---|---|
| `bg` | `--bg` | Page and map background |
| `surface` | `--surface` | Panels, cards, tables |
| `surface2` | `--surface2` | Controls, `.alert`, row hover |
| `line` | `--line` | Quiet lines |
| `line2` | `--line2` | Control borders, map lines |
| `ink` | `--ink` | Main text |
| `muted` | `--muted` | Secondary text |
| `accent` | `--cyan` | Fills, lines, active borders. Not small text |
| `accent_ink` | `--cyan-ink` | Accent as text, links, focus ring, native controls |
| `warning` | `--amber` | Warning fill and line |
| `warning_ink` | `--amber-ink` | Warning text |
| `attention` | `--pink` | Attention fill and line |
| `attention_ink` | `--pink-ink` | Error and danger text |
| `success` | `--ok` | Success text and line |
| `danger` | `--red` | Alarm fill, line and text |
| `on_danger` | `--on-red` | Text on `danger` |
| `idle` | `--idle` | Empty track, spinner ring |
| `dot` | `--dot` | Dots of the map grid |
| `glow` | `--glow` | Focus halo, chosen background |
| `button` | `--btn` | Fill of the primary button |
| `on_button` | `--on-btn` | Text on `button` |
| `hud` | `--hud` | See-through layer over the map |
| `shadow` | `--shadow` | Shadow of menus and windows |
| `provider_claude`, `provider_kimi`, `provider_glm`, `provider_antigravity` | `--p-*` | Provider marks |
| `on_attention` | None, `#fff` in `.nav-count` | Text on `attention`. **PROPOSAL**, new role |
| `scrim` | None, raw in `.dialog-back` | Layer behind a dialog. **PROPOSAL**, new role |
| `scrollbar_thumb`, `scrollbar_track` | None, browser default | `scrollbar-color`. **PROPOSAL**, new roles |
| `color_scheme` | `color-scheme` | `light` or `dark`, tells the browser how to draw native parts |

## 4. Cyberpunk, the current theme

**Character, written now by the head of Design:** a night control room, neon on near black, machine-cut corners, technical lettering, quiet motion.

```yaml
id: cyberpunk
name: { en: Cyberpunk, ru: Киберпанк }
version: 1.0
status: active
owner: Head of Design
character: [night control room, neon on near black, machine-cut corners, technical lettering, quiet motion]
modes: [light, dark]
default_mode: system   # GAP: after a person chooses, there is no way back to system
colors:
  light:
    bg: '#E6EBF0'
    surface: '#F8FAFC'
    surface2: '#EEF2F6'
    line: '#C9D3DD'
    line2: '#A9B7C5'
    ink: '#0F1B27'
    muted: '#4C5A68'
    accent: '#00A3BD'
    accent_ink: '#00768A'
    warning: '#E08A00'
    warning_ink: '#9A5A00'
    attention: '#E0307F'
    attention_ink: '#B0185F'
    success: '#1E8E4E'
    danger: '#D32F2F'
    on_danger: '#FFFFFF'
    idle: '#C5D0DB'
    dot: 'rgba(30, 60, 90, .17)'
    glow: 'rgba(0, 163, 189, .10)'
    button: '#00768A'
    on_button: '#FFFFFF'
    hud: 'rgba(240, 244, 247, .88)'
    shadow: 'rgba(20, 40, 60, .18)'
    provider_claude: '#C2593A'
    provider_kimi: '#1667E0'
    provider_glm: '#3D47D6'
    provider_antigravity: '#1E8E3E'
    on_attention: '#FFFFFF'   # GAP: 4.29:1 on attention in light
    scrim: 'rgba(10, 20, 30, .35)'
    scrollbar_thumb: '#A9B7C5'   # PROPOSAL: the value of line2, not in the code
    scrollbar_track: '#F8FAFC'   # PROPOSAL: the value of surface, not in the code
    color_scheme: 'light'
  dark:
    bg: '#141A22'
    surface: '#1B232D'
    surface2: '#212B37'
    line: '#2C3845'
    line2: '#3D4C5C'
    ink: '#E3EAF1'
    muted: '#93A0AE'
    accent: '#46E0EF'
    accent_ink: '#6FE9F5'
    warning: '#FFB54A'
    warning_ink: '#FFC36E'
    attention: '#FF62AA'
    attention_ink: '#FF8CC2'
    success: '#5FD08A'
    danger: '#FF6B6B'
    on_danger: '#2A0606'
    idle: '#2C3744'
    dot: 'rgba(140, 175, 205, .15)'
    glow: 'rgba(70, 224, 239, .10)'
    button: '#46E0EF'
    on_button: '#05222A'
    hud: 'rgba(23, 30, 39, .84)'
    shadow: 'rgba(0, 0, 0, .45)'
    provider_claude: '#F08A66'
    provider_kimi: '#5E9BFF'
    provider_glm: '#8D95FF'
    provider_antigravity: '#6DD58C'
    on_attention: '#FFFFFF'   # GAP: 2.77:1 on attention in dark
    scrim: 'rgba(10, 20, 30, .35)'
    scrollbar_thumb: '#3D4C5C'   # PROPOSAL: the value of line2, not in the code
    scrollbar_track: '#1B232D'   # PROPOSAL: the value of surface, not in the code
    color_scheme: 'dark'
fonts:
  display: { stack: "'Tektur', 'Onest', system-ui, sans-serif", faces: [500, 600], package: '@fontsource/tektur 5.3.0', license: OFL-1.1, scripts: [Cyrillic, Greek, Latin, Vietnamese] }
  body: { stack: "'Onest', system-ui, -apple-system, 'Segoe UI', sans-serif", faces: [400, 500, 600], package: '@fontsource/onest 5.3.1', license: OFL-1.1, scripts: [Cyrillic, Latin, Vietnamese] }
  mono: { stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", faces: system, package: none, license: none, scripts: system }
shape:
  cut: { compact_button: 5px, button: 7px, secondary_button: 0px, chip: 8px, frame: 10px, panel: 12px, window: 14px }
  cut_where: top right and bottom left
  corner_mark: { size: 22px, width: 2px, color: accent, where: top left of a department frame }
  control_radius: 0px   # GAP: not set on textarea
  radii: { dots_and_rings: 50%, small: [4px, 6px, 10px] }
decor:
  grid: { kind: dots, step: 22px, dot: 1px, color: dot }
  halo: { kind: radial, color: glow }
  glass: { color: hud, blur: 10px }
  map_hub: { ring: dashed line2, ring_active: accent, turn: 60s, gauge_steps: 24 }
  map_lines: { work: accent, return: warning }
  extra_layer: { kind: none }
motion:
  spinner: { time: 0.9s, kind: spin }
  hub_ring: { time: 60s, kind: spin }
  thinking_mark: { time: 2.4s, kind: spin }
  live_dot: { time: 1.6s, kind: blink }
  working_cell: { time: 2.2s, kind: blink }
  review_cell: { time: 3.2s, kind: breathe }
  new_line: { time: 0.45s, kind: rise }
  busy_department: { time: 2.6s, kind: glow and breathe }
  flash_department: { time: 1.4s, kind: flash }
  map_line: { time: 0.9s, kind: run }
  update_bar: { time: 0.7s, kind: flow }
  open_department: { time: 0.25s, kind: enter }
  reduced_motion: all off   # GAP: the running dot on map lines only slows to a quarter
terminal:
  # Raw values today, one set for both modes. Dark on any page, because the agent programs run their dark theme.
  all_modes:
    bg: '#15191F'
    ink: '#DCDCDC'
    cursor: '#FFFFFF'
    cursor_accent: '#000000'
    selection: '#B3D7FF'
    selection_ink: '#000000'
    idle: '#2B323B'
    scheme: dark
    colors: { black: '#14191E', red: '#B43C2A', green: '#00C200', yellow: '#C7C400', blue: '#2744C7', magenta: '#C040BE', cyan: '#00C5C7', white: '#C7C7C7' }
    bright: { black: '#686868', red: '#DD7975', green: '#58E790', yellow: '#ECE100', blue: '#A7ABF2', magenta: '#E17EE1', cyan: '#60FDFF', white: '#FFFFFF' }
    font: { stack: 'Monaco, Menlo, "DejaVu Sans Mono", monospace', size: 12px }
mark:
  shape: fixed by the brand
  dome: accent
  base: ink
  dot: ink
  logo_dome: accent   # GAP: the file keeps #00A3BD
  favicon: { dome: '#00A3BD', base: '#0F1B27' }
```

## 5. Matrix, the example

**Not a choice of look.** This sheet exists to prove that the format is enough. It is not the real theme: that waits for a decision by the CEO.

**RULE.** The general look only. No film stills, logos, character names, quotes or mirrored film glyphs. The name people see is decided before release; `matrix` is a working id.

What the proof showed, on the prototype of the etalon, `#656`:

| Asked | Result |
|---|---|
| Can panels change by values alone? | Yes, for colours and fonts: one block of values, 0 changed lines of the prototype. Cuts are the exception: `--cut: 0` on the root does nothing, so 6 forced rules were needed (T7) |
| Does the wrap rule hold with another font? | Yes. 140 configurations, 33 152 buttons, RU and EN, modes and pseudo text: 0 wrap, width or group errors. The head of Design ran it again with the font rule corrected (T14): 0 errors |
| Can roles be told apart when everything is green? | Only if they leave green. Accent stays pure green, success moves to jade, warning to amber, attention to pink, danger to red. Same green for accent and success reads as one role |
| Contrast | 30 of 30 text pairs from 5.42:1, recomputed by the head of Design. Control lines from 3.4:1, better than Cyberpunk |
| No cut corners | Works. Buttons keep their height, padding and contrast |
| Focus | Seen on all 6 kinds of button, 14.69:1 |
| Dark only | Works only if the same values fill all token blocks, and the mode switch stays on screen (T1) |
| Monospaced Russian | Fits: the long label is as wide as in Onest. Long Latin and addresses are 12% wider and wrap inside the panel |
| Font | `@fontsource/jetbrains-mono` 5.3.0, OFL-1.1. Latin and Cyrillic, 3 faces: 80 928 bytes |

Not proved, because the prototype does not draw them: map, `.chip`, ticker, tree view, live terminal, layer behind a dialog, `.nav-count`, login card, inline cuts of `Edge`. Firefox and WebKit: NOT_AVAILABLE. Pictures: `compare-*.png` on #656.

```yaml
id: matrix
name: { en: TBD, ru: TBD }
version: 0.2
status: draft
owner: Head of Design
character: [phosphor terminal room, green on black, square frames, monospaced lettering, calm steady pulse]
modes: [dark]
default_mode: dark
colors:
  dark:
    bg: '#050A06'
    surface: '#0A130D'
    surface2: '#101D14'
    line: '#1E3525'
    line2: '#4A7856'
    ink: '#D4F7DC'
    muted: '#84B390'
    accent: '#00E05A'
    accent_ink: '#66FF99'
    warning: '#E5B82E'
    warning_ink: '#F5CD56'
    attention: '#F25C9A'
    attention_ink: '#FF8AB8'
    success: '#42DEC2'
    danger: '#FF5247'
    on_danger: '#260402'
    idle: '#1B3021'
    dot: 'rgba(82, 224, 128, .16)'
    glow: 'rgba(0, 224, 90, .14)'
    button: '#00E05A'
    on_button: '#021C0B'
    hud: 'rgba(8, 16, 11, .88)'
    shadow: 'rgba(0, 0, 0, .62)'
    provider_claude: '#F08A66'
    provider_kimi: '#639EFF'
    provider_glm: '#8F97FF'
    provider_antigravity: '#6EE08E'
    on_attention: '#24030A'
    scrim: 'rgba(2, 6, 3, .64)'
    scrollbar_thumb: '#4A7856'
    scrollbar_track: '#0A130D'
    color_scheme: 'dark'
fonts:
  display: { stack: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace", faces: [500, 600], package: '@fontsource/jetbrains-mono 5.3.0', license: OFL-1.1, scripts: [Cyrillic, Greek, Latin, Vietnamese] }
  body: { stack: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace", faces: [400, 500, 600], package: '@fontsource/jetbrains-mono 5.3.0', license: OFL-1.1, scripts: [Cyrillic, Greek, Latin, Vietnamese] }
  mono: { stack: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace", faces: [400, 500], package: '@fontsource/jetbrains-mono 5.3.0', license: OFL-1.1, scripts: [Cyrillic, Greek, Latin, Vietnamese] }
shape:
  cut: { compact_button: 0px, button: 0px, secondary_button: 0px, chip: 0px, frame: 0px, panel: 0px, window: 0px }
  cut_where: none
  corner_mark: { size: 18px, width: 2px, color: accent, where: top left of a department frame }
  control_radius: 0px
  radii: { dots_and_rings: 50%, small: [0px, 2px, 4px] }
decor:
  grid: { kind: dots, step: 20px, dot: 1px, color: dot }
  halo: { kind: radial, color: glow }
  glass: { color: hud, blur: 8px }
  map_hub: { ring: dashed line2, ring_active: accent, turn: 60s, gauge_steps: 24 }
  map_lines: { work: accent, return: warning }
  # Falling code would be: { kind: code_rain, where: map background, glyphs: open technical, head: accent_ink, trail: accent, max_opacity: 0.14, column_step: 20px, speed: 36px/s, frames: 20/s }. Not drawn, not checked. Rules in section 2.
  extra_layer: { kind: none }
motion:
  spinner: { time: 0.9s, kind: spin }
  hub_ring: { time: 60s, kind: spin }
  thinking_mark: { time: 2.4s, kind: spin }
  live_dot: { time: 1.4s, kind: blink }
  working_cell: { time: 2.0s, kind: blink }
  review_cell: { time: 3.0s, kind: breathe }
  new_line: { time: 0.35s, kind: rise }
  busy_department: { time: 2.6s, kind: glow and breathe }
  flash_department: { time: 1.2s, kind: flash }
  map_line: { time: 0.9s, kind: run }
  update_bar: { time: 0.7s, kind: flow }
  open_department: { time: 0.20s, kind: enter }
  reduced_motion: all off
terminal:
  all_modes:
    bg: '#040805'
    ink: '#C8F5D2'
    cursor: '#00E05A'
    cursor_accent: '#021C0B'
    selection: '#66FF99'
    selection_ink: '#021C0B'
    idle: '#1B3021'
    scheme: dark
    colors: { black: '#0A140D', red: '#FF6B61', green: '#00E05A', yellow: '#E5B82E', blue: '#5E9BFF', magenta: '#F25C9A', cyan: '#42DEC2', white: '#C8F5D2' }
    bright: { black: '#7AA886', red: '#FF8D85', green: '#66FF99', yellow: '#F5CD56', blue: '#8AB8FF', magenta: '#FF8AB8', cyan: '#7AF2DC', white: '#EAFFF0' }
    font: { stack: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace", size: 12px }
mark:
  shape: fixed by the brand
  dome: accent
  base: ink
  dot: ink
  logo_dome: accent
  favicon: { dome: '#00E05A', base: '#021C0B' }
```

## 6. How to add a theme

1. Fill in the whole sheet, then run `hornhoof-theme-check.py`. Any empty slot or failing pair stops here.
2. Build it as values only: no new selectors for layout and no change to a component.
3. Pass the checks below.
4. The head of Design approves it. A theme people will see goes to the CEO first: same data, same frame, only the theme differs (notebook note 6).

| Check | Limit |
|---|---|
| Body text on `bg`, `surface`, `surface2` | From 4.5:1 for `ink` and `muted`. Each coloured text role has its table, as in style book section 1 |
| Controls and large text | From 3:1 |
| Fixed pairs: `on_button` on `button`, `on_danger` on `danger`, `on_attention` on `attention`, text on `hud` | From 4.5:1 |
| Focus ring in `accent_ink` on `surface` and `bg` | From 3:1, seen on a picture, including a button with a cut |
| `accent`, `success`, `warning`, `attention`, `danger` | Told apart side by side on a picture of every `.status` and `.alert`. The word is always there |
| Fonts | Cover Latin and Cyrillic in every face used. Licence allows shipping. Download weight measured |
| Section 6 of the style book | The wrap check gives 0 errors on the longest and shortest shipped languages, because a new font changes every width |
| Native parts | `textarea` and its hint, checkbox, radio, `select`, scrollbar: none shows a browser default colour |
| Words | No label names a colour or a shape of a theme |
| Terminal | The 15 text colours from 4.5:1 on its `bg`. `colors.black` is for dark text on bright plates: from 4.5:1 on green, yellow, cyan and white |
| Motion and decor | Off under reduced motion, including what moves from code. Never behind text. No change to terminal fit (#335) or load (#411) |
| Every mode the sheet declares | Pictures at 375 and 1440, RU and EN, in Chromium, Firefox and WebKit (#527) |
| Switching | The same elements and words before and after. No flash of another theme on first paint |
| The checks themselves | A check reads roles and the sheet, never a value of one theme: a font name or a hex in a test fails on the next theme |

## 7. Check: does the product match Cyberpunk?

Looked at by the head of Design: map, login, terminal window, department panel, machine card (#469), all panels of #591. Those pictures are older than the code. Not looked at: the other states of the 104 in inventory #469 and the materials of a question. A full check by element is with the Codex designer.

| Code | Verdict | What | Evidence |
|---|---|---|---|
| CP1 | Matches | Dark mode as a whole: neon accent on near black, cut corners, Tektur, dot grid, dial of the map, corner mark, glass | `map.context-full-en-dark-1440`, `auth.login-draft-en-dark-1440`, `department.about-full-en-dark-1440` |
| CP2 | Weak, decide | Light mode keeps the shape and the lettering and loses the neon: teal on pale grey reads as clean technology, not as a night control room | `map.context-full-en-light-1440`, `machines.card-full-en-light-1440` |
| CP3 | Partly fixed | Notebook field. On the pictures it shows browser defaults: frame `#767676`, fill `#FFFFFF` in light; frame `#858585`, grey fill `#3B3B3B` in dark, off the blue-black palette, with round corners. The code now sets frame, fill and padding. It still sets no hint colour and no corner radius | `after-notebook-*`, `theme.css:743` |
| CP4 | Deviation | Checkbox of the machine card is browser blue: `#0075FF` in light, `#99C8FF` in dark, because `.lend input` has no `accent-color`. Elsewhere `accent-color` mixes `--cyan-ink` (5 rules) and `--cyan` (4 rules) | `after-machine-confirm-*`, measured; `screens/Machines.tsx:194`, `theme.css:173`, `187`, `202`, `595`, `868`, `872`, `983`, `1001`, `1030` |
| CP5 | Deviation | The mark outside the page: `logo.svg` keeps its dome at `#00A3BD`, while `--cyan` is `#46E0EF` in dark. The favicon has fixed colours, one set for both modes | `.github/assets/logo.svg`, `apps/web/index.html:8` |
| CP6 | Accepted | The second neon, pink, shows only for attention and danger, so the cyan and magenta pair is rarely seen. Meaning is worth more than the look | In `theme.css`: `--pink` 22 uses, `--cyan` 110 |
| CP7 | Accepted | Glow is very quiet, 10% alpha. Good for reading all day | `--glow` |
| CP8 | Watch | A disabled primary button in dark turns muddy teal at opacity .45, on the first screen a person sees | `auth.login-draft-en-dark-1440` |
| CP9 | Accepted | Terminal stays dark in light mode, as a terminal should | `agent.window-terminal-en-light-1440` |
| CP10 | NOT_AVAILABLE | Scrollbars: the snapshots show none in headless Chromium. `xterm.css`: not in the code snapshot | |
| CP11 | Accepted, CEO may decide | Terminal colours under 4.5:1 on its background: red 3.04, blue 2.30, magenta 3.96, bright black 3.16. The code says the palette repeats the CEO's own terminal profile, so it stays until the CEO says otherwise. A new theme may not copy this | `ui/AgentTerminal.tsx:13`, `15` |

## 8. Check: can the theme be changed?

**Answer: not yet, but the base is good, and the proof confirms it.** Colours and fonts of the page are already held in one place: `theme.css` has 1015 uses of `var()` and only 7 raw colours, TSX has no token names and no colours in its 38 inline styles, and font families are named only in two tokens. On the prototype, values alone repaint every panel and the wrap rule holds. What is missing is the notion of a theme itself, and the terminal, the corner cuts and the loading of fonts.

| Code | What stands in the way | Evidence | What is needed |
|---|---|---|---|
| T1 | No theme exists. `data-theme` is the mode, only `light` or `dark`, with dark values written twice. A theme with one mode falls into Cyberpunk light on `light`, or keeps a switch that does nothing | `theme.ts:9`, `theme.css:15` to `38`, `compare-light-mode-ru-1440.png` on #656 | A theme and a mode as two separate choices, each theme one set of values. The mode switch hides when a theme has one mode |
| T2 | The choice lives only in one browser (`localStorage`, `hh-theme`), there is no way back to system, and nothing runs before first paint, so a flash of the wrong mode is possible by the code. Not measured | `theme.ts:3`, `theme.ts:21`, `apps/web/index.html:12` | Stored for the person, applied before first paint |
| T3 | Interface words: «Тема» and `Theme` mean the mode | `i18n/ru.ts:169`, `i18n/en.ts:133` | Rename when themes ship: mode for light and dark, theme for the style |
| T4 | Tokens carry colour names, so in Matrix `--cyan` would be green | In `theme.css`: `--cyan` 110, `--cyan-ink` 70, `--amber` 40, `--amber-ink` 22, `--pink` 22, `--pink-ink` 17, in all 281 uses. In TS and TSX: 0 | Role names of section 3. Only `theme.css` changes. CSS class tones and code comments follow later |
| T5 | Terminal colours are raw in code: 22 of the 35 raw colours in the product. Its font is outside the tokens | `ui/AgentTerminal.tsx:15`, `18`, `21` | `terminal.*` of the sheet |
| T6 | 7 raw colours in `theme.css` | `.dialog-back` `272`, `.t-term` `688`, `.t-load` `695` twice, `.t-load .spinner` `696` twice, `.nav-count` `1036` | `scrim`, `terminal.*`, `on_attention` |
| T7 | Corner cuts cannot be changed in one place. There are 6 values. `--cut` stands on each element, and `Edge` writes it inline in 23 places, so `--cut: 0` on a parent does nothing. The polygon itself allows 0 | `ui/Edge.tsx:8`, `theme.css:61`, `72`, `709`, `1300`, `1381`, `1593` | Tokens for the steps of `shape.cut`, set once for the theme. Components and `Edge` name a step, not pixels |
| T8 | Fonts are imported once, for everyone | `main.tsx:1` to `5` | Load only the fonts of the chosen theme, without a flash |
| T9 | Widths tied to a font: a badge is `length * 6.7` for Onest at 11.5 px; map and department cards have fixed sizes with an ellipsis; 21 rules in `--f-display` fix one line, a height or letter spacing. Measured in #656: a badge in JetBrains Mono takes 161 px of its 154.1 px in Russian, 133 of 127.3 in English. Map and tree were not drawn | `screens/TreeView.tsx:74`, `screens/Map.tsx:26`, `map-people.ts:4`, `screens/schema.ts:7` | Measure the text, not the font. The wrap check on each theme |
| T10 | Words name a colour of today's theme: "The amber line", «Желтая линия» | `i18n/en.ts:847`, `i18n/ru.ts:878` | Name what it means, not its colour |
| T11 | Mark files are fixed | `logo.svg`, favicon `apps/web/index.html:8` | Colours from the theme, or a decision that they stay |
| T12 | Native parts follow the browser where nothing is set | CP3, CP4 | Set by the theme, style book section 9. A native checkbox keeps the browser's small radius, also in a theme without cuts: accepted for now, redrawing it is its own work |
| T13 | The running dot on map lines only slows under reduced motion, while everything else stops | `ui/wires.tsx:44`. CSS: `theme.css:150`. `theme.css:697` tries to slow a spinner that the rule at line 150 stops | Decide one behaviour |
| T14 | Checks tied to today's theme. The wrap check of the etalon names Tektur, so on another font it gives 34 930 false errors. One product test compares an exact colour | `panel-wrap-standard-final-check.js:159`, `apps/web/e2e/agent-state.spec.ts:84` | Read the token, not a value |

Not leaks, checked: the white in `ui/MessagePictures.tsx:43` is a background under a picture before it is compressed; black and white in `ui/PeopleWires.tsx:17`, `18` are an SVG mask. Neither reaches the screen as a colour. `theme-leaks.py` on #655 finds new raw values on any commit, but not colours built while running or inside packages.

**Open decisions, with my recommendation:**

| Decision | Recommendation | Who |
|---|---|---|
| Light mode of Cyberpunk (CP2) | Keep it as the day version. It is the cheapest and reads well | CEO |
| Who picks the theme: each person, or the company | Company default, each person may change it. Keep the choice for the person, not in one browser | CEO |
| Cost of T1 to T14 on real screens | Development estimates after this file is approved | Development |

**Order of work, recommended.** Cheapest first, none of it changes how today's theme looks:

1. Raw colours into roles: T6, T5. Words: T10. Native parts: T12. Checks: T14.
2. Role names beside the old names: T4. Cuts by step: T7. Widths from the text: T9.
3. The theme itself: T1, T2, T3, T8, T11. Only this step shows a person anything new.

Then one real theme can be built: the sheet, the checks of section 6, and the screens the proof did not cover.
