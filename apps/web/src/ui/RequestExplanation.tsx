import { useT, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { WaitingRequest } from '../types';
import { Markdown } from './Markdown';

export type HumanActionKind = 'payment' | 'owner_login' | 'manual_machine_action' | 'ceo_permission';

export type ActionBindingView = {
  kind: HumanActionKind;
  resourceId: string | null;
  scope: string | null;
  duration: string | null;
  amount: string | null;
};

export type HumanOptionView = {
  label: string;
  image: string | null;
  consequence: string | null;
};

export type PlainEnvelopeView = {
  classified: boolean;
  pending: boolean;
  situation: string;
  requiredAction: string;
  options: HumanOptionView[];
  actionBinding: ActionBindingView | null;
};

type RawRecord = Record<string, unknown>;
type ParsedClassification = { kind: 'ready_result' | 'human_only_action'; actionBinding: ActionBindingView | null };
type ClassifiedSpec = { parsed: ParsedClassification; rawEnvelope: RawRecord | null };
type LabeledRow = { label: string; value: string };

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const ACTION_KINDS = new Set<string>(['payment', 'owner_login', 'manual_machine_action', 'ceo_permission']);
const DECISION_KINDS = new Set<string>(['question', 'approval', 'choice', 'stuck', 'staff', 'structure']);
const NAMED_READY_KINDS = new Set<string>(['policy', 'staff', 'structure']);
const BLOCKED_AUDIENCES = new Set<unknown>(['internal', 'legacy']);
const ASKED_INSIDE = 'Asked inside the company.';
const EXECUTABLE_TEXT_RE =
  /```|<script\b|\|\s*(?:ba)?sh\b|\b(?:curl|wget|sudo|ssh|rm\s+-rf|chmod|chown|systemctl|kubectl|docker\s+run)\b|\bSELECT\b[\s\S]+\bFROM\b|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i;

const PENDING_ENVELOPE: PlainEnvelopeView = {
  classified: true,
  pending: true,
  situation: '',
  requiredAction: '',
  options: [],
  actionBinding: null,
};

const asRecord = (value: unknown): RawRecord | null => (typeof value === 'object' ? (value as RawRecord | null) : null);

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const hasExecutableText = (value: string): boolean => EXECUTABLE_TEXT_RE.test(value);

const isSafePlainText = (value: string | null): value is string => value !== null && !hasExecutableText(value);

const isCommitArtifact = (rec: RawRecord): boolean =>
  rec.kind === 'commit' && typeof rec.sha === 'string' && COMMIT_SHA_RE.test(rec.sha);

const isDesignArtifact = (rec: RawRecord): boolean =>
  rec.kind === 'design' && Array.isArray(rec.images) && rec.images.length > 0;

const isNamedReadyArtifact = (rec: RawRecord): boolean =>
  typeof rec.kind === 'string' && NAMED_READY_KINDS.has(rec.kind);

function isValidReadyArtifact(artifact: unknown): boolean {
  const rec = asRecord(artifact);
  if (!rec) return false;
  return isCommitArtifact(rec) || isDesignArtifact(rec) || isNamedReadyArtifact(rec);
}

const isActionKind = (kind: string | null): kind is HumanActionKind => kind !== null && ACTION_KINDS.has(kind);

function parseActionBinding(raw: unknown): ActionBindingView | null {
  const rec = asRecord(raw);
  const kind = cleanString(rec?.kind);
  const resourceId = cleanString(rec?.resourceId);
  if (!isActionKind(kind) || !resourceId) return null;
  return {
    kind,
    resourceId,
    scope: cleanString(rec?.scope),
    duration: cleanString(rec?.duration),
    amount: cleanString(rec?.amount),
  };
}

const readyClassification = (artifact: unknown): ParsedClassification | null =>
  isValidReadyArtifact(artifact) ? { kind: 'ready_result', actionBinding: null } : null;

function actionClassification(rawBinding: unknown): ParsedClassification | null {
  const actionBinding = parseActionBinding(rawBinding);
  return actionBinding ? { kind: 'human_only_action', actionBinding } : null;
}

function parseClassification(raw: unknown): ParsedClassification | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.kind === 'ready_result') return readyClassification(rec.artifact);
  if (rec.kind === 'human_only_action') return actionClassification(rec.actionBinding);
  return null;
}

const providerLabel = (id: string): string => (PROVIDER_NAMES as Record<string, string>)[id] ?? id;

const parseDecisionPurpose = (rec: RawRecord): ParsedClassification | null =>
  typeof rec.decisionKind === 'string' && DECISION_KINDS.has(rec.decisionKind) ? { kind: 'ready_result', actionBinding: null } : null;

function parseOwnerLoginPurpose(rec: RawRecord): ParsedClassification | null {
  const provider = cleanString(rec.provider);
  if (!provider) return null;
  return {
    kind: 'human_only_action',
    actionBinding: { kind: 'owner_login', resourceId: providerLabel(provider), scope: null, duration: null, amount: null },
  };
}

function parseCeoPermissionPurpose(rec: RawRecord): ParsedClassification | null {
  const permission = cleanString(rec.permission);
  if (!permission) return null;
  return {
    kind: 'human_only_action',
    actionBinding: { kind: 'ceo_permission', resourceId: permission, scope: null, duration: cleanString(rec.until), amount: null },
  };
}

const makeBareActionPurpose = (kind: 'payment' | 'manual_machine_action') => (rec: RawRecord): ParsedClassification => ({
  kind: 'human_only_action',
  actionBinding: {
    kind,
    resourceId: cleanString(rec.resourceId),
    scope: cleanString(rec.scope),
    duration: cleanString(rec.until),
    amount: cleanString(rec.amount),
  },
});

const PURPOSE_PARSERS: Record<string, (rec: RawRecord) => ParsedClassification | null> = {
  decision: parseDecisionPurpose,
  owner_login: parseOwnerLoginPurpose,
  ceo_permission: parseCeoPermissionPurpose,
  payment: makeBareActionPurpose('payment'),
  manual_machine_action: makeBareActionPurpose('manual_machine_action'),
};

function parseServerPurpose(raw: unknown): ParsedClassification | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec.kind !== 'string') return null;
  return PURPOSE_PARSERS[rec.kind]?.(rec) ?? null;
}

const hasTaskAndAgent = (rec: RawRecord): boolean => asRecord(rec.task) !== null && asRecord(rec.agent) !== null;

export function isHiddenSourceRequest(request: WaitingRequest): boolean {
  const rec = request as unknown as RawRecord;
  return rec.known === false || !hasTaskAndAgent(rec);
}

const isBlockedRow = (rec: RawRecord): boolean =>
  BLOCKED_AUDIENCES.has(rec.audience) || rec.text === ASKED_INSIDE || Boolean(rec.clientPromote);

const hasFixture491Fields = (rec: RawRecord): boolean =>
  rec.audience !== undefined || rec.classification !== undefined || rec.humanEnvelope !== undefined;

const omitsServerPair = (rec: RawRecord): boolean => rec.purpose === undefined && rec.envelope === undefined;

const hasEmptyServerPair = (rec: RawRecord): boolean => rec.purpose === null && rec.envelope === null;

function isUnclassifiedHumanRow(rec: RawRecord): boolean {
  if (isBlockedRow(rec) || hasFixture491Fields(rec)) return false;
  return hasTaskAndAgent(rec) && (omitsServerPair(rec) || hasEmptyServerPair(rec));
}

function resolveServerSpec(rec: RawRecord): ClassifiedSpec | null {
  const parsed = parseServerPurpose(rec.purpose);
  const rawEnvelope = asRecord(rec.envelope);
  return parsed && rawEnvelope ? { parsed, rawEnvelope } : null;
}

function resolveFixtureSpec(rec: RawRecord): ClassifiedSpec | null {
  const parsed = rec.audience === 'human' ? parseClassification(rec.classification) : null;
  return parsed ? { parsed, rawEnvelope: asRecord(rec.humanEnvelope) } : null;
}

function resolveClassifiedSpec(rec: RawRecord): ClassifiedSpec | null {
  if (isBlockedRow(rec)) return null;
  return resolveServerSpec(rec) ?? resolveFixtureSpec(rec);
}

export function isAuthorizedHumanRequest(request: WaitingRequest): boolean {
  const rec = request as unknown as RawRecord;
  return isUnclassifiedHumanRow(rec) || resolveClassifiedSpec(rec) !== null;
}

const isPoisonedOptional = (value: string | null): boolean => value !== null && hasExecutableText(value);

function readOptionRecord(item: unknown): { rec: RawRecord; label: string } | null {
  const rec = asRecord(item);
  const label = cleanString(rec?.label);
  return rec && label ? { rec, label } : null;
}

function fallbackImageAt(options: unknown, index: number): string | null {
  if (!Array.isArray(options)) return null;
  return cleanString(asRecord(options[index])?.image);
}

function parseOptionItem(item: unknown, fallbackImage: string | null): { option: HumanOptionView | null; poisoned: boolean } {
  const entry = readOptionRecord(item);
  if (!entry) return { option: null, poisoned: false };
  const consequence = cleanString(entry.rec.consequence);
  if (hasExecutableText(entry.label) || isPoisonedOptional(consequence)) return { option: null, poisoned: true };
  return { option: { label: entry.label, consequence, image: cleanString(entry.rec.image) ?? fallbackImage }, poisoned: false };
}

function parseEnvelopeOptions(raw: unknown, fallbackOptions: unknown): { options: HumanOptionView[]; poisoned: boolean } {
  if (!Array.isArray(raw)) return { options: [], poisoned: false };
  const options: HumanOptionView[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseOptionItem(raw[i], fallbackImageAt(fallbackOptions, i));
    if (parsed.poisoned) return { options: [], poisoned: true };
    if (parsed.option) options.push(parsed.option);
  }
  return { options, poisoned: false };
}

function isBindingSafe(binding: ActionBindingView | null): boolean {
  if (!binding) return true;
  const fields = [binding.resourceId, binding.scope, binding.duration, binding.amount];
  return fields.every(f => f === null || !hasExecutableText(f));
}

function legacyEnvelope(request: WaitingRequest): PlainEnvelopeView {
  return {
    classified: false,
    pending: false,
    situation: '',
    requiredAction: '',
    options: request.options.map(o => ({ label: o.label, image: o.image, consequence: null })),
    actionBinding: null,
  };
}

function parseSafeEnvelopeBody(
  env: RawRecord | null,
  fallbackOptions: unknown,
): { situation: string; requiredAction: string; options: HumanOptionView[] } | null {
  if (!env) return null;
  const situation = cleanString(env.situation);
  const requiredAction = cleanString(env.requiredAction);
  const parsedOpts = parseEnvelopeOptions(env.options, fallbackOptions);
  if (!isSafePlainText(situation) || !isSafePlainText(requiredAction) || parsedOpts.poisoned) return null;
  return { situation, requiredAction, options: parsedOpts.options };
}

function buildClassifiedEnvelope(spec: ClassifiedSpec, fallbackOptions: unknown): PlainEnvelopeView {
  const actionBinding = spec.parsed.actionBinding;
  const body = parseSafeEnvelopeBody(spec.rawEnvelope, fallbackOptions);
  if (!body || !isBindingSafe(actionBinding)) return PENDING_ENVELOPE;
  return { classified: true, pending: false, ...body, actionBinding };
}

export function resolvePlainEnvelope(request: WaitingRequest): PlainEnvelopeView {
  const rec = request as unknown as RawRecord;
  if (isUnclassifiedHumanRow(rec)) return legacyEnvelope(request);
  const spec = resolveClassifiedSpec(rec);
  return spec ? buildClassifiedEnvelope(spec, request.options) : PENDING_ENVELOPE;
}

function ActionBindingDetails({ t, binding }: { t: Messages; binding: ActionBindingView }) {
  const extras: LabeledRow[] = [
    binding.scope ? { label: t.tasks.actionScopeLabel, value: binding.scope } : null,
    binding.duration ? { label: t.tasks.actionDurationLabel, value: binding.duration } : null,
    binding.amount ? { label: t.tasks.actionAmountLabel, value: binding.amount } : null,
  ].filter((row): row is LabeledRow => row !== null);

  return (
    <ul className="req-ways">
      <li>
        <strong>{t.tasks.actionKinds[binding.kind]}</strong>
        {binding.resourceId && (
          <>
            {` (${t.tasks.actionResourceLabel}: `}
            <span>{binding.resourceId}</span>
            {')'}
          </>
        )}
      </li>
      {extras.map(row => (
        <li key={row.label}>
          <strong>{row.label}: </strong>
          <span>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

function PlainSummaryBody({ t, request, envelope }: { t: Messages; request: WaitingRequest; envelope: PlainEnvelopeView }) {
  const rows: LabeledRow[] = [
    { label: t.tasks.situationLabel, value: envelope.situation },
    { label: t.tasks.requiredActionLabel, value: envelope.requiredAction },
  ];
  const showConsequences = request.kind !== 'choice' && envelope.options.length > 0;
  return (
    <div className="req-explained">
      <div className="md">
        {rows.map(row => (
          <p key={row.label} className="req-text">
            <strong>{row.label}: </strong>
            <span>{row.value}</span>
          </p>
        ))}
        {envelope.actionBinding && <ActionBindingDetails t={t} binding={envelope.actionBinding} />}
        {showConsequences && (
          <ul className="req-ways">
            {envelope.options.map((opt, idx) => (
              <li key={idx}>
                <strong>{opt.label}</strong>
                {opt.consequence && (
                  <>
                    {` (${t.tasks.consequenceLabel}: `}
                    <span>{opt.consequence}</span>
                    {')'}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const legacySaidText = (t: Messages, request: WaitingRequest): string =>
  request.kind === 'stuck' && !isHiddenSourceRequest(request) ? t.tasks.stuckText(request.agent.name, request.task.number) : request.text;

function LegacyRequestWords({ t, request }: { t: Messages; request: WaitingRequest }) {
  const said = legacySaidText(t, request);
  if (request.explained) {
    return (
      <>
        <div className="req-explained">
          <Markdown text={request.explained} />
        </div>
        <details className="req-more">
          <summary>{t.tasks.inDetail}</summary>
          <p className="req-text">{said}</p>
        </details>
      </>
    );
  }
  return (
    <>
      <p className="req-text">{said}</p>
      {request.explaining && <p className="muted">{t.tasks.explaining}</p>}
    </>
  );
}

export function RequestExplanation({ request, envelope }: { request: WaitingRequest; envelope: PlainEnvelopeView }) {
  const t = useT();
  if (!envelope.classified) return <LegacyRequestWords t={t} request={request} />;
  if (envelope.pending) return <p className="muted">{t.tasks.plainExplanationPending}</p>;
  return <PlainSummaryBody t={t} request={request} envelope={envelope} />;
}
