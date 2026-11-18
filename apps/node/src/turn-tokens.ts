import type { TurnTokens } from '@hornhoof/protocol';

/* The tokens a turn used, as its program reports them. Input is what the model read anew, the cache what it read from its
   cache and wrote there, the total all it read and wrote. A count the program does not tell stays null, and a report
   with none is no data: Hornhoof never makes a count up. */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const sum = (...counts: (number | null)[]): number | null => (counts.some(n => n !== null) ? counts.reduce<number>((a, n) => a + (n ?? 0), 0) : null);

function told(tokens: TurnTokens): TurnTokens | null {
  return tokens.input === null && tokens.output === null && tokens.cacheRead === null && tokens.cacheWrite === null ? null : tokens;
}

/* Anthropic's usage, which Claude Code reports: its input leaves out what came from the cache. */
export function anthropicTokens(usage: unknown): TurnTokens | null {
  if (!isRecord(usage)) return null;
  const input = count(usage.input_tokens), output = count(usage.output_tokens), cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
  return told({ input, output, cacheRead, cacheWrite, total: sum(input, output, cacheRead, cacheWrite) });
}

/* OpenAI's usage, which Codex reports: its input counts the cached part too. */
export function openaiTokens(usage: unknown): TurnTokens | null {
  if (!isRecord(usage)) return null;
  const read = count(usage.input_tokens), cacheRead = count(usage.cached_input_tokens), output = count(usage.output_tokens);
  const input = read === null ? null : Math.max(0, read - (cacheRead ?? 0));
  return told({ input, output, cacheRead, cacheWrite: count(usage.cache_write_input_tokens), total: sum(read, output) });
}

/* Antigravity's: its input counts what it read from the cache, its output its thinking, and it tells its total itself. */
export function agyTokens(usage: unknown): TurnTokens | null {
  if (!isRecord(usage)) return null;
  const read = count(usage.input_tokens), cacheRead = count(usage.cache_read_tokens), output = count(usage.output_tokens);
  const input = read === null ? null : Math.max(0, read - (cacheRead ?? 0));
  return told({ input, output, cacheRead, cacheWrite: null, total: count(usage.total_tokens) ?? sum(read, output) });
}

/* A model's name as a turn's tokens carry it: a program's word that is no name, or one too long, names none. */
export const modelName = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null);

/* The turn's tokens with the model it ran on: the one its program told, else the one the turn asked for. */
export function withModel(tokens: TurnTokens | null | undefined, model: unknown): TurnTokens | null {
  const named = modelName(model);
  if (!tokens || tokens.model || !named) return tokens ?? null;
  return { ...tokens, model: named };
}

/* The model a line of Claude Code's output says it runs: its start, or a message of the model. */
export function claudeModel(line: Record<string, unknown>, before: string | null): string | null {
  const model = line.type === 'system' ? line.model : isRecord(line.message) ? line.message.model : null;
  return modelName(model) ?? before;
}

/* Both turns' counts together, null where neither told one. */
export function addTokens(a: TurnTokens | null, b: TurnTokens | null): TurnTokens | null {
  if (!a || !b) return a ?? b;
  return { input: sum(a.input, b.input), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite), total: sum(a.total, b.total) };
}

/* What a turn in a live terminal used, from its program's log as the node reads it: Claude Code's messages, each once
   though its log repeats one for every block, or each of Codex's calls since its last turn started, a repeated report
   counted once. */
export class TurnTally {
  private messages = new Map<string, TurnTokens>();
  private codex: TurnTokens | null = null;
  private codexTotal = -1;
  private model: string | null = null;

  begin(): void {
    this.messages.clear();
    this.codex = null;
    this.model = null;
  }

  claudeLine(line: unknown): void {
    if (!isRecord(line) || line.type !== 'assistant' || !isRecord(line.message) || typeof line.message.id !== 'string') return;
    this.model = claudeModel(line, this.model);
    const tokens = anthropicTokens(line.message.usage);
    if (tokens) this.messages.set(line.message.id, tokens);
  }

  codexLine(line: unknown): void {
    /* Codex names the model of each turn in its turn context, also the one it picked by itself when Hornhoof named none. */
    if (isRecord(line) && line.type === 'turn_context' && isRecord(line.payload)) {
      this.model = modelName(line.payload.model) ?? this.model;
      return;
    }
    if (!isRecord(line) || (line.type !== 'event_msg' && line.type !== 'session_meta') || !isRecord(line.payload)) return;
    if (line.type === 'session_meta') {
      /* A session's log of its own counts from nothing. */
      this.codexTotal = -1;
      return;
    }
    const { payload } = line;
    if (payload.type === 'task_started') this.codex = null;
    if (payload.type !== 'token_count' || !isRecord(payload.info) || !isRecord(payload.info.total_token_usage)) return;
    const total = count(payload.info.total_token_usage.total_tokens);
    if (total === null || total <= this.codexTotal) return;
    this.codexTotal = total;
    this.codex = addTokens(this.codex, openaiTokens(payload.info.last_token_usage));
  }

  tokens(): TurnTokens | null {
    return withModel([...this.messages.values()].reduce<TurnTokens | null>(addTokens, null) ?? this.codex, this.model);
  }
}
