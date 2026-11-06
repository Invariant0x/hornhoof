import type { Case, ModelCheckKind, Party } from './contract.js';

export type DatasetProblem = { line: number; code: string };
export type Dataset = { hash: string; cases: Case[]; holdout: number; mustBlock: number };
export type DatasetRules = { kind: ModelCheckKind; authors: readonly Party[] };

export function parseDataset(_raw: Buffer, _rules: DatasetRules): { ok: true; dataset: Dataset } | { ok: false; problems: DatasetProblem[] } {
  return { ok: false, problems: [] };
}
export const tuningCases = (dataset: Dataset): Case[] => dataset.cases;
export function withLiveMiss(_raw: Buffer, _miss: Case, _rules: DatasetRules): { ok: true; raw: Buffer; dataset: Dataset } | { ok: false; problems: DatasetProblem[] } {
  return { ok: false, problems: [] };
}
