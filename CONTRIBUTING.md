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
npx tsc -p apps/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsc -p apps/node/tsconfig.json --noEmit
```

Run `tsc` for each part you changed. After a change in `packages/protocol`, rebuild it with `npx tsc -p packages/protocol/tsconfig.json` before you test the server or the node. After a change in `scripts/`, run `shellcheck` over the script.

What only a real browser shows, such as where a panel lies over a page, is tested with Playwright in `apps/web/e2e`. These tests are not part of `npm test`. After a change to how the screens are laid out, run them:

```sh
npx playwright install --only-shell chromium
npm run test:browser -w apps/web
```

The first line downloads the browser once. A Hornhoof node already has it.

A change to the database schema gets a new migration from `npx drizzle-kit generate` in `apps/server`. Never edit a migration that is already on `main`.

## Rules for the code and the words

These are the same rules everyone follows, people and agents alike. [AGENTS.md](AGENTS.md) has them in short.

- Code, comments, commit messages and the README are in English.
- Every screen ships in English and Russian. A new string goes into both `apps/web/src/i18n/en.ts` and `apps/web/src/i18n/ru.ts`, in plain words a person outside IT reads without effort.
- No em dashes anywhere, in code, texts or translations. In Russian write "е" instead of "ё".
- Match the code around you: its naming, how much it comments and how it does things.
- Do not reformat files you did not change, and do not run a formatter over the whole repository.
- A screen you change must work at phone width, with no sideways scroll. Add screenshots in English and Russian to the pull request.
- Templates in `templates/` stay general, and `templates/SOURCES.md` names where each text comes from and under which licence. Do not copy text from a source whose licence does not allow it.

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
