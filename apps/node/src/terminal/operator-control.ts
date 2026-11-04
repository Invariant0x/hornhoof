import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { OPERATOR_CASE_MS, OPERATOR_CELLS_BYTES, OPERATOR_KEY_MS, OPERATOR_MAX_KEYS, OPERATOR_PROTECTED_SCREEN, OPERATOR_SNAPSHOT_MS, OperatorError, OperatorKey, OperatorReason, type OperatorKeyPrepared, type OperatorKeyResult, type OperatorScreen, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import { HIDDEN, redact, secretForms } from '../redact.js';
import type { OperatorIdentity } from './operator-observer.js';
import { readOperatorStore, writeOperatorStore } from './operator-storage.js';
import { protectedOperatorContent } from './operator-privacy.js';

export type OperatorProgram = OperatorIdentity & { generation: number; agentProgram: boolean; alive: boolean; pasted: boolean; turnStarted: boolean; active: boolean; runningTool: boolean; retrying: boolean; wait: { id: string; kind: 'harmless' | 'permission' | 'menu' | 'protected' | 'work' | 'unknown' } | null };
type CaseCommand = Extract<OperatorServerMessage, { type: 'program.operator_case' }>;
type ScreenCommand = Extract<OperatorServerMessage, { type: 'program.screen_get' }>;
type KeyCommand = Omit<Extract<OperatorServerMessage, { type: 'program.key_send' }>, 'key'> & { key: unknown };
type PrepareCommand = Extract<OperatorServerMessage, { type: 'program.key_prepare' }>;
type Lease = { token: string; digest: string; until: number };
type Pane = { cols: number; rows: number; cells: string };
type Options = { file: string; current(): OperatorProgram | null; capture(): Promise<Pane>; press(key: OperatorKey): Promise<void>; lane<T>(run: () => Promise<T>): Promise<T>; secrets(): string[]; now?(): number };
const Case = z.object({ instance: z.uuid(), agentKey: z.uuid(), jobId: z.uuid().nullable(), digest: z.string(), revision: z.number(), deadline: z.number(), revoked: z.boolean(), readOnly: z.boolean().default(false), reason: OperatorReason.nullable().default(null), questionId: z.uuid().nullable().default(null), actions: z.number(), lastRead: z.number().nullable() });
const Action = z.object({ case: z.uuid().nullable().default(null), digest: z.string(), result: z.enum(['requested', 'applied', 'refused', 'unknown']), reason: OperatorError.nullable() });
const RetiredCase = Case.pick({ instance: true, agentKey: true, jobId: true, revision: true, deadline: true, revoked: true });
const State = z.object({ cases: z.record(z.string(), Case), actions: z.record(z.string(), Action), retired: z.record(z.string(), RetiredCase).default({}) });
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 4096;
type State = z.infer<typeof State>;
type CaseRow = z.infer<typeof Case>;
type CaseIdentity = OperatorIdentity & { case: string; capability: string };
type CapturedPane = { pane: Pane; error: null } | { pane: null; error: OperatorError };
type Snapshot = { token: string; case: string; instance: string; generation: number; hash: string; at: number; used: boolean; protected: boolean };
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
  let masked = redact(text, secrets);
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

/* This capability never selects a tmux target. Its host binds it to one existing agent program and serialized lane. */
export class OperatorControl {
  private readonly state: State;
  private readonly now: () => number;
  private snapshot: Snapshot | null = null;
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.state = readOperatorStore(options.file, State, { cases: {}, actions: {}, retired: {} });
    for (const action of Object.values(this.state.actions)) if (action.result === 'requested') { action.result = 'unknown'; action.reason = 'action_unknown'; }
    this.prune();
  }

  openCase(command: CaseCommand): boolean {
    this.prune();
    if (this.state.retired[command.case]) return false;
    const old = this.state.cases[command.case];
    if (old && old.revision >= command.revision) return false;
    if (!old && Object.keys(this.state.cases).length >= MAX_HISTORY) return false;
    this.state.cases[command.case] = this.updatedCase(command, old);
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
      const captured = await this.capturePane();
      if (!captured.pane) return this.noScreen(command, captured.error);
      return this.screenResult(command, current, captured.pane, row.readOnly);
    });
  }

  prepare(command: PrepareCommand): OperatorKeyPrepared {
    for (const [id, lease] of this.leases) if (lease.until <= this.now()) this.leases.delete(id);
    const reason = this.keyCaseRefusal(command) ?? this.keyRefusal(this.options.current(), '', this.state.cases[command.case]) ?? this.prepareRefusal(command);
    if (reason) return { type: 'program.key_prepared', ...this.identity(command), action: command.action, result: 'refused', reason, lease: null };
    const lease = this.leases.get(command.action) ?? { token: randomUUID(), digest: this.keyDigest(command), until: this.now() + OPERATOR_KEY_MS };
    if (lease.digest !== this.keyDigest(command)) return { type: 'program.key_prepared', ...this.identity(command), action: command.action, result: 'refused', reason: 'action_unknown', lease: null };
    this.leases.set(command.action, lease);
    return { type: 'program.key_prepared', ...this.identity(command), action: command.action, result: 'ok', reason: null, lease: lease.token };
  }

  key(command: KeyCommand): Promise<OperatorKeyResult> {
    const receivedAt = this.now();
    return this.options.lane(() => this.applyKey(command, receivedAt));
  }

  private async applyKey(command: KeyCommand, receivedAt: number): Promise<OperatorKeyResult> {
    const parsed = OperatorKey.safeParse(command.key);
    if (!parsed.success) return this.result(command, 'refused', 'operator_forbidden');
    this.prune();
    const digest = hash(JSON.stringify(command));
    const old = this.state.actions[command.action];
    if (old) return this.cached(command, digest, old);
    const denied = this.actionRefusal(command);
    if (denied) return this.result(command, 'refused', denied);
    const row = this.state.cases[command.case]!;
    this.state.actions[command.action] = { case: command.case, digest, result: 'requested', reason: null };
    row.actions++;
    this.save();
    const refusal = await this.beforeKey(command) ?? (this.keyExpired(command, receivedAt) ? 'snapshot_stale' : null);
    if (refusal) return this.complete(command, 'refused', refusal);
    return this.pressKey(command, parsed.data, receivedAt);
  }

  private actionRefusal(command: KeyCommand): OperatorError | null {
    const denied = this.keyCaseRefusal(command);
    if (denied) return denied;
    const row = this.state.cases[command.case]!;
    return row.actions >= OPERATOR_MAX_KEYS || Object.keys(this.state.actions).length >= MAX_HISTORY ? 'operator_forbidden' : null;
  }

  private async pressKey(command: KeyCommand, key: OperatorKey, receivedAt: number): Promise<OperatorKeyResult> {
    try {
      /* press launches send-keys synchronously before yielding. No await may separate this final evidence check. */
      const denied = this.finalKeyRefusal(command, receivedAt);
      if (denied) return this.complete(command, 'refused', denied);
      this.snapshot!.used = true;
      this.leases.delete(command.action);
      await this.options.press(key);
      return this.complete(command, 'applied', null);
    } catch {
      return this.complete(command, 'unknown', 'action_unknown');
    }
  }

  private finalKeyRefusal(command: KeyCommand, receivedAt: number): OperatorError | null {
    if (this.keyExpired(command, receivedAt)) return 'snapshot_stale';
    const denied = this.keyCaseRefusal(command) ?? this.keyRefusal(this.options.current(), '', this.state.cases[command.case]);
    if (denied) return denied;
    return this.finalSnapshotMatches(command) ? null : 'snapshot_stale';
  }

  private finalSnapshotMatches(command: KeyCommand): boolean {
    const snap = this.snapshot;
    return Boolean(snap && !snap.used && snap.token === command.snapshot && this.options.current()?.generation === snap.generation);
  }

  private async beforeKey(command: KeyCommand): Promise<OperatorError | null> {
    const state = this.options.current();
    const busy = this.keyRefusal(state, '', this.state.cases[command.case]);
    if (busy) return busy;
    if (this.staleSnapshot(command)) return 'snapshot_stale';
    const snap = this.snapshot!;
    if (snap.generation !== state?.generation) return 'snapshot_stale';
    if (snap.protected) return 'protected_screen';
    const captured = await this.capturePane();
    if (!captured.pane) return captured.error;
    return this.capturedKeyRefusal(command, snap, captured.pane);
  }

  private capturedKeyRefusal(command: KeyCommand, snap: Snapshot, pane: Pane): OperatorError | null {
    const cells = operatorCells(pane.cells, this.options.secrets());
    const after = this.options.current();
    const denied = this.keyCaseRefusal(command) ?? this.keyRefusal(after, cells, this.state.cases[command.case]);
    if (denied) return denied;
    return this.paneChanged(snap, after, cells) ? 'snapshot_stale' : null;
  }

  private paneChanged(snap: Snapshot, after: OperatorProgram | null, cells: string): boolean {
    return this.snapshot !== snap || snap.generation !== after?.generation || snap.hash !== hash(cells);
  }

  private async capturePane(): Promise<CapturedPane> {
    try {
      const pane = await this.options.capture();
      return this.boundedPane(pane) ? { pane, error: null } : { pane: null, error: 'input_not_proven' };
    } catch { return { pane: null, error: 'node_unavailable' }; }
  }

  private screenResult(command: ScreenCommand, current: OperatorProgram, pane: Pane, readOnly: boolean): OperatorScreen {
    const display = operatorCells(pane.cells, this.options.secrets());
    const cells = this.protected(this.options.current(), display) ? OPERATOR_PROTECTED_SCREEN : display;
    const after = this.options.current();
    const forbidden = this.caseRefusal(command) ?? (readOnly ? 'operator_forbidden' : this.keyRefusal(after, cells, this.state.cases[command.case]));
    const changed = after?.generation !== current.generation;
    const token = randomUUID();
    this.snapshot = { token, case: command.case, instance: command.instance, generation: current.generation, hash: hash(cells), at: this.now(), used: false, protected: this.protected(after, cells) };
    return { type: 'program.screen', ...this.identity(command), request: command.request, result: 'ok', reason: changed ? 'snapshot_stale' : forbidden, snapshot: token, generation: current.generation, state: this.stage(after), keysAllowed: !forbidden && !changed, protected: this.snapshot.protected, ...pane, cells };
  }

  private updatedCase(command: CaseCommand, old?: CaseRow): CaseRow {
    const previous = old ?? { actions: 0, lastRead: null, deadline: Infinity, revoked: false };
    return { ...this.identity(command), digest: hash(command.capability), revision: command.revision, deadline: Math.min(previous.deadline, this.now() + Math.min(command.remainingMs, OPERATOR_CASE_MS)), revoked: previous.revoked || command.disposition === 'revoke', readOnly: command.readOnly ?? false, reason: command.reason ?? null, questionId: command.questionId ?? null, actions: previous.actions, lastRead: previous.lastRead };
  }

  private keyCaseRefusal(command: CaseIdentity): OperatorError | null {
    return this.caseRefusal(command) ?? (this.state.cases[command.case]?.readOnly ? 'operator_forbidden' : null);
  }

  private keyExpired(command: KeyCommand, receivedAt: number): boolean {
    const lease = this.leases.get(command.action);
    return !lease || lease.token !== command.lease || lease.digest !== this.keyDigest(command) || this.now() >= lease.until || this.now() - receivedAt >= Math.min(command.withinMs ?? OPERATOR_KEY_MS, OPERATOR_KEY_MS);
  }

  private keyDigest(command: PrepareCommand | KeyCommand): string {
    return hash(JSON.stringify({ ...this.identity(command), case: command.case, capability: command.capability, snapshot: command.snapshot, generation: command.generation, action: command.action, key: command.key }));
  }

  private prepareRefusal(command: PrepareCommand): OperatorError | null {
    if (this.leases.size >= 128 || this.state.actions[command.action]) return 'operator_forbidden';
    return this.snapshotRefusal(command);
  }

  private snapshotRefusal(command: PrepareCommand | KeyCommand): OperatorError | null {
    if (this.staleSnapshot(command)) return 'snapshot_stale';
    return this.snapshot!.protected ? 'protected_screen' : null;
  }

  private staleSnapshot(command: PrepareCommand | KeyCommand): boolean {
    const snap = this.snapshot;
    if (!snap || snap.used) return true;
    return !this.matchesSnapshot(command, snap) || this.now() - snap.at >= OPERATOR_SNAPSHOT_MS;
  }

  private matchesSnapshot(command: PrepareCommand | KeyCommand, snap: Snapshot): boolean {
    return snap.case === command.case && snap.instance === command.instance && snap.token === command.snapshot && snap.generation === command.generation;
  }

  private cached(command: KeyCommand, digest: string, old: State['actions'][string]): OperatorKeyResult {
    if (old.digest !== digest || old.result === 'requested') return this.result(command, 'unknown', 'action_unknown');
    return this.result(command, old.result, old.reason);
  }

  private caseRefusal(command: CaseIdentity): OperatorError | null {
    const row = this.state.cases[command.case];
    if (!row || row.revoked || this.now() >= row.deadline) return 'case_closed';
    if (row.digest !== hash(command.capability) || !this.sameIdentity(row, command)) return 'operator_forbidden';
    const current = this.options.current();
    if (!current?.agentProgram) return 'no_program';
    if (!this.sameIdentity(current, command)) return 'snapshot_stale';
    return null;
  }

  private protected(program: OperatorProgram | null, cells: string): boolean {
    return program?.wait?.kind === 'protected' || protectedOperatorContent(cells);
  }

  private boundedPane(pane: Pane): boolean {
    return Buffer.byteLength(pane.cells) <= OPERATOR_CELLS_BYTES && Number.isInteger(pane.cols) && pane.cols >= 1 && pane.cols <= 512 && Number.isInteger(pane.rows) && pane.rows >= 1 && pane.rows <= 256;
  }

  private keyRefusal(program: OperatorProgram | null, cells: string, incident?: CaseRow): OperatorError | null {
    if (this.protected(program, cells)) return 'protected_screen';
    if (!program?.agentProgram || !program.alive) return 'no_program';
    const stale = this.questionRefusal(program, incident);
    if (stale) return stale;
    if (program.retrying) return 'program_busy';
    return this.waitRefusal(program, incident);
  }

  private questionRefusal(program: OperatorProgram, incident?: CaseRow): OperatorError | null {
    return incident?.reason === 'question_waiting' && incident.questionId !== program.wait?.id ? 'snapshot_stale' : null;
  }

  private waitRefusal(program: OperatorProgram, incident?: CaseRow): OperatorError | null {
    if (this.permissionWait(program)) return this.authorizedQuestion(program, incident) ? null : 'input_not_proven';
    if (program.runningTool) return 'program_busy';
    if (program.wait?.kind === 'harmless') return null;
    if (program.wait) return 'input_not_proven';
    return this.workStarted(program) ? 'program_busy' : null;
  }

  private permissionWait(program: OperatorProgram): boolean {
    return program.wait?.kind === 'permission' || program.wait?.kind === 'menu';
  }

  private authorizedQuestion(program: OperatorProgram, incident?: CaseRow): boolean {
    return incident?.reason === 'question_waiting' && incident.questionId === program.wait?.id;
  }

  private workStarted(program: OperatorProgram): boolean { return program.pasted || program.turnStarted || program.active; }

  private sameIdentity(left: OperatorIdentity, right: OperatorIdentity): boolean {
    return left.agentKey === right.agentKey && left.instance === right.instance && left.jobId === right.jobId;
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

  /* Results survive a full day past the capability deadline. Retired identities are never forgotten:
     relative remainingMs and per-case revisions cannot prove that an unknown UUID is genuinely new. */
  private prune(): void {
    const pending = new Set(Object.values(this.state.actions).filter(action => action.result === 'requested').map(action => action.case));
    let changed = false;
    for (const [id, row] of Object.entries(this.state.cases)) {
      if (this.now() - row.deadline < HISTORY_RETENTION_MS || pending.has(id)) continue;
      this.state.retired[id] = { instance: row.instance, agentKey: row.agentKey, jobId: row.jobId, revision: row.revision, deadline: row.deadline, revoked: row.revoked };
      delete this.state.cases[id];
      changed = true;
    }
    for (const [id, action] of Object.entries(this.state.actions)) {
      /* Legacy actions have no case binding. Keep their uncertain ownership rather than guessing. */
      if (!action.case || !this.state.retired[action.case] || action.result === 'requested') continue;
      delete this.state.actions[id];
      changed = true;
    }
    if (changed) this.save();
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
