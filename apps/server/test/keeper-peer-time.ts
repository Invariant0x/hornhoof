import { onTestFinished, vi, type TestContext } from 'vitest';
import type { Keeper } from '../src/modules/keeper/keeper.js';
import { until as stateUntil } from './helpers-basic.js';
import { controlledTime, registerStep, until as runSteps } from './worker-keeper-time.js';

let monotonic = 0;
let signal: AbortSignal;
const leases = new Set<() => Promise<void>>();

export function peerTime(context: TestContext): void {
  controlledTime(context);
  signal = context.signal;
  monotonic = 0;
  leases.clear();
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  onTestFinished(() => { leases.clear(); clock.mockRestore(); });
}

export function advance(ms: number): void {
  signal.throwIfAborted();
  monotonic += ms;
  vi.setSystemTime(Date.now() + ms);
}

export async function state(check: () => boolean | Promise<boolean>): Promise<void> {
  const running = signal;
  await stateUntil(async () => {
    running.throwIfAborted();
    const done = await check();
    running.throwIfAborted();
    return done;
  });
}

/* A completed round, with no interval dispatch and no deadline running during I/O. */
export async function step(ms = 20): Promise<void> {
  advance(ms);
  await runSteps(() => true);
}

export async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  await state(async () => {
    if (await check()) return true;
    await step();
    return check();
  });
}

export async function leaseStep(ms: number): Promise<void> {
  advance(ms);
  for (const lease of leases) await lease();
}

export async function leaseRound(keeper: Keeper): Promise<void> {
  await keeper['readNeeded']();
  await keeper['sync']?.look();
  await keeper['holder'].guard();
  await keeper['holder'].look();
  if (keeper['neededNow']) {
    if (keeper['holder'].standing()) await keeper['leaseProofs']!.tick();
    else await keeper['reentry']!.tick();
  }
  await keeper['holder'].tick();
  keeper['giveWord']();
}

export async function certificate(keeper: Keeper): Promise<void> {
  const certificates = keeper['identity']?.['certificates'];
  certificates?.['look']();
  await state(() => !certificates?.['asking']);
}

export async function networkRound(keeper: Keeper): Promise<void> {
  await certificate(keeper);
  await keeper['peers']?.['reading'];
  await keeper['peers']?.['readOnce']();
  await certificate(keeper);
  await keeper['links']?.['working'];
  await keeper['links']?.['lookOnce']();
  keeper['links']?.['dial']?.['look']?.();
  keeper['giveWord']();
}

export async function tunnelRound(keeper: Keeper): Promise<void> {
  await keeper['tunnel']?.['tick']();
  await keeper['peers']?.['tunnel']?.['tick']();
}

export function registerKeeper(keeper: Keeper, round: () => Promise<void>): () => void {
  const lease = () => leaseRound(keeper);
  leases.add(lease);
  const remove = registerStep(round);
  return () => { leases.delete(lease); remove(); };
}
