# Staging batches

The staging implementation is disabled. New registered plans default to
`enabled=false`, `maxBatchSize=4`, and `maxWaitMs=0`. The size and delay are
unmeasured bootstrap values, not a performance result. No background publisher or
agent-callable staging command is registered in this release. Changing a plan row
alone does not activate one.

The implementation currently provides these internal components:

| Component | Contract |
| --- | --- |
| `tasks/staging-plans.ts` | `resolveRegisteredStagingPlan` reads one current enabled normal-turn root and complete native health on its exact base commit. Missing roots and unsupported urgent lanes stay unavailable. |
| `tasks/staging-receipts.ts` | `readRegisteredStagingInclusion` reads the frozen 14-field H-to-M receipt only for the current workspace, revision, source head, publication and target. It also checks the persisted batch, trial, exact native GREEN and both confirmed publication operations. It writes nothing and does not confirm remote effects. |
| `tasks/staging-store.ts` | `settleRegisteredStagingTrial` records a registered native result once, under plan, batch and trial locks. Retries preserve the version. Failed exit codes without a bound failing test remain unattributed. |
| `tasks/staging-batch-policy.ts` | Chooses an already eligible batch by size or oldest acceptance time. It does not establish eligibility or claim submissions. |
| `tasks/staging-split.ts` | Determines the next subset check, isolated failing submissions, or interacting groups from immutable checks. The recomposed remainder needs its own GREEN. |
| `tasks/staging-failures.ts` | Conservatively decodes complete supported test output. Labels alone are not failure authority. |
| Node `staging-git.ts` | Prepares a deterministic single-parent squash candidate, creates its immutable trial tag, and applies ordinary canonical staging and turn fast-forwards with independent exact readback. These functions require a protected caller and an executor already bound to the registered repository. |

The following runtime dependencies are absent and remain disabled:

- The canonical current sealed/published submission authority. Text
  phases and publication JSON are metadata, not its replacement.
- The authenticated registered-operation entry for protected Git preparation and
  publication, exact full ref and expected commit, and server-selected affected
  test snapshot. Public `run_work`, free-form commands, and a moving branch do not
  supply that authority.
- Their automatic batch claim, native dispatch and receipt-writer glue. The
  database outbox is persistent intent storage, not a second queue or runner.
- Registered urgent-lane and main-release producers. A turn receipt never grants
  main inclusion.

Until these are connected and checked, no caller may advertise staging admission
or automatic publication as available. Existing task submission and manual turn
integration retain their current behavior. Database fixture rows prove storage
behavior, not production admission, authenticated node execution or live Git
credentials.

Trial refs use `refs/tags/turn-N-staging-<batch UUID>-<trial UUID>`. They are
create-only: a retry may read the same commit, but never replace another commit.
Canonical `refs/heads/turn-N-staging` and `refs/heads/turn-N` use ordinary pushes
only, after GREEN; the candidate has the registered base as its only parent.
Force, leases, deletion and ref cleanup are not part of this implementation.

A future maintenance change must define retention and reachability rules before
removing old trial tags. It must account for active checks, uncertain publication,
retained journals and inclusion receipts. This release deletes none.

The private tables and their grants must ship together. An older server binary
with broad generic SQL grants is not a supported rollback target for the new
schema. Use a forward correction and preserve all existing rows and journals.
