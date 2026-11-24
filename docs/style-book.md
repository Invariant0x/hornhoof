# Hornhoof style book

**Version 1.4, approved by the head of Design on 2026-11-16.** The head of Design owns this book (section 8).

**Base.** `apps/web/src/theme.css` at commit `a354cc276d6f92792e4e602627d7300dfc04f251`, SHA256 `6efe8ccd9c9d420114e212c0cbf6c99d4a1ac97771b8ceebb00c1f8549a412ec`. Colours, type, sizes, components, fonts and languages were read at that commit. Counts of sizes and weights in sections 2 and 3 were taken at `2fed0c54` and not recounted.

**Themes.** The look of Hornhoof changes by theme. This book holds what stays the same in every theme. The token values below are those of the current theme, Cyberpunk. What a theme may change, the sheet of each theme and the checks are in `hornhoof-themes.md`: read it together with this book.

**How to read it.** Everything is a fact read from the code unless it carries one of these marks:

- **RULE**: mandatory for new work.
- **PROPOSAL**: not in the code and not decided. It counts only after the head approves it.
- **GAP**: the code today does not meet a rule. Listed so nobody copies it.
- **NOT_AVAILABLE**: no source exists, so nothing is claimed.

## 1. Colours

All colours are tokens in `:root` of `theme.css`. Light is the default. Dark applies with `data-theme="dark"`, or when the system asks for dark and no mode was chosen. In the code `data-theme` and the word "theme" mean the mode, light or dark, which is not what this book calls a theme.

**RULE.** New work uses tokens by their meaning, and text uses a token whose contrast below passes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#E6EBF0` | `#141A22` | Page and map background |
| `--surface` | `#F8FAFC` | `#1B232D` | Panels, cards, tables |
| `--surface2` | `#EEF2F6` | `#212B37` | Controls: `.act`, `select`, inputs; `.alert`; row hover |
| `--line` | `#C9D3DD` | `#2C3845` | Quiet lines and frames |
| `--line2` | `#768695` | `#687A8F` | Control borders, stronger frames, map lines |
| `--ink` | `#0F1B27` | `#E3EAF1` | Main text |
| `--muted` | `#4C5A68` | `#93A0AE` | Secondary text, the most used text colour |
| `--p-claude` | `#A84628` | `#F08A66` | Claude mark, `.pm.claude` |
| `--p-kimi` | `#125BC7` | `#5E9BFF` | Kimi mark, `.pm.kimi` |
| `--p-glm` | `#3D47D6` | `#8D95FF` | GLM mark, `.pm.glm` |
| `--p-antigravity` | `#157331` | `#6DD58C` | Antigravity mark, `.pm.antigravity` |
| `--cyan` | `#00A3BD` | `#46E0EF` | Accent for fills, lines, active borders and focus. Not for small text |
| `--cyan-ink` | `#006E80` | `#6FE9F5` | Accent as text: links, chosen items, `accent-color` |
| `--amber` | `#E08A00` | `#FFB54A` | Warning fill and line |
| `--amber-ink` | `#9A5A00` | `#FFC36E` | Warning text |
| `--pink` | `#E0307F` | `#FF62AA` | Attention fill and line: `.alert` line, `.bar.max` |
| `--pink-ink` | `#B0185F` | `#FF8CC2` | Error and danger text |
| `--ok` | `#13753D` | `#5FD08A` | Success text and line |
| `--red` | `#C62828` | `#FF6B6B` | Alarm fill, line and text |
| `--on-red` | `#FFFFFF` | `#2A0606` | Text on `--red` |
| `--on-pink` | `#000000` | `#141A22` | Text on `--pink` fills: `.nav-count`. Skin role `on_attention` |
| `--scrim` | `rgba(10, 20, 30, .35)` | `rgba(4, 8, 12, .64)` | Dim layer behind a dialog: `.dialog-back`. Skin role `scrim`. Cyberpunk is denser since 23.11 (#1938, Head of design round 3): the map falls behind and the window reads first |
| `--scrollbar-thumb` | `#768695` | `#687A8F` | Thumb of the page scrollbar, `scrollbar-color`. Skin role `scrollbar_thumb` |
| `--scrollbar-track` | `#F8FAFC` | `#1B232D` | Track of the page scrollbar, `scrollbar-color`. Skin role `scrollbar_track` |
| `--idle` | `#C5D0DB` | `#2C3744` | Empty track, `.spinner` ring, panel bar lights |
| `--dot` | `rgba(30, 60, 90, .17)` | `rgba(140, 175, 205, .15)` | Dots of the map grid |
| `--glow` | `rgba(0, 163, 189, .10)` | `rgba(70, 224, 239, .10)` | Focus halo, chosen background |
| `--btn` | `#00768A` | `#46E0EF` | Fill of the primary button `.btn` |
| `--on-btn` | `#FFFFFF` | `#05222A` | Text on `--btn` |
| `--hud` | `rgba(240, 244, 247, .94)` | `rgba(23, 30, 39, .94)` | Dense layer over the map, with no blur under it: `.glass` |
| `--shadow` | `rgba(20, 40, 60, .18)` | `rgba(0, 0, 0, .45)` | Shadow of menus and windows |
| `--tracker-pulse-low` | `0.8` | `0.55` | Not a colour: the weakest opacity the core of a task worked on now breathes down to, `.tr-status-dot.working.now::before`. Set per skin in `apps/web/src/skins/registry.ts`, measured at 3:1 on the row, the row under the pointer and the open row: Matrix and Pixel 0.55 as Cyberpunk. A person's own skin is not measured and keeps 1, a still core (Design #1628) |

### Contrast of text

Computed with the WCAG 2 formula from the values above. Only tokens that `theme.css` sets as a text `color` are listed; `--on-btn` and `--on-red` are for their own fills, so they stand under fixed pairs. The limit is 4.5:1 for body text and 3:1 for large text and controls, from `templates/skills/dsn-theme.md`. **Under 4.5 is marked in bold.**

| Text token | Light on `--bg` | on `--surface` | on `--surface2` | Dark on `--bg` | on `--surface` | on `--surface2` |
|---|---|---|---|---|---|---|
| `--ink` | 14.51 | 16.64 | 15.47 | 14.41 | 13.06 | 11.81 |
| `--muted` | 5.90 | 6.76 | 6.29 | 6.56 | 5.95 | 5.38 |
| `--p-claude` | 4.90 | 5.62 | 5.23 | 7.11 | 6.44 | 5.82 |
| `--p-kimi` | 5.23 | 6.00 | 5.58 | 6.34 | 5.74 | 5.19 |
| `--p-glm` | 5.70 | 6.54 | 6.08 | 6.56 | 5.94 | 5.37 |
| `--p-antigravity` | 4.96 | 5.69 | 5.29 | 9.62 | 8.72 | 7.88 |
| `--cyan` | **2.51** | **2.88** | **2.68** | 10.97 | 9.94 | 8.99 |
| `--cyan-ink` | 4.94 | 5.67 | 5.27 | 12.20 | 11.06 | 10.00 |
| `--amber` | **2.24** | **2.57** | **2.39** | 9.96 | 9.03 | 8.16 |
| `--amber-ink` | 4.56 | 5.23 | 4.87 | 11.06 | 10.03 | 9.06 |
| `--pink` | **3.57** | **4.10** | **3.81** | 6.31 | 5.72 | 5.17 |
| `--pink-ink` | 5.57 | 6.39 | 5.94 | 8.15 | 7.38 | 6.68 |
| `--ok` | 4.81 | 5.51 | 5.13 | 9.06 | 8.21 | 7.42 |
| `--red` | 4.69 | 5.37 | 5.00 | 6.30 | 5.71 | 5.16 |

Fixed pairs:

| Pair | Light | Dark |
|---|---|---|
| `--on-btn` on `--btn` | 5.31 | 10.38 |
| `--on-red` on `--red` | 5.62 | 6.71 |
| `--ink` on `--hud` over `--bg` | 15.60 | 13.95 |
| `--muted` on `--hud` over `--bg` | 6.34 | 6.35 |
| `--on-pink` on `--pink` | 4.90 | 6.31 |
| `--scrollbar-thumb` on `--scrollbar-track` (control, limit 3:1) | 3.57 | 3.60 |

Lines against what they stand on. The limit of 3:1 is for controls; `--line` only divides content, so it is shown for reference:

| Line | On | Light | Dark |
|---|---|---|---|
| `--line` | `--surface` | **1.45** | **1.33** |
| `--line2` | `--surface` | 3.57 | 3.60 |
| `--line2` | `--surface2` | 3.32 | 3.25 |
| `--cyan` | `--surface` | **2.88** | 9.94 |
| `--cyan` | `--bg` | **2.51** | 10.97 |
| `--cyan-ink` | `--surface` | 5.67 | 11.06 |

**GAP.** Tokens with bold cells are used as text today. This table shows the token against each surface, not an audit of which pair appears on which screen. Do not use a bold pair for new small text. Example: `--pink` is the text of `.t-card-tag` at 12.5 px, 4.10 on `--surface` in the light theme. The text tokens of the light theme not in bold took the values the head of Design set, so they hold 4.5:1 on every surface.

`--line2`, the border of controls, holds 3:1 on its surfaces in both themes, with the values the head of Design set.

Every focus ring in `theme.css` is drawn in `--cyan-ink`, the general `:focus-visible` among them, as the head of Design asked: it holds 3:1 on every surface where `--cyan` does not.

**GAP.** 3 raw colours, in 5 uses, still sit outside the tokens in `theme.css`: `#15191F` in `.t-term` and `.t-load`, `#dcdcdc` in `.t-load` and `.t-load .spinner`, `#2b323b` in `.t-load .spinner`. `.dialog-back` uses `--scrim` and `.nav-count` uses `--on-pink` since 1.3. For the whole product, see `hornhoof-themes.md`, section 8.

### Local variables

These are set on components, not themes: `--cut`, `--c2`, `--edge`, `--strip-room`, `--inset`, `--frame`, `--top-frame`, `--panel-width`, `--gap`, `--row`.

## 2. Type

| Token | Value, the same in both themes | Use |
|---|---|---|
| `--f-display` | `'Tektur', 'Onest', system-ui, sans-serif` | Headings, buttons, tabs |
| `--f-body` | `'Onest', system-ui, -apple-system, 'Segoe UI', sans-serif` | Body text |
| `--f-mono` | `ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | Commands, code, keys |
| `--cut-k` | `1` | Scale of every cut corner, set by the skin on `:root`: `0` square (Matrix), `1` the usual cut (Cyberpunk, Light, Pixel), a person's own skin from `0` to `1.5` |

`--cut-k` scales every cut corner: `calc(var(--cut) * var(--cut-k))`. The skin's shape decides how the corner is drawn: one slanted cut, or two square steps of `calc(2px * var(--cut-k))` in Pixel.

**RULE.** New components with a cut corner multiply their `--cut` by `--cut-k` and never set `--cut-k` themselves.

Fonts are imported in `apps/web/src/main.tsx`:

| Family | Imported weights | Package | Writing systems in the package |
|---|---|---|---|
| Onest | 400, 500, 600 | `@fontsource/onest` 5.3.1, OFL-1.1 | Cyrillic, Latin, Vietnamese, math, symbols. No Greek |
| Tektur | 500, 600 | `@fontsource/tektur` 5.3.0, OFL-1.1 | Cyrillic, Greek, Latin, Vietnamese |
| Mono | none, system fonts only | | |

| Use | Font | Size | Weight | Line height | Source |
|---|---|---|---|---|---|
| Body | `--f-body` | 14 px | 400 | 1.45 | `body` |
| `h1` | `--f-display` | 26 px | 600 | 1.15 | `h1, h2, h3`, `h1` |
| `h2` | `--f-display` | 18 px | 600 | 1.15 | `h1, h2, h3`, `h2` |
| `h3` | `--f-display` | set per place: 22 px in `.ac-head`, 15 px in `.settings-part`, 13 px in `.dv-drawer` | 600 | 1.15 | see the selectors |
| Button `.btn` | `--f-display` | 14 px, `.btn.small` 13 px | 600 | inherited | `.btn` |
| Button `.act` | `--f-display` | 13 px | 600 | inherited | `.act` |
| Tab | `--f-display` | 14 px | 600 | inherited | `.tabs button` |
| Field label | `--f-body` | 13 px | 500 | inherited | `.field > label` |
| Hint and field error | `--f-body` | 12 px | 400 | inherited | `.field .hint`, `.field .bad` |
| Status | `--f-body` | 12 px | 600 | inherited | `.status` |
| Badge | `--f-body` | 11 px | 600 | inherited | `.badge` |
| Panel name | `--f-body` | 12.5 px | 400 | inherited | `.t-bar` |
| Code and commands | `--f-mono` | 12 px | 400 | 1.55 | `.command code` |

Rules per value in `theme.css`. Sizes: `13px` 75, `12px` 64, `12.5px` 44, `14px` 15, `15px` 12, `13.5px` 12, `11.5px` 8, `11px` 7, `18px` 4, `22px` 3, `26px` 2, `20px` 2, `16px` 2, `8.5px` 1, `28px` 1, `15.5px` 1, `10.5px` 1, `17px` 1. Weights: `600` 84, `500` 13, `700` 9, `400` 2. Line heights: `1` 4, `1.45` 3, `1.55` 3, `1.2` 3, `1.4` 3, `1.15` 2, `22px` 2, `1.35` 2, `14px` 1, `16px` 1, `18px` 1, `1.5` 1, `1.25` 1, `1.1` 1, `1.3` 1. There are no size tokens.

**GAP.** Weight 700 appears in 9 rules, but no 700 face is imported, so it never gets a real 700 face.

**GAP.** `templates/skills/dsn-ui-rules.md` asks for body text of at least 16 px on phones. Body text is 14 px at every width.

**RULE.** New work uses sizes already in the list above and adds none between them. Sizes under 12 px are for compact map and badge labels only.

### Other writing systems

Today a letter missing from Onest or Tektur falls through the token's list to `system-ui`, so it looks different on each computer. Nothing else is loaded and no script has its own font. Hindi, Arabic, Chinese, Japanese, Korean, Thai and Hebrew are all in this case.

**RULE.** Line heights are numbers without a unit, so taller scripts grow the line. Fonts are chosen by language or by `unicode-range`, never by a rule that looks at one screen.

**PROPOSAL.** When a language needs a script Onest lacks: add one font family with the writing system's own `unicode-range` before `system-ui` in `--f-body` and `--f-display`, and check its licence. Noto families served this way in test prototypes only, not in the product. This needs a decision on font size and download weight per language.

## 3. Spacing and sizes

There are no spacing tokens. Uses per value in `margin`, `padding` and `gap` in `theme.css`, most used first: `10 px` 114, `8 px` 110, `6 px` 77, `12 px` 75, `4 px` 58, `14 px` 42, `2 px` 40, `16 px` 35, `18 px` 23, `3 px` 14, `1 px` 11, `20 px` 10, `7 px` 9, `32 px` 8, `24 px` 8, `5 px` 7.

**RULE.** New work uses 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32 px, the values that already lead the count.

| Place | Value | Source |
|---|---|---|
| Side panel content | 16 px top, 18 px sides, 20 px bottom, 18 px between blocks | `.ac-body` |
| Notebook | 14 px 16 px | `.notebook` |
| Panel on a page | 20 px, 14 px between blocks | `.panel > .edge-in` |
| Form card | 24 px, 16 px between blocks; 16 px and 14 px where the card is under 480 px wide. Its head: 4 px from title to note, 12 px to its line | `.form-card > .edge-in`, `.form-head` |
| Form grid | Label column 180 px, 12 px to the field, 12 px between rows, hint 4 px under the field; where the form is under 480 px wide, the label stands 6 px over the field. The foot: 12 px over it to a 1 px `--line` | `.form-grid`, `.form-grid > .form-foot` |
| Dialog | 18 px, 12 px between blocks | `.dialog` |
| Card | 28 px, 18 px between blocks | `.card > .edge-in` |
| Table cell | 12 px 14 px, header 10 px 14 px | `.ptable td`, `.ptable th` |
| Sort table cell | 10 px | `.dt > tbody > tr > td` |
| Common button gap | 8 px or 10 px | `.ac-actions`, `.settings-actions`, `.card .actions` |
| Side panel `.acard`, drawer `.dv-drawer` | 400 px; at 760 px and under 16 px from each side, 343 px on a 375 px phone (measured in the screen inventory) | `.dv-drawer, .acard` |
| Panels in the agent window | up to 400 px; at 760 px and under the full window | `.orch`, `.side-panel` |
| Dialog width | up to 560 px | `.dialog` |
| Card width | up to 440 px, wide 960 px | `.card` |

| Control | Height | Source |
|---|---|---|
| `.btn` | from 40 px | `.btn` |
| Button in `.entry-actions` or `.form-foot` | from 44 px | Section 6 |
| `.btn.small` | from 30 px | `.btn.small` |
| `.btn` in `.dv-acts` | from 44 px | `.dv-acts .btn` |
| `.act` | 32 px fixed | `.act` |
| Field input and select | 40 px fixed | `.field input`, `.field select` |
| Tab, `.hbtn`, `.zbtn`, avatar | 44 px | `.tabs`, `.hbtn`, `.zbtn`, `.avatar` |
| Panel bar | 38 px, its close button 34 px | `.t-bar`, `.t-bar button` |
| Compact row button | from 26 px | `.t-access-row .btn` |

Width breakpoints, with the number of rules: `max-width: 760px` 6, `max-width: 420px` 3, `max-width: 560px` 2, `min-width: 761px` 2, `max-width: 860px` 1, `max-width: 720px` 1, `min-width: 1200px` 1. Width of the place, by container: `card (min-width: 700px)`, `card (min-width: 1180px)`, `card (max-width: 300px)`, `tbl (max-width: 780px)`.

Corners: mostly square. The cut corner is a `clip-path` with `--cut`: 7 px on `.btn`, 10 px on `.edge`, others set per place. `border-radius` is used for round dots and a few small items: `0`, `10px`, `50%`, `6px`, `4px`.

**RULE, all skins.** The frame, selection border and glow of an element follow its shape, cut corner included. A rectangular `box-shadow` or `outline` around a `clip-path` shape is not allowed: it leaves a square halo and a dark triangle at the cut. Draw them with the same shape (an outer layer or pseudo-element with the same `clip-path` and `--cut`, or `filter: drop-shadow` on a wrapper). In a skin with no cut corners the same code draws a plain rectangle. Check it on a picture of the selected card in every built-in skin (#1070). Focus of a `.btn` keeps its own rule in section 6.

**RULE.** A touch target is at least 44 by 44 px, from `templates/skills/dsn-ui-rules.md`.

**GAP.** Outside a group of section 6, `.btn` is 40 px, `.btn.small` 30 px and `.act` 32 px, and the panel bar's close button and `.t-access-row .btn` are also under 44 px. No rule raises them on a phone. Inside `.entry-actions` and `.form-foot` a button is from 44 px.

## 4. Components

Only what exists in the code. Source paths are relative to `apps/web/src/`. Each class exists in `theme.css` and in the named files; the check script confirms both.

### Buttons

| Class | Look | States in `theme.css` | Source, examples |
|---|---|---|---|
| `.btn` | Primary: `--btn` fill, `--on-btn` text, cut corner | hover `brightness(1.08)`; disabled opacity .45; focus drops the cut and draws a 2 px `--cyan-ink` ring | `ui/Ask.tsx`, `screens/Settings.tsx`, `ui/RepoSettings.tsx` |
| `.btn.ghost` | Secondary: no fill, `--line2` inner line, no cut | hover `--cyan` inner line; focus outline visible | `ui/Ask.tsx`, `ui/CopyButton.tsx`, `screens/Shell.tsx` |
| `.btn.small` | Same at 13 px, from 30 px | as above | `ui/Ask.tsx`, `ui/Requests.tsx` |
| `.act` | Row action: `--surface2` fill, `--line2` border | hover `--cyan` border, `--cyan-ink` text; disabled opacity .45 | `screens/People.tsx`, `screens/Subscriptions.tsx`, `ui/AgentCard.tsx` |
| `.act.danger` | Row action that removes | hover `--pink` border, `--pink-ink` text | `screens/People.tsx`, `screens/Machines.tsx` |
| `.t-link` | Text link button, `--cyan-ink`, underlined | | `ui/Notebook.tsx`, `screens/AgentWindow.tsx` |
| `.linkbtn`, `.rowbtn` | Link and row buttons of a sort table | | `ui/SortTable.tsx` |
| `.hbtn` | Bar button, 44 px | | `screens/Department.tsx` |
| `.zbtn` | Square map button, 44 px | | `ui/canvas.tsx` |

The focus of `.btn` is set in `theme.css:81`. It has not been checked on a picture yet, as rule 7 of section 6 asks.

### Fields

| Class or element | Look | States | Source |
|---|---|---|---|
| `.field` with label, input or select, `.hint`, `.bad` | Stack with 6 px gap | focus: `--cyan` border and `0 0 0 3px var(--glow)` | `ui/Field.tsx` |
| `select` | Own arrow, `--surface2` fill, keeps one line | focus as above; disabled opacity .55 | `theme.css`, `ui/AgentCard.tsx` |
| `.choice`, `.segments` | Radio cards and segments, `.on` is chosen | `.on`; segments show focus on the label | `screens/Setup.tsx` |
| `label.check` | Checkbox with text | | `screens/Setup.tsx` |
| `.check-card` | A switch on its own frame, from 44 px, beside its label in a form's grid | | `screens/People.tsx` |
| `.kind-switch`, `.kind-card` | Who joins: a person or a personal AI assistant, two radio cards with a 20 px icon, side by side, one over the other where the form is narrow; `.on` is chosen | `.on`; focus ring on the card | `screens/PeopleAssistant.tsx` |
| `textarea` | Styled per place, no shared class | focus in `textarea.ac-text` | `ui/Notebook.tsx`, `ui/NewTask.tsx`, `ui/TaskPanel.tsx` |

### Statuses and messages

| Class | Meaning and token | Source |
|---|---|---|
| `.status.active`, `.status.ready` | Good: `--ok` | `screens/Machines.tsx`, `screens/Subscriptions.tsx` |
| `.status.invited`, `.status.needs_login`, `.status.needs_setup`, `.status.waiting_machine`, `.status.limit` | Wait or act: `--amber-ink` | `screens/People.tsx`, `screens/Subscriptions.tsx` |
| `.status.offline`, `.status.builtin_offline` | Off: `--muted` | `screens/Subscriptions.tsx` |
| `.badge` | Small mark, `--pink-ink`; `.badge.lead` `--btn` fill; `.badge.old` and `.badge.head` `--amber-ink`; `.badge.required` `--cyan-ink` | `screens/Machines.tsx`, `screens/People.tsx`, `ui/StaffCard.tsx` |
| `.alert` | Message with a 3 px `--pink` line on the start side, on `--surface2` | `ui/AgentCard.tsx`, `screens/People.tsx` |
| `.warn-line` | Warning on its own line with its sign, a 3 px `--amber` line on the start side, `--amber-ink` text | `ui/StaffCard.tsx` |
| `.busy-swap` | The words of a main button and what it says while it works, the hidden one keeping the button's width; the button has `aria-busy` | `ui/BusyLabel.tsx` |
| `.secret`, `.secret-code` | Something shown once: its note, the code right under it in `--f-mono`, left to right, and its buttons under the code | `screens/People.tsx`, `screens/PeopleAssistant.tsx` |
| `.field .bad`, `.update-error` | Error text, `--pink-ink` | `ui/Field.tsx`, `ui/UpdateBanner.tsx` |
| `.spinner` | 16 px ring, `--idle` with a `--cyan` arc | `ui/UpdateProgress.tsx`, `ui/AgentTerminal.tsx` |
| `.bar` | 4 px progress on `--idle`: `--cyan`, `.hi` `--amber`, `.max` `--pink` | `ui/Bar.tsx` |

**RULE.** Status is never shown by colour alone, from `templates/skills/dsn-ui-rules.md`. The `.status` labels above carry a word.

**GAP.** `ui/Notebook.tsx` uses the class `error`, which has no rule in `theme.css`, so its message has no colour of its own.

### Panels and frames

| Class | What it is | Source |
|---|---|---|
| `.edge`, `.edge-in`, `.edge.accent` | Cut frame: outer layer is the line, inner layer the fill | `ui/Edge.tsx` |
| `.card`, `.card.wide` | Form card with the mark, on the sign-in, setup and invitation screens | `ui/Card.tsx` |
| `.panel`, `.form-card`, `.form-grid` | Section of a page; a card with a form and its head; the grid of a form, see section 3 | `screens/People.tsx`, `ui/ConnectPanel.tsx` |
| `.dialog`, `.dialog-back` | Centered window on a dim layer | `screens/Settings.tsx`, `screens/Versions.tsx` |
| `.side-panel`, `.acard`, `.t-bar`, `.ac-body` | Side panel with bar and scrolling body | `ui/SidePanels.tsx` |
| `.dv-drawer` | Department drawer | `screens/Department.tsx` |
| `.tabs` | Top navigation, the chosen tab has a 2 px `--cyan` bottom line | `screens/Shell.tsx` |
| `.chip` | Small labelled box on the map | `screens/Map.tsx`, `ui/RunningNow.tsx` |

### Records and their buttons

The record of section 6 now stands in the notebook, people, requests, confirmations, the task panel and settings. `.entries` and `.entry` exist only inside `.notebook`, and `.fit` only on the people table. These older groups still do the same job in different ways, as the screen inventory records:

| Class | Structure today | Source |
|---|---|---|
| `.notebook li` | Grid `auto 1fr auto auto auto`, text and buttons are siblings | `ui/Notebook.tsx` |
| `.ask` | Question and buttons are siblings in a wrapping row | `ui/Ask.tsx`, `screens/Machines.tsx` |
| `.settings-actions` | Row that may mix text and buttons | `screens/Settings.tsx` |
| `.ac-actions` | Row of buttons with a top line | `ui/AgentCard.tsx`, `ui/TaskPanel.tsx` |
| `.repo-actions`, `.machine-actions`, `.req-actions`, `.req-options` | Groups of buttons | `ui/RepoSettings.tsx`, `screens/Machines.tsx`, `ui/Requests.tsx` |
| `.row-actions` | Buttons of a table row, at the end of the row | `screens/People.tsx` |

New work follows section 6, with the classes named there.

### States

**RULE.** Draw a state only where it exists, and add no new confirmation steps. Show a confirmation only where the product already has one. Saving shows a visible sign that keeps the group's width, not `disabled` alone.

Which states exist, from a check with Development. That check was on `3e372c98` plus unfinished work on the records of section 6, so it is neither a clean snapshot nor a live test:

| Place | States |
|---|---|
| Notebook | Normal, hover, focus, read error with retry, save error, empty and editing can be told apart. Loading and saving are being added there locally with `aria-busy` and a status |
| People | Busy and error can be told apart |
| Shared confirmations | Their own local state of the question |
| Requests | Normal, hover and focus exist. Sending shows a `role="status"` line and `aria-busy`, with the buttons disabled; no spinner is needed there. A save error is an alert, and the draft stays. Read-only shows who decided. Loading and empty live in the parent panels. A read error is needed there, but it does not reach the person yet. There is no confirmation step |

`Remove` in the notebook has no confirmation. Development decided that this is not a defect and that no confirmation will be added. `templates/skills/dsn-ui-rules.md` asks for one in general, so the case stands in the exceptions list of section 8.

### Materials of a question

A question that shows a result carries materials: pictures, documents, files and links, shared by the question or belonging to one option.

**RULE.**

1. A material and an answer are never nested and never look alike. A material is a flat frame in `--f-body` with the word of its kind and the word to open it. An answer is a button of section 6, under the materials of its option.
2. Opening, zooming, paging, closing and downloading choose nothing and send nothing. The draft of the answer survives all of them.
3. In a list of options, a picture takes the whole width of the option, so the difference shows before opening.
4. The viewer covers the window, follows the theme and keeps its close button on screen. A document reads to its end, and a part that did not load is said in words, never hidden.
5. A refused or failed material keeps its name and says why in words.
6. A download mark appears only on what can be downloaded.

Built with the classes `.mat*`, `.mv*`, `.opt*` and `.answer-zone`. What each field means is decided with Development.

### Tables

| Class | Behaviour | Source |
|---|---|---|
| `.ptable` | Plain table, at 760 px of window and under each row becomes a block | `screens/People.tsx` |
| `.dt`, `.sortbar` | Sort table, at 780 px of its own width and under each row becomes a block with a sort bar | `ui/SortTable.tsx` |

### Tracker

The tracker uses the approved list reference and the existing skin roles. Tracker palette aliases in `theme.css` resolve for every built-in and custom skin.

| Tokens | Skin roles and use |
|---|---|
| `--tracker-palette-accent`, `--tracker-palette-warning`, `--tracker-palette-attention`, `--tracker-palette-success`, `--tracker-palette-blue`, `--tracker-palette-violet` | Accent, warning, attention, success, Kimi and GLM roles for department and person marks |
| `--tracker-program-claude`, `--tracker-program-codex`, `--tracker-program-kimi`, `--tracker-program-glm`, `--tracker-program-antigravity`, `--tracker-program-other` | The provider role for each program, muted mixed with ink for Codex, and muted for an unknown program |
| `--tracker-priority-urgent`, `--tracker-priority-high`, `--tracker-priority-normal`, `--tracker-priority-low` | Attention text, warning text, accent text and muted text |
| `--tracker-mark-ink`, `--tracker-mark-strength` | Dark uses the page background as text on a full-strength fill. Light uses ink on a fill mixed at 30 percent over the panel surface |
| `--tracker-working-ring`, `--tracker-waiting-ring` | Accent and warning on dark, their text variants on light |

| Class | What it is | Source |
|---|---|---|
| `.tracker`, `.tr-main`, `.tr-top`, `.tr-menu`, `.tr-where`, `.tr-view-as`, `.tr-search` | Mockup 10's frame: a left panel of `clamp(270px, 18.75vw, 360px)` and the main area, both under a 1 px line. Each band of the main area spans its width with 20 px inside: where the person is in 600 16 px of the display face, View as and search. At 760 px and under the page has one column, 12 px inside, and the Lists button opens the left panel | `screens/Tasks.tsx` |
| `.tr-side`, `.tr-side-title`, `.tr-new`, `.tr-new-menu`, `.tr-side-heading`, `.tr-item`, `.tr-badge`, `.tr-dept-head`, `.tr-unfold`, `.tr-l1`, `.tr-l2`, `.tr-live`, `.tr-waitd`, `.tr-idle` | Left panel, 12 by 8 px inside: Waits for me, My tasks and Working now; Responsible, each person with what they answer for; Departments, each with who answers and how many work now, and open: its goals, pipelines, employees (dot, name, task) and products. Goals, Due dates, Failures, the orchestrator's own work and Turns follow under a line. Rows of 32 px for a mouse and 44 px for a finger (`pointer: coarse`), 13.5 px, an 18 px icon column, steps of 30 and 52 px. Counts: a pink badge for what needs the person, a lined badge, muted digits, green for work going on; what stands at the end wraps under the name as a whole. The panel reserves room for the scrollbar. The 30 px + beside Tasks (44 px for a finger) is the only way to make something on the screen: it opens the card menu's rows in a raised box as wide as the panel, with a new task, goal or pipeline, a change of the pipeline and writing to the orchestrator, as far as the person may | `ui/TrackerSide.tsx` |
| `.tr-bar`, `.tr-views`, `.tr-chips`, `.tr-chip` | List, Board and Graph tabs, 600 13.5 px with 10 by 12 px and a 2 px line under the chosen one. On the list only, the mockup's chips, group, subtasks, executor and responsible, 12.5 px with 3 by 10 px; a choice in use has an accent border. Controls grow to 44 px on phones and touch screens | `screens/Tasks.tsx` |
| `.tr-list`, `.tr-group`, `.tr-group-toggle`, `.tr-status-pill`, `.tr-row`, `.tr-cells`, `.tr-head`, `.tr-name`, `.tr-line`, `.tr-status-dot`, `.tr-k`, `.tr-v` | Mockup 10's table: a cut pill in capitals (600 12 px) and a count over each status, the column names once under the first pill, one 37 px line per task in the shares 44, 14, 14, 14 and 14 of the width, never narrower than the longest word. The line: subtask caret, 14 px status ring, title, subtask count, `#number` in the mono face and the wait in its colour. Subtasks stand open, 36 px further in. At 640 px or less of list width each detail is labeled below the title | `ui/TrackerViews.tsx` |
| `.tr-avatars`, `.tr-mark`, `.tr-avatar`, `.tr-executor`, `.tr-dept-mark` | Marks of 22 px with a 2 px line of the page colour, letters in 600 10.5 px: a circle with one letter for a person, a 4 px rounded square with two for an employee (the first letters of two words, or the first two of one word), overlapping by 6 px side by side. A department mark is 18 px with cut corners | `ui/TrackerMarks.tsx`, `ui/TrackerViews.tsx` |
| `.tr-columns`, `.tr-col`, `.tr-col-head`, `.tr-col-who`, `.tr-card`, `.tr-card-body`, `.tr-card-meta` | Board: columns side by side in shares of the width up to 270 px each while each keeps 160 px, one under another otherwise, 10 px apart. A column is the panel surface in a line, 8 px inside, its head a status pill, the count and for a stage the role that holds it. A card is a 1 px line around the raised surface with 8 px cut corners, 9 by 10 px inside: the title in 600 13.5 px, then avatars, due date, subtasks done of all and the wait, 12 px. The whole card opens it | `ui/TrackerViews.tsx` |
| `.tr-goals-page`, `.tr-goal-mark`, `.tr-goal-title` | The goals page, from Goals at the end of the left panel (the company's) or under a department: the list's rows with a goal mark, the progress over the two middle columns, who answers for it and its date, smaller goals under their goal | `ui/TrackerViews.tsx` |
| `.tr-graph`, `.tr-gtop`, `.tr-crumbs`, `.tr-canvas`, `.tr-map`, `.tr-wires`, `.tr-node`, `.tr-legend` | Graph on the map's dotted canvas with the map's zoom bar: Graph from and the way back up, nodes 290 by 52 px that grow to hold their words, a 4 px status strip, goals in a dashed accent line with their progress, solid lines for parts, dashed `--amber-ink` lines with words for waits, and the legend under it | `ui/TrackerViews.tsx` |
| `.acard.at-end`, `.acard.plain` | The card as a 460 px drawer at the end side from under the top bar, over the tracker without narrowing it, leaving the 32 px strips of minimized windows in reach beside it; on a phone the whole screen under the top bar | `ui/SidePanels.tsx`, `screens/Shell.tsx` |
| `.tp-path`, `.tp-kind`, `.tp-heading`, `.tp-state`, `.tp-why`, `.tp-bar`, `.tp-card-facts`, `.gbtn`, `.tp-sec`, `.tp-row`, `.tp-mat`, `.tr-form`, `.tr-stages`, `.tr-stage` | The card's goal path, kind in capitals, title in 600 20 px, status pill, why and progress bar, the facts with their names in a share of the width, Graph from here, then Subtasks, Links, Materials and History, and the edit forms | `ui/TaskPanel.tsx`, `ui/GoalPanel.tsx`, `ui/TaskAttachments.tsx`, `ui/TrackerForms.tsx` |
| `.tp-late`, `.tr-wait`, `.tr-relation` | Late dates and a wait for a person in attention text, 600; other waits and related tasks in outlined 600 11 px labels | `ui/TrackerViews.tsx`, `ui/TaskActivity.tsx`, `ui/TaskPanel.tsx` |

### Worker marks

The company map shows one 9 px square per employee, in the employee's status color. Generalists use the same square and keep their label for hover and screen readers wherever the worker kind is shown.

A filled diamond means a one-shot call. In the department diagram and its task route, the stage card has one diamond per declared call and another for the judge when there is one. Idle uses `--muted`, running uses `--tracker-working-ring` with a glow, and waiting uses `--tracker-waiting-ring`. The tracker and the standalone task route use one diamond to identify a one-shot stage.

## 5. Languages

**Goal: ready for 20 to 30 languages.** Today the registry holds two: `en`, the source, and `ru`, in `apps/web/src/i18n/`. `LANGUAGES` lists them in `index.tsx`. `isLanguage` there also names `en` and `ru` by hand, so a new language changes both, in addition to what `CONTRIBUTING.md` lists.

**RULE.**

1. Plan for text 1.5 to 2 times longer than English. No layout may depend on the length of today's strings.
2. Plan for different fonts and taller lines (section 2). Heights are minimums.
3. Right to left mirrors the layout. New rules use logical sides: `margin-inline-start`, `padding-inline`, `inset-inline-start`, `border-inline-start`, `text-align: start`.
4. Text wraps instead of being cut (section 6).
5. No rule looks at one language. Words and the order of words may change, so no sentence is glued from pieces.

**How to check.** Take the longest and the shortest of the languages really supported, by the method of the screen inventory: import the real `LANGUAGES` registry and dictionaries, measure the shared static keys at 14 px Onest in Chromium after `fonts.ready`, sum the text widths and rank them. Recompute when the registry grows; the ranking is not a fixed rule. Add one right to left language when one exists. Until then right to left is NOT_AVAILABLE as a product language, and pseudo strings only test the rule. They are not translations.

Result of the screen inventory at `5c67fb00`, not recomputed here: 1124 shared keys, EN is the shortest and RU the longest. Some single panels go the other way, so both are captured.

**Known debt, counted on the base of this book:**

| What | Count | How it was counted |
|---|---|---|
| Physical left and right | 189 | 187 at `2fed0c54`, by the same method: `left` 32, `right` 30, `border-left` 29, `margin-left` 21, `text-align: left` 21, `padding-left` 20, `border-left-color` 17, `margin-right` 7, `padding-right` 6, `text-align: right` 2, `border-right` 1, `border-left-style` 1. Earlier reports said 155 with no written method, so do not compare the two numbers |
| Logical sides | 8 | `*-inline` rules. 83 with `*-block`, `inline-size` and `block-size` |
| `text-overflow: ellipsis` | 27 | rules in `theme.css` |
| `white-space: nowrap` | 49 | rules in `theme.css` |
| Line heights in px | 5 | rules in `theme.css` |
| `dir` on the page | 0 | Nothing sets it. `dir="ltr"` stands only on addresses of materials |

Not every physical side needs to change: `left: 0` on a full-width layer stays correct. The count is the list to review, not the amount of work.

**Writing.** From `AGENTS.md` and `CONTRIBUTING.md`, mandatory for every text: English is the source of every text and every other language of the registry follows it; plain words a person outside IT reads without effort; no em dashes; in Russian write "е" instead of the letter with two dots. Repository text is in English.

## 6. Text wrap and action groups

**RULE, mandatory for all future interface.**

1. Text wraps. There is no sideways scroll and no cut text inside a panel: no ellipsis, no hidden overflow on text.
2. A word breaks only when it does not fit on a line of its own.
3. The buttons of a record are one element, in one row under the text, on one edge, with equal gaps. A label may take several lines inside its button. When whole words no longer fit, the row goes on from the same edge.
4. The group stands in one position across a whole list. A form's foot in the same panel stands on the same edge.
5. The one exception is a row of a real table, from its width threshold. A table that does not fit with whole words and one row of buttons turns its rows into records.
6. A status keeps one whole frame. Its words may wrap inside the frame, and the frame never splits across lines.
7. Focus is visible on every button, including those with a cut corner, in both themes. Check it on a picture: `:focus-visible` being true proves nothing if `clip-path` cuts the outline away.
8. A closed native `select` and a one-line input are not panel text. A long value shows in the open list, and an input keeps its native editing.
9. Width decides by the place, not the window: the same panel can be narrow on a wide screen.
10. A check of this rule must be able to fail. Show it failing once.
11. The order of buttons is the same everywhere and does not depend on width: the main action, then secondary actions, then cancel or a dangerous action.
12. A list of choices is not a row of actions. Each choice takes its own line across the panel, and cancel stays in the group under the list.
13. A table keeps its actions column last, its buttons on the end edge of the column. There is no fixed width threshold: the table stays a table while whole words, a whole status and one row of buttons fit, measured only when the data, language, font or size of the place changes.
14. The action button of a page title is from 44 px and stands on the end edge at any width.
15. A command or an address with a copy button: the button stands in the group under the text, on the end edge, from 44 px, at any width.

| Number | Value |
|---|---|
| Gap from text to group | 8 px |
| Gap between buttons | 8 px |
| Gap from text to its caption | 4 px |
| Gap between records | 16 px and a 1 px `--line` |
| Edge of the group and of a form's foot | End of the line, the same in the whole panel. Chosen by the CEO |
| Table threshold | None, see rule 13 |
| Button of a record, on every screen | From 44 px, padding 8 px 12 px, `--f-display` 600 14 px, line height 1.4. Chosen by the CEO |
| Focus ring | 2 px `--cyan-ink`, offset 2 px. On the close button of a panel, offset -2 px, inside the button |
| How a `.btn` with a cut corner shows focus | It drops the cut while it has focus, as `.t-access-row .btn` already does |
| Class names | `.fit`, `.entries`, `.entry`, `.entry-main`, `.entry-meta`, `.entry-actions`, `.form-foot`, `.choice-list`, `.facts` |

**GAP.** The product meets this section only in part. The records of section 6 are in the code at the base of this book. Of the 17 remarks of the panel review, 16 are still in the code and wait for their fixes. Requests stand on the start edge against this section: `.req-actions.entry-actions` in `theme.css:1142`. `.entry-actions > :is(.act, .btn)` is set twice, `theme.css:736` and `theme.css:1141`. Tables other than people have no `.fit` and break words, remark M3.

## 7. Site and marketing

Real sources in the repository:

| What | Source |
|---|---|
| The mark: a dome, a base line and a dot on a 30 by 30 grid, stroke width 2.4 | `.github/assets/logo.svg`, `LogoMark` in `apps/web/src/ui/icons.tsx`, `.mk-dome`, `.mk-base`, `.mk-dot` in `theme.css`, favicon in `apps/web/index.html` |
| Mark colours | Dome `--cyan`, base and dot `--ink`. In `logo.svg` the dome stays `#00A3BD` in dark, while `--cyan` is `#46E0EF` there. Which is right is not written anywhere |
| One line about the product | "Your own company of AI agents, on your own computers.", `README.md` |
| What it is not | `README.md`, section "What Hornhoof is not": no cloud service, no new AI, no chat, not only for code |
| Words used for the product | Orchestrator, department, head, employee, task, machine, plan: `README.md`, `guide/` |
| Pictures of the product | `.github/assets/`: `build.gif`, `development.gif`, `map.gif`, `setup.gif`, `tasks.gif`, `terminal.gif`, `machines.png`, `subscriptions.png` |
| User guide | `guide/`, 10 files |
| How marketing agents work | `templates/roles/marketing/`, `templates/skills/mkt-*.md`. Kept general by `AGENTS.md`, for any company, so they hold no rule about Hornhoof |
| Domain | `hornhoof.org` in public links for a company, such as in `guide/public-link.md`. That is a product feature and not a site |

| Section | State | What it needs |
|---|---|---|
| Website: pages, layout, its own type | NOT_AVAILABLE, no site source in the repository | The site's source, or a decision to build one |
| Brand guide: logo clear space, minimum size, colours on photos, forbidden uses | NOT_AVAILABLE | A decision by the head and the CEO. `templates/skills/dsn-brand-consistency.md` lists what it must answer |
| Voice: three words, words we use and never use, good examples | NOT_AVAILABLE | Written by Marketing or the CEO. `templates/skills/mkt-brand-voice.md` expects it |
| Product marketing context: audience, positioning, competitors | NOT_AVAILABLE | One document, per `templates/skills/mkt-product-context.md`. No Marketing department is open today |
| Social and email templates, cover images | NOT_AVAILABLE | Decided after the brand guide |
| Character: how the product should feel | Written per theme | `hornhoof-themes.md`, section 4 |

**RULE.** Until a section exists, marketing work uses the mark, tokens and fonts above and invents no logo, colour or claim.

**GAP.** `THIRD_PARTY.md` lists server components and not the Onest and Tektur fonts. Their package licence is OFL-1.1. Development should check whether they belong there.

## 8. Using and changing this book

**Before work.** Before any task is given out and before any mockup or check, the head reads this book and `hornhoof-themes.md`; each member rereads the sections the work touches. This was asked by the CEO. A mockup names the book's version it follows.

**A conflict.** The book and a task disagree: ask the head. The book and the code disagree: the code is what runs, so report it and the head decides which one changes. Tokens in this book must match `theme.css`, and `hornhoof-style-book-check.py` proves it.

**Changes.** Only the head of Design approves a change. Each approved change raises the version and adds one line below. A change of tokens goes in the same piece of work as the change to `theme.css`.

**Versions.** The first number grows when a rule changes, the second for fixes and additions that break nothing.

**Exceptions.** An exception has a written reason, a place, an owner and an end date, approved by the head. Without all of them it is a bug. An exception past its date is a bug.

| Place | Rule | Reason | Owner | Until |
|---|---|---|---|---|
| `Remove` in the notebook, `ui/Notebook.tsx` | Destructive actions ask for confirmation, `templates/skills/dsn-ui-rules.md` | Development decided that it is not a defect | Development | Reviewed by 2027-02-05 |
| The ticker: one moving line, with the full text on hover or tap | No ellipsis on text, section 6 | Head of Design's decision of 2026-11-19: the exception covers only the ticker. Map captions and `.chip` are out of the exception, so the general wrap rule applies to them | Development | Reviewed by 2027-02-05 |
| Close button of a panel | Touch target of 44 px, section 3 | The panel bar is 38 px; a change of the bar is its own work | Design | Reviewed by 2027-02-05 |
| Name in the terminal bar: cut with an ellipsis in Russian at 375 px | No ellipsis on text, section 6 | The terminal bar keeps its own rule of fitting its window | Development | Reviewed by 2027-02-05 |

### Change list

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | 2026-11-05 | First version: built from the code, numbers of section 6 after the CEO's choice, rules 11 to 13, section 9 | Head of Design |
| 1.1 | 2026-11-06 | Rules for materials of a question | Head of Design |
| 1.2 | 2026-11-07 | Base moved to `a354cc27`. Themes and modes told apart. GAPs and counts updated. Rules 14 and 15 of section 6, from the panel review. One exception added. Reading before work extended to giving out tasks | Head of Design |
| 1.3 | 2026-11-13 | Tokens of skin file version 2: `--on-pink`, `--scrim`, `--scrollbar-thumb`, `--scrollbar-track` and `--cut-k`, with their contrast. Raw colours of `.dialog-back` and `.nav-count` removed from the GAP | Head of Design |
| 1.4 | 2026-11-16 | Frame, selection and glow follow the cut corner in all skins, section 3 (#1070) | Head of Design |

## 9. Browsers

**RULE.**

1. Do not rely on browser defaults. Every property that shapes a screen is set on purpose: box sizing, margins and padding of built-in elements, font and line height of controls, appearance of buttons and fields, list and table defaults, and the space a scrollbar takes.
2. Reserve the same room for a scrollbar on every engine, so a layout does not shift when one appears and panels keep their width. **GAP.** `scrollbar-gutter: stable` stands in 3 of 20 scrolling rules: `.dialog`, `.notebook`, `.ac-body`.
3. Check on the three browser engines: Chromium, Firefox and WebKit, on desktop and phone sizes. Passing on one engine proves nothing about the others.
4. Between engines, key sizes differ by at most 1 px and the center of an icon by at most 0.5 px. A bigger difference is a defect, or an entry in the exceptions list of section 8.
5. A check of this rule measures real rendering in each engine and can fail. Show it failing once. Pictures from all three go to the head of Design for review.
