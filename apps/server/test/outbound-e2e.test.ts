import { randomUUID } from 'node:crypto';
import type { Case, CheckInput, ModelCheckKind, ModelIdentity, OutboundPolicyValue } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { modelCheckCertificates, modelChecks, outboundApprovals, outboundChannels, subscriptions } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { FRESH_INFERENCE_HASH } from '../src/modules/jobs/dispatch.js';
import { saveDataset, saveThresholds } from '../src/modules/model-checks/store.js';
import { OUTBOUND_CHECK_PROMPTS, syncOutboundCheckDefinition } from '../src/modules/outbound/evaluation-port.js';
import { as } from './helpers.js';
import { AUTHOR, LABELLER, SET, asJsonl, classCase, hashOf } from './model-check-fixture.js';
import { closeKept, EVENT_KEY, frozenOf, keep, rotateTo, SIGNING_KEY, smtpSettings, smtpWay, submitByTool } from './outbound-live-world.js';
import { PASSWORD, smtpReceiver, vendorApi, vendorJson, wordsOf, type VendorAnswer, type VendorCall } from './outbound-receivers.js';
import { supportWorld, type SupportWorld } from './outbound-support-world.js';
import { aKeyOf, QUIET, world, type World } from './outbound-world.js';

/* The whole of the gates on one running server, by its own minute: an agent's tools, the kernel, a fresh model of another vendor,
   the dispatcher and real SMTP. A control server stands in for the vendor's API, and only the definition of a check is set by a
   direct call, as no route sets one yet. Synthetic secrets, and nothing leaves this machine. */
afterEach(closeKept);

const MODEL_KEY = 'synthetic-model-key-e2e-4f1c';
const GPT: ModelIdentity = { providerId: 'openai_api', vendorId: 'openai', modelId: 'gpt-check', revisionId: 'gpt-check-2026-01-01', inferenceConfigHash: FRESH_INFERENCE_HASH };
const CLAUDE: ModelIdentity = { providerId: 'anthropic_api', vendorId: 'anthropic', modelId: 'claude-check', revisionId: 'claude-check-2026', inferenceConfigHash: FRESH_INFERENCE_HASH };
const LIMITS = { falseAllowRate: 0, falseDenyRate: 0.25, classErrorRate: 0 };
/* Every first message of an author goes to a check. */
const CHECK_FIRST: OutboundPolicyValue = { ...QUIET, sampling: { ...QUIET.sampling, firstPerAuthor: 100 } };

type Result = { kind: 'review'; decision: string; reasonCodes: string[] } | { kind: 'classification'; classId: string; requiresHuman: boolean; reasonCodes: string[] };
const ALLOW: Result = { kind: 'review', decision: 'allow', reasonCodes: [] };
const BLOCK: Result = { kind: 'review', decision: 'block', reasonCodes: ['forbidden_content'] };

const asLabelled = (row: Case): Result => ('decision' in row.expected
  ? { kind: 'review', decision: row.expected.decision, reasonCodes: row.expected.decision === 'allow' ? [] : ['uncertain'] }
  : { kind: 'classification', classId: row.expected.classId, requiresHuman: row.expected.requiresHuman, reasonCodes: [] });

const inputOf = (call: VendorCall) => JSON.parse((call.body['messages'] as { content: string }[]).at(-1)!.content) as CheckInput;

/* The vendor's API: it answers the examples of a check as they are labelled, or as a test says, and anything else as the test says. */
type Says = { live: (input: CheckInput) => Result; examples?: (row: Case) => Result };
function theVendor(model: ModelIdentity, rows: Case[], says: Says): VendorAnswer {
  const examples = new Map(rows.map(row => [row.input.subject.id, row]));
  return (response, call) => {
    const input = inputOf(call);
    const row = examples.get(input.subject.id);
    const content = JSON.stringify(row ? (says.examples ?? asLabelled)(row) : says.live(input));
    vendorJson(200, model.providerId === 'openai_api'
      ? { model: model.revisionId, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
      : { model: model.revisionId, content: [{ type: 'text', text: content }], stop_reason: 'end_turn' })(response, call);
  };
}

type Place = { c: Pick<World['c'], 'db' | 'companyId' | 'app' | 'ids'>; ctx: World['ctx'] };
type Checked = { kind: ModelCheckKind; departmentId: string; rows: Case[]; taxonomyHash?: string | null };

const minuteOf = (ctx: World['ctx']) => async (at: Date = new Date()) => {
  const failures: string[] = [];
  await minuteRound(ctx, at, what => () => failures.push(what));
  expect(failures).toEqual([]);
};

/* Puts a check in place as a person would, and lets the server's own minute run its examples through the real port. */
async function aCheck(w: Place, { kind, departmentId, rows, taxonomyHash = null }: Checked, model: ModelIdentity): Promise<void> {
  const place = { companyId: w.c.companyId, departmentId, productId: null, kind };
  const now = new Date();
  await syncOutboundCheckDefinition(w.ctx, place, { sourceListHash: hashOf('sources'), taxonomyHash, model, author: AUTHOR, now });
  await saveDataset(w.ctx, place, asJsonl(rows), LABELLER, now);
  await saveThresholds(w.ctx, place, w.c.ids.ceo, LIMITS, now);
  await minuteOf(w.ctx)();
}

async function checkedWorld(options: { model?: ModelIdentity; asked?: (row: Case) => Result } = {}) {
  const model = options.model ?? GPT;
  const w = await world(CHECK_FIRST);
  await aKeyOf(w.c, 'openai_api', MODEL_KEY);
  const rows = SET();
  const say: Says = { live: () => ALLOW, ...(options.asked ? { examples: options.asked } : {}) };
  const api = keep(await vendorApi(theVendor(model, rows, say)));
  w.ctx.vendorUrls = { openai_api: api.url, anthropic_api: api.url };
  await aCheck(w, { kind: 'outbound_review', departmentId: w.c.dev.id, rows }, model);
  const liveCalls = () => api.heard.filter(call => !rows.some(row => row.input.subject.id === inputOf(call).subject.id));
  return { w, say, liveCalls, minute: minuteOf(w.ctx), checks: () => w.c.db.select().from(modelChecks), certificates: () => w.c.db.select().from(modelCheckCertificates) };
}

const LATER = () => new Date(Date.now() + 6 * 60_000);

describe('a message chosen for a check', () => {
  it('leaves once, by the server\'s own minute, after a fresh model of another vendor allowed exactly its words', async () => {
    const { w, liveCalls, minute, certificates } = await checkedWorld();
    expect(await certificates()).toHaveLength(1);
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const { messageId, status } = await submitByTool(w, input());
    expect(status).toBe('waiting_checks');
    await minute();
    await minute(LATER());
    await minute(LATER());
    expect(server.seen.messages).toHaveLength(1);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
    expect(liveCalls()).toHaveLength(1);
    const [call] = liveCalls();
    expect(call!.headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
    expect(call!.body).toEqual({ model: GPT.modelId, max_completion_tokens: 1024, temperature: 0, messages: [{ role: 'system', content: OUTBOUND_CHECK_PROMPTS.outbound_review }, { role: 'user', content: expect.any(String) }] });
    const frozen = await frozenOf(w, messageId);
    expect(inputOf(call!)).toMatchObject({ kind: 'outbound_review', authorVendorId: 'anthropic', subject: { id: messageId } });
    expect((inputOf(call!) as { message: { subject: string } }).message.subject).toBe(frozen.subject);
    expect(wordsOf(server.seen.messages[0]!.raw).trimEnd()).toBe(frozen.text.trimEnd());
  });

  it('shows the model no secret of the server and no address of the customer', async () => {
    const { w, liveCalls, minute } = await checkedWorld();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port, { eventKey: EVENT_KEY });
    await submitByTool(w, input());
    await minute();
    const said = JSON.stringify(liveCalls().map(call => call.body));
    expect(said).not.toBe('[]');
    for (const secret of [PASSWORD, EVENT_KEY, SIGNING_KEY, MODEL_KEY, 'ann@shop.example', w.ctx.config.secret.toString('base64')]) expect(said).not.toContain(secret);
  });

  it('never leaves when the model blocks it, and the channel stops', async () => {
    const { w, say, liveCalls, minute } = await checkedWorld();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    say.live = () => BLOCK;
    const { messageId } = await submitByTool(w, input());
    await minute();
    await minute(LATER());
    expect(server.seen.messages).toEqual([]);
    expect(liveCalls()).toHaveLength(1);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'rejected', reasonCodes: ['review_failed'] });
    const [channel] = await w.c.db.select().from(outboundChannels).where(eq(outboundChannels.id, w.channel.id));
    expect(channel).toMatchObject({ status: 'stopped', stoppedReason: 'review_failed' });
  });

  it('waits with no API key, asks nobody, and goes on once one comes', async () => {
    const { w, liveCalls, minute } = await checkedWorld();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    await w.c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.provider, 'openai_api'));
    const { messageId } = await submitByTool(w, input());
    await minute();
    await minute(LATER());
    expect(liveCalls()).toEqual([]);
    expect(server.seen.messages).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_checks' });
    await aKeyOf(w.c, 'openai_api', MODEL_KEY);
    await minute(LATER());
    await minute(LATER());
    expect(liveCalls()).toHaveLength(1);
    expect(server.seen.messages).toHaveLength(1);
  });

  it('waits rather than ask a model of the author\'s own vendor', async () => {
    const { w, liveCalls, minute } = await checkedWorld({ model: CLAUDE });
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const { messageId } = await submitByTool(w, input());
    await minute();
    await minute(LATER());
    expect(liveCalls()).toEqual([]);
    expect(server.seen.messages).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_checks' });
  });

  it('waits when the check did not pass its examples, with no certificate and no model asked', async () => {
    const { w, liveCalls, minute, certificates, checks } = await checkedWorld({ asked: () => ALLOW });
    expect(await certificates()).toEqual([]);
    expect((await checks())[0]).toMatchObject({ status: 'off' });
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const { messageId } = await submitByTool(w, input());
    await minute();
    await minute(LATER());
    expect(liveCalls()).toEqual([]);
    expect(server.seen.messages).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_checks' });
  });
});

describe('the people screen of a running server', () => {
  it('shows channels and messages to a person and no setting of an account', async () => {
    const { w, minute } = await checkedWorld();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    await submitByTool(w, input());
    await minute();
    const seen = await w.c.app.inject({ method: 'GET', url: '/api/outbound', ...as(w.c.ceoToken) });
    expect(seen.statusCode).toBe(200);
    expect(seen.json<{ channels: unknown[] }>().channels.length).toBeGreaterThan(0);
    expect(seen.body).not.toContain(PASSWORD);
    expect((await w.c.app.inject({ method: 'GET', url: '/api/outbound' })).statusCode).toBe(401);
  });
});

const asReplyReview = (row: Case): Case => ({ ...row, kind: 'support_reply_review', input: { ...row.input, kind: 'support_reply_review' } as Case['input'] });
const REFUND = { expected: { classId: 'refund', requiresHuman: true }, mustBlock: true };

/* A department with both of its checks passed on a server of its own. */
async function answeringDesk(classified: { classId: string; requiresHuman: boolean }) {
  const w = await supportWorld();
  await aKeyOf(w.c, 'openai_api', MODEL_KEY);
  const reviews = SET().map(asReplyReview);
  const classes = [classCase(), classCase({ split: 'holdout' }), classCase(REFUND), classCase({ ...REFUND, split: 'holdout' })];
  const live = (input: CheckInput): Result => (input.kind === 'support_classification' ? { kind: 'classification', ...classified, reasonCodes: classified.requiresHuman ? ['requires_human'] : [] } : ALLOW);
  const api = keep(await vendorApi(theVendor(GPT, [...reviews, ...classes], { live })));
  const ctx = w.c.app.ctx;
  ctx.vendorUrls = { openai_api: api.url };
  await aCheck({ c: w.c, ctx }, { kind: 'support_classification', departmentId: w.c.sales.id, rows: classes, taxonomyHash: w.taxonomy.digest }, GPT);
  await aCheck({ c: w.c, ctx }, { kind: 'support_reply_review', departmentId: w.c.sales.id, rows: reviews }, GPT);
  return { w, api, minute: minuteOf(ctx) };
}

const onItsOwnMail = async (w: SupportWorld) => {
  const server = keep(await smtpReceiver({ secure: true }));
  await rotateTo(w, w.account.id, smtpSettings(server.port, { from: 'help@support.acme.example' }));
  return server;
};

const said = async (tools: Awaited<ReturnType<World['c']['tools']>>, name: string, args: object) => {
  const answer = (await tools.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
  if (answer.isError) throw new Error(answer.content[0]!.text);
  return JSON.parse(answer.content[0]!.text) as Record<string, string>;
};

describe('a reply to a ticket through an agent\'s tools', () => {
  it('is classified on its own, reviewed by another vendor and sent once in the customer\'s words of the catalog', async () => {
    const { w, api, minute } = await answeringDesk({ classId: 'how_to', requiresHuman: false });
    const server = await onItsOwnMail(w);
    const ticket = await w.addTicket('How do I reset my password?');
    const tools = await w.c.tools(w.c.seller);
    const classified = await said(tools, 'support_classify', { task: w.taskId, idempotencyKey: randomUUID(), ticketId: ticket.ticketId, ticketRevision: 1 });
    expect(classified['status']).toBe('ready');
    const submitted = await said(tools, 'support_submit', {
      task: w.taskId, idempotencyKey: randomUUID(), channelId: w.channel.id, accountId: w.account.id, bindingGeneration: 1,
      ticketId: ticket.ticketId, ticketRevision: 1, classificationReceiptId: classified['classificationReceiptId'],
      document: w.documentEn, scheduledAt: '2026-01-02T00:00:00.000Z',
    });
    /* It names no money, so no limit covers it and a person lets these very bytes go. */
    expect(submitted['status']).toBe('waiting_approval');
    await minute(LATER());
    expect(server.seen.messages).toEqual([]);
    const [approval] = await w.c.db.select().from(outboundApprovals).where(eq(outboundApprovals.messageId, submitted['messageId']!));
    expect((await w.c.app.inject({ method: 'POST', url: `/api/requests/${approval!.requestId}`, payload: { approve: true }, ...as(w.c.samToken) })).statusCode).toBe(200);
    await minute(LATER());
    await minute(LATER());
    expect(server.seen.messages).toHaveLength(1);
    expect(wordsOf(server.seen.messages[0]!.raw)).toContain('Open Settings and press Reset password');
    const askedAbout = api.heard.map(call => inputOf(call).kind);
    expect(askedAbout).toContain('support_classification');
    expect(askedAbout).toContain('support_reply_review');
    expect(JSON.stringify(api.heard.map(call => call.body))).not.toContain(PASSWORD);
  });

  it('goes to a person, not out, when the class says so', async () => {
    const { w, minute } = await answeringDesk({ classId: 'refund_request', requiresHuman: true });
    const server = await onItsOwnMail(w);
    const ticket = await w.addTicket('Please refund my last invoice.');
    const tools = await w.c.tools(w.c.seller);
    const classified = await said(tools, 'support_classify', { task: w.taskId, idempotencyKey: randomUUID(), ticketId: ticket.ticketId, ticketRevision: 1 });
    const submitted = await said(tools, 'support_submit', {
      task: w.taskId, idempotencyKey: randomUUID(), channelId: w.channel.id, accountId: w.account.id, bindingGeneration: 1,
      ticketId: ticket.ticketId, ticketRevision: 1, classificationReceiptId: classified['classificationReceiptId'],
      document: w.documentEn, scheduledAt: '2026-01-02T00:00:00.000Z',
    });
    expect(submitted['status']).toBe('waiting_approval');
    await minute(LATER());
    expect(server.seen.messages).toEqual([]);
  });

  it('says a refusal as an answer to the author, not as a failure of the tool', async () => {
    const { w } = await answeringDesk({ classId: 'how_to', requiresHuman: false });
    const ticket = await w.addTicket('How do I reset my password?');
    const tools = await w.c.tools(w.c.seller);
    const key = randomUUID();
    await said(tools, 'support_classify', { task: w.taskId, idempotencyKey: key, ticketId: ticket.ticketId, ticketRevision: 1 });
    const other = await w.addTicket('Where is the button?');
    const refused = (await tools.callTool({ name: 'support_classify', arguments: { task: w.taskId, idempotencyKey: key, ticketId: other.ticketId, ticketRevision: 1 } })) as { content: { text: string }[]; isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('idempotency_conflict');
  });
});
