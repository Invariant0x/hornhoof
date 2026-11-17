# Tests for task 1237

DONE_WITH_CONCERNS on `5fccde4cc1fd576f7ed7ae29b2949f62054f5fac`, base/parent `11aa5777c4a5f74a550c0e53570ec35ebae39f53`. Exactly two assigned paths changed: agent-sql.ts and the new orchestrator-sql-agent-changes.test.ts. Review and Security independently passed this candidate; their records and the Head's scope decision are saved in gates-and-scope.json. Tests changed no product code.

Read all six complete final author logs. They each name the exact candidate, clean tree, cwd, literal command, memory setting and actual exit 0. Existing passed executions were reused rather than repeated:

- From apps/server, `npx vitest run test/orchestrator-sql-agent-changes.test.ts --maxWorkers=1`: 1 passed.
- Same command with orchestrator-sql-secrets.test.ts: 1 passed; head-department-control.test.ts: 7 passed; department-owner-control.test.ts: 11 passed. Each invocation names one file. All have NODE_OPTIONS = --max-old-space-size=4096 and an outer timeout in the saved command.
- From the repository root, `npx tsc -p apps/server/tsconfig.eslint.json --noEmit` and `npx eslint apps/server/src/db/agent-sql.ts apps/server/test/orchestrator-sql-agent-changes.test.ts`: exit 0.

The 20 tests cover role grants, ordinary server staffing and department authority. The new test refuses INSERT, INSERT SELECT, changes to author/content, DELETE, TRUNCATE, CTE writes, MERGE and a DO block. It preserves SELECT and the seeded row, checks table/column privileges and refuses a write after legacy table grants are restored and grantsFor is applied again. It uses effective SET LOCAL ROLE transactions on PGlite with ownDatabases isolation, not a running native PostgreSQL login. There are no time waits in this new case. Normal server writers remain on the trusted connection.

Read the final RED on base sources with the final test: an inserted forged row resolves with affectedRows 1 instead of the required rejection, exit 1. Its only working-tree addition is the new test. The source patch matches the Git diff byte for byte. The draft RED and pre-commit GREEN are retained but not used as final proof.

No migration is needed for the existing table-wide grants: openRoles calls grantsFor on startup; its initial REVOKE clears previous table grants, and READ_ONLY then restores SELECT. The upgrade case exercises that path. The lockfile and migrations are unchanged; deps.log records lockfile preparation and workspace builds on the base. CTE and DO statements do not elevate the role; the reachable net.assert_lease functions do not write agent_changes, and its foreign keys have no cascade deletion. These last points were inspected, not a new native database execution.

Executed `python3 docs/tasks/1237-tests/verify.py`, exit 0: 13 saved record hashes, two candidate source hashes, exact parent and source patch, six exact-version receipts, 20 passed tests and behavioral RED. audit.json retains each command, cwd, file runner time and every printed test over one second. This is a record audit, not another product run.

Concerns:

- T5 is NOT_PASS. The Head explicitly accepted the new real-role DB case as an exception at 09:49:17 UTC: case 2850 ms, reported test-file time 2854 ms, runner 15.93 s. Other recorded overruns are kept separately: secrets case 2527 ms; head cases 5753, 1600 and 1251 ms, runner 35.90 s; department case 4203 ms, runner 32.02 s. Their reported test-file times are 12.193 s and 9.072 s. Load was not recorded; no load-causation or timing-stability guarantee is claimed.
- The Head explicitly kept writable turn_releases and task_routes outside this repair for separate work. The base role probe and static grants show these rights; no exploit of those paths is claimed here.
- No live PostgreSQL, final combined release candidate, full suite, run_tests or integration was checked. This candidate precedes the separate head-history feature; its future merged SHA still needs the release owner's checks. Native first-look review in earlier gates could not inspect the diff because of bwrap; the recorded manual Review and Security passed.

Evidence lives on task-1237-tests-logs. The task-1237 product candidate remains unchanged. The Head owns integration for the next turn; nothing was pushed to turn-31 or main.
