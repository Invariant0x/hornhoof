# Task43 artifact transfer application runbook

This runbook does not authorize application or delivery. The implementation branch and the exact reviewed commit must pass DEV-REV, DEV-TEST and both DEV-SEC checks, followed by the separate operational and API acceptance. Main, images, installers, live processes and the real task43 archive stay unchanged until the exact implementation commit is approved for a separate application window.

## Scope and prerequisites

- The only operation is `transfer_task_artifact({task:56,requestId:UUID})` through the existing `POST /mcp` with the current job bearer of the Operations head assigned to working task56 at stage0. A historical task57, an ended job, a node key, another role, another task or another company does not authorize the call.
- Use the exact reviewed server build for the company and the exact reviewed node builds for source agent `b8f2e7aa-1fb2-447e-9312-7dc1e12108a6` and target agent `100edb09-da27-4868-9646-5c0118b9934e`. A node advertises `task43_transfer_v1` only after its isolated helper qualification succeeds.
- Confirm the actual deployment provides private authenticated node connections and the intended workspace mounts. Do not infer this from sample Compose addresses. Preserve configured workspace and session volumes. There is no database migration.
- The source relative path is `task-43-evidence/review-transfer-r1/task43-review-transfer-r1.tgz`. The destination basename in the existing target workspace is `task43-review-transfer-r1.tgz`. The fixed expectation is 2012762 bytes and SHA256 `c92e8a8c418dc7290a4296079e75a131d9a6ea5188a52264cda7267f67fe561c`.
- Operations must stop if the source differs, either workspace is absent, either node is offline or unsupported, or the destination exists with different bytes or through a symlink. The operation never overwrites a different destination and never extracts or executes the archive.
- Before deployment, take the standard approved backup, record the previous server and node versions and test their rollback. Follow the separately coordinated queue and lifecycle review for tasks14, 27 and46.

## Application impact

Server replacement disconnects MCP and node connections and aborts an in-flight transfer without changing ordinary task state. Node replacement can end live CLI and tmux processes, so session continuity is not promised. Apply only in the approved window with those effects accepted. Old nodes keep ordinary behavior but cannot use this operation.

After the exact builds are running, verify health and the two intended node identities. Confirm that their hello capabilities include `task43_transfer_v1`. An unsupported node returns `unsupported_node`; do not weaken filesystem checks or change permissions to make the capability available.

The relay permits one global attempt, one in-flight chunk, 32768 bytes per chunk and at most 49152 UTF-8 bytes per task43 frame. The fixed file takes62 chunks, with 13914 bytes in the last chunk. The total timeout is60000 ms and the idle timeout is10000 ms. Transfer frames do not enter the node outbox, task comments, public URLs or `hh-attach`.

## Call and retry

1. The orchestrator resumes task56 through normal task flow. Operations confirms that the current running job belongs to the assigned Operations head and that task56 is still working at stage0.
2. Generate one UUID as `requestId`. Call `transfer_task_artifact` with exactly `{ "task": 56, "requestId": "THE-UUID" }`. Callers cannot supply agents, addresses, paths, commands, size or hash.
3. A successful transport returns a JSON receipt with `status=server_complete`, `delivered=false`, the actual target path, size, hash, request and attempt ids, and UTC metadata. A start and final receipt are stored as structured `task43Transfer` metadata in existing task56 events. Binary content and credentials are not receipts.
4. A failed attempt returns `isError=true` and a failed receipt with a bounded `errorReason`. Authorization, validation and routing failures before an attempt return `{ "error": { "code", "reason", "message" } }`. `wrong_context` means the current authority is invalid, `busy` means another attempt is active, and `unsupported_node` or `node_offline` means routing is unavailable.
5. Retry only with a fresh valid task56 job if the old job ended, using the same `requestId`. Every retry rechecks the actual destination. Matching bytes return `already_present`; a different destination remains untouched. There is no automatic background retry.
6. `commit_outcome_unknown` with `mayExist=true` means publication may already have happened. Do not claim that the file is absent and do not delete it as an automatic rollback. Reauthorize and retry so the receiver can rehash it.

## Independent acceptance and rollback

Transport completion is not delivery, task56 completion or a PASS for task43. The Head of Operations must independently run the recipient verification in the actual Kimi environment under task56:

```sh
stat -c '%s' /data/work/agents/100edb09-da27-4868-9646-5c0118b9934e/task43-review-transfer-r1.tgz
sha256sum /data/work/agents/100edb09-da27-4868-9646-5c0118b9934e/task43-review-transfer-r1.tgz
```

Accept only `2012762` and `c92e8a8c418dc7290a4296079e75a131d9a6ea5188a52264cda7267f67fe561c`. Operations records the final delivered or failed decision in task56 with a reference to the transport receipt. Do not extract or execute the archive.

If application health fails, use the previously tested server and node rollback for the approved previous versions. Rollback does not undo a file that may already be published and does not erase receipts. Any action on that file requires a separate Operations decision after independent verification.
