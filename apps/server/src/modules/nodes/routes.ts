import { readFile } from 'node:fs/promises';
import { and, count, eq, gt, inArray, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { machines, nodeCodes, people, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

const JoinBody = z.object({
  code: z.string().min(1).max(200),
  machineId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  hostname: z.string().trim().min(1).max(120),
  os: z.enum(['linux', 'darwin']),
  arch: z.enum(['arm64', 'x86_64']),
});

const IdParams = z.object({ id: z.uuid() });

const codeUsed = () => new ApiError(410, 'gone', 'This install command was already used or has expired. Get a new one in Hornhoof.', 'code_used');

export function nodeRoutes(app: FastifyInstance, { db, config }: Deps): void {
  /* The installer calls this with the code from the command. The code is the only credential, and it works once. */
  app.post('/api/nodes/join', async (req, reply) => {
    const body = JoinBody.parse(req.body);
    const codeHash = hashToken(body.code);
    const [code] = await db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, codeHash));
    if (!code) throw new ApiError(404, 'not_found', 'This install command is not valid. Copy it again from Hornhoof.', 'code_unknown');

    const joined = await db.transaction(async tx => {
      const used = await tx
        .update(nodeCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(nodeCodes.codeHash, codeHash), isNull(nodeCodes.usedAt), gt(nodeCodes.expiresAt, new Date())))
        .returning({ codeHash: nodeCodes.codeHash });
      if (used.length === 0) throw codeUsed();

      /* Only subscriptions still waiting for a machine; one that joined elsewhere keeps its machine. */
      const subs = await tx
        .select({ id: subscriptions.id, provider: subscriptions.provider })
        .from(subscriptions)
        .where(
          and(
            inArray(subscriptions.id, code.subscriptionIds),
            eq(subscriptions.ownerPersonId, code.personId),
            eq(subscriptions.status, 'waiting_machine'),
            isNull(subscriptions.removedAt),
          ),
        );
      if (subs.length === 0) throw codeUsed();

      const details = { hostname: body.hostname, os: body.os, arch: body.arch };
      const [machine] = await tx
        .insert(machines)
        .values({ companyId: code.companyId, personId: code.personId, machineKey: body.machineId, ...details })
        .onConflictDoUpdate({ target: [machines.personId, machines.machineKey], set: { ...details, revokedAt: null } })
        .returning({ id: machines.id });

      const nodes = [];
      for (const sub of subs) {
        const key = newToken();
        await tx
          .update(subscriptions)
          .set({ machineId: machine!.id, nodeKeyHash: hashToken(key), status: 'needs_login' })
          .where(eq(subscriptions.id, sub.id));
        nodes.push({ subscriptionId: sub.id, provider: sub.provider, key });
      }
      return { machine: { id: machine!.id }, nodes };
    });

    if (req.headers.accept?.includes('text/plain')) {
      return reply.type('text/plain; charset=utf-8').send(joined.nodes.map(n => `${n.subscriptionId} ${n.provider} ${n.key}\n`).join(''));
    }
    return joined;
  });

  app.get('/api/machines', async req => {
    const me = await requirePerson(req, db);
    const live = isNull(machines.revokedAt);
    const rows = await db
      .select({ id: machines.id, hostname: machines.hostname, os: machines.os, arch: machines.arch, ownerId: people.id, ownerName: people.name })
      .from(machines)
      .innerJoin(people, eq(people.id, machines.personId))
      .where(me.scopeKind === 'company' ? live : and(live, eq(machines.personId, me.id)))
      .orderBy(machines.createdAt);
    const usage = await db
      .select({ machineId: subscriptions.machineId, total: count(), lastSeenAt: max(subscriptions.lastSeenAt) })
      .from(subscriptions)
      .where(isNull(subscriptions.removedAt))
      .groupBy(subscriptions.machineId);
    const byMachine = new Map(usage.map(u => [u.machineId, u]));
    return {
      machines: rows.map(m => ({
        id: m.id,
        hostname: m.hostname,
        os: m.os,
        arch: m.arch,
        owner: { id: m.ownerId, name: m.ownerName },
        online: false,
        lastSeenAt: byMachine.get(m.id)?.lastSeenAt ?? null,
        subscriptions: byMachine.get(m.id)?.total ?? 0,
      })),
    };
  });

  app.post('/api/machines/:id/disconnect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [machine] = await db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    if (machine.personId !== me.id && me.scopeKind !== 'company') throw new ApiError(403, 'forbidden', 'Only the owner of this machine can do this.', 'not_owner');
    await db.transaction(async tx => {
      await tx.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, id));
      await tx
        .update(subscriptions)
        .set({ machineId: null, nodeKeyHash: null, status: 'waiting_machine' })
        .where(and(eq(subscriptions.machineId, id), isNull(subscriptions.removedAt)));
    });
    return reply.code(204).send();
  });

  app.get('/install.sh', async (_req, reply) => {
    const script = await readFile(config.installScript, 'utf8');
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(script.replaceAll('__HORNHOOF_SERVER__', config.publicUrl));
  });
}
