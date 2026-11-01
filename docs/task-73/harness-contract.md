# Required B0 harness contract

Status: PROPOSED. The harness is a separate required implementation result. This proposal does not implement native controls or claim B0 readiness.

## Entry point and exit status

The workflow invokes only the approved `ci/b0-probe/run.mjs` through the verified launcher and native executable. The harness starts its synthetic HTTP model stub inside the same container and network namespace as the CLI, binds only to `127.0.0.1` on an ephemeral port, and passes no personal credentials.

- Exit 0 means every case claimed by the selected suite passed its own acceptance predicate.
- Exit 2 means a requested capability is unsupported, with an allowlisted GAP failure class and null counts where unmeasured.
- Any other nonzero exit means failure or infrastructure error, never PASS.
- Missing result, malformed result, missing positive control or missing runtime version is an infrastructure failure.

The `isolation` suite must pass before `codex-positive`. The `codex-positive` suite must pass before `codex-d2`. A successful earlier suite does not qualify a later one.

## Isolation controls

Before any CLI invocation, the harness must prove all of these with harmless controls:

1. The container has only the loopback network device. A raw request to the local stub succeeds.
2. External IPv4 connection attempts from the harness and from a spawned descendant fail at the kernel boundary. Use fixed documentation or infrastructure addresses with short timeouts, not a provider endpoint.
3. External DNS resolution fails. Proxy variables are not evidence of isolation.
4. Home, config, cache, data and temporary directories are new and empty. No host home, agent folder, credential, auth file or socket is mounted.
5. The root filesystem and mounted CLI and harness are read-only. No Docker socket is present. The process runs as non-root with no effective capabilities and no-new-privileges.
6. Model stub, CLI and all descendants share the loopback-only network namespace. The external denial control must include a CLI descendant, not only the harness parent.
7. Time, process, memory and output limits are enforced. Raw CLI output is captured and bounded or discarded, never streamed to the Actions log.

`denied = 0` is not a model denial result. It is only a network control counter.

## Actual positive model control

For `codex-positive`, the harness must configure the actual pinned Codex CLI, not a fake script, to use the synthetic loopback endpoint with an empty fresh profile. It must verify the native executable hash again before launch and observe the runtime version separately from package metadata.

PASS requires a model request attributed to that CLI process at the stub, at least one counted model request, and consumption of a synthetic response that allows the CLI to finish the bounded scenario. Authentication, startup or configuration failure with zero requests is not PASS. The stub records only method classification, UTC and counters, never authorization headers, prompts or reasoning.

## D2 request boundaries

The existing task 63 `hh-hook` result is observer-only. It must not be reused as a before-send grant. Before `codex-d2` can run, a separate reviewed result must establish a provider-supported blocking point before every claimed inference request, bound to the current synthetic subscription, process or session and request identity. Timeout, unavailable control, duplicate grant and late grant must fail closed without releasing a request.

Each entry path and internal request type is a separate case. Counting a Hornhoof job, terminal paste or user prompt does not count an inference request. The current started response may complete, but every later retry, tool continuation, compaction or new prompt needs a new admission decision. The full case list is in `coverage.json`; unsupported cases remain GAP and cannot be dropped to make the suite pass.

The other five lanes require their own pinned artifacts and equivalent positive and D2 controls. Passing Codex does not qualify Claude, Kimi, Anthropic API, OpenAI API or GLM.

## Result allowlist

The only uploaded file is `/output/result.json`, at most 65,536 bytes. `validate-result.mjs` must reject unknown fields, oversized strings or arrays, non-UTC timestamps, negative counters, non-integer counters and any numeric count for an unexecuted case. It must not print the JSON or raw CLI output.

Allowed top-level fields:

- `schemaVersion`: integer 1, required.
- `status`: `pass`, `fail`, `gap` or `infra_failure`, required.
- `failureClass`: one short allowlisted identifier or null.
- `approvedCommit`: exactly 40 lowercase hexadecimal characters when known, otherwise null.
- `suite`: `isolation`, `codex-positive`, `codex-d2` or null.
- `lane`: `codex` or null.
- `startedAt`, `endedAt`: UTC ISO 8601 strings or null.
- `cli`: null, or an object containing only `packageVersion`, `nativePackageVersion`, `runtimeVersion`, `launcherSha256` and `nativeSha256`.
- `isolation`: null, or an object containing only boolean loopback, fresh-profile, descendant-denial, DNS-denial and confinement checks.
- `modelCounts`: null, or an object containing only `positive`, `denied`, `internalRetry`, `toolContinuation` and `compaction`, each a nonnegative integer or null.
- `cases`: at most 32 objects, each containing only an allowlisted `id`, `status`, `modelRequests` and `failureClass`.

The emergency fallback written by the workflow contains only `schemaVersion`, `status`, `failureClass` and `modelCounts`. All other absent fields remain absent, not fabricated values.

Forbidden output includes environment variables, tokens, cookies, authorization headers, personal paths, profile contents, auth status, full URLs other than fixed public upstream metadata, prompts, completions, reasoning, session logs, raw CLI output and stack traces. The artifact is one unzipped JSON file with one-day retention, not a general evidence service.
