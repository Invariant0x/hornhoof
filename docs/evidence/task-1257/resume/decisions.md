# Task 1257 resumed integration

The head confirmed preserving iv-no-confirm and excluding the deleted outbound implementation and universal new_kinds default from task 1112. All remaining standing head authority must use the current ruleOf signature. This transfer is still pending.

The head then ordered task 1119 first, followed by the other accepted candidates, with each checked part fast-forwarded into turn-32. The release waits for all four parts. Current inspected target: 283e056f355026eb0f26841eea329825d79b8725.

## Secret redaction and current SQL authority

The head separately confirmed keeping the unrestricted orchestrator from iv-orch-sees-all and the redaction and Operations restrictions from task 1227. The conditional exception for DELETE applies because Ivan's commit f5e936bc9 itself gives the orchestrator the application's entire connection and rights:

- apps/server/src/db/agent-sql.ts:85: "The orchestrator has every right of Hornhoof itself".
- apps/server/src/db/agent-sql.ts:203 drops its former restricted role.
- apps/server/src/db/agent-sql.ts:204: `const write = openPool(url, err => console.warn(` followed by `APP_NAME, { fenced })`, using the application's URL without a restricted role.
- The same commit's test helper leaves write calls in the application session and changes role only for read calls. Its orchestrator-sql-secrets.test.ts explicitly allows changing keys and deleting peer_secrets.

Consequently the transfer retains the current agent-sql.ts and adds secret_redactions to Operations' HIDDEN list. The obsolete KEY_FIELDS entry for fingerprint and characters is excluded because the entire restricted orchestrator grant implementation was removed upstream. The suppression fingerprint test now asserts the orchestrator can read each projection while Operations cannot. The rights test inserts a suppression row and proves the orchestrator can delete it, and still denies Operations both reading and deleting it. This does not claim an unrestricted orchestrator cannot disable suppression. Stored-text redaction and fingerprint matching remain in the server.

The tracker merge retains updateTask's optional tracker argument alongside credential masking; task detail retains mayEdit/version/revision alongside mayHideSecret. The exported LogEntry keeps the tracker's words and accepts optional task/action props for the hide control.

Task 1119 uses migration 0141 after 0140. Secret redaction uses 0142 after 0141. Original SQL is unchanged; snapshots retain every predecessor table, indices and journal entries. Checks and final integration commits are pending.
