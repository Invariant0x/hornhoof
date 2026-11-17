import type { ProgramInfo } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { machineNodes } from '../testruns/load.js';
import { nodeIdentity, ownBuiltin, type NodeHub, type NodeIdentity } from './hub.js';
import { builtinMachine } from './nodes.js';

type Person = Awaited<ReturnType<typeof requirePerson>>;
type OwnMachine = (person: Person, id: string) => Promise<{ id: string }>;
const Target = z.object({ id: z.union([z.literal('builtin'), z.uuid()]) });

/* own: the built-in node of the machine this app runs on, which is builtin's. */
export function machineProgramNodes(ids: string[], machineId: string, builtin: { id: string } | null, own: NodeIdentity): NodeIdentity[] {
  return [...ids.map(nodeIdentity), ...(builtin?.id === machineId ? [own] : [])];
}

function combined(before: ProgramInfo | undefined, after: ProgramInfo): ProgramInfo {
  return { ...after, updating: Boolean(before?.updating || after.updating), failed: Boolean(before?.failed || after.failed) };
}

/* Prefixes on one physical host may have the same program, or different installed versions of it. */
export function programsFor(hub: NodeHub, ids: NodeIdentity[]): ProgramInfo[] | null {
  const snapshots = ids.map(id => hub.programsOf(id)).filter(snapshot => snapshot !== null);
  if (!snapshots.length) return null;
  const programs = new Map<string, ProgramInfo>();
  for (const snapshot of snapshots) {
    for (const program of snapshot) {
      const key = JSON.stringify([program.id, program.version]);
      programs.set(key, combined(programs.get(key), program));
    }
  }
  return [...programs.values()].sort((a, b) => a.id.localeCompare(b.id) || String(a.version).localeCompare(String(b.version)));
}

export function machineProgramState(hub: NodeHub, ids: string[], machineId: string, builtin: { id: string } | null, own: NodeIdentity) {
  const nodes = machineProgramNodes(ids, machineId, builtin, own);
  return {
    online: nodes.some(id => hub.isOnline(id)),
    programs: programsFor(hub, nodes),
    checkError: nodes.map(id => hub.checkErrorOf(id)).find((err): err is string => err !== null) || null,
    browserError: nodes.map(id => hub.browserErrorOf(id)).find((err): err is string => err !== null) || null,
  };
}

async function targets(ctx: Ctx, person: Person, id: string, ownMachine: OwnMachine): Promise<NodeIdentity[]> {
  if (id === 'builtin') {
    requireCompanyScope(person);
    return [ownBuiltin(ctx.config)];
  }
  await ownMachine(person, id);
  const nodes = await machineNodes(ctx.db, person.companyId);
  const host = await builtinMachine(ctx.db, ctx.config.hostId, person.companyId, ctx.config.machineId);
  return machineProgramNodes(nodes.filter(node => node.machineId === id).map(node => node.id), id, host, ownBuiltin(ctx.config));
}

export function machineProgramRoutes(app: FastifyInstance, ctx: Ctx, ownMachine: OwnMachine): void {
  app.post('/api/machines/:id/programs/update', async (req, reply) => {
    const person = await requirePerson(req, ctx.db);
    const { id } = Target.parse(req.params);
    const nodes = await targets(ctx, person, id, ownMachine);
    const accepted = nodes.map(node => ctx.hub.updatePrograms(node)).some(Boolean);
    if (!accepted) throw new ApiError(409, 'conflict', 'No connected node on this machine can update its programs.', 'programs_unavailable');
    return reply.code(202).send({ updating: true });
  });
}
