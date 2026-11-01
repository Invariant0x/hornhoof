# Minimal CI resource for B0 qualification

Status: PROPOSED, statically reviewable, not published and not run. This is a resource and permission proposal, not B0 or D2 evidence.

## Proposal

Use one manual, tests-only GitHub Actions job on the existing repository's GitHub-hosted `ubuntu-24.04` runner. Start with the Codex lane because task 63 established package metadata for it. Fetch verified artifacts on the disposable host, then run the actual CLI and synthetic model stub together in one non-root container with `--network=none`. Docker creates only a loopback device in that network namespace, so the stub remains reachable while external egress is denied to the CLI and all descendants.

The B0 job itself does not push images or tags, use `latest`, update Hornhoof, mount company or agent credentials, mount a host home or socket, or mount the Docker socket inside the probe. It does not alter `images.yml`, production Dockerfiles or provider code. No self-hosted runner, host capability, coordinator or interception service is added. Publishing its workflow to main has a separate unavoidable Images effect, explicitly gated below.

The first dispatch is `isolation`, then `codex-positive`, and only then `codex-d2`. Resource-ready is not B0-ready. All six native/API lanes and model counts remain as recorded in `coverage.json` until separate actual qualification.

## EXISTING_PROVEN

- Source `bd696b0724385b6b11da53a24ada2f188b031217` has one `Images` workflow. Its test job uses `ubuntu-latest`, Node 22 and `npm test` with `contents:read`; it has no native CLI pins, fresh profile or kernel egress denial.
- A separate Images job has `packages:write` and publishes images. This proposal does not reuse or change that job.
- Task 63 is accepted evidence of a GAP, not a native PASS. Its helper is observer-only. All six lanes are unavailable and model counts are null.
- Official Docker documentation states that `--network=none` creates only the loopback device. No IPv6 loopback is configured, so the stub contract uses IPv4 `127.0.0.1`.
- Exact public npm archive integrity and executable hashes are recorded in `pins.json`. The native Linux x64 archive and binary were inspected as source artifacts without installation or CLI execution.

## PROPOSED files

The proposal branch contains only documents under `docs/task-73/`. A later exact approved implementation commit must contain:

1. `.github/workflows/b0-probe.yml`, copied byte-for-byte from `b0-probe.yml` here.
2. `ci/b0-probe/run.mjs`, the native isolation and model harness, not implemented here.
3. `ci/b0-probe/validate-result.mjs`, the non-printing output allowlist validator, not implemented here.
4. `ci/b0-probe/SHA256SUMS`, with repository-relative paths for every harness and fixture file.
5. `ci/b0-probe/fixtures/`, bounded synthetic responses and decision inputs, with no personal data or credentials.
6. The output contract in `harness-contract.md` and lane matrix in `coverage.json` as permanent documentation.

The workflow fails before Docker if the harness, validator or checksum manifest is missing. Its presence in this proposal is not a claim that those files already exist.

## Execution boundary

The draft workflow has only `workflow_dispatch`; there is no push, pull request, schedule, workflow-run or reusable-workflow trigger. A fixed concurrency group serializes probes without cancelling an active one. The job has a 15-minute limit and the container has a 600-second limit, one CPU, 1 GiB memory with no additional swap, 128 PIDs and 1024 open files.

Artifact download and Docker image pull happen on the disposable host before the probe. The probe itself has:

- `network=none`, `cap-drop=ALL`, `no-new-privileges`, non-root numeric user and read-only root;
- a small writable `/tmp`, fresh writable home and output directories, and no other writable mount;
- only the approved harness and verified CLI mounted read-only;
- explicit non-secret environment variables for fresh profiles, with no inherited host environment or secrets;
- raw stdout and stderr discarded, with only the bounded result allowed out.

The host-side Docker daemon remains a privileged trust boundary. The proposal relies on GitHub's disposable hosted VM and an exact reviewed workflow, not on giving an agent node Docker access. The workflow's action references are full commit SHAs and the container is an amd64 manifest digest, not mutable tags.

## Approved commit and dispatch race

GitHub requires a `workflow_dispatch` workflow file on the default branch. The dispatch API accepts a branch or tag in `ref`, not an arbitrary commit SHA. `GITHUB_SHA` for this event is the last commit on that ref.

The runbook therefore uses `ref=main` and a separate `approved_commit` input. The first step, before checkout or any third-party action, requires the event, `refs/heads/main` and `GITHUB_SHA == approved_commit`. Checkout then uses the full 40-character commit and verifies `HEAD` and harness checksums. If main moved after approval, the run stops before the probe.

This guards an ordinary approval-to-dispatch race. A workflow can always be changed by someone who controls the default branch, so a self-check is not a security boundary against a malicious writer. Protected main, reviewed workflow ownership and exact CEO commit approval are prerequisites; their current GitHub configuration is UNKNOWN and must be checked by Operations without changing it. Dispatching a SHA in the API `ref` field is not a supported substitute.

## Bootstrap publication and Images side effect

The required default-branch bootstrap is not isolated from the existing `Images` workflow. At the reviewed source, `.github/workflows/images.yml:3-5` triggers on every push to main. After its tests, `.github/workflows/images.yml:25-30,55-73` builds with `push: true` and publishes `latest`, package-version and commit-SHA tags using the existing Images job's `packages:write` permission. Adding `b0-probe.yml` to main therefore has an Images effect even though the B0 job itself never publishes anything.

The exact publication route is therefore blocked by default and requires two explicit decisions before merge:

1. The Head of Development presents the exact B0 bootstrap commit and, separately, the unavoidable Images run and its `latest`, version and SHA tags. The CEO must approve both the exact commit and this Images effect. Approval of B0 alone is not approval to publish Images.
2. If the CEO approves B0 but not the Images effect, publication remains BLOCKED. Operations must not merge, use a Contents API workaround, disable Images or change its triggers in this task. A different repository or runner would require a new proposal and review.
3. Only after both approvals may Operations use the normal exact-commit merge path. Before merge, Operations verifies that `images.yml` at the approved commit still has the reviewed behavior. After merge, Operations records the Images run ID, watches it to a natural result and verifies the resulting run and tags against that approval.
4. B0 dispatch remains blocked until the Images result is observed and accepted under the separate approval. If Images fails or its behavior differs, stop; any revert, rerun or follow-up is another reviewed decision. No automatic B0 dispatch follows the main merge.

This makes the Images effect an explicit release decision, not a hidden side effect of introducing a tests-only workflow. The proposal does not modify Images or request a new packages scope for the B0 runtime.

## CLI and runtime identity

The initial lane uses `@openai/codex` package version `0.166.0` and native package version `0.166.0-linux-x64`. Registry SHA-512 integrity is checked before extraction. The launcher SHA-256 is `e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af`; the actual native executable SHA-256 is `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8`. These are different identities, not interchangeable package labels.

The Node container digest and all byte sizes are in `pins.json`. Runtime Node and Codex versions must be observed inside the future isolated run and are currently `PLANNED_NOT_RUN`, not inferred from a tag. No provider CLI or package script was executed for this proposal.

## Permissions and missing service capability

`permissions.json` is the authoritative existing/required/unknown matrix. The B0 runtime job receives only `contents:read`; all unspecified `GITHUB_TOKEN` scopes are none. The pinned artifact upload uses the runner-provided `ACTIONS_RUNTIME_TOKEN` path, so no `artifact-metadata` scope is requested. No packages, administration, deployment, attestation, OIDC or runtime workflow-write scope is requested.

Publication requires Contents write and Workflows write for the principal that updates the workflow. Dispatch and cancel require Actions write. Reading runs, logs and artifacts requires Actions read. These repository permissions are not limited to one workflow even when the credential is limited to this repository.

No authenticated Operations service principal or effective GitHub permission was proven in this session. The unauthenticated repository metadata GET returned 404 at `2026-11-01T10:02:24.763362Z`; this does not establish visibility or permissions. No personal login, token, credential helper, environment or auth file was inspected.

The one minimal future infrastructure step is for the technical GitHub repository owner, or organization administrator where applicable, to configure an Operations-owned fine-grained service credential or GitHub App installation for only this repository. It needs Actions read/write for dispatch and operational reading, and Contents read/write plus Workflows write only for the separate publication principal. It stays in the existing Operations GitHub service context, never in Hornhoof or the probe. Splitting publication and dispatch principals is preferred. This is a proposed permission change for separate approval, not something task 73 performs.

## Runbook after this proposal is accepted

1. **Implementation, Development native-harness author:** in a new task and branch, add the exact workflow and required harness files, write failing static/fixture tests first, review the output allowlist and complete the normal root and independent gates. Keep the workflow outside `.github/workflows` until that implementation is approved. Deliverable: exact candidate commit and checksum manifest.
2. **Setup, Operations with the technical repository owner:** verify the service principal, effective permissions, hosted-runner Docker availability and protected-main/workflow review configuration using read-only metadata. Read the exact `images.yml` at the candidate commit and record the expected Images side effect without running it. Request only the missing repository-scoped permissions through the separate approval path. Do not add a host, capability, provider account or personal credential. Deliverable: allowlisted principal, permission evidence and Images effect, with secrets omitted.
3. **Approval, Head of Development and CEO:** the head presents two distinct decisions: the exact B0 implementation commit and permission diff, and the unavoidable Images run with `push: true` plus `latest`, version and SHA tags. The CEO must explicitly approve both before publication. If Images is not approved, the bootstrap remains blocked even when B0 is approved. No server search, SQL, CLI, merge or dispatch is delegated to the CEO. Deliverable: recorded separate exact-commit and Images approvals.
4. **Dispatch, Operations:** only after both approvals, merge the exact commit through the normal path, record and watch the resulting Images run, and accept its observed behavior under that approval. Then call `POST /repos/Invariant0x/hornhoof/actions/workflows/b0-probe.yml/dispatches` with `ref: main` and inputs `approved_commit: <the same 40-character SHA>` and `suite: isolation`. Repeat later only with explicit authorization for `codex-positive`, then `codex-d2`. Read back run ID, `head_sha`, inputs and status; mismatch, unexpected Images behavior or timeout is a blocker. Deliverable: Images run and B0 run identifiers with UTC, never tokens.
5. **Qualification, independent Architect and Security reviewers:** verify the run source, action and CLI hashes, fresh profile, isolation controls and allowlisted result. Require actual CLI positive count before interpreting denial. Keep every unexecuted lane and case `NOT_RUN` with null counts. Deliverable: a scoped PASS or precise GAP, not automatic closure of task 52 or D2.
6. **Cleanup, Operations:** the job force-removes only its named container and disposable directories in `always()` cleanup. Let the one-day artifact expire; cancel only the identified run if it is stuck or unsafe. Reverting or disabling the workflow or Images is a separate reviewed change, not an automatic deletion. Deliverable: observed container cleanup and artifact retention metadata.

## PLANNED_NOT_RUN and real gaps

No Docker, workflow dispatch, workflow run, provider CLI, model endpoint, OAuth, live setting, image publication, package installation or heavy suite was performed. Public registry artifacts were downloaded only for source hashing. The actual native harness and provider-supported blocking before-send point remain missing. Current GitHub service principal, repository visibility, effective permissions and branch protection remain unknown. Bootstrap publication remains BLOCKED until the separate Images approval described above. The other five lanes still need their own pins and harnesses. No part of this proposal authorizes production enforcement or closes task 52.

## Official references

- Docker none network: https://docs.docker.com/engine/network/drivers/none/
- Docker run options: https://docs.docker.com/reference/cli/docker/container/run/
- Docker security and daemon boundary: https://docs.docker.com/engine/security/
- GitHub dispatch semantics: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch
- GitHub dispatch API and Actions write: https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event
- GitHub run read and cancel permissions: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#cancel-a-workflow-run
- GitHub workflow publication permissions: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28#repository-permissions-for-workflows
- Runtime GITHUB_TOKEN scopes: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defining-access-for-the-github_token-scopes
- Full-SHA action pinning: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#pin-actions-to-a-full-length-commit-sha
- Artifact retention and one-file upload: https://github.com/actions/upload-artifact
