# The test harness of a product

A product's harness is everything a test needs before it starts: dependencies, builds, the browser, prepared database templates and services. A product has one. It is built once per architecture and kept on every machine, so a run starts on any machine without installing or building anything.

Nobody builds it by hand. The system builds it, the head of the department answers for it and hears when an update fails, and `test_harness` shows where it stands.

## What it is made of

A repository's `.hornhoof/test-environment.json` says what the harness holds. A repository without one is read by its files: `apps/node/src/test-discovery.ts` brings up JavaScript (npm, pnpm, yarn) and Python from their lock and requirement files. It names Go, Rust, PHP, Ruby and Java as languages the machines cannot build yet, as their toolchains are not in the image.

A harness is made of units: the dependencies, and each `prepare` entry. A unit's key is the hash of what it is built from: its inputs, its commands, the machine's programs and architecture, and for a prepared unit the key of its dependencies. So:

- A changed lock file builds the dependencies again, and the units built with them. A changed migration builds only the units that read it.
- Another architecture has other keys, so it gets its own build of the same version. The version in `harnessVersion` leaves the machine out, so it stays one.
- What is stored never changes. A new version is a new entry beside the old one.

## How it reaches every machine

Every minute the server (`apps/server/src/modules/testruns/harness.ts`) reads the head of each product's default branch and asks every machine that may take the product's parts to get it ready.

1. The first machine to ask for a unit holds a lease on it and builds. The others wait.
2. The builder packs the stored tree (`apps/node/src/test-bundle.ts`) and sends it to the server in parts of 32 MiB, each sent again by itself when it fails.
3. The others take the bundle and check every file against what its header says before anything is stored.

Dependencies that came ready on another branch go to the other machines at once, so a run on that branch finds them there. A machine that comes back after being away is asked again, as it may have lost its folder.

A run reaches the harness the same way, should it come first: what the machine lacks, it claims. A manual `run_tests` command gets it before it starts, with at most 10 minutes for it. When that fails its log says so and the command starts anyway, as it may install for itself.

With `cache: "link"` a part gets read-only hard links to the one stored tree, which takes under a second for tens of thousands of files. A part can replace a linked file and add its own, and cannot change what the next part gets. `cache: "copy"` gives each part its own copy.

## When an update fails

Nothing that works stops. The stored versions stay, so runs on commits with a good harness go on. A run on the commit whose build fails ends with why. The head hears once, whatever number of machines ran into it, until the harness is good again. The build is tried again after 5 minutes, then twice as long each time, up to an hour apart.

## What it costs a machine

A machine keeps the 8 dependency trees and 64 prepared trees it used last, and whatever a run may still read: nothing used within the last 3 hours goes. A tree nobody used for 7 days goes. The server keeps bundles up to `HARNESS_MB` megabytes (20480 by default) in `HARNESS_DIR`, and drops those used longest ago. A server with no `HARNESS_DIR` keeps none, and each machine then builds its own.

## Measuring it

`apps/node/test/harness.measure.ts` measures the time to the first test before and after on one machine, on the real repository, with real npm, git and builds. No test run starts it. From `apps/node`, on a committed tree:

```sh
HH_MEASURE_OUT=results.json npx --no-install vitest run --config vitest.measure.config.ts
```
