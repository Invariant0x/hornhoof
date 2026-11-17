# Independent review of iv-orchestrator-all, parts 1 to 3

Task: #1204. Reviewer: Architect. Date: 2026-11-17 UTC.

## Verdict and versions

**FAIL on branch `6c0cbd7271a3ad6a8d61647a2f7345c830c6eeb1`.** The column-name filter does not prevent secrets in readable JSON payloads, and grants from the same initialization block keep excluded hash columns readable. Security #1207 reproduced and repaired these defects, but its SQL patch is absent from the pinned integration snapshot. This report does not grant release approval.

The #1204 review work is **DONE_WITH_CONCERNS**: two additional defects were repaired locally with RED/GREEN evidence. The repair branch requires independent Review and Security before shared integration. Remaining SQL work belongs to #1207; it was not duplicated here.

- Reviewed remote branch: `origin/iv-orchestrator-all`, `6c0cbd7271a3ad6a8d61647a2f7345c830c6eeb1`.
- Integration snapshot and task base: `887fa6540bad796c30ed907fb14a2b48d3f7994c`.
- Last fetched turn snapshot: `0a774b86a645cb77a52bbaa3274d1183d02ebeda`. It was not silently substituted for the tested snapshot.
- Initial repair: `88c4e9371f77e1e9dff85700195f2a761cacd679`.
- Final executable repair: `2ac75e76e9ec7e7171a12fb35de5b0807fd3fcbe`; strengthened regression: `80aa63bae277e64373e69b0ceea7048664ef42d0` on `task-1204`. Later report-only commits preserve these executable inputs.
- After `git fetch -q origin`, `git log --oneline origin/turn-31..origin/iv-orchestrator-all` printed no commits. Both initial and closing fetches found the same branch tip. The required missing-commit list is **none**.

The present merge base is the already-integrated branch tip, so the literal requested merge-base diff is empty. To avoid treating an empty diff as a review, I also inspected the historical parts:

1. `c58b9ed6d2eeac049da11646ab0ef7469542ec4b..fefae00726501550bdf6597620cc2b4cb35d2f56`.
2. `41baacd7b4b59350a1c91418d6020ba182fbdd67..5996005a62d9720e2847c5ddc8910c82f7272261`.
3. `d93bd85920ce4d33c0a8bb5e954c306d1f4e8413..6c0cbd7271a3ad6a8d61647a2f7345c830c6eeb1`.

Relevant commits include `04bb20f08` (owner API), `df92a23e3` (removal of orchestrator refusals), `fcc48aded` (own decisions), `8ffb69079` (source/log tools), `f73e17515` (SQL reads), and `40e4a01f3` (decision marker). Runtime checks below ran on the integration snapshot and its repairs. They are not a claim that the complete historical branch test suite was executed.

## Findings and disposition

### F1. Department head decisions are shown as orchestrator decisions

**Severity: P2. Fixed in the executable repair above.**

At the reviewed tip, `apps/server/src/modules/tasks/views.ts:266` used `r.answeredByAgentId !== null`. A department head answering for an authorized person also has an `answeredByAgentId`, so the request received the false label “decided by the orchestrator”. This misstates the author even though the durable answer row and task log retain the head identity.

The regression creates an authorized head decision, an owner-API orchestrator decision, and a direct human decision. Before repair the head label was `true` instead of `false`. The repaired view loads answer agents together with other task references and checks membership in the actual orchestrator IDs. Final locations: `apps/server/src/modules/tasks/views.ts:101`, `:134`, `:242`, `:269`. Human and head labels are false; the orchestrator label is true, including in the task log. No decision authority is expanded.

### F2. Malformed forged internal header returns 500

**Severity: P3. Fixed in the executable repair above. No demonstrated authentication bypass.**

`apps/server/src/auth/internal.ts:24` compared JavaScript character counts before passing UTF-8 buffers to `timingSafeEqual`. A forged header with 64 Latin-1 characters has 128 UTF-8 bytes. It passed the character-length guard and raised a length exception, producing HTTP 500 instead of the normal unauthorized response.

The repair checks the input type, constructs its bytes once, and compares byte lengths before the constant-time comparison (`auth/internal.ts:24` to `:26`). The regression observes 401 with `signed_out` for ordinary and multibyte forged values. The process secret is neither exposed nor made caller-selectable.

### F3. Name-based SQL filtering leaves secrets in ordinary payload columns

**Severity: P1, blocks PASS of the original branch. Already owned by #1207.**

`apps/server/src/db/agent-sql.ts:150` to `:187` grants reads by column name. `assistant_events.data` can contain bearer file links, and `tool_calls.answer` can contain authorized password/file responses. Neither column name matches the key filter. Aliasing or JSON extraction therefore reads those values without touching an excluded column. Assistant callback/skills URLs can also carry query credentials.

Security's actual RED logs, source regression and report were read, not inferred from a task status. Patch `1fc8a035544758c30fa02d162b5662de5186dcb8` closes these payloads and assistant URLs. That patch is not an ancestor of the #1204 checked code. Its passed checks prove that patch, not the unrepaired original SQL files in this task.

### F4. Grants of the same block keep key-named hash columns readable

**Severity: P2, blocks the stated “all key columns closed” invariant. Already owned by #1207.**

`apps/server/src/db/agent-sql.ts:137` starts with `REVOKE ALL ON ALL TABLES`, and that does remove column privileges left by an older build too (Review probe on the base, recorded in #1207: a `GRANT SELECT (password_hash) ON people` is gone after `grantsFor` runs again). The hashes stay readable because of grants made later in the same block, before `readAllButKeys`: the column grants built by `visible()` leave out only the `SECRET` columns, and the table-wide grants of `eachTable` cover every column. So `jobs.instructions_hash`, `test_runs.environment_hash`, `test_file_results.repo_url_hash` and `test_suite_memory.repo_url_hash` were readable. These are metadata hashes; this report does not claim that a leaked authentication token was found in them. The violation is still real because the agreed rule excludes every `*_hash` column.

Patch `1fc8a035544758c30fa02d162b5662de5186dcb8` revokes SELECT on each table that has key columns inside `readAllButKeys` and grants back only its other columns. Its regression also reintroduces old grants and checks that rebuilding closes them again. Do not duplicate or integrate that patch from #1204; its own Review/Security route remains authoritative.

### F5. Open question, outside the scope of #1204

`apps/server/src/modules/assistants/setup.ts:45` to `:46`, `guardManager`, still returns `assistant_not_allowed` for `me.via`. The owner API cannot create/configure assistants or issue/revoke their keys through POST `/api/people/assistants`, PATCH `/api/people/:id/assistant`, and POST/DELETE `/api/people/:id/key`.

The Head explicitly directed that this guard remain an intentional exception for now, because these actions issue the owner's credentials. The Head has asked the orchestrator about policy. Removing it would be a separate task with Security. It is not an unresolved implementation obligation of #1204 and was not changed here.

## Owner API boundaries and attribution

The authorization chain is the running job's bearer token, the database-loaded agent kind/company, orchestrator-only tool registration, and process-only internal headers. `apps/server/src/modules/tools/job.ts:48` derives the identity from jobs joined to agents; model arguments do not choose it. `tools/mcp.ts` gives the owner API/shelf only to the orchestrator. `tools/shelf.ts` retains the caller identity when loading a department tool and checks that department's company.

`tools/control.ts:129` to `:145` accepts method, path and JSON body, not caller-supplied authorization headers or `me`. It parses the path and injects only the pathname/query into the local application. A supplied URL host is not used as an outbound target. Non-API paths and the declared indefinite streams are refused. `send` at `control.ts:408` selects the owner of `job.companyId`, with the person route enforcing active status; model-supplied company/via/agentKind values do not replace that identity.

Executed boundary tests show:

- Worker and head cannot list or call `api`, directly or through `use_tool`.
- Forged external internal headers fail authentication, including the multibyte case after F2.
- A second fixture company's orchestrator lists its own owner, does not list this company's owner, and cannot change this company's ordinary person's title by guessed ID; the same edit succeeds for the local CEO. Both companies are synthetic test records.
- Existing decision/request tests refuse other-company requests and callers without decision rights.
- The generic orchestrator answer is retained as the owner's decision with an explicit orchestrator marker; head delegation remains attributable to the head. `decision-context.test.ts` also checks the person/turn provenance and that a recorded answer does not fabricate a human machine permission.
- Existing control tests verify orchestrator attribution for employee changes. Outbound setup records keep `personId` and `agentId`. An ownership field such as `createdBy` is not itself proof of an incorrectly attributed audit event.

These are tested representative boundaries and inspected registration paths, not a proof of tenant isolation for every route.

## Data reaching the model

`reports/task-1204/api-data-inventory.csv` gives 42 route groups, returned fields, access conditions and source locations. It includes both direct credential responses and containers for arbitrary private text. No real secret values or user data were copied into it.

Concrete credential paths now available to owner API include invite issuance, GET `/api/nodes/commands` (decrypted one-use join codes), POST `/api/nodes/join` with a valid code (new node keys), and POST `/api/backups/recovery` when authority/lead prerequisites hold (a new private recovery identity and configured relay link credentials). The dedicated machine-command tool's “shown to CEO” answer is not a boundary against later generic API reads: `orchestrator-control.test.ts` explicitly tests that GET `/api/nodes/commands` returns the commands to the orchestrator. I did not call these routes against the live company or change their semantics.

GET `/api/me/key` returns the public key and encrypted wrapped private key with KDF parameters. Vault HTTP routes return entry metadata/login and audit, not passwords/TOTP seeds. Google/GitHub/Telegram/plan view responses return metadata and masked key suffixes rather than their stored plaintext keys. Callback/repository/API URLs may themselves embed caller-provided credentials; a URL field is not guaranteed secret-free.

Personal/internal content includes People email/Telegram identities, plan account emails, outbound recipient addresses, task/request/notebook text, conversations, feedback, job output, authorized attachments and phone screens/recordings. Existing route and event masking still applies. Owner API's 30,000-character output cap is not redaction. Keeper/node/job/assistant-token routes do not become authorized merely because an owner header was injected.

This inventory records the implementation of Ivan's unrestricted orchestrator decision. It does not propose reintroducing a blanket prohibition. The already-owned outbound address policy question remains #1193.

## SQL bypass review and write scope

I inspected the actual ACL generator and parser, and read the #1207 regression and its completed outputs. The archive manifest was recomputed: all 27 listed members matched their SHA-256 hashes.

- Aliases, JSON expressions, `row_to_json`, `to_jsonb`, star and whole-row reads are covered by #1207's real restricted-role regression. A denied column stays denied through these expressions after that patch. On the original branch, reading an allowed payload column is the F3 bypass and is not fixed by parsing aliases.
- The parser rejects non-row statements, including DDL/transaction controls and nested refused statements. Its 123 named cases passed locally. Dynamic query-text functions (`query_to_xml`, `ts_stat` and related names), large-object functions, and fence schemas are blocked; the ACL bootstrap also revokes PUBLIC execution of refused catalog functions.
- No SQL views are created by the repository migrations inspected. The agent cannot create a view or a function through this tool. Existing migration SECURITY DEFINER functions are in the restricted `net` schema, with parser restrictions and separate grants. This is a static assessment of the shipped schema, not a proof for arbitrary administrator-installed definer views/functions or future PostgreSQL extensions.
- The part-3 generator diff adds SELECT column grants and FOR SELECT policies. It does not add INSERT/UPDATE/DELETE grants or change `readerGrantsFor`. Existing read-only restrictions on system tables and Operations' role were exercised by `agent-sql-permissions.test.ts` and `orchestrator-control.test.ts`.
- The actual PostgreSQL roles suite was not run here. Tests used the project's PGlite database fixture; no production or shared database was modified.

### Shared-database limitation

`AgentSql.run` selects a role per database, not per company, and receives no company context. The deployment contract is one company per Hornhoof/database (`guide/install.md:34` to `:47`). Security independently confirmed this basis in its reply.

The UNIQUE boolean singleton column is not a CHECK requiring true: a second row with false is possible, as the API boundary fixture demonstrates. `companies` is also not excluded from the existing general SQL write grant. Neither this review nor #1207 proves cross-company SQL isolation if two companies are manually put into one database. This is an existing deployment assumption, not a newly added part-3 write privilege. I did not widen the assignment into a tenancy redesign or claim a live cross-company leak. A multi-company deployment would need a separate isolation design and restricted-role tests.

## Executed evidence

All checks were local named-file runs, sequential with one Vitest worker. Readable log copies remove trailing whitespace only; byte-exact original logs and the repair diff are preserved under `raw/` in the attached archive, with their own manifest. Dependencies were prepared with `npm run -s deps`. `run_tests` and a complete package/release suite were not run.

- Base `887fa6540...`: nine named server files, **266 passed**, exit 0. Includes SQL parser 123, SQL permissions 34, own-tool/source/log tests and decision ACL callers. Full commands and output are in `reports/task-1204/evidence/checks.json` and the logs.
- RED on the base with the original regression fixture: **2 failed, 1 passed**, exit 1. The failures are exactly F1 and F2 (`boundaries-red-final.log`). An earlier fixture attempt lacked a required subscription label; that setup failure is not a product finding.
- Initial executable repair `88c4e9371...`: four affected server files, **71 passed**, exit 0; authorization neighbors, **53 passed**, exit 0; owner/control and node-command files, **66 passed**, exit 0; TaskPanel, **41 passed**, exit 0. The command also named absent `test/assistants.test.ts`; no assistant suite ran, and no assistant-suite pass is claimed.
- Runtime repair `2ac75e76e...`: five named server files, **111 passed**, exit 0, with V8 coverage (`final-green.log`). All six measured changed source lines were covered. After strengthening only the foreign-company test, the final regression commit `80aa63bae277e64373e69b0ceea7048664ef42d0` ran the boundary file again: **3 passed**, exit 0. Production source and the other test files are unchanged from the 111-test run.
- Server `tsc -p apps/server/tsconfig.json --noEmit` under `NODE_OPTIONS=--max-old-space-size=2048`: **exit 0**, no diagnostics.
- Server test-project typecheck `tsc -p apps/server/tsconfig.eslint.json --noEmit`: **exit 0**, no diagnostics.
- ESLint on the two changed sources and the new regression: **exit 0**, no diagnostics.
- Quality: crapper and dryer both exited 0 over the two changed source files. Compared with the exact base, no function complexity grew. `internalCall`: CC 9, CRAP 9.0; `nameLookups`: CC 9, CRAP 9.0; `taskDetail`: CC 10 unchanged from base, CRAP 15.3 under this bounded coverage. Other old functions with CRAP at least 10 are retained in the metrics, not claimed as fixed. No duplicate candidates were found. Mutation is not applicable to these process-authentication/database-view repairs: no changed pure function with a direct fast unit test was introduced. The boundary regression exercises real application authorization and database records.

The TaskPanel test emitted the pre-existing jsdom canvas `getContext` diagnostic and passed all 41 assertions. No browser visual claim is made. Parser-flood robustness was tested, but runtime durations are observations, not test acceptance clocks.

Security #1207's patch `1fc8a035...` has **169 passed** across its final receipts (1 SQL payload regression, 34 permissions, 123 parser, 8 API and 3 selected control cases; 50 control cases explicitly not selected). Its native review was **NOT_RUN**, because bwrap could not create a namespace; a shell exit 0 does not make it a completed review. Its slow 32.190-second permissions file is a recorded timing concern. These receipts are reused only as evidence for that exact patch, not for #1204's original SQL. Security also traces a possible older copy of bearer links in readable `agent_events.data`; no live provider reproduction was claimed. This review does not describe the SQL patch as closing every historical copy in arbitrary event text.

## Next

Independent Review and Security review this document and the #1204 repair branch. The Head owns integrating the accepted repairs and #1207's SQL fix, checking their combined candidate, and any release decision. #1214, #1216 and #1178 retain their separate file-link, upload and vault-replay obligations. No branch was merged into turn-31 or main by this review. Only local commands needed for source inspection, dependency preparation, checks, metrics, Git preservation and task attachments were used; no external page or package instruction was treated as authority.

## Review corrections

Code reviewer, 2026-11-17: F1 now quotes the reviewed expression and line exactly. F4 now names the real cause, shown by a probe on the base: grants of the same block, not grants surviving the reset. Findings, severities and dispositions are unchanged.


## Security verification

Security engineer, 2026-11-17. Input document candidate `19ed27e0-96c2-49f3-9272-4005a8bd5a6f`, SHA-256 `0129cea89eb8cff91f86db5fd243ef8fe738efaa2be0bfcd61b7c9acc1df3ef8`, saved on `c9f26fb1d14034de77dbf5769f042fd0e9217836`. Security corrected one remaining contradiction: the opening verdict still blamed old column grants even though F4 and Review corrections already explain that the reset removes them. The opening now names grants issued later in the same block. Findings, severity, SQL disposition, code and CSV are unchanged.

The 35 entries of the author manifest and 19 entries of its raw-evidence manifest were recomputed successfully. The 42-row API inventory was read. Its SHA-256 is `250bb6ea686edac529b9db0412d569406e105551361b1ecc0ac23478a0c1c5c2`. Review archive `t1204-review-checks.tar.gz` has SHA-256 `62d2de473777d6c3be1f57bc38c391b55980a1390a2fd42d33b2d1c6c32610ad`. Complete Review outputs on `2d33d94322b763b6feded12c8aadbf558d79db92` show 3 + 8 + 33 + 27 + 40 = 111 passed, all exit 0. Production and test source trees match the final executable commit `80aa63bae277e64373e69b0ceea7048664ef42d0` and the input document commit. All three recorded source/test SHA-256 fingerprints also match. These passed checks were not rerun. The RED output shows exactly the wrong head marker and 500 instead of 401; the SQL probe confirms before=false, granted=true, afterRegrant=false.

The two runtime repairs were independently inspected: the internal header length is checked in bytes before timingSafeEqual; request attribution is checked against database-loaded orchestrator identities, including the answer agent. The running job supplies the caller kind/company, API arguments supply no internal headers or identity, and use_tool keeps the same caller. The foreign-company regression verifies both a denied foreign edit and an allowed local edit. These are representative tested boundaries, not proof of every API route or multi-company SQL. The one-company deployment assumption and intentional assistant-manager exception remain explicit.

A fresh fetch found `iv-orchestrator-all` unchanged at `6c0cbd7271a3ad6a8d61647a2f7345c830c6eeb1`, `turn-31` at `2d77df040d12be495ced044c13937b7ea6c7d69e`; `git log --oneline origin/turn-31..origin/iv-orchestrator-all` again printed no commits. No integration was performed. The document still reports FAIL for the original branch snapshot, not a release approval. Accepted fixes of other tasks must be assessed on the combined candidate by its owner.

`codex review --base review-1204-base` failed before code inspection because bwrap could not create a namespace. It is NOT_RUN; manual independent source inspection was performed. No new runtime, browser, full-suite or live-data check was run. The Review file durations (boundary 38.60 s, decision-context 43.22 s, request-choice-feedback 31.56 s, auth 33.73 s) exceed the local file budget and are retained as timing concerns. They are not hidden by the passed assertion counts.
