import type { CertifiedCheck, CheckBinding, InvalidationCode, ModelCheckKind, ModelIdentity, VerifiedEvaluation } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import type { Party } from '../model-checks/dataset.js';
import type { CheckPlace } from '../model-checks/store.js';
import type { ModelCheckPorts } from './ports.js';

const EVALUATOR_BRAND: unique symbol = Symbol('hornhoof.trustedEvaluator');

export type EvaluatorAuth = { readonly [EVALUATOR_BRAND]: true };

export const OUTBOUND_CHECK_HASHES: Record<ModelCheckKind, { checkerCodeHash: string; promptHash: string; outputSchemaHash: string }> = {
  outbound_review: { checkerCodeHash: '0'.repeat(64), promptHash: '0'.repeat(64), outputSchemaHash: '0'.repeat(64) },
  support_reply_review: { checkerCodeHash: '0'.repeat(64), promptHash: '0'.repeat(64), outputSchemaHash: '0'.repeat(64) },
  support_classification: { checkerCodeHash: '0'.repeat(64), promptHash: '0'.repeat(64), outputSchemaHash: '0'.repeat(64) },
};

export function trustedEvaluatorAuth(): EvaluatorAuth {
  return { [EVALUATOR_BRAND]: true };
}

export async function syncOutboundCheckDefinition(
  _ctx: Pick<Ctx, 'db'>,
  _place: CheckPlace,
  _spec: { sourceListHash: string; taxonomyHash: string | null; model: ModelIdentity; author: Party; now?: Date },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export async function currentCheckBinding(
  _db: Pick<Db, 'select'>,
  _place: CheckPlace,
): Promise<{ checkId: string; binding: CheckBinding; bindingDigest: string } | null> {
  return null;
}

export async function publishVerifiedEvaluation(
  _ctx: Pick<Ctx, 'db'>,
  _auth: unknown,
  _evaluation: VerifiedEvaluation,
  _now?: Date,
): Promise<CertifiedCheck | null> {
  throw new Error('NOT_IMPLEMENTED');
}

export function createEvaluationPort(
  _ctx: Pick<Ctx, 'db'>,
  _options?: { now?: () => Date },
): Omit<ModelCheckPorts, 'runModelCheck'> {
  return {
    getCertifiedCheck: async () => null,
    invalidateCertification: async () => {
      throw new Error('NOT_IMPLEMENTED');
    },
    publishEvaluation: async () => {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}

export type { InvalidationCode };
