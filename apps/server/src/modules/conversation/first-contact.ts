import type { CompanyTemplateKey } from '@hornhoof/protocol';
import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agentEvents, companies, jobs } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { FIRST_CONTACT_ACTION, quote, turnPrompt } from './prompt.js';
import { insertTurn, NoSubscription, orchestratorOf, pump, turnGoingOn } from './queue.js';
import { onAgent } from './line.js';

const WORDS = {
  fixProject: 'Fix a problem in my project', checkSetup: 'Check that my project is ready to run',
  planLaunch: 'Plan my first launch', sketchProduct: 'Sketch the first product screen', findCustomers: 'Find people who might use my product',
  pickProduct: 'Choose what to ship next', reviewScreens: 'Review a product’s screens',
  reviewBills: 'Sort bills and check what is due', sortRequests: 'Sort customer requests', planRelease: 'Plan a product release',
  reviewSecurity: 'Review my project for security problems', triageReport: 'Sort a security report and plan the fix',
  sortIssues: 'Sort open issues', writeGuide: 'Write a guide for new contributors',
  findLeads: 'Find possible clients', answerClients: 'Sort and answer client requests',
  planExperiment: 'Plan an experiment', reviewResults: 'Review the results and suggest what to try next',
  findDevices: 'Find my TVs and other home devices and help clean up junk', checkDevices: 'Check my home devices and Wi-Fi',
  householdBooks: 'Set up Accounting to keep my household books and receive my bills and papers',
  setUpPipeline: 'Set up a way to handle my work',
  chooseDepartments: 'Set up departments for the work I do',
  telegram: 'Set up Telegram so I can talk to you there', assistant: 'Set up my personal assistant',
} as const;

type Offer = keyof typeof WORDS;
const MENUS = {
  project: ['fixProject', 'checkSetup'], startup: ['planLaunch', 'sketchProduct', 'findCustomers'],
  studio: ['pickProduct', 'reviewScreens'], corporation: ['reviewBills', 'sortRequests', 'planRelease'],
  security: ['reviewSecurity', 'triageReport'], opensource: ['sortIssues', 'writeGuide'],
  agency: ['findLeads', 'answerClients'], lab: ['planExperiment', 'reviewResults'],
  home: ['findDevices', 'checkDevices', 'householdBooks'], empty: ['chooseDepartments'],
} as const satisfies Record<CompanyTemplateKey | 'empty', readonly Offer[]>;

const offersFor = (kit: CompanyTemplateKey | null): Offer[] => [...MENUS[kit ?? 'empty'], 'setUpPipeline', 'telegram', 'assistant'];

export function greetingOffers(kit: CompanyTemplateKey | null): string {
  return ['Ask what the person wants and give this short first-contact menu. Offer each item in their language and act on what they pick.', ...offersFor(kit).map(offer => `- ${WORDS[offer]}`)].join('\n');
}

const PATH = '/api/orchestrator/first-contact';
const request = z.object({ language: z.enum(['en', 'ru']), replyTo: z.uuid().optional() }).and(z.union([
  z.object({ offer: z.enum(Object.keys(WORDS) as Offer[]) }).transform(({ offer }) => ({ offer, text: WORDS[offer] })),
  z.object({ text: z.string().trim().min(1) }),
]));
const missing = () => new ApiError(404, 'not_found', 'There is no such conversation.');
const notReady = () => new ApiError(409, 'conflict', 'Connect a subscription for the orchestrator to start work.', 'orchestrator_not_ready');
const contactMessage = sql`${agentEvents.kind} = 'message' and ${agentEvents.data}->>'action' = ${FIRST_CONTACT_ACTION}`;

async function kitOf(ctx: Ctx, person: Person) {
  const [company] = await ctx.db.select(only(companies, 'template')).from(companies).where(eq(companies.id, person.companyId));
  return company?.template ?? null;
}

const ownContact = (me: Person) => and(eq(jobs.companyId, me.companyId), eq(jobs.createdBy, me.id), eq(jobs.kind, 'conversation'), exists(sql`
  (select 1 from ${agentEvents} where ${agentEvents.jobId} = ${jobs.id} and ${contactMessage})
`));

async function answerOf(ctx: Ctx, me: Person, id: string) {
  const [root] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(and(eq(jobs.id, id), ownContact(me)));
  if (!root) throw missing();
  const chain = [id];
  let status = root.status;
  while (status === 'failed' || status === 'done') {
    const next = await turnGoingOn(ctx, chain.at(-1)!);
    if (!next) break;
    const [row] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(and(eq(jobs.id, next.id), eq(jobs.companyId, me.companyId), eq(jobs.createdBy, me.id)));
    if (!row) break;
    chain.push(next.id);
    status = row.status;
  }
  const replies = await ctx.db.select({ text: sql<string | null>`${agentEvents.data}->>'text'` }).from(agentEvents)
    .where(and(inArray(agentEvents.jobId, chain), eq(agentEvents.kind, 'text'))).orderBy(asc(agentEvents.seq));
  return { status, replies: replies.flatMap(row => row.text ? [row.text] : []) };
}

async function lastContact(ctx: Ctx, me: Person) {
  const [last] = await ctx.db.select({ id: jobs.id, text: sql<string>`${agentEvents.data}->>'text'`, offer: sql<Offer | null>`${agentEvents.data}->>'offer'` })
    .from(jobs).innerJoin(agentEvents, and(eq(agentEvents.jobId, jobs.id), contactMessage))
    .where(and(eq(jobs.companyId, me.companyId), eq(jobs.createdBy, me.id))).orderBy(desc(jobs.createdAt)).limit(1);
  return last ? { ...last, answer: await answerOf(ctx, me, last.id) } : null;
}

export function firstContactRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get(PATH, async req => {
    const me = await requirePerson(req, ctx.db);
    const [kit, last] = await Promise.all([kitOf(ctx, me), lastContact(ctx, me)]);
    return { offers: offersFor(kit), ...(last ? { last } : {}) };
  });

  app.post(PATH, async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const input = request.parse(req.body);
    const agent = await orchestratorOf(ctx, me.companyId);
    if (!agent) throw missing();
    if ('offer' in input && !offersFor(await kitOf(ctx, me)).includes(input.offer)) throw new ApiError(400, 'validation', 'Choose an offer for your company.');
    const previous = input.replyTo ? await answerOf(ctx, me, input.replyTo) : null;
    const prompt = [
      `First contact with one person. Answer only the sender (person id ${me.id}). Reply in ${input.language === 'ru' ? 'Russian' : 'English'}.`,
      'Read the sender’s access in the company before sharing company information. Start the work requested and ask one question only when you need their answer.',
      ...('offer' in input && input.offer === 'setUpPipeline' ? ['Use the ready pipeline catalog. Ask what work they want to set up, then offer the closest pipeline and apply their choice.'] : []),
      ...(previous?.replies.length ? [`Your last answer to this person:\n${quote(previous.replies.join('\n'))}`] : []),
      turnPrompt({ name: me.name, title: me.title }, quote(input.text)),
    ].join('\n\n');
    const jobId = await onAgent(ctx, agent.id, async () => {
      try {
        return await insertTurn(ctx, { companyId: me.companyId, agentId: agent.id, createdBy: me.id, prompt, message: { personId: me.id, text: input.text, action: FIRST_CONTACT_ACTION, ...('offer' in input ? { offer: input.offer } : {}) } });
      } catch (err) {
        if (err instanceof NoSubscription) throw notReady();
        throw err;
      }
    });
    await pump(ctx, agent.id);
    return reply.code(202).send({ jobId });
  });

  app.get(`${PATH}/:id`, async req => {
    const me = await requirePerson(req, ctx.db);
    return answerOf(ctx, me, z.object({ id: z.uuid() }).parse(req.params).id);
  });
}
