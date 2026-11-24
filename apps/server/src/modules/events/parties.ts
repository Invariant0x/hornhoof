import { NotificationSchema } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, departments, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { deptName } from '../departments/templates.js';

const LangText = z.object({ en: z.string(), ru: z.string() });
export const PartySchema = z.object({
  kind: z.enum(['person', 'agent', 'hornhoof']), id: z.string().nullable(), name: z.string(),
  role: LangText.nullable(), department: z.object({ id: z.string(), name: LangText }).nullable(),
  agentKind: z.enum(['orchestrator', 'head', 'worker', 'assistant']).optional(),
});
const Party = PartySchema;
/* channel: the way a person's message came when not from the agent's window. assistant: the person's assistant that wrote it
   for them. */
export const MessageEnvelopeSchema = z.object({ direction: z.enum(['in', 'out']), from: Party, to: Party, notification: NotificationSchema.optional(), senders: z.array(Party).optional(), revision: z.number().int().nonnegative().optional(), originSeq: z.number().int().positive().optional(), channel: z.enum(['telegram', 'assistant']).optional(), assistant: z.object({ id: z.string(), name: z.string() }).optional() });
export type MessageParty = z.infer<typeof Party>;
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
type PartyContext = Pick<Ctx, 'db' | 'templates'>;

export const HORNHOOF: MessageParty = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null };

const DEPARTMENT_RU = {
  operations: 'Операции', development: 'Разработка', marketing: 'Маркетинг', sales: 'Продажи',
  business_development: 'Развитие бизнеса', design: 'Дизайн', support: 'Поддержка', finance: 'Финансы',
  home_devices: 'Домашние устройства', household: 'Домашнее хозяйство',
  video_production: 'Производство видео',
};

export async function agentParty(ctx: PartyContext, companyId: string, agentId: string): Promise<MessageParty> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (!agent) throw new Error('The message agent does not exist in this company.');
  return { kind: 'agent', id: agent.id, name: agent.name, role: agentRole(ctx, agent), department: await agentDepartment(ctx, agent.departmentId), agentKind: agent.kind };
}

export function agentRole(ctx: Pick<PartyContext, 'templates'>, agent: Pick<typeof agents.$inferSelect, 'kind' | 'roleKey'>) {
  return agent.kind === 'orchestrator' ? { en: 'Orchestrator', ru: 'Оркестратор' } : ctx.templates.roles.get(agent.roleKey ?? '')?.title ?? null;
}

/* A department as a message names it, in both languages. */
export const departmentParty = (dept: typeof departments.$inferSelect): NonNullable<MessageParty['department']> => ({
  id: dept.id,
  name: { en: deptName(dept), ru: dept.name ?? (dept.templateKey ? DEPARTMENT_RU[dept.templateKey] : '') },
});

async function agentDepartment(ctx: PartyContext, id: string | null): Promise<MessageParty['department']> {
  if (!id) return null;
  const [dept] = await ctx.db.select().from(departments).where(eq(departments.id, id));
  return dept ? departmentParty(dept) : null;
}

export async function personParty(ctx: PartyContext, companyId: string, personId: string): Promise<MessageParty> {
  const [person] = await ctx.db.select().from(people).where(and(eq(people.id, personId), eq(people.companyId, companyId)));
  if (!person) throw new Error('The message person does not exist in this company.');
  return { kind: 'person', id: person.id, name: person.name, role: person.title ? { en: person.title, ru: person.title } : null, department: null };
}

const field = (data: unknown, key: string): unknown => data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined;

const AssistantMark = z.object({ id: z.string(), name: z.string() });

/* The way a person's message came, as Hornhoof kept it with the message: Telegram, or the person's assistant. */
function channelOf(data: unknown): Pick<MessageEnvelope, 'channel' | 'assistant'> {
  if (field(data, 'channel') === 'telegram') return { channel: 'telegram' };
  const assistant = AssistantMark.safeParse(field(data, 'assistant'));
  if (field(data, 'channel') === 'assistant' && assistant.success) return { channel: 'assistant', assistant: { id: assistant.data.id, name: assistant.data.name } };
  return {};
}

/* Sender identity comes from stored ids and authenticated callers, never from the words of the message. */
export async function incomingEnvelope(ctx: PartyContext, companyId: string, agentId: string, personId: string | null | undefined, data: unknown): Promise<MessageEnvelope> {
  const to = await agentParty(ctx, companyId, agentId);
  const notice = field(data, 'notification');
  if (notice !== undefined) return noticeEnvelope(data, to);
  if (personId) return { direction: 'in', from: await personParty(ctx, companyId, personId), to, ...channelOf(data) };
  const by = field(data, 'by');
  if (field(data, 'from') === 'agent' && typeof by === 'string') return { direction: 'in', from: await agentParty(ctx, companyId, by), to };
  if (field(data, 'from') === 'orchestrator') {
    const [agent] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
    if (agent) return { direction: 'in', from: await agentParty(ctx, companyId, agent.id), to };
  }
  return { direction: 'in', from: HORNHOOF, to, notification: { source: 'service', tasks: [] } };
}

function noticeEnvelope(data: unknown, to: MessageParty): MessageEnvelope {
  const notification = NotificationSchema.parse(field(data, 'notification'));
  const actor = Party.optional().parse(field(data, 'actor'));
  const senders = z.array(Party).optional().parse(field(data, 'senders'));
  return { direction: 'in', from: actor ?? HORNHOOF, to, notification, ...(senders ? { senders } : {}) };
}

/* The envelope is kept in the existing JSON payload; old rows and their data stay unchanged. */
export function messageData(data: unknown, message: MessageEnvelope): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('A message needs an object payload.');
  return { ...data, _message: message };
}

export function readMessage(data: unknown): { data: unknown; message?: MessageEnvelope } {
  const parsed = MessageEnvelopeSchema.safeParse(field(data, '_message'));
  if (!parsed.success) return { data: withoutFresh(data) };
  /* The envelope is not the message's payload. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the envelope from the payload
  const { _message, ...body } = withoutFresh(data) as Record<string, unknown>;
  return { data: body, message: parsed.data };
}

/* The conversation an assistant's program sent for a new session waits for its turn only: whatever reads the message, with
   or without its envelope, never gets it. */
function withoutFresh(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('_fresh' in data)) return data;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the fresh conversation from the payload
  const { _fresh, ...body } = data as Record<string, unknown>;
  return body;
}
