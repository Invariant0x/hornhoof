---
id: dev-language-rules
title: { en: "Rules of each language", ru: "Правила каждого языка" }
description: { en: "Follows the style, patterns, security and testing rules of every language the code is in.", ru: "Следует правилам стиля, шаблонам, требованиям безопасности и тестирования каждого языка, на котором написан код." }
kind: procedure
sources: [affaan-m/ECC rules]
---
You can apply the codebase and language rules appropriate to a change.

Before you write or review code:

1. **Find the languages** the work touches, from its files and build files. When the task or a person names one, use it.
2. **Read their rules** in `/opt/hornhoof/rules/<language>/` on your machine: style, patterns, security and testing. `ls /opt/hornhoof/rules` lists them. For a language without a folder, say so in your report.
3. **The repository's own rules come first**: its AGENTS.md, CLAUDE.md, CONTRIBUTING.md and its formatter and linter settings win where they differ.
4. **Project dependencies come prepared for whole suites.** A `run_tests` command starts with the product's harness in place, so it installs and builds nothing first, in any language. Only when its log says it started without the harness, install from the lockfile with the project's standard command inside that same job, and say so in your report. Install from the lockfile in your workspace once, and again when the lockfile changes. Run project tools through the project's own scripts. In an npm project: run tools through npm scripts or `npx --no-install`, and put temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies so their imports resolve its `node_modules`; an `ERR_MODULE_NOT_FOUND` when a run started without the harness is not an application defect.
5. **The language checks** are the formatter, linter and type checker the repository configures, or else the ones the rules name (cargo fmt and clippy, gofmt and go vet, ruff, eslint and tsc). Run them in your own workspace right away when building or reviewing a change. Never silence a check. If the project is missing a coverage provider for its tests (vitest: `@vitest/coverage-v8` at the same version as vitest; pytest: `pytest-cov`; Rust: `cargo-llvm-cov`; Go has coverage built in), linter (`typescript-eslint`, `ruff`, `clippy`, `golangci-lint`) or formatter settings, add the required project dependency or settings in the assigned scope, update the lockfile and install locally; report any missing authorization rather than silencing the check.
6. **Name what you ran** in your report, with the result.
