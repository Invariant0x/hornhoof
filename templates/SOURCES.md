# Where these templates learned from

Every role and skill text in this folder is written for Hornhoof, with one exception: dev-engineering-rules quotes unclebob/ub-mode's SKILL.md word for word at commit 3da62bf3fcfd2034de41f30d920d2739e566171f, from "Every time you are asked to make a change follow:" to its end, as its README asks people to copy it. The lines above the quote are Hornhoof's own and win where the two differ: they bound the quote by the assigned task, touch the main line only when a task names it, make a report the result and its evidence, run quality tools only when assigned, question the premise after three failed fixes, and say how old data is treated before and after version 1.0. Hornhoof's branch, tooling and testing adaptations are in dev-testing-policy. No other text in this folder is copied from the sources below; they taught us what a role does and which steps a procedure needs. Each skill names its sources in its `sources` field as `<repo> <path>`.

The list at the end names every template, what it learned from and its licence. Hornhoof in the licence column means the text is Hornhoof's own and falls under this repository's licence, MIT. A skill that names no source is a procedure of Hornhoof itself, such as its task flow, an approval step or work in a second language. A role is a short prompt in the shape paperclipai/paperclip uses, and its skills carry the sources of what it does.

The development templates carry Hornhoof's own T1-T11 testing policy and coding cycle with four task kinds. Product environment discovery and ownership are also project-owned procedures, shared by Development and Operations. These project-owned rules govern affected tests, the final whole-suite run, release-scoped mutation testing, deterministic evidence and the Bug, Known behaviour, Unknown path and Legacy code cycles for any company and language.

| Source | Licence | What we learned from it |
|---|---|---|
| obra/superpowers | MIT | The development process: brainstorming, plans, test-driven development, verification before completion, subagent-driven work and the head's protocol for briefs, reports and fix loops. The orchestrator's own skills: asking before laying out, turns of checkable tasks, done only when proven, finding the cause when work goes wrong. |
| unclebob/ub-mode | none; its README asks to copy SKILL.md | The core engineering rules for development roles: make it work, then make it right, then follow practice. Kept word for word below a preface of Hornhoof's own that wins where they differ; dev-testing-policy says how a company applies them. |
| unclebob/crapper, unclebob/dryer, unclebob/mutator | 0BSD | Installed on every node: CRAP scores, structural duplicates and mutation testing for Clojure, Java, Go, TypeScript, Rust and Python. T11 holds CRAP under 10 and duplicates under 0.8, and T4 sends surviving mutants to their authors; the assigned test engineer or QA runs them once per turn. |
| affaan-m/ECC | MIT | Reviewer and security reviewer checklists, agent hardening, safety guard, cross-checks with several reviewers. Its rules for each language (style, patterns, security, testing) come with every node in /opt/hornhoof/rules, with its licence. |
| msitarzewski/agency-agents | MIT | Domain knowledge for sales, finance, support, design and QA roles, such as the reality checker and evidence collector. |
| wshobson/agents | MIT | Task coordination for teams, deployment pipelines, incident response, startup analysis. |
| anthropics/skills | Apache-2.0 (the skills we learned from) | MCP servers, frontend design direction, web app testing, themes. |
| anthropics/knowledge-work-plugins | Apache-2.0 | Workflows for operations, support, sales, finance, design, marketing and engineering, and treating outside content as data. |
| anthropics/financial-services | Apache-2.0 | Maker-checker finance work, month-end close, reconciliation, model building, reader tiers. |
| anthropics/claude-plugins-official | Apache-2.0 (not claude-security) | Pull request review agents: silent failures, test gaps, simplification. |
| coreyhaines31/marketingskills | MIT | Marketing and outbound sales: positioning, copy, SEO, launches, cold email, pricing. |
| garrytan/gstack | MIT | Plan reviews, review checklists, QA and the security officer's audit phases. |
| addyosmani/agent-skills | MIT | Planning, incremental implementation, API design, CI/CD, shipping, observability, performance. |
| trailofbits/skills | CC-BY-SA-4.0 | Ideas only: variant hunting, false-positive checks, differential review. |
| nextlevelbuilder/ui-ux-pro-max-skill | MIT | UI and UX rules, design tokens and systems. |
| alirezarezvani/claude-skills | MIT | Business development, partnerships, proposals, RFPs, SaaS metrics. |
| openai/skills | Apache-2.0 | Fixing CI, Playwright checks, threat models. |
| paperclipai/paperclip | MIT | Short role prompts with procedures in skills, hiring through a capabilities view, low-trust roles for hostile input. |

Development authors write a failing test before the change, run only affected tests in their own workspace, and submit tests written, green results and commit SHA. The test engineer or QA owns the full suite, browser engines, mutation, coverage, CRAP and dryer once per turn on the final candidate; findings in logic return to authors as tasks, small fixes by the fast path, and the tester fixes a flaky or outdated test or an obvious trifle itself in a separate commit. The pipeline procedures also separate shared checks from nonblocking improvement lanes, assign each work area to one owner, bound waits and preserve author-check and run evidence without duplicate runs. This verification ownership adapts the development roles and skills below.

## Every template

| File | Where the text comes from | What it learned from | Licence |
|---|---|---|---|
| `roles/business_development/BIZ-ANALYST.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/business_development/BIZ-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/business_development/BIZ-PARTNER.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/business_development/BIZ-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/business_development/BIZ-REV.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/design/DSN-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/design/DSN-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/design/DSN-QA.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/design/DSN-SYS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/design/DSN-UI.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-ARCH.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-BE.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-DOCS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-ENG.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-FE.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/development/DEV-OPS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-PERF.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-QA.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/development/DEV-RED.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-REV.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-SEC.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/development/DEV-TEST.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/finance/FIN-AUDIT.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/finance/FIN-BOOK.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/finance/FIN-FPA.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/finance/FIN-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/finance/FIN-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-SEO.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-SOCIAL.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-WRITE.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/marketing/MKT-EDIT.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/operations/OPS-ACCT.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/operations/OPS-BUGS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/operations/OPS-FIX.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/operations/OPS-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/operations/OPS-INTEG.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources; project-owned test-environment responsibilities | Hornhoof |
| `roles/operations/OPS-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/operations/OPS-PROGRAM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/operations/OPS-WATCH.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-AE.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-OPS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-REV.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/sales/SAL-SDR.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-KB.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-T1.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-T2.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/support/SUP-QA.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `skills/biz-business-strategy.md` | Written for Hornhoof | msitarzewski/agency-agents specialized/business-strategist.md | Hornhoof |
| `skills/biz-channel-economics.md` | Written for Hornhoof | alirezarezvani/claude-skills commercial/skills | Hornhoof |
| `skills/biz-competitive-landscape.md` | Written for Hornhoof | anthropics/financial-services plugins/agent-plugins/market-researcher/skills/competitive-analysis/SKILL.md; wshobson/agents plugins/startup-business-analyst | Hornhoof |
| `skills/biz-deal-terms.md` | Written for Hornhoof | alirezarezvani/claude-skills commercial/skills; anthropics/knowledge-work-plugins legal/skills/review-contract/SKILL.md; anthropics/knowledge-work-plugins legal/skills/triage-nda/SKILL.md | Hornhoof |
| `skills/biz-decision-council.md` | Written for Hornhoof | affaan-m/ECC skills/council/SKILL.md | Hornhoof |
| `skills/biz-deep-research.md` | Written for Hornhoof | affaan-m/ECC skills/deep-research/SKILL.md | Hornhoof |
| `skills/biz-market-sizing.md` | Written for Hornhoof | wshobson/agents plugins/startup-business-analyst/skills/market-sizing-analysis/SKILL.md | Hornhoof |
| `skills/biz-marketplace-listings.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/directory-submissions/SKILL.md | Hornhoof |
| `skills/biz-opportunity-scoring.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/biz-partner-evaluation.md` | Written for Hornhoof | alirezarezvani/claude-skills commercial/skills/partnerships-architect/SKILL.md | Hornhoof |
| `skills/biz-sector-overview.md` | Written for Hornhoof | anthropics/financial-services plugins/agent-plugins/market-researcher | Hornhoof |
| `skills/biz-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-adversarial.md` | Written for Hornhoof | garrytan/gstack review/specialists/red-team.md; msitarzewski/agency-agents security/security-penetration-tester.md; trailofbits/skills | Hornhoof |
| `skills/dev-api-design.md` | Written for Hornhoof | addyosmani/agent-skills skills/api-and-interface-design/SKILL.md; wshobson/agents plugins/backend-development/skills/api-design-principles/SKILL.md | Hornhoof |
| `skills/dev-browser-check.md` | Written for Hornhoof | openai/skills skills/.curated/playwright/SKILL.md; anthropics/skills skills/webapp-testing/SKILL.md | Hornhoof |
| `skills/dev-ci-release.md` | Written for Hornhoof | addyosmani/agent-skills skills/ci-cd-and-automation/SKILL.md; wshobson/agents plugins/cicd-automation/skills/deployment-pipeline-design/SKILL.md; openai/skills skills/.curated/gh-fix-ci/SKILL.md | Hornhoof |
| `skills/dev-cleanup.md` | Written for Hornhoof | affaan-m/ECC agents/refactor-cleaner.md; addyosmani/agent-skills skills/code-simplification/SKILL.md | Hornhoof |
| `skills/dev-debugging.md` | Written for Hornhoof | obra/superpowers skills/systematic-debugging/SKILL.md | Hornhoof |
| `skills/dev-deploy-rollback.md` | Written for Hornhoof | anthropics/knowledge-work-plugins engineering/skills/deploy-checklist/SKILL.md; addyosmani/agent-skills skills/shipping-and-launch/SKILL.md; affaan-m/ECC skills/docker-patterns/SKILL.md | Hornhoof |
| `skills/dev-docs.md` | Written for Hornhoof | affaan-m/ECC agents/doc-updater.md; anthropics/knowledge-work-plugins engineering/skills/documentation/SKILL.md | Hornhoof |
| `skills/dev-e2e-tests.md` | Written for Hornhoof | affaan-m/ECC skills/e2e-testing/SKILL.md; openai/skills skills/.curated/playwright/SKILL.md; obra/superpowers skills/systematic-debugging/condition-based-waiting.md | Hornhoof |
| `skills/dev-engineering-rules.md` | unclebob/ub-mode SKILL.md word for word from "Every time you are asked to make a change follow:" to the end, at the commit named above; the lines above the quote are written for Hornhoof | unclebob/ub-mode SKILL.md | ub-mode names no licence, and its README asks people to copy SKILL.md; the lines above the quote: Hornhoof |
| `skills/dev-frontend-ui.md` | Written for Hornhoof | addyosmani/agent-skills skills/frontend-ui-engineering/SKILL.md; anthropics/skills skills/frontend-design/SKILL.md | Hornhoof |
| `skills/dev-gates.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/SKILL.md; affaan-m/ECC skills/council-multi-model/SKILL.md; affaan-m/ECC skills/santa-method/SKILL.md | Hornhoof |
| `skills/dev-i18n-en-ru.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-implement.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/implementer-prompt.md; addyosmani/agent-skills skills/incremental-implementation/SKILL.md; addyosmani/agent-skills skills/source-driven-development/SKILL.md | Hornhoof |
| `skills/dev-language-rules.md` | Written for Hornhoof | affaan-m/ECC rules | Hornhoof |
| `skills/dev-lead.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-migrations.md` | Written for Hornhoof | affaan-m/ECC skills/database-migrations/SKILL.md | Hornhoof |
| `skills/dev-release-improvements.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-performance.md` | Written for Hornhoof | affaan-m/ECC agents/performance-optimizer.md; addyosmani/agent-skills skills/performance-optimization/SKILL.md; garrytan/gstack review/specialists/performance.md | Hornhoof |
| `skills/dev-plan-review.md` | Written for Hornhoof | garrytan/gstack plan-eng-review/SKILL.md.tmpl; affaan-m/ECC agents/architect.md; affaan-m/ECC skills/architecture-decision-records/SKILL.md | Hornhoof |
| `skills/dev-qa-acceptance.md` | Written for Hornhoof | msitarzewski/agency-agents testing/testing-reality-checker.md; msitarzewski/agency-agents testing/testing-evidence-collector.md; garrytan/gstack qa/SKILL.md.tmpl | Hornhoof |
| `skills/dev-release-notes.md` | Written for Hornhoof | garrytan/gstack document-release/SKILL.md.tmpl | Hornhoof |
| `skills/dev-review-diff.md` | Written for Hornhoof | affaan-m/ECC agents/code-reviewer.md; obra/superpowers skills/requesting-code-review/code-reviewer.md; anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md; garrytan/gstack review/checklist.md | Hornhoof |
| `skills/dev-review-fix.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-security-fix.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-review-verdict.md` | Written for Hornhoof | obra/superpowers skills/requesting-code-review/code-reviewer.md | Hornhoof |
| `skills/dev-security-review.md` | Written for Hornhoof | affaan-m/ECC agents/security-reviewer.md; addyosmani/agent-skills skills/security-and-hardening/SKILL.md; garrytan/gstack review/specialists/security.md; affaan-m/ECC skills/agent-security-hardening/SKILL.md | Hornhoof |
| `skills/dev-task-flow.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-tdd.md` | Written for Hornhoof | obra/superpowers skills/test-driven-development/SKILL.md; obra/superpowers skills/test-driven-development/writing-good-tests.md | Hornhoof |
| `skills/dev-test-environment.md` | Written for Hornhoof | No outside source: product test-environment discovery and ownership procedure | Hornhoof |
| `skills/dev-test-gaps.md` | Written for Hornhoof | anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/pr-test-analyzer.md; garrytan/gstack review/specialists/testing.md; anthropics/knowledge-work-plugins engineering/skills/testing-strategy/SKILL.md | Hornhoof |
| `skills/dev-testing-policy.md` | Written for Hornhoof | unclebob/crapper README.md; unclebob/dryer README.md; unclebob/mutator README.md | Hornhoof |
| `skills/dev-threat-model.md` | Written for Hornhoof | openai/skills skills/.curated/security-threat-model/SKILL.md; wshobson/agents plugins/security-scanning/skills/stride-analysis-patterns/SKILL.md; wshobson/agents plugins/security-scanning/skills/attack-tree-construction/SKILL.md | Hornhoof |
| `skills/dev-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dev-worktrees.md` | Written for Hornhoof | obra/superpowers skills/using-git-worktrees/SKILL.md; obra/superpowers skills/finishing-a-development-branch/SKILL.md | Hornhoof |
| `skills/dev-write-plan.md` | Written for Hornhoof | obra/superpowers skills/brainstorming/SKILL.md; obra/superpowers skills/writing-plans/SKILL.md; anthropics/knowledge-work-plugins engineering/skills/system-design/SKILL.md | Hornhoof |
| `skills/dsn-accessibility-review.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/accessibility-review/SKILL.md; wshobson/agents plugins/ui-design/skills/accessibility-compliance/SKILL.md; affaan-m/ECC agents/a11y-architect.md | Hornhoof |
| `skills/dsn-brand-consistency.md` | Written for Hornhoof | msitarzewski/agency-agents design/design-brand-guardian.md; anthropics/skills skills/brand-guidelines/SKILL.md | Hornhoof |
| `skills/dsn-component-spec.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/design-system/SKILL.md; wshobson/agents plugins/ui-design/skills/design-system-patterns/SKILL.md | Hornhoof |
| `skills/dsn-design-critique.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/design-critique/SKILL.md | Hornhoof |
| `skills/dsn-design-direction.md` | Written for Hornhoof | anthropics/skills skills/frontend-design/SKILL.md | Hornhoof |
| `skills/dsn-design-md.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dsn-generic-ui-check.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dsn-handoff.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/design-handoff/SKILL.md | Hornhoof |
| `skills/dsn-plan-review.md` | Written for Hornhoof | garrytan/gstack plan-design-review/SKILL.md.tmpl | Hornhoof |
| `skills/dsn-system-governance.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/design-system/SKILL.md | Hornhoof |
| `skills/dsn-theme.md` | Written for Hornhoof | anthropics/skills skills/theme-factory/SKILL.md | Hornhoof |
| `skills/dsn-tokens.md` | Written for Hornhoof | nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/design-system/SKILL.md; affaan-m/ECC skills/design-system/SKILL.md | Hornhoof |
| `skills/dsn-ui-rules.md` | Written for Hornhoof | nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/ui-ux-pro-max/SKILL.md; wshobson/agents plugins/ui-design/skills/visual-design-foundations/SKILL.md | Hornhoof |
| `skills/dsn-ux-copy.md` | Written for Hornhoof | anthropics/knowledge-work-plugins design/skills/ux-copy/SKILL.md | Hornhoof |
| `skills/dsn-visual-qa.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/dsn-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/fin-accruals.md` | Written for Hornhoof | anthropics/financial-services plugins/agent-plugins/month-end-closer | Hornhoof |
| `skills/fin-audit-support.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance | Hornhoof |
| `skills/fin-budget-forecast.md` | Written for Hornhoof | msitarzewski/agency-agents finance/finance-fpa-analyst.md | Hornhoof |
| `skills/fin-cash-flow.md` | Written for Hornhoof | anthropics/knowledge-work-plugins small-business/skills/cash-flow-snapshot/SKILL.md | Hornhoof |
| `skills/fin-close-management.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance/skills/close-management/SKILL.md; anthropics/financial-services plugins/agent-plugins/month-end-closer/agents/month-end-closer.md | Hornhoof |
| `skills/fin-controls-testing.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance/skills/sox-testing/SKILL.md | Hornhoof |
| `skills/fin-financial-model.md` | Written for Hornhoof | anthropics/financial-services plugins/agent-plugins/model-builder/skills/3-statement-model/SKILL.md; wshobson/agents plugins/startup-business-analyst/skills/startup-financial-modeling/SKILL.md | Hornhoof |
| `skills/fin-independent-recompute.md` | Written for Hornhoof | anthropics/financial-services managed-agent-cookbooks/README.md | Hornhoof |
| `skills/fin-journal-entries.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance/skills/journal-entry-prep/SKILL.md; anthropics/knowledge-work-plugins finance/skills/journal-entry/SKILL.md; msitarzewski/agency-agents finance/finance-bookkeeper-controller.md | Hornhoof |
| `skills/fin-payables-receivables.md` | Written for Hornhoof | msitarzewski/agency-agents specialized/accounts-payable-agent.md; anthropics/knowledge-work-plugins small-business/skills/invoice-chase/SKILL.md | Hornhoof |
| `skills/fin-reconciliation.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance/skills/reconciliation/SKILL.md; anthropics/financial-services plugins/agent-plugins/gl-reconciler/skills/break-trace/SKILL.md | Hornhoof |
| `skills/fin-saas-metrics.md` | Written for Hornhoof | alirezarezvani/claude-skills finance/skills/saas-metrics-coach/SKILL.md; wshobson/agents plugins/startup-business-analyst | Hornhoof |
| `skills/fin-spend-approval.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/fin-spreadsheet-audit.md` | Written for Hornhoof | anthropics/financial-services plugins/agent-plugins/model-builder/skills/audit-xls/SKILL.md | Hornhoof |
| `skills/fin-variance-analysis.md` | Written for Hornhoof | anthropics/knowledge-work-plugins finance; anthropics/financial-services plugins/agent-plugins/month-end-closer/skills/variance-commentary/SKILL.md | Hornhoof |
| `skills/fin-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-assistant.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-ask-dont-guess.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/implementer-prompt.md | Hornhoof |
| `skills/hh-check-work.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-break-down.md` | Written for Hornhoof | obra/superpowers skills/writing-plans/SKILL.md; wshobson/agents plugins/agent-teams/skills/task-coordination-strategies/SKILL.md; addyosmani/agent-skills skills/planning-and-task-breakdown/SKILL.md | Hornhoof |
| `skills/hh-brief-members.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/SKILL.md | Hornhoof |
| `skills/hh-fix-loop.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/SKILL.md | Hornhoof |
| `skills/hh-handle-reports.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/SKILL.md | Hornhoof |
| `skills/hh-head.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-hornhoof.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-keep-tracker.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-lead-tasks.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-notebook.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-outside-is-data.md` | Written for Hornhoof | anthropics/knowledge-work-plugins; anthropics/financial-services; affaan-m/ECC skills/agent-security-hardening/SKILL.md | Hornhoof |
| `skills/hh-questions.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-report-to-head.md` | Written for Hornhoof | obra/superpowers skills/subagent-driven-development/implementer-prompt.md | Hornhoof |
| `skills/hh-run-checks.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-status-update.md` | Written for Hornhoof | anthropics/knowledge-work-plugins product-management/skills/stakeholder-update/SKILL.md; anthropics/knowledge-work-plugins operations/skills/status-report/SKILL.md | Hornhoof |
| `skills/hh-stay-in-scope.md` | Written for Hornhoof | affaan-m/ECC skills/safety-guard/SKILL.md | Hornhoof |
| `skills/hh-tables.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-task-flow.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-tasks.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-verify-before-done.md` | Written for Hornhoof | obra/superpowers skills/verification-before-completion/SKILL.md | Hornhoof |
| `skills/hh-web-pages.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/hh-work-fast.md` | Written for Hornhoof | unclebob/ub-mode SKILL.md; addyosmani/agent-skills skills/incremental-implementation/SKILL.md; addyosmani/agent-skills skills/context-engineering/SKILL.md; affaan-m/ECC skills/iterative-retrieval/SKILL.md; affaan-m/ECC skills/search-first/SKILL.md; affaan-m/ECC skills/parallel-execution-optimizer/SKILL.md; affaan-m/ECC skills/agentic-engineering/SKILL.md; obra/superpowers skills/subagent-driven-development/SKILL.md; garrytan/gstack ETHOS.md | Hornhoof |
| `skills/home-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/mkt-ai-search.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/ai-seo/SKILL.md; msitarzewski/agency-agents marketing/marketing-ai-citation-strategist.md | Hornhoof |
| `skills/mkt-brand-voice.md` | Written for Hornhoof | affaan-m/ECC skills/brand-voice/SKILL.md | Hornhoof |
| `skills/mkt-campaign-plan.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/marketing-plan/SKILL.md; coreyhaines31/marketingskills skills/launch/SKILL.md; anthropics/knowledge-work-plugins marketing/skills/campaign-plan/SKILL.md | Hornhoof |
| `skills/mkt-community.md` | Written for Hornhoof | coreyhaines31/marketingskills; msitarzewski/agency-agents marketing/marketing-developer-community-builder.md | Hornhoof |
| `skills/mkt-copy-editing.md` | Written for Hornhoof | coreyhaines31/marketingskills; wshobson/agents plugins/avoid-ai-writing/skills/avoid-ai-writing/SKILL.md | Hornhoof |
| `skills/mkt-copywriting.md` | Written for Hornhoof | coreyhaines31/marketingskills; anthropics/knowledge-work-plugins marketing/skills/content-creation/SKILL.md | Hornhoof |
| `skills/mkt-crosspost.md` | Written for Hornhoof | affaan-m/ECC skills/crosspost/SKILL.md | Hornhoof |
| `skills/mkt-product-context.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/product-marketing/SKILL.md | Hornhoof |
| `skills/mkt-publish-approval.md` | Written for Hornhoof | affaan-m/ECC skills/operator-approval-loop/SKILL.md | Hornhoof |
| `skills/mkt-russian-copy.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/mkt-schema-markup.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/schema/SKILL.md | Hornhoof |
| `skills/mkt-seo-audit.md` | Written for Hornhoof | coreyhaines31/marketingskills; anthropics/knowledge-work-plugins | Hornhoof |
| `skills/mkt-social-posts.md` | Written for Hornhoof | coreyhaines31/marketingskills | Hornhoof |
| `skills/mkt-telegram-vk.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/mkt-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/mkt-yandex-seo.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-account-register.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-account-signup.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-api-connector.md` | Written for Hornhoof | affaan-m/ECC skills/api-connector-builder/SKILL.md; anthropics/skills skills/mcp-builder/SKILL.md; affaan-m/ECC skills/canary-watch/SKILL.md | Hornhoof |
| `skills/ops-capacity-plan.md` | Written for Hornhoof | anthropics/knowledge-work-plugins operations/skills/capacity-plan/SKILL.md | Hornhoof |
| `skills/ops-change-request.md` | Written for Hornhoof | anthropics/knowledge-work-plugins operations/skills/change-request/SKILL.md | Hornhoof |
| `skills/ops-connector-catalog.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support/CONNECTORS.md | Hornhoof |
| `skills/ops-credential-vault.md` | Written for Hornhoof | msitarzewski/agency-agents security/security-secrets-credential-engineer.md; wshobson/agents plugins/cicd-automation/skills/secrets-management/SKILL.md | Hornhoof |
| `skills/ops-failure-review.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-incident-response.md` | Written for Hornhoof | anthropics/knowledge-work-plugins engineering/skills/incident-response/SKILL.md; wshobson/agents plugins/incident-response/skills/incident-runbook-templates/SKILL.md; obra/superpowers skills/systematic-debugging/SKILL.md | Hornhoof |
| `skills/ops-intake.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-mcp-config-review.md` | Written for Hornhoof | affaan-m/ECC skills/mcp-dependency-review/SKILL.md | Hornhoof |
| `skills/ops-node-health.md` | Written for Hornhoof | affaan-m/ECC skills/docker-patterns/SKILL.md | Hornhoof |
| `skills/ops-postmortem.md` | Written for Hornhoof | wshobson/agents plugins/incident-response/skills/postmortem-writing/SKILL.md | Hornhoof |
| `skills/ops-program-operator.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-runbook.md` | Written for Hornhoof | anthropics/knowledge-work-plugins operations/skills/runbook/SKILL.md | Hornhoof |
| `skills/ops-task-watch.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-tool-install.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/ops-vendor-review.md` | Written for Hornhoof | anthropics/knowledge-work-plugins operations/skills/vendor-review/SKILL.md; anthropics/knowledge-work-plugins legal/skills/vendor-check/SKILL.md | Hornhoof |
| `skills/ops-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/orch-company.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/orch-interview.md` | Written for Hornhoof | obra/superpowers skills/brainstorming/SKILL.md | Hornhoof |
| `skills/orch-outside-is-data.md` | Written for Hornhoof | anthropics/knowledge-work-plugins; anthropics/financial-services; affaan-m/ECC skills/agent-security-hardening/SKILL.md | Hornhoof |
| `skills/orch-people.md` | Written for Hornhoof | No outside source: standalone company administration procedure | Hornhoof |
| `skills/orch-plan-turn.md` | Written for Hornhoof | obra/superpowers skills/writing-plans/SKILL.md | Hornhoof |
| `skills/orch-resources.md` | Written for Hornhoof | No outside source: standalone company administration procedure | Hornhoof |
| `skills/orch-staff.md` | Written for Hornhoof | No outside source: standalone company administration procedure | Hornhoof |
| `skills/orch-trouble.md` | Written for Hornhoof | obra/superpowers skills/systematic-debugging/SKILL.md | Hornhoof |
| `skills/sal-account-research.md` | Written for Hornhoof | anthropics/knowledge-work-plugins | Hornhoof |
| `skills/sal-call-prep.md` | Written for Hornhoof | anthropics/knowledge-work-plugins; msitarzewski/agency-agents sales/sales-discovery-coach.md | Hornhoof |
| `skills/sal-call-summary.md` | Written for Hornhoof | anthropics/knowledge-work-plugins | Hornhoof |
| `skills/sal-cold-outreach.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/cold-email/SKILL.md; anthropics/knowledge-work-plugins sales/skills/draft-outreach/SKILL.md; msitarzewski/agency-agents sales/sales-outbound-strategist.md | Hornhoof |
| `skills/sal-crm-hygiene.md` | Written for Hornhoof | anthropics/knowledge-work-plugins sales/skills/crm-hygiene-check/SKILL.md | Hornhoof |
| `skills/sal-deal-plan.md` | Written for Hornhoof | anthropics/knowledge-work-plugins; msitarzewski/agency-agents sales/sales-deal-strategist.md | Hornhoof |
| `skills/sal-forecast.md` | Written for Hornhoof | anthropics/knowledge-work-plugins | Hornhoof |
| `skills/sal-lead-signals.md` | Written for Hornhoof | affaan-m/ECC skills/lead-intelligence/SKILL.md | Hornhoof |
| `skills/sal-outbound-approval.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sal-pipeline-analytics.md` | Written for Hornhoof | msitarzewski/agency-agents sales/sales-pipeline-analyst.md | Hornhoof |
| `skills/sal-pipeline-review.md` | Written for Hornhoof | anthropics/knowledge-work-plugins sales/skills/deal-review/SKILL.md; msitarzewski/agency-agents sales/sales-deal-strategist.md | Hornhoof |
| `skills/sal-proposal.md` | Written for Hornhoof | msitarzewski/agency-agents sales/sales-proposal-strategist.md; alirezarezvani/claude-skills business-growth/skills/contract-and-proposal-writer/SKILL.md | Hornhoof |
| `skills/sal-prospecting.md` | Written for Hornhoof | coreyhaines31/marketingskills skills/prospecting/SKILL.md; anthropics/knowledge-work-plugins | Hornhoof |
| `skills/sal-win-loss.md` | Written for Hornhoof | anthropics/knowledge-work-plugins | Hornhoof |
| `skills/sal-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sup-bilingual.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sup-billing-issues.md` | Written for Hornhoof | affaan-m/ECC skills/customer-billing-ops/SKILL.md | Hornhoof |
| `skills/sup-bug-report.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sup-customer-research.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support | Hornhoof |
| `skills/sup-deflection.md` | Written for Hornhoof | anthropics/knowledge-work-plugins small-business/skills/ticket-deflector/SKILL.md | Hornhoof |
| `skills/sup-docs-from-tickets.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sup-draft-response.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support; msitarzewski/agency-agents support/support-support-responder.md | Hornhoof |
| `skills/sup-escalation.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support/skills/customer-escalation/SKILL.md | Hornhoof |
| `skills/sup-kb-article.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support/skills/kb-article/SKILL.md | Hornhoof |
| `skills/sup-reproduce-issue.md` | Written for Hornhoof | obra/superpowers skills/systematic-debugging/SKILL.md | Hornhoof |
| `skills/sup-support-policy.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/sup-support-report.md` | Written for Hornhoof | msitarzewski/agency-agents support/support-analytics-reporter.md; msitarzewski/agency-agents product/product-feedback-synthesizer.md | Hornhoof |
| `skills/sup-ticket-triage.md` | Written for Hornhoof | anthropics/knowledge-work-plugins customer-support | Hornhoof |
| `skills/sup-work-pipeline.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `roles/home_devices/HOM-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/home_devices/HOM-NET.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/home_devices/HOM-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/home_devices/HOM-SMART.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/household/HHD-HEAD.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/household/HHD-PM.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/household/HHD-SUPPLY.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/household/HHD-BILLS.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `roles/household/HHD-CAL.md` | Written for Hornhoof | paperclipai/paperclip doc/plans/2026-10-02-hiring-template-prompt-diff.md for the short shape; its skills name their own sources | Hornhoof |
| `skills/home-real-world-approval.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/home-network.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/home-smart-control.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/home-shopping.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/home-bills.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `skills/home-calendar.md` | Written for Hornhoof | No outside source: Hornhoof's own procedure | Hornhoof |
| `teams/development/DEV-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/design/DSN-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/marketing/MKT-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/sales/SAL-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/support/SUP-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/finance/FIN-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/business_development/BIZ-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/operations/OPS-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/home_devices/HOM-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `teams/household/HHD-TEAM.md` | Written for Hornhoof | Hornhoof's own turnkey mode: one member does a task whole, with no stage after it | Hornhoof |
| `echelons/development.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/operations.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/marketing.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/sales.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/business_development.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/design.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/support.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/finance.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/home_devices.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
| `echelons/household.md` | Written for Hornhoof | Hornhoof's own echelons: the stages a department's work goes through in a turn | Hornhoof |
