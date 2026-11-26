import type { DispatchQueue } from './queue.js';
import { turnOperatorDeliveries, failedTurnDelivery, heldByOperator } from './deliveries.js';
import { queuedSession, withOriginal, freshConversation, forgetFresh } from './sessions.js';
import { type Along } from './turn-types.js';
import { turnPlacement } from './subscription-room.js';
import { placement, isLeader, liveSubscription, conversationOf } from './placement.js';
import { WORKER_COMPACT_WINDOW, FULL_COMPACT_WINDOW, NOTHING_UNREAD } from './constants.js';
import { idOnly } from '../../db/selections.js';
import { effortsOf, modelsFor } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, jobs } from '../../db/schema.js';
import { dispatchJob } from '../jobs/dispatch.js';
import { turnsHeld } from '../updates/drain.js';
import { ownMachine } from '../nodes/hub.js';
import { machineInstalls, nextToInstallHolds } from '../network/follow.js';
import { turnSent } from '../nodes/program-room.js';
import { messageForJob, publishWorking } from '../events/store.js';
import { instructionsOf } from '../agents/instructions.js';
import { repoAt, turnPlaces } from '../departments/repository.js';
import { textHash } from '../templates/load.js';
import { openTaskNumbers } from '../tasks/open-numbers.js';
import { addressed } from './prompt.js';
import { effortOfTurn } from './turn-effort.js';
import { repositoryScope } from '../testruns/describe.js';
import { cancelUnsentDelivery } from '../program-operator/deliveries.js';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { claimMail, inboxChanged, mailShown, mailSummary, mailWentOut, unreadMail } from './inbox.js';
export async function sendNext(ctx: Ctx, agentId: string, queue: DispatchQueue): Promise<void> {
  const { waitsForWords, waitsForRetry, dueTurn, inboxTurnDue, heldBack, goingAlong, ALONG, take, HELD, wentOutWithWords, wentOut } = queue;
  const { db } = ctx;
  const [running] = await db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  if (running || await waitsForWords(ctx, agentId)) return;
  /* Between turns: onto a fallback plan while its own holds its turns back, and home again once it does not. What follows
     reads the plan it is on after that. */
  await ctx.conversationEffects.beforeDispatch(ctx, agentId);
  const sub = await liveSubscription(ctx, agentId);
  if (!sub || sub.status !== 'ready') return;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
  if (!agent || !(await placement(ctx, agent, sub))) return;
  if (await heldByOperator(ctx, agent)) return;
  /* An update waits for the turns that run: new ones start after it, the orchestrator's go on. */
  if (agent.kind !== 'orchestrator' && turnsHeld(ctx, agent.companyId)) return;
  if (await waitsForRetry(ctx, agentId)) return;
  const due = await dueTurn(ctx, agent, sub);
  if (!due) return (await inboxTurnDue(ctx, agent)) ? sendNext(ctx, agentId, queue) : undefined;
  if (await heldBack(ctx, due)) return sendNext(ctx, agentId, queue);
  /* The turn that takes the inbox asks what is unread in it when it goes, or goes nowhere when nothing is. */
  let mail = due.inboxWake ? await unreadMail(db, agentId) : [];
  if (due.inboxWake && !mail.length) {
    await db.update(jobs).set({ status: 'done', result: NOTHING_UNREAD, finishedAt: new Date() }).where(and(eq(jobs.id, due.id), eq(jobs.status, 'queued')));
    return sendNext(ctx, agentId, queue);
  }
  const job = due.inboxWake ? { ...due, prompt: mailSummary(mail) } : due;
  const at = await repoAt(ctx, await turnPlaces(db, agent, job.taskId));
  const repo = at?.repo ?? null;
  const place = await turnPlacement(ctx, agent, sub);
  if (!place) return;
  /* A machine that installs its build takes no turn now; the turn waits and goes out by itself when the machine is done.
     Asked here, before the turn's words are put together, and once more when the turn is taken. Nor does the machine
     next to install, so the turns that run there end and it has its turn: the orchestrator's and the heads' wait up to
     their limit. */
  if (await machineInstalls(db, place.nodeId)) return;
  if (await nextToInstallHolds(ctx, place.nodeId, isLeader(agent))) return;
  const going: Along[] = [];
  for (const j of await goingAlong(ctx, agent, job)) if (!(await heldBack(ctx, { ...j, agentId }))) going.push(j);
  /* The turn that takes the inbox goes along with what is unread in it now; while nothing is, it stays and ends unsent. */
  if (!mail.length && going.some(j => j.inboxWake)) mail = await unreadMail(db, agentId);
  const along = going.flatMap(j => (!j.inboxWake ? [j] : mail.length ? [{ ...j, prompt: mailSummary(mail) }] : []));

  const instructions = await instructionsOf(ctx, agent);
  /* The program's flag only for a model this subscription can run; anything else runs on its Default. */
  const models = modelsFor(sub.provider, sub.models);
  const model = agent.model && models.some(m => m.id === agent.model) ? agent.model : null;
  /* How hard it thinks goes on in the same session; the program starts again at the new level. */
  const effort = effortOfTurn(ctx, agent, effortsOf(models, model));
  /* The hash covers the model too, so a new model starts a fresh session like new instructions do. */
  const runHash = model ? textHash(`${instructions.hash}:${model}`) : instructions.hash;
  const on = { subscriptionId: sub.id, nodeId: place.nodeId, builtinMachine: place.builtinMachine, own: ownMachine(ctx.config) };
  const { sessionId, catchUp, originalPrompt, prompts } = await queuedSession(ctx, agent, on, runHash, job, along);
  const asked = along.length ? [ALONG, job.prompt, ...prompts].join('\n\n---\n\n') : job.prompt;
  const said = withOriginal(asked, originalPrompt);
  /* A turn that types nothing only starts the program, for a person to talk to it: what was said before goes with its
     instructions instead. Where the agent works it reads with its briefing tool, so no message carries it. */
  const composed = catchUp ? `${catchUp}\n\n${said}` : said;
  /* An assistant's own agent reads its program's message as the program built it: its rules say who it is from. A new
     session reads the program's whole conversation, when the program sent it, in place of the new words and the catch-up.
     A session that goes on may have begun anew on its machine, which only the node sees: the conversation goes beside the
     words, for the node to type in their place then. */
  const fresh = agent.kind === 'assistant' && job.prompt ? await freshConversation(ctx, job.id) : null;
  const prompt = !job.prompt ? '' : job.inboxWake ? composed : agent.kind === 'assistant' ? (sessionId === null ? fresh : null) ?? composed : addressed(composed, await messageForJob(ctx, { id: job.id, companyId: job.companyId, agentId, retryOf: job.retryOf, continueOf: job.continueOf }));
  const token = newToken();
  /* Running from the moment it is sent: the token works for its tools at once, and the next turn waits. */
  /* The machine of the built-in node it goes to is written with it, so that node alone may answer for it. */
  const taken = await take(ctx, job, along, { subscriptionId: sub.id, nodeId: place.nodeId, builtinMachine: place.builtinMachine, prompt, sessionId, toolTokenHash: hashToken(token), instructionsHash: runHash });
  if (taken === HELD) return;
  if (!taken) return sendNext(ctx, agentId, queue);
  await claimMail(db, agentId, mail, job);
  wentOutWithWords(ctx, agentId, job);
  /* The agent stays on this machine from now on. */
  if (place.moves) await db.update(agents).set({ nodeId: place.nodeId, builtinMachine: place.builtinMachine }).where(eq(agents.id, agentId));
  let sent = false;
  let deliveries: { operatorDelivery?: OperatorDelivery; operatorSourceDelivery?: OperatorDelivery } = {};
  try {
    deliveries = await turnOperatorDeliveries(ctx, agent, job, place.node, prompt);
    const tasksNow = repo ? await openTaskNumbers(db, agent.companyId) : null;
    await publishWorking(ctx, job.companyId);
    sent = await dispatchJob(ctx, {
      id: job.id,
      subscriptionId: sub.id,
      nodeId: place.nodeId,
      builtinMachine: place.builtinMachine,
      role: agent.roleKey,
      leader: isLeader(agent),
      prompt,
      freshPrompt: sessionId === null ? null : fresh,
      sessionId,
      model,
      effort,
      compactWindow: agent.kind === 'worker' ? WORKER_COMPACT_WINDOW : FULL_COMPACT_WINDOW,
      timeoutMs: job.timeoutMs,
      instructions: instructions.text,
      toolToken: token,
      ...deliveries,
      context: job.prompt ? null : catchUp,
      /* Each agent keeps one folder on the node, with its repository's clone inside, which gets the dependencies the
         company's machines built for its commit. Which tasks are still open lets the node take away its worktrees of the
         closed ones. */
      workspace: { key: agent.id, repo, ...(at ? { repositoryScope: repositoryScope(at.department.companyId, at.department.id, at.repo.url) } : {}), ...(tasksNow ? { tasks: tasksNow } : {}) },
      skills: instructions.skills,
    });
  } catch (err) {
    await failedTurnDelivery(ctx, job, err);
  }
  if (sent) {
    turnSent(ctx, place.node, agentId);
    /* What the inbox showed is read with this turn; a letter that came for the inbox meanwhile waits for the next one. */
    const read = await mailWentOut(db, agentId, [job.id, ...along.filter(j => !j.inboxWake).map(j => j.id)]);
    if (mail.length) await mailShown(db, agentId, mail.map(m => m.id), job.id);
    if (read || mail.length) await inboxChanged(ctx, agentId);
    if (agent.kind === 'assistant') await forgetFresh(ctx, job.id);
    return wentOut(ctx, job, along, taken.lines);
  }
  if (deliveries.operatorDelivery) await cancelUnsentDelivery(db, deliveries.operatorDelivery);
  await db.update(jobs).set({ status: 'queued', startedAt: null, nodeId: null, prompt: job.prompt, sessionId: job.sessionId, toolTokenHash: null, instructionsHash: null }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')));
  await publishWorking(ctx, job.companyId);
}
