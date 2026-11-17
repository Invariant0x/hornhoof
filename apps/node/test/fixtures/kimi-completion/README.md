# Kimi completion samples

These samples are synthetic, derived from the public Kimi Code 2.5.1 renderer at commit 1b02030d8c2c6b00131b23ebb67a231614877827. They are not captures of the November 16 incidents. No production screen, PID or CLI version has been received on task 1123 yet.

`done.ansi` uses the recorded input-box layout in ../real-screens/kimi-2.5.1-first.ansi, with a fabricated finished answer and the footer shape from tui/components/chrome/footer.ts. The word BLOCKED is answer content and is not itself completion evidence.

`status-cases.json` records synthetic control sequences from packages/pi-tui/src/program-status.ts (formatProgramStatus), terminal.ts (formatProgramStatusOutput), and tui/controllers/program-status.ts (rootStatus). OSC 7501 carries root state=done and app=kimi-code; id denotes a child record. TMUX doubles ESC inside a DCS passthrough wrapper. Questions, permissions and authentication emit blocked. Unknown, truncated, malformed and missing root records must fail closed.

Source: https://github.com/MoonshotAI/kimi-code/tree/1b02030d8c2c6b00131b23ebb67a231614877827
