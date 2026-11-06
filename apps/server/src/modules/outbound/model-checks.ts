import {
  CheckReceipt,
  ClassificationResult,
  ReviewInput,
  ReviewResult,
  canonicalJson,
  type CheckBinding,
  type CheckInput,
  type CheckReceipt as CheckReceiptDto,
  type CheckResult,
  type CheckUnavailable,
  type MessageDocument,
  type ModelCheckKind,
  type ModelIdentity,
  type ProviderId,
} from '@hornhoof/protocol';
import type { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import {
  agents,
  jobs,
  outboundCatalogRevisions,
  outboundChannels,
  outboundMessageRevisions,
  outboundMessages,
  outboundReviewReceipts,
  subscriptions,
} from '../../db/schema.js';
import { publicUrl } from '../link/link.js';
import { bindingDigest } from '../model-checks/lifecycle.js';
import type { RunModelCheck } from '../model-checks/run.js';
import { formatMoney, priceAfterDiscount } from './checks.js';
import { unsubscribeUrl } from './contacts.js';
import { recordReview } from './core.js';
import { OUTBOUND_CHECK_PROMPTS, activeCheckBinding, createEvaluationPort } from './evaluation-port.js';
import type { ModelCheckPorts, SealedPayload } from './ports.js';

type ReviewInputDto = z.infer<typeof ReviewInput>;
type ReviewFactDto = ReviewInputDto['facts'][number];

export type AuthorVendorHint = string | { readonly provider?: ProviderId | null; readonly vendorId: string };

export type FreshModelRequest = {
  readonly kind: ModelCheckKind;
  readonly expectedModel: ModelIdentity;
  readonly systemPrompt: string;
  readonly userPayload: string;
};

export type FreshModelResponse =
  | { readonly status: 'ok'; readonly reviewer: ModelIdentity; readonly rawOutput: string; readonly isolated: true }
  | { readonly status: 'unavailable' };

export type FreshModelInvoke = (request: FreshModelRequest) => Promise<FreshModelResponse>;

const PROVIDER_VENDOR: Record<ProviderId, string> = {
  claude: 'anthropic',
  anthropic_api: 'anthropic',
  codex: 'openai',
  openai_api: 'openai',
  kimi: 'moonshot',
  glm: 'zhipu',
  antigravity: 'google',
};

const VENDOR_FAMILIES: readonly [string, RegExp][] = [
  ['anthropic', /(?:^|[^a-z])(?:anthropic|claude)(?:$|[^a-z])/],
  ['openai', /(?:^|[^a-z])(?:openai|codex|gpt)(?:$|[^a-z])/],
  ['moonshot', /(?:^|[^a-z])(?:moonshot|kimi)(?:$|[^a-z])/],
  ['zhipu', /(?:^|[^a-z])(?:zhipu|glm)(?:$|[^a-z])/],
  ['google', /(?:^|[^a-z])(?:google|gemini|antigravity)(?:$|[^a-z])/],
];

const PLACEHOLDER_VENDORS = new Set(['', 'unknown', 'none', 'null', 'undefined', 'n/a']);

function canonicalDeclaredVendor(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (PLACEHOLDER_VENDORS.has(cleaned)) return null;
  const family = VENDOR_FAMILIES.find(([, pattern]) => pattern.test(cleaned));
  return family ? family[0] : cleaned;
}

export function resolveVendorSet(providerId: ProviderId | null, declaredVendorId: string): ReadonlySet<string> | null {
  const declared = canonicalDeclaredVendor(declaredVendorId);
  const fromProvider = providerId ? PROVIDER_VENDOR[providerId] : null;
  if (!declared && !fromProvider) return null;
  if (declared && fromProvider && declared !== fromProvider) return null;
  return new Set([declared ?? fromProvider!]);
}

export function areVendorsIndependent(
  authorProvider: ProviderId | null,
  authorVendorId: string,
  reviewer: ModelIdentity,
): boolean {
  const authorSet = resolveVendorSet(authorProvider, authorVendorId);
  const reviewerSet = resolveVendorSet(reviewer.providerId, reviewer.vendorId);
  if (!authorSet || !reviewerSet) return false;
  for (const vendor of authorSet) {
    if (reviewerSet.has(vendor)) return false;
  }
  return true;
}

function parseValidatedResult(input: CheckInput, rawOutput: string): CheckResult | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawOutput);
  } catch {
    return null;
  }
  if (input.kind !== 'support_classification') {
    const parsed = ReviewResult.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  }
  const parsed = ClassificationResult.safeParse(decoded);
  if (!parsed.success) return null;
  const entry = input.taxonomy.find(item => item.classId === parsed.data.classId);
  if (!entry || (entry.requiresHuman && !parsed.data.requiresHuman)) return null;
  return parsed.data;
}

const unavailable = (code: CheckUnavailable['code']): CheckUnavailable => ({ kind: 'unavailable', code });

function checkVendorForInput(binding: CheckBinding, input: CheckInput): boolean {
  if (input.kind === 'support_classification') return resolveVendorSet(binding.model.providerId, binding.model.vendorId) !== null;
  return areVendorsIndependent(null, input.authorVendorId, binding.model);
}

async function executeSingleModelCheck(
  invoke: FreshModelInvoke,
  binding: CheckBinding,
  input: CheckInput,
): Promise<CheckReceiptDto | CheckUnavailable> {
  if (binding.kind !== input.kind) return unavailable('invalid_output');
  if (!checkVendorForInput(binding, input)) return unavailable('vendor_conflict');
  let response: FreshModelResponse;
  try {
    response = await invoke({
      kind: binding.kind,
      expectedModel: binding.model,
      systemPrompt: OUTBOUND_CHECK_PROMPTS[binding.kind],
      userPayload: canonicalJson(input),
    });
  } catch {
    return unavailable('unavailable');
  }
  if (response.status !== 'ok' || response.isolated !== true) return unavailable('unavailable');
  if (canonicalJson(response.reviewer) !== canonicalJson(binding.model)) return unavailable('uncertified');
  const result = parseValidatedResult(input, response.rawOutput);
  if (!result) return unavailable('invalid_output');
  return CheckReceipt.parse({
    schemaVersion: 1,
    checkId: binding.checkId,
    bindingDigest: bindingDigest(binding),
    subjectDigest: input.subject.contentDigest,
    reviewer: response.reviewer,
    result,
  });
}

export function createEvaluatorModelRunner(invoke: FreshModelInvoke): RunModelCheck {
  return (binding, input) => executeSingleModelCheck(invoke, binding, input);
}

export function createLiveModelCheckRunner(deps: {
  getCertifiedCheck: ModelCheckPorts['getCertifiedCheck'];
  invoke: FreshModelInvoke;
}): RunModelCheck {
  return async (binding, input) => {
    if (!checkVendorForInput(binding, input)) return unavailable('vendor_conflict');
    const cert = await deps.getCertifiedCheck(binding);
    if (!cert || cert.status !== 'active') return unavailable('uncertified');
    return executeSingleModelCheck(deps.invoke, binding, input);
  };
}

export function createModelCheckPorts(
  ctx: Pick<Ctx, 'db'>,
  invoke: FreshModelInvoke,
  options?: { now?: () => Date },
): ModelCheckPorts {
  const evaluationPort = createEvaluationPort(ctx, options);
  const runModelCheck = createLiveModelCheckRunner({
    getCertifiedCheck: evaluationPort.getCertifiedCheck,
    invoke,
  });
  return {
    runModelCheck,
    ...evaluationPort,
  };
}

export async function reviewOutboundMessageRevision(
  ctx: Pick<Ctx, 'db'>,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  params: {
    companyId: string;
    messageId: string;
    messageRevision: number;
    binding: CheckBinding;
    input: ReviewInputDto;
  },
): Promise<CheckReceiptDto | CheckUnavailable> {
  const digest = bindingDigest(params.binding);
  const [existing] = await ctx.db
    .select()
    .from(outboundReviewReceipts)
    .where(
      and(
        eq(outboundReviewReceipts.messageId, params.messageId),
        eq(outboundReviewReceipts.messageRevision, params.messageRevision),
        eq(outboundReviewReceipts.bindingDigest, digest),
      ),
    );
  if (existing) {
    return {
      schemaVersion: 1,
      checkId: existing.checkId,
      bindingDigest: existing.bindingDigest,
      subjectDigest: existing.subjectDigest,
      reviewer: existing.reviewer,
      result: existing.result,
    };
  }
  const checked = await ports.runModelCheck(params.binding, params.input);
  if ('code' in checked) return checked;
  await ctx.db
    .insert(outboundReviewReceipts)
    .values({
      companyId: params.companyId,
      messageId: params.messageId,
      messageRevision: params.messageRevision,
      checkId: checked.checkId,
      bindingDigest: checked.bindingDigest,
      subjectDigest: checked.subjectDigest,
      reviewer: checked.reviewer,
      result: checked.result,
    })
    .onConflictDoNothing();
  return checked;
}

type CatalogRow = typeof outboundCatalogRevisions.$inferSelect;
type MessageRow = typeof outboundMessages.$inferSelect;
type RevisionRow = typeof outboundMessageRevisions.$inferSelect;
type ChannelRow = typeof outboundChannels.$inferSelect;

function resolveHintedVendor(hint: AuthorVendorHint): string {
  const provider = typeof hint === 'string' ? null : (hint.provider ?? null);
  const vendorId = typeof hint === 'string' ? hint : hint.vendorId;
  const set = resolveVendorSet(provider, vendorId);
  return set ? [...set][0]! : 'unknown';
}

async function resolveStoredAuthorVendor(db: Pick<Db, 'select'>, message: MessageRow): Promise<string> {
  const [[agent], [job]] = await Promise.all([
    db.select({ model: agents.model, subscriptionId: agents.subscriptionId }).from(agents).where(eq(agents.id, message.authorAgentId)),
    message.authorJobId
      ? db.select({ subscriptionId: jobs.subscriptionId }).from(jobs).where(eq(jobs.id, message.authorJobId))
      : Promise.resolve([]),
  ]);
  const subId = job?.subscriptionId ?? agent?.subscriptionId ?? null;
  const [sub] = subId
    ? await db.select({ provider: subscriptions.provider }).from(subscriptions).where(eq(subscriptions.id, subId))
    : [];
  const set = resolveVendorSet(sub?.provider ?? null, agent?.model ?? '');
  return set ? [...set][0]! : 'unknown';
}

function canonicalFactValue(row: CatalogRow, rows: readonly CatalogRow[], locale: string): string | null {
  if (row.value.kind === 'link') return row.value.url;
  if (row.value.kind === 'claim' || row.value.kind === 'knowledge') return row.value.text;
  if (row.value.kind !== 'price') return null;
  const price = row.value;
  const discountRow = price.discountId ? rows.find(r => r.entryId === price.discountId && r.value.kind === 'discount') : undefined;
  const discount = discountRow && discountRow.value.kind === 'discount' ? discountRow.value : null;
  const money = priceAfterDiscount(price, discount);
  return money ? formatMoney(money, locale) : `${price.amount} ${price.currency}`;
}

async function buildQueuedFacts(db: Pick<Db, 'select'>, companyId: string, document: MessageDocument): Promise<ReviewFactDto[]> {
  if (document.blocks.length === 0) return [];
  const blockIds = document.blocks.map(b => b.id);
  const blockRows = await db
    .select()
    .from(outboundCatalogRevisions)
    .where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, blockIds)));
  const discountIds = blockRows.flatMap(r => (r.value.kind === 'price' && r.value.discountId ? [r.value.discountId] : []));
  const discountRows = discountIds.length
    ? await db
        .select()
        .from(outboundCatalogRevisions)
        .where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, discountIds)))
    : [];
  const allRows = [...blockRows, ...discountRows];
  const facts: ReviewFactDto[] = [];
  for (const block of document.blocks) {
    const row = blockRows.find(r => r.entryId === block.id && r.revision === block.revision);
    const canonicalValue = row ? canonicalFactValue(row, allRows, document.locale) : null;
    if (row && canonicalValue !== null) {
      facts.push({ kind: block.kind, id: row.entryId, revision: row.revision, canonicalValue, sourceId: row.id });
    }
  }
  return facts;
}

async function unsealForReview(
  ctx: Ctx,
  message: MessageRow,
  revision: RevisionRow,
  channel: ChannelRow,
): Promise<{ subject: string | null; body: string }> {
  const sealed = JSON.parse(decryptSecret(revision.sealedEnc, ctx.config.secret)) as SealedPayload;
  const stop = message.contactId
    ? unsubscribeUrl(await publicUrl(ctx.db, ctx.config), ctx.config.secret, {
        companyId: channel.companyId,
        contactId: message.contactId,
        channelId: channel.id,
        purpose: channel.purpose,
      })
    : null;
  const body = stop ? sealed.text.split(stop).join('[unsubscribe link]') : sealed.text;
  return { subject: sealed.subject, body };
}

export async function reviewQueuedMessage(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  messageId: string,
  now: Date = new Date(),
  authorVendor?: AuthorVendorHint,
): Promise<CheckReceiptDto | CheckUnavailable | null> {
  const [message] = await ctx.db.select().from(outboundMessages).where(eq(outboundMessages.id, messageId));
  if (!message || message.status !== 'waiting_checks') return null;
  const [[revision], [channel]] = await Promise.all([
    ctx.db
      .select()
      .from(outboundMessageRevisions)
      .where(and(eq(outboundMessageRevisions.messageId, message.id), eq(outboundMessageRevisions.revision, message.revision))),
    ctx.db.select().from(outboundChannels).where(eq(outboundChannels.id, message.channelId)),
  ]);
  if (!revision || !channel) return null;

  const kind = message.targetKind === 'ticket' ? ('support_reply_review' as const) : ('outbound_review' as const);
  const active = await activeCheckBinding(
    ctx.db,
    { companyId: channel.companyId, departmentId: channel.departmentId, productId: channel.productId, kind },
    now,
  );
  if (!active) return unavailable('uncertified');

  const [unsealed, facts, authorVendorId] = await Promise.all([
    unsealForReview(ctx, message, revision, channel),
    buildQueuedFacts(ctx.db, message.companyId, revision.document),
    authorVendor ? Promise.resolve(resolveHintedVendor(authorVendor)) : resolveStoredAuthorVendor(ctx.db, message),
  ]);
  const input = ReviewInput.parse({
    schemaVersion: 1,
    kind,
    locale: revision.document.locale,
    subject: { id: message.id, contentDigest: revision.contentDigest },
    message: unsealed,
    facts,
    policyDigest: revision.policyDigest,
    authorVendorId,
  });
  const checked = await ports.runModelCheck(active.binding, input);
  if ('code' in checked) return checked;
  await recordReview(
    ctx,
    {
      messageId: message.id,
      revision: revision.revision,
      checkId: checked.checkId,
      bindingDigest: checked.bindingDigest,
      subjectDigest: checked.subjectDigest,
      reviewer: checked.reviewer,
      result: checked.result,
    },
    now,
  );
  return checked;
}
