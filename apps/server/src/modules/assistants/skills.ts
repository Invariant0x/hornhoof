import { createHmac } from 'node:crypto';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { assistantReplies, assistants } from '../../db/schema.js';

/* How long the program has for one skill, and how much of its answer an agent reads. */
export const SKILL_WAIT_MS = 120_000;
export const SKILL_ANSWER_BYTES = 100_000;

/* What a skill's call is signed with: HMAC-SHA256 of the time and the exact body under the signing secret, so the program
   tells a call heard again later from a new one. */
export const skillSignature = (secret: string, stamp: string, body: string): string => `sha256=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}`;

const Answer = z.object({ ok: z.boolean(), text: z.string(), data: z.unknown().optional() });

/* Whether the assistant whose own agent this is has a skills address now: only then is persona_call among its agent's tools
   and in its instructions. */
export async function hasSkills(db: Ctx['db'], agentId: string): Promise<boolean> {
  const [row] = await db.select({ agentId: assistants.agentId }).from(assistants).where(and(eq(assistants.agentId, agentId), isNotNull(assistants.skillsUrl), ne(assistants.skillsUrl, '')));
  return row !== undefined;
}

type Called = { ok: boolean; text: string };
const failed = (text: string): Called => ({
  ok: false,
  text: `The skill did not complete successfully. Do not report success. Tell your owner what failed and why; for a refused file delivery, say that the file did not arrive.\n\nReason: ${text}`,
});
const timedOut = (err: unknown) => err instanceof Error && err.name === 'TimeoutError';
const late = `The assistant's program did not answer within ${SKILL_WAIT_MS / 1000} seconds.`;

function skillAnswer(parsed: z.infer<typeof Answer>): Called {
  const text = parsed.data === undefined ? parsed.text : `${parsed.text}\n\n${JSON.stringify(parsed.data)}`;
  return parsed.ok ? { ok: true, text } : failed(text);
}

/* The answer's text, or null past the most an agent reads. */
async function capped(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SKILL_ANSWER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* One of the assistant program's own skills, asked for by the assistant's own agent: a signed POST to the program's skills
   address with the message that started the turn when the assistant's words started it, and the program's answer as the
   agent reads it. A redirect is not followed. */
export async function callSkill(ctx: Ctx, job: { id: string; agentId: string }, call: { name: string; arguments: Record<string, unknown> }, signal: AbortSignal): Promise<Called> {
  const [to] = await ctx.db.select({ assistantId: assistants.personId, url: assistants.skillsUrl, secret: assistants.wakeSecretEnc }).from(assistants).where(eq(assistants.agentId, job.agentId));
  if (!to?.url) return failed("This assistant has no skills address, so its program's skills cannot be asked: its owner sets one on the assistant's card in People.");
  if (!to.secret) return failed("This assistant has no key yet, so its program's skills cannot be asked: its owner makes one on the assistant's card in People.");
  const [started] = await ctx.db
    .select({ messageId: assistantReplies.messageId })
    .from(assistantReplies)
    .where(and(eq(assistantReplies.jobId, job.id), eq(assistantReplies.assistantId, to.assistantId)))
    .orderBy(desc(assistantReplies.createdAt))
    .limit(1);
  const body = JSON.stringify({ messageId: started?.messageId ?? null, name: call.name, arguments: call.arguments });
  const stamp = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetch(to.url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-hornhoof-timestamp': stamp, 'x-hornhoof-signature': skillSignature(decryptSecret(to.secret, ctx.config.secret), stamp, body) },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(SKILL_WAIT_MS), signal]),
    });
  } catch (err) {
    return failed(timedOut(err) ? late : "The assistant's program could not be reached at its skills address.");
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return failed(`The assistant's program answered with status ${res.status}.`);
  }
  /* The answer comes within the same time, and a program that breaks off or stalls in the middle of it answered nothing. */
  let raw: string | null;
  try {
    raw = await capped(res);
  } catch (err) {
    return failed(timedOut(err) ? late : "The assistant's program stopped in the middle of its answer.");
  }
  if (raw === null) return failed(`The assistant's program answered with more than ${SKILL_ANSWER_BYTES / 1000} KB.`);
  let parsed: z.infer<typeof Answer>;
  try {
    parsed = Answer.parse(JSON.parse(raw));
  } catch {
    return failed("The assistant's program answered without ok and text in JSON.");
  }
  return skillAnswer(parsed);
}
