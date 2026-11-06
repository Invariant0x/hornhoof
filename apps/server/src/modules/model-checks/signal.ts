import type { Ctx } from '../../app.js';
import type { Signal } from './lifecycle.js';
import type { Report } from './run.js';

export type SignalPlace = { companyId: string; departmentId: string; checkId: string; kind: string };
export async function recordCheckSignal(_ctx: Ctx, _place: SignalPlace, _signal: Signal, _report: Report): Promise<void> {}
