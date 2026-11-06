# Task 535: prepared command for the official Playwright image

Status: prepared and unexecuted. Syntax check, image availability/digest, three-engine execution and artifact delivery through the runner are NOT_VERIFIED. No new probe, install, image build or Docker command was run. This payload is for the runtime owner's existing admitted execution context after the resource decision; it creates no new runner or public commandEnvironment field.

## Image and scope

Official image: `mcr.microsoft.com/playwright:v1.64.1-noble`, matching the repository's locked `@playwright/test` 1.64.1. The [official Docker documentation](https://playwright.dev/docs/docker) lists this tag and states that the image supplies browsers and system dependencies while the project's Playwright package is installed separately. The [official Dockerfile](https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.noble) documents the browser directory `/ms-playwright` and Git/Node tooling. These documents were read on 2026-11-06; their current main branch is not an attestation of the local image's digest or Node patch version.

The command does not pull an image. The runtime owner first supplies the approved official tag in its existing Docker context. The command requires a local image ID and an official repository digest, records both and runs that exact image ID with `--pull=never`. An unavailable image/digest is a precondition failure, not permission for another image or an installation.

The source and harness are the already probed immutable commit `1b0bc54b4fbf6d1d468ced679ac2897372b29c71`. Probe file SHA256: `8b73f954cdfcb62bd44430a77bf9694a43a975e8e96bb1569268fdca9bcb42bb`. One company notebook screen, longest actual shipped locale on that source, light theme, 375x812, DPR 1; Chromium, Firefox and WebKit sequentially. This is the same compatibility scope as 729, not the 89-row matrix or approved-main/candidate comparison.

## One command

The full executable text is in [2026-11-06-official-playwright-command.sh.txt](2026-11-06-official-playwright-command.sh.txt). In the approved runtime context:

```sh
bash docs/superpowers/reports/2026-11-06-official-playwright-command.sh.txt /absolute/local/hornhoof /absolute/new/task-535-output
```

The first path is a local repository that already contains the pinned source object. It may be a worktree: the command creates a separate shallow local checkout of only the pinned commit. No network Git fetch, source-directory copy, host node_modules, global Git configuration or repository credentials are copied. The output path must not exist; its parent must already be writable by the ordinary execution user. Paths used in Docker bind mounts must not contain commas. Execute as an existing non-root user with the approved Docker context; the command does not grant Docker access or mount a daemon socket into the container.

Mounts and execution:

- The temporary credential-free pinned checkout is mounted read-only at `/input`.
- The new output directory is mounted read/write at `/out`, with the caller's numeric UID/GID.
- `/work` and `/tmp` are disposable container-local tmpfs mounts. The root filesystem is read-only; no host source directory is writable.
- The process is non-root, uses `--init`, two CPU quota, 4 GiB memory and private IPC with 1 GiB shared memory. No host network/IPC, published ports or added capabilities are requested.
- A writable source copy receives `npm ci`, protocol build and web build, then the existing probe. No browser or system dependency installer runs. A 300-second command deadline plus a 15-second termination grace leaves time for diagnostics within a six-minute run part.

Actual Node version, architecture, UID, quotas, load and image metadata are recorded, not inferred from a machine label. The official image's Node may differ from run 729's Node 22.23.4; this is a compatibility check, not a performance comparison. The fixture binds its own source SHA, data and built font hashes. Missing libraries, launch errors or screenshot/export failures remain failures.

## Files to return

Return every existing file from the output directory, including failed/timeout diagnostics:

- `image.json`: requested tag, actual local image ID, repository digests, OS/architecture and version label.
- `environment.json`: actual process/resource facts and the recorded image metadata.
- `geometry.json`: source/profile/font/data identity, actual per-engine versions/statuses and raw geometry; `acceptedGeometryResult` stays false.
- `chromium.png`, `firefox.png`, `webkit.png`: only screenshots actually produced, verified against their stdout size, PNG signature and SHA256. Missing screenshots are not fabricated.
- `full.log`: complete build and probe stdout/stderr, retained before interpreting the outcome.
- `test-exit-code.txt`: the inner setup/build/probe/timeout exit status, written before artifact decoding. An export error cannot replace this outcome.
- `artifacts.json`: names, sizes and SHA256 of the stable container outputs. It is a manual inventory, not a canonical 546 artifact receipt.
- `docker.log` and `exit-code.txt`: outer Docker diagnostics and native exit status. If setup, container start, timeout or export prevents an expected file, report that absence explicitly; keep the files that exist.

No output is a deployed run/part/author ACL receipt. The resource owner must return files through the approved company route and bind actual run/part/source/identity. This draft has not proven that route, actual digest, all three engines or geometry acceptance.
