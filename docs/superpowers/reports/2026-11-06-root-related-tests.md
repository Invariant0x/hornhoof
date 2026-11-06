# Root related-test runner565

Status: IN_PROGRESS. The collection/config contracts are checked at8c22964eb0c4f1d7f8665a56dd229440c9a50368. Neither312 nor378 is a green whole run; the branch is not merged into turn-8. No full suite was executed.

## Change and API

The root vitest.config.mjs extends the existing workspace configs under five named projects: @hornhoof/server,node,web,protocol and additional node:no-proc. Test-only package/subpath aliases resolve protocol to src. Every worker is a fork and an injected workspace-directory setup preserves actual cwd-sensitive fixture behavior. Production package exports and npm test are unchanged; npm run test:related calls the root CLI.

The existing DB/basic helper bodies are moved without behavior edits. Heavy helpers retain their API through re-exports. Six light-only consumer files switch only their import: db,agent-sql-permissions,program-operator-deliveries,tree-history-query,config,tunnel. There are no assertion or deadline changes. The460 engine is not edited. Coordination with552/558 is recorded in565; its author confirmed preserving the lightweight agent-sql import on merge.

Consumer566 uses scripts/test/related-probe.mjs: `await probe(options, changedRepoRelativeString)` returns named projects and canonical repo-relative all/selected rows. Run the child with cwd at the checkout root, call once per changed path and union rows. The helper uses public Vitest APIs and never runs test callbacks. The source/API was sent early at67891 and checked collection source8c229 was handed off after312.566's later407 failed at its additional network fetch before collection; it is NOT_RUN, not proof against this source. No new fetch/credential/ref workaround was suggested.

## Selection widths

Numbers below are test-file collections, not executed test counts or performance measurements.

| Changed file | Before root, run300 | After root, run312 | After projects selected |
| --- | --- | --- | --- |
|apps/server/src/app.ts|152/476 unnamed discovery|143/429|143server; no DB-only helpers consumers|
|packages/protocol/src/link.ts|1/476, missing consuming projects|170/429|153server+16web+1protocol|
|apps/node/src/redact.ts|96/476 unnamed discovery|100/429|95normal node+5no-proc variants|

The476 unconfigured root inputs included files outside normal workspace inventories, so476-to429 is not a conservation or speedup claim. Normal workspace inventory was201server+125node+73web+17protocol=416 before; after merging upstream model-check work it is206+125+73+17=421. The five extra server files come from upstream, not the565 helper split. The root contract proves exact normal-file set equality against the standalone workspace configs and exact preservation of8 additional no-proc variants. Those variants duplicate execution modes, not new unique test files. The new two-case basic-helper test at the next source checkpoint is additional and was not part of312's denominator.

The server standalone app selection narrows148/201 before to143/206 after. Protocol selection expands intentionally to real src consumers that dist exports hid. Node's normal95-file redact graph stays broad because redaction is shared infrastructure; the root is conservative, not a symbol-level slicer. No production barrel refactor or narrower heuristic is claimed.

## Executed evidence

- Run300/1 at67891cce7c3a3ad6fe15be821a161562cc8c7060:5 intended root-contract failures; install/protocol build/script lint0. Missing projects, false app-to-DB links, missing protocol consumers, unnamed node project and actual CSS cwd failure were observed before implementation.
- Run312/1 at8c22964eb0c4f1d7f8665a56dd229440c9a50368:5/5 root contracts passed, including actual CSS3cases. Actual targeted related executions passed server77cases/3files, protocol5/1 and node160/9; no-proc48/8 passed. The170-file protocol collection was not all executed. Root checkJs, server types, test-types, changed lint and mixed dryer exited0.
-312 overall FAILED/exit3: the9-file helper/smoke selection had91pass/6fail, all tasks-merge. Coverage was not written after failure, LCOV was null and CRAP110 at0% is not a passing quality result.
- Diagnostic378/1, same exact8c229, FAILED/exit3: tasks-merge standalone via the original package config gave5pass/6fail; root9files gave91pass/the same6fail. All six error with #2 is not at your gate. This rules out the new root config as the trigger, not every possible pre565 source difference. The package control still contains the mechanical helper extraction.
-378's reportOnFailure retained an empty report. The author command incorrectly used a repository-prefixed coverage glob. [Vitest coverage docs](https://main.vitest.dev/config/coverage) state that patterns match each project root; the next narrow check uses test/helpers*.ts and keeps the report nonempty before accepting CRAP. No source or threshold change is used to hide the empty report.

Full native logs300/312/378 are on565; the JSON includes commands, stages and hashes.312 executed on platform-selected0x.local, actual Linuxarm64/Node22.23.4/Docker,8CPUs/cpuset0-7,maxCPU/memory quotas.378 executed on platform-selected0xs-MacBook-Pro.local, actual Linuxarm64/Node22.23.4/Docker,10CPUs/cpuset0-9,maxquotas,observed load1 7.61..11.66. These are actual execution facts, not exclusive physical-host claims or performance samples.

## Remaining proof and ownership

Source inspection traces the gate failure to460/c1944585a29cc27f94b2e7af22dc7250a49bc85b: repository review requires a provider independent of the author, while tasks-merge company() gives Bruno and Rita the same subscription.460's owner confirmed no active tasks-merge edit or prepared fix. Head approved the independent-review-plan patch929cdca5-6afe-4498-8270-abe9cdb72c99. It is applied as the separate commit a9adce4a255d425785682548c81a9c5a9a0fd320. The11 original test bodies remain byte-identical; production460 is unchanged. A separate regression in41191345 gives the reviewer a different Claude subscription from an Anthropic API author and expects403. Its GREEN remains pending.

Independent work continues: two fast behavior pins cover the moved until helper's asynchronous readiness and deadline, with fake timers and unchanged helper body. The corrected coverage check adds those pins, existing six light consumers and auth/setup smoke coverage. The already isolated tasks-merge failures stay explicitly separate, not erased or relabeled GREEN. Run458 collected root script coverage separately and combined it with helper LCOV without altering counters. Old heavy helper functions with unchanged bodies are reported separately from newly moved and root logic; a baseline complexity failure remains a concern, not a lowered threshold.

No formatter is configured in this source. MJS duplicate-analysis support is not proved by mixed dryer success. These gaps are reported rather than installed around. Fresh turn integration and affected checks on the exact merge SHA remain required before the task can be handed in.


## Coverage correction and exact baseline receipt

458/part1 at7fa3d6d6223d0e4d52408533b2cfef7df5ba1cd6 remains native FAILED/exit2 solely from existing-heavy-helper-crapper. All other8 stages passed. Root contracts5/5 and the selected88 helper/API cases passed. Correct project-relative include produced nonempty LCOV: basic helper lines100%/branches80%; DB helper lines60%/branches75%; probe lines/branches/functions100%. New/moved/root logic CRAPmax4.2 and dryer0. The root config factory and worker-cwd module were not present in Node LCOV; their runtime contracts are separate proof, not100% coverage claims. The untouched heavy helper openStream remains CRAP110, connectNode30 and agentSqlOn12.

473/part1 ran the unmodified shared turn-8 at exact59695b6c8c91ebd24aa71d96f8c1a891f422be92, without565's config or helper extraction. It is native FAILED/exit3: the original11 tasks-merge cases gave5pass/the same6fail; original heavy helper CRAP also failed at110 with nonempty37.3% line coverage. Complete tests-473-1.log is22095bytes, SHA25679ae8cbd61095ba39e0adab9065efc6f495422b214b7a610781f8a80fe99d03b. Thus the failure existed on the integration base containing460; the earlier reported460412/412 did not establish this family's GREEN. The base source is now directly recorded instead of inferred from a same-source package/root comparison.

The openStream,connectNode and agentSqlOn function bodies are byte-identical between473's base and the current extracted helper. Their per-function SHA256 values are in the companion JSON. The scoped CRAP failure is not removed or presented as a global passing quality matrix. No legacy helper body is refactored outside the mechanical brief.

After the approved test-only fixture commits, fresh turn-8=59695b6c was merged into task-565 without conflicts, including preservation of the coordinated lightweight agent-sql import and its two552 cases. This merge brings upstream features and test files, not additional565 optimization. The next exact candidate check will rerun the dynamic root inventory/contracts, every selected helper/API case plus tasks-merge, types/lint and changed-logic quality; no full suite or private source fetch is used.
