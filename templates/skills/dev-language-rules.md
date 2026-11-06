---
id: dev-language-rules
title: { en: "Rules of each language", ru: "Правила каждого языка" }
description: { en: "Follows each language's coding rules and separates author tests from shared final checks.", ru: "Следует правилам каждого языка и разделяет тесты автора и общие итоговые проверки." }
kind: procedure
sources: [affaan-m/ECC rules]
---
For `small: true` and ordinary work, follow the language's coding rules and run only affected tests through run_tests. Submit the tests written, green results and commit SHA. The test engineer or QA owns the remaining language checks once per turn on the final candidate; detailed reports belong to those shared checks.

Before you write or review code:

1. **Find the languages** the work touches, from its files and build files. When the task or a person names one, use it.
2. **Read their rules** in `/opt/hornhoof/rules/<language>/` on your machine: style, patterns, security and testing. `ls /opt/hornhoof/rules` lists them. For a language without a folder, say so in your report.
3. **The repository's own rules come first**: its AGENTS.md, CLAUDE.md, CONTRIBUTING.md and its formatter and linter settings win where they differ.
4. **Prepare project dependencies before checks.** Inside a `run_tests` command in a fresh clone or worktree, or after its lockfile changes, install the project's dependencies from its lockfile with the project's standard command before running checks, in any language (never run dependency installers locally in your working terminal; follow `hh-run-checks`). For example, before ESLint, Vite, Vitest or Playwright in an npm project, run `npm ci` inside the `run_tests` job. Run project tools through project scripts (for example, npm scripts) or `npx --no-install`, running developer affected tests only through run_tests. Put temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies so their imports resolve its `node_modules`. An `ERR_MODULE_NOT_FOUND` before installing dependencies is not an application defect.
5. **Final language checks belong to the test engineer or QA**, once per turn through `run_tests` (`hh-run-checks`): the formatter, linter and type checker the repository configures, or else the ones the rules name (cargo fmt and clippy, gofmt and go vet, ruff, eslint and tsc). Return failures to authors as tasks; never silence a check. If the project is missing a coverage provider for its tests (vitest: `@vitest/coverage-v8` at the same version as vitest; pytest: `pytest-cov`; Rust: `cargo-llvm-cov`; Go has coverage built in), linter (`typescript-eslint`, `ruff`, `clippy`, `golangci-lint`) or formatter settings, do not install them locally or work around them; tell the head of Development so one task adds them to the project.
6. **Name what you ran** in your report, with the result.
