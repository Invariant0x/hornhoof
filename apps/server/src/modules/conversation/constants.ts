
/* Workers compact their conversation at half a million tokens, which keeps their turns quick; heads and the orchestrator
   keep the whole window, since they hold the department's and the company's picture. Their window is named outright too:
   left to its own choice, Claude Code stops a session with a question whether to compact earlier, which nobody answers. */
export const WORKER_COMPACT_WINDOW = 500_000;
export const FULL_COMPACT_WINDOW = 1_000_000;

/* Any turn may run as long as its work takes. This only ends one that hangs, a program frozen or waiting for input
   nobody gives, so the agent's next turns are not stuck behind it; the agent goes on in the same session. */
export const TURN_TIMEOUT_MS = 2 * 3_600_000;

/* What a turn ends with when a person or Hornhoof stopped it on purpose; none of these is a failure. */
export const STOPPED_ON_PURPOSE = ['cancelled', 'removed', 'switched_off'];

/* What the turn that takes the inbox asks before it goes out, when its prompt is written from the inbox. */
export const INBOX_PROMPT = 'Hornhoof: your inbox.';
export const NOTHING_UNREAD = 'Nothing in the inbox was unread when this turn was due.';
/* What a turn that went out inside another one ended with: its own result is the other turn's. */
export const GONE_ALONG = 'Went out with the turn before it.';
