import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { canReach, type Access } from '../../auth/access.js';
import { viewerOf } from '../../auth/agent-view.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { StreamMessage } from './bus.js';
import { heardBy, heardInFull } from './stream-view.js';

/* Whether a message is for this person at all, by where they reach and what is theirs. A task goes to everyone of the
   company, who sees all of its work; the rest that names a place goes where the person reaches. */
function isFor(m: StreamMessage, me: Person, access: Access): boolean {
  if ('spot' in m && m.type !== 'task' && !canReach(access, m.spot)) return false;
  /* It carries nothing, so every person's screens load the access that is theirs to see; a head acting for anyone sees
     none of it. */
  if (m.type === 'computer' && me.viaHead) return false;
  return m.type !== 'subscription.signin' || m.owner === me.id;
}

/* One Server-Sent Events stream per open page. What is said of an agent or its work goes only to people who see them. */
export function streamRoutes(app: FastifyInstance, ctx: Ctx): void {
  const open = new Set<ServerResponse>();
  /* Before Fastify waits for requests to finish, since a stream never does. */
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/stream', async (req, reply) => {
    let me = await requirePerson(req, ctx.db);
    let viewer = await viewerOf(ctx.db, me);
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    open.add(res);

    const send = (m: StreamMessage) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(m)}\n\n`);
    };
    /* Without the full view each message waits to be checked, one after the other, so they keep their order. A message that
       says the company changed may have moved who this person sees, so they look again before anything after it. */
    let checked: Promise<void> = Promise.resolve();
    const check = async (m: StreamMessage) => {
      if (m.type === 'org') await look();
      const heard = await heardBy(ctx.db, me.companyId, viewer, m);
      if (heard) send(heard);
    };
    const unsubscribe = ctx.bus.subscribe(me.companyId, m => {
      if (!isFor(m, me, viewer.access)) return;
      if (viewer.full) {
        const heard = heardInFull(viewer, m);
        if (heard) send(heard);
      } else checked = checked.then(() => check(m)).catch((err: unknown) => req.log.warn({ err }, 'A message of the stream was not checked, so it was not sent.'));
    });
    /* The ping keeps proxies from closing the stream and looks at the person again: a signed-out or disabled person stops
       hearing anything, and changed access applies from here on. A change of anyone's access looks at once. Looks overlap,
       as a change of access calls one beside the checks: each says who the person is unless one begun after it has said
       so already, so an older one that ends later never brings back what they saw before. */
    let begun = 0, said = 0;
    const look = async () => {
      const mine = ++begun;
      try {
        const person = await requirePerson(req, ctx.db);
        const seen = await viewerOf(ctx.db, person);
        if (mine > said) [me, viewer, said] = [person, seen, mine];
        return true;
      } catch {
        res.end();
        return false;
      }
    };
    const ping = setInterval(() => {
      void look().then(ok => {
        if (ok) res.write(': ping\n\n');
      });
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
