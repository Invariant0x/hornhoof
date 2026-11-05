Real screens of the programs, for what the node reads from a screen. Never write one of these by hand: run the program
and capture it. A screen somebody imagined let 0.7.0 pass its tests while Codex and Kimi Code got no words at all.

Captured on 2026-11-05 at 120x40 with `tmux capture-pane -p -e -J -S -0`, as the node reads a screen, from the npm packages
the node installs (`@openai/codex`, `@moonshot-ai/kimi-code`) started as the node starts them, in a home without any sign-in.
Paths and request ids are replaced; nothing else is changed. Codex held a placeholder API key, so it reaches its prompt and
retries against the refusal; Kimi Code had no sign-in, which still shows its prompt.

- `*-first`: the empty prompt right after the program started.
- `*-idle`, `*-after`: the empty prompt later on, under other footers.
- `*-draft`, `*-multi-line`: what a person typed and did not send.
- `*-busy`, `*-retrying`: the empty prompt while a turn runs.

Antigravity's screens are in `../agy-tui`.
