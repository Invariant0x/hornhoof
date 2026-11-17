import { afterEach, expect, it, vi } from 'vitest';
import { assertCheckGroup, cleanCheckGroup, type GroupProcess } from '../src/check-group.js';

const GROUP = { pid: 4242, started: '100' };
const leader: GroupProcess = { ...GROUP, parent: 42, group: 4242, session: 4242, uid: 20000, state: 'S' };
const descendant = { ...leader, pid: 4243, parent: 4242, started: '101' };
afterEach(() => vi.useRealTimers());

function recorded(initial = [leader, descendant]) {
  let members = initial;
  const kill = vi.fn(), block = vi.fn();
  return { kill, block, gone: () => { members = []; }, members: (next: GroupProcess[]) => { members = next; },
    run: () => cleanCheckGroup(GROUP, 20000, { list: async () => members, kill, block }) };
}

it('keeps cleanup pending until the recorded whole group is gone, with TERM then KILL on virtual time', async () => {
  vi.useFakeTimers();
  const group = recorded();
  let ended = false;
  const pending = group.run().then(() => { ended = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(group.kill.mock.calls).toEqual([[-4242, 'SIGTERM']]);
  await vi.advanceTimersByTimeAsync(4999);
  expect(ended).toBe(false);
  expect(group.kill).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(group.kill.mock.calls).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  group.gone();
  await vi.advanceTimersByTimeAsync(25);
  await pending;
  expect(ended).toBe(true);
  expect(group.block).not.toHaveBeenCalled();
});

it('refuses new checks after KILL fails and clears the reason itself only once the group is gone', async () => {
  vi.useFakeTimers();
  const group = recorded();
  let ended = false;
  const pending = group.run().then(() => { ended = true; });
  await vi.advanceTimersByTimeAsync(10000);
  expect(ended).toBe(false);
  expect(group.block).toHaveBeenLastCalledWith(expect.stringContaining('4242'));
  group.gone();
  await vi.advanceTimersByTimeAsync(25);
  await pending;
  expect(group.block).toHaveBeenLastCalledWith(null);
});

it.each([
  { ...leader, started: '999' },
  { ...leader, uid: 0 },
])('never signals a reused PID or another user', async foreign => {
  vi.useFakeTimers();
  const group = recorded([foreign]);
  const pending = group.run();
  await vi.advanceTimersByTimeAsync(10000);
  expect(group.kill).not.toHaveBeenCalled();
  group.gone();
  await vi.advanceTimersByTimeAsync(25);
  await pending;
});

it('reaps an idle parked leader immediately without a grace for a command that already ended', async () => {
  vi.useFakeTimers();
  const group = recorded([leader]);
  const pending = group.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(group.kill.mock.calls).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  group.gone();
  await vi.advanceTimersByTimeAsync(25);
  await pending;
});

it.each([
  { ...leader, parent: 99 }, { ...leader, uid: 0 }, { ...leader, started: '999' },
  { ...leader, group: 42 }, { ...leader, session: 42 }, null,
])('rejects a recorded group outside the authenticated caller identity', async sample => {
  await expect(assertCheckGroup(GROUP, 20000, 42, async () => sample)).rejects.toThrow('caller');
});
it('accepts only the recorded waiting leader of the authenticated caller', async () => {
  await expect(assertCheckGroup(GROUP, 20000, 42, async () => leader)).resolves.toBeUndefined();
});
