import { useT, type Messages } from '../i18n';
import type { WaitingRequest } from '../types';
import { Markdown } from './Markdown';

export type HumanActionKind = 'payment' | 'owner_login' | 'manual_machine_action' | 'ceo_permission';

export type ActionBindingView = {
  kind: HumanActionKind;
  resourceId: string;
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
type LabeledRow = { label: string; value: string };

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const ACTION_KINDS = new Set<string>(['payment', 'owner_login', 'manual_machine_action', 'ceo_permission']);
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

function isValidReadyArtifact(artifact: unknown): boolean {
  const rec = asRecord(artifact);
  if (!rec) return false;
  if (rec.kind === 'commit') return typeof rec.sha === 'string' && COMMIT_SHA_RE.test(rec.sha);
  return rec.kind === 'design' && Array.isArray(rec.images) && rec.images.length > 0;
}

function parseActionBinding(raw: unknown): ActionBindingView | null {
  const rec = asRecord(raw);
  const kind = cleanString(rec?.kind);
  const resourceId = cleanString(rec?.resourceId);
  if (!kind || !ACTION_KINDS.has(kind) || !resourceId) return null;
  return {
    kind: kind as HumanActionKind,
    resourceId,
    scope: cleanString(rec?.scope),
    duration: cleanString(rec?.duration),
    amount: cleanString(rec?.amount),
  };
}

function parseClassification(raw: unknown): ParsedClassification | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.kind === 'ready_result') return isValidReadyArtifact(rec.artifact) ? { kind: 'ready_result', actionBinding: null } : null;
  const actionBinding = rec.kind === 'human_only_action' ? parseActionBinding(rec.actionBinding) : null;
  return actionBinding ? { kind: 'human_only_action', actionBinding } : null;
}

export function isHiddenSourceRequest(request: WaitingRequest): boolean {
  const rec = request as unknown as RawRecord;
  return rec.known === false || !asRecord(rec.task) || !asRecord(rec.agent);
}

function isUnclassifiedPre491Request(rec: RawRecord): boolean {
  const has491Fields = rec.audience !== undefined || rec.classification !== undefined || rec.humanEnvelope !== undefined;
  return !has491Fields && asRecord(rec.task) !== null && asRecord(rec.agent) !== null;
}

export function isAuthorizedHumanRequest(request: WaitingRequest): boolean {
  const rec = request as unknown as RawRecord;
  if (isUnclassifiedPre491Request(rec)) return true;
  return rec.audience === 'human' && parseClassification(rec.classification) !== null;
}

function parseOptionItem(item: unknown): { option: HumanOptionView | null; poisoned: boolean } {
  const rec = asRecord(item);
  const label = cleanString(rec?.label);
  if (!label) return { option: null, poisoned: false };
  const consequence = cleanString(rec?.consequence);
  const badConsequence = consequence !== null && hasExecutableText(consequence);
  if (hasExecutableText(label) || badConsequence) return { option: null, poisoned: true };
  return { option: { label, consequence, image: cleanString(rec?.image) }, poisoned: false };
}

function parseEnvelopeOptions(raw: unknown): { options: HumanOptionView[]; poisoned: boolean } {
  if (!Array.isArray(raw)) return { options: [], poisoned: false };
  const options: HumanOptionView[] = [];
  for (const item of raw) {
    const parsed = parseOptionItem(item);
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

export function resolvePlainEnvelope(request: WaitingRequest): PlainEnvelopeView {
  const rec = request as unknown as RawRecord;
  if (isUnclassifiedPre491Request(rec)) return legacyEnvelope(request);
  const actionBinding = parseClassification(rec.classification)?.actionBinding ?? null;
  const env = asRecord(rec.humanEnvelope);
  const situation = cleanString(env?.situation);
  const requiredAction = cleanString(env?.requiredAction);
  const parsedOpts = parseEnvelopeOptions(env?.options);
  if (!isSafePlainText(situation) || !isSafePlainText(requiredAction)) return PENDING_ENVELOPE;
  if (parsedOpts.poisoned || !isBindingSafe(actionBinding)) return PENDING_ENVELOPE;
  return { classified: true, pending: false, situation, requiredAction, options: parsedOpts.options, actionBinding };
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
        {` (${t.tasks.actionResourceLabel}: `}
        <span>{binding.resourceId}</span>
        {')'}
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

function LegacyRequestWords({ t, request }: { t: Messages; request: WaitingRequest }) {
  const said = request.kind === 'stuck' ? t.tasks.stuckText(request.agent.name, request.task.number) : request.text;
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
