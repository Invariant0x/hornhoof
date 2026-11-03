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


/* A cleared composer only acknowledges keys. These words wait for the program's own record of taking each message. */
export class TurnWords {
  private readonly queued: string[] = [];
  constructor(private words: string[] = []) {}

  add(text: string): void { this.words.push(text); }
  clear(): void { this.words = []; }
  pending(): string[] { return [...this.words]; }

  observe(kind: TermProgram['kind'], line: Record<string, unknown>): void {
    if (kind === 'claude' && line.type === 'queue-operation') {
      if (line.operation === 'enqueue') this.queued.push(contentText(line.content));
      if (line.operation === 'remove' && line.reason === 'absorbed_mid_turn') this.taken(this.queued.shift() ?? '');
    }
    if (kind === 'kimi' && line.type === 'turn.steer' && (line.agentId === undefined || line.agentId === 'main')) this.taken(contentText(line.input));
    const p = isRecord(line.payload) ? line.payload : {};
    if (kind === 'codex' && line.type === 'event_msg' && p.type === 'item_completed' && isRecord(p.item) && p.item.type === 'UserMessage') this.taken(contentText(p.item.content));
  }

  private taken(text: string): void {
    const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
    const at = this.words.findIndex(word => flat(word) === flat(text));
    if (at >= 0) this.words.splice(at, 1);
  }
}
