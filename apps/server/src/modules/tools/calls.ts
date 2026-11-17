import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRIVATE_COMMAND_REFUSED, PRIVATE_TURN_LOST, type ToolPrivacyPolicy } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { fromTunnel } from '../../auth/tunnel.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { notConfirmed } from '../../db/confirm.js';
import { isLeaseRefused } from '../../db/net.js';
import { toolCalls } from '../../db/schema.js';
import { listed, outsideSources, sources, toolSource, touch, withSource } from '../../db/sources.js';
import { READ_ONLY_MESSAGE } from '../keeper/app-mode.js';
import { INVOCATION, UUID } from '../../net/proxy.js';
import { READ_TOOLS } from './read-tools.js';

export { INVOCATION };

/* The call's id, believed only from the keeper's address: the keeper passes it on only from front, so a node that reaches
   the app past them never stamps a call. */
export async function invocationOf(req: FastifyRequest, config: Config): Promise<string | null> {
  const id = String(req.headers[INVOCATION] ?? '').toLowerCase();
  return UUID.test(id) && (await fromTunnel(req, config)) ? id : null;
}

/* The tools that reach a node, the updater, the computer, a file, the relay or another turn. A second run of one could
   stop the next turn, send a message again or start another install, so each commits that it started before it acts. */
export const STARTS_FIRST: ReadonlySet<string> = new Set([
  'run_tests',
  'run_work',
  'stop_tests',
  'stop_work',
  'computer',
  'ask_computer_access',
  'test_subscription',
  'update_hornhoof',
  'cancel_update',
  'set_public_link',
  'remove_public_link',
  'tell_orchestrator',
  'message_employee',
  'stop_employee',
  'cancel_task',
  'disconnect_machine',
  'remove_subscription',
  'program_keys',
  'restart_program',
]);

/* The longest answer kept, as JSON. */
export const ANSWER_MAX = 256 * 1024;

const clock = (at: Date): string => at.toISOString().slice(11, 16);
export const PENDING = (startedAt: Date): string => `This call started at ${clock(startedAt)} UTC and its result is not in yet. Do not run it again; look at its result first.`;
export const ALREADY_RAN = 'This call already ran, but its answer was not kept. Look at its result before you repeat it.';
export const MAY_HAVE_RUN = 'Hornhoof could not confirm this change. The call may have run; look at its result before you repeat it.';
export const TOO_LARGE = 'This call ran, but its answer was too large to keep. Look at its result again.';
export const ID_TAKEN = 'This call id belongs to another job, so the call did not run. Send it again.';

type Answer = { content: { type: 'text'; text: string }[]; isError?: boolean; [more: string]: unknown };
export type ToolProtection = {
  lost?: boolean;
  sensitive(name: string, policy: ToolPrivacyPolicy, input: unknown, answer?: Answer): Promise<void>;
  hide<T>(value: T): T;
};
const say = (text: string): Answer => ({ content: [{ type: 'text', text }], isError: true });

/* The id of the tool call running now, when front gave it one. */
export function currentInvocation(): string | null {
  const base = sources.getStore()?.base;
  return base?.startsWith('tool:') ? base.slice('tool:'.length) : null;
}

/* What is kept of an answer: the answer, or a note that it was too large. */
export const keptAnswer = (answer: unknown): unknown => (JSON.stringify(answer).length > ANSWER_MAX ? say(TOO_LARGE) : answer);

type Call = { db: Db; jobId: string; id: string; name: string };

const rowOf = async ({ db, id }: Call) => (await db.select().from(toolCalls).where(eq(toolCalls.id, id)))[0];

/* What a call that came before answers this one with, or null when this one is the first. */
async function answeredBefore(call: Call): Promise<Answer | null> {
  const row = await rowOf(call);
  if (row && row.jobId !== call.jobId) return say(ID_TAKEN);
  if (row) {
    /* Written again as it is, so the journal carries the row to whoever keeps a copy. */
    await call.db.execute(sql`UPDATE tool_calls SET at = at WHERE id = ${call.id}`);
    return (row.answer as Answer | null) ?? say(PENDING(row.at));
  }
  const before = await listed(call.db, toolSource(call.id));
  if (!before) return null;
  await touch(call.db, before.first);
  return say(ALREADY_RAN);
}

/* Whether this call is the one that starts: a call of the same id that got here first holds the row. */
async function started({ db, id, jobId }: Call): Promise<boolean> {
  return (await db.insert(toolCalls).values({ id, jobId }).onConflictDoNothing().returning({ id: toolCalls.id })).length === 1;
}

/* The first answer stays: a row the lease check wrote in the change's own commit, or one an earlier try kept, is not replaced. */
async function keep({ db, id, jobId }: Call, answer: unknown): Promise<void> {
  const kept = JSON.stringify(keptAnswer(answer));
  await db.execute(sql`INSERT INTO tool_calls (id, job_id, answer) VALUES (${id}, ${jobId}, ${kept}::jsonb)
    ON CONFLICT (id) DO UPDATE SET answer = excluded.answer WHERE tool_calls.answer IS NULL`);
}

/* A failure that will pass says nothing of whether the change was made. On a started row that is kept, since the tool may
   have acted; any other call keeps nothing, so its retry runs, or hears that it ran. */
async function passing(call: Call, err: unknown, startsFirst: boolean): Promise<Answer> {
  const refused = isLeaseRefused(err);
  if (!refused && !notConfirmed(err)) throw err;
  if (startsFirst) await outsideSources(() => keep(call, say(MAY_HAVE_RUN))).catch(() => undefined);
  return say(refused ? READ_ONLY_MESSAGE : MAY_HAVE_RUN);
}

async function once(call: Call, run: () => Promise<Answer>): Promise<Answer> {
  const before = await outsideSources(() => answeredBefore(call));
  if (before) return before;
  const startsFirst = STARTS_FIRST.has(call.name);
  if (startsFirst && !(await outsideSources(() => started(call)))) return (await outsideSources(() => answeredBefore(call))) ?? say(ALREADY_RAN);
  let answer: Answer;
  try {
    answer = await withSource(toolSource(call.id), run);
  } catch (err) {
    return passing(call, err, startsFirst);
  }
  /* The tool did its work, and the agent hears so even when the answer cannot be kept: told of a failure, it would do the
     work again under a new id. The same id sent again still finds the call started or listed, and does not run it. */
  await outsideSources(() => keep(call, answer)).catch(() => undefined);
  return answer;
}

/* Wraps every tool the modules register after it. With an invocation id a call runs once: its work runs in a source of
   that id, its answer is kept under it for its job, and the same id sent again gets that answer, hears that the call is
   still running, or hears that it ran. Without an id a call runs as it always did. */
export function guardTools(server: McpServer, ctx: Pick<Ctx, 'db'>, job: { id: string }, invocation: string | null, protection?: ToolProtection): void {
  type Config = { _meta?: ToolPrivacyPolicy };
  const register = server.registerTool.bind(server) as (name: string, config: Config, handler: (...given: unknown[]) => Promise<Answer>) => unknown;
  server.registerTool = ((name: string, config: Config, handler: (...given: unknown[]) => Promise<Answer>) => {
    if (protection?.lost) return register(name, config, READ_TOOLS.has(name) && name !== 'database' ? handler : async () => say(PRIVATE_TURN_LOST));
    if (config._meta?.sensitive) return register(name, config, async (...given) => {
      await protection?.sensitive(name, config._meta!, given.length > 1 ? given[0] : undefined);
      /* Neither replay state nor a tool source: even a retry after a committed audit write must check access again.
         Unexpected errors can hold input or output in their message or cause, so they leave no detail. */
      try {
        const answer = await handler(...given);
        await protection?.sensitive(name, config._meta!, undefined, answer);
        return answer;
      }
      catch { return say('The sensitive tool could not complete. Its details are hidden.'); }
    });
    const run = async (...given: unknown[]) => {
      if (given.length > 1 && protection) {
        const hidden = protection.hide(given[0]);
        if (config._meta?.secretCommand && JSON.stringify(hidden) !== JSON.stringify(given[0])) return say(PRIVATE_COMMAND_REFUSED);
        given[0] = hidden;
      }
      const answer = await handler(...given);
      return protection?.hide(answer) ?? answer;
    };
    return register(name, config, invocation ? (...given) => once({ db: ctx.db, jobId: job.id, id: invocation, name }, () => run(...given)) : run);
  }) as McpServer['registerTool'];
}
