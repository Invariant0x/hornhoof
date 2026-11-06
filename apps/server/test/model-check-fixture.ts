import { createHash, randomUUID } from 'node:crypto';
import type { Case, CheckBinding, ModelCheckKind } from '@hornhoof/protocol';
import type { Party } from '../src/modules/model-checks/dataset.js';

/* Examples made up for tests only, about nothing real. No company's data, and no suite anything may ship with. */
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export const AUTHOR: Party = { kind: 'agent', id: randomUUID() };
export const LABELLER: Party = { kind: 'person', id: randomUUID() };
export const RULES = { kind: 'outbound_review' as ModelCheckKind, authors: [AUTHOR] };
export const CLASS_RULES = { kind: 'support_classification' as ModelCheckKind, authors: [AUTHOR] };

const subject = (text: string) => ({ id: randomUUID(), contentDigest: sha(text) });

export function reviewCase(more: Partial<Case> = {}): Case {
  return {
    schemaVersion: 1, id: randomUUID(), kind: 'outbound_review', locale: 'en', split: 'dev',
    input: { schemaVersion: 1, kind: 'outbound_review', locale: 'en', subject: subject('review'), message: { subject: 'Hello', body: 'Words only a test holds' }, facts: [], policyDigest: sha('policy'), authorVendorId: 'vendor-a' },
    expected: { decision: 'allow' }, mustBlock: false, labelledBy: LABELLER, labelledAt: '2026-11-01T10:00:00.000Z', sourceIncidentId: null, ...more,
  };
}

export const TAXONOMY = [{ classId: 'refund', requiresHuman: true, description: 'Asks for money back' }, { classId: 'howto', requiresHuman: false, description: 'Asks how to do something' }, { classId: 'other', requiresHuman: false, description: 'Anything else' }];

export function classCase(more: Partial<Case> = {}): Case {
  return {
    schemaVersion: 1, id: randomUUID(), kind: 'support_classification', locale: 'en', split: 'dev',
    input: { schemaVersion: 1, kind: 'support_classification', locale: 'en', subject: subject('ticket'), ticket: { text: 'Words only a test holds' }, taxonomyRevision: sha('taxonomy'), taxonomy: TAXONOMY },
    expected: { classId: 'howto', requiresHuman: false }, mustBlock: false, labelledBy: LABELLER, labelledAt: '2026-11-01T10:00:00.000Z', sourceIncidentId: null, ...more,
  };
}

export const mustBlock = (more: Partial<Case> = {}) => reviewCase({ expected: { decision: 'block' }, mustBlock: true, ...more });
export const holdout = (more: Partial<Case> = {}) => reviewCase({ split: 'holdout', ...more });
export const asJsonl = (cases: readonly unknown[]) => Buffer.from(`${cases.map(row => JSON.stringify(row)).join('\n')}\n`);

export function binding(more: Partial<CheckBinding> = {}): CheckBinding {
  return {
    schemaVersion: 1, companyId: randomUUID(), departmentId: randomUUID(), productId: null, checkId: randomUUID(), kind: 'outbound_review', definitionVersion: 1,
    checkerCodeHash: sha('code'), promptHash: sha('prompt'), outputSchemaHash: sha('output'), sourceListHash: sha('list'), taxonomyHash: null,
    model: { providerId: 'codex', vendorId: 'vendor-b', modelId: 'model-b', revisionId: 'rev-1', inferenceConfigHash: sha('config') },
    datasetVersion: randomUUID(), datasetHash: sha('dataset'), thresholdsHash: sha('thresholds'), ...more,
  };
}

export const hashOf = sha;
