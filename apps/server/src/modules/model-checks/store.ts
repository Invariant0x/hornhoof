import type { Case, CheckBinding, ModelCheckKind } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { DatasetProblem, Party } from './dataset.js';
import type { RunModelCheck } from './run.js';

export type CheckPlace = { companyId: string; departmentId: string; productId: string | null; kind: ModelCheckKind };
export type CheckDefinition = Pick<CheckBinding, 'checkerCodeHash' | 'promptHash' | 'outputSchemaHash' | 'sourceListHash' | 'taxonomyHash' | 'model'>;
export type SavedSet = { ok: true; version: number; hash: string } | { ok: false; problems: DatasetProblem[] };

export async function saveDefinition(_ctx: Ctx, _place: CheckPlace, _definition: CheckDefinition, _author: Party, _now: Date): Promise<void> {}
export async function saveDataset(_ctx: Ctx, _place: CheckPlace, _raw: Buffer, _by: Party, _now: Date): Promise<SavedSet> { return { ok: false, problems: [] }; }
export async function addLiveMiss(_ctx: Ctx, _place: CheckPlace, _miss: Case, _by: Party, _now: Date): Promise<SavedSet> { return { ok: false, problems: [] }; }
export async function saveThresholds(_ctx: Ctx, _place: CheckPlace, _personId: string, _given: unknown, _now: Date): Promise<boolean> { return false; }
export async function runNextEvaluation(_ctx: Ctx, _call: RunModelCheck, _now: Date): Promise<string | null> { return null; }
export async function weeklyRound(_ctx: Ctx, _now: Date): Promise<void> {}
export async function modelCheckRound(_ctx: Ctx, _now: Date, _call?: RunModelCheck): Promise<void> {}
export async function checkIsOn(_ctx: Ctx, _place: CheckPlace, _now: Date): Promise<boolean> { return false; }
