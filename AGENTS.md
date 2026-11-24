# Working on Hornhoof

These rules are for anyone who changes this repository, people and agents alike. They come before general habits.

## Language

* Code, comments, commit messages, README and other repository text are in English.
* Every screen ships in every language the product ships (today English and Russian). A new string goes into `apps/web/src/i18n/en.ts` and into the file of each shipped language next to it (`ru.ts`), in plain words a person outside IT reads without effort. Texts live in language files only; plurals go through `plural()`, dates and numbers through `Intl`; code never names a language. See "Adding a language" in [`CONTRIBUTING.md`](CONTRIBUTING.md#adding-a-language).
* No em dashes anywhere, in code, texts or translations. In Russian write "е" instead of "ё".

## Code

* Write the failing test first, watch it fail, then make it pass.
* Follow the coding cycle for four task kinds in [`dev-tdd`](templates/skills/dev-tdd.md): Bug, Known behaviour, Unknown path or Legacy code. Each task names acceptance, risk class and its requirement -> test evidence.
* Match the code around you: its naming, comment density and idioms.
* Run the tests of what you changed before you push your branch. The whole suite, `npm test` from the repository root (including `npm run typecheck:tests` for server, node and protocol tests) and `npx tsc -p <app>/tsconfig.json --noEmit` for each app the turn touched, runs once per turn, on the merged turn branch, before it goes into main.
* Test selection (T2 in [`dev-testing-policy`](templates/skills/dev-testing-policy.md)) in this repository is `npm run -s check:author -- --sha <commit> --base <commit>`, which runs in your own workspace and selects by the groups in [`.hornhoof/author-check.md`](.hornhoof/author-check.md). Submitting a task starts no test run. `run_tests` runs only on `main`, a turn's branch or a `release-` branch: the first run of a release runs every test file, and each later run of it only what failed or changed. For a report of the selector itself, `scripts/test/impact-README.md` documents `node scripts/test/replay-impact.mjs request.json > replay.json`, `scripts/test/related-probe.mjs` for Vitest related collection and `python3 scripts/test/impact-python/pytest_impact.py` for Python package import-graph collection, all through `run_tests` on a release branch. A selection step that could not run stays marked `NOT_RUN`. Selector collection runs no tests or migrations.
* In a new worktree, `npm run -s deps` puts the dependencies and the protocol and node builds in place. A worktree of a clone that installed the same lockfile links the clone's packages in seconds and keeps its own workspace packages; any other checkout runs `npm ci`. `check:author` does the same before it checks.
* The release check is `node scripts/check-release.mjs`.
* Do not reformat files you did not change, and do not run a formatter over the whole repository.

## Interface and languages

* Follow [`dev-frontend-ui`](templates/skills/dev-frontend-ui.md), [`docs/style-book.md`](docs/style-book.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md#interface-panels-and-language-checks) on every `apps/web` change (do not invent unapproved tokens, colours or per-row spacing).
* Non-visual work (server, data, API, logic, states, live data, behaviour tests and a simple temporary skeleton) runs in parallel without waiting on a mockup; only final visual styling waits for the approved Design reference and visual check.
* Every panel, card, list item, settings row and table fits its container width with no sideways scroll: long words, identifiers, paths and URLs wrap, and when width is tight, an entry's action buttons wrap below the text as a whole group on one even row with shared edge and spacing across entries. Never hide, drop, clip or truncate text or buttons (`text-overflow: ellipsis` or clipped overflow) to disguise overflow.
* Reset browser default margins, paddings, borders and backgrounds on interactive controls, and give each component explicit sizing, padding, border, background, font inheritance, centred icons and interactive states instead of relying on browser default geometry. Reserve scrollbar space in scrollable panels without assuming overlay scrollbars, and verify web layout and geometry across Chromium, Firefox and WebKit instead of a single browser engine.
* Build layouts for 20 to 30 languages (`1.5x` to `2x` text expansion, taller line-heights for CJK and Devanagari, and mirrored RTL layout via logical CSS properties). Verify narrow/phone and desktop widths in light and dark themes on the dynamically longest and shortest actually shipped locales registered in `LOCALES` in [`packages/protocol/src/locales.ts`](packages/protocol/src/locales.ts) (summing the character lengths of the real strings rendered on the touched view across `apps/web/src/i18n/*.ts`), plus one shipped RTL locale once `LOCALES` includes one. Never hardcode two locale IDs forever, and never count a pseudo-locale or demo string as a shipped language.

## Templates

Department, role and skill templates in `templates/` are the same for every company. Keep them general: no company, product, industry or programming language of one particular user in them. `templates/SOURCES.md` lists where each text comes from and under which license.
