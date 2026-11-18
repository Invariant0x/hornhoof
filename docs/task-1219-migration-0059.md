# Task 1219: preserve the previous release's node data

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1219-migration-0059.md). These are historical results, not checks of the current release.

Bug, no production risk. Base: `887fa6540bad796c30ed907fb14a2b48d3f7994c`.
Checked implementation: `4ac0a495265f905777441aa1fbf295d3e0f40300`.

On clean turn `bf1ff1422851f4f0276d13881c42b16a0cf93eba`, the existing
`migrations-0050-0062.test.ts` upgrade case for migration 0059 failed, exit 1:
the later migration 0135 adds `update_wait_since: null`. The whole-row equality
mistook that new field for damage to the previous release's data.

The case now matches every previous field and the exact number of node rows,
while allowing later migrations to add columns. Empty connection history,
unchanged grants, cascading deletion and cause constraints retain their existing
assertions. The fresh-install and full-upgrade paths still run. Production
migrations and Oracle's `migrations.test.ts` are unchanged.

Requirement -> test: the existing case `starts empty on the previous release's
database, keeps its nodes, and grants no one anything` failed before the change
and passed afterwards. Then `npx --no-install vitest run
test/migrations-0050-0062.test.ts --maxWorkers=1` ran the entire named file three
times consecutively on the checked implementation: 17 of 17 passed each time,
exit 0, no excluded cases. Test-file execution took 28.000, 15.873 and 12.788
seconds; complete runner times were 33.28, 25.13 and 18.01 seconds. The records
include the SHA, command, start and machine load. Existing migration cases still
exceed the preferred one-second case budget; no timeout or timing assertion
changed. The final author-check receipt records types and lint on the final
candidate. No full suite or `run_tests` is part of this task.
