# Root related-test runner565

Status: candidate525 is remotely checked. Exact integration proof remains pending after merging the fresh turn source. The collection/config contracts are checked at8c22964eb0c4f1d7f8665a56dd229440c9a50368. Neither312 nor378 is a green whole run; the branch is not merged into turn-8. No full suite was executed.

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

Full native logs300/312/378 are on565; the JSON includes commands, stages and hashes.312 executed on platform-selectedmachine A, actual Linuxarm64/Node22.23.4/Docker,8CPUs/cpuset0-7,maxCPU/memory quotas.378 executed on platform-selectedmachine B, actual Linuxarm64/Node22.23.4/Docker,10CPUs/cpuset0-9,maxquotas,observed load1 7.61..11.66. These are actual execution facts, not exclusive physical-host claims or performance samples.

## Remaining proof and ownership

Source inspection traces the gate failure to460/c1944585a29cc27f94b2e7af22dc7250a49bc85b: repository review requires a provider independent of the author, while tasks-merge company() gives Bruno and Rita the same subscription.460's owner confirmed no active tasks-merge edit or prepared fix. Head approved the independent-review-plan patch929cdca5-6afe-4498-8270-abe9cdb72c99. It is applied as the separate commit a9adce4a255d425785682548c81a9c5a9a0fd320. At a9adce4a, the11 original test bodies remained byte-identical; production460 was unchanged. A separate regression in41191345 gives the reviewer a different Claude subscription from an Anthropic API author and expects403. Its same-vendor403 rejection passed486; the final updated expectation is pending.

Independent work continues: two fast behavior pins cover the moved until helper's asynchronous readiness and deadline, with fake timers and unchanged helper body. The corrected coverage check adds those pins, existing six light consumers and auth/setup smoke coverage. The already isolated tasks-merge failures stay explicitly separate, not erased or relabeled GREEN. Run458 collected root script coverage separately and combined it with helper LCOV without altering counters. Old heavy helper functions with unchanged bodies are reported separately from newly moved and root logic; a baseline complexity failure remains a concern, not a lowered threshold.

No formatter is configured in this source. MJS duplicate-analysis support is not proved by mixed dryer success. These gaps are reported rather than installed around. Fresh turn integration and affected checks on the exact merge SHA remain required before the task can be handed in.


## Coverage correction and exact baseline receipt

458/part1 at7fa3d6d6223d0e4d52408533b2cfef7df5ba1cd6 remains native FAILED/exit2 solely from existing-heavy-helper-crapper. All other8 stages passed. Root contracts5/5 and the selected88 helper/API cases passed. Correct project-relative include produced nonempty LCOV: basic helper lines100%/branches80%; DB helper lines60%/branches75%; probe lines/branches/functions100%. New/moved/root logic CRAPmax4.2 and dryer0. The root config factory and worker-cwd module were not present in Node LCOV; their runtime contracts are separate proof, not100% coverage claims. The untouched heavy helper openStream remains CRAP110, connectNode30 and agentSqlOn12.

473/part1 ran the unmodified shared turn-8 at exact59695b6c8c91ebd24aa71d96f8c1a891f422be92, without565's config or helper extraction. It is native FAILED/exit3: the original11 tasks-merge cases gave5pass/the same6fail; original heavy helper CRAP also failed at110 with nonempty37.3% line coverage. Complete tests-473-1.log is22095bytes, SHA25679ae8cbd61095ba39e0adab9065efc6f495422b214b7a610781f8a80fe99d03b. Thus the failure existed on the integration base containing460; the earlier reported460412/412 did not establish this family's GREEN. The base source is now directly recorded instead of inferred from a same-source package/root comparison.

The openStream,connectNode and agentSqlOn function bodies are byte-identical between473's base and the current extracted helper. Their per-function SHA256 values are in the companion JSON. The scoped CRAP failure is not removed or presented as a global passing quality matrix. No legacy helper body is refactored outside the mechanical brief.

After the approved test-only fixture commits, fresh turn-8=59695b6c was merged into task-565 without conflicts, including preservation of the coordinated lightweight agent-sql import and its two552 cases. This merge brings upstream features and test files, not additional565 optimization. The next exact candidate check will rerun the dynamic root inventory/contracts, every selected helper/API case plus tasks-merge, types/lint and changed-logic quality; no full suite or private source fetch is used.


## Current candidate486 and remaining precise blocker

486/part1 at57ce0474ec21f13f1a561d29c11483aac83e0367 remains native FAILED/exit1:105pass/1fail across10 affected files,106cases. The tasks-merge family is11pass/1fail, including successful403 rejection for the distinct Claude subscription of the same vendor. The six original gate refusals are gone; five of those original cases fully pass, while the first now reaches a later exact-event assertion. It receives the review field that460 adds to merged submission events. The old expected object has only evidence and merged. The assertion has not been weakened or changed.

Every other486 stage passed: root contracts5/5 on the fresh inventory, typecheck:tests, changed lint, changed-logic CRAPmax6.0 and dryer0. The legacy heavy-function110 result remains independently recorded in458/473;486 does not claim a globally green quality matrix. Original helper/data assertions, individual deadlines and production gateAuthorVendor/independentProvider are untouched.

Full tests-486-1.log is287938bytes, SHA256e1945b5e2614626bae79ee914960a01beaf6af26ee69a1f9af1aeef47e8cd88b. Its only failed stage is helper-coverage-project-relative. Full raw log, nonempty LCOV and all stages/resources are preserved. Later upstream changes explain the selected106-case denominator; it is recorded from the actual output, not the earlier100+2 estimate in the command scope label.

The latest graph at this source is:

| Input | Selected/total | Project rows |
| --- | ---: | --- |
|apps/server/src/app.ts|151/448|@hornhoof/server=151|
|packages/protocol/src/link.ts|178/448|@hornhoof/protocol=1, @hornhoof/server=161, @hornhoof/web=16|
|apps/node/src/redact.ts|104/448|@hornhoof/node=99, @hornhoof/node:no-proc=5|

The head explicitly required the original11 checks unchanged. The approved929 fixture patch cannot repair this later payload expectation without changing an assertion. The concrete NOT_APPLIED proposal4b6dc349-2652-4106-82ea-23332e2405dd keeps the full final toEqual and the existing evidence/merged checks. It additionally validates the complete initial review shape, its source/author/SHA/quality/count fields and UUID, then requires the merged event to retain that exact review object. It does not use toMatchObject, discard the review field or edit the engine. Only head can extend the original assertion boundary. That restriction was subsequently answered by head below; no turn-8 push has yet occurred.

The stable collection API at57ce0474 remains available to566. The root runner is not declared a full565PASS; the original broader failed runs and the newly exposed expectation failure remain in the evidence.


## Head-approved exact expectation and final command

Head565 at2026-11-06T04:48:14.904Z approved4b6dc349: the extra review is a lawful460 addition and the stronger full toEqual keeps evidence and merged. Applied as separate2bbd71cc; the other10 original test bodies and every original deadline stay unchanged. The new initial-review shape assertion also verifies the pinned UUID/source/author/quality/count fields before requiring that same review object on merge. No production engine change is part of565.

Head explicitly accepted the legacy helper CRAP110 exception while those bodies remain unchanged;473/458 retain the actual failed broad scans and numbers. No unrelated heavy helper is refactored and no threshold changes. Fresh turn-8=38247b5c9c8f12e89d7634acdd412327087c0862 merged cleanly into task-565. Its urgency/outbound features are upstream composition, not565 work.

The task-specific targeted authorcheck recipe is2026-11-06-root-related-authorcheck.sh.txt. It uses the ordinary run_tests command-mode only and is reused on the exact candidate/merge sources: lock install, protocol+node preparation, root inventory/selection/CSS contracts, helper/API and merge-family coverage, representative actual related server/protocol/node callbacks, all existing no-proc variants, a real web Setup unit consumer, types/test-types/lint and changed-logic CRAP/dryer. It does not execute a full suite or silently waive a failed stage. The established head exception for the unchanged heavy functions is printed separately in scope metadata. New recipe invocation and updated expectation GREEN remain pending until the full native log is read.


## Cancelled broadened smoke507 and bounded replacement

507/part1 is native STOPPED, not PASS, on source e2bae7a271517a5126d4c9d00f172b5a6ff1f33d confirmed by the command guard and scope line. The complete425466-byte native log has SHA2566404e49a3bcb55ec2e3f040b4da01270093a02c3ea0404eabf22015b10b8f087. Install, protocol/node preparation, five root contracts and all106 selected helper/merge cases passed before cancellation, including the approved exact-review expectation and same-vendor403. Later quality stages were not reached.

The previous representative score.ts related command became broad on the newer integration source through timers/store/app imports. The author stopped it instead of completing an unnecessarily broad authorcheck. Its unfinished output reports conversation.test.ts61cases/1failure, with the marked case opening a new session after a subscription change. Cancellation preceded the final error details. This remains partial failing evidence, not an unrelated test silently relabeled green. No conversation assertion or production code is edited by565.

The recipe now uses the isolated benchmark/report.ts production module for server related execution. Before each server/protocol/node related callback run, the public collection probe must match an explicit expected file set. A mismatch makes the authorcheck fail and skips that callback invocation; it never filters away tests from a related run. This prevents another upstream graph expansion from turning this targeted check into a broad suite. The expected lists are printed with actual selection; the server list is one release-benchmark file, protocol one link file, node the established nine load consumers. The corrected recipe still requires exact candidate/merge native proof.


## Candidate525: exact approved assertion GREEN

525/part1 at62264631b61e79cedd413765400fdf8682e52f5f is native PASSED/exit0. All17 stages exited0. Complete tests-525-1.log is319116bytes, SHA25615699a0217fa80fef5014538ea0dca676f5640a48110fff0b91ccf490cc01048. Five root contracts passed; ten helper/API files106cases passed, including all12 tasks-merge cases and the same-vendor403 rejection. Thus the six original gate failures and the later lawful460 review-field mismatch have an observed RED-to-GREEN path, with the approved test-only fixture and stronger full expected object.

The three selection guards matched exactly before callbacks: benchmark/report selects one file/eight cases, protocol link one/five, node load nine/160. Existing no-proc variants eightfiles/48cases passed, as did web Setup22cases and actual CSS3cases inside the root contract. None of the protocol's181 collected consumer files was automatically executed as a whole suite. Root checkJs, server/web types, test-types, changed lint, changed-logic CRAPmax6 and dryer0 passed. Coverage remains nonempty: basic lines100%/branches80%, DB lines60%/branches75%, probe lines/branches/functions100%; factory/worker-cwd coverage limitations remain. Legacy heavy-function110/30/12 is the explicit head exception, not a globally green quality claim.

Normal inventory is219server+131node+73web+21protocol=444 files, exactly preserved under root, plus eight existing no-proc execution variants=452rows. Actual root widths: app154/452, protocol link181/452, node redact104/452. Inventory growth from earlier points is upstream composition, with no tests dropped by the root configuration.

Actual execution was platform-selectedmachine B, Linuxarm64/Node22.23.4/Docker marker,10CPUs/cpuset0-9,maxCPU/memory quotas, observed load1 6.76..10.68. This is targeted correctness evidence, not a performance comparison or exclusive-host claim. Fresh turn-8=3c9d1dd8 was merged without conflicts after525; it adds independent-part and command-guard work. The unchanged recipe and tests require a new exact integration receipt before turn-8 publication and handoff566.507 remains STOPPED with its partial unrelated conversation failure; no claim about that family's GREEN is made.
