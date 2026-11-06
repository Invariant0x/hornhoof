import type { ProviderId, SubmitResult, SupportClassifyResult } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { ModelCheckPorts } from './ports.js';

export type OutboundAgentCaller = {
  readonly companyId: string;
  readonly agentId: string;
  readonly jobId?: string | null;
  readonly authorProvider?: ProviderId | null;
  readonly authorVendorId?: string;
};

export function containsSecretMaterial(_text: string): boolean {
  return false;
}

export function containsThirdPartyPii(_text: string): boolean {
  return false;
}

export function containsForbiddenSupportPromise(_text: string): boolean {
  return false;
}

export async function classifySupportTicket(
  _ctx: Pick<Ctx, 'db' | 'config' | 'bus'>,
  _ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  _caller: OutboundAgentCaller,
  _rawInput: unknown,
  _now?: Date,
): Promise<SupportClassifyResult> {
  throw new Error('NOT_IMPLEMENTED');
}

export async function submitSupportReply(
  _ctx: Pick<Ctx, 'db' | 'config' | 'bus'>,
  _ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  _caller: OutboundAgentCaller,
  _rawInput: unknown,
  _now?: Date,
): Promise<SubmitResult> {
  throw new Error('NOT_IMPLEMENTED');
}
