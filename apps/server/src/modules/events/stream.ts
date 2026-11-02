import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { requirePerson } from '../../auth/session.js';

/* One Server-Sent Events stream per open page. An agent's conversation goes only to people who reach where it works:
   the orchestrator's to people who see the whole company. */
export function streamRoutes(app: FastifyInstance, ctx: Ctx): void {
  const open = new Set<ServerResponse>();
  /* Before Fastify waits for requests to finish, since a stream never does. */
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/stream', async (req, reply) => {
    let me = await requirePerson(req, ctx.db);
    let access = await accessOf(ctx.db, me);
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    open.add(res);

    const unsubscribe = ctx.bus.subscribe(me.companyId, m => {
      if ('spot' in m && !canReach(access, m.spot)) return;
      if (m.type === 'subscription.signin' && m.owner !== me.id) return;
      res.write(`data: ${JSON.stringify(m)}\n\n`);
    });
    /* The ping keeps proxies from closing the stream and looks at the person again: a signed-out or disabled person stops
       hearing anything, and changed access applies from here on. A change of anyone's access looks at once. */
    const look = async () => {
      try {
        me = await requirePerson(req, ctx.db);
        access = await accessOf(ctx.db, me);
        return true;
      } catch {
        res.end();
        return false;
      }
    };
    const ping = setInterval(async () => {
      if (await look()) res.write(': ping\n\n');
    }, ctx.config.streamPingMs);
    const stopLooking = ctx.bus.onAccessChange(me.companyId, () => void look());
    res.on('close', () => {
      clearInterval(ping);
      stopLooking();
      unsubscribe();
      open.delete(res);
    });
  });
}
