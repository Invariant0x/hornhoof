import { describe, expect, it } from 'vitest';
import type { NodeMessage } from '@hornhoof/protocol';
import { Stops, type HeldJob, type StopsHost } from '../src/stops.js';

type JobDone = Extract<NodeMessage, { type: 'job.done' }>;

/* A node that runs the jobs given, with a host that holds the turns given, and what it told and kept. */
function stopsOf(jobs: Record<string, HeldJob>, host: StopsHost | null) {
  const told: JobDone[] = [], kept: JobDone[] = [], outside: string[] = [];
  const stops = new Stops({ held: id => jobs[id], outside: id => outside.push(id), host: () => host, emit: end => told.push(end), hold: end => kept.push(end) });
  return { stops, told, kept, outside };
}
const job = (sessionId: string | null): HeldJob => ({ stop: new AbortController(), sessionId });
const ended = (jobId: string): JobDone => ({ type: 'job.done', jobId, ok: true, sessionId: 's-late', result: 'A late answer.', tail: '', error: null });

describe('a Stop of a job on the node', () => {
  it('tells the end with the session and tokens of the turn the host holds, and calls the host off', async () => {
    const cancelled: string[] = [];
    const host: StopsHost = { calledOffEnd: () => ({ sessionId: 's-host', tokens: null }), cancel: async id => { cancelled.push(id); } };
    const held = job('s-given');
    const s = stopsOf({ j1: held }, host);
    await s.stops.callOff('j1');
    expect(held.stop.signal.aborted).toBe(true);
    expect(s.outside).toEqual(['j1']);
    expect(s.told).toEqual([{ type: 'job.done', jobId: 'j1', ok: false, sessionId: 's-host', result: 'Stopped.', tail: '', error: 'cancelled', tokens: null }]);
    expect(cancelled).toEqual(['j1']);
  });

  it('tells the session the job was given when the host holds no turn of it, once, and keeps no later end of it', async () => {
    const host: StopsHost = { calledOffEnd: () => null, cancel: async () => {} };
    const s = stopsOf({ j1: job('s-given') }, host);
    await s.stops.callOff('j1');
    await s.stops.callOff('j1');
    s.stops.ended(ended('j1'));
    expect(s.told).toEqual([{ type: 'job.done', jobId: 'j1', ok: false, sessionId: 's-given', result: 'Stopped.', tail: '', error: 'cancelled' }]);
    expect(s.kept).toEqual([]);
    /* The next end of the same id, as after the node started again, is its own. */
    s.stops.ended(ended('j1'));
    expect(s.kept).toHaveLength(1);
  });

  it('tells nothing for a job the node does not run, and keeps the end of a job no Stop called off', async () => {
    const s = stopsOf({}, null);
    await s.stops.callOff('other');
    s.stops.ended(ended('j2'));
    expect(s.told).toEqual([]);
    expect(s.outside).toEqual(['other']);
    expect(s.kept).toEqual([ended('j2')]);
  });
});
