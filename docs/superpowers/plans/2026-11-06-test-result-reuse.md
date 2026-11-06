# Reusing green test results

**Goal (task 642):** a test file does not run again when its code did not change; every five turns everything runs; mutation only on changed risky logic; Hornhoof runs groups in parallel on free machines and collects the result, and the agent joins at what failed.

**Architecture:** `run_tests` without a command already pins a commit, describes its environment on a node, plans parts for free machines and collects the result. This work puts the reuse inside that path: the node also answers with a fingerprint per test file, the server keeps green results by fingerprint, plans only what has none, and ends a run that has nothing to do at once. Manual commands are untouched.

**Spec:** the body of #642. Groups belong to #640 (`task-640`), the harness to #641 (`task-641`).

## Decisions

- **Fingerprint** = the test file, the tracked code it reaches, what #309 says the graph cannot see for its package, and the environment version. Git object ids hash the content, so nothing is installed and no repository code runs while describing.
- **Graph.** For JS/TS a scanner over pinned blobs follows imports and path literals, and leaves out imports of types alone, as Vitest's graph does. `scripts/test/test-fingerprint-graph.test.mjs` holds it to the real Vitest graph of #309: any edge Vitest sees, it must see too. Anything it cannot read (a computed import, an unknown package, a program in another language) makes the inputs the whole of the test's package and of that file's. Data leads nowhere. A test in another language gets its whole package without parsing. A folder or pattern named from the repository or the package counts, except a package's own folder, and a pattern outside a test folder only as `import.meta.glob`: elsewhere it is a rule about paths, and following those made a README edit rerun 271 files.
- **Out of graph.** `selectAffectedTests` answers, per tracked path, which packages #309 takes whole for it, so #640's rules apply without a second list. What such a file runs counts with it: what it imports and the files it names one by one, not the folders, packages and test files it names to say where tests are. A rule that gives a package a file of another one takes that file alone. Without these limits the root configurations reached 1822 files and any edit reran everything; `scripts/test/test-fingerprint-graph.test.mjs` now holds it on the real repository.
- **Environment version** = runtime versions as a node reports them (not architecture or libc: a result stays good across machines of one release, and the full run catches the rest), dependency inputs and the suite's command.
- **Full run.** `execution.fullRun` in the manifest: `{ everyTurns, replaces, profile }`. A run of `replaces` on a due turn runs as `profile`, reading no reuse. Due: a multiple of `everyTurns`, or that many turns since the last full run, and not when that turn already had one.
- **Mismatch.** A full run still looks up what it would have reused. A file that fails there is a mismatch: named in the result, shown in `test_run` and counted as `selectionMisses` in the turn's report, which has no number unless a full run got to compare. A file that fails at a fingerprint loses its green result there in any run.
- **Trust.** A job writes its own report, so what a task branch says could reach a later commit. A release's profiles (`replaces` and `profile`) take a result only from the main branch or the turn's. A task branch cannot change such a result, only the main line leaves a suite's memory, and only a full run of the turn's branch that got to everything counts as the turn's. Other profiles reuse what any branch proved. Code merged into the turn's branch is trusted as that branch is, until the review of the turn.
- **Per file.** A runner says how each file went in the file `$HH_TEST_REPORT` names, one contract for every language, so the passing files of a failed part stay green. A runner that writes none counts per suite, and a suite that failed with no file named proves nothing of any of them.
- **Mutation** is a suite whose units are risky source files, with a fingerprint of the file's own text and the fast tests that reach it. Unchanged file: its result is reused, and its one-line note (killed, survived) is shown again. Changed file: mutator's own snapshot, carried by `suite.keep` between runs, reruns only survivors and rewritten functions. From a snapshot the tool skips its baseline and keeps old kills, so the runner runs the tests first and judges a file whole when its tests changed. A full run carries no snapshot. A survivor is a finding and not a failure: T4 decides what blocks.
- **Browser.** Suite `browser` (one look) in `final`, suite `browser-matrix` (every other language, theme and width) only in the full profile. `scenarioSources` ties a scenario to the screens named like it, or to all of them. A rule may give every scenario a shared source, which then counts by itself. The real server scenarios build the app they open.
- **Profiles and services.** A result holds across the profiles of its suite, or `final` could not reuse what `fast` proved. Only `server-postgres` reads the database, so here nothing depends on that; a manifest keeps tests that read a service in a suite of the profiles that open it.
- **Final checks** run whatever was reused, as no test file proves them.

## Steps

- [x] Protocol: fingerprints on `tests.described`, per-file outcomes and kept files on `tests.done`, kept files on `tests.run`, `execution.fullRun`, `suite.scenarioSources`, `suite.keep`.
- [x] Node: graph and fingerprints, batch blob reads, fingerprints on describe (failure never fails the run).
- [x] Server: `test_file_results`, `test_suite_memory`, reuse decision, planning only misses, a run with no parts ends at once.
- [x] Server: recording green, full run on the due turn, mismatch report, `selectionMisses`.
- [x] Node: per-file report of the runner, kept files in and out.
- [x] Repository: manifest profiles and suites, Playwright projects, `scripts/mutation/run.mjs`.
- [ ] Rules in templates, docs, measurement of two runs in a row on one machine.

## Review focus

- A run where everything is reused still ends, tells its agent and frees its wait.
- A file skipped wrongly is the one real harm: every path of doubt must widen, never narrow.
- A part that lost its machine or checked another commit records nothing.
- A node of the release before cannot read a manifest with these fields, so its description fails openly: server and nodes update together. A node that sends no fingerprints runs everything.
- The report file is written by the job user: the node opens it without following links.
