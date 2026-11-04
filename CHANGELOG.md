# Changelog

Newest releases come first. Each release starts with `## [X.N.P] - YYYY-MM-DD`,
one plain summary, and short entries under `### Added`, `### Changed` and
`### Fixed`. Include `### Before you update` only when people need to take action.
The middle number is the turn; the last counts releases between turns.

## [0.6.0] - 2026-11-04

Turn 6: one agent window you can open from anywhere, with the agent's current
task beside its terminal; side panels on the left; a work tree you can move and
zoom.

### Added

- Open the same agent window by clicking an agent on the map, in the work tree,
  in Subscriptions or in Machines, also for an agent that is asleep, and write to
  it from there.
- Open the task the agent is working on now with Task in the window header. On a
  wide screen it opens to the left of the terminal; on a narrow one it takes the
  terminal's place, and you can go back to the terminal.
- Close, minimize and maximize the agent window with the three buttons in its
  corner. A minimized window waits as a thin strip at the right edge and slides
  back out when you click it.
- Move and zoom the work tree with the same gestures and buttons as the map.

### Changed

- Every side panel other than the agent window, Speed included, now opens on the
  left, in the same place.
- Agents you cannot open are shown as plain names in Subscriptions and Machines
  instead of buttons that led to an empty window.
- Developers, code reviewers and security engineers now install a project's
  dependencies before they run its checks, so they no longer lose turns on tools
  that seem to be missing.
- The node image includes ShellCheck 0.11.0, so agents can check shell scripts.

### Fixed

- Task in the agent window opens the agent's actual current task, also for the
  orchestrator and for employees of a product.
- Pressing Escape to close a side panel, the account menu or a dialog no longer
  stops a busy agent.
- A minimized agent window no longer hides the live line of a department or
  keeps room for itself on the map.
- Ctrl+O right after new messages appear folds or unfolds the log instead of
  being lost.
- If the company could not be loaded, opening an agent from Subscriptions or
  Machines now shows the error instead of doing nothing.

## [0.5.1] - 2026-11-04

An urgent fix: a message that reached an agent during its turn no longer comes
to it a second time.

### Fixed

- Count a message as delivered when the agent reads it during a turn in Claude
  Code. Claude Code records words pasted over several lines in its own wrapper,
  the node did not recognize them, and Hornhoof gave the agent the same message
  again as a new turn.

## [0.5.0] - 2026-11-04

Turn 5: one work tree for the whole turn, closed tasks that stay quiet, clearer
plan and machine screens, and node restarts that say why they happened.

### Added

- See the whole turn in one work tree: every task, every review and the final
  check, what each agent's program is doing, and who waits for whom since when.
- Mark a task as waiting for an outside event, with a reason and a deadline, so
  it is not reported as stuck while it waits.
- Get a plan's connect command at once in two places: a block on top and the
  plan's row "Waiting for a machine", with the time it stays valid. "Done" hides
  only the block; the command works until it is used or 24 hours pass.
- Make a deputy CEO in "Edit" on the People screen: a deputy sees the whole
  company and takes the CEO's decisions. A short "Dep" badge marks the name.
- Put a person alone in a sub-unit of a department, with a direct line from the
  head (used for urgent fixes).
- Open "About" from the account menu: what Hornhoof is, its version, developer,
  license and links.
- See why a node restarted: which node, planned or not, and the end of its log.
- See the node build: machines whose nodes run another build than the server
  are marked "Other build", with the update command.
- Choose Antigravity models and use Antigravity's own terminal screen.

### Changed

- A plan that does not work shows one full-width block on its card: what is
  wrong and where, the action that fixes it (copy the update command, sign in or
  make a new command) and "Remove". Limits, agents and controls come back once
  it works.
- Signing in on a node that is too old names the machine and gives the update
  command with "Copy".
- Nodes update agent programs when they start and on the update button, never
  in the middle of a turn.
- A second connect command for the same place is refused while the first one
  is still valid.
- Retry and continue send the text that was asked for, without later additions
  from the queue.
- Versions follow turns: turn N is version 0.N.0, urgent fixes between turns
  are 0.N.1, 0.N.2.
- The node image includes the GitHub CLI (gh).

### Fixed

- A closed task no longer wakes anyone: no late comments, no "merge after
  gates" and no retries after an interrupted turn.
- When a task it waited for is cancelled, the waiting task's creator is told.
- A reviewer moved into a sub-unit leaves the reviews it was on.
- Text pasted into an agent's terminal can no longer end the paste early.
- An agent's answer after Stop goes to the right turn.
- A turn on the built-in node cut off by a server restart gets its real reason
  instead of "unknown".
- Reconnecting a plan no longer leaves an old record behind, and a node silent
  for a day is no longer shown as ready.
- After a plan reconnects, the old machine's connection is closed and can no
  longer act for the new node.
- Dots on the map lines no longer vanish with "reduce motion".
- Agents no longer receive the node machine's CLAUDE_CODE_AUTO_COMPACT_WINDOW.
- The server log no longer shows the FSTDEP023 warning.

### Before you update

- Database migrations 0045, 0047 and 0049 to 0052 run on start. They add
  indexes and columns. 0051 clears leftovers of earlier plan reconnects: an
  older plan still waiting for a machine, with no agents and no work, is
  removed with its nodes and saved sign-in when the same owner has a newer
  ready plan of that provider; nodes shown as ready without a key, or of a
  removed plan, are set to "needs sign-in". Removed rows do not come back if
  you return to 0.4.
- Every node restarts once on the new image.
- Update a node on a Mac with the command from the machine card, without
  `--join`.
- Install commands made before this version keep working until a new command
  is made for the same place or 24 hours pass.
