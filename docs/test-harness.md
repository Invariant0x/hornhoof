# The test harness of a product

A product's harness is everything a test needs before it starts: dependencies, builds, the browser, prepared database templates and services. A product has one. It is built once per architecture and kept on every machine, so a run starts on any machine without installing or building anything.

Nobody builds it by hand. The system builds it, the head of the department answers for it and hears when an update fails, and `test_harness` shows where it stands.

## What it is made of

A repository's `.hornhoof/test-environment.json` says what the harness holds. A repository without one is read by its files: `apps/node/src/test-discovery.ts` finds each program in it by its lock and build files, in JavaScript (npm, pnpm, yarn), Python, Go, Rust, Java (Maven, Gradle), PHP and Ruby. Folders of other people's code or examples do not count (`vendor`, `fixtures`, `examples`, `docs` and the like). A manifest with no lock file is refused when nothing else stands, as machines could get different dependencies.

A harness is made of units: the dependencies, and each `prepare` entry. A unit's key is the hash of what it is built from: its inputs, its commands, the machine's programs and architecture, and for a prepared unit the key of its dependencies. So:

- A changed lock file builds the dependencies again, and the units built with them. A changed migration builds only the units that read it.
- Another architecture has other keys, so it gets its own build of the same version. The version in `harnessVersion` leaves the machine out, so it stays one.
- What is stored never changes. A new version is a new entry beside the old one.

## The release check

A project says how its release is checked as a whole in `execution.releaseCheck` of its `test-environment.json`, next to `execution.fullRun`. The whole suite runs exactly once per release, right before the release, in the Tests stage, through that one mechanism, and nobody else starts it or repeats it:

- `{ "mechanism": "ci" }`: the project's own CI runs it for the exact commit of the release, and the release rests on that result.
- `{ "mechanism": "command", "command": { ... } }`: a command of the project's own, which the Tests stage runs once.
- `{ "mechanism": "hornhoof_run", "profile": "full" }`: for a project with nothing else, one shared run of the named profile, started by the Tests stage alone.

A manifest without it is read as before. Everyone else checks only what they touched, in their own workspace.

## Languages and their tools

No language's tools are in the machines' image, and a product gets only those of its own languages, so a compiler a company does not use costs it nothing. They are one unit of the harness (`apps/node/src/test-tools.ts`): fetched once per product and architecture when the harness is first built, checked against the digest published with them, and passed to the other machines in its bundle like any other unit. While a part runs they are on its `PATH` by name.

| Language | What comes | From |
| --- | --- | --- |
| Go | Go | go.dev |
| Rust | rustup, the toolchain, and the C tools that link it | static.rust-lang.org, Debian packages |
| Java | a JDK, and Maven or Gradle | Adoptium, Maven Central, gradle.org |
| PHP | PHP and Composer | static-php-cli (it publishes no digest), getcomposer.org |
| Ruby | Ruby, built once from source, and the C tools and libraries it builds with | ruby-lang.org, Debian packages |

Node and Python are the machines' own, so a key holds their version and a run gets the version its machine has.

Java takes its home from the system, not from `HOME`, and a job user's there is not its to write. So each part gets `GRADLE_USER_HOME` of its own: a copy of what the build left in `.hornhoof/gradle/home` of the program, or `.hornhoof/gradle-home`, stored empty, for a command outside one. A description written by hand that runs Gradle needs the same.

The head of development and the owner choose the languages when they choose the architecture, and name them in `.tool-versions` at the root of the repository, in the format asdf reads (`golang 1.25.4`, `java 21`). The harness then comes up before there is any code, with one suite, `tools`, that shows each of them runs. What that file names wins, but for a Rust toolchain file, which Rust obeys in its project: both then come. Without it a version comes from the project's own files (`go.mod`, `rust-toolchain.toml`, `pom.xml`, `build.gradle`, `composer.json`, `.ruby-version` and the like), and with no word on it, from the newest version known when the code was written.

## Several programs

Each repository of a company is a product with a harness of its own, built and spread apart from the others.

One repository may hold several programs, in one language or many. Each gets a unit of its own, `dependencies-<language>-<folder>`, and a suite of its own that runs in its folder, so a changed lock file rebuilds that one program. They share the tools, one version per language, the newest any of them asks for. A changed tool version builds the tools and every program again.

## How it reaches every machine

Every minute the server (`apps/server/src/modules/testruns/harness.ts`) reads the head of each product's default branch and asks every machine that may take the product's parts to get it ready.

1. The first machine to ask for a unit holds a lease on it and builds. The others wait.
2. The builder packs the stored tree (`apps/node/src/test-bundle.ts`) and sends it to the server in parts of 32 MiB, each sent again by itself when it fails.
3. The others take the bundle and check every file against what its header says before anything is stored.

Dependencies that came ready on another branch, a program's as well as the product's, go to the other machines at once, so a run on that branch finds them there. A machine that comes back after being away is asked again, as it may have lost its folder.

A run reaches the harness the same way, should it come first: what the machine lacks, it claims. A manual `run_tests` command gets it before it starts, with at most 10 minutes for it. When that fails its log says so and the command starts anyway, as it may install for itself.

With `cache: "link"` a part gets read-only hard links to the one stored tree, which takes under a second for tens of thousands of files. A part can replace a linked file and add its own, and cannot change what the next part gets. `cache: "copy"` gives each part its own copy. An artifact of a prepared unit says which it wants: what a run only reads is linked (`link: true`), what it writes into is copied, like Cargo's `target`. Every stored file has one fixed time, the same on every machine, so a tool that compares times finds what it got up to date.

## When an update fails

Nothing that works stops. The stored versions stay, so runs on commits with a good harness go on. A run on the commit whose build fails ends with why. The head hears once, whatever number of machines ran into it, until the harness is good again. The build is tried again after 5 minutes, then twice as long each time, up to an hour apart.

## What it costs a machine

A machine keeps the 8 dependency trees and 64 prepared trees it used last, and whatever a run may still read: nothing used within the last 3 hours goes. A tree nobody used for 7 days goes. The server keeps bundles up to `HARNESS_MB` megabytes (20480 by default) in `HARNESS_DIR`, and drops those used longest ago. A server with no `HARNESS_DIR` keeps none, and each machine then builds its own.

## Measuring it

`apps/node/test/harness.measure.ts` measures the time to the first test before and after on one machine, on the real repository, with real npm, git and builds. No test run starts it. From `apps/node`, on a committed tree:

```sh
HH_MEASURE_OUT=results.json npx --no-install vitest run --config vitest.measure.config.ts test/harness.measure.ts
```

`apps/node/test/languages.measure.ts` takes a real project of each language, and a repository with several programs, from nothing but its files. One machine builds, another takes it and runs the tests with the network closed, and a broken test then fails. It downloads the real tools, so no test run starts it either. `-t 'project: rust$'` picks one.
