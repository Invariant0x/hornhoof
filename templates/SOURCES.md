# Where these templates learned from

Every role and skill text in this folder is written for Hornhoof, with one exception: dev-engineering-rules is unclebob/ub-mode's SKILL.md word for word, as its README asks people to copy it, with a short note on how Hornhoof runs its tools. No other text is copied from the sources below; they taught us what a role does and which steps a procedure needs. Each skill names its sources in its `sources` field as `<repo> <path>`.

| Source | Licence | What we learned from it |
|---|---|---|
| obra/superpowers | MIT | The development process: brainstorming, plans, test-driven development, verification before completion, subagent-driven work and the head's protocol for briefs, reports and fix loops. |
| unclebob/ub-mode | none; its README asks to copy SKILL.md | The engineering rules for development roles, word for word: make it work, then make it right, then follow practice. |
| unclebob/crapper, unclebob/dryer, unclebob/mutator | 0BSD | Installed on every node: CRAP scores, structural duplicates and mutation testing for Clojure, Java, Go, TypeScript, Rust and Python. The review gate holds CRAP under 10 and duplicates under 0.8; the tests gate kills surviving mutants. |
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
