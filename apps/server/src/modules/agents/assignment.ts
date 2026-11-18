import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { employeeChangedBy } from '../../auth/session.js';
import { agentChanges, agents, departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { headStandingPrincipal } from '../conversation/decision-context.js';
import { onAgent } from '../conversation/line.js';
import { appendEvent } from '../events/store.js';
import type { ToolJob } from '../tools/job.js';

const Assignment = z.strictObject({ employee: z.uuid(), assignment: z.string().nullable() });
const forbidden = () => new ApiError(403, 'forbidden', 'A head can set only the assignment of a current worker in its own department.', 'not_your_department');

/* This authority changes text alone. It never delegates the employee-card PATCH surface. */
export async function setAssignment(ctx: Ctx, job: ToolJob, body: z.infer<typeof Assignment>): Promise<void> {
  await onAgent(ctx, body.employee, async () => {
    await appendEvent(ctx, {
      companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'applied',
      data: { action: 'set_employee_assignment', employee: body.employee },
    }, async tx => {
      /* The audit FK already holds KEY SHARE. Serialize ACL changes without deadlocking parallel audit inserts. */
      const [head] = await tx.select().from(agents).where(and(eq(agents.id, job.agentId), eq(agents.companyId, job.companyId), isNull(agents.removedAt))).for('no key update');
      /* A head in its own department; the orchestrator in the one it names. */
      const own = head?.kind === 'head' ? head.departmentId : head?.kind === 'orchestrator' ? job.departmentId : null;
      if (!head || !own) throw forbidden();
      const [department] = await tx.select().from(departments).where(and(eq(departments.id, own), eq(departments.companyId, job.companyId), isNull(departments.parentId)));
      if (!department) throw forbidden();
      const [employee] = await tx.select().from(agents).where(and(eq(agents.id, body.employee), eq(agents.companyId, job.companyId), isNull(agents.removedAt))).for('update');
      if (!employee || employee.kind !== 'worker' || employee.departmentId !== own) throw forbidden();
      const overrides = { ...employee.overrides };
      if (body.assignment === null) delete overrides.base;
      else overrides.base = body.assignment;
      if (JSON.stringify(overrides) === JSON.stringify(employee.overrides)) return;
      await tx.update(agents).set({ overrides }).where(eq(agents.id, employee.id));
      const principal = head.kind === 'head' ? await headStandingPrincipal(tx, head) : null;
      const by = employeeChangedBy({ id: principal?.personId ?? null, via: head.id, ...(head.kind === 'head' ? { viaHead: true as const } : {}) });
      await tx.insert(agentChanges).values({ companyId: job.companyId, agentId: employee.id, ...by, field: 'prompt', before: employee.overrides, after: overrides });
    });
    ctx.bus.publish(job.companyId, { type: 'org' });
  });
}

export function registerAssignmentTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool('set_employee_assignment', {
    description: 'Sets why one worker in your own department exists and which work it owns. assignment is text, or null to clear it. Changes no skills, model, provider, timer or permissions.',
    inputSchema: Assignment,
  }, async body => {
    try {
      await setAssignment(ctx, job, body);
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
  });
}
