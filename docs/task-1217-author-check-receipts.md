# Trusted author checks before skipping Review

Task: #1217. Inspected base: `c546bfe3bfe20ff86b9889d7ee5d7bb10fc9b1a6`.
Branch: `task-1217`, created from `origin/turn-31`. This work belongs to turn-32;
it must not be integrated into turn-31. After 0.31.0, take in the released main.

## Finding

The server has no trusted record of a local `check:author` result or its CRAP
measurement at the candidate SHA:

- `scripts/author-check/wired.mjs`, `check`, prints `AUTHOR_CHECK` JSON and returns
  the command's exit code. It sends nothing to the server.
- `scripts/author-check/stages.mjs`, `finished`, records submission and check SHAs,
  stage outcomes, paths and `worstCrap`. It supplies no base SHA, trusted producer
  identity or server receipt ID. It also drops the stage reason codes from JSON.
- `.hornhoof/author-check.md`, "What it prints", explicitly says the record has
  no run ID, its part IDs are null and the server stores none.
- `apps/server/src/modules/tasks/review-context.ts`, `ReviewRecord`, keeps the
  pinned commit, branch, author and source comparison. It intentionally excludes
  the former quality and author-run fields.
- `engine.ts`, `submitCandidate`, stores the author's evidence string and the
  immutable candidate, then calls `forwardHandoff`. An evidence string is not an
  execution receipt.
- No `check:author`, `AUTHOR_CHECK` or author-check receipt handler was found in
  server source, node source or the protocol. Existing test-run receipts prove
  their assigned test selections, not this local command or its CRAP result.

Implementing a skip from `submit.evidence`, an uploaded JSON file, a cherry-pick
trailer or an exit code alone would not satisfy the task. Review must remain
required until a trustworthy producer is available.

## Smallest proposed addition

Use the existing authenticated node connection to report one local author check.
Keep execution in the executor's workspace, before submit. Do not add remote
quality runs, restore `quality/runs`, or run checks as a submit side effect.

1. The server binds a request ID to company, task, executing job and node,
   repository identity, branch, base SHA and candidate SHA. The command is fixed
   to the author-check entry point, with no arbitrary command argument.
2. The node owns execution and captures the process status and structured
   result itself. An agent cannot supply a completed result. Verify the
   workspace's repository, clean candidate checkout and base before execution,
   and reject any changed checkout after execution. Execution needs workspace
   exclusion so another writer cannot change checked inputs during the run.
3. The node sends the bound result on its authenticated connection. The server
   validates the assigned node/job, request ID, repository, both SHAs, stage
   outcomes and completeness before recording an append-only task event.
   Repeated delivery of the same request is idempotent. Other nodes and jobs,
   stale revisions and malformed or partial results cannot create a green
   receipt. The trusted runner must also pin the accepted check definition;
   running candidate-controlled code that merely prints a green record is not
   sufficient proof.
4. Extend the structured result with base SHA, stage reason codes and explicit
   CRAP measurement applicability/completeness for new or grown functions.
   Retain unknown values as unknown. A recorded failure, cancellation, missing
   output or unavailable required stage keeps Review.
5. At a Development handoff, read a matching receipt for this repository and
   exact base/candidate comparison. A successful eligible handoff skips only
   Review with `author_check_passed`, referencing the receipt event in the
   submission log. Security and Tests retain their existing ownership and
   mandatory conditions. Preserve candidate ancestry, revisions and turnkey.

This needs task-owner agreement to extend implementation beyond the assigned
server task modules into the node, protocol and local author-check result.
The concrete request transport and accepted check-definition identity must be
chosen before implementing that channel.

## Eligibility after the receipt exists

Eligibility is `small: true`, or a nonempty complete delta entirely under
`docs/`, or a verified identical cherry-pick patch. A cherry-pick trailer may
identify a proposed source, but cannot prove equality. Compare the original
parent/source and candidate base/head changes, including paths, modes, renames
and binary content; incomplete comparisons keep Review.

`worstCrap: null` currently has several meanings. In particular a docs-only
change has no source functions and reports `no_source_changed`, while missing
measurement can also be null. A typed explicit no-functions result may satisfy
the vacuous CRAP condition, but unknown measurements must never become zero.
The owner must settle which declared nonapplicable stages count as a green
author check; the existing documentation calls unavailable stages partial even
when the process exits zero.

## Verification to perform after the contract is settled

Use named local files with controlled clocks and recorded process/network
samples. Observe RED on the original route, then GREEN for small, docs-only,
identical and changed cherry-picks, CRAP below 10 and at/above 10, absent/stale/
forged receipts, Security retained for every non-none risk, and unchanged
turnkey. Check the actual log reason and receipt reference, candidate ancestry,
repeat submission, and rejection of receipts from another task, repository or
node. Run affected caller files, server build, server types, changed-file ESLint,
crapper and dryer. Broader node/protocol checks depend on the approved channel.
No whole suite or `run_tests` is part of this task branch.

The existing baseline files are
`apps/server/test/development-echelons-fast-route.test.ts` and
`apps/server/test/development-echelons-turnkey.test.ts`. They characterize the
current mandatory Review and turnkey route; they do not prove the proposed skip.

## Baseline evidence

On `c546bfe3bfe20ff86b9889d7ee5d7bb10fc9b1a6`, after `npm run -s deps`,
the following command ran in `apps/server` and exited 0:

```sh
npx --no-install vitest run test/development-echelons-fast-route.test.ts test/development-echelons-turnkey.test.ts
```

Complete runner output:

```text
 RUN  v5.0.5 /data/work/agents/4dc88cc7-213b-4828-9023-e7f5ced48683/hornhoof/apps/server

 PASS test/development-echelons-turnkey.test.ts (9 tests) 2503ms
   PASS a task of a turnkey team never enters the echelons (9)
     PASS gets no echelon route, whatever its text says, and its holder closes it alone 1464ms
 PASS test/development-echelons-fast-route.test.ts (8 tests) 1619ms
   PASS echelon route without idle handoffs (8)
     PASS collapses Architecture into Development when both belong to the same executor 908ms

 Test Files  2 passed (2)
      Tests  17 passed (17)
   Start at  04:06:17
   Duration  12.65s (tests 54%, import 29%, transform 17%)
```

The output above substitutes `PASS` for the runner's checkmark glyphs. The first
turnkey test took 1464 ms, over the company's 1 s per non-browser test budget;
its file stayed under 30 s. No production or test source was changed. This is
baseline evidence only. RED/GREEN for the requested shortcut, build, types,
lint and quality checks of an implementation remain NOT_RUN until the trusted
receipt contract is settled. `git diff --check` passed for this note.
