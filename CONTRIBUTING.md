# Helping build Hornhoof

Thank you for wanting to help. Hornhoof is young, and every report, idea and change shapes it. This page says how work gets into Hornhoof, so your time is not lost.

## Ways to help, with or without code

- Report a problem: open an issue with "Bug report". Say what you did, what you expected and what happened. Logs help, but remove keys and passwords from them first.
- Suggest an idea: open an issue with "Idea". Start with the problem you have, not the solution. "I lose track of which agent waits for me" tells us more than "add a button".
- Translate. English is the main language of Hornhoof, and every other language is a translation of it. The screens have Russian now. Better words, or a whole new language, are welcome; see "Adding a language" below.
- Write templates. Departments, roles and skills live in `templates/`. They must fit any company: no company, product, industry or programming language of one particular user in them.
- Fix and build. Issues marked `good first issue` are small and well described, and `help wanted` marks bigger ones we would love help with.

Security problems never go into a public issue. [SECURITY.md](SECURITY.md) says how to report them privately.

## How a change gets in

Hornhoof works like most large open projects: you propose a change as a pull request, the checks run, a maintainer reviews it, and a maintainer merges it.

1. Agree first on anything big. For a new feature, a new screen or a change to how agents work, open an issue or comment on one before you write code. A short "I want to do X like this" saves a pull request that cannot be taken. Typos, small fixes and translations need no issue.
2. Fork the repository and make a branch from `main`. Name it after what it does, like `fix-invite-link` or `machines-tab-phone`.
3. Write the test first. Write a test that shows what should happen, run it and watch it fail, then write the code that makes it pass. A change without a test that failed first is not done.
4. Run the checks on your machine, as "Checks before you push" says. They must be green.
5. Commit with a sign-off, as "Sign your work" says.
6. Open a pull request against `main` and fill in the template. Keep it to one topic: two small pull requests get in faster than one big one.
7. The checks run on GitHub. Tests, type checks and the sign-off check must pass before review.
8. A maintainer reviews it. Answer review comments with new commits on the same branch, and do not force-push over a branch under review. When a comment is unclear, ask.
9. A maintainer merges it as one commit with the pull request's title. Your sign-off goes with it.

We try to give every pull request a first answer within a week. If yours waits longer, a friendly comment on it is welcome.

## Set up

You need Node 22, Docker, and bash and jq for the tests of the installer and the updater (`brew install jq` on a Mac, `apt install jq` on Debian or Ubuntu).

```sh
git clone https://github.com/<you>/hornhoof.git
cd hornhoof
npm install
npm test
```

To run it, start Postgres, then the server with `DATABASE_URL` and `HORNHOOF_SECRET` set (`npm run dev`) and the web app with `npm run dev -w apps/web`. The web app sends `/api` to port 8080. To run everything in Docker instead, see [Run it from source with Docker](guide/install.md#run-it-from-source-with-docker) in the guide.

The repository has four parts:

- `apps/server`: the server, its database and the tools agents call.
- `apps/web`: the screens people use.
- `apps/node`: the node that runs agents on a machine.
- `packages/protocol`: what the server and the nodes say to each other.

## Checks before you push

```sh
npm test
npm run lint
npx tsc -p apps/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsc -p apps/node/tsconfig.json --noEmit
```

`npm run lint` gives each part its own eslint process. To lint one part, run `npm run build -w @hornhoof/protocol` and `npm run lint:part -w apps/server`. The server is linted in five runs, one after another, since its sources and tests together need more memory than one run has; the runs stop at the first that finds something, and an option added after `--` reaches only the last of them, so to fix or filter name the files to `npx eslint` yourself. Avoid `npx eslint` over the whole repository: eslint keeps the types of every part in memory until it exits, and together they need more than the 2 GB node allows by default on a machine with less than 15 GB of memory.

Run `tsc` for each part you changed. After a change in `packages/protocol`, rebuild it with `npx tsc -p packages/protocol/tsconfig.json` before you test the server or the node. After a change in `scripts/`, run `shellcheck` over the script.

`npm run test:real` needs Docker and runs the tests against Pebble and against Postgres 17.11, the image compose's `db` runs.

`npm run test:lab` needs a Docker that may run privileged containers and about 20 GB of free disk. It builds the app, node and updater images from the checkout, starts two computers with a Docker of their own, installs a server on one with `install.sh`, joins the other with the command from Machines and disconnects it. `HH_LAB_BUILT=1` reuses the images of a run before, and `HH_LAB_KEEP=1` leaves the machines to look at; everything the lab makes carries the label `hornhoof.lab`.

Coverage for crapper is `npx vitest run --coverage` in the part's folder, on the dependencies its harness put there or after `npm ci`, with no `node_modules` copied in. Keep a probe with its own vite config inside the clone, or its plugins are not found.

What only a real browser shows, such as where a panel lies over a page, is tested with Playwright in `apps/web/e2e`. These tests are not part of `npm test`. After a change to how the screens are laid out, run them:

```sh
npx playwright install chromium
npm run test:browser -w apps/web
```

The first line downloads the browser once on your own machine. A Hornhoof worker node prepares the lockfile's Chromium in `/data/browsers` automatically before handing out tasks.

The server tests of one file share one database, emptied before each test, because opening a copy costs far more. A test that opens a second one gets a separate database. A file whose tests change more than rows, such as a trigger, a function, a table, a role or a grant, calls `ownDatabases()` at its top and gets a new database for each test; lint asks for that where it sees such a statement. A change lint cannot see is found when the file ends, and fails the file.

Rows a group of tests starts from, such as a company with its people and departments, are made once per file: `fixture()` in `apps/server/test/helpers-db.ts` makes them through the real code for the first test that asks, and gives every later test the same rows back. `setUpCompany()` goes through it. A rule that needs no database is tested without one, and a test calls the step of the server it waits for instead of polling for it.

A timeout given at the root reaches every package: `npm test -- --testTimeout=60000`.

A change to the database schema gets a new migration from `npx drizzle-kit generate` in `apps/server`. Never edit a migration that is already on `main`.

## Releasing a version

A release needs no turns of the agent programs on real nodes: the tests are its check. That check is `run_tests` with no suite on the turn's branch or a `release-` branch at the exact commit, with the profile that `execution.fullRun.profile` in `.hornhoof/test-environment.json` names, `full`: the first run of a release runs every test file, and each later run of the same release runs only what failed or changed since, so a release that failed is mended and run again.

1. After the owner approved the exact commit, move `main` to it by fast-forward: a merge commit is another commit, which the owner did not approve.
2. The push to `main` runs the Images workflow by itself. Once the tests passed, a commit with a new version builds the app, node and updater images under the tag of the commit; then the publish job finds the three images by the digests that tag points at, moves the version and `latest` onto exactly those, the app image last, and checks that `latest` holds them. A build that failed moves nothing: run the workflow's failed jobs again. A commit whose version is out already builds and moves nothing. A run of the workflow by hand builds the images of any branch under the tag of its commit and moves nothing else.
3. The release job then creates the version tag `v<version>` and its GitHub release. Servers offer it by themselves, and the nodes of each server follow its build as their work ends.

Never make the version tag or its GitHub release by hand: the workflow makes both. The images and publish jobs read an existing tag of the version as a version that is out already: with a tag made before they ran, the push builds no images and moves nothing, and the release job makes no release. If such a tag was made, delete it and its release, then run all jobs of the workflow for that push again.

## Rules for the code and the words

These are the same rules everyone follows, people and agents alike. [AGENTS.md](AGENTS.md) has them in short.

- Code, comments, commit messages and the README are in English.
- Every screen ships in English and Russian. A new string goes into both `apps/web/src/i18n/en.ts` and `apps/web/src/i18n/ru.ts`, in plain words a person outside IT reads without effort.
- No em dashes anywhere, in code, texts or translations. In Russian write "е" instead of "ё".
- Match the code around you: its naming, how much it comments and how it does things.
- Do not reformat files you did not change, and do not run a formatter over the whole repository.
- A screen you change must hold its full text and actions at phone and desktop widths with no sideways scroll, following [`templates/skills/dev-frontend-ui.md`](templates/skills/dev-frontend-ui.md), [`docs/style-book.md`](docs/style-book.md) and "Interface panels and language checks" below.
- Templates in `templates/` stay general, and `templates/SOURCES.md` names where each text comes from and under which licence. Do not copy text from a source whose licence does not allow it.

### Interface panels and language checks

- Every panel, card, list item, settings row and table cell wraps long words, identifiers, paths and URLs inside the panel width. When space runs short, an entry's action buttons move below the text as a whole group on one even row with one shared edge and spacing across entries, following [`docs/style-book.md`](docs/style-book.md) (never custom per-row offsets, and never `text-overflow: ellipsis`, clipped overflow or hidden controls).
- Reset browser default margins, paddings, borders and backgrounds on interactive controls, and give each component explicit sizing, padding, border, background, font inheritance, centred icons and interactive states instead of relying on browser default geometry. Reserve scrollbar space in scrollable panels without assuming overlay scrollbars, and verify web layout and geometry across Chromium, Firefox and WebKit instead of a single browser engine.
- Non-visual work (server, data, API, logic, states, live data, behaviour tests and a simple temporary skeleton) proceeds in parallel without waiting on a design mockup; only final visual styling waits for the approved Design reference and visual check, without inventing unchosen tokens or distances.
- Layouts must accommodate 20 to 30 languages (`1.5x` to `2x` expansion over short Latin copy, taller line-heights for scripts such as CJK and Devanagari, and mirrored RTL layout via logical CSS properties for Arabic and Hebrew).
- For screenshots and browser checks on a touched screen, read the actually shipped locales from `LANGUAGES` in [`apps/web/src/i18n/index.tsx`](apps/web/src/i18n/index.tsx) and their dictionaries in `apps/web/src/i18n/*.ts`, sum the character lengths of the real translation strings rendered on that screen for each shipped locale, and test the dynamically **longest** and **shortest** shipped locales (plus one shipped RTL locale once `LANGUAGES` includes one) in light and dark themes at phone and desktop widths. Never hardcode a fixed pair of locale IDs forever, and never count a demo or pseudo-locale string as a shipped translation.

## Adding a language

All text people see lives in `apps/web/src/i18n/`: `en.ts` is the source, and `ru.ts` is its Russian translation. A new language is a new file next to them with every key of `en.ts`, plus its name in `LANGUAGES` in `index.tsx`. Write it in plain words, the way a person outside IT speaks, and check the screens at phone width, where longer words wrap first. Open an issue before you start, so two people do not translate the same language.

## Commit messages

One line in English that says what changes for the person using Hornhoof, as a plain sentence:

```
Show the machine an employee runs on
Keep a machine command in a conversation with its code hidden
```

Add a short body when the why is not obvious. The pull request's title follows the same rule, since it becomes the commit on `main`.

## Sign your work

Like the Linux kernel, Hornhoof asks every commit in a pull request to carry a `Signed-off-by` line. With it you state that you wrote the change, or have the right to send it, under the [Developer Certificate of Origin](https://developercertificate.org/). Git adds the line for you:

```sh
git commit -s -m "Show the machine an employee runs on"
```

It uses the name and email in your git settings. Forgot it? `git commit --amend -s` fixes the last commit, and `git rebase --signoff main` fixes all of them on your branch, before review starts.

## Your contribution's licence

Hornhoof is under the [MIT License](LICENSE). By sending a pull request you agree that your change is published under it too.

## Working with AI agents

Using an AI agent to write your change is fine; Hornhoof itself is built with many. Point your agent to [AGENTS.md](AGENTS.md). You still answer for the pull request: read every line, run it, and make sure the tests prove what it claims. Leave the agent's "Generated with" and co-author lines out of commits.

## Be kind

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
