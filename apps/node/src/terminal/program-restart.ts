import { UNHEARD_MS, type ProgramState } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { contentText, isRecord } from '../providers/events.js';
import { flat, pastable } from './left-input.js';
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

const SESSION_FLAGS: Record<Exclude<TermProgram['kind'], 'codex'>, string> = {
  claude: '--resume',
  antigravity: '--conversation',
  kimi: '-S',
};

function placeSessionFlag(command: string[], kind: Exclude<TermProgram['kind'], 'codex'>, flag: string, sessionId: string): void {
  const at = command.findIndex(arg => arg === flag || (kind === 'claude' && arg === '--session-id'));
  if (at >= 0) command.splice(at, 2, flag, sessionId);
  else if (kind === 'antigravity') command.splice(1, 0, flag, sessionId);
  else command.push(flag, sessionId);
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
  placeSessionFlag(command, kind, SESSION_FLAGS[kind], sessionId);
  return command;
}


/* Claude Code keeps words pasted over several lines inside one pair of pasted_content tags, in its queue and in what it
   took. Only that outer pair goes: tags inside the words are theirs. */
const PASTED = /^\s*<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>\s*$/;
const recorded = (text: string) => PASTED.exec(text)?.[2] ?? text;
/* Whether the program's record is these words: as they are, or inside Claude's paste wrapper. */
const same = (words: string, got: string) => flat(words) === flat(got) || flat(words) === flat(recorded(got));
type WordState = 'waiting' | 'queued' | 'held' | 'taken' | 'removed' | 'discarded';
/* typed: the words of a person at the terminal, not of Hornhoof, which never types them again. */
export type WordReceipt = { text: string; jobId: string | null; state: WordState; accepted: boolean; sources: Set<string>; shown?: string | null; operatorDelivery?: OperatorDelivery; typed?: boolean };
type ReceiptHooks = { preserveOriginal?: boolean; original?(phase: 'queued' | 'taken'): void; word?(word: WordReceipt, phase: 'queued' | 'taken' | 'not_taken'): void };

function removeQueued(text: string, enqueued: string[]): string {
  const at = text ? enqueued.findIndex(queued => same(queued, text) || same(text, queued)) : 0;
  return at < 0 ? text : enqueued.splice(at, 1).join('');
}

const withDelivery = (operatorDelivery?: OperatorDelivery) => (operatorDelivery ? { operatorDelivery } : {});
/* An assignment the operator answers for stays until the program's own record shows it taken. */
const originalAfterClear = (original: string[], receipts: ReceiptHooks) => (receipts.preserveOriginal ? original : []);

/* Claude can omit the words from a removal; its queue belongs to the program, across turns. */
export function claudeWordReceipt(line: Record<string, unknown>, enqueued: string[]): { state: 'queued' | 'taken' | 'removed'; text: string } | null {
  if (line.type !== 'queue-operation') return null;
  const text = contentText(line.content);
  if (line.operation === 'enqueue') {
    enqueued.push(text);
    return { state: 'queued', text };
  }
  if (line.operation === 'remove') return { state: line.reason === 'absorbed_mid_turn' ? 'taken' : 'removed', text: removeQueued(text, enqueued) };
  if (line.operation === 'dequeue') removeQueued(text, enqueued);
  return null;
}

/* Claude records the words it took as an entry of the user, as text and nothing else: a tool's output comes as an entry of
   the user too, but as its result, and what Claude itself says is its own. Only these words whole are these words, as
   Claude got them: as tmux pasted them, inside Claude's wrapper of a paste over several lines or not, with their space
   folded, as the receipts of queued words take them. */
export function claudeTook(line: Record<string, unknown>, words: string): boolean {
  const message = userMessage(line);
  return message !== null && onlyText(message.content) && same(pastable(words), contentText(message.content));
}

/* What Claude writes as the user's of its own carries one of these: a note, a sub-agent's prompt, its summary of a
   compacted conversation that only its transcript shows, a note beside a tool call, words of its own queue. */
const CLAUDE_OWN = ['isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'turnCompanion', 'queueTranscriptOnly'] as const;

/* An entry Claude wrote as the user's of its own, which nobody typed, whatever words it holds. */
export const claudeOwn = (line: Record<string, unknown>): boolean => CLAUDE_OWN.some(flag => line[flag] === true);

/* The message of an entry typed into Claude's input, as Claude Code 2.1.318 to 2.1.329 mark it (promptSource typed): not
   one of Claude's own, nor one that says nothing of where it came from. */
function userMessage(line: Record<string, unknown>): Record<string, unknown> | null {
  if (line.type !== 'user' || line.promptSource !== 'typed' || claudeOwn(line) || !isRecord(line.message)) return null;
  return line.message.role === 'user' ? line.message : null;
}

function onlyText(content: unknown): boolean {
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.length > 0 && content.every(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string');
}

/* Keys are not receipts. Keep each live message until the program takes it, including across a restart. */
export class TurnWords {
  private readonly words: WordReceipt[] = [];
  private readonly enqueued: string[] = [];
  private original: string[];
  private replayed: string | null = null;
  private endedAt: number | null = null;

  constructor(words: string[] = [], private readonly receipts: ReceiptHooks = {}) { this.original = words; }

  add(text: string, jobId: string | null = null, operatorDelivery?: OperatorDelivery): WordReceipt {
    const word: WordReceipt = { text, jobId, state: 'waiting', accepted: false, sources: new Set(), ...withDelivery(operatorDelivery) };
    this.words.push(word);
    return word;
  }

  /* Words the owner typed that the program queued: they hold the turn after and open their own, as live words do. */
  addTyped(text: string, jobId: string): void {
    this.words.push({ text: recorded(text), jobId, state: 'queued', accepted: true, sources: new Set(['transcript']), typed: true });
  }

  clear(): void {
    this.original = originalAfterClear(this.original, this.receipts);
  }

  pending(): string[] { return [...this.original, ...this.words.filter(word => this.waiting(word)).map(word => word.text)]; }
  originalPending(): boolean { return this.original.length > 0; }
  held(): WordReceipt[] { return this.words.filter(word => word.state === 'held'); }
  replay(text: string): void { this.replayed = text; this.endedAt = null; }
  end(now: number): void { this.endedAt ??= now; }

  waitingForTurn(now: number): boolean {
    const endedAt = this.endedAt;
    if (endedAt === null) return false;
    return now - endedAt < UNHEARD_MS && this.words.some(word => word.state === 'queued' || word.state === 'held');
  }

  settledJobs(): string[] {
    return [...new Set(this.words.filter(word => word.accepted).map(word => word.jobId).filter((id): id is string => id !== null))];
  }

  settled(): boolean { return this.endedAt !== null && this.pending().length === 0; }

  /* These words wait in the program's queue: taking them is a request of their own. */
  isQueued(text: string): boolean {
    return this.words.some(word => word.state === 'queued' && same(word.text, text));
  }

  removed(text: string): boolean {
    const word = this.words.find(word => this.waiting(word) && same(word.text, text));
    if (!word) return false;
    word.state = 'removed';
    return true;
  }

  queued(text: string, source: string): boolean {
    return this.queuedOriginal(text) || this.queuedWord(text, source);
  }

  private queuedOriginal(text: string): boolean {
    if (!this.receipts.original || !this.original.some(word => same(word, text))) return false;
    this.receipts.original('queued');
    return true;
  }

  private queuedWord(text: string, source: string): boolean {
    const word = this.words.find(word => this.waiting(word) && same(word.text, text) && !word.sources.has(source));
    if (!word) return false;
    word.sources.add(source);
    word.state = 'queued';
    this.told(word, 'queued');
    return true;
  }

  private told(word: WordReceipt, phase: 'queued' | 'taken' | 'not_taken'): void {
    this.receipts.word?.(word, phase);
  }

  taken(text: string): boolean {
    if (this.replayed !== null && same(this.replayed, text)) {
      this.takeReplay();
      return true;
    }
    if (this.takeOriginal(text)) return true;
    const word = this.words.find(word => this.waiting(word) && same(word.text, text));
    if (!word) return false;
    word.state = 'taken';
    this.receipts.word?.(word, 'taken');
    return true;
  }

  private takeReplay(): void {
    for (const word of this.words) if (this.waiting(word)) { word.state = 'taken'; this.receipts.word?.(word, 'taken'); }
    if (this.original.length) this.receipts.original?.('taken');
    this.replayed = null;
    this.original = [];
  }

  takeOriginal(text: string): boolean {
    const original = this.original.findIndex(word => same(word, text));
    if (original < 0) return false;
    this.original.splice(original, 1);
    this.receipts.original?.('taken');
    return true;
  }

  /* The words Hornhoof typed, as it typed them, with the turn they were typed into. */
  takeQueued(text: string): { jobId: string | null; text: string; operatorDelivery?: OperatorDelivery } | null {
    const word = this.words.find(word => this.waiting(word) && same(word.text, text));
    if (!word) return null;
    word.state = 'taken';
    this.told(word, 'taken');
    return { jobId: word.jobId, text: word.text, ...withDelivery(word.operatorDelivery) };
  }

  bind(jobId: string): void {
    for (const word of this.words) word.jobId ??= jobId;
  }

  unheard(now: number, gone = false, idle = true): { text: string; jobId: string | null; reason?: string; operatorDelivery?: OperatorDelivery }[] {
    const expired = gone || (this.endedAt !== null && now - this.endedAt >= UNHEARD_MS);
    return this.words.filter(word => this.returnWords(word, expired, gone || idle)).flatMap(word => this.returned(word));
  }

  private returned(word: WordReceipt) {
    const reason = word.state === 'removed' ? 'the program removed the queued words' : null;
    word.state = 'discarded';
    /* A person who took their words back, or whose words the program kept, has them; Hornhoof does not type them. */
    if (word.typed) return [];
    this.told(word, 'not_taken');
    return [{ text: word.text, jobId: word.jobId, ...(reason ? { reason } : {}), ...withDelivery(word.operatorDelivery) }];
  }

  private returnWords(word: WordReceipt, expired: boolean, idle: boolean): boolean {
    return word.accepted && this.waiting(word) && (word.state === 'removed' || (expired && (idle || word.state !== 'queued')));
  }

  observe(kind: TermProgram['kind'], line: Record<string, unknown>, turnId?: string): void {
    if (kind === 'claude') this.claude(line);
    if (kind === 'kimi' && (line.agentId === undefined || line.agentId === 'main')) {
      if (line.type === 'prompt.steered') this.queued(contentText(line.input ?? line.prompt), 'wire');
      if (line.type === 'turn.steer' && (!turnId || line.turnId === undefined || String(line.turnId) === turnId)) this.taken(contentText(line.input));
      /* Kimi 2.6.3 takes steered words by going on with them in a turn of its own. */
      if (line.type === 'turn.prompt' && line.trigger === 'notify') this.taken(contentText(line.input));
    }
    const p = isRecord(line.payload) ? line.payload : {};
    if (kind === 'codex' && line.type === 'event_msg' && p.type === 'item_completed' && isRecord(p.item) && p.item.type === 'UserMessage'
      && (!turnId || p.turn_id === undefined || p.turn_id === turnId)) this.taken(contentText(p.item.content));
  }

  private claude(line: Record<string, unknown>): void {
    const receipt = claudeWordReceipt(line, this.enqueued);
    if (receipt?.state === 'queued') this.queued(receipt.text, 'transcript');
    if (receipt?.state === 'taken') this.taken(receipt.text);
  }

  private waiting(word: WordReceipt): boolean { return word.state !== 'taken' && word.state !== 'discarded'; }
}
