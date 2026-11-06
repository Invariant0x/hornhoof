import type { GateCode, MessageStatus, ReasonCode } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import type { DecidedBy } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';

export type OutboundSourceSummary = {
  kind: string;
  entryId: string;
  revision: number;
  summary: string;
};

export type BoundMessageApprovalView = {
  kind: 'message';
  requestId: string;
  status: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  channel: { id: string; name: string; adapter: 'smtp' | 'webhook'; purpose: string; audience: 'direct' | 'public' };
  account: { id: string; label: string; senderDomain: string; bindingGeneration: number };
  messageId: string;
  revision: number;
  locale: string;
  contentDigest: string;
  policyDigest: string;
  sourceRevisionsDigest: string;
  rendered: { subject: string | null; body: string };
  sources: OutboundSourceSummary[];
};

export type BoundApproachApprovalView = {
  kind: 'approach';
  requestId: string;
  status: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  channel: { id: string; name: string; adapter: 'smtp' | 'webhook'; purpose: string; audience: 'direct' | 'public' };
  segment: { id: string; revision: number | null; name: string | null };
  template: { id: string; revision: number; locale: string; subject: string | null; preview: string };
  policyDigest: string;
  sourceRevisionsDigest: string;
  sources: OutboundSourceSummary[];
};

export type BoundApprovalView = BoundMessageApprovalView | BoundApproachApprovalView;

export type UnknownRecoveryView = {
  attemptId: string;
  safeCode: string;
  endedAt: string;
  quotaHeld: true;
  nextActionCode: 'check_receiver_before_resend';
};

export type OutboundMessageSafeItem = {
  id: string;
  departmentId: string;
  productId: string | null;
  taskId: string;
  channelId: string;
  channelName: string;
  accountId: string;
  accountLabel: string;
  senderDomain: string;
  revision: number;
  contentDigest: string;
  status: MessageStatus;
  reasonCodes: GateCode[];
  scheduledAt: string;
  updatedAt: string;
  unknownRecovery: UnknownRecoveryView | null;
};

export type SupportEscalationSafeItem = {
  ticketId: string;
  revision: number;
  departmentId: string;
  productId: string | null;
  status: 'escalated';
  classId: string | null;
  reasonCodes: ReasonCode[];
  requestId: string | null;
  taskId: string | null;
  ownerPersonId: string;
  canAnswer: boolean;
  decidedBy: DecidedBy;
  createdAt: string;
};

export type OutboundChannelSafeItem = {
  id: string;
  departmentId: string;
  productId: string | null;
  name: string;
  adapter: 'smtp' | 'webhook';
  purpose: string;
  audience: 'direct' | 'public';
  status: 'new' | 'active' | 'stopped';
  generation: number;
  stoppedReason: GateCode | null;
  stoppedAt: string | null;
  accounts: {
    id: string;
    label: string;
    senderDomain: string;
    status: 'active' | 'invalid' | 'revoked';
    configGeneration: number;
    available: boolean;
  }[];
};

export type OutboundOverviewDto = {
  channels: OutboundChannelSafeItem[];
  messages: OutboundMessageSafeItem[];
  escalations: SupportEscalationSafeItem[];
  approvals: BoundApprovalView[];
};

export async function getBoundApprovalView(
  _ctx: Pick<Ctx, 'db'>,
  _me: Person,
  _requestId: string,
): Promise<BoundApprovalView | null> {
  return null;
}

export async function listOutboundOverview(
  _ctx: Pick<Ctx, 'db'>,
  _me: Person,
  _departmentId?: string,
): Promise<OutboundOverviewDto> {
  return { channels: [], messages: [], escalations: [], approvals: [] };
}

export function outboundViewRoutes(_app: FastifyInstance, _ctx: Ctx): void {}
