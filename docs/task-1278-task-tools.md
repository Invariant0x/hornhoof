# Task 1278: exact tool lists after company machine access

Kind: bug. Risk: test expectations only; no runtime permission change.
Branch: `task-1278`, from fresh `origin/turn-32` at
`cf64981ca64e5fa3e6dad5ad4171007534651e2c`.
Checked implementation: `5bcf680d6ab306a390fe441e85c3f0567dc5acc5`.
The following evidence commit changes documents and logs only.

The reproduced failure is the head's list at `tasks-tools.test.ts:99`,
not the orchestrator's list. The worker expectation has the same omission.
The orchestrator assertion already passes. The relevant files match the
reported `2f48ff9192198d6ad71f3c74b48d3a52071f0d83` baseline.

History and intent:

- `b6df22af2e4193d0d437e6922548d42d25bda634` originally gave the orchestrator
  `computer` and `computer_result`.
- `9bdde0ec1b72d063feffcbe01e1a6e2b2d255aa1` added its `machines` tool.
- `cd45dc67369c90cc4028560ad40fb47fd58c53c5` implements the on-demand shelf
  requested in #1159. The #1159 and #1163 bodies authorize the orchestrator's
  full tool and API access; they do not explain this failing head assertion.
- `9f2a7a610b8537c304cf1a98c290a1737035f975`, from #1119 and delivered through
  #1257 / `b24eafc22bebff582e2e0ee6da22a1ded11b0c04`, adds the non-orchestrator
  `registerComputerTools` call. This intentionally exposes `computer`,
  `computer_result` and `machines` to heads and workers. Item 6 of #1119
  requires company agents to use `all_agents` access, excluding assistants.
  Its `computer-scope.test.ts` MCP case explicitly checks both employee kinds.

Only the two head/worker expected arrays changed. Each still uses sorted,
exact equality with a literal list; no tool is ignored, skipped or inferred
from the actual result. The orchestrator expectation is unchanged.

Requirement to check:

- Exact lists per kind: `tasks-tools.test.ts`, 30 PASS.
- Intentional employee tools and access guards: `computer-scope.test.ts`,
  19 PASS, including refusal before `all_agents`, successful recorded command
  and result handling, exclusion of assistants/other companies, and no
  employee `ask_computer_access` tool.
- Original orchestrator computer behavior: `computer.test.ts`, 20 PASS.

RED on the base: 29 PASS, one intended failure, exit 1. Final named checks
on the checked implementation: 69 PASS across three files, exit 0.
Server types including tests, eslint of the changed test, server build and
`git diff --check` all exit 0. Commands, versions and statuses are recorded
in `docs/evidence/task-1278/checks.json`; complete output is beside it.
No full run, `run_tests` or broad author check was invoked.

Own diff and security inspection found no issue: the two changes retain
exact exposure checks and do not alter production access, identities,
secrets, dependencies or clocks. The existing scope tests check the runtime
boundary. Native `codex review --base task-1278-base` returned exit 0 but
could not read any code because bubblewrap could not create a namespace.
It is recorded as NOT_RUN, not a passing review. No sandbox bypass or system
change was attempted. Release-wide checks remain with the release owner.
