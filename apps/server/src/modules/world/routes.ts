/* HTTP routes for isometric world:
   - GET  /api/world/state       (strictly read-only company state projection)
   - GET  /api/world/theme       (active company theme and active world pack summary for any signed-in member)
   - PUT  /api/world/theme       (CEO-only company theme/world switcher; broadcasts live update to everyone)
   - PUT  /api/world/layout      (saves city layout in isolated world_layouts table only)
   - POST /api/world/relocations (God's Word relocation: creates a real small task after confirmation,
                                  building coordinates never move until the task is accepted) */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_COMPANY_THEME,
  WorldLayoutSaveSchema,
  WorldRelocationRequestSchema,
  WorldThemeUpdateSchema,
  type WorldRelocationRecord,
  type WorldRelocationStored,
  type WorldThemeView,
} from '@hornhoof/protocol/world';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { actorOf, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, worldLayouts } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { createTask } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { readWorldLiveState } from './live-data.js';
import { isAllowedCompanyTheme, worldPackForTheme } from './packs/index.js';

const MAX_STORED_RELOCATIONS = 200;

function themeViewOf(ctx: Ctx, theme: string, canEdit: boolean): WorldThemeView {
  const pack = worldPackForTheme(ctx.worldPacks, theme);
  return {
    theme,
    activePack: pack
      ? {
          id: pack.id,
          label: pack.label,
          skillIds: pack.skills.map(s => s.id),
        }
      : null,
    canEdit,
  };
}

export function worldRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* Strictly read-only live world snapshot of the signed-in person's company. */
  app.get('/api/world/state', async req => {
    const me = await requirePerson(req, db);
    return readWorldLiveState(ctx, me);
  });

  /* Returns the company's single active theme/world for any signed-in member. */
  app.get('/api/world/theme', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db
      .select({ theme: companies.theme })
      .from(companies)
      .where(eq(companies.id, me.companyId));
    return themeViewOf(ctx, company?.theme ?? DEFAULT_COMPANY_THEME, Boolean(me.isOwner && !me.viaHead));
  });

  /* Changes the single company-wide theme/world. Strictly restricted to the company CEO. */
  app.put('/api/world/theme', async req => {
    const me = await requirePerson(req, db);
    if (!me.isOwner || me.viaHead) {
      throw new ApiError(403, 'forbidden', 'Only the CEO can change the company theme.', 'not_owner_session');
    }
    const body = WorldThemeUpdateSchema.parse(req.body);
    if (!isAllowedCompanyTheme(ctx.worldPacks, body.theme)) {
      throw new ApiError(400, 'validation', `Unknown company theme "${body.theme}".`);
    }
    await db
      .update(companies)
      .set({ theme: body.theme })
      .where(eq(companies.id, me.companyId));
    ctx.bus.publish(me.companyId, { type: 'company_theme', theme: body.theme });
    ctx.bus.publish(me.companyId, { type: 'org' });
    return themeViewOf(ctx, body.theme, true);
  });

  /* Persists the generated/grown city layout into the isolated world_layouts table without touching work tables. */
  app.put('/api/world/layout', async req => {
    const me = await requirePerson(req, db);
    const body = WorldLayoutSaveSchema.parse(req.body);
    await db
      .insert(worldLayouts)
      .values({
        companyId: me.companyId,
        packId: body.packId,
        seed: body.seed,
        layout: body.layout,
        relocations: [],
        updatedAt: new Date(ctx.clock()),
      })
      .onConflictDoUpdate({
        target: worldLayouts.companyId,
        set: {
          packId: body.packId,
          seed: body.seed,
          layout: body.layout,
          updatedAt: new Date(ctx.clock()),
        },
      });
    return { ok: true, packId: body.packId, seed: body.seed };
  });

  /* Relocation by God's Word: verifies permission + explicit confirmation, creates a real small task
     for the right owner (department head, resident agent, or orchestrator), and stores a pending order.
     Building coordinates stay unchanged until the task reaches status === 'done'. */
  app.post('/api/world/relocations', async (req, reply) => {
    const me = await requirePerson(req, db);
    const body = WorldRelocationRequestSchema.parse(req.body);
    const access = await accessOf(db, me);
    const isWholeAuthority = actsAsCeo(me) || access.whole;

    let assigneeAgentId: string | null = null;
    let taskDepartmentId: string | null = null;

    if (body.buildingKind === 'department' || body.buildingKind === 'statue') {
      if (!body.departmentId) {
        throw new ApiError(400, 'validation', 'departmentId is required to relocate a department structure.');
      }
      const [dept] = await db
        .select({ id: departments.id, parentId: departments.parentId })
        .from(departments)
        .where(and(eq(departments.id, body.departmentId), eq(departments.companyId, me.companyId)));
      if (!dept) {
        throw new ApiError(404, 'not_found', 'Department not found.');
      }
      if (!isWholeAuthority && !canReach(access, { departmentId: dept.id, parentId: dept.parentId })) {
        throw new ApiError(403, 'forbidden', 'You do not have permission to relocate this department structure.');
      }
      taskDepartmentId = dept.parentId ?? dept.id;
      const [head] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, me.companyId),
            eq(agents.departmentId, taskDepartmentId),
            eq(agents.kind, 'head'),
            isNull(agents.removedAt),
            isNull(agents.switchedOffAt),
          ),
        );
      if (head) {
        assigneeAgentId = head.id;
      } else {
        const orch = await orchestratorOf(ctx, me.companyId);
        if (!orch) throw new ApiError(409, 'conflict', 'No active assignee is available for relocation.');
        assigneeAgentId = orch.id;
        taskDepartmentId = null;
      }
    } else if (body.buildingKind === 'house') {
      if (!body.agentId) {
        throw new ApiError(400, 'validation', 'agentId is required to relocate an agent house.');
      }
      const [resident] = await db
        .select({
          id: agents.id,
          kind: agents.kind,
          departmentId: agents.departmentId,
          productId: agents.productId,
          teamId: agents.teamId,
          removedAt: agents.removedAt,
          switchedOffAt: agents.switchedOffAt,
        })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.companyId, me.companyId)));
      if (!resident || resident.removedAt || resident.kind === 'assistant') {
        throw new ApiError(404, 'not_found', 'Agent not found.');
      }
      if (resident.switchedOffAt) {
        throw new ApiError(409, 'conflict', 'Agent is switched off and cannot accept a relocation order.');
      }
      const spot = await agentSpot(db, resident);
      if (!isWholeAuthority && !canReach(access, spot)) {
        throw new ApiError(403, 'forbidden', 'You do not have permission to relocate this agent house.');
      }
      assigneeAgentId = resident.id;
      taskDepartmentId = resident.departmentId;
    } else {
      if (!isWholeAuthority) {
        throw new ApiError(403, 'forbidden', 'Only the CEO or whole-company owner may relocate common buildings.');
      }
      const orch = await orchestratorOf(ctx, me.companyId);
      if (!orch) {
        throw new ApiError(409, 'conflict', 'No active orchestrator is available for relocation.');
      }
      assigneeAgentId = orch.id;
      taskDepartmentId = null;
    }

    const title = `Перестроить ${body.buildingLabel}`.slice(0, 120);
    const brief = `Принять приказ на перестройку "${body.buildingLabel}" с (${body.fromCol}, ${body.fromRow}) на (${body.toCol}, ${body.toRow}) и отчитаться.`.slice(0, 600);
    const taskBody = [
      `God's Word relocation order / Приказ на перестройку здания.`,
      `Building: ${body.buildingLabel} (${body.buildingId}, kind=${body.buildingKind})`,
      `Current tile: (${body.fromCol}, ${body.fromRow})`,
      `Target tile: (${body.toCol}, ${body.toRow})`,
      `Small order: acknowledge the relocation and report done. Coordinates move only once this task is accepted.`,
    ].join('\n');

    const { task, wakes } = await createTask(ctx, actorOf(me), {
      resultKind: 'coordination',
      title,
      brief,
      body: taskBody,
      departmentId: taskDepartmentId,
      assigneeAgentId,
      executor: false,
      small: true,
    });
    await wakeAll(ctx, wakes);

    const createdAt = new Date(ctx.clock()).toISOString();
    const stored: WorldRelocationStored = {
      id: randomUUID(),
      buildingId: body.buildingId,
      buildingKind: body.buildingKind,
      buildingLabel: body.buildingLabel,
      fromCol: body.fromCol,
      fromRow: body.fromRow,
      toCol: body.toCol,
      toRow: body.toRow,
      taskId: task.id,
      taskNumber: task.number,
      assigneeAgentId,
      departmentId: taskDepartmentId,
      createdAt,
    };

    await db.transaction(async tx => {
      const [existing] = await tx
        .select({ relocations: worldLayouts.relocations })
        .from(worldLayouts)
        .where(eq(worldLayouts.companyId, me.companyId))
        .for('update');
      const nextRelocations = [...(existing?.relocations ?? []), stored].slice(-MAX_STORED_RELOCATIONS);
      await tx
        .insert(worldLayouts)
        .values({
          companyId: me.companyId,
          packId: 'default',
          seed: me.companyId,
          layout: null,
          relocations: nextRelocations,
          updatedAt: new Date(ctx.clock()),
        })
        .onConflictDoUpdate({
          target: worldLayouts.companyId,
          set: {
            relocations: nextRelocations,
            updatedAt: new Date(ctx.clock()),
          },
        });
    });

    const relocation: WorldRelocationRecord = {
      ...stored,
      taskStatus: task.status,
      status: 'pending',
      resolvedAt: null,
    };

    return reply.code(201).send({
      relocation,
      task: {
        id: task.id,
        number: task.number,
        title: task.title,
        status: task.status,
        small: task.small,
        assigneeAgentId: task.assigneeAgentId,
        departmentId: task.departmentId,
      },
    });
  });
}
