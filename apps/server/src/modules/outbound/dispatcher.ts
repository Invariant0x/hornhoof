import type { Ctx } from '../../app.js';
import type { SmtpSettings, WebhookSettings } from './accounts.js';
import type { DispatchAdmission, TransportAdapter } from './ports.js';

export type Senders = { smtp: TransportAdapter<SmtpSettings>; webhook: TransportAdapter<WebhookSettings>; deadlineMs: number };
type Begun = Extract<DispatchAdmission, { kind: 'begun' }>;
type Receipt = { attemptId: string; kind: 'delivered' | 'bounce' | 'refusal' | 'complaint'; providerEventId: string; occurredAt: string };

export const dispatchDue = async (_ctx: Ctx, _now: Date, _senders: Senders): Promise<void> => {};
export const reconcileOutbound = async (_ctx: Ctx, _now: Date, _senders: Senders): Promise<void> => {};
export const sendBegun = async (_ctx: Ctx, _begun: Begun, _senders: Senders): Promise<void> => {};
export const noticeStops = async (_ctx: Ctx): Promise<void> => {};
export const recordReceipts = async (_ctx: Ctx, _account: object, _events: Receipt[]) => ({ recorded: 0, repeated: 0, ignored: 0 });
