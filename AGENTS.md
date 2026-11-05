# Working on Hornhoof

These rules are for anyone who changes this repository, people and agents alike. They come before general habits.

## Language

* Code, comments, commit messages, README and other repository text are in English.
* Every screen ships in English and Russian. A new string goes into both `apps/web/src/i18n/en.ts` and `apps/web/src/i18n/ru.ts`, in plain words a person outside IT reads without effort.
* No em dashes anywhere, in code, texts or translations. In Russian write "е" instead of "ё".

## Code

* Write the failing test first, watch it fail, then make it pass.
* Follow the coding cycle for four task kinds in [`dev-implement`](templates/skills/dev-implement.md): Bug, Known behaviour, Unknown path or Legacy code. Each task names acceptance, risk class and its requirement -> test evidence.
* Match the code around you: its naming, comment density and idioms.
* Run the tests of what you changed before you push your branch. The whole suite, `npm test` from the repository root (including `npm run typecheck:tests` for server, node and protocol tests) and `npx tsc -p <app>/tsconfig.json --noEmit` for each app the turn touched, runs once per turn, on the merged turn branch, before it goes into main.
* Do not reformat files you did not change, and do not run a formatter over the whole repository.

## Templates

Department, role and skill templates in `templates/` are the same for every company. Keep them general: no company, product, industry or programming language of one particular user in them. `templates/SOURCES.md` lists where each text comes from and under which license.
