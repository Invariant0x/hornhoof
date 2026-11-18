import { expect, it } from 'vitest';
import type { Ctx } from '../src/app.js';
import { withInputLock } from '../src/modules/conversation/decision-context.js';
import { onAgent } from '../src/modules/conversation/queue.js';

it('keeps input and dispatch lanes separate and advances an input lane after rejection', async () => {
  const ctx = { db: {} } as Ctx;
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('The recorded input was rejected.');
  const first = withInputLock(ctx, 'one', async () => {
    order.push('input started');
    await held;
    order.push('input rejected');
    throw failure;
  });
  const rejected = expect(first).rejects.toBe(failure);
  const next = withInputLock(ctx, 'one', async () => { order.push('next input'); return 'kept'; });
  await Promise.all([
    onAgent(ctx, 'one', async () => { order.push('dispatch'); }),
    withInputLock(ctx, 'two', async () => { order.push('other input'); }),
  ]);
  expect(order).toEqual(['input started', 'dispatch', 'other input']);
  release();
  await rejected;
  expect(await next).toBe('kept');
  expect(order).toEqual(['input started', 'dispatch', 'other input', 'input rejected', 'next input']);
  expect(await withInputLock(ctx, 'one', async () => 'idle again')).toBe('idle again');
});
