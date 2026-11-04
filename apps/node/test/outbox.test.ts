import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { endId, isEnd, Outbox, OUTBOX_FILE, parseLine, type End } from '../src/outbox.js';

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
