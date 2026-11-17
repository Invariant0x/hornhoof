# Vault privacy, task 1178

The task branch starts at `41d37dd3d4f919e63ed39f4f0ce0d898e440f4c5` and incorporates the release branch before integration. The final task report names the checked candidate and the fast-forward target. This is a turnkey repair, with local named checks and self-review; it does not approve a release to main.

## Boundaries

Sensitive tools declare `_meta.sensitive`. Both Vault registrations and node telemetry share the protocol's definitions. The node also learns the flag and field policy from the trusted MCP tool listing. The replay wrapper bypasses lookup, tool sources, pending rows and answer storage for every flagged tool, including calls without an invocation ID. Repeating a call checks the handler's current authorization again. Unexpected failures of sensitive tools return a fixed message without the original exception.

The node hides sensitive tool inputs, results and all subsequent intermediate tool data. It suppresses the raw terminal tail and the operator's terminal view for as long as the exposed program session survives. A later typed turn also suppresses that retained tail. Removing the program and its tmux session resets this boundary.

The server independently hides those events before storage and publication, including telemetry from older nodes. It writes a value-free issuance marker before returning a sensitive MCP answer. Only the server can set the issuance marker. An unknown parked job's raw program data is hidden until its database arrives.

Issued passwords and OTP values remain in an in-memory map scoped to the database and turn. Ordinary reports, messages and completion text still arrive with exact occurrences replaced by `[hidden]`. Routing references and typed discriminants survive short passwords; JSON is masked structurally. Terminal output and intermediate commands use the flag boundary rather than a list of known password values. The map is dropped on normal completion, cancellation, node loss, abandoned startup turns and outside steps.

After a restart, a durable issuance marker with no corresponding in-memory state makes that old turn fail closed: incoming text and its completion are hidden, and new writing MCP calls ask the agent to finish the turn and start a new one. Safe reads remain available. Normal turns keep ordinary reports. No secret values are recovered from the database.

Computer commands containing an issued value are refused before execution or insertion into `computer_runs`. The response tells the agent to type the password with its own program on the machine. A turn attachment containing the value is refused before storage; filenames are masked. Restarted sensitive turns cannot upload attachments.

Phone execution has an explicitly approved separate boundary. `_meta.secretExecution` is a server capability, enabled for a call only when its input contains a value issued by Vault during that turn. The agent cannot enable or disable it. The raw input and reply go only to the authorized caller and device; no replay row or tool source is created. Later captures of that executor remain private. Phone frames during a sensitive turn retain their sequence and time but store no PNG. Ordinary phone actions, replay and recordings retain their behavior.

No old rows are cleaned and no data migration is introduced. The authorized program's own third-party transcript remains outside the server's telemetry copies; the node does not create a plaintext protocol copy of the secret response.

## Regression proof

All markers in the tests and RED logs are synthetic.

- `apps/server/test/vault-tools.test.ts`: replay storage and journal, retry after entry deletion, old-node `tool.input` and `tool_result.summary`, raw completion without node tool telemetry, Vault save input/errors, reports with and without a password, computer refusal, attachment refusal, restart fallback, cancellation and node loss.
- `apps/server/test/tool-calls.test.ts`: an arbitrary flagged tool bypasses all replay storage; ordinary replay, lease failures, keeper trust and database tools keep their contract.
- `apps/server/test/read-tools.test.ts`: cut-off writes stop before privacy callbacks, issuance markers or memory are created.
- `apps/server/test/vault-phone-privacy.test.ts`: ordinary replay and PNG, password in URL and typed input, caller-supplied false flag, repeated captures, hidden PNG through the human API, and a unique-marker scan of every public, net and net_local table.
- `packages/protocol/test/tool-privacy.test.ts`: shared policies, arbitrary flagged tools, short passwords, JSON, routing identity, opaque media and server-derived secret execution.
- `apps/node/test/runner.test.ts`, `terminal-bridge.test.ts` and `terminal-host-secrets.test.ts`: secret input/result/tail/failure, observation before forwarding, dynamically listed policy, retained terminal tail, ordinary later report, and a clean session's visible screen.

The initial server RED on the original base had 4 intended failures and 19 passing tests. It showed the marker in replay, replay after deletion, node input and node result paths. Node RED separately demonstrated the Vault save input and Vault entry result paths. Later targeted RED checks caught routing corruption by short passwords, opaque-media corruption, unclassified URL execution, cut-off calls that wrote an audit marker, and a retained terminal tail in a later typed turn. Each received a corresponding repair.

## Test speed

The observed Vault slowdown was cold PGlite setup and repeated company setup, not the cryptographic cost. A diagnostic run had 80,739 ms in setup and 742 ms in the selected test; another had 48,421 ms in setup and 1,962 ms in the selected test. Both exceeded the existing 20 s test deadline during initialization. Initializing shared infrastructure during file preparation and snapshotting the full company fixture removes that work from each case. Test timeouts, production KDF settings and assertions are unchanged. Phone lease tests use an injected clock; replay concurrency waits for an explicit state transition rather than polling elapsed real time.

An early failing named check took 647.53 s and included 5 timed-out helper/parser cases. That failure is retained as a concern until their final named recheck completes. The subsequent 10-file Vault/tools/phone check passed all 74 tests in 184.81 s; Vault tools took 2,856 ms for 16 cases, Vault API 2,167 ms for 8 cases, and OTP 9 ms for 7 cases. These wall-clock observations are evidence, not test thresholds.

## Review and check record

Self-review repaired four concrete findings: the history test used the wrong table; short passwords could corrupt routing choices; a cleared program session remained hidden; and abnormal endings retained the memory map. Follow-up review added all executable input fields to phone classification, put cut-off refusal before sensitive registration callbacks, covered retained typed tails, and separated memory storage from event persistence to avoid a new import cycle.

Final command results and exact candidate are recorded below when the outstanding local checks finish. No whole suite or `run_tests` is used on this task branch. The shared author-check selector is not invoked because a protocol change selects whole suites; the task explicitly requires named local checks instead.
