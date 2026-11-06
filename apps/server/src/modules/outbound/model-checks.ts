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
  type ModelCheckKind,
  type ModelIdentity,
  type ProviderId,
} from '@hornhoof/protocol';
import type { z } from 'zod';

type ReviewInputDto = z.infer<typeof ReviewInput>;
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { outboundReviewReceipts } from '../../db/schema.js';
import { bindingDigest } from '../model-checks/lifecycle.js';
import type { RunModelCheck } from '../model-checks/run.js';
import { OUTBOUND_CHECK_PROMPTS, createEvaluationPort } from './evaluation-port.js';
import type { ModelCheckPorts } from './ports.js';

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
