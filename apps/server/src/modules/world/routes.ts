/* HTTP routes for isometric world:
   - GET  /api/world/state          (strictly read-only company state projection)
   - GET  /api/world/theme          (active company theme and active world pack summary for any signed-in member)
   - PUT  /api/world/theme          (CEO-only company theme/world switcher; restores original names on leaving world)
   - GET  /api/world/rename-preview (CEO-only preview of era names for active non-assistant agents)
   - POST /api/world/rename-agents  (CEO-only confirmed bulk rename preserving original pre-world names)
   - POST /api/world/restore-names  (CEO-only confirmed restore of preserved pre-world names)
   - PUT  /api/world/layout         (saves city layout in isolated world_layouts table only)
   - POST /api/world/relocations    (God's Word relocation: creates a real small task after confirmation,
                                     building coordinates never move until the task is accepted) */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_COMPANY_THEME,
  WorldLayoutSaveSchema,
  WorldRelocationRequestSchema,
  WorldRenameExecuteSchema,
  WorldRenamePreviewQuerySchema,
  WorldRestoreNamesSchema,
  WorldThemeUpdateSchema,
  planWorldAgentRenames,
  type WorldAgentRenameCandidate,
  type WorldRelocationRecord,
  type WorldRelocationStored,
  type WorldRenamePreview,
  type WorldRenameResult,
  type WorldRestoreNamesResult,
  type WorldThemeView,
} from '@hornhoof/protocol/world';
import { and, asc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { actorOf, employeeChangedBy, requirePerson, type Person } from '../../auth/session.js';
import { agentChanges, agents, companies, departments, worldLayouts } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { createTask } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { readWorldLiveState } from './live-data.js';
import { isAllowedCompanyTheme, worldPackForTheme } from './packs/index.js';

const MAX_STORED_RELOCATIONS = 200;

function requireWorldCeo(me: Person): void {
  if (!me.isOwner || me.viaHead) {
    throw new ApiError(403, 'forbidden', 'Only the CEO can change the company theme or rename agents for a world.', 'not_owner_session');
  }
}

function themeViewOf(
  ctx: Ctx,
  theme: string,
  canEdit: boolean,
  extra?: { renamedAgentsCount?: number; restoredNamesCount?: number },
): WorldThemeView {
  const pack = worldPackForTheme(ctx.worldPacks, theme);
  const voiceSamples = pack?.skills.find(s => s.voice)?.voice?.samples;
  return {
    theme,
    activePack: pack
      ? {
          id: pack.id,
          label: pack.label,
          skillIds: pack.skills.map(s => s.id),
          ...(voiceSamples ? { voiceSamples } : {}),
        }
      : null,
    canEdit,
    ...(extra?.renamedAgentsCount !== undefined ? { renamedAgentsCount: extra.renamedAgentsCount } : {}),
    ...(extra?.restoredNamesCount !== undefined ? { restoredNamesCount: extra.restoredNamesCount } : {}),
  };
}

const KIND_RANK: Record<'orchestrator' | 'head' | 'worker', number> = {
  orchestrator: 0,
  head: 1,
  worker: 2,
};

async function loadRenameCandidates(db: Ctx['db'], companyId: string): Promise<WorldAgentRenameCandidate[]> {
  const rows = await db
    .select({
      id: agents.id,
      kind: agents.kind,
      name: agents.name,
      originalName: agents.originalName,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant')))
    .orderBy(asc(agents.createdAt), asc(agents.id));

  return rows
    .filter((r): r is { id: string; kind: 'orchestrator' | 'head' | 'worker'; name: string; originalName: string | null } => r.kind !== 'assistant')
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

async function restoreCompanyAgentNames(db: Ctx['db'], me: Person): Promise<WorldRestoreNamesResult> {
  const by = employeeChangedBy(me);
  const items: { agentId: string; previousName: string; restoredName: string }[] = [];
  await db.transaction(async tx => {
    const renamed = await tx
      .select({ id: agents.id, name: agents.name, originalName: agents.originalName })
      .from(agents)
      .where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant'), isNotNull(agents.originalName)))
      .orderBy(asc(agents.createdAt), asc(agents.id));

    for (const row of renamed) {
      if (!row.originalName) continue;
      await tx
        .update(agents)
        .set({ name: row.originalName, originalName: null })
        .where(eq(agents.id, row.id));
      await tx.insert(agentChanges).values({
        companyId: me.companyId,
        agentId: row.id,
        ...by,
        field: 'name',
        before: row.name,
        after: row.originalName,
      });
      items.push({ agentId: row.id, previousName: row.name, restoredName: row.originalName });
    }
  });
  return { restoredCount: items.length, items };
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
    const renamed = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant'), isNotNull(agents.originalName)));
    return themeViewOf(ctx, company?.theme ?? DEFAULT_COMPANY_THEME, Boolean(me.isOwner && !me.viaHead), {
      renamedAgentsCount: renamed.length,
    });
  });

  /* Changes the single company-wide theme/world. Strictly restricted to the company CEO.
     When leaving a world for a standard non-world theme, restores all preserved pre-world agent names automatically. */
  app.put('/api/world/theme', async req => {
    const me = await requirePerson(req, db);
    requireWorldCeo(me);
    const body = WorldThemeUpdateSchema.parse(req.body);
    if (!isAllowedCompanyTheme(ctx.worldPacks, body.theme)) {
      throw new ApiError(400, 'validation', `Unknown company theme "${body.theme}".`);
    }
    await db
      .update(companies)
      .set({ theme: body.theme })
      .where(eq(companies.id, me.companyId));

    let restoredNamesCount = 0;
    const nextPack = worldPackForTheme(ctx.worldPacks, body.theme);
    if (!nextPack) {
      const restored = await restoreCompanyAgentNames(db, me);
      restoredNamesCount = restored.restoredCount;
    }

    const remainingRenamed = nextPack
      ? (
          await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant'), isNotNull(agents.originalName)))
        ).length
      : 0;

    ctx.bus.publish(me.companyId, { type: 'company_theme', theme: body.theme });
    ctx.bus.publish(me.companyId, { type: 'org' });
    return themeViewOf(ctx, body.theme, true, {
      renamedAgentsCount: remainingRenamed,
      ...(restoredNamesCount > 0 ? { restoredNamesCount } : {}),
    });
  });

  /* Preview of era names for all active non-assistant agents before CEO confirmation. */
  app.get('/api/world/rename-preview', async req => {
    const me = await requirePerson(req, db);
    requireWorldCeo(me);
    const { lang } = WorldRenamePreviewQuerySchema.parse(req.query);
    const [company] = await db.select({ theme: companies.theme }).from(companies).where(eq(companies.id, me.companyId));
    const pack = worldPackForTheme(ctx.worldPacks, company?.theme);
    if (!pack) {
      throw new ApiError(409, 'conflict', 'No active world pack is selected for this company.');
    }
    const candidates = await loadRenameCandidates(db, me.companyId);
    const items = planWorldAgentRenames(pack, lang, candidates);
    const preview: WorldRenamePreview = {
      packId: pack.id,
      packLabel: pack.label,
      lang,
      items,
      alreadyRenamedCount: candidates.filter(c => c.originalName !== null).length,
    };
    return preview;
  });

  /* Executes a confirmed one-action bulk rename of active non-assistant agents into the active world's era names,
     preserving each agent's first pre-world originalName so returning off the world restores it cleanly. */
  app.post('/api/world/rename-agents', async req => {
    const me = await requirePerson(req, db);
    requireWorldCeo(me);
    const body = WorldRenameExecuteSchema.parse(req.body);
    const [company] = await db.select({ theme: companies.theme }).from(companies).where(eq(companies.id, me.companyId));
    const pack = worldPackForTheme(ctx.worldPacks, company?.theme);
    if (!pack) {
      throw new ApiError(409, 'conflict', 'No active world pack is selected for this company.');
    }

    const by = employeeChangedBy(me);
    const items = await db.transaction(async tx => {
      const candidates = await loadRenameCandidates(tx, me.companyId);
      const planned = planWorldAgentRenames(pack, body.lang, candidates);
      for (const item of planned) {
        await tx
          .update(agents)
          .set({
            name: item.proposedName,
            originalName: item.preservedOriginalName,
          })
          .where(eq(agents.id, item.agentId));
        if (item.currentName !== item.proposedName) {
          await tx.insert(agentChanges).values({
            companyId: me.companyId,
            agentId: item.agentId,
            ...by,
            field: 'name',
            before: item.currentName,
            after: item.proposedName,
          });
        }
      }
      return planned;
    });

    ctx.bus.publish(me.companyId, { type: 'org' });
    const result: WorldRenameResult = {
      packId: pack.id,
      lang: body.lang,
      renamedCount: items.length,
      items,
    };
    return result;
  });

  /* Restores every renamed agent's preserved pre-world name on CEO confirmation. */
  app.post('/api/world/restore-names', async req => {
    const me = await requirePerson(req, db);
    requireWorldCeo(me);
    WorldRestoreNamesSchema.parse(req.body);
    const result = await restoreCompanyAgentNames(db, me);
    if (result.restoredCount > 0) {
      ctx.bus.publish(me.companyId, { type: 'org' });
    }
    return result;
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

    const title = `Move ${body.buildingLabel}`.slice(0, 120);
    const brief = `Accept the order to move "${body.buildingLabel}" from (${body.fromCol}, ${body.fromRow}) to (${body.toCol}, ${body.toRow}) and report.`.slice(0, 600);
    const taskBody = [
      `God's Word relocation order.`,
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
