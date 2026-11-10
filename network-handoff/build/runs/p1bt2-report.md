# Plan 1b Task 2 report (writer)

Status: DONE

Read first: CLAUDE.md, the brief, hornhoof/AGENTS.md, templates/skills/dev-engineering-rules.md, and the skills test-driven-development, systematic-debugging, verification-before-completion.

## Files changed (lane /home/altera/hornhoof-network/wt/p1bt2)
- apps/server/src/app.ts: `Deps.onRoute`, wired with `addHook('onRoute')` right after Fastify is created; new `publicRoutes` (health, version, robots.txt).
- apps/server/src/web.ts: `x-robots-tag: noindex, nofollow` in SECURITY_HEADERS.
- apps/server/test/before-sign-in.test.ts (new), apps/server/test/static.test.ts (x-robots-tag expectation).

## Tests and how they failed first
- health over the link: got `version` and `commit` besides ok.
- version over the link without a session: 200 instead of 401.
- robots: `/robots.txt` was 404; static test: `x-robots-tag` undefined.
- the sweep test: failed first on missing `onRoute` (0 routes seen), then on unknown parameters, then on the unlisted PUBLIC routes; with PUBLIC filled it passes. No route leaks the company (nothing to escalate to the lead).
- `urlsOf` (pure function) has its own two tests.

## Runs
- light.sh vitest: before-sign-in, health, version, static: 4 files, 20 tests pass.
- `npx tsc -p apps/server/tsconfig.json --noEmit`: empty. `npm run typecheck:tests`: no errors. eslint on the four changed files: clean.
- remote gates (gates-hornhoof.sh lanebase server, label p1bt2-gates3): exit 0. Crapper: highest CRAP 7.0 (webAppRoutes, unchanged); changed functions 1 to 6. Dryer: no duplicate candidates.
- Mutator not run (rule).

## Notes and deviations
- PUBLIC list (filled from one run): GET/HEAD `/*`, `/api/health`, `/robots.txt`, `/api/setup`, `/install.sh` from both origins; GET/HEAD `/api/version` local only; POST `/api/auth/logout` both. `/install.sh` and logout were not named in the plan's examples.
- `:teamId` is a route parameter that the plan's map lacks; it is filled with the same ids as `:id`.
- Route methods arrive as arrays (`HEAD,GET`); the test splits them.
- `typecheck:tests` and `lint` are root scripts, not server scripts. The gates script wants test paths relative to apps/server.
- Not committed or staged.
