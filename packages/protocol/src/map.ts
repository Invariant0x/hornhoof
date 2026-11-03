/* The lines of the company map between a head and its people, and between the orchestrator and each department's head.
   A line is blue while the one below works on an assignment, yellow for five minutes after it gave back a result, and
   quiet otherwise. Each start of new work begins a new cycle of the line, so a result given back in an earlier cycle never
   lights it again, even when the new work ends without one. It lives apart from the message schemas, so the web takes it
   without the schema library. */

export const RETURN_MS = 300_000;
/* A gate sent work back to its executor; distinct from a result handed to the head. */
export const REWORK_MS = 600_000;

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
