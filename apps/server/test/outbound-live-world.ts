import type { OutboundSubmit } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../src/crypto/secrets.js';
import { outboundMessageRevisions } from '../src/db/schema.js';
import type { Senders } from '../src/modules/outbound/dispatcher.js';
import type { SealedPayload } from '../src/modules/outbound/ports.js';
import { smtpAdapter } from '../src/modules/outbound/smtp.js';
import { webhookAdapter } from '../src/modules/outbound/webhook.js';
import { as } from './helpers.js';
import { CERT, PASSWORD, USERNAME } from './outbound-receivers.js';
import { aChannelOf, aPermissionOf, aPolicyOf, documentOf, partsOf, type World } from './outbound-world.js';

/* The way an owner really sets a sending account up and an author really sends, against control receivers on this machine,
   with synthetic secrets. Nothing here reaches anyone else. */
export const EVENT_KEY = `${PASSWORD}-events-0123456789abcdef`;
export const SIGNING_KEY = `${PASSWORD}-signing-0123456789abcdef`;
export const FROM = 'sender@acme.test';

/* The receivers listen on this machine, which a real sender may not reach: only the test lets it. */
const onThisMachine = (address: string) => address === '127.0.0.1' || address === '::1';
export const liveSenders = (given: Partial<Senders> = {}): Senders => ({ smtp: smtpAdapter(), webhook: webhookAdapter({ mayReach: onThisMachine, timeoutMs: 2000 }), deadlineMs: 10_000, ...given });

export const smtpSettings = (port: number, more: object = {}) => ({ host: 'localhost', port, security: 'tls', username: USERNAME, password: PASSWORD, from: FROM, eventKey: EVENT_KEY, ca: CERT, ...more });
export const hookSettings = (endpoint: string, more: object = {}) => ({ endpoint, signingKey: SIGNING_KEY, ca: CERT, ...more });

const askOwner = async (w: World, url: string, payload: object) => {
  const answer = await w.c.app.inject({ method: 'POST', url, payload, ...as(w.c.ceoToken) });
  if (answer.statusCode !== 200) throw new Error(`${url} answered ${answer.statusCode}: ${answer.body}`);
  return answer.json() as Record<string, unknown>;
};

/* The world's author moved by the owner to a new account of a channel, as an owner does it. */
export async function onNewAccount(w: World, channelId: string, config: object, label = 'Live') {
  await askOwner(w, `/api/outbound/accounts/${w.account.id}/release`, {});
  const accountId = (await askOwner(w, '/api/outbound/accounts', { channelId, label, config }))['accountId'] as string;
  await askOwner(w, `/api/outbound/accounts/${accountId}/bind`, { agentId: w.c.worker.id });
  return accountId;
}

export const rotateTo = (w: World, accountId: string, config: object) => askOwner(w, `/api/outbound/accounts/${accountId}/rotate`, { config });
export const settleAs = (w: World, attemptId: string, outcome: string) => askOwner(w, `/api/outbound/attempts/${attemptId}/settle`, { outcome, evidence: 'Asked the provider.' });

/* What an author submits with once its account changed. */
export const onAccount = (w: World, accountId: string, change: Partial<OutboundSubmit> = {}): OutboundSubmit => w.input({ accountId, bindingGeneration: 1, ...change });

export async function smtpWay(w: World, port: number, more: object = {}) {
  const accountId = await onNewAccount(w, w.channel.id, smtpSettings(port, more));
  return { accountId, input: (change: Partial<OutboundSubmit> = {}) => onAccount(w, accountId, change) };
}

/* A channel of its own: an endpoint is one more way out, with its own words, consent and limits. */
export async function hookWay(w: World, endpoint: string, more: object = {}) {
  const channel = await aChannelOf(w.c, { name: 'Hook', adapter: 'webhook' });
  await aPolicyOf(w.c, channel.id);
  await aPermissionOf(w.c, w.contact.id, channel.id);
  const parts = await partsOf(w.c, channel.id);
  const accountId = await onNewAccount(w, channel.id, hookSettings(endpoint, more), 'Hook');
  return { channelId: channel.id, accountId, input: (change: Partial<OutboundSubmit> = {}) => onAccount(w, accountId, { channelId: channel.id, segmentId: parts.segment.entryId, document: documentOf(parts), ...change }) };
}

/* An author's tools, as a running turn has them. */
export async function submitByTool(w: World, input: OutboundSubmit): Promise<{ messageId: string; status: string }> {
  const tools = await w.c.tools(w.c.worker);
  const said = (await tools.callTool({ name: 'outbound_submit', arguments: input })) as { content: { text: string }[]; isError?: boolean };
  if (said.isError) throw new Error(said.content[0]!.text);
  return JSON.parse(said.content[0]!.text) as { messageId: string; status: string };
}

/* The words frozen when the message was admitted. */
export async function frozenOf(w: World, messageId: string): Promise<SealedPayload> {
  const [revision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, messageId));
  return JSON.parse(decryptSecret(revision!.sealedEnc, w.ctx.config.secret)) as SealedPayload;
}
