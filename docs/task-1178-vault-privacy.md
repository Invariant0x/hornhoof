# Vault privacy, task 1178

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1178-vault-privacy.md). These are historical results, not checks of the current release.

The task branch starts at `41d37dd3d4f919e63ed39f4f0ce0d898e440f4c5` and incorporates `turn-31` through `c546bfe3bfe20ff86b9889d7ee5d7bb10fc9b1a6`. The final checked code and tests are `beb379fa907715580128324e0d84ccf6834b36fe`. The broad named checks used `792ca47fb44b2d26155b26574181efd9551c2b07`; final delta checks cover the subsequent integration. The final commit adds this report and evidence only; the task completion report names its full SHA and records the authorized fast-forward to `turn-31`. This turnkey repair includes local named checks and self-review. It does not approve a release to main.

## Boundaries

Sensitive tools declare `_meta.sensitive`. Both Vault registrations and node telemetry share the protocol's definitions. The node also learns the flag and field policy from the trusted MCP tool listing. The replay wrapper bypasses lookup, tool sources, pending rows and answer storage for every flagged tool, including calls without an invocation ID. Repeating a call checks the handler's current authorization again. Unexpected failures of sensitive tools return a fixed message without the original exception.

The node hides sensitive tool inputs, results and all subsequent intermediate tool data. It suppresses the raw terminal tail and the operator's terminal view for as long as the exposed program session survives. A later typed turn also suppresses that retained tail. Removing the program and its tmux session resets this boundary.

Before forwarding a sensitive MCP call, the bridge awaits protection of the node's own protocol files. The tmux recorder stops and existing `.hh-output` files are removed; `.hh-screen` receives only the hidden-output note. Cleanup or recorder failure prevents forwarding. An atomic, value-free marker retains the private session and job identity across node restarts. Recovery removes stale raw files and never restarts their recorder. If the same private job resumes without its memory masks, its text and final answer are hidden. A later, different job can still deliver its ordinary report while the retained terminal output stays hidden. Cursor and exit parsing respect the same boundary.

The server independently hides those events before storage and publication, including telemetry from older nodes. It writes a value-free issuance marker before returning a sensitive MCP answer. Only the server can set the issuance marker. An unknown parked job's raw program data is hidden until its database arrives.

Issued passwords and OTP values remain in an in-memory map scoped to the database and turn. Ordinary reports, messages and completion text still arrive with exact occurrences replaced by `[hidden]`. Routing references and typed discriminants survive short passwords; JSON is masked structurally. Terminal output and intermediate commands use the flag boundary rather than a list of known password values. The map is dropped on normal completion, cancellation, node loss, abandoned startup turns and outside steps.

After a restart, a durable issuance marker with no corresponding in-memory state makes that old turn fail closed: incoming text and its completion are hidden, and new writing MCP calls ask the agent to finish the turn and start a new one. Safe reads remain available. Normal turns keep ordinary reports. No secret values are recovered from the database.

Computer commands containing an issued value are refused before execution or insertion into `computer_runs`. The response tells the agent to type the password with its own program on the machine. A turn attachment containing the value is refused before storage; filenames are masked. The streaming guard retains a bounded window so a value split between UTF-8 chunks is never yielded to storage; a rejected transfer removes earlier safe temporary bytes. Restarted sensitive turns cannot upload attachments.

Phone execution has an explicitly approved separate boundary. `_meta.secretExecution` is a server capability, enabled for a call only when its input contains a value issued by Vault during that turn. The agent cannot enable or disable it. The raw input and reply go only to the authorized caller and device; no replay row or tool source is created. Later captures of that executor remain private. Phone frames during a sensitive turn retain their sequence and time but store no image bytes, including the current JPEG format. Ordinary phone actions, replay and recordings retain their behavior.

The `use_tool` shelf declares `delegatesTool`; the actual target's policy protects delegated calls too. The bridge accepts this capability only from the trusted tool listing.

No old rows are cleaned and no data migration is introduced. The authorized program's own third-party transcript remains outside the server's telemetry copies; the node does not create a plaintext protocol copy of the secret response.

## Regression proof

All markers in the tests and RED logs are synthetic.

- `apps/server/test/vault-tools.test.ts`: replay storage and journal, retry after entry deletion, old-node `tool.input` and `tool_result.summary`, raw completion without node tool telemetry, Vault save input/errors, reports with and without a password, computer refusal, attachment refusal, restart fallback, successful and failed completion, cancellation and node loss.
- `apps/server/test/tool-calls.test.ts`: an arbitrary flagged tool bypasses all replay storage; ordinary replay, lease failures, keeper trust and database tools keep their contract.
- `apps/server/test/read-tools.test.ts`: cut-off writes stop before privacy callbacks, issuance markers or memory are created.
- `apps/server/test/vault-phone-privacy.test.ts`: ordinary replay and image bytes, password in URL and typed input, caller-supplied false flag, repeated captures, hidden frames through the human API, and a unique-marker scan of every public, net and net_local table.
- `apps/server/test/private-upload.test.ts`: split UTF-8 secret, unmodified ordinary binary upload, filename masking and rejection after restart.
- `apps/server/test/orchestrator-any-tool.test.ts`: a secret target reached through `use_tool` retains its protection.
- `packages/protocol/test/tool-privacy.test.ts`: shared policies, arbitrary flagged tools, short passwords, JSON, routing identity, opaque media and server-derived secret execution.
- `apps/node/test/runner.test.ts`, `terminal-bridge.test.ts` and `terminal-host-secrets.test.ts`: secret input/result/tail/failure, awaited observation before forwarding, cleanup rejection, dynamically listed and delegated policy, retained terminal tail, ordinary later report, node restart and a clean session's visible screen.
- `apps/node/test/terminal-tmux.test.ts`: recorded tmux interaction, raw file removal, private temporary capture, recorder failure, absent session, atomic marker recovery and cursor protection. These tests exercise our calls and recorded responses, without waiting for a live tmux program.

The initial server RED on the original base had 4 intended failures and 19 passing tests. It showed the marker in replay, replay after deletion, node input and node result paths. Node RED separately demonstrated the Vault save input and Vault entry result paths. Later targeted RED checks caught routing corruption by short passwords, opaque-media corruption, unclassified URL execution, cut-off calls that wrote an audit marker, and a retained terminal tail in a later typed turn. Each received a corresponding repair.

Further RED logs show retained node recording files, ignored asynchronous recorder cleanup, delegated-tool leakage and a node restart exposing a final answer. The streaming RED is explicitly a supplemental mutation: an isolated Vitest alias replaced the upload guard with a pass-through implementation, and the unchanged assertion detected it. It is not presented as a run against the original base. Logs are in [the evidence directory](https://github.com/invariant0x/hornhoof/tree/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1178-evidence).

The last integration introduced `report.verification.delta`. Its unique-marker regression failed before adding that field to prose masking and passed afterward, preserving the candidate identity and revision. This covers the new report path without altering the incoming route change.

## Test speed

The observed Vault slowdown was cold PGlite setup and repeated onboarding and invitations, not the cryptographic cost. A diagnostic run had 80,739 ms in setup and 742 ms in the selected test; another had 48,421 ms in setup and 1,962 ms in the selected test. Both exceeded the existing 20 s test deadline during initialization. A separate production password KDF measurement was 392.885 ms. Vault encryption and KDF parameters are unchanged.

The Vault fixture now seeds the minimal valid company, identities, roles, sessions and subscriptions directly, uses the real Vault API, and snapshots the prepared database. Shared database preparation runs before cases. In the completion delta, all 19 Vault-tools tests passed in 3,042 ms; the first case took 360 ms. After the final integration the same file passed in 3,633 ms. Test timeouts and existing assertions are unchanged. Phone lease tests use an injected clock; replay concurrency waits for an explicit state transition rather than polling elapsed real time. Wall-clock measurements in the logs are diagnostic evidence, never assertions or thresholds.

Earlier parser and helper initialization timeouts were failures, not passes. Their final separate named check completed successfully: 43 passed and 2 expected failures across both files. No earlier failed or mixed-version attempt is counted as final evidence.

## Review and check record

Self-review repaired four concrete findings: the history test used the wrong table; short passwords could corrupt routing choices; a cleared program session remained hidden; and abnormal endings retained the memory map. Follow-up security review added all executable input fields to phone classification, put cut-off refusal before sensitive registration callbacks, covered retained typed tails, and separated memory storage from event persistence to avoid a new import cycle. It also covered streaming attachments, the delegated tool shelf, owned node protocol files and memory loss on node restart. No external checker or helper was called onto this turnkey task.

The final named checks passed:

- Server: 16 files, 155 tests; the later two-file completion delta passed 31 tests and supersedes the changed Vault test file. After final integration, four related MCP files passed all 49 tests again.
- Node: 11 files, 211 tests; attachment transport separately passed 10 tests. After final integration, three related caller files passed all 79 tests again.
- Protocol: all 13 tests passed after the last change. Shared database helpers: 43 passed and 2 expected failures.
- Server and node builds; server, node and protocol types including tests; web types; lint of all changed TypeScript files: exit 0.
- CRAP: no new or more complex function at 10 or above, using completed coverage and the exact integration base. Unchanged existing hotspots are recorded separately.
- Sampled semantic mutation of six changed protocol privacy lines: 6 killed, 0 survived, 0 uncovered, 0 compile errors and 0 timeouts. This is a bounded security sample, not a claim that every mutation site was checked.

Dryer found two existing adapter/query patterns. They are retained with an explicit reason: assistant and Vault response adapters share the same small MCP response contract but have different registration and security owners; the computer owner-name lookup and running-job lookup select different records and express different domain rules. Their scores are 1.00 and 0.85. Extracting a generic cross-domain wrapper would obscure these contracts and is outside this repair.

[checks.json](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1178-evidence/checks.json) records commands, exit codes and the source/test/config tree fingerprint. [verification.txt](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1178-evidence/verification.txt) contains the complete final test outputs and static-check results; [quality.json](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/task-1178-evidence/quality.json) records the baseline comparison. The final report-only commit must match the checked code fingerprint before integration.

No whole suite or `run_tests` is used on this task branch. The task explicitly requires named local checks; full release validation and release approval remain with the release owner. No main merge or server deployment is part of this work.
