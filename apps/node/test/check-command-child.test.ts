import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { PARKED_CHECK } from '../src/check-command.js';

function leader() {
  const child = new EventEmitter(), spawn = vi.fn(() => child);
  const process = Object.assign(new EventEmitter(), { connected: true, pid: 4242, send: vi.fn(), kill: vi.fn(), exit: vi.fn() });
  runInNewContext(PARKED_CHECK, { require: () => ({ spawn }), process });
  return { child, spawn, process, go: (managed = true) => process.emit('message', { command: ['recorded-tool'], env: {}, managed }) };
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
