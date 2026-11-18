import { createHmac } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentHidden, seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requireCompanyPerson, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { feedbackInbox, feedbackSubmissions, improvements, repoHosts } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { improvementsChanged, moveImprovementTx } from '../improvements/store.js';
import { ISSUE_REPOSITORY, issueOf } from './github-issue.js';
import { fingerprintOfReport, inboxChanged, listInbox, receive } from './inbox.js';
import { answerOf, factsOf, installationOf, REPEATS_MAX, Report, shownOf, Written, type IssueLink, type Shown } from './report.js';

/* A body the inbox takes from the relay at most. */
const INBOUND_BYTES = 16 * 1024;
const ISSUE_OWNER = ISSUE_REPOSITORY.split('/')[0]!;

const Send = Written.extend({ digest: z.string().regex(/^[0-9a-f]{64}$/) });
const Params = z.object({ id: z.uuid() });
const Repeats = z.strictObject({ improvement: z.uuid() });

const notHere = () => new ApiError(404, 'not_found', 'Not found.');
const humanOnly = (me: Person): void => {
  if (me.viaHead) throw new ApiError(403, 'forbidden', 'Only a person does this, from their own screen, or the orchestrator.', 'feedback_person_only');
};

/* The wait a refusal names, as the header a client reads. */
function passWait(reply: FastifyReply, err: unknown): never {
  const wait = err instanceof ApiError ? err.details?.retryAfterS : undefined;
  if (typeof wait === 'number') reply.header('retry-after', String(wait));
  throw err;
}

/* The finding a report is sent from: one about Hornhoof itself that still waits, on an installation that sends them on,
   filed by an agent the person may see, as for taking it. */
async function findingFor(ctx: Pick<Ctx, 'db' | 'config'>, me: Person, id: string | undefined) {
  if (!id) return null;
  const [found] = await ctx.db.select().from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, me.companyId)));
  if (!found) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
  if (!seesAgentId(await viewerOf(ctx.db, me), found.agentId)) throw agentHidden();
  if (found.scope !== 'platform' || ctx.config.feedbackInbox) throw new ApiError(409, 'conflict', 'This finding is about the work of this company, so it stays here.', 'improvement_not_platform');
  if (found.status !== 'open') throw new ApiError(409, 'conflict', `This improvement is ${found.status} already.`, 'improvement_decided');
  return found;
}

/* The issue an answer of the inbox names, as a finding keeps it. */
const issueColumns = (issue: IssueLink | null) => (issue ? { issueNumber: issue.number, issueUrl: issue.url } : {});

/* The relay sees a stable submission id without learning who sent it or what it came from. */
function submissionOf(ctx: Pick<Ctx, 'config'>, ...parts: (string | number)[]): string {
  return createHmac('sha256', ctx.config.secret).update(JSON.stringify(parts)).digest('hex');
}

function sendReport(ctx: Ctx, submission: string, report: Shown, repeats?: number) {
  const signed = { v: 1 as const, installation: installationOf(ctx.config.secret), submission, ...report, repeats };
  return ctx.config.feedbackInbox ? receive(ctx, signed, false) : ctx.links.relay.feedback(signed).then(answerOf);
}

const receiptKey = (submission: string) => `out:${submission}`;

/* A repeat batch keeps its size when a send fails. New findings belong to the next batch. */
async function reportRepeats(ctx: Ctx, companyId: string, found: typeof improvements.$inferSelect): Promise<void> {
  if (found.status !== 'sent' || !found.sentReport || found.reportedSeen === null || ctx.config.feedbackInbox) throw new ApiError(409, 'conflict', "This finding was not sent to Hornhoof's developers.", 'feedback_not_sent');
  const repeats = Math.min(found.seen - found.reportedSeen, REPEATS_MAX);
  if (repeats < 1) throw new ApiError(409, 'conflict', 'No round found it again since its developers last heard of it.', 'feedback_no_repeats');
  const submission = submissionOf(ctx, 'feedback repeats', companyId, found.id, found.reportedSeen);
  const key = receiptKey(submission);
  await ctx.db.insert(feedbackSubmissions).values({ key, repeats }).onConflictDoNothing();
  const [receipt] = await ctx.db.select().from(feedbackSubmissions).where(eq(feedbackSubmissions.key, key));
  if (receipt!.sent) return;
  const count = receipt!.repeats!;
  const answer = await sendReport(ctx, submission, found.sentReport, count);
  await ctx.db.transaction(async tx => {
    const [marked] = await tx.update(feedbackSubmissions).set({ sent: true })
      .where(and(eq(feedbackSubmissions.key, key), eq(feedbackSubmissions.sent, false))).returning();
    if (marked) await tx.update(improvements)
      .set({ reportedSeen: sql`${improvements.reportedSeen} + ${count}`, reportNumber: found.reportNumber ?? answer.number, ...issueColumns(answer.issue) })
      .where(eq(improvements.id, found.id));
  });
  improvementsChanged(ctx, companyId);
}

/* What would go for what a person wrote, from a finding's card or not: a finding asks for the whole company first. */
async function shown(ctx: Pick<Ctx, 'db' | 'config'>, me: Person, written: Written) {
  if (written.improvement) requireCompanyScope(me);
  const finding = await findingFor(ctx, me, written.improvement);
  return { finding, ...shownOf(written, await factsOf(ctx, me.companyId, finding?.code ?? null)) };
}

/* Feedback to Hornhoof's developers. Any person signed in writes a bug, an improvement or an idea, or sends a finding about
   Hornhoof itself from its card, sees what goes, and only their press sends it: through hornhoof.org, or straight into the
   inbox on Hornhoof's own installation. There the inbox takes what every installation sends, and people who see the whole
   company turn its cards into GitHub issues. */
export function feedbackRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const sending = new Map<string, Promise<void>>();

  /* Concurrent presses share one send on this server. The receiving inbox recognizes the same submission after a restart. */
  function once(key: string, send: () => Promise<void>): Promise<void> {
    const pending = sending.get(key);
    if (pending) return pending;
    const result = send().finally(() => sending.delete(key));
    sending.set(key, result);
    return result;
  }

  app.get('/api/feedback', async req => {
    await requirePerson(req, db);
    return { inbox: config.feedbackInbox };
  });

  app.post('/api/feedback/preview', async req => {
    const me = await requirePerson(req, db);
    const { report, hidden, digest } = await shown(ctx, me, Written.parse(req.body));
    return { report, hidden, digest };
  });

  app.post('/api/feedback', async (req, reply) => {
    const me = await requirePerson(req, db);
    humanOnly(me);
    const body = Send.parse(req.body);
    const { finding, report, digest } = await shown(ctx, me, body);
    if (digest !== body.digest) throw new ApiError(409, 'conflict', 'What would be sent changed since you looked at it. Look at it again.', 'feedback_changed');
    const submission = submissionOf(ctx, 'feedback report', me.companyId, finding?.id ?? me.id, digest);
    try {
      await once(submission, async () => {
        const key = receiptKey(submission);
        const [receipt] = await db.select().from(feedbackSubmissions).where(eq(feedbackSubmissions.key, key));
        if (receipt?.sent) return;
        const answer = await sendReport(ctx, submission, report);
        await db.transaction(async tx => {
          const [added] = await tx.insert(feedbackSubmissions).values({ key, sent: true }).onConflictDoNothing().returning();
          if (added && finding) await moveImprovementTx(tx, me.companyId, finding.id, 'open', {
            status: 'sent',
            decidedBy: me.id,
            sentAt: new Date(ctx.clock()),
            sentReport: report,
            sentFingerprint: fingerprintOfReport(report),
            reportNumber: answer.number,
            ...issueColumns(answer.issue),
            reportedSeen: sql`${improvements.seen}`,
          });
        });
        if (finding) improvementsChanged(ctx, me.companyId);
      });
    } catch (err) {
      passWait(reply, err);
    }
    return { sent: true };
  });

  app.post('/api/feedback/repeats', async (req, reply) => {
    const me = await requireCompanyPerson(req, db);
    humanOnly(me);
    const { improvement } = Repeats.parse(req.body);
    const [found] = await db.select().from(improvements).where(and(eq(improvements.id, improvement), eq(improvements.companyId, me.companyId)));
    if (!found) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
    if (!seesAgentId(await viewerOf(db, me), found.agentId)) throw agentHidden();
    try {
      await once(`repeats:${improvement}:${found.reportedSeen}`, () => reportRepeats(ctx, me.companyId, found));
    } catch (err) {
      passWait(reply, err);
    }
    return { sent: true };
  });

  /* What the relay passes on from every installation. No session: what it takes is checked here, by its shape, its size
     and the shared protection against a flood. */
  app.post('/api/feedback/inbound', { bodyLimit: INBOUND_BYTES }, async (req, reply) => {
    if (!config.feedbackInbox) throw notHere();
    const report = Report.safeParse(req.body);
    if (!report.success) throw new ApiError(400, 'validation', 'This is not a feedback report Hornhoof takes.', 'feedback_refused');
    let answer: Awaited<ReturnType<typeof receive>> | undefined;
    try {
      answer = await receive(ctx, report.data);
    } catch (err) {
      passWait(reply, err);
    }
    return reply.code(202).send({ received: true, ...answer });
  });

  app.get('/api/feedback/inbox', async req => {
    if (!config.feedbackInbox) throw notHere();
    const me = await requireCompanyPerson(req, db);
    return { cards: await listInbox(ctx, me.companyId) };
  });

  /* Cards whose issue is being made now, so two presses at once make one. */
  const opening = new Set<string>();

  app.post('/api/feedback/inbox/:id/issue', async req => {
    if (!config.feedbackInbox) throw notHere();
    const me = await requireCompanyPerson(req, db);
    humanOnly(me);
    const { id } = Params.parse(req.params);
    const card = (await listInbox(ctx, me.companyId)).find(c => c.id === id);
    if (!card) throw new ApiError(404, 'not_found', 'There is no such card in the inbox.', 'feedback_unknown');
    if (card.issue || opening.has(id)) throw new ApiError(409, 'conflict', 'This card has an issue already.', 'feedback_issued');
    opening.add(id);
    try {
      const key = await issueKey(ctx, me.companyId);
      const made = await ctx.createIssue(key, issueOf(card));
      if ('problem' in made) throw new ApiError(502, 'unavailable', `GitHub did not create the issue. ${made.problem}`, 'feedback_issue_refused');
      const [saved] = await db
        .update(feedbackInbox)
        .set({ issueNumber: made.number, issueUrl: made.url, issuedBy: me.id })
        .where(and(eq(feedbackInbox.id, id), eq(feedbackInbox.companyId, me.companyId), isNull(feedbackInbox.issueNumber)))
        .returning({ id: feedbackInbox.id });
      if (!saved) throw new ApiError(409, 'conflict', 'This card has an issue already.', 'feedback_issued');
      inboxChanged(ctx, me.companyId);
      return { issue: { number: made.number, url: made.url } };
    } finally {
      opening.delete(id);
    }
  });
}

/* The GitHub key the company saved for the owner of the issues' repository: the company's own first, then a department's,
   as a repository is created with them. */
async function issueKey(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string) {
  const rows = await ctx.db.select().from(repoHosts).where(eq(repoHosts.companyId, companyId)).orderBy(asc(repoHosts.updatedAt));
  const ours = rows.filter(r => r.owner.toLowerCase() === ISSUE_OWNER);
  const host = ours.find(r => !r.departmentId) ?? ours[0];
  if (!host) throw new ApiError(409, 'conflict', `No GitHub key for ${ISSUE_OWNER} is saved. Save one in Settings, under Integrations, with the right to create issues.`, 'feedback_no_github_key');
  return { provider: host.provider, owner: host.owner, token: decryptSecret(host.tokenEnc, ctx.config.secret) };
}
