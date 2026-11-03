import type { FailureKind, ProgramState } from './index.js';

/* The lines of the company map between a head and its people, and between the orchestrator and each department's head.
   A line is blue while the one below works on an assignment, yellow for five minutes after it gave back a result, and
   quiet otherwise. Each start of new work begins a new cycle of the line, so a result given back in an earlier cycle never
   lights it again, even when the new work ends without one. It lives apart from the message schemas, so the web takes it
   without the schema library. */

export const RETURN_MS = 300_000;
/* A gate sent work back to its executor; distinct from a result handed to the head. */
export const REWORK_MS = 600_000;
/* The map says a thinking or retrying program gave no sign for this long. */
export const QUIET_SIGN_MS = 600_000;
/* A thinking or retrying program with no sign for this long is an alarm. */
export const QUIET_ALARM_MS = 1_800_000;
/* A running tool with no sign for this long is an alarm: tests and builds run long. */
export const TOOL_QUIET_ALARM_MS = 7_200_000;
/* How long a thinking or retrying program may give no sign before Operations may restart it: past the program's own way
   out. Claude Code ends a dead wait itself after its retries, about 66 minutes; Codex never does; Kimi Code logs every
   retry, so half an hour without one is past its own; Antigravity's run ends by itself. */
export const RESTART_AFTER_MS: Record<'claude' | 'codex' | 'kimi' | 'antigravity', number | null> = { claude: 4_500_000, codex: 1_800_000, kimi: 1_800_000, antigravity: null };
/* The map marks a program red when it reports idle this long while its turn still runs. */
export const LOST_END_MS = 60_000;

/* The program's own retry, with its next try in epoch milliseconds when known. */
export type ProgramRetry = { attempt: number; max: number | null; nextAt: number | null };

/* A running turn's program as /api/org and /api/agents/:id give it. All times are Unix epoch milliseconds. */
export type TurnProgram = {
  state: ProgramState;
  since: number;
  tool: string | null;
  screenAt: number;
  signAt: number | null;
  retry: ProgramRetry | null;
  reportedAt: number;
};

/* Hornhoof tries a turn that failed for a passing reason again in the same session: try attempt of max, at epoch ms. */
export type TurnRetry = { attempt: number; max: number; at: number; kind: FailureKind };

export type TurnAlarmReason = 'program_stalled' | 'node_silent';

/* The server's alarm about a running turn; since is the last change or report, in Unix epoch milliseconds. */
export type TurnAlarm = { reason: TurnAlarmReason; since: number };

export type LineState = 'blue' | 'yellow' | 'quiet';

/* What the server knows of one line, times in epoch milliseconds. */
export interface LineFacts {
  working: boolean;
  workEpoch: number;
  returnedEpoch: number | null;
  returnedAt: number | null;
}

/* One line as /api/org gives it, with the time of the return as an ISO timestamp. */
export interface WorkLine {
  upstreamAgentId: string;
  downstreamAgentId: string;
  working: boolean;
  workEpoch: number;
  returnedEpoch: number | null;
  returnedAt: string | null;
}

/* When the yellow of a line goes out, or null when the line is not yellow on these facts at any time. */
export function yellowUntil(facts: LineFacts): number | null {
  if (facts.working || facts.returnedAt === null || facts.returnedEpoch !== facts.workEpoch) return null;
  return facts.returnedAt + RETURN_MS;
}

export function lineState(facts: LineFacts, now: number): LineState {
  if (facts.working) return 'blue';
  const until = yellowUntil(facts);
  if (until === null) return 'quiet';
  return until - RETURN_MS <= now && now < until ? 'yellow' : 'quiet';
}
