import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { writePrivately } from '../keeper/machine-keys.js';
import { RECOVERY_FILE, type Question, type RecoveryWord } from '../keeper/question.js';
import { freshState } from '../keeper/state.js';

const GoOnBody = z.object({ networkId: z.string().regex(/^[0-9a-f]{32}([0-9a-f]{32})?$/), reach: z.string().max(64).nullable() });

const notCeo = () => new ApiError(403, 'forbidden', 'Only the CEO answers this, by himself or through the orchestrator.', 'not_owner_session');
const changed = () => new ApiError(409, 'conflict', 'The question changed. Look again.', 'question_changed');

/* The CEO himself, or the orchestrator acting for him: not a head, and not his assistant. */
const ownSession = (me: Person): boolean => me.isOwner && !me.viaHead && !me.assistant;

/* The question a copy puts to the CEO while the machine that leads is gone and the copy may lack changes, as the app
   of that copy shows it, and the CEO's answer, which goes to this machine's keeper through the control folder. The
   app only reads there: it decides nothing, and writes nothing into the company's data. */
export function questionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* The question the keeper's last fresh word carries; none on a machine that leads. */
  const standing = (): Question | null => (ctx.mode.current() === 'lead' ? null : (freshState(config.controlDir, Date.now())?.question ?? null));
  const answer = (word: RecoveryWord): void => writePrivately(join(config.controlDir, RECOVERY_FILE), JSON.stringify(word));
  const stamp = (me: Person) => ({ id: randomUUID(), by: me.id, at: new Date().toISOString() });

  app.get('/api/network/question', async req => {
    const me = await requirePerson(req, db);
    return { question: standing(), canAnswer: ownSession(me) };
  });

  app.post('/api/network/question/go-on', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!ownSession(me)) throw notCeo();
    const body = GoOnBody.parse(req.body);
    /* He chose a copy for what it had when he looked: anything else is another question. */
    if (!standing()?.copies.some(copy => copy.networkId === body.networkId && copy.reach === body.reach)) throw changed();
    answer({ ...stamp(me), goOn: body.networkId, reach: body.reach });
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/network/question/wait', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!ownSession(me)) throw notCeo();
    if (!standing()) throw changed();
    answer({ ...stamp(me), wait: true });
    return reply.code(202).send({ ok: true });
  });
}
