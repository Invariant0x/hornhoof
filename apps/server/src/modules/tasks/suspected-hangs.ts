import type { Ctx } from '../../app.js';

/* A running turn with no sign of work for this long, while a task is on its agent, is a suspected hang. */
export const HANG_AFTER_MS = 10 * 60_000;

export type HangSignKind = 'event' | 'program_sign' | 'state_change' | 'check_end' | 'restart' | 'server_start' | 'turn_start';
export type SuspectedHang = {
  agentId: string;
  agent: string;
  turnId: string;
  task: { id: string; number: number; title: string };
  silentMs: number;
  silentMinutes: number;
  lastSign: { at: string; kind: HangSignKind };
  program: { state: string; tool: string | null } | null;
  /* What decides whether a reader may open the task, for whoever shows the entry. */
  sight: { status: string; departmentId: string | null; assigneeAgentId: string | null; executorAgentId: string | null };
};

export async function suspectedHangs(_ctx: Ctx, _companyId: string, _now: Date): Promise<SuspectedHang[]> {
  return [];
}
