import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { agentFor } from '../agents/find.js';
import { useSessionStore } from '../vault/fill.js';
import { keepVaultSignIn, removeSignIn, signInOf, signInsOf, signInViews } from './store.js';

/* The saved sign-ins on an employee's card: a person who sees the employee reads where it is signed in and revokes a
   sign-in with one press. A person of another department does not see the employee and is refused. */

const SignInParams = z.object({ signInId: z.string() });
const unknownSignIn = () => new ApiError(404, 'not_found', 'This employee has no such saved sign-in.', 'sign_in_unknown');

export function signInRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* A site sign-in the vault's browser got is kept for the agent whose turn asked for it. */
  useSessionStore(ctx, keepVaultSignIn);

  app.get('/api/agents/:id/sign-ins', async req => {
    const { agent } = await agentFor(ctx, req);
    return { signIns: await signInViews(ctx, await signInsOf(ctx, agent.id)) };
  });

  app.delete('/api/agents/:id/sign-ins/:signInId', async (req, reply) => {
    const { agent } = await agentFor(ctx, req);
    const row = await signInOf(ctx, agent.id, SignInParams.parse(req.params).signInId);
    if (!row) throw unknownSignIn();
    await removeSignIn(ctx, row);
    return reply.code(204).send();
  });
}
