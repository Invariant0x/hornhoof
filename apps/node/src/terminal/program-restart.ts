import type { ProgramState } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { contentText, isRecord } from '../providers/events.js';
import type { TermProgram } from './programs.js';

export type RestartEvidence = {
  jobId: string | null; kind: TermProgram['kind']; state: ProgramState; calls: number; question: boolean;
  signAt: number; sessionId: string | null; restarted: boolean;
};

export function restartRefusal(a: RestartEvidence | null, jobId: string, now: number): string | null {
  if (!a) return 'No turn runs for this agent.';
  if (a.jobId !== jobId) return 'A different turn runs for this agent.';
  if (a.restarted) return 'This turn already restarted its program.';
  if (a.calls) return 'A tool is running.';
  if (a.question) return 'The program is asking a person.';
  if (a.state !== 'thinking' && a.state !== 'retrying') return 'The program is not thinking or retrying.';
  const after = RESTART_AFTER_MS[a.kind];
  if (after === null) return 'This program cannot be restarted.';
  if (now - a.signAt < after) return 'The program gave a sign of life too recently.';
  if (!a.sessionId) return 'The session is not known.';
  return null;
}

/* Resume with every original flag, without adding an instructions file that the first launch did not have. */
export function resumeCommand(kind: TermProgram['kind'], original: string[], sessionId: string): string[] {
  const command = [...original];
  if (kind === 'codex') {
    if (command[1] === 'resume') { command[2] = sessionId; return command; }
    const cwd = command.indexOf('-C');
    if (cwd >= 0) command.splice(cwd, 2);
    command.splice(1, 0, 'resume', sessionId);
    return command;
  }
  const flag = kind === 'claude' ? '--resume' : '-S';
  const at = command.findIndex(arg => arg === flag || (kind === 'claude' && arg === '--session-id'));
  if (at >= 0) command.splice(at, 2, flag, sessionId);
  else command.push(flag, sessionId);
  return command;
}


export const UNHEARD_MS = 15_000;
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
type WordState = 'waiting' | 'queued' | 'held' | 'taken' | 'discarded';
export type WordReceipt = { text: string; jobId: string | null; state: WordState; accepted: boolean; sources: Set<string> };

/* Keys are not receipts. Keep each live message until the program takes it, including across a restart. */
export class TurnWords {
  private readonly words: WordReceipt[] = [];
  private readonly enqueued: string[] = [];
  private original: string[];
  private replayed: string | null = null;
  private endedAt: number | null = null;

  constructor(words: string[] = []) { this.original = words; }

  add(text: string, jobId: string | null = null): WordReceipt {
    const word: WordReceipt = { text, jobId, state: 'waiting', accepted: false, sources: new Set() };
    this.words.push(word);
    return word;
  }

  clear(): void {
    this.original = [];
  }

  pending(): string[] { return [...this.original, ...this.words.filter(word => this.waiting(word)).map(word => word.text)]; }
  replay(text: string): void { this.replayed = text; this.endedAt = null; }
  end(now: number): void { this.endedAt ??= now; }

  queued(text: string, source: string): boolean {
    const word = this.words.find(word => this.waiting(word) && flat(word.text) === flat(text) && !word.sources.has(source));
    if (!word) return false;
    word.sources.add(source);
    word.state = 'queued';
    return true;
  }

  taken(text: string): boolean {
    if (this.replayed !== null && flat(this.replayed) === flat(text)) {
      for (const word of this.words) if (this.waiting(word)) word.state = 'taken';
      this.replayed = null;
      this.clear();
      return true;
    }
    const original = this.original.findIndex(word => flat(word) === flat(text));
    if (original >= 0) { this.original.splice(original, 1); return true; }
    const word = this.words.find(word => this.waiting(word) && flat(word.text) === flat(text));
    if (!word) return false;
    word.state = 'taken';
    return true;
  }

  takeQueued(text: string): { jobId: string | null } | null {
    const word = this.words.find(word => this.waiting(word) && flat(word.text) === flat(text));
    if (!word) return null;
    word.state = 'taken';
    return { jobId: word.jobId };
  }

  bind(jobId: string): void {
    for (const word of this.words) word.jobId ??= jobId;
  }

  unheard(now: number, gone = false): { text: string; jobId: string | null }[] {
    if (!gone && (this.endedAt === null || now - this.endedAt < UNHEARD_MS)) return [];
    return this.words.filter(word => word.accepted && this.waiting(word)).map(word => {
      word.state = 'discarded';
      return { text: word.text, jobId: word.jobId };
    });
  }

  observe(kind: TermProgram['kind'], line: Record<string, unknown>, turnId?: string): void {
    if (kind === 'claude') this.claude(line);
    if (kind === 'kimi' && (line.agentId === undefined || line.agentId === 'main')) {
      if (line.type === 'prompt.steered') this.queued(contentText(line.input ?? line.prompt), 'wire');
      if (line.type === 'turn.steer' && (!turnId || line.turnId === undefined || String(line.turnId) === turnId)) this.taken(contentText(line.input));
    }
    const p = isRecord(line.payload) ? line.payload : {};
    if (kind === 'codex' && line.type === 'event_msg' && p.type === 'item_completed' && isRecord(p.item) && p.item.type === 'UserMessage'
      && (!turnId || p.turn_id === undefined || p.turn_id === turnId)) this.taken(contentText(p.item.content));
  }

  private claude(line: Record<string, unknown>): void {
    if (line.type !== 'queue-operation') return;
    if (line.operation === 'enqueue') {
      const text = contentText(line.content);
      this.enqueued.push(text);
      this.queued(text, 'transcript');
    }
    if (line.operation === 'remove' && line.reason === 'absorbed_mid_turn') this.taken(this.enqueued.shift() ?? contentText(line.content));
    if (line.operation === 'dequeue') this.enqueued.shift();
  }

  private waiting(word: WordReceipt): boolean { return word.state !== 'taken' && word.state !== 'discarded'; }
}
