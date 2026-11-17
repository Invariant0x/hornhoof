import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELLO_IDS_BEFORE_ACKS, HELLO_IDS_MAX, parseNodeMessage, type NodeMessage } from '@hornhoof/protocol';
import { z } from 'zod';

export const OUTBOX_FILE = 'outbox.jsonl';
const OUTBOX_MAX = 20_000;
const FLUSH_MS = 1000;

export type End = Extract<NodeMessage, { type: 'job.done' | 'tests.done' }>;
export type Entry = { n: number; msg: NodeMessage };

/* One line of the file. A stream line opens it and keeps the next number across a rewrite; a hold line is an end that
   has no number yet; an add line is a numbered message. */
type Line = { k: 'stream'; stream: string; next: number } | { k: 'hold'; msg: End } | { k: 'add'; n: number; msg: NodeMessage };

export const isEnd = (m: NodeMessage): m is End => m.type === 'job.done' || m.type === 'tests.done';
export const endId = (m: End): string => (m.type === 'job.done' ? m.jobId : m.partId);

const StreamLine = z.object({ k: z.literal('stream'), stream: z.uuid(), next: z.number().int().min(1) });
const NumberedLine = z.object({ k: z.literal('add'), n: z.number().int().min(1), msg: z.unknown() });
const HoldLine = z.object({ k: z.literal('hold'), msg: z.unknown() });

const asMessage = (value: unknown): NodeMessage | null => parseNodeMessage(JSON.stringify(value));

/* A line of the file, or null when it is cut short or is not one this node wrote. */
export function parseLine(text: string): Line | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const stream = StreamLine.safeParse(data);
  if (stream.success) return stream.data;
  const add = NumberedLine.safeParse(data);
  const added = add.success ? asMessage(add.data.msg) : null;
  if (add.success && added) return { k: 'add', n: add.data.n, msg: added };
  const hold = HoldLine.safeParse(data);
  const held = hold.success ? asMessage(hold.data.msg) : null;
  return held && isEnd(held) ? { k: 'hold', msg: held } : null;
}

/* The oldest message the cap may drop: a job.event first, else any that is not an end; none when only ends are left. */
function evictable(entries: Entry[]): number {
  const event = entries.findIndex(e => e.msg.type === 'job.event');
  return event >= 0 ? event : entries.findIndex(e => !isEnd(e.msg));
}

type OutboxOptions = { max?: number; flushMs?: number; onError?: (err: unknown) => void };

/* The messages a node has not had confirmed, in its volume. Each message that changes the company's data gets the next
   number of the stream and stays until the server confirms it, so a restart of the node or of the server loses none.
   The file is appended a line per change, and rewritten when something was dropped, at most once per flushMs. */
export class Outbox {
  readonly stream: string;
  private entries: Entry[] = [];
  private readonly held_ = new Map<string, End>();
  private next = 1;
  /* Dropped entries whose lines are still in the file. */
  private stale = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;
  private readonly max: number;
  private readonly flushMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(dir: string, opts: OutboxOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, OUTBOX_FILE);
    this.max = opts.max ?? OUTBOX_MAX;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    this.onError = opts.onError ?? (() => {});
    const found = this.load();
    this.stream = found ?? randomUUID();
    if (!found) this.rewrite();
  }

  /* The next number goes on the message, and the message is kept. */
  add(msg: NodeMessage): Entry {
    const entry = { n: this.next, msg: { ...msg, n: this.next } as NodeMessage };
    this.insert(entry);
    this.append({ k: 'add', n: entry.n, msg: entry.msg });
    return entry;
  }

  /* A job's or a part's end from the moment it leaves running, before its turn to be sent. The first end of an id stays. */
  hold(end: End): void {
    const id = endId(end);
    if (this.held_.has(id) || this.ends().some(e => endId(e) === id)) return;
    this.held_.set(id, end);
    this.append({ k: 'hold', msg: end });
  }

  number(id: string): Entry | null {
    const end = this.held_.get(id);
    return end ? this.add(end) : null;
  }

  held(): string[] {
    return [...this.held_.keys()];
  }

  pending(): Entry[] {
    return [...this.entries];
  }

  /* Whether a numbered message of this type still waits to be confirmed. */
  owes(type: NodeMessage['type']): boolean {
    return this.entries.some(e => e.msg.type === type);
  }

  ack(upto: number): void {
    this.entries = this.entries.filter(e => e.n > upto);
    this.dirty();
  }

  ackJob(jobId: string): void {
    this.dropEnd('job.done', jobId);
  }

  ackPart(partId: string): void {
    this.dropEnd('tests.done', partId);
  }

  /* An older server confirms nothing: what was sent is gone, but for the ends, which wait for their own ack. */
  dropSent(upto: number): void {
    this.entries = this.entries.filter(e => e.n > upto || isEnd(e.msg));
    this.dirty();
  }

  doneJobs(): string[] {
    return this.ends().flatMap(e => (e.type === 'job.done' ? [e.jobId] : []));
  }

  doneParts(): string[] {
    return this.ends().flatMap(e => (e.type === 'tests.done' ? [e.partId] : []));
  }

  /* Writes what waits for its rewrite. */
  close(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.rewrite();
  }

  private ends(): End[] {
    return [...this.held_.values(), ...this.entries.map(e => e.msg).filter(isEnd)];
  }

  private dropEnd(type: End['type'], id: string): void {
    const is = (m: NodeMessage) => m.type === type && endId(m as End) === id;
    if (this.held_.get(id)?.type === type) this.held_.delete(id);
    this.entries = this.entries.filter(e => !is(e.msg));
    this.dirty();
  }

  private insert(entry: Entry): void {
    this.entries.push(entry);
    this.next = Math.max(this.next, entry.n + 1);
    if (isEnd(entry.msg)) this.held_.delete(endId(entry.msg));
    this.cap();
  }

  private cap(): void {
    for (let at = evictable(this.entries); this.entries.length > this.max && at >= 0; at = evictable(this.entries)) {
      this.entries.splice(at, 1);
      this.stale++;
    }
    if (this.stale >= this.max) this.dirty();
  }

  /* Reads the file, cuts off a last line that was left half written, and gives the stream it names. */
  private load(): string | null {
    if (!existsSync(this.path)) return null;
    const raw = readFileSync(this.path);
    let stream: string | null = null;
    let good = 0;
    for (let start = 0, end = raw.indexOf(10); end >= 0; start = end + 1, end = raw.indexOf(10, start)) {
      const line = parseLine(raw.toString('utf8', start, end));
      if (!line) continue;
      stream = this.replay(line, stream);
      good = end + 1;
    }
    if (raw.length > good) truncateSync(this.path, good);
    if (!stream) this.forget();
    return stream;
  }

  private replay(line: Line, stream: string | null): string | null {
    if (line.k === 'stream') this.next = Math.max(this.next, line.next);
    if (line.k === 'hold') this.held_.set(endId(line.msg), line.msg);
    if (line.k === 'add') this.insert({ n: line.n, msg: line.msg });
    return line.k === 'stream' ? (stream ?? line.stream) : stream;
  }

  /* A file with no stream line is not one this node can trust: it starts over. */
  private forget(): void {
    this.entries = [];
    this.held_.clear();
    this.next = 1;
  }

  private dirty(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushMs);
    this.timer.unref();
  }

  private flush(): void {
    this.timer = null;
    this.rewrite();
  }

  private append(line: Line): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      this.failed(err);
    }
  }

  /* To a temporary file, then a rename, so a crash leaves the old file or the new one whole. */
  private rewrite(): void {
    const lines: Line[] = [
      { k: 'stream', stream: this.stream, next: this.next },
      ...[...this.held_.values()].map((msg): Line => ({ k: 'hold', msg })),
      ...this.entries.map((e): Line => ({ k: 'add', n: e.n, msg: e.msg })),
    ];
    const temp = `${this.path}.tmp`;
    try {
      writeFileSync(temp, lines.map(l => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
      renameSync(temp, this.path);
      this.stale = 0;
    } catch (err) {
      this.failed(err);
    }
  }

  /* Memory still has it all, and a write that failed may have left a line cut short or no stream line: the next rewrite
     puts the file right, whole. */
  private failed(err: unknown): void {
    this.onError(err);
    this.dirty();
  }
}

/* Everything numbered that Hornhoof has not confirmed, in order, ends that were still held included, for as long as the
   socket takes them. A server that confirms nothing gets each once, so what really went is dropped and no more. */
export function sendPending(outbox: Outbox, next: (m: NodeMessage) => boolean, confirmed: boolean): void {
  for (const id of outbox.held()) outbox.number(id);
  let last = 0;
  for (const entry of outbox.pending()) {
    if (!next(entry.msg)) break;
    last = entry.n;
  }
  if (!confirmed && last) outbox.dropSent(last);
}

/* The ids of a hello: the runs still going, then those whose ends wait. A server drops a hello past its bound, and the
   node would get no more work, so the list stops there, with the runs still going kept. */
export function helloIds(active: string[], ended: string[], confirming: boolean): string[] {
  return [...new Set([...active, ...ended])].slice(0, confirming ? HELLO_IDS_MAX : HELLO_IDS_BEFORE_ACKS);
}

/* What waited was for the node as it was. Sent by the node it is now, an old removed would revoke its new key. */
export function clearOutbox(dir: string): void {
  for (const file of [OUTBOX_FILE, `${OUTBOX_FILE}.tmp`]) rmSync(join(dir, file), { force: true });
}
