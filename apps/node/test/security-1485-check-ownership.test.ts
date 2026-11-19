import { expect, it, vi } from 'vitest';
import { deferred } from '../../../test-support/deferred.mjs';
import { CheckClient } from '../src/check-client.js';
import { currentCheckLease, reuseCheckLease, setCheckClient, withCheckSlot } from '../src/check-queue.js';

it('refuses a different agent as a nested check and releases the owner slot promptly', async () => {
  const releases: string[] = [];
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') {
      queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
    } else if (frame.type === 'check.release') {
      releases.push(frame.id);
    }
    return true;
  });
  client.online(true);
  setCheckClient(client);

  const started = deferred(), finish = deferred();
  let ownerLease: string | undefined;
  const held = withCheckSlot(async () => {
    ownerLease = currentCheckLease();
    started.resolve();
    await finish.promise;
  }, { agentId: '10000000-0000-4000-8000-000000000001' });
  try {
    await Promise.race([started.promise, held.then(() => { throw new Error('The owner exited before admission.'); })]);
    if (!ownerLease) throw new Error('The fixture requires an admitted lease.');
    const otherCheck = vi.fn(async () => 'ran');
    await expect(reuseCheckLease(ownerLease, '10000000-0000-4000-8000-000000000002', new AbortController().signal, otherCheck)).rejects.toThrow('The parent check slot is no longer active.');
    expect(otherCheck).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
    finish.resolve();
    await held;
    expect(releases).toEqual([ownerLease]);
  } finally {
    finish.resolve();
    await held.catch(() => {});
    setCheckClient(null);
  }
});
