import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { companies, jobs, type CompanyPause } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';

type Reader = Pick<Db, 'select'>;

/* The company's active pause record, or null while the company runs. */
export async function companyPause(db: Reader, companyId: string): Promise<CompanyPause | null> {
  const [row] = await db.select(only(companies, 'paused')).from(companies).where(eq(companies.id, companyId));
  return row?.paused ?? null;
}

export async function isCompanyPaused(db: Reader, companyId: string): Promise<boolean> {
  return (await companyPause(db, companyId)) !== null;
}

/* Every company currently paused, for minute-round sweeps that iterate across companies. */
export async function pausedCompanyIds(db: Reader): Promise<Set<string>> {
  const rows = await db.select(idOnly(companies)).from(companies).where(isNotNull(companies.paused));
  return new Set(rows.map(r => r.id));
}

/* Agents allowed to consider starting a turn while the company is paused. */
export const mayStartWhilePaused = (agent: { kind: string; roleKey?: string | null }): boolean =>
  agent.kind === 'orchestrator' || agent.kind === 'assistant' || agent.roleKey === PROGRAM_OPERATOR_ROLE;

/* Whether a person's live or typed input may reach this agent while the company is paused. */
export const mayHearPersonWhilePaused = (agent: { kind: string }, personId: string | null | undefined): boolean =>
  Boolean(personId && (agent.kind === 'orchestrator' || agent.kind === 'assistant'));

/* A queued program-operator turn that belongs to an open case of a turn currently running: the one Operations exception
   allowed during a company pause so a finishing turn cannot hang on a program prompt or sign-in. */
export const openCaseForRunningTurn = sql`exists (
  select 1 from program_operator_cases poc
  join jobs subject on subject.id = poc.job_id
  where poc.operator_job_id = ${jobs.id}
    and poc.status = 'open'
    and subject.status = 'running'
)`;
