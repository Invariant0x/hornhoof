# Managed program updates implementation plan

> For agentic workers: use superpowers:executing-plans to implement this approved task in this session. Follow TDD for each increment.

**Goal:** Let the node update its agent programs at startup and on request, keep active turns running, and show versions on machine cards.

**Architecture:** A node owns one serialized updater for its configured npm programs. Existing per-program installation gates remain responsible for missing binaries. Program snapshots travel in hello/status and live in NodeHub. A machine action uses existing machine permissions and reaches its connected managed nodes, including the built-in node on that host. Terminal launch hashes include the installed version.

**Tech Stack:** TypeScript, Zod protocol, Node.js processes, Fastify, React, Vitest, Playwright.

**Spec:** Hornhoof task tool #140 and parent #116, current bodies captured in this plan's workspace before implementation.

## Global constraints

- Start from origin/turn-5, baseline 42b1d11597973064a343dfceafa475e0ab4c62da. Work on task-140 in its own worktree.
- Update Claude Code, Codex and Kimi using npm install -g --prefix <tools> <package>@latest as the owner of tools. Update configured programs, not unused providers.
- Update at startup and by the machine button only. Add no scheduled updater. Keep tools unwritable by agent users.
- Do not interrupt an active turn. A later turn resumes on the installed version; waits for an in-progress update before selecting its version.
- Machine owner or a company-scoped person can update, matching ownMachine. The virtual built-in card is visible to company-scoped people and uses that same scope.
- Keep versions in live NodeHub state. No migration is needed. Older nodes without program snapshots cannot receive update commands.
- English code/comments, English and Russian UI, no em dashes. Use existing card components and tokens.
- Targeted tests only, plus protocol build and tsc for changed packages. No Docker or release workflow. New functions CRAP < 10; existing CC must not increase relative to main. Dryer threshold .8; mutator on changed lines with coverage and survivor analysis.
- Commit as Ivan Korol <invariant0x@icloud.com>, no trailers. Submit, then merge the fresh turn-5 and verify before pushing. Main needs CEO approval and is outside this task's integration.

## Review focus

1. Concurrent update requests and new turns: one installation batch; new turns wait, existing processes receive no Escape or kill.
2. Failed npm installation: retain the usable installed version, report a failed update, allow retry and unrelated programs to work.
3. Authorization and routing: owner/company only; no commands to another machine, a disconnected node, or an older node without support.
4. Version identity: version change restarts between turns with the same session; unchanged version reuses the process.
5. Reconnect and partial state: fresh hello restores versions, disconnected/older nodes show unknown state, built-in and personal nodes on a shared host are aggregated without duplicate version rows.

## Task 1: Disable session self-updates

**Files:** providers/process.ts, providers/{claude,codex,kimi}.ts, terminal/programs.ts; node providers and terminal-programs tests.

**Interfaces:** reuse childEnv; share Codex's centrally-managed update configuration between headless and terminal launches.

- [ ] Add failing behavior tests: child processes see DISABLE_AUTOUPDATER=1 and KIMI_CODE_NO_AUTO_UPDATE=1 (also legacy KIMI_CLI_NO_AUTO_UPDATE=1); Codex receives -c check_for_update_on_startup=false, including resume. An inherited false value must not enable updates.
- [ ] Run providers.test.ts and terminal-programs.test.ts and observe the missing switches.
- [ ] Implement the smallest shared settings change. Keep other provider settings intact.
- [ ] Run both test files and commit the increment.

Sources: https://code.claude.com/docs/en/env-vars ; https://learn.chatgpt.com/docs/config-file/config-reference ; https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars .

## Task 2: Node-owned updater and launch version

**Files:** new apps/node/src/program-updates.ts and its tests; main.ts, providers/process.ts, terminal/host.ts; commands/main/terminal host tests; the shared ProgramInfo schema/type in packages/protocol/src/index.ts.

**Interfaces:** ProgramInfo = { id: 'claude'|'codex'|'kimi', version: string|null, updating: boolean, failed: boolean }. ProgramUpdates exposes snapshot(): ProgramInfo[], update(changed?: () => void): Promise<void>, ready(): Promise<void>, version(id: string): string|null. Entries supply install(): Promise<void> and readVersion(): string|null. TermJob gains optional version: string|null.

- [ ] Add failing tests using a fake npm executable and real tools files: an already-installed program is updated at startup with @latest; an explicit batch updates again; duplicate requests share a batch; calls do not recur on a timer or every job.
- [ ] Add failure/retry and pending-update tests: old version remains usable, changed callbacks expose updating/failed, new jobs wait for completion.
- [ ] Introduce and test the shared ProgramInfo schema/type, then rebuild protocol. Implement serialized batches, read versions from node-owned npm package metadata, and retain the existing missing-install retry path. Personal nodes manage their configured program, built-in nodes their two API-key programs. Keep Antigravity's existing installer unchanged. Connect and report progress during startup updates rather than hiding the machine for an npm timeout; new turns wait for the batch.
- [ ] Add a real tmux regression: start a slow turn on version 1, make version 2 available, let the old turn finish without Escape/kill, then resume the same session in a new process on the next turn. An unchanged version keeps the process.
- [ ] Include the version in launchHash, pass the post-update snapshot to each queued job, and verify the targeted node tests. Commit.

## Task 3: Protocol and live node state

**Files:** packages/protocol/src/index.ts and tests; node main.ts and tests; server nodes/{hub,messages}.ts and tests.

**Interfaces:** consume ProgramInfo from Task 2. Optional programs: ProgramInfo[] on hello/status (maximum 3 per node); ServerMessage { type: 'programs.update' }. NodeHub stores/reports the latest snapshot while connected.

- [ ] Add failing parser tests: old messages still parse; program snapshots and update commands round-trip; malformed/oversized states are rejected.
- [ ] Implement protocol, rebuild it with npm run build -w @hornhoof/protocol.
- [ ] Add a socket test: hello reports installed versions; programs.update produces updating then completed status; an active job is not cancelled. Include failed update and reconnect cases.
- [ ] Wire startup and explicit updates into runNode. Reuse the normal status transport, with generic failure state that contains no npm output or credentials. If a handler's CC grows, extract an already-tested message operation rather than increasing it.
- [ ] Store snapshots for both built-in and personal sockets; clear them with the connection. Verify targeted node/server/protocol tests and commit.

## Task 4: Machine update route and version response

**Files:** server nodes/routes.ts and a focused machine-programs module; new server program-updates tests.

**Interfaces:** POST /api/machines/:id/programs/update returns 202 after sending programs.update to capable connected nodes for that machine. The reserved builtin target is company-scoped. GET /api/machines returns nullable programs snapshots on physical and virtual built-in rows.

- [ ] Add failing HTTP/socket tests for owner/company success, stranger/unauthenticated denial, unknown machine, offline/older nodes, and correct multi-node routing. Delegated identities follow the existing requirePerson/ownMachine rules. Assert received protocol messages and machine responses.
- [ ] Implement using ownMachine's existing authorization. Mark live updates pending before sending so repeated UI polls cannot briefly re-enable the button. Merge identical program/version rows while retaining partial failures.
- [ ] Verify built-in routing on a registered server machine and a virtual server card. Keep other machine actions intact. Run program-updates, relevant nodes/machine-load tests and commit.

## Task 5: Machine card and final evidence

**Files:** new web ProgramVersions component, Machines.tsx, types.ts, en.ts, ru.ts, Machines/component tests, guide/machines-and-plans.md.

**Interfaces:** use the machine programs response and update route from Task 4; keep pending/request-error state in the card component and refresh through the existing loader.

- [ ] Add failing user-facing tests: installed names/versions, update click targets the selected machine, progress disables repeat submission, failed update permits retry, read-only person cannot update, offline/older nodes show an understandable state.
- [ ] Implement with existing Part/Facts/buttons and translated Update programs / Обновить программы strings. Show partial per-program failures without leaking process output. Cover the built-in card.
- [ ] Run UI tests and targeted cross-package checks, all changed-package tsc commands, crapper, dryer and mutator --lines with project coverage. Analyze every survivor, supplement unsupported mutations manually, and record all commands/results.
- [ ] Run the product through dev-browser-check, capture machine cards in EN/RU and light/dark at desktop/phone sizes, verify focus, no overflow and no console errors. Attach screenshots through hh-attach for #140.
- [ ] Update the user guide, obtain one fresh whole-branch review, fix blocking findings with RED/GREEN, commit and push task-140. Submit evidence, integrate fresh turn-5, verify changed parts and push the merge commit, submit again.
