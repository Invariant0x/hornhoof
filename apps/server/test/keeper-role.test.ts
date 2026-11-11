import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { keeperRole } from '../src/modules/keeper/role.js';

function control(marker = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-role-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  if (marker) writeFileSync(join(dir, 'replica.json'), '{}');
  return dir;
}

describe('the keeper a machine runs', () => {
  it("is a worker's where the machine keeps no data, whatever else is there", async () => {
    let asked = 0;
    const subscribed = async () => (asked++, true);
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(true), subscribed)).toBe('worker');
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(), subscribed)).toBe('worker');
    expect(asked).toBe(0);
  });

  it('follows where the machine keeps a copy', async () => {
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(true), async () => false)).toBe('follow');
    /* Its control folder was lost, and its database still follows the leader's. */
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(), async () => true)).toBe('follow');
    expect(await keeperRole({}, control(), async () => true)).toBe('follow');
  });

  it('leads anywhere else', async () => {
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(), async () => false)).toBe('lead');
    expect(await keeperRole({}, control(), async () => false)).toBe('lead');
    /* A database that does not answer follows nobody as far as anyone knows. */
    expect(await keeperRole({}, control(), async () => { throw new Error('the database does not answer'); })).toBe('lead');
  });
});
