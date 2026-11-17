import { randomUUID } from 'node:crypto';
import { OPERATOR_SNAPSHOT_MS, ProgramKey, type OperatorError, type OperatorQuestion, type OperatorServerMessage, type ProgramInputLine, type ProgramInputResult, type ProgramView } from '@hornhoof/protocol/program-operator';
import { boundedPane, operatorCells, type Pane } from './operator-control.js';
import { redact } from '../redact.js';

type ViewCommand = Extract<OperatorServerMessage, { type: 'program.view_get' }>;
type InputCommand = Extract<OperatorServerMessage, { type: 'program.input_send' }>;
/* What the host knows of an agent's program that runs here now, or null when none does. */
export type ProgramFacts = { jobId: string | null; instance: string; working: boolean; completion?: string; tool: string | null; question: OperatorQuestion | null; input: ProgramInputLine; undelivered: boolean };
type Source = {
  facts(key: string): Promise<ProgramFacts | null>;
  capture(key: string): Promise<Pane>;
  paste(key: string, text: string): Promise<void>;
  press(key: string, keys: string[]): Promise<void>;
  lane<T>(key: string, run: () => Promise<T>): Promise<T>;
  secrets(): string[];
  now(): number;
};
type Snapshot = { token: string; instance: string; at: number };
const MAX_DONE = 1024;
/* Hornhoof looks at a running program on its own too, so up to this many fresh looks of one program stay good at once. */
const MAX_LOOKS = 8;

/* The orchestrator and Operations look at any employee's program here and type into it, as the server allows them. It opens no
   program and selects no tmux target of its own: a look and the input after it go to the agent's existing one, through the
   same lane as Hornhoof's own keys. Only the values of secrets are masked, and nothing on the screen stops the input. */
export class ProgramAccess {
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly done = new Map<string, ProgramInputResult>();

  constructor(private readonly source: Source) {}

  view(command: ViewCommand): Promise<ProgramView> {
    return this.source.lane(command.agentKey, async () => {
      const facts = await this.source.facts(command.agentKey);
      if (!facts) return this.noView(command, 'no_program');
      let pane: Pane;
      try { pane = await this.source.capture(command.agentKey); } catch { return this.noView(command, 'node_unavailable'); }
      if (!boundedPane(pane)) return this.noView(command, 'input_not_proven');
      const snapshot = { token: randomUUID(), instance: facts.instance, at: this.source.now() };
      this.keep(command.agentKey, snapshot);
      const secrets = this.source.secrets();
      return { type: 'program.view', agentKey: command.agentKey, request: command.request, result: 'ok', reason: null, jobId: facts.jobId, instance: facts.instance, snapshot: snapshot.token, state: facts.working ? 'working' : 'idle', ...(facts.completion ? { completion: facts.completion } : {}), tool: facts.tool === null ? null : redact(facts.tool, secrets).slice(0, 100), question: maskedQuestion(facts.question, secrets), input: facts.input, undelivered: facts.undelivered, cols: pane.cols, rows: pane.rows, cells: operatorCells(pane.cells, secrets) };
    });
  }

  /* Another look leaves a fresh one good, but the first input ends every look: whoever types next sees what it did with a
     fresh look first. An action told twice goes once. */
  input(command: InputCommand): Promise<ProgramInputResult> {
    const old = this.done.get(command.action);
    if (old) return Promise.resolve(old);
    return this.source.lane(command.agentKey, async () => {
      const facts = await this.source.facts(command.agentKey);
      const refusal = this.refusal(command, facts);
      if (refusal) return this.finish(command, facts, 'refused', refusal);
      this.snapshots.delete(command.agentKey);
      try {
        if (command.text !== null) await this.source.paste(command.agentKey, command.text);
        if (command.keys.length) await this.source.press(command.agentKey, command.keys);
        return this.finish(command, facts, 'applied', null);
      } catch {
        return this.finish(command, facts, 'unknown', 'action_unknown');
      }
    });
  }

  private refusal(command: InputCommand, facts: ProgramFacts | null): OperatorError | null {
    if (!command.keys.every(key => ProgramKey.safeParse(key).success)) return 'operator_forbidden';
    if (!facts) return 'no_program';
    const snapshot = this.fresh(command.agentKey).find(s => s.token === command.snapshot);
    return snapshot?.instance === facts.instance ? null : 'snapshot_stale';
  }

  private fresh(agentKey: string): Snapshot[] {
    const now = this.source.now();
    return (this.snapshots.get(agentKey) ?? []).filter(s => now - s.at < OPERATOR_SNAPSHOT_MS);
  }

  private keep(agentKey: string, snapshot: Snapshot): void {
    this.snapshots.set(agentKey, [...this.fresh(agentKey), snapshot].slice(-MAX_LOOKS));
  }

  private finish(command: InputCommand, facts: ProgramFacts | null, result: ProgramInputResult['result'], reason: OperatorError | null): ProgramInputResult {
    const secrets = this.source.secrets();
    const reply: ProgramInputResult = { type: 'program.input_result', agentKey: command.agentKey, action: command.action, result, reason, jobId: facts?.jobId ?? null, instance: facts?.instance ?? null, question: maskedQuestion(facts?.question ?? null, secrets), text: command.text === null ? null : operatorCells(command.text, secrets), auditReason: operatorCells(command.auditReason, secrets) };
    if (this.done.size >= MAX_DONE) this.done.delete(this.done.keys().next().value!);
    this.done.set(command.action, reply);
    return reply;
  }

  private noView(command: ViewCommand, reason: OperatorError): ProgramView {
    return { type: 'program.view', agentKey: command.agentKey, request: command.request, result: 'refused', reason, jobId: null, instance: null, snapshot: null, state: 'gone', tool: null, question: null, input: 'unknown', undelivered: false, cols: 1, rows: 1, cells: '' };
  }
}

function maskedQuestion(question: OperatorQuestion | null, secrets: string[]): OperatorQuestion | null {
  return question ? { ...question, tool: question.tool && redact(question.tool, secrets), text: redact(question.text, secrets), callId: question.callId && redact(question.callId, secrets) } : null;
}
