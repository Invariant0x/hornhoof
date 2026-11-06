import type { CheckBinding, CheckInput, CheckReceipt, CheckUnavailable, ModelCheckKind, ModelIdentity, ProviderId } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { RunModelCheck } from '../model-checks/run.js';
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

export function resolveVendorSet(_providerId: ProviderId | null, _declaredVendorId: string): ReadonlySet<string> | null {
  return null;
}

export function areVendorsIndependent(_authorProvider: ProviderId | null, _authorVendorId: string, _reviewer: ModelIdentity): boolean {
  return false;
}

export function createEvaluatorModelRunner(_invoke: FreshModelInvoke): RunModelCheck {
  return async () => ({ kind: 'unavailable', code: 'unavailable' });
}

export function createLiveModelCheckRunner(_deps: {
  getCertifiedCheck: ModelCheckPorts['getCertifiedCheck'];
  invoke: FreshModelInvoke;
}): RunModelCheck {
  return async () => ({ kind: 'unavailable', code: 'unavailable' });
}

export function createModelCheckPorts(
  _ctx: Pick<Ctx, 'db'>,
  _invoke: FreshModelInvoke,
  _options?: { now?: () => Date },
): ModelCheckPorts {
  return {
    runModelCheck: async () => ({ kind: 'unavailable', code: 'unavailable' }),
    getCertifiedCheck: async () => null,
    invalidateCertification: async () => {
      throw new Error('NOT_IMPLEMENTED');
    },
    publishEvaluation: async () => {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}

export async function reviewOutboundMessageRevision(
  _ctx: Pick<Ctx, 'db'>,
  _ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  _params: {
    companyId: string;
    messageId: string;
    messageRevision: number;
    binding: CheckBinding;
    input: Extract<CheckInput, { kind: 'outbound_review' | 'support_reply_review' }>;
  },
): Promise<CheckReceipt | CheckUnavailable> {
  return { kind: 'unavailable', code: 'unavailable' };
}
