# This slice

Plan 1b Task 7: the certificate's row and the tunnel's https mode. Security class: two readers at once, each alone. Nothing orders a certificate until Task 8, which is being written on top of this.

The batch's other slices are Plan 2 Task 3 (the app's mode, `ctx.mode`) and the sql-check part of Plan 3 Task 3. The Claude reader of this slice is also the reader named for the interactions between slices: `apps/server/src/config.ts`, `apps/server/src/app.ts` and `apps/server/src/db/agent-sql.ts`, read on the branch as they now stand. The two config splits were merged by the lead.

Read for: where the private key can be seen or leave from (agent SQL, reader role, logs, API answers, backups named in the plan); what the tunnel does when the row, the key or the certificate is missing, wrong or expired; what an old `tunnel.json` with no mode means.
