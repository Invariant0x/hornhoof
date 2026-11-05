import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELLO_IDS_BEFORE_ACKS, HELLO_IDS_MAX, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { clearOutbox, endId, helloIds, isEnd, Outbox, OUTBOX_FILE, parseLine, sendPending, type End } from '../src/outbox.js';

/* A disk that fills up in the middle of a line: the next append writes part of its line, then fails. */
const disk = vi.hoisted(() => ({ tearNext: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  const tearing: typeof fs.appendFileSync = (path, data, options) => {
    if (!disk.tearNext) return fs.appendFileSync(path, data, options);
    disk.tearNext = false;
    fs.appendFileSync(path, String(data).slice(0, 12), options);
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  };
  return { ...fs, appendFileSync: tearing };
});

const folder = () => mkdtempSync(join(tmpdir(), 'hh-outbox-'));
const event = (seq: number): NodeMessage => ({ type: 'job.event', jobId: 'job-1', seq, event: { kind: 'text', text: `line ${seq}` } });
const jobEnd = (jobId: string): End => ({ type: 'job.done', jobId, ok: true, sessionId: null, result: '', tail: '', error: null });
const testEnd = (partId: string): End => ({ type: 'tests.done', partId, ok: true, exitCode: 0, error: null, commit: null, log: '' });
const numbers = (box: Outbox) => box.pending().map(e => e.n);

describe('Outbox', () => {
  it('numbers messages and keeps them across a restart', () => {
    const dir = folder();
    const first = new Outbox(dir);
    for (let seq = 0; seq < 3; seq++) first.add(event(seq));
    const second = new Outbox(dir);
    expect(second.stream).toBe(first.stream);
    expect(numbers(second)).toEqual([1, 2, 3]);
    expect(second.pending()[2]!.msg).toMatchObject({ type: 'job.event', seq: 2, n: 3 });
    expect(second.add(event(3)).n).toBe(4);
  });

  it('starts a new stream with a new file', () => {
    expect(new Outbox(folder()).stream).not.toBe(new Outbox(folder()).stream);
  });

  it('drops what the server confirmed', () => {
    const dir = folder();
    const box = new Outbox(dir);
    for (let seq = 0; seq < 3; seq++) box.add(event(seq));
    box.ack(2);
    expect(numbers(box)).toEqual([3]);
    box.close();
    expect(numbers(new Outbox(dir))).toEqual([3]);
  });

  it('never reuses a number once every entry was confirmed', () => {
    const dir = folder();
    const box = new Outbox(dir);
    box.add(event(0));
    box.add(event(1));
    box.ack(2);
    box.close();
    const again = new Outbox(dir);
    expect(again.pending()).toEqual([]);
    expect(again.add(event(2)).n).toBe(3);
  });

  it('numbers a held end when its turn comes', () => {
    const dir = folder();
    const box = new Outbox(dir);
    box.hold(jobEnd('job-9'));
    expect(box.doneJobs()).toEqual(['job-9']);
    expect(box.add(event(0)).n).toBe(1);
    expect(numbers(new Outbox(dir))).toEqual([1]);
    expect(new Outbox(dir).held()).toEqual(['job-9']);
    const numbered = box.number('job-9');
    expect(numbered).toMatchObject({ n: 2, msg: { type: 'job.done', jobId: 'job-9', n: 2 } });
    expect(box.held()).toEqual([]);
    expect(box.doneJobs()).toEqual(['job-9']);
    expect(box.number('job-9')).toBeNull();
    const reopened = new Outbox(dir);
    expect(numbers(reopened)).toEqual([1, 2]);
    expect(reopened.held()).toEqual([]);
  });

  it('holds the first end of a job and ignores a second one', () => {
    const box = new Outbox(folder());
    box.hold(jobEnd('job-1'));
    box.hold({ ...jobEnd('job-1'), ok: false });
    expect(box.number('job-1')!.msg).toMatchObject({ ok: true });
    box.hold(jobEnd('job-1'));
    expect(box.held()).toEqual([]);
  });

  it("keeps a job's end until either ack", () => {
    const box = new Outbox(folder());
    box.add(event(0));
    const job = box.number(endOf(box, jobEnd('job-1')))!;
    const part = box.number(endOf(box, testEnd('part-1')))!;
    box.ack(job.n - 1);
    expect(numbers(box)).toEqual([job.n, part.n]);
    box.ackJob('job-1');
    expect(numbers(box)).toEqual([part.n]);
    box.ackJob('part-1');
    expect(numbers(box)).toEqual([part.n]);
    box.ackPart('part-1');
    expect(numbers(box)).toEqual([]);
  });

  it('drops a held end on its own ack', () => {
    const box = new Outbox(folder());
    box.hold(jobEnd('job-1'));
    box.hold(testEnd('part-1'));
    box.ackJob('job-1');
    box.ackPart('part-1');
    expect(box.held()).toEqual([]);
    expect(box.doneJobs()).toEqual([]);
    expect(box.doneParts()).toEqual([]);
  });

  it('lists the jobs and the parts whose ends it holds or numbered', () => {
    const box = new Outbox(folder());
    box.hold(jobEnd('job-1'));
    box.hold(testEnd('part-1'));
    box.number('part-1');
    expect(box.doneJobs()).toEqual(['job-1']);
    expect(box.doneParts()).toEqual(['part-1']);
  });

  it('drops live messages when it talks to an older server', () => {
    const box = new Outbox(folder());
    box.add(event(0));
    const end = box.number(endOf(box, jobEnd('job-1')))!;
    box.add(event(1));
    box.add(event(2));
    box.add(event(3));
    box.dropSent(3);
    expect(numbers(box)).toEqual([end.n, 4, 5]);
  });

  it('writes the file for its owner only', () => {
    const dir = folder();
    const box = new Outbox(dir);
    box.add(event(0));
    box.ack(1);
    box.close();
    expect(statSync(join(dir, OUTBOX_FILE)).mode & 0o777).toBe(0o600);
  });

  it('caps the outbox by its oldest events, never an end', () => {
    const box = new Outbox(folder(), { max: 10 });
    for (let i = 0; i < 5; i++) box.number(endOf(box, jobEnd(`job-${i}`)));
    for (let seq = 0; seq < 15; seq++) box.add(event(seq));
    const kept = box.pending();
    expect(kept.filter(e => isEnd(e.msg))).toHaveLength(5);
    expect(kept.filter(e => e.msg.type === 'job.event').map(e => (e.msg as { seq: number }).seq)).toEqual([10, 11, 12, 13, 14]);
  });

  it('keeps every end even when the ends alone are past the cap', () => {
    const box = new Outbox(folder(), { max: 10 });
    for (let seq = 0; seq < 15; seq++) box.add(event(seq));
    for (let i = 0; i < 60; i++) box.number(endOf(box, i % 2 ? jobEnd(`job-${i}`) : testEnd(`part-${i}`)));
    expect(box.pending()).toHaveLength(60);
    expect(box.pending().every(e => isEnd(e.msg))).toBe(true);
  });

  it('drops other numbered messages when no event is left to drop', () => {
    const box = new Outbox(folder(), { max: 2 });
    box.add({ type: 'job.started', jobId: 'a' });
    box.add({ type: 'job.started', jobId: 'b' });
    box.add({ type: 'job.started', jobId: 'c' });
    expect(box.pending().map(e => (e.msg as { jobId: string }).jobId)).toEqual(['b', 'c']);
  });

  it('keeps the file small while the cap drops events', () => {
    const dir = folder();
    const box = new Outbox(dir, { max: 5, flushMs: 0 });
    for (let seq = 0; seq < 40; seq++) box.add(event(seq));
    box.close();
    expect(readFileSync(join(dir, OUTBOX_FILE), 'utf8').trim().split('\n').length).toBeLessThanOrEqual(1 + 5 + 5);
  });

  it('recovers from a line cut short', () => {
    const dir = folder();
    const box = new Outbox(dir);
    for (let seq = 0; seq < 3; seq++) box.add(event(seq));
    appendFileSync(join(dir, OUTBOX_FILE), '{"k":"add","n":4,"msg":{"type":"job.ev');
    const second = new Outbox(dir);
    expect(numbers(second)).toEqual([1, 2, 3]);
    expect(second.add(event(3)).n).toBe(4);
    const third = new Outbox(dir);
    expect(numbers(third)).toEqual([1, 2, 3, 4]);
    expect(third.pending()[3]!.msg).toMatchObject({ seq: 3 });
  });

  it('cuts off a last line that is not JSON even with its newline', () => {
    const dir = folder();
    const box = new Outbox(dir);
    box.add(event(0));
    appendFileSync(join(dir, OUTBOX_FILE), 'not json\n');
    expect(numbers(new Outbox(dir))).toEqual([1]);
    box.add(event(1));
    expect(numbers(new Outbox(dir))).toEqual([1, 2]);
  });
});

describe('Outbox on its own timer', () => {
  const FLUSH_MS = 1000;
  const manualTimers = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
  };
  const lines = (dir: string) => readFileSync(join(dir, OUTBOX_FILE), 'utf8').trim().split('\n').length;

  it('shrinks the file after each drop with no close, so a long-running node replays nothing it had confirmed', () => {
    manualTimers();
    const dir = folder();
    const box = new Outbox(dir, { flushMs: FLUSH_MS });
    for (let seq = 0; seq < 3; seq++) box.add(event(seq));
    box.ack(2);
    expect(lines(dir)).toBe(4);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(lines(dir)).toBe(2);
    expect(numbers(new Outbox(dir))).toEqual([3]);

    box.add(event(3));
    box.add(event(4));
    box.ack(4);
    expect(lines(dir)).toBe(4);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(lines(dir)).toBe(2);
    expect(numbers(new Outbox(dir))).toEqual([5]);
  });

  it('writes the file whole once a first write that failed can go through, so a restart keeps its stream and messages', () => {
    manualTimers();
    const dir = folder();
    const temp = join(dir, `${OUTBOX_FILE}.tmp`);
    /* A folder where the temporary file goes fails every rewrite until it is gone, as a full disk does until there is room. */
    mkdirSync(temp);
    const errors: unknown[] = [];
    const box = new Outbox(dir, { flushMs: FLUSH_MS, onError: err => errors.push(err) });
    box.add(event(0));
    expect(errors).toHaveLength(1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(errors).toHaveLength(2);
    rmdirSync(temp);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(errors).toHaveLength(2);
    const again = new Outbox(dir);
    expect(again.stream).toBe(box.stream);
    expect(numbers(again)).toEqual([1]);
  });

  it('writes the file whole after a line cut short by a full disk, so neither that line nor the next is lost', () => {
    manualTimers();
    const dir = folder();
    const errors: unknown[] = [];
    const box = new Outbox(dir, { flushMs: FLUSH_MS, onError: err => errors.push(err) });
    box.add(event(0));
    disk.tearNext = true;
    box.add(event(1));
    box.add(event(2));
    expect(errors).toHaveLength(1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(numbers(new Outbox(dir))).toEqual([1, 2, 3]);
  });

  it('writes a line cut short whole on close too', () => {
    manualTimers();
    const dir = folder();
    const box = new Outbox(dir, { flushMs: FLUSH_MS });
    box.add(event(0));
    disk.tearNext = true;
    box.add(event(1));
    box.close();
    expect(numbers(new Outbox(dir))).toEqual([1, 2]);
  });
});

describe('sendPending', () => {
  const filled = (count: number) => {
    const box = new Outbox(folder());
    for (let seq = 0; seq < count; seq++) box.add(event(seq));
    return box;
  };
  /* A socket that takes this many messages and then has closed. */
  const socketFor = (takes: number) => {
    const sent: (number | undefined)[] = [];
    const next = (m: NodeMessage) => {
      if (sent.length >= takes) return false;
      sent.push((m as { n?: number }).n);
      return true;
    };
    return { sent, next };
  };

  it('drops only what really went when an older server closes partway through', () => {
    const box = filled(5);
    const socket = socketFor(2);
    sendPending(box, socket.next, false);
    expect(socket.sent).toEqual([1, 2]);
    expect(numbers(box)).toEqual([3, 4, 5]);
  });

  it('drops nothing when the socket took nothing', () => {
    const box = filled(2);
    sendPending(box, socketFor(0).next, false);
    expect(numbers(box)).toEqual([1, 2]);
  });

  it('keeps what a confirming server was sent until it says so', () => {
    const box = filled(3);
    const socket = socketFor(3);
    sendPending(box, socket.next, true);
    expect(socket.sent).toEqual([1, 2, 3]);
    expect(numbers(box)).toEqual([1, 2, 3]);
  });

  it('numbers the ends still held and sends them after the rest', () => {
    const box = filled(1);
    box.hold(jobEnd('job-1'));
    const socket = socketFor(5);
    sendPending(box, socket.next, true);
    expect(socket.sent).toEqual([1, 2]);
    expect(box.held()).toEqual([]);
  });

  it('keeps an end for its own ack when an older server was sent it', () => {
    const box = filled(1);
    box.hold(jobEnd('job-1'));
    sendPending(box, socketFor(5).next, false);
    expect(box.doneJobs()).toEqual(['job-1']);
    expect(numbers(box)).toEqual([2]);
  });
});

describe('helloIds', () => {
  const ids = (name: string, count: number) => Array.from({ length: count }, (_, i) => `${name}-${i}`);

  it('lists all a confirming server can take', () => {
    expect(helloIds(ids('run', 3), ids('end', 150), true)).toEqual([...ids('run', 3), ...ids('end', 150)]);
  });

  it('stops at the bound of the protocol', () => {
    expect(helloIds(ids('run', 3), ids('end', HELLO_IDS_MAX), true)).toHaveLength(HELLO_IDS_MAX);
  });

  it('caps at what an older server takes, the runs still going first', () => {
    const listed = helloIds(ids('run', 3), ids('end', 150), false);
    expect(listed).toEqual([...ids('run', 3), ...ids('end', HELLO_IDS_BEFORE_ACKS - 3)]);
  });

  it('counts an id once', () => {
    expect(helloIds(['a', 'b', 'a'], ['b', 'c'], true)).toEqual(['a', 'b', 'c']);
  });
});

describe('clearOutbox', () => {
  it('forgets what waited, and a new outbox starts a new stream', () => {
    const dir = folder();
    const box = new Outbox(dir);
    box.add(event(0));
    mkdirSync(join(dir, 'other'));
    appendFileSync(join(dir, `${OUTBOX_FILE}.tmp`), 'half a rewrite');
    clearOutbox(dir);
    expect(existsSync(join(dir, OUTBOX_FILE))).toBe(false);
    expect(existsSync(join(dir, `${OUTBOX_FILE}.tmp`))).toBe(false);
    const again = new Outbox(dir);
    expect(again.stream).not.toBe(box.stream);
    expect(again.pending()).toEqual([]);
    expect(existsSync(join(dir, 'other'))).toBe(true);
  });

  it('is fine with a folder that has no outbox', () => {
    expect(() => clearOutbox(folder())).not.toThrow();
  });
});

describe('owes', () => {
  it('tells whether a message of that type still waits', () => {
    const box = new Outbox(folder());
    expect(box.owes('removed')).toBe(false);
    const entry = box.add({ type: 'removed' });
    box.add(event(0));
    expect(box.owes('removed')).toBe(true);
    box.ack(entry.n);
    expect(box.owes('removed')).toBe(false);
  });
});

describe('parseLine', () => {
  it('reads each kind of line and refuses the rest', () => {
    const stream = '8b1f6e1c-2d1c-4c9e-9a53-0f1d7f3f5a11';
    expect(parseLine(JSON.stringify({ k: 'stream', stream, next: 4 }))).toEqual({ k: 'stream', stream, next: 4 });
    expect(parseLine(JSON.stringify({ k: 'hold', msg: jobEnd('j') }))).toMatchObject({ k: 'hold' });
    expect(parseLine(JSON.stringify({ k: 'add', n: 2, msg: event(0) }))).toMatchObject({ k: 'add', n: 2 });
    expect(parseLine('{"k":"add"')).toBeNull();
    expect(parseLine(JSON.stringify({ k: 'add', n: 0, msg: event(0) }))).toBeNull();
    expect(parseLine(JSON.stringify({ k: 'add', n: 1, msg: { type: 'nope' } }))).toBeNull();
    expect(parseLine(JSON.stringify({ k: 'hold', msg: event(0) }))).toBeNull();
    expect(parseLine(JSON.stringify({ k: 'stream', stream: 'x', next: 1 }))).toBeNull();
  });
});

describe('ends', () => {
  it('know their id and tell themselves from other messages', () => {
    expect(endId(jobEnd('j'))).toBe('j');
    expect(endId(testEnd('p'))).toBe('p');
    expect(isEnd(jobEnd('j'))).toBe(true);
    expect(isEnd(event(0))).toBe(false);
  });
});

/* Holds an end and gives back its id, so a test can number it when it likes. */
function endOf(box: Outbox, end: End): string {
  box.hold(end);
  return endId(end);
}
