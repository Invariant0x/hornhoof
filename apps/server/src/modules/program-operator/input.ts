import { OperatorDelivery, type OperatorDelivery as Delivery } from '@hornhoof/protocol/program-operator';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentEvents, programDeliveries } from '../../db/schema.js';
import { only } from '../../db/selections.js';

type Attempt = { delivery: Delivery; jobId: string; digest: string };
const live = new WeakMap<object, Map<string, Attempt>>();
const object = (data: unknown): data is object => data !== null && typeof data === 'object';

/* A shared message can go to several panel members; each recipient keeps its own delivery identity. */
export function rememberLiveInput(data: unknown, agentId: string, attempt: Attempt): void {
  if (!object(data)) return;
  const recipients = live.get(data) ?? new Map<string, Attempt>();
  recipients.set(agentId, attempt);
  live.set(data, recipients);
}

export function liveInputOf(data: unknown, agentId: string): Attempt | undefined {
  return object(data) ? live.get(data)?.get(agentId) : undefined;
}

export async function sourceDeliveryForJob(db: Db, agentId: string, jobId: string): Promise<string | undefined> {
  return (await sourceDeliveryMetadataForJob(db, agentId, jobId))?.id;
}

export async function sourceDeliveryMetadataForJob(db: Db, agentId: string, jobId: string): Promise<Delivery | undefined> {
  const [event] = await db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.jobId, jobId), sql`${agentEvents.data}->'operatorDelivery' is not null`)).orderBy(asc(agentEvents.seq)).limit(1);
  const value = event?.data as { operatorDelivery?: unknown } | undefined;
  const parsed = OperatorDelivery.safeParse(value?.operatorDelivery);
  if (!parsed.success) return;
  const [source] = await db.select({ id: programDeliveries.id, ordinal: programDeliveries.ordinal }).from(programDeliveries).where(and(eq(programDeliveries.id, parsed.data.id), eq(programDeliveries.agentId, agentId), eq(programDeliveries.ordinal, parsed.data.ordinal)));
  return source;
}
