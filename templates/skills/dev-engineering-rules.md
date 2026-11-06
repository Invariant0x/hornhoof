---
id: dev-engineering-rules
title: { en: "Engineering rules (ub-mode)", ru: "Инженерные правила (ub-mode)" }
description: { en: "Uncle Bob's ub-mode with Hornhoof's testing policy: make it work, make it right, then follow practice.", ru: "ub-mode Дяди Боба с правилами тестирования Hornhoof: сначала чтобы работало, потом чтобы было правильно, затем практика." }
kind: checklist
sources: [unclebob/ub-mode SKILL.md, unclebob/crapper README.md, unclebob/dryer README.md, unclebob/mutator README.md]
---
Every time you are asked to make a change follow:
* First Make it Work.
* Then Make it Right.
* Follow Practice

### First Make it Work

#### Laziness Protocol

* One decision lives in one place.
* Ship the smallest edit that solves the problem.

#### Foundational Thinking

* Get the data shape right before you write the logic.
* Do first whatever helps every later phase.
* If a concurrent writer would matter, do not share state.

#### TDD

* Write the failing test before you change the code.
* See it fail for the reason you expect.
* Make the smallest change that makes it pass.
* If an honest test is impractical, do not write a bad one.

#### Redesign From First Principles

* Do not bolt a new requirement onto the old design.
* Ask what you would have built if it had been there from the start, think that through, and deliver it in pieces.

#### Attack the Premise

* When two fixes that share one premise fail the same gate, write that premise in one sentence and count which actors hold the imbalance.
* Remove the assignment.
* Do not start another fix until you have done that.

#### Subtract Before You Add

* Take complexity out before you add anything.

#### Outcome-Oriented Execution

* Aim at the end state you can check.
* A break in the middle is allowed when you planned it and can undo it.

#### Build the Lever

* If the work is not obvious at a glance, build the tool that does it.
* Do one unit by hand, then make the tool match that unit.

#### Architecture

##### Model the Domain

* Put the domain in a structure that makes the illegal states impossible.
* Maintain a glossary of domain terms.
* If the code is already clear and local, leave it.

##### Boundary Discipline

* Check the data where it enters.
* Inside, trust it.
* Keep the business logic in a pure function.

##### Type System Discipline

* Make the illegal value impossible to write.
* Parse outside data once, where it comes in.
* Do not silence the compiler.

##### Make Operations Idempotent

* Running it twice, or running it after a crash halfway through, ends in the same state.

##### Separate Before Serializing Shared State

* If they do not need the same mutable thing, give each its own.
* If they do, allow one writer, and enforce that in the structure.

### Then Make it Right

#### Fix Root Causes

* Reproduce it.
* Fix the cause.
* A guard that only hides the crash is not a fix.

#### Sequence work into verifiable units

* Finish one small unit and check it.
* Then start the next.

#### Test Behavior, Not Implementation

* The test calls the code the way its user does and checks the result that user would see.
* If the test would still pass when every function returned nothing, throw it out.

#### Crapper

* Use the crapper tool
* Reduce each function under  CRAP 10 by splitting it, by testing it, or both.
* Consider whether case statements are worth reducing.

#### Dryer

* Use the dryer tool to eliminate duplication that rank 0.8 or above.

#### Mutator

* Use the mutator tool
* Run it only as T4 below schedules it, never as a task or fix-round check.
* Cover the uncovered.
* Kill the survivors.
* Delete dead code.

#### Refactoring

* Pin what the code does.
* Change the structure.
* Prove the behavior did not change.

### Practice

#### Keep a Log

* Keep a log of every action you take and the reason you took it.
* Report that log upon completion.

#### Guard the Context Window

* Keep the main thread small.
* Send the bulk elsewhere, and keep the summary.

#### Worktree Cleanup

* Find what is safe to remove, confirm nothing still in use needs it, then reclaim the disk.
* Uncommitted work waits for a decision.

#### Commit and Push

* Commit often, in small ordered commits.
* Each commit says why, what changed, and how you proved it.
* Push your branch, not the main line.

### In Hornhoof

* Run crapper and dryer through `run_tests` on a free compatible machine (hh-run-checks), from the repository root on the files your branch changed, `git diff --name-only --diff-filter=d <main line>...HEAD`: `--changed` sees only uncommitted files. Their coverage comes from the project's own test tools (vitest: `@vitest/coverage-v8` at the same version as vitest; pytest: `pytest-cov`; Rust: `cargo-llvm-cov`; Go has coverage built in). If the project is missing a coverage provider, linter (`typescript-eslint`, `ruff`, `clippy`, `golangci-lint`) or formatter settings, do not install them locally or work around them; tell the head of Development so one task adds them to the project.
* For T2 impact selection in this repository, use the explicit selector commands and helpers documented in `scripts/test/impact-README.md` as they stand instead of assuming automatic selection inside `run_tests` or the test-environment runner while that integration port is unconnected (keep unconnected environment-runner integration marked `NOT_RUN`): run `npm ci && npm run build -w @hornhoof/protocol && npm run build -w @hornhoof/node && node scripts/test/replay-impact.mjs request.json > replay.json` on the pinned candidate SHA through `run_tests` for the standalone impact report, `scripts/test/related-probe.mjs` from the repository root for Vitest related collection, and `python3 scripts/test/impact-python/pytest_impact.py` for Python package import-graph collection, then execute the selected dependent tests through `run_tests` on that exact commit. Selector collection does not execute tests or migrations. Keep an explicit project list of paths outside import graphs: migrations, schema, configuration, environment, routes, fixtures, string tables, scripts, installation, updates, shared packages, API contracts and templates. Changes to paths outside import graphs, unsupported languages, unavailable adapters or any doubt select the complete affected package; newly added test files always run even when no graph edge reaches them; database migrations run both up and down (when either direction is unsupported, report it explicitly); and one final whole-suite run on the turn's candidate remains with the test engineer.
* Push your branch, not the main line: the main line takes it after the gates and the CEO's approval.

### Testing policy

These rules fit any company, project and language.

- T1. Put logic in pure functions with direct fast tests: milliseconds, no database, network or processes. At each seam, such as a route or an outside-world boundary, use only the integration tests that cover its contract and named failures, usually one or two, and few end-to-end tests. Write no tests just for coverage. Split a function with CRAP above 10 first. Test races, locks, role permissions and migrations of existing data on the product's real database in the final run.
- T2. A task runs only the dependent tests its change affects through `run_tests`, using the project's selector, such as vitest related, jest --findRelatedTests, pytest --testmon, go test of affected packages or cargo test -p, plus types, lint, crapper and dryer on changed functions, without assuming automatic test-environment selection where that runner port is not yet connected. Paths outside import graphs, including migrations, schema, configuration, environment variables, routes, fixtures, string tables, scripts, installation, updates, shared packages, API contracts and templates, select their whole package at once, and database migrations run both up and down (when either direction is unsupported, report it explicitly). Measure selection instead of trusting it: a new test file always runs even when no graph edge reaches it; when an adapter is unsupported or unavailable, or when in doubt, run the whole package; and one final whole-suite candidate run on the turn's branch remains. When the final run finds what selection missed, record a selection miss, and treat missing comparator evidence as unavailable rather than zero misses.
- T3. Use this same check table everywhere:

| Stage | Checks |
|---|---|
| In work | Tests selected by impact, types, lint, crapper and dryer (T2). |
| After a batch merges | The batch's affected tests on one pinned commit. |
| Final turn candidate | The whole suite with typecheck of tests and every affected application, build, QA browser checks and real database tests (T1). |

  The whole suite runs only for the final turn candidate, never on a task, a fix round or a batch. Every check names its commit; its evidence counts while that is the commit being reviewed. A large run may be split across machines only when the split pays for itself and its parts take roughly equal time.
- T4. Run mutator, Stryker, PIT, Infection or mull once per release or phase, only on the riskiest pure logic and only against its fast tests; never on a task, a fix round or against tests using a database, processes or network. One reviewer named by the head selects changed pure functions without database, network or process imports by CRAP and change size, plus everything on money, access and security paths, within the release check's time budget. Skip dry code such as logs, string tables and configuration literals, with at most one mutant per line. Use covering tests and past results where the tool supports perTest and incremental runs. In monorepos run mutator from the repository root (`--root .`), selecting package tests through the workspace. Report killed, survived, uncovered, compile_error and timeout separately; compile errors and timeouts are not kills. A configuration error or zero tests fails the run. Survivors go to the line's author as direct fast tests; record why an equivalent mutant is equivalent. Only money, access and security logic blocks the release; other survivors become tasks for the next turn.
- T5. Do not mass-rewrite old slow tests. New code follows T1; rewrite a slow test only when its code is already changing.
- T6. Review asks for more tests only for a named harm to a person; low coverage alone is not a finding. Every bug fix still starts with a failing test that reproduces it.
- T7. Measure suite speed every turn. The performance line records time by package and part and tests slower than the median of its package by a chosen factor. Limits are relative, never fixed minutes.
- T8. Test checks in other departments the same way. Code checks, such as an email gate, a response gate or financial recomputation in SQL or a script, have fast unit tests, including cases they must reject. Model checks, such as ticket classification, brand and promise review or design criticism, use a versioned set of examples with known answers, labelled by someone other than its author and with a part hidden from the author. Run that set when the check, its prompt or the provider model changes, not on every item, and count false accepts and false rejects separately. The department owner sets the acceptance threshold. Every error found in life becomes an example.
- T9. Keep tests deterministic (F.I.R.S.T.): date, timezone, test order, randomness and ids do not change the result. Shared test helpers set clocks, timezone and seed. Fix a flaky test by its cause, without retries or quarantine. Once per turn, run the final suite in shuffled order.
- T10. Evidence is a run, not a paraphrase. A submission attaches the actual result and names the same commit that is reviewed; the reviewer checks that evidence instead of rerunning the tests. A result parser that counts any result a success is broken evidence.
- T11. Crapper and dryer take coverage from an already completed run and never start a second coverage run. Split a changed function with CRAP above 10; the ub-mode gates remain. A dryer flag tells the reviewer to remove the duplicate or leave a written reason; dryer compares changed code with existing code too.
