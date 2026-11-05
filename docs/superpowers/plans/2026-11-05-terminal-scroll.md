# Local Terminal Scrollback and Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep terminal history in xterm, scroll it locally without WebSocket input in every mode, and provide initial tmux history plus immediate output through an independently integrable node module.

**Architecture:** A web helper owns normal/alternate buffer scrolling and restores the live buffer before new output or reset. A separate node `view-stream.ts` supplies styled tmux history and immediate protocol-sized output; its owner in #407 connects it to `openView`. Independent performance measurements belong to #406.

**Tech Stack:** TypeScript, React, xterm 5.5, tmux, Node.js, Vitest, Playwright.

**Spec:** Hornhoof tasks #400, #394, #406, and #407, current bodies read with the task tool.

## Global Constraints

- Work only in `AgentTerminal.tsx`, new web/node scroll and stream helpers, and their focused tests. Do not edit `host.ts`; #407 owns its integration.
- Do not change `AgentWindow.tsx`, server `terminals/{routes,relay.ts}`, or `conversation/*`.
- Wheel scrolling emits zero WebSocket messages with `write` true and false, including alternate screen and application mouse modes.
- Do not send history over the socket on wheel events or clear the alternate buffer to read normal history.
- Keep split-secret masking and UTF-8 decoding intact. The 60 ms quiet guard belongs to #407's `openView` integration and may remain only for a possible partial secret.
- Baseline SHA for #406 is `05d27e284dbbe51f129b3df00c9c805db193d6a6`. Do not duplicate #406's independent measurements.
- Do not submit as complete until #407 confirms integration on a specific commit and focused tests pass there.
- No full root `npm test`, `run_tests`, or `mutator`. Code and comments are English, without em dashes or commit trailers.

## Review Focus

- Alternate screen with no normal history leaves the live program screen and keyboard input unchanged; cover in helper tests.
- New output or reconnect while a person reads old history restores the live buffer before parsing; cover in component and Playwright tests.
- Resizing while scrolled retains the reading anchor; cover existing fit tests plus an alternate-screen Playwright resize.
- Initial history includes styled lines above the viewport for ordinary and alternate-screen sessions; cover with real tmux.
- Split secrets and multi-byte output remain masked and decoded once; run existing mask, redaction, and terminal host tests after streaming changes.

---

### Task 1: Failing Browser Scroll Scenarios

**Files:**
- Create: `apps/web/e2e/terminal-scroll.spec.ts`

**Interfaces:**
- Consumes: existing `serveAgentWindow` and its WebSocket fixture.
- Produces: RED evidence for ordinary, read-only, alternate-screen, and live-restore behavior.

- [ ] **Step 1: Write the failing browser scenarios**

Use unique history lines. Cover `write` true and false, normal history, `\x1b[?1049h` with SGR mouse tracking, return to the live bottom, new output while scrolled, and resize while reading history. Count every outbound socket message.

- [ ] **Step 2: Run on unmodified code**

Run `HORNHOOF_BROWSER_PORT=4182 npm run test:browser -w apps/web -- e2e/terminal-scroll.spec.ts`. Expected RED: SGR or arrow-key wheel input, no read-only movement, and no alternate history.

- [ ] **Step 3: Attach RED evidence**

Save Playwright output and a baseline screenshot outside the branch. Do not run #406's independent performance matrix.

### Task 2: Local Normal and Alternate-Screen Scrolling

**Files:**
- Create: `apps/web/src/ui/terminal-scroll.ts`
- Create: `apps/web/test/terminal-scroll.test.ts`
- Modify: `apps/web/src/ui/AgentTerminal.tsx`
- Modify: `apps/web/test/AgentTerminal.test.tsx`
- Modify: `apps/web/e2e/terminal-scroll.spec.ts`

**Interfaces:**
- `scrollTerminal(term: Terminal, amount: number): void`: scroll normal history, including while alternate is active.
- `restoreLiveTerminal(term: Terminal): void`: remove only the temporary `buffers.active` getter override and refresh the live buffer when it exists.
- `attachTerminalScroll(term: Terminal): void`: use xterm's custom wheel handler and line-scaled wheel amount, always returning `false` to suppress SGR and arrow-key input.

- [ ] **Step 1: Write failing helper and component tests**

Cover normal scrolling, alternate with and without normal history, repeated wheels, reaching the live bottom, restoring before output and reset, both write modes, and no wheel-generated input. Update the existing mouse-selection assertion from wheel bit 16 to no protocol bits.

- [ ] **Step 2: Verify RED**

Run `npx --no-install vitest run test/terminal-scroll.test.ts test/AgentTerminal.test.tsx` in `apps/web`, then the Playwright scenarios. Expected missing helper and current outbound wheel input.

- [ ] **Step 3: Implement and integrate**

Temporarily override only `buffers.active` with a configurable getter for `buffers.normal`, as validated against xterm 5.5. Scroll and refresh normal history; delete the override before live output and at the bottom. Never call `activateNormalBuffer`, which clears alternate. Set mouse protocol masks to zero and attach the custom wheel handler.

- [ ] **Step 4: Verify GREEN**

Run the same Vitest files and all of `e2e/terminal-scroll.spec.ts`. Expect zero socket messages from every wheel case, visible history, and intact live updates.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/terminal-scroll.ts apps/web/src/ui/AgentTerminal.tsx apps/web/test/terminal-scroll.test.ts apps/web/test/AgentTerminal.test.tsx apps/web/e2e/terminal-scroll.spec.ts docs/superpowers/plans/2026-11-05-terminal-scroll.md
git commit -m "Scroll terminal history locally in every mode"
```

### Task 3: Independent Initial-History and Output Module

**Files:**
- Create: `apps/node/src/terminal/view-stream.ts`
- Create: `apps/node/test/view-stream.test.ts`
- Create: `apps/node/test/terminal-view-history.test.ts`
- Modify: `apps/node/src/terminal/tmux.ts` only if a capture defect requires it

**Interfaces:**
- `readViewHistory(tmux: Pick<Tmux, 'screen'>, name: string): Promise<string>`: return `tmux.screen(name, 5000, true)`.
- `sendTerminalOutput(send: (data: string) => void, text: string): void`: synchronously send consecutive slices of at most `2 * TERM_CHUNK` characters.
- #407 owns the minimal `openView` calls that mask initial history and forward later output through these APIs.

- [ ] **Step 1: Write failing module and real-tmux tests**

Assert immediate chunking, empty input, styled history above the viewport for ordinary output and `\x1b[?1049h`, and no wheel-driven history reads. Test `readViewHistory` independently of `host.ts`.

- [ ] **Step 2: Verify RED**

Run `npx --no-install vitest run test/view-stream.test.ts test/terminal-view-history.test.ts` in `apps/node`. Expected missing module.

- [ ] **Step 3: Implement only the independent module**

Use the existing styled `screen` capture, without `-a`, and immediate chunk forwarding. Do not edit `host.ts`. Keep secret masking at its existing integration boundary.

- [ ] **Step 4: Verify GREEN and hand off**

Run the same tests plus `terminal-mouse`, `terminal-tmux`, mask, and redaction suites. Send #407 the exact module commit and proposed minimal calls, then confirm its integration commit.

- [ ] **Step 5: Commit**

```bash
git add apps/node/src/terminal/view-stream.ts apps/node/test/view-stream.test.ts apps/node/test/terminal-view-history.test.ts
git commit -m "Provide terminal history and immediate view output"
```

### Task 4: Integration Proof and Focused Verification

**Files:**
- Modify only tests found necessary by integration
- Create outside the branch: screenshots and verification evidence

**Interfaces:**
- Consumes: #407's specific integration commit and #406's independent measurement process.
- Produces: final web/node SHAs, integration test evidence, screenshots, and a clean `task-400` branch for `turn-8`.

- [ ] **Step 1: Verify the actual integration**

Run focused web/node tests against #407's named commit, including `openView` initial history and new output. If integration is absent, report the unfinished requirement and use `wait_for`; do not claim readiness from an unconnected module.

- [ ] **Step 2: Check manual web mutants and screenshots**

Individually mutate wheel suppression, alternate getter override, live restoration, and missing-history handling. Require focused tests to fail for each, restore, and rerun GREEN. Capture ordinary, read-only, and alternate history screenshots and attach them with `hh-attach --task 400`.

- [ ] **Step 3: Run required checks**

Run focused web/node Vitest with coverage, terminal Playwright files, `tsc` for both apps, `npm run typecheck:tests`, ESLint on changed files, `crapper --use-existing-coverage`, `dryer`, and `git diff --check`.

- [ ] **Step 4: Share final SHA and submit**

Send #406 the final commit for its independent after matrix. Push `task-400` and submit with exact commands, integration SHA, and any unverified limitation plainly stated.
