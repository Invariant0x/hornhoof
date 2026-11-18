import { EventEmitter } from 'node:events';
import type { NodeMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { builtinOf, NodeHub } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { until } from './helpers-basic.js';

/* A ping round that never comes during a test, the longest a timer takes: no socket here answers pings. */
const NO_PING_MS = 2_147_483_647;

describe('the node hub', () => {
  it('keeps the server transport link across delivery and refuses an old connection after replacement', async () => {
    const links: string[] = [], seen: (string | undefined)[] = [];
    let acknowledge!: () => void;
    const delivered = () => new Promise<void>(resolve => { acknowledge = resolve; });
    const hub = new NodeHub({
      pingMs: NO_PING_MS,
      onClose: async () => {},
      onConnected: async (_id, link) => { links.push(link); },
      onMessage: async (_id, _msg, transport?: { linkId: string }) => { seen.push(transport?.linkId); acknowledge(); },
    });
    onTestFinished(() => hub.stop());
    const node = { kind: 'node' as const, nodeId: 'transport-node' };
    const socket = () => Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    const old = socket();
    hub.attach(node, old as unknown as WebSocket);
    const first = delivered();
    old.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, linkId: 'client-forged-link' }));
    await first;
    expect(seen).toEqual([links[0]]);
    expect(seen[0]).not.toBe('client-forged-link');
    const current = hub as NodeHub & { isCurrentLink?: (id: typeof node, link: string) => boolean };
    expect(current.isCurrentLink?.(node, links[0]!)).toBe(true);
    const next = socket();
    hub.attach(node, next as unknown as WebSocket);
    expect(links[1]).not.toBe(links[0]);
    expect(current.isCurrentLink?.(node, links[0]!)).toBe(false);
    expect(current.isCurrentLink?.(node, links[1]!)).toBe(true);
    const second = delivered();
    old.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    next.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, linkId: links[0] }));
    await second;
    expect(seen).toEqual([links[0], links[1]]);
    next.readyState = 3;
    next.emit('close');
    expect(current.isCurrentLink?.(node, links[1]!)).toBe(false);
  });

  it('keeps two built-in nodes apart', () => {
    const hub = new NodeHub({ pingMs: NO_PING_MS, onClose: async () => {}, onMessage: async () => {} });
    onTestFinished(() => hub.stop());
    const socket = () => Object.assign(new EventEmitter(), { readyState: 1, sent: [] as string[], close() { this.readyState = 3; }, ping() {}, send(frame: string) { this.sent.push(frame); } });
    const [a, b] = [builtinOf('a'.repeat(32)), builtinOf('b'.repeat(32))];
    const [onA, onB] = [socket(), socket()];
    hub.attach(a, onA as unknown as WebSocket);
    hub.attach(b, onB as unknown as WebSocket);
    expect([hub.isOnline(a), hub.isOnline(b), hub.isOnline(BUILTIN)]).toEqual([true, true, false]);
    /* What is sent to one reaches only its socket. */
    expect(hub.send(b, { type: 'job.cancel', jobId: 'j1' })).toBe(true);
    expect([onA.sent.length, onB.sent.map(frame => (JSON.parse(frame) as { jobId: string }).jobId)]).toEqual([0, ['j1']]);
    /* The machine's node that comes again takes the place of its own older socket alone. */
    const again = socket();
    hub.attach(a, again as unknown as WebSocket);
    expect([onA.readyState, onB.readyState, hub.isOnline(a), hub.isOnline(b)]).toEqual([3, 1, true, true]);
    /* Only one that said hello counts as there for work. */
    expect(hub.builtins()).toEqual([]);
    hub.greet(b);
    expect(hub.builtins()).toEqual(['b'.repeat(32)]);
  });

  it('takes the word that words went in at once, though a message before it still waits for that word', async () => {
    let heard!: () => void;
    const said = new Promise<void>(done => (heard = done));
    const handled: string[] = [];
    const hub = new NodeHub({
      pingMs: NO_PING_MS,
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
    /* A word that waited behind the message would wait for ever, and the message with it. */
    await said;
    await until(() => handled.length === 2);
    expect(handled).toEqual(['agent.said', 'status']);
  });

  it('takes a tool call made with no turn running at once, and the messages after it do not wait for its answer', async () => {
    let heard!: () => void;
    const statusCame = new Promise<void>(done => (heard = done));
    const handled: string[] = [];
    const hub = new NodeHub({
      pingMs: NO_PING_MS,
      onClose: async () => {},
      onMessage: async (_id, msg: NodeMessage) => {
        /* As a tool that waits for what the node says next, the end of a job it restarts or a check it asked for. */
        if (msg.type === 'tools.call') await statusCame;
        if (msg.type === 'status') heard();
        handled.push(msg.type);
      },
    });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ type: 'tools.call', agentKey: '00000000-0000-4000-8000-000000000001', ref: 'r1', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' }));
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    /* A node whose messages waited behind a long call would stay silent to Hornhoof for as long as the call runs. */
    await statusCame;
    await until(() => handled.length === 2);
    expect(handled).toEqual(['status', 'tools.call']);
  });

  it('says since when a node is away: from its socket closing, else from the first time it is asked', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const hub = new NodeHub({ pingMs: NO_PING_MS, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(node, socket as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    const closedAt = Date.now();
    socket.readyState = 3;
    socket.emit('close');
    vi.advanceTimersByTime(1000);
    expect(hub.awaySince(node)).toBe(closedAt);
    vi.advanceTimersByTime(1000);
    expect(hub.awaySince(node)).toBe(closedAt);
    /* One Hornhoof never saw, as after its own restart, is away from the first question on. */
    const other = { kind: 'node' as const, nodeId: 'n2' };
    const asked = Date.now();
    expect(hub.awaySince(other)).toBe(asked);
    vi.advanceTimersByTime(1000);
    expect(hub.awaySince(other)).toBe(asked);
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    void hub.stop();
  });

  it('keeps the build a node said in its hello, and says none for a node it does not know', () => {
    const hub = new NodeHub({ pingMs: NO_PING_MS, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.buildOf(node)).toBeNull();
    hub.greet(node, true, false, null, 'c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf(node)).toBe('c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf({ kind: 'node', nodeId: 'n2' })).toBeNull();
    void hub.stop();
  });

  it('evicts a closed socket immediately, leaves a newer key hash open and drops frames from a closed or replaced socket', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => (release = done));
    const handled: string[] = [];
    const terms: string[] = [];
    const errors: unknown[] = [];
    const hub = new NodeHub({
      pingMs: NO_PING_MS,
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
    /* The status queued behind the hello is taken up, and dropped, in the same turn as the hello ends: by the next look both
       are done. */
    await until(() => handled.includes('hello'));
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
    const hub = new NodeHub({ pingMs: NO_PING_MS, onClose: async () => {}, onMessage: async () => {} });
    onTestFinished(() => hub.stop());
    const sent: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, send(text: string) { sent.push(JSON.parse(text)); } });
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    expect(() => socket.emit('message', '{broken')).not.toThrow();
    expect(() => socket.emit('message', JSON.stringify({ type: 'unknown' }))).not.toThrow();
    const programs = [{ id: 'claude', version: '1.0.0', updating: false, failed: true }];
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, programs }));
    expect(hub.programsOf(BUILTIN)).toEqual(programs);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.greet(BUILTIN);
    expect(hub.hasTerminals(BUILTIN)).toBe(false);
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
      await hub.stop();
      vi.useRealTimers();
    }
  });

  it('tracks browser failure, noRuns and load across greeting, live status updates and closed sockets', () => {
    const hub = new NodeHub({ pingMs: NO_PING_MS, onClose: async () => {}, onMessage: async () => {} });
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

    hub.greet(node, true, true, null, 'build-1', 'libnss3.so: cannot open shared object file');
    expect(hub.browserErrorOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noRunsOf(node)).toBe('browser_failed: libnss3.so: cannot open shared object file');
    expect(hub.browserHoldOf(node)).toBeNull();
    hub.report(node, { cpus: 4, load: 1.5, memFree: 900, memTotal: 1000, tests: 0, jobs: 0 });
    expect(hub.browserHoldOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noteStatus(node, 'browser_failed: libnss3.so: cannot open shared object file')).toBe(false);
    expect(hub.browserHoldOf(node)).toBe('libnss3.so: cannot open shared object file');
    expect(hub.noteStatus(node, 'Playwright browsers could not start: libnss3.so: cannot open shared object file')).toBe(false);
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

  it('drops a node that sends no messages for three minutes even when pong frames keep arriving, and keeps one sending load', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T18:07:00.000Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    const ends: { nodeId: string; cause: string }[] = [];
    const hub = new NodeHub({
      pingMs: 20_000,
      onClose: async () => {},
      onMessage: async () => {},
      onDisconnected: async (id, end) => {
        if (id.kind === 'node') ends.push({ nodeId: id.nodeId, cause: end.cause });
      },
    });
    onTestFinished(() => hub.stop());
    const makeSocket = () => {
      const sock = Object.assign(new EventEmitter(), {
        readyState: 1,
        close() { sock.readyState = 3; sock.emit('close', 1000); },
        ping() { sock.emit('pong'); },
        terminate() { sock.readyState = 3; sock.emit('close', 1006); },
      });
      return sock;
    };
    const silent = { kind: 'node' as const, nodeId: 'silent-node' };
    const active = { kind: 'node' as const, nodeId: 'laptop-node' };
    const silentSock = makeSocket();
    const activeSock = makeSocket();
    hub.attach(silent, silentSock as unknown as WebSocket);
    hub.attach(active, activeSock as unknown as WebSocket);
    hub.greet(silent, true);
    hub.greet(active, true);
    expect([hub.isReady(silent), hub.isReady(active)]).toEqual([true, true]);

    for (let step = 0; step < 8; step++) {
      await vi.advanceTimersByTimeAsync(20_000);
      activeSock.emit('message', JSON.stringify({ type: 'load', cpus: 8, load: 1, memFree: 4000, memTotal: 8000, tests: 0, jobs: 0 }));
    }
    expect([hub.isReady(silent), hub.isReady(active)]).toEqual([true, true]);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hub.isOnline(silent)).toBe(false);
    expect(hub.isReady(silent)).toBe(false);
    expect(hub.isReady(active)).toBe(true);
    expect(ends).toEqual([{ nodeId: 'silent-node', cause: 'missed_pongs' }]);
  });
});

describe('numbered messages in the hub', () => {
  const STREAM = '5f0c2b1e-8a43-4c1d-9e57-2b7f6a1d3c90';
  const NODE = { kind: 'node' as const, nodeId: 'numbered-node' };
  type Numbered = { stream: string; type: string; n: number };

  function fakeSocket() {
    const sent: { type: string; upto?: number }[] = [];
    const closes: [number, string][] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: (text: string) => void sent.push(JSON.parse(text) as { type: string; upto?: number }),
      close: (code: number, reason: string) => void closes.push([code, reason]),
      ping() {},
    });
    const says = (msg: object) => socket.emit('message', JSON.stringify(msg));
    return { socket, sent, closes, says };
  }

  /* A hub whose numbered messages are taken, or not, as the test says for each one. */
  function hubTaking(take: (msg: Numbered) => Promise<boolean> | boolean) {
    const numbered: Numbered[] = [];
    const plain: string[] = [];
    const hub = new NodeHub({
      pingMs: NO_PING_MS,
      onClose: async () => {},
      onMessage: async (_id, msg) => void plain.push(msg.type),
      onNumbered: async (_id, stream, msg) => {
        const got = { stream, type: msg.type, n: msg.n };
        numbered.push(got);
        return take(got);
      },
    });
    onTestFinished(() => hub.stop());
    const attach = () => {
      const node = fakeSocket();
      hub.attach(NODE, node.socket as unknown as WebSocket);
      return node;
    };
    return { hub, numbered, plain, attach };
  }

  const hello = (stream?: string) => ({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], ...(stream ? { stream } : {}) });
  const started = (n?: number) => ({ type: 'job.started', jobId: 'j1', ...(n === undefined ? {} : { n }) });

  it('confirms each numbered message on its own socket once it is taken, in the order they came', async () => {
    const { numbered, plain, attach } = hubTaking(() => true);
    const node = attach();
    node.says(hello(STREAM));
    node.says(started(1));
    node.says({ type: 'status', loggedIn: true, limits: null });
    node.says(started(2));
    await until(() => node.sent.length === 2);
    expect(node.sent).toEqual([{ type: 'ack', upto: 1 }, { type: 'ack', upto: 2 }]);
    expect(numbered).toEqual([{ stream: STREAM, type: 'job.started', n: 1 }, { stream: STREAM, type: 'job.started', n: 2 }]);
    expect(plain).toEqual(['hello', 'status']);
  });

  it('closes a socket whose message it could not take, confirms nothing, and runs nothing that waited behind it', async () => {
    const { numbered, plain, attach } = hubTaking(msg => msg.n !== 2);
    const node = attach();
    node.says(hello(STREAM));
    node.says(started(1));
    node.says(started(2));
    node.says(started(3));
    node.says({ type: 'status', loggedIn: true, limits: null });
    await until(() => node.closes.length === 1);
    expect(node.closes).toEqual([[1013, 'Hornhoof could not take this now; send it again.']]);
    expect(node.sent).toEqual([{ type: 'ack', upto: 1 }]);
    expect(numbered.map(msg => msg.n)).toEqual([1, 2]);
    expect(plain).toEqual(['hello']);
  });

  it('takes a message without a number, or from a node that named no stream, as it always did', async () => {
    const { numbered, plain, attach } = hubTaking(() => true);
    const old = attach();
    old.says(hello());
    old.says(started(1));
    await until(() => plain.length === 2);
    const node = attach();
    node.says(hello(STREAM));
    node.says(started());
    await until(() => plain.length === 4);
    expect(plain).toEqual(['hello', 'job.started', 'hello', 'job.started']);
    expect(numbered).toEqual([]);
    expect([...old.sent, ...node.sent]).toEqual([]);
  });

  it('keeps the stream of the first hello that names one', async () => {
    const { numbered, attach } = hubTaking(() => true);
    const node = attach();
    node.says(hello(STREAM));
    node.says(hello('00000000-0000-4000-8000-000000000001'));
    node.says(started(1));
    await until(() => node.sent.length === 1);
    expect(numbered).toEqual([{ stream: STREAM, type: 'job.started', n: 1 }]);
  });

  it('lets what a socket already sent finish before it stops, and takes nothing after', async () => {
    let finish!: () => void;
    const working = new Promise<void>(done => (finish = done));
    const { hub, numbered, attach } = hubTaking(async () => (await working, true));
    const node = attach();
    node.says(hello(STREAM));
    node.says(started(1));
    await until(() => numbered.length === 1);
    const stopped = hub.stop();
    node.says(started(2));
    expect(node.closes).toEqual([]);
    finish();
    await stopped;
    expect(node.sent).toEqual([{ type: 'ack', upto: 1 }]);
    expect(node.closes).toEqual([[1001, 'Server is stopping.']]);
    expect(numbered.map(msg => msg.n)).toEqual([1]);
  });
});
