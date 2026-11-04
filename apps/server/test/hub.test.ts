import { EventEmitter } from 'node:events';
import type { NodeMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BUILTIN, NodeHub } from '../src/modules/nodes/hub.js';

describe('the node hub', () => {
  it('takes the word that words went in at once, though a message before it still waits for that word', async () => {
    let heard!: () => void;
    const said = new Promise<void>(done => (heard = done));
    const handled: string[] = [];
    const hub = new NodeHub({
      pingMs: 60_000,
      onClose: async () => {},
      onMessage: async (_id, msg: NodeMessage) => {
        /* As a finished job waits for the words Hornhoof typed into another agent's turn. */
        if (msg.type === 'status') await said;
        if (msg.type === 'agent.said') heard();
        handled.push(msg.type);
      },
    });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    socket.emit('message', JSON.stringify({ type: 'agent.said', ref: 'r1', ok: true }));
    const late = new Promise<void>((_, fail) => setTimeout(() => fail(new Error('the word waited behind the message')), 2000));
    await Promise.race([said, late]);
    await new Promise(r => setTimeout(r, 20));
    expect(handled).toEqual(['agent.said', 'status']);
  });

  it('says since when a node is away: from its socket closing, else from the first time it is asked', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(node, socket as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    const before = Date.now();
    socket.readyState = 3;
    socket.emit('close');
    const since = hub.awaySince(node)!;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(hub.awaySince(node)).toBe(since);
    /* One Hornhoof never saw, as after its own restart, is away from the first question on. */
    const other = { kind: 'node' as const, nodeId: 'n2' };
    const first = hub.awaySince(other)!;
    expect(first).toBeGreaterThanOrEqual(since);
    expect(hub.awaySince(other)).toBe(first);
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    hub.stop();
  });

  it('keeps the build a node said in its hello, and says none for a node it does not know', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.buildOf(node)).toBeNull();
    hub.greet(node, true, true, false, null, 'c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf(node)).toBe('c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf({ kind: 'node', nodeId: 'n2' })).toBeNull();
    hub.stop();
  });

  it('evicts a closed socket immediately, leaves a newer key hash open and drops frames from a closed or replaced socket', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => (release = done));
    const handled: string[] = [];
    const terms: string[] = [];
    const errors: unknown[] = [];
    const hub = new NodeHub({
      pingMs: 60_000,
      onClose: async () => {},
      onError: err => errors.push(err),
      onTerminal: (_id, msg) => {
        if (msg.termId === 'boom') throw new Error('terminal failed');
        terms.push(msg.termId);
      },
      onMessage: async (_id, msg: NodeMessage) => {
        if (msg.type === 'hello') await gate;
        handled.push(msg.type);
      },
    });
    onTestFinished(() => hub.stop());
    const closedCodes: number[] = [];
    const oldSocket = Object.assign(new EventEmitter(), { readyState: 1, close(code: number) { closedCodes.push(code); }, ping() {} });
    const oldId = { kind: 'node' as const, nodeId: 'n1', keyHash: 'old-hash' };
    hub.attach(oldId, oldSocket as unknown as WebSocket);
    oldSocket.emit('message', JSON.stringify({ type: 'term.data', termId: 't1', data: 'hi' }));
    oldSocket.emit('message', JSON.stringify({ type: 'term.data', termId: 'boom', data: 'hi' }));
    expect(terms).toEqual(['t1']);
    expect(errors).toHaveLength(1);

    oldSocket.emit('message', JSON.stringify({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] }));
    oldSocket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    await Promise.resolve();
    hub.close('n1', 4001, 'wrong-hash');
    expect(closedCodes).toEqual([]);
    expect(hub.isOnline(oldId)).toBe(true);

    hub.close('n1', 4001, 'old-hash');
    expect(closedCodes).toEqual([4001]);
    expect(hub.isOnline(oldId)).toBe(false);
    expect(hub.awaySince(oldId)).not.toBeNull();
    oldSocket.emit('message', JSON.stringify({ type: 'agent.said', ref: 'r1', ok: true }));
    oldSocket.emit('message', JSON.stringify({ type: 'term.data', termId: 't2', data: 'late' }));
    release();
    await new Promise(r => setTimeout(r, 20));
    expect(handled).toEqual(['hello']);
    expect(terms).toEqual(['t1']);

    const newSocket = Object.assign(new EventEmitter(), { readyState: 1, close(code: number) { closedCodes.push(code); }, ping() {} });
    const newId = { kind: 'node' as const, nodeId: 'n1', keyHash: 'new-hash' };
    hub.attach(newId, newSocket as unknown as WebSocket);
    hub.close('n1', 4001, 'old-hash');
    expect(hub.isOnline(newId)).toBe(true);
    expect(closedCodes).toEqual([4001]);
  });
});


describe('live program metadata in the hub', () => {
  it('requires a greeting, keeps snapshots isolated and coalesces update commands', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    onTestFinished(() => hub.stop());
    const sent: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, send(text: string) { sent.push(JSON.parse(text)); } });
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    expect(hub.takesSkillFiles(BUILTIN)).toBe(false);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    expect(() => socket.emit('message', '{broken')).not.toThrow();
    expect(() => socket.emit('message', JSON.stringify({ type: 'unknown' }))).not.toThrow();
    const programs = [{ id: 'claude', version: '1.0.0', updating: false, failed: true }];
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, programs }));
    expect(hub.programsOf(BUILTIN)).toEqual(programs);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.greet(BUILTIN);
    expect(hub.hasTerminals(BUILTIN)).toBe(false);
    expect(hub.takesSkillFiles(BUILTIN)).toBe(false);
    expect(hub.runsWork(BUILTIN)).toBe(false);
    const snapshot = hub.programsOf(BUILTIN)!;
    snapshot[0]!.version = 'changed outside';
    expect(hub.programsOf(BUILTIN)).toEqual(programs);
    expect(hub.updatePrograms(BUILTIN)).toBe(true);
    expect(sent).toEqual([{ type: 'programs.update' }]);
    expect(hub.programsOf(BUILTIN)).toEqual([{ ...programs[0], updating: true, failed: false }]);
    expect(hub.updatePrograms(BUILTIN)).toBe(true);
    expect(sent).toHaveLength(1);
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, programs: [] }));
    expect(hub.programsOf(BUILTIN)).toEqual([]);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    socket.readyState = 3;
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    const older = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, older as unknown as WebSocket);
    hub.greet(BUILTIN);
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
  });

  it('allows three full ping intervals for a new socket to reply', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const ping = vi.fn();
    const hub = new NodeHub({ pingMs: 1000, onClose: async () => {}, onMessage: async () => {} });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping, terminate });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(ping).toHaveBeenCalledTimes(3);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      hub.stop();
      vi.useRealTimers();
    }
  });

  it('tracks browser failure, noRuns and load across greeting, live status updates and closed sockets', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    onTestFinished(() => hub.stop());
    const unknown = { kind: 'node' as const, nodeId: 'missing' };
    expect(hub.browserErrorOf(unknown)).toBeNull();
    expect(hub.noRunsOf(unknown)).toBeNull();
    expect(hub.loadOf(unknown)).toBeNull();
    expect(hub.noteStatus(unknown, null, null)).toBe(false);

    const node = { kind: 'node' as const, nodeId: 'n1' };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(node, socket as unknown as WebSocket);
    expect(hub.browserErrorOf(node)).toBeNull();
    expect(hub.browserHoldOf(node)).toBeNull();
    expect(hub.noRunsOf(node)).toBeNull();
    expect(hub.loadOf(node)).toBeNull();

    hub.greet(node, true, true, true, null, 'build-1', 'libnss3.so: cannot open shared object file');
    expect(hub.browserErrorOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noRunsOf(node)).toBe('browser_failed: libnss3.so: cannot open shared object file');
    expect(hub.browserHoldOf(node)).toBeNull();
    hub.report(node, { cpus: 4, load: 1.5, memFree: 900, memTotal: 1000, tests: 0, jobs: 0 });
    expect(hub.browserHoldOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noteStatus(node, 'browser_failed: libnss3.so: cannot open shared object file')).toBe(false);
    expect(hub.browserHoldOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noteStatus(node, 'Playwright Chromium could not start: libnss3.so: cannot open shared object file')).toBe(false);
    expect(hub.browserHoldOf(node)).toBe('libnss3.so: cannot open shared object file');

    /* Leaving fields undefined in status preserves the current readiness state and reports no recovery. */
    expect(hub.noteStatus(node)).toBe(false);
    expect(hub.browserErrorOf(node)).toBe('libnss3.so: cannot open shared object file');

    /* Explicit non-browser noRuns overrides the browser hold; clearing browserError while noRuns stays set unblocks browser state. */
    expect(hub.noteStatus(node, 'git missing')).toBe(false);
    expect(hub.noRunsOf(node)).toBe('git missing');
    expect(hub.browserHoldOf(node)).toBeNull();
    expect(hub.noteStatus(node, 'git missing', null)).toBe(true);
    expect(hub.browserErrorOf(node)).toBeNull();
    expect(hub.noRunsOf(node)).toBe('git missing');
    expect(hub.browserHoldOf(node)).toBeNull();

    /* Clearing noRuns while browser is already healthy signals run recovery; repeating when already clear returns false. */
    expect(hub.noteStatus(node, null, null)).toBe(true);
    expect(hub.noRunsOf(node)).toBeNull();
    expect(hub.noteStatus(node, null, null)).toBe(false);

    expect(hub.loadOf(node)).toMatchObject({ cpus: 4, load: 1.5 });

    /* Once the socket is no longer open, browserErrorOf, browserHoldOf and loadOf return null. */
    expect(hub.noteStatus(node, null, 'libgbm.so.1 missing')).toBe(false);
    expect(hub.browserHoldOf(node)).toBe('libgbm.so.1 missing');
    socket.readyState = 3;
    expect(hub.browserErrorOf(node)).toBeNull();
    expect(hub.browserHoldOf(node)).toBeNull();
    expect(hub.loadOf(node)).toBeNull();
  });
});


describe('connection history events', () => {
  const node = { kind: 'node' as const, nodeId: 'n1' };

  function fakeSocket(closed: number[] = []) {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      close(code: number, reason: string) {
        closed.push(code);
        this.readyState = 3;
        socket.emit('close', code, Buffer.from(reason));
      },
      ping() {},
      terminate() {
        this.readyState = 3;
        socket.emit('close', 1006, Buffer.alloc(0));
      },
    });
    return socket;
  }

  it('distinguishes a node close from a socket error', async () => {
    const events: unknown[] = [];
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {}, onEvent: async (_id, event) => { events.push(event); } });
    onTestFinished(() => hub.stop());
    const first = fakeSocket();
    hub.attach(node, first as unknown as WebSocket);
    first.readyState = 3;
    first.emit('close', 1000, Buffer.from('Bye'));
    const second = fakeSocket();
    hub.attach(node, second as unknown as WebSocket);
    second.emit('error', new Error('read ECONNRESET'));
    second.readyState = 3;
    second.emit('close', 1006, Buffer.alloc(0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events).toEqual([
      { kind: 'connected', at: expect.any(Date) },
      { kind: 'disconnected', at: expect.any(Date), actor: 'node', cause: 'node_closed', closeCode: 1000, closeReason: 'Bye', error: null },
      { kind: 'connected', at: expect.any(Date) },
      { kind: 'disconnected', at: expect.any(Date), actor: 'network', cause: 'socket_error', closeCode: 1006, closeReason: '', error: 'read ECONNRESET' },
    ]);
  });

  it('records a replaced socket once before the new connection', async () => {
    const events: { kind: string; cause?: string }[] = [];
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {}, onEvent: async (_id, event) => { events.push(event); } });
    onTestFinished(() => hub.stop());
    const first = fakeSocket();
    hub.attach(node, first as unknown as WebSocket);
    hub.attach(node, fakeSocket() as unknown as WebSocket);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.map(event => [event.kind, event.cause ?? null])).toEqual([
      ['connected', null], ['disconnected', 'replaced'], ['connected', null],
    ]);
    expect(events[1]).toMatchObject({ actor: 'server', closeCode: 4000, closeReason: 'Replaced by a newer connection.' });
  });

  it('names missed pongs when sweep drops the socket', async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const hub = new NodeHub({ pingMs: 1000, onClose: async () => {}, onMessage: async () => {}, onEvent: async (_id, event) => { events.push(event); } });
    const socket = fakeSocket();
    hub.attach(node, socket as unknown as WebSocket);
    try {
      await vi.advanceTimersByTimeAsync(4000);
      expect(events.at(-1)).toMatchObject({ kind: 'disconnected', actor: 'server', cause: 'missed_pongs', closeCode: 1006 });
    } finally {
      await hub.stop();
      vi.useRealTimers();
    }
  });

  it('names an administrative close and a server stop', async () => {
    const events: unknown[] = [];
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {}, onEvent: async (_id, event) => { events.push(event); } });
    hub.attach(node, fakeSocket() as unknown as WebSocket);
    hub.close(node.nodeId, 4001);
    hub.attach(node, fakeSocket() as unknown as WebSocket);
    await hub.stop();
    expect(events).toEqual([
      { kind: 'connected', at: expect.any(Date) },
      { kind: 'disconnected', at: expect.any(Date), actor: 'server', cause: 'server_close', closeCode: 4001, closeReason: 'Disconnected in Hornhoof.', error: null },
      { kind: 'connected', at: expect.any(Date) },
      { kind: 'disconnected', at: expect.any(Date), actor: 'server', cause: 'server_stop', closeCode: 1001, closeReason: 'Server is stopping.', error: null },
    ]);
  });
});
