---
id: dev-language-rules
title: { en: "Rules of each language", ru: "Правила каждого языка" }
description: { en: "Follows the style, patterns, security and testing rules of every language the code is in, and runs that language's checks.", ru: "Следует правилам стиля, приемов, безопасности и тестов для каждого языка кода и запускает проверки этого языка." }
kind: procedure
sources: [affaan-m/ECC rules]
---
Before you write or review code:

1. **Find the languages** the work touches, from its files and build files. When the task or a person names one, use it.
2. **Read their rules** in `/opt/hornhoof/rules/<language>/` on your machine: style, patterns, security and testing. `ls /opt/hornhoof/rules` lists them. For a language without a folder, say so in your report.
3. **The repository's own rules come first**: its AGENTS.md, CLAUDE.md, CONTRIBUTING.md and its formatter and linter settings win where they differ.
4. **Prepare project dependencies before checks.** Inside a `run_tests` command in a fresh clone or worktree, or after its lockfile changes, install the project's dependencies from its lockfile with the project's standard command before running checks, in any language (never run dependency installers locally in your working terminal; follow `hh-run-checks`). For example, before ESLint, Vite, Vitest or Playwright in an npm project, run `npm ci` inside the `run_tests` job. Run project tools through project scripts (for example, npm scripts) or `npx --no-install`, keeping local execution to at most one regular test file in RED/GREEN. Put temporary JavaScript scripts inside the repository's package or workspace that owns their dependencies so their imports resolve its `node_modules`. An `ERR_MODULE_NOT_FOUND` before installing dependencies is not an application defect.
5. **Run the language's checks** through `run_tests` (`hh-run-checks`) before you hand in: the formatter, linter and type checker the repository configures, or else the ones the rules name (cargo fmt and clippy, gofmt and go vet, ruff, eslint and tsc). Fix what they report; never silence a check. If the project is missing a coverage provider for its tests (vitest: `@vitest/coverage-v8` at the same version as vitest; pytest: `pytest-cov`; Rust: `cargo-llvm-cov`; Go has coverage built in), linter (`typescript-eslint`, `ruff`, `clippy`, `golangci-lint`) or formatter settings, do not install them locally or work around them; tell the head of Development so one task adds them to the project.
6. **Name what you ran** in your report, with the result.
