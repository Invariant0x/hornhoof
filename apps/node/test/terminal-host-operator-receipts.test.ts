import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { agyProgram } from '../src/terminal/programs.js';
import { afterEach, expect, it } from 'vitest';
import { hasTmux, home, host, job, kimiJob, setUp } from './terminal-host-helpers.js';

let dir = '';
afterEach(async () => { await host?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it.skipIf(!hasTmux).each(['claude', 'kimi', 'antigravity'] as const)('records the actual %s assignment receipt in a real tmux program and never alarms after its own activity', async kind => {
  dir = join(home, `operator-${randomUUID()}`);
  let now = 0;
  const sent: OperatorNodeMessage[] = [];
  await setUp({ readyMs: 2000, pollMs: 25, lookMs: 50, cols: 120, rows: 40, plugins: [], operator: { dir, now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
  const key = randomUUID(), jobId = randomUUID(), id = randomUUID();
  const base = kind === 'kimi' ? kimiJob(key, 'hello', { agentKey: key, jobId }) : job(key, 'hello', { agentKey: key, jobId });
  const requested = kind === 'antigravity' ? { ...base, program: agyProgram, bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)), home: join(home, 'agy', key), signedOut: SIGNED_OUT } : base;
  expect(await host.run({ ...requested, operatorDelivery: { id, ordinal: 1 } })).toMatchObject({ ok: true });
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId: id, phase: 'taken' }));
  now = 8 * 3600000;
  host.operatorTick();
  expect(sent.filter(frame => frame.type === 'program.operator_needed' && frame.agentKey === key)).toEqual([]);
});
