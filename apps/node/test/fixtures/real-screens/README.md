Real screens of the programs, for what the node reads from a screen. Never write one of these by hand: run the program
and capture it. A screen somebody imagined let 0.7.0 pass its tests while Codex and Kimi Code got no words at all.

Captured on 2026-11-05 at 120x40 with `tmux capture-pane -p -e -J -S -0`, as the node reads a screen, from the npm packages
the node installs (`@openai/codex`, `@moonshot-ai/kimi-code`) started as the node starts them, in a home without any sign-in.
Paths and request ids are replaced; nothing else is changed. Codex held a placeholder API key, so it reaches its prompt and
retries against the refusal; Kimi Code had no sign-in, which still shows its prompt.

- `*-first`: the empty prompt right after the program started.
- `*-idle`, `*-after`: the empty prompt later on, under other footers.
- `*-draft`, `*-multi-line`, `*-empty-rows-draft`, `*-paragraphs-draft`: what a person typed and did not send.
- `*-busy`, `*-retrying`: the empty prompt while a turn runs.
- `*-long-session`: the empty prompt after a turn of a resumed session, at 160x48 on a model stub, with the banner long off
  the top of the screen.
- `*-rate-limits-question`: what Codex shows after a turn once its plan is 90% used, here at 160x48 on a model stub that says 95%.

Claude Code's screens were captured on 2026-11-09 at 160x48 the same way, from Claude Code 2.1.319 started with
`--dangerously-skip-permissions` in a folder of its own, signed in to a plan. The folder's path is replaced.

- `claude-2.1.319-interrupted`: the empty prompt after Escape stopped a running shell command.
- `claude-2.1.319-interrupted-resumed`: the same session after the program was killed and started again with `--resume`,
  the interruption still on its screen.
- `claude-2.1.319-interrupted-resumed-draft`: there, words typed key by key and not sent.
- `claude-2.1.319-interrupted-resumed-pasted`: there, words pasted as the node pastes them and not sent.

Antigravity's screens are in `../agy-tui`.
