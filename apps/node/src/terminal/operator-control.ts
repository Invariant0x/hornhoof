import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { OPERATOR_CASE_MS, OPERATOR_CELLS_BYTES, OperatorReason, type OperatorCheck, type OperatorInputLine, type OperatorQuestion, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import { HIDDEN, redactOperator, secretForms } from '../redact.js';
import type { OperatorIdentity } from './operator-observer.js';
import { readOperatorStore, writeOperatorStore } from './operator-storage.js';

export type OperatorProgram = OperatorIdentity & { generation: number; runningTool: boolean; retrying: boolean; wait: { id: string; kind: OperatorQuestion['kind'] } | null };
type CaseCommand = Extract<OperatorServerMessage, { type: 'program.operator_case' }>;
export type Pane = { cols: number; rows: number; cells: string };
type Options = { file: string; capture(): Promise<Pane>; lane<T>(run: () => Promise<T>): Promise<T>; secrets(): string[]; now?(): number };
const Case = z.object({ instance: z.uuid(), agentKey: z.uuid(), jobId: z.uuid().nullable(), digest: z.string(), revision: z.number(), deadline: z.number(), revoked: z.boolean(), readOnly: z.boolean().default(false), reason: OperatorReason.nullable().default(null), questionId: z.uuid().nullable().default(null) });
const RetiredCase = Case.pick({ instance: true, agentKey: true, jobId: true, revision: true, deadline: true, revoked: true });
const State = z.object({ cases: z.record(z.string(), Case), retired: z.record(z.string(), RetiredCase).default({}) });
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 4096;
type State = z.infer<typeof State>;
type CaseRow = z.infer<typeof Case>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/* Keep SGR styling only. OSC links/clipboard and other terminal controls cannot become picture content or input. */
export function operatorCells(cells: string, secrets: string[]): string {
  const display = cells
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)([0-?]*[ -/]*)(?:([@-~])|$)/g, (sequence: string, parameters: string, final: string | undefined) => final === 'm' && /^[0-9;]*$/.test(parameters) ? sequence.replace(/^\x9b/, '\x1b[') : '')
    .replace(/\x1b(?!\[[0-9;]*m)(?:[ -/]*[0-~]|$)/g, '')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, '');
  const plain = display.replace(/\x1b\[[0-9;]*m/g, '');
  const masked = maskOperatorRows(plain, secrets);
  /* A secret may span several styled runs. Prefer an unstyled redacted pane to leaking its visible value. */
  return masked === plain ? display : masked;
}

/* A known credential may cross hard capture rows. Keep the original row layout outside its masked span. */
function maskOperatorRows(text: string, secrets: string[]): string {
  let masked = redactOperator(text, secrets);
  for (const value of secretForms(secrets)) masked = maskWrappedSecret(masked, value);
  return masked;
}

function maskWrappedSecret(text: string, value: string): string {
  const joined = text.replace(/\n/g, '');
  if (!joined.includes(value)) return text;
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index++) if (text[index] !== '\n') offsets.push(index);
  const chunks: string[] = [];
  let cursor = 0;
  for (let match = joined.indexOf(value); match >= 0; match = joined.indexOf(value, match + value.length)) {
    chunks.push(text.slice(cursor, offsets[match]), HIDDEN);
    cursor = offsets[match + value.length - 1]! + 1;
  }
  return chunks.join('') + text.slice(cursor);
}

/* The cases Hornhoof opened on one agent's program, as the server last said, and what the node saw as it stopped waiting for
   a turn's words. Looking at a program and typing into it is ProgramAccess's, for whoever the server lets. */
export class OperatorControl {
  private readonly state: State;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.state = readOperatorStore(options.file, State, { cases: {}, retired: {} });
    this.prune();
  }

  openCase(command: CaseCommand): boolean {
    this.prune();
    if (this.state.retired[command.case]) return false;
    const old = this.state.cases[command.case];
    if (old && old.revision >= command.revision) return false;
    if (!old && Object.keys(this.state.cases).length >= MAX_HISTORY) return false;
    this.state.cases[command.case] = this.updatedCase(command, old);
    this.save();
    return true;
  }

  /* The screen and the input line as the node stops waiting for a turn's words, with only the values of secrets masked. */
  check(line: (cells: string) => OperatorInputLine): Promise<OperatorCheck> {
    return this.options.lane(async () => {
      const pane = await this.capturePane();
      return pane ? { input: line(pane.cells), screen: { cols: pane.cols, rows: pane.rows, cells: operatorCells(pane.cells, this.options.secrets()) } } : { input: 'unknown', screen: null };
    });
  }

  private async capturePane(): Promise<Pane | null> {
    try {
      const pane = await this.options.capture();
      return boundedPane(pane) ? pane : null;
    } catch { return null; }
  }

  private updatedCase(command: CaseCommand, old?: CaseRow): CaseRow {
    const previous = old ?? { deadline: Infinity, revoked: false };
    return { agentKey: command.agentKey, jobId: command.jobId, instance: command.instance, digest: hash(command.capability), revision: command.revision, deadline: Math.min(previous.deadline, this.now() + Math.min(command.remainingMs, OPERATOR_CASE_MS)), revoked: previous.revoked || command.disposition === 'revoke', readOnly: command.readOnly ?? false, reason: command.reason ?? null, questionId: command.questionId ?? null };
  }

  /* Cases stay a full day past their deadline. Retired identities are never forgotten: relative remainingMs and per-case
     revisions cannot prove that an unknown UUID is genuinely new. */
  private prune(): void {
    let changed = false;
    for (const [id, row] of Object.entries(this.state.cases)) {
      if (this.now() - row.deadline < HISTORY_RETENTION_MS) continue;
      this.state.retired[id] = { instance: row.instance, agentKey: row.agentKey, jobId: row.jobId, revision: row.revision, deadline: row.deadline, revoked: row.revoked };
      delete this.state.cases[id];
      changed = true;
    }
    if (changed) this.save();
  }

  private save(): void { writeOperatorStore(this.options.file, this.state); }
}

export function boundedPane(pane: Pane): boolean {
  return Buffer.byteLength(pane.cells) <= OPERATOR_CELLS_BYTES && Number.isInteger(pane.cols) && pane.cols >= 1 && pane.cols <= 512 && Number.isInteger(pane.rows) && pane.rows >= 1 && pane.rows <= 256;
}
