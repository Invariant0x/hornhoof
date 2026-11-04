import { createHash, randomUUID } from 'node:crypto';
import { OPERATOR_CASE_MS, OPERATOR_CELLS_BYTES, OPERATOR_MAX_KEYS, OPERATOR_SNAPSHOT_MS, OperatorError, OperatorKey, OperatorReason, type OperatorKeyResult, type OperatorScreen, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import { redact } from '../redact.js';
import type { OperatorIdentity } from './operator-observer.js';
import { readOperatorStore, writeOperatorStore } from './operator-storage.js';

export type OperatorProgram = OperatorIdentity & { generation: number; agentProgram: boolean; alive: boolean; pasted: boolean; turnStarted: boolean; active: boolean; runningTool: boolean; retrying: boolean; wait: { id: string; kind: 'harmless' | 'permission' | 'menu' | 'protected' | 'work' | 'unknown' } | null };
type CaseCommand = Extract<OperatorServerMessage, { type: 'program.operator_case' }>;
type ScreenCommand = Extract<OperatorServerMessage, { type: 'program.screen_get' }>;
type KeyCommand = Omit<Extract<OperatorServerMessage, { type: 'program.key_send' }>, 'key'> & { key: unknown };
type Pane = { cols: number; rows: number; cells: string };
type Options = { file: string; current(): OperatorProgram | null; capture(): Promise<Pane>; press(key: OperatorKey): Promise<void>; lane<T>(run: () => Promise<T>): Promise<T>; secrets(): string[]; now?(): number };
const Case = z.object({ instance: z.uuid(), agentKey: z.uuid(), jobId: z.uuid().nullable(), digest: z.string(), revision: z.number(), deadline: z.number(), revoked: z.boolean(), readOnly: z.boolean().default(false), reason: OperatorReason.nullable().default(null), questionId: z.uuid().nullable().default(null), actions: z.number(), lastRead: z.number().nullable() });
const Action = z.object({ digest: z.string(), result: z.enum(['requested', 'applied', 'refused', 'unknown']), reason: OperatorError.nullable() });
const State = z.object({ cases: z.record(z.string(), Case), actions: z.record(z.string(), Action) });
type State = z.infer<typeof State>;
type Snapshot = { token: string; case: string; instance: string; generation: number; hash: string; at: number; used: boolean; protected: boolean };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sensitive = /terms|conditions|consent|privacy|telemetry|data.?sharing|sign.?in|log.?in|password|verification|one.time|two.factor|payment|billing|credit.card|purchase|upgrade|authenticat|access.?token|auth.?token|\btoken\s*:|api.?key|credential|qr.?code|услови|согласи|парол|войти|вход|код подтверж|оплат|тариф|передач.{0,25}данн/iu;

/* Keep SGR styling only. OSC links/clipboard and other terminal controls cannot become picture content or input. */
export function operatorCells(cells: string, secrets: string[]): string {
  const display = cells.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, '');
  const plain = display.replace(/\x1b\[[0-9;]*m/g, '');
  const masked = redact(plain, secrets);
  /* A secret may span several styled runs. Prefer an unstyled redacted pane to leaking its visible value. */
  return masked === plain ? display : masked;
}

/* This capability never selects a tmux target. Its host binds it to one existing agent program and serialized lane. */
export class OperatorControl {
  private readonly state: State;
  private readonly now: () => number;
  private snapshot: Snapshot | null = null;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.state = readOperatorStore(options.file, State, { cases: {}, actions: {} });
    for (const action of Object.values(this.state.actions)) if (action.result === 'requested') { action.result = 'unknown'; action.reason = 'action_unknown'; }
  }

  openCase(command: CaseCommand): boolean {
    const old = this.state.cases[command.case];
    if (old && old.revision >= command.revision) return false;
    const deadline = this.now() + Math.min(command.remainingMs, OPERATOR_CASE_MS);
    this.state.cases[command.case] = { instance: command.instance, agentKey: command.agentKey, jobId: command.jobId, digest: hash(command.capability), revision: command.revision, deadline: old ? Math.min(old.deadline, deadline) : deadline, revoked: command.disposition === 'revoke', readOnly: command.readOnly ?? false, reason: command.reason ?? null, questionId: command.questionId ?? null, actions: old?.actions ?? 0, lastRead: old?.lastRead ?? null };
    this.snapshot = null;
    this.save();
    return true;
  }

  screen(command: ScreenCommand): Promise<OperatorScreen> {
    return this.options.lane(async () => {
      const denied = this.caseRefusal(command);
      if (denied) return this.noScreen(command, denied);
      const current = this.options.current()!;
      const row = this.state.cases[command.case]!;
      if (row.lastRead !== null && this.now() - row.lastRead < 1000) return this.noScreen(command, 'snapshot_stale');
      row.lastRead = this.now(); this.save();
      let pane: Pane;
      try { pane = await this.options.capture(); } catch { return this.noScreen(command, 'node_unavailable'); }
      const cells = operatorCells(pane.cells, this.options.secrets());
      if (Buffer.byteLength(cells) > OPERATOR_CELLS_BYTES || pane.cols < 1 || pane.cols > 512 || pane.rows < 1 || pane.rows > 256) return this.noScreen(command, 'input_not_proven');
      const after = this.options.current();
      const forbidden = this.caseRefusal(command) ?? (row.readOnly ? 'operator_forbidden' : this.keyRefusal(after, cells, this.state.cases[command.case]));
      const changed = after?.generation !== current.generation;
      const token = randomUUID();
      this.snapshot = { token, case: command.case, instance: command.instance, generation: current.generation, hash: hash(cells), at: this.now(), used: false, protected: this.protected(after, cells) };
      return { type: 'program.screen', ...this.identity(command), request: command.request, result: 'ok', reason: changed ? 'snapshot_stale' : forbidden, snapshot: token, generation: current.generation, state: this.stage(after), keysAllowed: !forbidden && !changed, protected: this.snapshot.protected, ...pane, cells };
    });
  }

  key(command: KeyCommand): Promise<OperatorKeyResult> {
    return this.options.lane(() => this.applyKey(command));
  }

  private async applyKey(command: KeyCommand): Promise<OperatorKeyResult> {
    const parsed = OperatorKey.safeParse(command.key);
    if (!parsed.success) return this.result(command, 'refused', 'operator_forbidden');
    const digest = hash(JSON.stringify(command));
    const old = this.state.actions[command.action];
    if (old) return this.cached(command, digest, old);
    const denied = this.caseRefusal(command);
    if (denied) return this.result(command, 'refused', denied);
    const row = this.state.cases[command.case]!;
    if (row.readOnly) return this.result(command, 'refused', 'operator_forbidden');
    if (row.actions >= OPERATOR_MAX_KEYS || Object.keys(this.state.actions).length >= 4096) return this.result(command, 'refused', 'operator_forbidden');
    this.state.actions[command.action] = { digest, result: 'requested', reason: null };
    row.actions++;
    this.save();
    const refusal = await this.beforeKey(command);
    if (refusal) return this.complete(command, 'refused', refusal);
    try {
      /* press launches send-keys synchronously before yielding. No await may separate this final evidence check. */
      const final = this.keyCaseRefusal(command) ?? this.keyRefusal(this.options.current(), '', this.state.cases[command.case]);
      if (final) return this.complete(command, 'refused', final);
      const snapshot = this.snapshot;
      if (!snapshot || snapshot.used || snapshot.token !== command.snapshot || this.options.current()?.generation !== snapshot.generation) return this.complete(command, 'refused', 'snapshot_stale');
      snapshot.used = true;
      await this.options.press(parsed.data);
      return this.complete(command, 'applied', null);
    } catch {
      return this.complete(command, 'unknown', 'action_unknown');
    }
  }

  private async beforeKey(command: KeyCommand): Promise<OperatorError | null> {
    const snap = this.snapshot;
    const state = this.options.current();
    const busy = this.keyRefusal(state, '', this.state.cases[command.case]);
    if (busy) return busy;
    if (!snap || snap.used || snap.case !== command.case || snap.instance !== command.instance || snap.token !== command.snapshot || snap.generation !== command.generation || snap.generation !== state?.generation || this.now() - snap.at >= OPERATOR_SNAPSHOT_MS) return 'snapshot_stale';
    if (snap.protected) return 'protected_screen';
    let pane: Pane;
    try { pane = await this.options.capture(); } catch { return 'node_unavailable'; }
    const cells = operatorCells(pane.cells, this.options.secrets());
    const after = this.options.current();
    const denied = this.keyCaseRefusal(command) ?? this.keyRefusal(after, cells, this.state.cases[command.case]);
    if (denied) return denied;
    return this.snapshot !== snap || snap.generation !== after?.generation || snap.hash !== hash(cells) ? 'snapshot_stale' : null;
  }

  private keyCaseRefusal(command: KeyCommand): OperatorError | null {
    return this.caseRefusal(command) ?? (this.state.cases[command.case]?.readOnly ? 'operator_forbidden' : null);
  }

  private cached(command: KeyCommand, digest: string, old: State['actions'][string]): OperatorKeyResult {
    if (old.digest !== digest || old.result === 'requested') return this.result(command, 'unknown', 'action_unknown');
    return this.result(command, old.result, old.reason);
  }

  private caseRefusal(command: { case: string; capability: string } & OperatorIdentity): OperatorError | null {
    const row = this.state.cases[command.case];
    if (!row || row.revoked || this.now() >= row.deadline) return 'case_closed';
    if (row.digest !== hash(command.capability) || row.agentKey !== command.agentKey || row.instance !== command.instance || row.jobId !== command.jobId) return 'operator_forbidden';
    const current = this.options.current();
    if (!current?.agentProgram) return 'no_program';
    if (current.instance !== command.instance || current.agentKey !== command.agentKey || current.jobId !== command.jobId) return 'snapshot_stale';
    return null;
  }

  private protected(program: OperatorProgram | null, cells: string): boolean {
    return program?.wait?.kind === 'protected' || cells.includes('[hidden]') || sensitive.test(cells.replace(/\x1b\[[0-9;]*m/g, ''));
  }

  private keyRefusal(program: OperatorProgram | null, cells: string, incident?: z.infer<typeof Case>): OperatorError | null {
    if (this.protected(program, cells)) return 'protected_screen';
    if (!program?.agentProgram || !program.alive) return 'no_program';
    if (incident?.reason === 'question_waiting' && incident.questionId !== program.wait?.id) return 'snapshot_stale';
    if (program.retrying) return 'program_busy';
    if (program.wait?.kind === 'permission' || program.wait?.kind === 'menu') return incident?.reason === 'question_waiting' && incident.questionId === program.wait.id ? null : 'input_not_proven';
    if (program.runningTool) return 'program_busy';
    if (program.wait?.kind === 'harmless') return null;
    if (program.wait) return 'input_not_proven';
    return program.pasted || program.turnStarted || program.active ? 'program_busy' : null;
  }

  private stage(program: OperatorProgram | null): OperatorScreen['state'] {
    if (!program?.agentProgram) return 'unknown';
    if (!program.alive) return 'gone';
    if (program.wait) return 'awaiting_input';
    return this.keyRefusal(program, '') ? 'working' : 'pre_work';
  }

  private noScreen(command: ScreenCommand, reason: OperatorError): OperatorScreen {
    return { type: 'program.screen', ...this.identity(command), request: command.request, result: 'refused', reason, snapshot: null, generation: 0, state: 'unknown', keysAllowed: false, protected: false, cols: 1, rows: 1, cells: '' };
  }

  private identity(value: OperatorIdentity): OperatorIdentity { return { agentKey: value.agentKey, jobId: value.jobId, instance: value.instance }; }
  private save(): void { writeOperatorStore(this.options.file, this.state); }

  private result(command: KeyCommand, result: OperatorKeyResult['result'], reason: OperatorError | null): OperatorKeyResult {
    return { type: 'program.key_result', ...this.identity(command), action: command.action, result, reason };
  }

  private complete(command: KeyCommand, result: OperatorKeyResult['result'], reason: OperatorError | null): OperatorKeyResult {
    const action = this.state.actions[command.action]!;
    action.result = result; action.reason = reason;
    this.save();
    return this.result(command, result, reason);
  }
}
