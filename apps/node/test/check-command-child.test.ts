import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ANCHOR_MS, PARKED_CHECK } from '../src/check-command.js';

function leader() {
  const child = new EventEmitter(), spawn = vi.fn(() => child), setTimeout = vi.fn<(step: () => void, ms: number) => void>();
  const process = Object.assign(new EventEmitter(), { connected: true, pid: 4242, send: vi.fn(), kill: vi.fn(), exit: vi.fn() });
  runInNewContext(PARKED_CHECK, { require: () => ({ spawn }), process, setTimeout });
  return { child, spawn, process, setTimeout, go: (managed = true) => process.emit('message', { command: ['recorded-tool'], env: {}, managed }) };
}

it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('reports the recorded group %s even before the wrapper reads a stop frame', signal => {
  const c = leader();
  c.go();
  c.process.emit(signal);
  /* The payload catches the signal and exits zero. Cancellation still cannot become PASS. */
  c.child.emit('exit', 0, null);
  expect(c.process.send).toHaveBeenCalledWith({ code: null, signal }, expect.any(Function));
});

it('starts nothing before admission and exits on an early wrapper disconnect', () => {
  const c = leader();
  expect(c.spawn).not.toHaveBeenCalled();
  c.process.emit('disconnect');
  expect(c.process.exit).toHaveBeenCalledWith(1);
});

it('never starts a payload when the node already stopped its waiting leader', () => {
  const c = leader();
  c.process.emit('SIGTERM');
  c.go();
  expect(c.spawn).not.toHaveBeenCalled();
});

it('keeps a managed identity anchor for node cleanup when its admitted wrapper disappears', () => {
  const c = leader();
  c.go(); c.process.emit('disconnect');
  expect(c.process.kill).not.toHaveBeenCalled();
  expect(c.process.exit).not.toHaveBeenCalled();
});

it('stays the group anchor after a managed payload ends, and ends its own group if no node comes for it', () => {
  const c = leader();
  c.go();
  c.child.emit('exit', 0, null);
  c.process.emit('disconnect');
  expect(c.process.exit).not.toHaveBeenCalled();
  expect(c.process.kill).not.toHaveBeenCalled();
  expect(c.setTimeout).toHaveBeenCalledWith(expect.any(Function), ANCHOR_MS);
  /* The step the timer would take, called directly: no clock is waited for. */
  c.setTimeout.mock.calls[0]![0]();
  expect(c.process.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
});

it('keeps no anchor for a payload that ran without a slot', () => {
  const c = leader();
  c.go(false);
  c.child.emit('exit', 0, null);
  expect(c.setTimeout).not.toHaveBeenCalled();
  c.process.emit('disconnect');
  expect(c.process.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
});
